#!/usr/bin/env node
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DEFAULT_CDP_PORT, DEFAULT_THEME_ID, EXPECTED_BUNDLE_ID, RENDERER_URL_HINT, resolveStudioPaths } from "./constants.mjs";
import { applySkin, removeSkin, skinStatus, readSavedActiveSkin, activateSavedSkin, activateSavedNative } from "./injector.mjs";
import { readState, writeState } from "./state-store.mjs";
import { loadTheme } from "./theme-schema.mjs";
import { createSingleImageTheme, listThemes } from "./theme-store.mjs";

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function options(argv) {
  const result = {};
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`无法识别的参数：${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key} 缺少值`);
    result[key.slice(2)] = value;
    index += 1;
  }
  return result;
}

function portFrom(value) {
  const port = value === undefined ? DEFAULT_CDP_PORT : Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("--port 必须是 1024 到 65535 的整数");
  return port;
}

function defaults(overrides) {
  const paths = resolveStudioPaths();
  return {
    bundledThemesRoot: join(sourceRoot, "themes"),
    userThemesRoot: paths.userThemesRoot,
    loadTheme,
    listThemes,
    createSingleImageTheme,
    applySkin,
    removeSkin,
    skinStatus,
    readSavedActiveSkin,
    activateSavedSkin,
    activateSavedNative,
    readStateFile: readState,
    writeStateFile: writeState,
    ...overrides,
  };
}

// 状态回执只作诊断：写入失败（权限/磁盘）绝不允许打断换肤主流程
function recordState(deps, patch) {
  return deps.writeStateFile(patch).catch(() => {});
}

// doctor 环境报告附带的 Node 版本检查（注入脚本用到较新的内置 API，要求 18+）
function nodeInfo() {
  const major = Number(process.versions.node.split(".")[0]);
  return { version: process.version, required: ">=18", ok: Number.isInteger(major) && major >= 18 };
}

export async function runCli(argv, overrides = {}) {
  const command = argv[0] ?? "help";
  const args = options(argv);
  const deps = defaults(overrides);
  const roots = [deps.bundledThemesRoot, deps.userThemesRoot];

  if (command === "help") {
    return {
      commands: ["list", "create --image PATH --name NAME", "apply [--theme ID] [--port 9223]", "pause (alias: restore)", "status", "doctor"],
    };
  }
  if (command === "list") return deps.listThemes({ roots });
  if (command === "create") {
    if (!args.image) throw new Error("create 需要 --image");
    if (!args.name) throw new Error("create 需要 --name");
    return deps.createSingleImageTheme({ imagePath: args.image, name: args.name, storeRoot: deps.userThemesRoot });
  }
  if (command === "apply") {
    const port = portFrom(args.port);
    try {
      return await applyCommand(deps, roots, args, port);
    } catch (error) {
      await recordState(deps, {
        lastApply: { at: new Date().toISOString(), ok: false, port, themeId: args.theme ?? null, error: error.message },
      });
      throw error;
    }
  }
  if (command === "pause" || command === "restore") {
    const port = portFrom(args.port);
    const result = await deps.removeSkin({ port });
    await recordState(deps, { lastPause: { at: new Date().toISOString(), ok: true, port, removed: result.removed } });
    return result;
  }
  if (command === "status") return deps.skinStatus({ port: portFrom(args.port) });
  if (command === "doctor") {
    const state = await deps.readStateFile().catch(() => null);
    const exists = async (path) => access(path).then(() => true, () => false);
    if (process.platform === "win32") {
      const candidates = [
        process.env.WORKBUDDY_EXE,
        process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "workbuddy", "WorkBuddy.exe"),
        process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "workbuddy", "WorkBuddy.exe"),
        process.env.ProgramFiles && join(process.env.ProgramFiles, "WorkBuddy", "WorkBuddy.exe"),
        process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "WorkBuddy", "WorkBuddy.exe"),
      ].filter(Boolean);
      let app = null;
      for (const c of candidates) {
        if (await exists(c)) { app = c; break; }
      }
      return {
        platform: "win32",
        app,
        appFound: !!app,
        candidates,
        cdpPort: DEFAULT_CDP_PORT,
        rendererHint: RENDERER_URL_HINT,
        installRoot: resolveStudioPaths().installRoot,
        statePath: resolveStudioPaths().statePath,
        node: nodeInfo(),
        state,
      };
    }
    // 非 Windows 按 macOS 布局探测；平台如实上报（Linux 等会显示 appFound:false）
    const app = "/Applications/WorkBuddy.app";
    return {
      platform: process.platform,
      app,
      appFound: await exists(app),
      bundleId: EXPECTED_BUNDLE_ID,
      cdpPort: DEFAULT_CDP_PORT,
      rendererHint: RENDERER_URL_HINT,
      installRoot: resolveStudioPaths().installRoot,
      statePath: resolveStudioPaths().statePath,
      node: nodeInfo(),
      state,
    };
  }
  throw new Error(`未知命令：${command}`);
}

