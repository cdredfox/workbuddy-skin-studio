import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadTheme } from "../src/theme-schema.mjs";

// 内置主题目录的集成护栏：每个 themes/<id>/ 都必须通过 loadTheme 完整校验；
// 携带伴随 js 的主题，js 文本必须可被 JS 引擎编译（防手滑改坏随包主题）
const themesRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "themes");

test("内置主题：全部通过 loadTheme 校验，伴随 js 可编译", async () => {
  const entries = await readdir(themesRoot, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  assert.ok(dirs.length >= 18, `内置主题数量异常：${dirs.length}`);
  const seen = new Set();
  for (const name of dirs) {
    const loaded = await loadTheme(join(themesRoot, name));
    assert.ok(!seen.has(loaded.manifest.id), `主题 id 重复：${loaded.manifest.id}`);
    seen.add(loaded.manifest.id);
    assert.equal(loaded.manifest.id, name, `目录名与主题 id 不一致：${name}`);
    if (loaded.jsPath) {
      const js = await readFile(loaded.jsPath, "utf8");
      assert.doesNotThrow(() => new Function(js), `${name} 的伴随 js 语法错误`);
    }
  }
});
