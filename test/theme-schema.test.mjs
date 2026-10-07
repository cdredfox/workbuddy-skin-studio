import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadTheme, validateThemeManifest } from "../src/theme-schema.mjs";

const base = { schemaVersion: 1, id: "demo-theme", name: "Demo", hero: "hero.png" };

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "wss-theme-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("normalizePoster：图片 hero 不允许带 poster", () => {
  assert.throws(
    () => validateThemeManifest({ ...base, poster: "poster.png" }),
    /only valid for video heroes/,
  );
});

test("normalizePoster：图片 hero 不带 poster 时归一为 null", () => {
  assert.equal(validateThemeManifest(base).poster, null);
});

test("normalizePoster：视频 hero 必须配 poster", () => {
  assert.throws(
    () => validateThemeManifest({ ...base, hero: "hero.mp4" }),
    /video hero requires a poster/,
  );
});

test("normalizePoster：视频主题 poster 必须是图片", () => {
  const video = { ...base, hero: "hero.mp4", poster: "poster.webp" };
  assert.equal(validateThemeManifest(video).poster, "poster.webp");
  assert.throws(
    () => validateThemeManifest({ ...video, poster: "poster.mp4" }),
    /poster must be/,
  );
});

test("normalizePoster：poster 必须是主题目录内的相对路径", () => {
  const video = { ...base, hero: "hero.mp4", poster: "poster.png" };
  for (const poster of ["../poster.png", "a/../../poster.png", "C:/poster.png", "/abs/poster.png", ""]) {
    assert.throws(
      () => validateThemeManifest({ ...video, poster }),
      /relative path inside the theme directory/,
      `poster=${JSON.stringify(poster)}`,
    );
  }
});

test("loadTheme：加载视频主题并解析 hero/poster 路径", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "hero.mp4"), Buffer.alloc(16, 1));
    await writeFile(join(dir, "poster.png"), Buffer.alloc(8, 2));
    await writeFile(
      join(dir, "theme.json"),
      JSON.stringify({ schemaVersion: 1, id: "video-theme", name: "Video", hero: "hero.mp4", poster: "poster.png" }),
    );
    const loaded = await loadTheme(dir);
    assert.equal(loaded.manifest.id, "video-theme");
    assert.ok(loaded.heroPath.endsWith("hero.mp4"));
    assert.ok(loaded.posterPath.endsWith("poster.png"));
  });
});

test("loadTheme：拒绝空 hero 文件", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "hero.png"), Buffer.alloc(0));
    await writeFile(join(dir, "theme.json"), JSON.stringify(base));
    await assert.rejects(loadTheme(dir), /non-empty file/);
  });
});

test("loadTheme：拒绝经目录联结（junction/symlink）逃逸主题目录的 hero", async (t) => {
  await withTempDir(async (dir) => {
    const outside = await mkdtemp(join(tmpdir(), "wss-outside-"));
    try {
      await writeFile(join(outside, "evil.png"), Buffer.alloc(8, 3));
      try {
        // junction 在 Windows 上无需提权；POSIX 下退化为普通目录 symlink
        await symlink(outside, join(dir, "linked"), "junction");
      } catch (error) {
        t.skip(`无法创建目录联结：${error.message}`);
        return;
      }
      await writeFile(
        join(dir, "theme.json"),
        JSON.stringify({ schemaVersion: 1, id: "escape-theme", name: "Escape", hero: "linked/evil.png" }),
      );
      await assert.rejects(loadTheme(dir), /escapes the theme directory/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("loadTheme：theme.json 非法 JSON 时报错带清单路径", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "theme.json"), "{ broken");
    await assert.rejects(loadTheme(dir), (error) => error.message.includes("theme.json") && /invalid theme manifest/.test(error.message));
  });
});

test("loadTheme：目录内指向合法文件的符号链接 hero 可正常加载", async (t) => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "assets"));
    await writeFile(join(dir, "assets", "real.png"), Buffer.alloc(8, 4));
    try {
      await symlink(join(dir, "assets", "real.png"), join(dir, "hero.png"), "file");
    } catch (error) {
      t.skip(`无法创建文件符号链接（Windows 需开发者模式/提权）：${error.message}`);
      return;
    }
    await writeFile(join(dir, "theme.json"), JSON.stringify(base));
    const loaded = await loadTheme(dir);
    assert.ok(loaded.heroPath.endsWith("hero.png"));
  });
});

test("css 主题：无 hero 合法，hero 归一为 null", () => {
  const manifest = validateThemeManifest({ schemaVersion: 1, id: "css-theme", name: "CSS", css: "skin.css" });
  assert.equal(manifest.hero, null);
  assert.equal(manifest.css, "skin.css");
  assert.equal(manifest.poster, null);
});

test("css 主题：css 必须是主题目录内的 .css 相对路径", () => {
  const cssBase = { schemaVersion: 1, id: "css-theme", name: "CSS" };
  for (const css of ["../skin.css", "a/../../skin.css", "C:/skin.css", "/abs/skin.css", "", "skin.png"]) {
    assert.throws(
      () => validateThemeManifest({ ...cssBase, css }),
      /theme css must be/,
      `css=${JSON.stringify(css)}`,
    );
  }
});

test("css 主题：无 hero 时不允许带 poster", () => {
  assert.throws(
    () => validateThemeManifest({ schemaVersion: 1, id: "css-theme", name: "CSS", css: "skin.css", poster: "p.png" }),
    /poster requires a video hero/,
  );
});

