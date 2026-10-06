import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_CDP_PORT,
  DEFAULT_THEME_ID,
  IMAGE_EXTENSIONS,
  MAX_ANIMATED_DIMENSION,
  MAX_THEME_THUMBNAIL_BYTES,
  MAX_THEME_VIDEO_BYTES,
  PRODUCT_ID,
  RENDERER_URL_HINT,
  VIDEO_DB_NAME,
  VIDEO_DB_STORE,
  resolveStudioPaths,
} from "../src/constants.mjs";

test("resolveStudioPaths：installRoot 跟随 home，状态类路径统一挂在 stateRoot 下", () => {
  const home = join("home-dir");
  const paths = resolveStudioPaths({ home });
  assert.equal(paths.installRoot, join(home, ".workbuddy", PRODUCT_ID));
  assert.equal(paths.statePath, join(paths.stateRoot, "state.json"));
  assert.equal(paths.logPath, join(paths.stateRoot, "injector.log"));
  assert.equal(paths.userThemesRoot, join(paths.stateRoot, "themes"));
});

test("resolveStudioPaths：Windows 下 stateRoot 优先 LOCALAPPDATA，缺失时回退 home/AppData/Local", (t) => {
  if (process.platform !== "win32") return t.skip("仅 Windows 布局");
  const saved = process.env.LOCALAPPDATA;
  try {
    process.env.LOCALAPPDATA = "X:\\LocalAppData";
    assert.equal(resolveStudioPaths({ home: "C:\\Users\\u" }).stateRoot, join("X:\\LocalAppData", "WorkBuddySkinStudio"));
    delete process.env.LOCALAPPDATA;
    assert.equal(
      resolveStudioPaths({ home: "C:\\Users\\u" }).stateRoot,
      join("C:\\Users\\u", "AppData", "Local", "WorkBuddySkinStudio"),
    );
  } finally {
    if (saved === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = saved;
  }
});

test("resolveStudioPaths：非 Windows 按 macOS 布局落到 ~/Library/Application Support", (t) => {
  if (process.platform === "win32") return t.skip("仅非 Windows 布局");
  assert.equal(
    resolveStudioPaths({ home: "/Users/u" }).stateRoot,
    join("/Users/u", "Library", "Application Support", "WorkBuddySkinStudio"),
  );
});

test("常量不变量：体积上限、图片扩展名、IndexedDB 库名与默认值", () => {
  // 30MB 与皮肤菜单自定义视频上传上限保持一致，改动需两侧同步
  assert.equal(MAX_THEME_VIDEO_BYTES, 30 * 1024 * 1024);
  // 缩略图随注入脚本逐主题下发，必须卡小
  assert.equal(MAX_THEME_THUMBNAIL_BYTES, 512 * 1024);
  for (const ext of [".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"]) {
    assert.ok(IMAGE_EXTENSIONS.has(ext), `IMAGE_EXTENSIONS 缺少 ${ext}`);
  }
  assert.ok(Number.isInteger(MAX_ANIMATED_DIMENSION) && MAX_ANIMATED_DIMENSION > 0);
  assert.ok(Number.isInteger(DEFAULT_CDP_PORT) && DEFAULT_CDP_PORT >= 1024 && DEFAULT_CDP_PORT <= 65535);
  assert.equal(typeof DEFAULT_THEME_ID, "string");
  assert.equal(typeof VIDEO_DB_NAME, "string");
  assert.equal(typeof VIDEO_DB_STORE, "string");
  assert.ok(RENDERER_URL_HINT.includes("renderer"));
});
