#!/usr/bin/env node
// 一条命令把图片 / 动图 / 视频素材做成内置主题 themes/<id>/
//
//   node scripts/make-theme.mjs <素材路径> --id my-theme --name "我的主题" [选项]
//
// 流程（与 .workbuddy/memory/MEMORY.md 的 SOP 一致）：
//   静态图 → 居中裁 16:9 → 宽≤1600、偶数尺寸、不放大 → hero.webp（q90，>300KB 逐级降质）
//   动图   → 裁 16:9 → 动画 WebP，≤3MB（宽度/质量阶梯逐级压缩）
//   视频   → 不合规（非 H.264/yuv420p/MP4、带音轨、非 16:9、长边>1920、fps>30、>30MB）即转码：
//            档 A CRF 单遍 → 档 B 两遍定码率（28MiB 预算）→ 档 C 截取 ≤60s 再两遍；
//            抽帧生成 poster hero.webp
//   取色   → 与 🎨 菜单 extractPalette 同算法（饱和度² 加权色相桶）；
//            明暗按 hero/poster 平均亮度选 buildSurfaces 的 light/dark 公式
//   收尾   → 写 theme.json → loadTheme 校验 → 安装到 themes/<id>/ → README 内置主题表加一行
//
// 依赖 PATH 上的 ffmpeg / ffprobe（可用环境变量 FFMPEG_PATH / FFPROBE_PATH 覆盖）。
import { execFile } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

import { MAX_ANIMATED_DIMENSION, MAX_THEME_VIDEO_BYTES, THEME_SCHEMA_VERSION } from "../src/constants.mjs";
import { loadTheme, validateThemeManifest } from "../src/theme-schema.mjs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const LIMITS = Object.freeze({
  heroWidth: 1600,
  imageWarnWidth: 1280,
  imageTargetBytes: 300 * 1024,
  imageQualities: [90, 82, 75],
  animatedBytes: 3 * 1024 * 1024, // 与 skin-menu.mjs MAX_ANIMATED_BYTES 一致（localStorage 配额）
  animatedWidths: [Math.min(1280, MAX_ANIMATED_DIMENSION), 960, 720, 540],
  animatedQualities: [75, 60, 45],
  videoLongSide: 1920,
  maxFps: 30,
  videoBytes: MAX_THEME_VIDEO_BYTES,
  videoBudgetMiB: 28, // 两遍编码目标体积，给容器开销/码率波动留 2MiB 余量
  defaultCrf: 23,
  minBitrateK: 1500, // 低于此码率 1080p 画质明显崩坏 → 截段
  trimSeconds: 60,
  aspect: 16 / 9,
  aspectTolerance: 0.01,
});

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".bmp", ".tif", ".tiff"]);

// ───────────────────────── 纯函数（便于单测） ─────────────────────────

export function cropFilter(focus = { x: 0.5, y: 0.5 }) {
  const fx = clamp01(focus.x), fy = clamp01(focus.y);
  return `crop='min(iw,ih*16/9)':'min(ih,iw*9/16)':'(iw-ow)*${fx}':'(ih-oh)*${fy}'`;
}

export function scaleFilter(maxWidth) {
  // 宽取偶数且不放大，高按比例取偶数（VP8 / yuv420p 均要求偶数宽高）
  return `scale='trunc(min(${maxWidth},iw)/2)*2':-2:flags=lanczos`;
}

export function parseFocus(value) {
  if (value == null) return { x: 0.5, y: 0.5 };
  const m = /^\s*(\d+(?:\.\d+)?)\s*[,:]\s*(\d+(?:\.\d+)?)\s*$/.exec(String(value));
  if (!m) throw new Error(`--focus 格式应为 "x,y"（0-100 百分比），收到：${value}`);
  return { x: clamp01(Number(m[1]) / 100), y: clamp01(Number(m[2]) / 100) };
}

