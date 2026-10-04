import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../src/cli.mjs";

// runCli 全部依赖可注入：这里只验证 apply 的编排（主题选择、并发加载、坏主题跳过、恢复自定义皮肤）
function applyOverrides({ saved = null, themes, failLoad = new Set() }) {
  const calls = { applySkin: null, activateSavedSkin: null };
  const overrides = {
    bundledThemesRoot: "bundled",
    userThemesRoot: "user",
    listThemes: async () => themes,
    readSavedActiveSkin: async () => saved,
    // 默认隔绝真实状态文件：测试不应写用户目录；需要断言时由 stateSpy 显式覆盖
    writeStateFile: async () => {},
    readStateFile: async () => null,
    loadTheme: async (path) => {
      if (failLoad.has(path)) throw new Error(`broken ${path}`);
      return { manifest: { id: path.replace(/^dir-/, "") }, path };
    },
    applySkin: async (args) => {
      calls.applySkin = args;
      return { applied: 1, themeId: args.activeId === undefined ? args.loadedTheme.manifest.id : args.activeId };
    },
    activateSavedSkin: async (args) => {
      calls.activateSavedSkin = args;
      return { activated: 1 };
    },
  };
  return { overrides, calls };
}

const THEMES = ["miku-light", "a", "b"].map((id) => ({ id, path: `dir-${id}` }));

test("apply --theme：坏主题不进菜单，菜单保持 listThemes 顺序", async () => {
  const { overrides, calls } = applyOverrides({ themes: THEMES, failLoad: new Set(["dir-a"]) });
  const result = await runCli(["apply", "--theme", "b"], overrides);
  assert.equal(result.themeId, "b");
  assert.deepEqual(calls.applySkin.themes.map(({ manifest }) => manifest.id), ["miku-light", "b"]);
  assert.equal(calls.applySkin.loadedTheme, calls.applySkin.themes[1]); // 选中主题只加载一次并复用
});

test("apply --theme：选中主题本身加载失败时直接报错", async () => {
  const { overrides } = applyOverrides({ themes: THEMES, failLoad: new Set(["dir-b"]) });
  await assert.rejects(runCli(["apply", "--theme", "b"], overrides), /broken dir-b/);
});

test("apply 无 --theme：恢复上次记住的自定义皮肤（先默认主题注入，再激活）", async () => {
  const { overrides, calls } = applyOverrides({ saved: "custom-xyz", themes: THEMES });
  const result = await runCli(["apply"], overrides);
  assert.equal(calls.applySkin.activeId, null);
  assert.deepEqual(calls.activateSavedSkin, { port: 9223, id: "custom-xyz", fallbackId: "miku-light" });
  assert.equal(result.themeId, "custom-xyz");
  assert.equal(result.restored, true);
});

test("apply 无 --theme：记住的内置主题已不存在时回退默认主题", async () => {
  const { overrides, calls } = applyOverrides({ saved: "gone", themes: THEMES });
  const result = await runCli(["apply"], overrides);
  assert.equal(result.themeId, "miku-light");
  assert.equal(calls.activateSavedSkin, null);
});

test("apply --theme：指定的主题不存在时报错", async () => {
  const { overrides } = applyOverrides({ themes: THEMES });
  await assert.rejects(runCli(["apply", "--theme", "nope"], overrides), /找不到主题：nope/);
});

// ---- 状态回执（state.json）：apply/pause 成功与失败都落记录，写失败不影响主流程 ----
function stateSpy() {
  const writes = [];
  return {
    writes,
    writeStateFile: async (patch) => { writes.push(patch); },
    readStateFile: async () => null,
  };
}

test("apply 成功：记录 lastApply（ok、themeId、applied）", async () => {
  const { overrides } = applyOverrides({ themes: THEMES });
  const spy = stateSpy();
  const result = await runCli(["apply", "--theme", "b"], { ...overrides, ...spy });
  assert.equal(result.themeId, "b");
  const lastApply = spy.writes.at(-1)?.lastApply;
  assert.equal(lastApply.ok, true);
  assert.equal(lastApply.themeId, "b");
  assert.equal(lastApply.applied, 1);
  assert.equal(typeof lastApply.at, "string");
});

test("apply 失败：记录 ok:false 与错误信息，错误照常抛出", async () => {
  const { overrides } = applyOverrides({ themes: THEMES });
  const spy = stateSpy();
  await assert.rejects(
    runCli(["apply", "--theme", "nope"], { ...overrides, ...spy }),
    /找不到主题：nope/,
  );
  const lastApply = spy.writes.at(-1)?.lastApply;
  assert.equal(lastApply.ok, false);
  assert.equal(lastApply.themeId, "nope");
  assert.ok(lastApply.error.includes("nope"));
});

test("apply：状态写入失败不阻断换肤结果", async () => {
  const { overrides } = applyOverrides({ themes: THEMES });
  const result = await runCli(["apply", "--theme", "b"], {
    ...overrides,
    writeStateFile: async () => { throw new Error("disk full"); },
  });
  assert.equal(result.themeId, "b");
});

test("pause：记录 lastPause（removed 数）", async () => {
  const spy = stateSpy();
  const result = await runCli(["pause"], {
    removeSkin: async () => ({ removed: 2 }),
    ...spy,
  });
  assert.equal(result.removed, 2);
  assert.deepEqual(spy.writes.at(-1).lastPause.removed, 2);
  assert.equal(spy.writes.at(-1).lastPause.ok, true);
});

// ---- watch 常驻看护：端口/间隔透传，reapply 复用 apply 编排 ----
test("watch：透传 port 与 interval，reapply 走 apply 路径", async () => {
  const { overrides, calls } = applyOverrides({ themes: THEMES });
  const spy = stateSpy();
  let watchArgs = null;
  const result = await runCli(["watch", "--port", "9333", "--interval", "800"], {
    ...overrides,
    ...spy,
    startWatch: async (args) => {
      watchArgs = args;
      await args.reapply(); // reapply 应触发一次完整 apply（含状态记录）
      return { stopped: true };
    },
  });
  assert.deepEqual(result, { stopped: true });
  assert.equal(watchArgs.port, 9333);
  assert.equal(watchArgs.intervalMs, 800);
  assert.equal(calls.applySkin.port, 9333); // reapply 沿用 watch 的端口
  assert.equal(spy.writes.at(-1).lastApply.ok, true);
});

test("watch：--interval 小于 500 报错", async () => {
  const { overrides } = applyOverrides({ themes: THEMES });
  await assert.rejects(runCli(["watch", "--interval", "100"], overrides), /--interval/);
});

// ---- doctor：Node 版本检查与状态回执一并输出 ----
test("doctor：包含 node 版本检查结果与 statePath，state 来自状态文件", async () => {
  const state = { lastApply: { ok: true, themeId: "miku-light" } };
  const report = await runCli(["doctor"], { readStateFile: async () => state });
  assert.equal(report.node.ok, true);
  assert.equal(report.node.version, process.version);
  assert.equal(report.node.required, ">=18");
  assert.equal(typeof report.statePath, "string");
  assert.deepEqual(report.state, state);
});

test("doctor：状态文件读取失败时 state 为 null 且不影响报告", async () => {
  const report = await runCli(["doctor"], { readStateFile: async () => { throw new Error("io"); } });
  assert.equal(report.state, null);
  assert.equal(typeof report.appFound, "boolean");
});
