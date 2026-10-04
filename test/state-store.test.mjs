import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { STATE_SCHEMA_VERSION } from "../src/constants.mjs";
import { readState, writeState } from "../src/state-store.mjs";

const freshPath = async () => join(await mkdtemp(join(tmpdir(), "wb-state-")), "state.json");

test("readState：文件不存在返回 null，不抛异常", async () => {
  assert.equal(await readState({ statePath: await freshPath() }), null);
});

test("writeState：新建写入并带 schemaVersion，读回内容一致", async () => {
  const statePath = await freshPath();
  const patch = { lastApply: { at: "2026-10-04T00:00:00Z", ok: true, themeId: "miku-light" } };
  const written = await writeState(patch, { statePath });
  assert.equal(written.schemaVersion, STATE_SCHEMA_VERSION);
  assert.deepEqual(await readState({ statePath }), written);
  // 落盘的是格式化 JSON + 尾换行
  const raw = await readFile(statePath, "utf8");
  assert.ok(raw.endsWith("}\n"));
});

test("writeState：patch 浅合并保留旧键，同名键整体替换", async () => {
  const statePath = await freshPath();
  await writeState({ lastApply: { ok: true, themeId: "a" } }, { statePath });
  const next = await writeState({ lastPause: { ok: true, removed: 2 } }, { statePath });
  assert.deepEqual(next.lastApply, { ok: true, themeId: "a" });
  assert.deepEqual(next.lastPause, { ok: true, removed: 2 });
  // 同名键整体替换而非深合并
  const replaced = await writeState({ lastApply: { ok: false, error: "boom" } }, { statePath });
  assert.deepEqual(replaced.lastApply, { ok: false, error: "boom" });
});

test("readState：损坏 JSON / 非对象内容一律回退 null", async () => {
  const dir = await freshPath();
  await writeFile(dir, "{ not json");
  assert.equal(await readState({ statePath: dir }), null);
  await writeFile(dir, "[1,2,3]");
  assert.equal(await readState({ statePath: dir }), null);
});

test("writeState：patch 非对象时拒绝写入", async () => {
  await assert.rejects(writeState(null, { statePath: await freshPath() }), TypeError);
  await assert.rejects(writeState([1], { statePath: await freshPath() }), TypeError);
});