test("无 css 时 hero 必填", () => {
  assert.throws(
    () => validateThemeManifest({ schemaVersion: 1, id: "no-hero", name: "NoHero" }),
    /hero must be a relative path/,
  );
});

test("loadTheme：加载纯 CSS 主题并解析 cssPath", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "skin.css"), "body { color: red; }");
    await writeFile(
      join(dir, "theme.json"),
      JSON.stringify({ schemaVersion: 1, id: "css-theme", name: "CSS", css: "skin.css" }),
    );
    const loaded = await loadTheme(dir);
    assert.ok(loaded.cssPath.endsWith("skin.css"));
    assert.equal(loaded.heroPath, null);
    assert.equal(loaded.posterPath, null);
  });
});

test("loadTheme：css 文件缺失或为空时拒绝", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "theme.json"),
      JSON.stringify({ schemaVersion: 1, id: "css-theme", name: "CSS", css: "skin.css" }),
    );
    await assert.rejects(loadTheme(dir));
    await writeFile(join(dir, "skin.css"), "");
    await assert.rejects(loadTheme(dir), /non-empty file/);
  });
});

test("js 伴随脚本：仅纯 CSS 主题可携带，路径必须是目录内 .js", () => {
  const cssTheme = { schemaVersion: 1, id: "css-theme", name: "CSS", css: "skin.css" };
  assert.equal(validateThemeManifest({ ...cssTheme, js: "skin.js" }).js, "skin.js");
  assert.throws(
    () => validateThemeManifest({ ...base, js: "skin.js" }),
    /only valid together with a css theme/,
  );
  for (const js of ["../skin.js", "C:/skin.js", "", "skin.css"]) {
    assert.throws(() => validateThemeManifest({ ...cssTheme, js }), /theme js must be/, `js=${JSON.stringify(js)}`);
  }
});

test("group 分组：仅纯 CSS 主题可配置，取值限 custom/palette/scenery，CSS 主题缺省归 custom", () => {
  const cssTheme = { schemaVersion: 1, id: "css-theme", name: "CSS", css: "skin.css" };
  // 缺省：CSS 主题归 custom（定制主题），图片主题无分组（注入侧固定归 image）
  assert.equal(validateThemeManifest(cssTheme).group, "custom");
  assert.equal(validateThemeManifest(base).group, null);
  // 显式配置
  assert.equal(validateThemeManifest({ ...cssTheme, group: "palette" }).group, "palette");
  assert.equal(validateThemeManifest({ ...cssTheme, group: "custom" }).group, "custom");
  assert.equal(validateThemeManifest({ ...cssTheme, group: "scenery" }).group, "scenery");
  // 图片主题不允许携带 group（含 scenery——纯 CSS 分类）
  assert.throws(
    () => validateThemeManifest({ ...base, group: "palette" }),
    /only valid together with a css theme/,
  );
  assert.throws(
    () => validateThemeManifest({ ...base, group: "scenery" }),
    /only valid together with a css theme/,
  );
  // 非法取值
  for (const group of ["image", "", "Palette", 1]) {
    assert.throws(
      () => validateThemeManifest({ ...cssTheme, group }),
      /theme group must be/,
      `group=${JSON.stringify(group)}`,
    );
  }
});

test("loadTheme：解析 jsPath，缺失时拒绝", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "skin.css"), "body { color: red; }");
    await writeFile(
      join(dir, "theme.json"),
      JSON.stringify({ schemaVersion: 1, id: "css-theme", name: "CSS", css: "skin.css", js: "skin.js" }),
    );
    await assert.rejects(loadTheme(dir));
    await writeFile(join(dir, "skin.js"), "return null;");
    const loaded = await loadTheme(dir);
    assert.ok(loaded.jsPath.endsWith("skin.js"));
  });
});

test("thumbnail：可选，任意主题可配，路径必须是目录内图片", () => {
  const cssTheme = { schemaVersion: 1, id: "css-theme", name: "CSS", css: "skin.css" };
  assert.equal(validateThemeManifest(cssTheme).thumbnail, null);
  assert.equal(validateThemeManifest({ ...cssTheme, thumbnail: "thumb.webp" }).thumbnail, "thumb.webp");
  assert.equal(validateThemeManifest({ ...base, thumbnail: "cover.png" }).thumbnail, "cover.png");
  for (const thumbnail of ["../t.webp", "C:/t.webp", "", "t.mp4", "t.svg"]) {
    assert.throws(
      () => validateThemeManifest({ ...cssTheme, thumbnail }),
      /theme thumbnail must be/,
      `thumbnail=${JSON.stringify(thumbnail)}`,
    );
  }
});

test("loadTheme：解析 thumbnailPath，缺失或超过体积上限时拒绝", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "skin.css"), "body { color: red; }");
    await writeFile(
      join(dir, "theme.json"),
      JSON.stringify({ schemaVersion: 1, id: "css-theme", name: "CSS", css: "skin.css", thumbnail: "thumb.webp" }),
    );
    await assert.rejects(loadTheme(dir));
    await writeFile(join(dir, "thumb.webp"), Buffer.alloc(1024, 1));
    const loaded = await loadTheme(dir);
    assert.ok(loaded.thumbnailPath.endsWith("thumb.webp"));
    await writeFile(join(dir, "thumb.webp"), Buffer.alloc(512 * 1024 + 1, 1));
    await assert.rejects(loadTheme(dir), /thumbnail exceeds/);
  });
});
