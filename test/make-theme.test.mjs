import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LIMITS, buildSurfaces, cropFilter, decideMode, extractPalette, hueName, insertReadmeRow,
  makeTheme, meanLuminance, parseFocus, planBitrate, probe, styleLabel, videoIssues,
} from "../scripts/make-theme.mjs";
import { loadTheme } from "../src/theme-schema.mjs";

const hasFfmpeg = (() => {
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); execFileSync("ffprobe", ["-version"], { stdio: "ignore" }); return true; }
  catch { return false; }
})();
const skipNoFfmpeg = hasFfmpeg ? false : "ffmpeg/ffprobe 不在 PATH";

test("make-theme：裁剪焦点解析与 crop 表达式", () => {
  assert.deepEqual(parseFocus(undefined), { x: 0.5, y: 0.5 });
  assert.deepEqual(parseFocus("30,60"), { x: 0.3, y: 0.6 });
  assert.deepEqual(parseFocus("150:0"), { x: 1, y: 0 });
  assert.throws(() => parseFocus("left"), /--focus/);
  assert.equal(cropFilter({ x: 0.3, y: 0.5 }), "crop='min(iw,ih*16/9)':'min(ih,iw*9/16)':'(iw-ow)*0.3':'(ih-oh)*0.5'");
});

test("make-theme：视频合规判定列出全部问题", () => {
  const ok = { codec: "h264", pixFmt: "yuv420p", hasAudio: false, width: 1920, height: 1080, fps: 30, size: 10 * 1024 * 1024 };
  assert.deepEqual(videoIssues(ok, ".mp4"), []);
  const bad = { codec: "hevc", pixFmt: "yuv420p10le", hasAudio: true, width: 2560, height: 1200, fps: 60, size: 40 * 1024 * 1024 };
  const issues = videoIssues(bad, ".mov");
  assert.equal(issues.length, 8);
  assert.ok(issues.some((s) => s.includes("16:9")));
  assert.ok(issues.some((s) => s.includes("音轨")));
});

test("make-theme：两遍码率规划与截段阈值", () => {
  assert.deepEqual(planBitrate(60), { kbps: Math.floor(28 * 8192 / 60), seconds: 60, trimmed: false });
  // 300s → 764k < 1500k → 截到 60s
  const long = planBitrate(300);
  assert.equal(long.trimmed, true);
  assert.equal(long.seconds, LIMITS.trimSeconds);
  assert.ok(long.kbps >= LIMITS.minBitrateK);
  // 显式 --max-seconds
  assert.deepEqual(planBitrate(120, { maxSeconds: 40 }), { kbps: Math.floor(28 * 8192 / 40), seconds: 40, trimmed: true });
});

test("make-theme：取色与 skin-menu 同算法、明暗公式", () => {
  // 70% 饱和蓝 + 30% 饱和金 + 灰（灰不参与取色）
  const px = [];
  for (let i = 0; i < 70; i++) px.push(30, 80, 220);
  for (let i = 0; i < 30; i++) px.push(240, 190, 40);
  for (let i = 0; i < 50; i++) px.push(128, 128, 128);
  const { accent, secondary } = extractPalette(Uint8Array.from(px));
  assert.deepEqual(accent.map(Math.round), [30, 80, 220]);
  assert.deepEqual(secondary.map(Math.round), [240, 190, 40]);
  assert.equal(hueName(accent), "蓝");
  assert.equal(hueName(secondary), "金");

  // 与 skin-menu buildSurfaces 同公式：mix(accent,[12,12,18],.86) / mix(accent,[244,246,252],.85)
  assert.deepEqual(buildSurfaces([30, 80, 220]).dark, { surface: "#0F162E", text: "#D4DDF7" });
  assert.equal(decideMode(meanLuminance(Uint8Array.from([20, 20, 30, 40, 40, 60]))), "dark");
  assert.equal(decideMode(meanLuminance(Uint8Array.from([240, 240, 230]))), "light");
  assert.equal(styleLabel({ accent: [30, 80, 220], secondary: [240, 190, 40], mode: "dark", kind: "video" }), "蓝 × 金 · 深色 · MP4 视频");
});

