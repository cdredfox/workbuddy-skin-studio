import { homedir } from "node:os";
import { join } from "node:path";

export const PRODUCT_ID = "workbuddy-skin-studio";
export const PRODUCT_NAME = "WorkBuddy Skin Studio";
export const STATE_SCHEMA_VERSION = 1;
export const THEME_SCHEMA_VERSION = 1;
export const DEFAULT_THEME_ID = "miku-light";
export const DEFAULT_CDP_PORT = 9223;
// 内置视频主题（hero 为 MP4）的体积上限；与皮肤菜单里自定义视频上传的 30MB 上限保持一致
export const MAX_THEME_VIDEO_BYTES = 30 * 1024 * 1024;
// 主题选择弹窗缩略图（theme.json thumbnail）体积上限：以 data URL 随注入脚本下发，
// 每个主题都会进 payload，需卡小（建议 640×400 WebP，几十 KB）
export const MAX_THEME_THUMBNAIL_BYTES = 512 * 1024;
export const EXPECTED_BUNDLE_ID = "com.workbuddy.workbuddy";

// 主题素材：hero/poster 允许的图片扩展名（theme-schema 校验、theme-store 创建共用）
export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".avifs"]);
// 动图不经压缩直接注入，需单独卡分辨率上限（Node 端 create 与渲染进程菜单上传共用）
export const MAX_ANIMATED_DIMENSION = 1920;

// 渲染进程 IndexedDB：视频皮肤原始文件存储（Node 端预置与菜单脚本共用同一个库）
export const VIDEO_DB_NAME = "workbuddy-skin-studio";
export const VIDEO_DB_STORE = "videos";

// WorkBuddy renderer target 的 URL 特征：app.asar/renderer/index.html
export const RENDERER_URL_HINT = "renderer/index.html";

export function resolveStudioPaths({ home = homedir() } = {}) {
  const isWin = process.platform === "win32";
  const installRoot = join(home, ".workbuddy", PRODUCT_ID);
  const stateRoot = isWin
    ? join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "WorkBuddySkinStudio")
    : join(home, "Library", "Application Support", "WorkBuddySkinStudio");

  return {
    installRoot,
    stateRoot,
    statePath: join(stateRoot, "state.json"),
    logPath: join(stateRoot, "injector.log"),
    userThemesRoot: join(stateRoot, "themes"),
  };
}