export function parseRate(rate) {
  if (!rate || rate === "0/0") return 0;
  const [n, d] = String(rate).split("/").map(Number);
  return d ? n / d : n;
}

// 列出视频不满足内置主题约束的原因；空数组 = 可原样使用
export function videoIssues(info, ext) {
  const issues = [];
  if (ext !== ".mp4") issues.push(`容器 ${ext} 非 MP4`);
  if (info.codec !== "h264") issues.push(`编码 ${info.codec} 非 H.264`);
  if (info.pixFmt !== "yuv420p") issues.push(`像素格式 ${info.pixFmt} 非 yuv420p`);
  if (info.hasAudio) issues.push("带音轨");
  if (Math.abs(info.width / info.height - LIMITS.aspect) / LIMITS.aspect > LIMITS.aspectTolerance) {
    issues.push(`画幅 ${info.width}×${info.height} 非 16:9`);
  }
  if (Math.max(info.width, info.height) > LIMITS.videoLongSide) issues.push(`长边 ${Math.max(info.width, info.height)} > ${LIMITS.videoLongSide}`);
  if (info.fps > LIMITS.maxFps + 0.01) issues.push(`帧率 ${round2(info.fps)} > ${LIMITS.maxFps}`);
  if (info.size > LIMITS.videoBytes) issues.push(`体积 ${mb(info.size)} > ${mb(LIMITS.videoBytes)}`);
  return issues;
}

// 两遍定码率规划：预算 28MiB / 时长；码率过低时截段到 ≤60s
export function planBitrate(durationSec, { maxSeconds } = {}) {
  let seconds = maxSeconds ? Math.min(durationSec, maxSeconds) : durationSec;
  const budgetKbit = LIMITS.videoBudgetMiB * 8192;
  let kbps = Math.floor(budgetKbit / seconds);
  let trimmed = Boolean(maxSeconds && maxSeconds < durationSec);
  if (kbps < LIMITS.minBitrateK) {
    seconds = Math.min(seconds, LIMITS.trimSeconds);
    kbps = Math.floor(budgetKbit / seconds);
    trimmed = true;
  }
  return { kbps, seconds, trimmed };
}

export const hex = (r, g, b) =>
  "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("").toUpperCase();
export const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// 与 src/skin-menu.mjs buildSurfaces 保持同公式
export function buildSurfaces(accentRgb) {
  return {
    light: { surface: hex(...mix(accentRgb, [252, 252, 255], 0.92)), text: hex(...mix(accentRgb, [16, 24, 40], 0.82)) },
    dark: { surface: hex(...mix(accentRgb, [12, 12, 18], 0.86)), text: hex(...mix(accentRgb, [244, 246, 252], 0.85)) },
  };
}

// 与 src/skin-menu.mjs extractPalette 保持同算法；px 为 RGB24 连续字节
export function extractPalette(px) {
  const buckets = new Map();
  for (let i = 0; i + 2 < px.length; i += 3) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const sat = max === 0 ? 0 : (max - min) / max;
    if (sat < 0.18 || lum < 24 || lum > 245) continue;
    const d = max - min || 1;
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    const bucket = (Math.round(h) % 6) * 2 + (sat > 0.55 ? 1 : 0);
    const entry = buckets.get(bucket) ?? { w: 0, r: 0, g: 0, b: 0, h: h * 60 };
    const weight = sat * sat;
    entry.w += weight; entry.r += r * weight; entry.g += g * weight; entry.b += b * weight;
    buckets.set(bucket, entry);
  }
  const ranked = [...buckets.values()].sort((a, b) => b.w - a.w)
    .map((e) => ({ rgb: [e.r / e.w, e.g / e.w, e.b / e.w], h: e.h }));
  const accent = ranked[0]?.rgb ?? [36, 201, 215];
  const secondary = ranked.find((e) => Math.abs(e.h - (ranked[0]?.h ?? 0)) > 50)?.rgb ?? mix(accent, [255, 255, 255], 0.35);
  return { accent, secondary };
}

