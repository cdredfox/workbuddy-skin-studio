import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import {
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";

import { resolveStudioPaths, THEME_SCHEMA_VERSION } from "./constants.mjs";

const COLOR_KEYS = ["accent", "secondary", "surface", "text"];
const COPY_KEYS = ["brand", "headline", "tagline"];
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const HEX_COLOR = /^#[0-9A-F]{6}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const THEME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_REMOTE_HERO_BYTES = 5 * 1024 * 1024;
const RELEASE_PATH = /^\/[^/]+\/workbuddy-skin\/releases\/download\/[^/]+\/[^/]+$/;
const DEFAULT_COLORS = {
  accent: "#4BC2E0",
  secondary: "#AD7ED5",
  surface: "#FAFAFF",
  text: "#122C60",
};

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isInside(root, candidate) {
  const relativePath = relative(root, candidate);
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function normalizeHero(hero) {
  if (
    typeof hero !== "string" ||
    !hero.trim() ||
    isAbsolute(hero) ||
    win32.isAbsolute(hero) ||
    hero.split(/[\\/]+/).includes("..")
  ) {
    throw new Error("theme hero must be a relative path inside the theme directory");
  }
  if (!IMAGE_EXTENSIONS.has(extname(hero).toLowerCase())) {
    throw new Error("theme hero must be PNG, JPEG, or WebP");
  }
  return hero;
}

function normalizeRemoteHero(input) {
  const configured = [input.heroUrl, input.heroSha256, input.heroBytes];
  if (configured.every((value) => value === undefined)) return null;
  if (configured.some((value) => value === undefined)) {
    throw new Error("remote hero requires heroUrl, heroSha256, and heroBytes");
  }

  let url;
  try {
    url = new URL(input.heroUrl);
  } catch {
    throw new Error("heroUrl must be a valid URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    !RELEASE_PATH.test(url.pathname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("heroUrl must be an immutable workbuddy-skin GitHub Release URL");
  }
  if (typeof input.heroSha256 !== "string" || !SHA256.test(input.heroSha256)) {
    throw new Error("heroSha256 must be a lowercase SHA-256 digest");
  }
  if (
    !Number.isInteger(input.heroBytes) ||
    input.heroBytes < 12 ||
    input.heroBytes > MAX_REMOTE_HERO_BYTES
  ) {
    throw new Error(`heroBytes must be between 12 and ${MAX_REMOTE_HERO_BYTES}`);
  }
  return {
    heroUrl: url.href,
    heroSha256: input.heroSha256,
    heroBytes: input.heroBytes,
  };
}

function normalizeColors(colors) {
  if (colors != null && !isRecord(colors)) {
    throw new Error("theme colors must be an object");
  }
  return Object.fromEntries(
    COLOR_KEYS.map((key) => {
      const configured = colors?.[key];
      const value = configured === undefined ? DEFAULT_COLORS[key] : configured;
      if (typeof value !== "string" || !HEX_COLOR.test(value)) {
        throw new Error(`${key} must be a six-digit hex color`);
      }
      return [key, value.toUpperCase()];
    }),
  );
}

function normalizeCopy(copy) {
  if (copy == null) return null;
  if (!isRecord(copy)) {
    throw new Error("theme copy must be null or an object");
  }

  return Object.fromEntries(
    COPY_KEYS.filter((key) => copy[key] !== undefined).map((key) => {
      if (typeof copy[key] !== "string") {
        throw new Error(`copy.${key} must be a string`);
      }
      return [key, copy[key]];
    }),
  );
}

export function validateThemeManifest(input) {
  if (!isRecord(input)) {
    throw new Error("theme manifest must be an object");
  }
  if (input.schemaVersion !== THEME_SCHEMA_VERSION) {
    throw new Error(`unsupported theme schema ${input.schemaVersion}`);
  }
  if (typeof input.id !== "string" || !THEME_ID.test(input.id)) {
    throw new Error("theme id must use lowercase letters, numbers, and hyphens");
  }
  if (typeof input.name !== "string" || !input.name.trim()) {
    throw new Error("theme name must be a non-empty string");
  }

  const remote = normalizeRemoteHero(input);
  return {
    schemaVersion: THEME_SCHEMA_VERSION,
    id: input.id,
    name: input.name.trim(),
    hero: normalizeHero(input.hero),
    ...(remote ?? {}),
    colors: normalizeColors(input.colors),
    copy: normalizeCopy(input.copy),
  };
}

async function validCachedHero(path, manifest) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size !== manifest.heroBytes) return false;
    const bytes = await readFile(path);
    return createHash("sha256").update(bytes).digest("hex") === manifest.heroSha256;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function assertWebp(bytes) {
  if (
    bytes.length < 12 ||
    bytes.subarray(0, 4).toString("ascii") !== "RIFF" ||
    bytes.subarray(8, 12).toString("ascii") !== "WEBP"
  ) {
    throw new Error("downloaded hero is not a WebP image");
  }
}

async function downloadRemoteHero(manifest, { cacheRoot, fetchImpl }) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const destinationRoot = resolve(cacheRoot, manifest.id);
  const destination = resolve(destinationRoot, manifest.hero);
  if (!isInside(resolve(cacheRoot), destination)) {
    throw new Error("theme cache path escapes the cache directory");
  }
  if (await validCachedHero(destination, manifest)) return destination;

  let response;
  try {
    response = await fetchImpl(manifest.heroUrl, { redirect: "follow" });
  } catch (error) {
    throw new Error(`下载主题图片失败：${error.message}`, { cause: error });
  }
  if (!response?.ok || typeof response.arrayBuffer !== "function") {
    throw new Error(`下载主题图片失败：HTTP ${response?.status ?? "unknown"}`);
  }
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REMOTE_HERO_BYTES) {
    throw new Error("远程主题图片超过 5 MB 限制");
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_REMOTE_HERO_BYTES) throw new Error("远程主题图片超过 5 MB 限制");
  if (bytes.length !== manifest.heroBytes) throw new Error("主题图片字节数校验失败");
  assertWebp(bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== manifest.heroSha256) throw new Error("主题图片 SHA-256 校验失败");

  await mkdir(destinationRoot, { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, bytes, { flag: "wx" });
  try {
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    if (!(await validCachedHero(destination, manifest))) throw error;
  }
  return destination;
}

async function localHero(root, manifest) {
  const heroPath = resolve(root, manifest.hero);
  if (!isInside(root, heroPath)) {
    throw new Error("theme hero escapes the theme directory");
  }
  try {
    const [realRoot, realHeroPath] = await Promise.all([
      realpath(root),
      realpath(heroPath),
    ]);
    if (!isInside(realRoot, realHeroPath)) {
      throw new Error("theme hero escapes the theme directory");
    }
    const info = await lstat(realHeroPath);
    if (!info.isFile() || info.size < 1) throw new Error("theme hero must be a non-empty file");
    return realHeroPath;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function loadTheme(
  themeDir,
  {
    cacheRoot = resolveStudioPaths().themeCacheRoot,
    fetchImpl = globalThis.fetch,
  } = {},
) {
  const root = resolve(themeDir);
  const raw = JSON.parse(await readFile(join(root, "theme.json"), "utf8"));
  const manifest = validateThemeManifest(raw);
  const localPath = await localHero(root, manifest);
  const heroPath = localPath ?? (
    manifest.heroUrl
      ? await downloadRemoteHero(manifest, { cacheRoot, fetchImpl })
      : null
  );
  if (!heroPath) throw new Error("theme hero is missing and no remote asset is configured");
  return { manifest, heroPath, root };
}
