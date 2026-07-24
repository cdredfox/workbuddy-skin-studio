import { homedir } from "node:os";
import { join } from "node:path";

export const PRODUCT_ID = "workbuddy-skin";
export const PRODUCT_NAME = "workbuddy-skin";
export const STATE_SCHEMA_VERSION = 1;
export const THEME_SCHEMA_VERSION = 1;
export const DEFAULT_THEME_ID = "sunny-orchard";
export const DEFAULT_CDP_PORT = 9223;
export const EXPECTED_BUNDLE_ID = "com.workbuddy.workbuddy";

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
    themeCacheRoot: join(stateRoot, "cache", "themes"),
    userThemesRoot: join(stateRoot, "themes"),
  };
}