export function meanLuminance(px) {
  let sum = 0, n = 0;
  for (let i = 0; i + 2 < px.length; i += 3) { sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]; n++; }
  return n ? sum / n : 128;
}

export const decideMode = (lum) => (lum < 128 ? "dark" : "light");

export function hueName(rgb) {
  const [r, g, b] = rgb.map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
  if (s < 0.15 || max - min < 0.06) return l > 0.7 ? "米白" : l < 0.25 ? "墨黑" : "灰";
  const d = max - min;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  if (h < 15 || h >= 345) return "红";
  if (h < 40) return l < 0.35 ? "棕" : "橙";
  if (h < 65) return "金";
  if (h < 160) return l < 0.3 ? "墨绿" : "绿";
  if (h < 200) return "青";
  if (h < 250) return l < 0.3 ? "深蓝" : "蓝";
  if (h < 290) return "紫";
  return "粉";
}

export function styleLabel({ accent, secondary, mode, kind }) {
  const a = hueName(accent), s = hueName(secondary);
  // 同色系深浅变体（深蓝/蓝、墨绿/绿）只写主色
  const hue = a === s || a.includes(s) || s.includes(a) ? a : `${a} × ${s}`;
  const parts = [hue, mode === "dark" ? "深色" : "浅色"];
  if (kind === "video") parts.push("MP4 视频");
  if (kind === "animated") parts.push("动图");
  return parts.join(" · ");
}

