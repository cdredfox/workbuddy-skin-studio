import { readFile, realpath, stat } from "node:fs/promises";
import {
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";

import {
  IMAGE_EXTENSIONS,
  MAX_THEME_THUMBNAIL_BYTES,
  MAX_THEME_VIDEO_BYTES,
  THEME_SCHEMA_VERSION,
} from "./constants.mjs";

const COLOR_KEYS = ["accent", "secondary", "surface", "text"];
const COPY_KEYS = ["brand", "headline", "tagline"];
const VIDEO_EXTENSIONS = new Set([".mp4"]);
const HERO_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);
const HEX_COLOR = /^#[0-9A-F]{6}$/i;
const THEME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
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

function normalizeMediaPath(value, label, extensions, types) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    value.split(/[\\/]+/).includes("..")
  ) {
    throw new Error(`theme ${label} must be a relative path inside the theme directory`);
  }
  if (!extensions.has(extname(value).toLowerCase())) {
    throw new Error(`theme ${label} must be ${types}`);
  }
  return value;
}

function normalizeHero(hero, hasCss) {
  // 纯 CSS 主题（定制主题移植）无 hero 底图；无 css 时 hero 必填
  if (hero === undefined || hero === null) {
    if (hasCss) return null;
    throw new Error("theme hero must be a relative path inside the theme directory");
  }
  return normalizeMediaPath(hero, "hero", HERO_EXTENSIONS, "PNG, JPEG, WebP, GIF, AVIF, or MP4");
}

function normalizeCss(css) {
  if (css === undefined || css === null) return null;
  return normalizeMediaPath(css, "css", new Set([".css"]), "a CSS file");
}

// 伴随 JS（如 TDP 英雄层的 DOM 注入）：只允许挂在纯 CSS 主题上，
// 随主题激活执行、切换/暂停时调用其返回的拆除函数
function normalizeJs(js, hasCss) {
  if (js === undefined || js === null) return null;
  if (!hasCss) throw new Error("theme js is only valid together with a css theme");
  return normalizeMediaPath(js, "js", new Set([".js"]), "a JS file");
}

// 弹窗分组：仅对纯 CSS 主题有意义。custom=定制主题（默认，如 TDP/QQ2008 整页移植），
// palette=配色主题（无图纯配色移植，如 workbuddy-skin-skill 的 10 套配色）；
// 图片/视频主题不提供此字段（注入侧固定归 image 组）
const THEME_GROUPS = new Set(["custom", "palette", "scenery"]);

function normalizeGroup(group, hasCss) {
  if (group === undefined || group === null) return hasCss ? "custom" : null;
  if (!hasCss) throw new Error("theme group is only valid together with a css theme");
  if (typeof group !== "string" || !THEME_GROUPS.has(group)) {
    throw new Error('theme group must be "custom", "palette", or "scenery"');
  }
  return group;
}

// 视频主题（hero 为 MP4）必须配 poster 海报帧图片：作 CSS 底图兜底，
// 视频异步挂载/解码失败时不至于裸奔；图片 hero 不允许带 poster
function normalizePoster(poster, hero) {
  const isVideo = VIDEO_EXTENSIONS.has(extname(hero).toLowerCase());
  if (!isVideo) {
    if (poster !== undefined) throw new Error("theme poster is only valid for video heroes");
    return null;
  }
  if (poster === undefined) throw new Error("video hero requires a poster image");
  return normalizeMediaPath(poster, "poster", IMAGE_EXTENSIONS, "PNG, JPEG, WebP, GIF, or AVIF");
}

// 主题选择弹窗缩略图（可选，任意主题可用）：纯 CSS 主题无 hero 可取，靠它提供封面；
// 图片/视频主题配置后覆盖从 hero/poster 自动提取的封面
function normalizeThumbnail(thumbnail) {
  if (thumbnail === undefined || thumbnail === null) return null;
  return normalizeMediaPath(thumbnail, "thumbnail", IMAGE_EXTENSIONS, "PNG, JPEG, WebP, GIF, or AVIF");
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

  const css = normalizeCss(input.css);
  const hero = normalizeHero(input.hero, css !== null);
  if (hero === null && input.poster !== undefined) {
    throw new Error("theme poster requires a video hero");
  }
  return {
    schemaVersion: THEME_SCHEMA_VERSION,
    id: input.id,
    name: input.name.trim(),
    hero,
    poster: hero === null ? null : normalizePoster(input.poster, hero),
    css,
    js: normalizeJs(input.js, css !== null),
    group: normalizeGroup(input.group, css !== null),
    thumbnail: normalizeThumbnail(input.thumbnail),
    colors: normalizeColors(input.colors),
    copy: normalizeCopy(input.copy),
  };
}

async function resolveMediaFile({ root, realRoot }, mediaPath, label) {
  const filePath = resolve(root, mediaPath);
  if (!isInside(root, filePath)) {
    throw new Error(`theme ${label} escapes the theme directory`);
  }

  const realFilePath = await realpath(filePath);
  if (!isInside(realRoot, realFilePath)) {
    throw new Error(`theme ${label} escapes the theme directory`);
  }

  // 校验解析后的真实文件：对目录内合法的符号链接，lstat 拿到的是链接本身（isFile=false），
  // 会把合法主题误拒；逃逸已由上面的 realpath 检查拦截
  const info = await stat(realFilePath);
  if (!info.isFile() || info.size < 1) {
    throw new Error(`theme ${label} must be a non-empty file`);
  }
  return { path: filePath, size: info.size };
}

export async function loadTheme(themeDir) {
  const root = resolve(themeDir);
  const manifestPath = join(root, "theme.json");
  let raw;
  try {
    raw = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`invalid theme manifest ${manifestPath}: ${error.message}`, { cause: error });
  }
  const manifest = validateThemeManifest(raw);

  const dirs = { root, realRoot: await realpath(root) };
  // 纯 CSS 主题（css 字段、无 hero）：只校验 css 文件本身；url()/import 资源
  // 在注入阶段由 injector 内联时再逐个解析校验
  const hero = manifest.hero === null ? null : await resolveMediaFile(dirs, manifest.hero, "hero");
  if (hero && VIDEO_EXTENSIONS.has(extname(manifest.hero).toLowerCase()) && hero.size > MAX_THEME_VIDEO_BYTES) {
    throw new Error(
      `theme hero video exceeds the ${MAX_THEME_VIDEO_BYTES / 1024 / 1024}MB limit`,
    );
  }
  const poster = manifest.poster
    ? await resolveMediaFile(dirs, manifest.poster, "poster")
    : null;
  const css = manifest.css ? await resolveMediaFile(dirs, manifest.css, "css") : null;
  const js = manifest.js ? await resolveMediaFile(dirs, manifest.js, "js") : null;
  const thumbnail = manifest.thumbnail
    ? await resolveMediaFile(dirs, manifest.thumbnail, "thumbnail")
    : null;
  if (thumbnail && thumbnail.size > MAX_THEME_THUMBNAIL_BYTES) {
    throw new Error(`theme thumbnail exceeds the ${MAX_THEME_THUMBNAIL_BYTES / 1024}KB limit`);
  }

  return {
    manifest,
    heroPath: hero?.path ?? null,
    posterPath: poster?.path ?? null,
    cssPath: css?.path ?? null,
    jsPath: js?.path ?? null,
    thumbnailPath: thumbnail?.path ?? null,
    root,
  };
}
