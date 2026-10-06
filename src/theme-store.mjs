import { createHash } from "node:crypto";
import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import { IMAGE_EXTENSIONS, MAX_ANIMATED_DIMENSION, THEME_SCHEMA_VERSION } from "./constants.mjs";

// createSingleImageTheme 原子写入用的临时目录后缀；listThemes 据此跳过残留的半成品
const TEMP_DIR_MARKER = ".tmp-";

// 只读文件头探测动图分辨率，超限拒绝（动图不经压缩直接注入，需卡上限）
// GIF：宽高在头部 6-9 字节（LE uint16）；注意此处不分辨单帧/多帧，GIF 一律按动图处理
// （当前内置主题均为 WebP，无实际影响；仅影响自定义 GIF 的「动图」标注与尺寸上限）；
// 动态 WebP：VP8X chunk 画布尺寸在 24-29 字节
// （24 位 LE，存值 = 实际 - 1），flags 字节 bit 0x02 为动画标记；
// 动态 AVIF：ftyp 主品牌为 avis（静态为 avif），宽高在 meta 内的 ispe box
// （BE uint32 宽高，位于 "ispe" 标记 +8/+12 处），在前 4KB 内搜索即可覆盖常规文件
export async function probeAnimatedSize(imagePath, extension) {
  if (![".gif", ".webp", ".avif", ".avifs"].includes(extension)) return null;
  const handle = await open(imagePath, "r");
  try {
    const header = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(header, 0, 4096, 0);
    if (extension === ".gif") {
      if (bytesRead < 10 || header.toString("latin1", 0, 3) !== "GIF") return null;
      return { width: header.readUInt16LE(6), height: header.readUInt16LE(8) };
    }
    if (extension === ".webp") {
      if (bytesRead < 30) return null;
      if (header.toString("latin1", 0, 4) !== "RIFF" || header.toString("latin1", 8, 12) !== "WEBP") return null;
      if (header.toString("latin1", 12, 16) !== "VP8X" || !(header[20] & 0x02)) return null; // 静态 WebP 不限制
      return { width: 1 + header.readUIntLE(24, 3), height: 1 + header.readUIntLE(27, 3) };
    }
    if (bytesRead < 12 || header.toString("latin1", 4, 8) !== "ftyp") return null;
    if (header.toString("latin1", 8, 12) !== "avis") return null; // 静态 AVIF 不限制
    const ispe = header.indexOf("ispe", 12, "latin1");
    if (ispe < 0 || ispe + 16 > bytesRead) return null;
    return { width: header.readUInt32BE(ispe + 8), height: header.readUInt32BE(ispe + 12) };
  } finally {
    await handle.close();
  }
}

function slugify(value) {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "custom-skin";
}

export async function createSingleImageTheme({ imagePath, name: rawName, storeRoot, colors = {} }) {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) throw new Error("主题名称不能为空");
  const extension = extname(imagePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) {
    throw new Error("素材必须是 PNG、JPG、JPEG、WebP、GIF 或 AVIF 图片");
  }
  const source = await stat(imagePath);
  if (!source.isFile() || source.size === 0) throw new Error("素材图片不存在或为空");

  const animatedSize = await probeAnimatedSize(imagePath, extension);
  if (animatedSize && Math.max(animatedSize.width, animatedSize.height) > MAX_ANIMATED_DIMENSION) {
    throw new Error(
      `动图分辨率过高（${animatedSize.width}×${animatedSize.height}，最长边限 ${MAX_ANIMATED_DIMENSION}px），请缩小尺寸后再试`,
    );
  }

  const digest = createHash("sha256")
    .update(`${name}\0${basename(imagePath)}\0${source.size}\0${source.mtimeMs}`)
    .digest("hex")
    .slice(0, 8);
  const id = `${slugify(name)}-${digest}`;
  const destination = join(storeRoot, id);
  const temporary = `${destination}${TEMP_DIR_MARKER}${process.pid}`;
  const hero = `hero${extension}`;
  const manifest = {
    schemaVersion: THEME_SCHEMA_VERSION,
    id,
    name,
    hero,
    colors: {
      accent: colors.accent ?? "#24c9d7",
      secondary: colors.secondary ?? "#ef8fd3",
      surface: colors.surface ?? "#f7fbff",
      text: colors.text ?? "#17344f",
    },
    copy: null,
  };

  await mkdir(storeRoot, { recursive: true });
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  try {
    await copyFile(imagePath, join(temporary, hero));
    await writeFile(join(temporary, "theme.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await rm(destination, { recursive: true, force: true });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return { id, path: destination, manifest };
}

async function readRootManifests(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const manifests = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.includes(TEMP_DIR_MARKER))
      .map(async (entry) => {
        const path = join(root, entry.name);
        try {
          const manifest = JSON.parse(await readFile(join(path, "theme.json"), "utf8"));
          // 只做列表所需的最小校验（id 必须是字符串）；完整校验留给 loadTheme
          if (manifest === null || typeof manifest !== "object" || typeof manifest.id !== "string") return null;
          return { ...manifest, path };
        } catch {
          // A half-copied folder is ignored so listing remains fast and useful.
          return null;
        }
      }),
  );
  return manifests.filter(Boolean);
}

// roots 按优先级排列（cli 传入 [内置, 用户]）：同 id 只保留第一个出现的，
// 否则重复 id 会进入菜单，行 Map 互相覆盖、切换命中错误主题
export async function listThemes({ roots }) {
  const perRoot = await Promise.all(roots.map(readRootManifests));
  const seen = new Set();
  const themes = [];
  for (const manifest of perRoot.flat()) {
    if (seen.has(manifest.id)) continue;
    seen.add(manifest.id);
    themes.push(manifest);
  }
  // order 字段可选：数值小的排前，缺省按 0 处理，同值再按名称 locale 排序
  // （name 缺失/非字符串时回退 id，避免 localeCompare 抛 TypeError 让整个 list 失败）
  const rank = (theme) => (Number.isFinite(theme.order) ? theme.order : 0);
  const label = (theme) => (typeof theme.name === "string" ? theme.name : theme.id);
  return themes.sort((a, b) => rank(a) - rank(b) || label(a).localeCompare(label(b)));
}