// README「内置主题」表插入一行：放在首个 CSS 主题（qq2008）之前，保持图片/视频主题聚在一起；
// 已存在同 id 行时 replace=true 则替换，否则返回 null
export function insertReadmeRow(text, { id, name, style }, { replace = false } = {}) {
  const row = `| \`${id}\` | ${name} | ${style} |`;
  const lines = text.split(/\r?\n/);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const existing = lines.findIndex((line) => line.startsWith(`| \`${id}\` |`));
  if (existing >= 0) {
    if (!replace) return null;
    lines[existing] = row;
    return lines.join(eol);
  }
  const heading = lines.findIndex((line) => /^##\s.*内置主题/.test(line));
  if (heading < 0) throw new Error("README 中未找到「内置主题」小节");
  let at = lines.findIndex((line, i) => i > heading && line.startsWith("| `qq2008` |"));
  if (at < 0) {
    const first = lines.findIndex((line, i) => i > heading && line.startsWith("|"));
    if (first < 0) throw new Error("README「内置主题」小节下未找到表格");
    at = first;
    while (at < lines.length && lines[at].startsWith("|")) at++;
  }
  lines.splice(at, 0, row);
  return lines.join(eol);
}

// ───────────────────────── ffmpeg 封装 ─────────────────────────

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

async function exec(bin, args, { encoding = "utf8" } = {}) {
  try {
    const { stdout } = await execFileAsync(bin, args, { encoding, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
    return stdout;
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`未找到 ${bin}，请安装 ffmpeg 并加入 PATH（或设置 FFMPEG_PATH / FFPROBE_PATH）`);
    const tail = String(error.stderr ?? "").trim().split(/\r?\n/).slice(-6).join("\n");
    throw new Error(`${bin} 执行失败：${tail || error.message}`);
  }
}

const ffmpeg = (args) => exec(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-y", ...args]);

export async function probe(file) {
  const ext = extname(file).toLowerCase();
  const isVideoExt = VIDEO_EXTENSIONS.has(ext);
  const args = ["-v", "error", "-show_entries",
    "stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,pix_fmt,nb_read_packets:format=duration,size",
    "-of", "json"];
  if (!isVideoExt) args.push("-count_packets");
  const json = JSON.parse(await exec(FFPROBE, [...args, file]));
  const v = json.streams?.find((s) => s.codec_type === "video");
  if (!v) throw new Error(`素材中没有可用的画面流：${file}`);
  const size = Number(json.format?.size) || (await stat(file)).size;
  const info = {
    ext,
    codec: v.codec_name,
    pixFmt: v.pix_fmt,
    width: Number(v.width),
    height: Number(v.height),
    fps: parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate),
    duration: Number(json.format?.duration) || 0,
    size,
    hasAudio: json.streams.some((s) => s.codec_type === "audio"),
  };
  if (isVideoExt) info.kind = "video";
  else if (IMAGE_EXTENSIONS.has(ext)) info.kind = Number(v.nb_read_packets) > 1 ? "animated" : "image";
  else throw new Error(`不支持的素材扩展名 ${ext}`);
  return info;
}

async function samplePixels(file, width) {
  const buf = await exec(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-i", file, "-frames:v", "1",
    "-vf", `scale=${width}:-1:flags=area`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer" });
  if (!buf.length) throw new Error(`无法从 ${file} 解码取色样本`);
  return buf;
}

const sizeOf = async (file) => (await stat(file)).size;

async function encodeStill(src, out, { focus, log, seek }) {
  const vf = `${cropFilter(focus)},${scaleFilter(LIMITS.heroWidth)}`;
  let bytes = 0;
  for (const q of LIMITS.imageQualities) {
    await ffmpeg([...(seek != null ? ["-ss", String(seek)] : []), "-i", src, "-frames:v", "1", "-vf", vf,
      "-c:v", "libwebp", "-quality", String(q), "-compression_level", "6", out]);
    bytes = await sizeOf(out);
    if (bytes <= LIMITS.imageTargetBytes) break;
    log(`  webp q${q} = ${kb(bytes)}，超过 ${kb(LIMITS.imageTargetBytes)} 目标，降质重试`);
  }
  return bytes;
}

async function encodeAnimated(src, out, { focus, log }) {
  for (const width of LIMITS.animatedWidths) {
    for (const q of LIMITS.animatedQualities) {
      await ffmpeg(["-i", src, "-vf", `${cropFilter(focus)},${scaleFilter(width)}`,
        "-c:v", "libwebp_anim", "-loop", "0", "-quality", String(q), "-compression_level", "6", out]);
      const bytes = await sizeOf(out);
      log(`  动画 webp 宽≤${width} q${q} = ${mb(bytes)}`);
      if (bytes <= LIMITS.animatedBytes) return bytes;
    }
  }
  throw new Error(`动图压到最小档仍超过 ${mb(LIMITS.animatedBytes)}，请先裁短/降帧后再试`);
}

function videoFilter(info, focus) {
  const parts = [cropFilter(focus), scaleFilter(LIMITS.videoLongSide)];
  if (info.fps > LIMITS.maxFps + 0.01) parts.push(`fps=${LIMITS.maxFps}`);
  return parts.join(",");
}

const X264 = ["-c:v", "libx264", "-preset", "slow", "-profile:v", "high", "-pix_fmt", "yuv420p", "-an"];

async function encodeVideo(src, out, info, { focus, crf, maxSeconds, workDir, log, warn }) {
  const issues = videoIssues(info, info.ext);
  if (!issues.length && !maxSeconds) {
    log("  视频已满足全部约束，原样复制");
    await copyFile(src, out);
    return { tier: "copy", bytes: info.size, seconds: info.duration };
  }
  if (issues.length) log(`  需转码：${issues.join("；")}`);
  const vf = videoFilter(info, focus);
  const cut = (s) => (s && s < info.duration ? ["-t", String(s)] : []);

  log(`  档 A：CRF ${crf} 单遍`);
  await ffmpeg(["-i", src, ...cut(maxSeconds), "-vf", vf, ...X264, "-crf", String(crf), "-movflags", "+faststart", out]);
  let bytes = await sizeOf(out);
  log(`  档 A 结果 ${mb(bytes)}`);
  if (bytes <= LIMITS.videoBytes) return { tier: "A", bytes, seconds: maxSeconds ? Math.min(maxSeconds, info.duration) : info.duration };

  const plan = planBitrate(info.duration, { maxSeconds });
  if (plan.trimmed && !maxSeconds) {
    warn(`档 C：全片 ${round2(info.duration)}s 压进 ${LIMITS.videoBudgetMiB}MiB 码率不足 ${LIMITS.minBitrateK}k，已截取前 ${plan.seconds}s（可用 --max-seconds 自定）`);
  }
  log(`  档 ${plan.trimmed && !maxSeconds ? "C" : "B"}：两遍定码率 ${plan.kbps}k × ${round2(plan.seconds)}s`);
  const passlog = join(workDir, "x264pass");
  const rate = ["-b:v", `${plan.kbps}k`];
  await ffmpeg(["-i", src, ...cut(plan.seconds), "-vf", vf, ...X264, ...rate, "-pass", "1", "-passlogfile", passlog, "-f", "null", "-"]);
  await ffmpeg(["-i", src, ...cut(plan.seconds), "-vf", vf, ...X264, ...rate,
    "-maxrate", `${Math.floor(plan.kbps * 1.5)}k`, "-bufsize", `${plan.kbps * 2}k`,
    "-pass", "2", "-passlogfile", passlog, "-movflags", "+faststart", out]);
  bytes = await sizeOf(out);
  log(`  两遍结果 ${mb(bytes)}`);
  if (bytes > LIMITS.videoBytes) throw new Error(`两遍编码后仍为 ${mb(bytes)}，超过 ${mb(LIMITS.videoBytes)}；请用 --max-seconds 缩短`);
  return { tier: plan.trimmed && !maxSeconds ? "C" : "B", bytes, seconds: plan.seconds };
}

// ───────────────────────── 主流程 ─────────────────────────

export async function makeTheme(options) {
  const {
    src, id, name, tagline, focus = { x: 0.5, y: 0.5 }, mode = "auto", colors: colorOverrides = {},
    crf = LIMITS.defaultCrf, maxSeconds, style, themesRoot = join(REPO_ROOT, "themes"),
    readmePath = join(REPO_ROOT, "README.md"), force = false, dryRun = false,
    log = console.log, warn = (msg) => console.warn(`⚠️  ${msg}`),
  } = options;

  if (!src) throw new Error("缺少素材路径");
  if (!existsSync(src)) throw new Error(`素材不存在：${src}`);
  if (!["auto", "light", "dark"].includes(mode)) throw new Error(`--mode 只能是 auto / light / dark`);
  for (const [key, value] of Object.entries(colorOverrides)) {
    if (value != null && !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`--${key} 需为 #RRGGBB`);
  }

  const info = await probe(src);
  const kind = info.kind;
  const heroFile = kind === "video" ? "hero.mp4" : "hero.webp";
  const posterFile = kind === "video" ? "hero.webp" : undefined;
  // 先用占位配色校验 id / name，避免白跑一遍编码
  validateThemeManifest(buildManifest({ id, name, heroFile, posterFile, colors: {}, tagline }));

  const target = join(themesRoot, id);
  if (existsSync(target) && !force) throw new Error(`themes/${id} 已存在；确认覆盖请加 --force（旧目录会先备份到系统临时目录）`);

  log(`素材：${src}`);
  log(`  类型 ${kind}，${info.width}×${info.height}，${mb(info.size)}` +
    (kind === "video" ? `，${info.codec}/${info.pixFmt}，${round2(info.fps)}fps，${round2(info.duration)}s${info.hasAudio ? "，带音轨" : ""}` : ""));
  if (kind !== "video" && info.width < LIMITS.imageWarnWidth) warn(`源图宽 ${info.width} < ${LIMITS.imageWarnWidth}，铺满窗口时可能发虚`);

  if (dryRun) {
    if (kind === "video") {
      const issues = videoIssues(info, info.ext);
      log(issues.length ? `  计划转码：${issues.join("；")}` : "  计划：原样复制");
      const plan = planBitrate(info.duration, { maxSeconds });
      log(`  若档 A 超限，两遍预算 ${plan.kbps}k × ${round2(plan.seconds)}s${plan.trimmed ? "（含截段）" : ""}`);
    }
    log(`  将写入 ${target}（dry-run，未执行）`);
    return { dryRun: true, info };
  }

  const workDir = await mkdtemp(join(tmpdir(), "make-theme-"));
  try {
    const heroOut = join(workDir, heroFile);
    let sampleFile = heroOut;
    let videoResult = null;
    if (kind === "image") {
      log("生成 hero.webp");
      const bytes = await encodeStill(src, heroOut, { focus, log });
      if (bytes > LIMITS.imageTargetBytes) warn(`hero.webp ${kb(bytes)} 仍高于 ${kb(LIMITS.imageTargetBytes)} 目标（不阻断）`);
    } else if (kind === "animated") {
      log("生成动画 hero.webp");
      await encodeAnimated(src, heroOut, { focus, log });
    } else {
      log("生成 hero.mp4");
      videoResult = await encodeVideo(src, heroOut, info, { focus, crf, maxSeconds, workDir, log, warn });
      const posterOut = join(workDir, posterFile);
      const seek = Math.min(1, (videoResult.seconds || info.duration) / 2);
      log("抽帧生成 poster hero.webp");
      await encodeStill(heroOut, posterOut, { focus: { x: 0.5, y: 0.5 }, log, seek });
      sampleFile = posterOut;
    }

    const palette = extractPalette(await samplePixels(sampleFile, 48));
    const lum = meanLuminance(await samplePixels(sampleFile, 160));
    const resolvedMode = mode === "auto" ? decideMode(lum) : mode;
    const accentHex = colorOverrides.accent ?? hex(...palette.accent);
    const accentRgb = hexToRgb(accentHex);
    const surfaces = buildSurfaces(accentRgb)[resolvedMode];
    const colors = {
      accent: accentHex,
      secondary: colorOverrides.secondary ?? hex(...palette.secondary),
      surface: colorOverrides.surface ?? surfaces.surface,
      text: colorOverrides.text ?? surfaces.text,
    };
    log(`取色：平均亮度 ${Math.round(lum)} → ${resolvedMode}${mode === "auto" ? "（自动）" : "（指定）"}；` +
      `accent ${colors.accent} / secondary ${colors.secondary} / surface ${colors.surface} / text ${colors.text}`);

    const manifest = buildManifest({ id, name, heroFile, posterFile, colors, tagline });
    const stageDir = join(workDir, id);
    await mkdir(stageDir);
    const files = [heroFile, ...(posterFile ? [posterFile] : [])];
    for (const file of files) await copyFile(join(workDir, file), join(stageDir, file));
    await writeFile(join(stageDir, "theme.json"), JSON.stringify(manifest, null, 2) + "\n");
    await loadTheme(stageDir); // 完整校验（含 30MB 视频上限、poster 必填）

    if (existsSync(target)) {
      const backup = join(tmpdir(), "skin-make-theme-backup", `${id}-${Date.now()}`);
      await cp(target, backup, { recursive: true });
      await rm(target, { recursive: true, force: true });
      warn(`已覆盖 themes/${id}，旧目录备份在 ${backup}`);
    }
    await cp(stageDir, target, { recursive: true });
    log(`已写入 ${target}`);

    let readmeUpdated = false;
    const styleText = style ?? styleLabel({ accent: accentRgb, secondary: hexToRgb(colors.secondary), mode: resolvedMode, kind });
    if (readmePath) {
      const text = await readFile(readmePath, "utf8");
      const next = insertReadmeRow(text, { id, name, style: styleText }, { replace: force });
      if (next === null) log(`README 已有 \`${id}\` 行，未改动`);
      else { await writeFile(readmePath, next); readmeUpdated = true; log(`README 内置主题表：| \`${id}\` | ${name} | ${styleText} |`); }
    }
    return { target, manifest, info, mode: resolvedMode, luminance: lum, video: videoResult, readmeUpdated, style: styleText };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function buildManifest({ id, name, heroFile, posterFile, colors, tagline }) {
  return {
    schemaVersion: THEME_SCHEMA_VERSION,
    id,
    name,
    hero: heroFile,
    ...(posterFile ? { poster: posterFile } : {}),
    colors,
    ...(tagline ? { copy: { tagline } } : {}),
  };
}

function hexToRgb(value) {
  const v = parseInt(value.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function clamp01(v) { return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0.5)); }
function round2(v) { return Math.round(v * 100) / 100; }
function kb(bytes) { return `${Math.round(bytes / 1024)}KB`; }
function mb(bytes) { return `${(bytes / 1024 / 1024).toFixed(1)}MB`; }

// ───────────────────────── CLI ─────────────────────────

const USAGE = `用法：node scripts/make-theme.mjs <素材> --id <id> --name <名称> [选项]

  素材             图片（png/jpg/webp/avif…）、动图（gif/动画 webp）或视频（mp4/mov/webm/mkv…）
  --id ID          主题 id = 目录名（小写字母/数字/连字符）
  --name NAME      主题显示名
  --tagline TEXT   可选副标题（copy.tagline）
  --focus X,Y      16:9 裁剪焦点百分比，默认 50,50（主体偏左可用 30,50）
  --mode M         auto（按平均亮度，默认）| light | dark
  --accent/--secondary/--surface/--text #RRGGBB   覆盖自动取色
  --crf N          视频档 A 的 CRF，默认 ${LIMITS.defaultCrf}
  --max-seconds N  视频只取前 N 秒
  --style TEXT     README「风格」列文案，默认自动生成
  --themes-root D  输出根目录，默认仓库 themes/（试跑可指向临时目录）
  --no-readme      不改 README
  --force          覆盖已存在的 themes/<id>（先备份）
  --dry-run        只探测并打印计划，不写文件`;

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      src: { type: "string" }, id: { type: "string" }, name: { type: "string" }, tagline: { type: "string" },
      focus: { type: "string" }, mode: { type: "string" },
      accent: { type: "string" }, secondary: { type: "string" }, surface: { type: "string" }, text: { type: "string" },
      crf: { type: "string" }, "max-seconds": { type: "string" }, style: { type: "string" },
      "themes-root": { type: "string" }, "no-readme": { type: "boolean" }, force: { type: "boolean" }, "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const src = values.src ?? positionals[0];
  if (values.help || !src || !values.id || !values.name) {
    console.log(USAGE);
    process.exitCode = values.help ? 0 : 1;
    return;
  }
  const result = await makeTheme({
    src: resolve(src),
    id: values.id,
    name: values.name,
    tagline: values.tagline,
    focus: parseFocus(values.focus),
    mode: values.mode ?? "auto",
    colors: { accent: values.accent, secondary: values.secondary, surface: values.surface, text: values.text },
    crf: values.crf ? Number(values.crf) : LIMITS.defaultCrf,
    maxSeconds: values["max-seconds"] ? Number(values["max-seconds"]) : undefined,
    style: values.style,
    themesRoot: values["themes-root"] ? resolve(values["themes-root"]) : undefined,
    readmePath: values["no-readme"] ? null : undefined,
    force: Boolean(values.force),
    dryRun: Boolean(values["dry-run"]),
  });
  if (result.dryRun) return;
  console.log(`\n✅ 主题 ${values.id} 就绪。后续：
  1. README「致谢」补素材来源与许可证（如适用）
  2. node src/cli.mjs list   确认已识别
  3. node --test             全量测试
  4. Start.bat ${values.id}   应用预览（会重启 WorkBuddy）`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  });
}