async function applyCommand(deps, roots, args, port) {
  {
    let themeId = args.theme;
    let savedCustomId = null;
    let savedNativeMode = null;
    let activeId;
    // 读取上次皮肤（CDP 往返）与扫描主题目录（磁盘）互不依赖，并发
    const [saved, themes] = await Promise.all([
      themeId ? null : deps.readSavedActiveSkin({ port }).catch(() => null),
      deps.listThemes({ roots }),
    ]);
    if (!themeId) {
      // 未指定主题：恢复上次使用的皮肤（菜单切换时已持久化到渲染进程 localStorage）；
      // 是自定义皮肤则先按默认主题注入菜单（activeId=null），再激活自定义皮肤；
      // 原生浅色/深色同理：注入后不应用皮肤，只钉明暗模式；
      // 没有记录或读取失败则回退默认主题
      if (saved && saved.startsWith("custom-")) {
        themeId = DEFAULT_THEME_ID;
        activeId = null;
        savedCustomId = saved;
      } else if (saved === "native-light" || saved === "native-dark") {
        themeId = DEFAULT_THEME_ID;
        activeId = null;
        savedNativeMode = saved === "native-dark" ? "dark" : "light";
      } else {
        themeId = saved ?? DEFAULT_THEME_ID;
      }
    }
    let selected = themes.find((theme) => theme.id === themeId);
    if (!selected) {
      if (args.theme) throw new Error(`找不到主题：${themeId}`);
      // 记住的主题已不存在：回退默认
      themeId = DEFAULT_THEME_ID;
      selected = themes.find((theme) => theme.id === themeId);
      if (!selected) throw new Error(`找不到主题：${themeId}`);
    }
    // 选中主题必须加载成功（失败直接抛出）；其余主题并发加载，坏主题不阻塞换肤、只是不进菜单。
    // allSettled 保序，菜单顺序与 listThemes 排序一致
    const loadedTheme = await deps.loadTheme(selected.path);
    const settled = await Promise.allSettled(
      themes.map((theme) => (theme.id === themeId ? loadedTheme : deps.loadTheme(theme.path))),
    );
    const menuThemes = settled.filter(({ status }) => status === "fulfilled").map(({ value }) => value);
    const result = await deps.applySkin({ loadedTheme, themes: menuThemes, port, activeId });
    if (savedCustomId) {
      await deps.activateSavedSkin({ port, id: savedCustomId, fallbackId: themeId });
      result.themeId = savedCustomId;
      result.restored = true;
    }
    if (savedNativeMode) {
      await deps.activateSavedNative({ port, mode: savedNativeMode });
      result.themeId = savedNativeMode === "dark" ? "native-dark" : "native-light";
      result.restored = true;
    }
    await recordState(deps, {
      lastApply: {
        at: new Date().toISOString(),
        ok: true,
        port,
        themeId: result.themeId,
        restored: result.restored === true,
        applied: result.applied,
        videoWarnings: result.videoWarnings?.length ?? 0,
      },
    });
    return result;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runCli(process.argv.slice(2))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`WorkBuddy Skin Studio：${error.message}\n`);
      process.exitCode = 1;
    });
}