test("make-theme：README 行插到 qq2008 之前，重复 id 不改", () => {
  const readme = ["## 🗂️ 内置主题", "", "| 主题 id | 名称 | 风格 |", "|---|---|---|", "| `cutie` | 小可爱 | 米白 · 浅色 |", "| `qq2008` | QQ 2008 | 蓝 |", "", "## 下一节"].join("\n");
  const next = insertReadmeRow(readme, { id: "foo", name: "Foo", style: "蓝 · 深色" });
  const lines = next.split("\n");
  assert.equal(lines[lines.indexOf("| `qq2008` | QQ 2008 | 蓝 |") - 1], "| `foo` | Foo | 蓝 · 深色 |");
  assert.equal(insertReadmeRow(next, { id: "foo", name: "Foo", style: "x" }), null);
  assert.ok(insertReadmeRow(next, { id: "foo", name: "Foo", style: "x" }, { replace: true }).includes("| `foo` | Foo | x |"));
  // 无 qq2008 行：追加到表尾
  const plain = readme.replace("| `qq2008` | QQ 2008 | 蓝 |\n", "");
  assert.ok(insertReadmeRow(plain, { id: "bar", name: "Bar", style: "s" }).includes("| `cutie` | 小可爱 | 米白 · 浅色 |\n| `bar` | Bar | s |\n\n## 下一节"));
});

async function withTemp(fn) {
  const dir = await mkdtemp(join(tmpdir(), "make-theme-test-"));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
// stdio 用 ignore：部分 Windows 环境下 execFileSync 管道模式会报 EBUSY
const ff = (args) => execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", ...args], { stdio: "ignore" });
const quiet = { log: () => {}, warn: () => {} };

test("make-theme 端到端：静态图 → 16:9 webp + 深色配色 + README", { skip: skipNoFfmpeg }, () => withTemp(async (dir) => {
  const src = join(dir, "src.png");
  ff(["-f", "lavfi", "-i", "color=c=0x14306e:size=2000x1500", "-frames:v", "1", src]);
  const readme = join(dir, "README.md");
  await writeFile(readme, "## 🗂️ 内置主题\n\n| 主题 id | 名称 | 风格 |\n|---|---|---|\n| `qq2008` | QQ 2008 | 蓝 |\n");
  const result = await makeTheme({ src, id: "e2e-image", name: "端到端", tagline: "t", themesRoot: dir, readmePath: readme, ...quiet });
  const info = await probe(join(dir, "e2e-image", "hero.webp"));
  assert.deepEqual([info.width, info.height], [1600, 900]);
  assert.equal(result.mode, "dark");
  const loaded = await loadTheme(join(dir, "e2e-image"));
  assert.equal(loaded.manifest.copy.tagline, "t");
  assert.ok((await readFile(readme, "utf8")).includes("| `e2e-image` | 端到端 | 深蓝 · 深色 |"));
  // 已存在且未 --force → 拒绝
  await assert.rejects(makeTheme({ src, id: "e2e-image", name: "x", themesRoot: dir, readmePath: null, ...quiet }), /--force/);
}));

test("make-theme 端到端：动图保留动画并裁 16:9", { skip: skipNoFfmpeg }, () => withTemp(async (dir) => {
  const src = join(dir, "src.gif");
  ff(["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10", "-t", "1", src]);
  await makeTheme({ src, id: "e2e-anim", name: "动图", themesRoot: dir, readmePath: null, ...quiet });
  const info = await probe(join(dir, "e2e-anim", "hero.webp"));
  assert.equal(info.kind, "animated");
  assert.deepEqual([info.width, info.height], [320, 180]);
}));

test("make-theme 端到端：不合规视频转码为 H.264/16:9/≤30fps/无音轨 + poster", { skip: skipNoFfmpeg }, () => withTemp(async (dir) => {
  const src = join(dir, "src.mov");
  ff(["-f", "lavfi", "-i", "testsrc2=size=1280x960:rate=60", "-f", "lavfi", "-i", "sine", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv444p", "-c:a", "aac", src]);
  const result = await makeTheme({ src, id: "e2e-video", name: "视频", themesRoot: dir, readmePath: null, ...quiet });
  assert.equal(result.video.tier, "A");
  const info = await probe(join(dir, "e2e-video", "hero.mp4"));
  assert.deepEqual([info.codec, info.pixFmt, info.width, info.height, Math.round(info.fps), info.hasAudio], ["h264", "yuv420p", 1280, 720, 30, false]);
  const loaded = await loadTheme(join(dir, "e2e-video"));
  assert.ok(loaded.posterPath.endsWith("hero.webp"));
}));
