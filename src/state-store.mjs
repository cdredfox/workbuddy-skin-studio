import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { STATE_SCHEMA_VERSION, resolveStudioPaths } from "./constants.mjs";

// 状态回执（state.json）：记录最近一次 apply / pause 的结果，
// 供 doctor 展示「上次注入于何时、哪个主题、是否成功」，升级失效时诊断更直接。
// 只增不改语义：patch 按键浅合并，lastApply / lastPause 各自整体替换。

export async function readState({ statePath } = {}) {
  const path = statePath ?? resolveStudioPaths().statePath;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    // 只接受扁平对象：数组/标量/ null 视为损坏，等同不存在
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    // 文件不存在 / JSON 损坏 / 权限不足：状态是诊断增强项，一律回退 null 不报错
    return null;
  }
}

export async function writeState(patch, { statePath } = {}) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    throw new TypeError("state patch must be a plain object");
  }
  const path = statePath ?? resolveStudioPaths().statePath;
  const current = (await readState({ statePath: path })) ?? {};
  const next = { ...current, ...patch, schemaVersion: STATE_SCHEMA_VERSION };
  await mkdir(dirname(path), { recursive: true });
  // 原子写入：先写临时文件再 rename，进程中断也不会留下半个 JSON
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
  await rename(tmp, path);
  return next;
}
