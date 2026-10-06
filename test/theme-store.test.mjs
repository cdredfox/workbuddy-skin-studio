import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSingleImageTheme, listThemes } from "../src/theme-store.mjs";

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "wss-store-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeTheme(root, folder, manifest) {
  await mkdir(join(root, folder), { recursive: true });
  await writeFile(join(root, folder, "theme.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
}

test("listThemes：多个 root 出现同 id 时只保留先出现的（内置优先），避免菜单重复 id", async () => {
  await withTempDir(async (dir) => {
    const bundled = join(dir, "bundled");
    const user = join(dir, "user");
    await writeTheme(bundled, "a", { id: "dup", name: "Bundled" });
    await writeTheme(user, "b", { id: "dup", name: "User" });
    await writeTheme(user, "c", { id: "only-user", name: "Only" });
    const themes = await listThemes({ roots: [bundled, user] });
    assert.deepEqual(themes.map(({ id, name }) => [id, name]), [["dup", "Bundled"], ["only-user", "Only"]]);
  });
});

test("listThemes：name 缺失不再让排序抛 TypeError，回退按 id 排序", async () => {
  await withTempDir(async (dir) => {
    await writeTheme(dir, "x", { id: "zeta" });
    await writeTheme(dir, "y", { id: "alpha", name: "Beta" });
    const themes = await listThemes({ roots: [dir] });
    assert.deepEqual(themes.map(({ id }) => id), ["alpha", "zeta"]);
  });
});

test("listThemes：order 优先，其次名称；跳过坏 JSON、无 id 清单与 .tmp- 残留目录", async () => {
  await withTempDir(async (dir) => {
    await writeTheme(dir, "first", { id: "b-theme", name: "B", order: -1 });
    await writeTheme(dir, "second", { id: "a-theme", name: "A" });
    await writeTheme(dir, "broken", "{ not json");
    await writeTheme(dir, "noid", { name: "No id" });
    await writeTheme(dir, "half.tmp-1234", { id: "half", name: "Half" });
    const themes = await listThemes({ roots: [dir, join(dir, "missing-root")] });
    assert.deepEqual(themes.map(({ id }) => id), ["b-theme", "a-theme"]);
    assert.ok(themes[0].path.endsWith("first"));
  });
});

test("createSingleImageTheme：名称去首尾空白，空名称拒绝", async () => {
  await withTempDir(async (dir) => {
    const image = join(dir, "pic.png");
    await writeFile(image, Buffer.alloc(32, 1));
    const store = join(dir, "store");
    const created = await createSingleImageTheme({ imagePath: image, name: "  My Skin  ", storeRoot: store });
    assert.equal(created.manifest.name, "My Skin");
    assert.equal(created.manifest.schemaVersion, 1);
    assert.match(created.id, /^my-skin-[0-9a-f]{8}$/);
    await assert.rejects(createSingleImageTheme({ imagePath: image, name: "   ", storeRoot: store }), /名称不能为空/);
  });
});
