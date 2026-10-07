import assert from "node:assert/strict";
import test from "node:test";

import { buildPaletteCss, buildSkinCss } from "../src/skin-css.mjs";

const HERO = "data:image/webp;base64,aGVsbG8=";
const baseTheme = {
  id: "demo",
  name: "Demo",
  colors: { accent: "#5141F2", secondary: "#7C3AED", surface: "#F5F6F8", text: "#111827" },
  copy: null,
};

test("标题样式：主标题走 accent→secondary 渐变文字，drop-shadow 光晕按字形描边", () => {
  const css = buildSkinCss({ theme: baseTheme, heroDataUrl: HERO });
  assert.ok(css.includes(".wb-home-header__title"));
  assert.ok(css.includes(".colleague-chat-empty-profile__title"));
  assert.ok(css.includes("linear-gradient(135deg, var(--wb-accent), var(--wb-secondary))"));
  assert.ok(css.includes("-webkit-text-fill-color: transparent"));
  // 不用 text-shadow（透明填充会透字形发脏），用 filter 描光晕
  assert.ok(css.includes("filter: drop-shadow(0 1px 6px var(--wb-surface))"));
});

test("主题标语：copy.tagline 配置时输出渐变标语，未配置时不注入文案", () => {
  const withTagline = buildSkinCss({
    theme: { ...baseTheme, copy: { tagline: "与开发者共鸣" } },
    heroDataUrl: HERO,
  });
  assert.ok(withTagline.includes(".wb-home-header::after"));
  assert.ok(withTagline.includes('content: "与开发者共鸣" !important'));

  const without = buildSkinCss({ theme: baseTheme, heroDataUrl: HERO });
  assert.ok(!without.includes(".wb-home-header::after"));
});

test("标题渐变引用 CSS 变量而非字面色值：自定义皮肤哨兵替换后自动适配取色", () => {
  const css = buildSkinCss({ theme: baseTheme, heroDataUrl: HERO });
  const titleBlock = css.slice(css.indexOf(".wb-home-header__title"));
  assert.ok(!titleBlock.includes("#5141F2"), "标题渐变不应硬编码色值");
});

test("左上角字标：硬切渐变双色字标（Work 文本色 / Buddy accent），全 var() 引用", () => {
  const css = buildSkinCss({ theme: baseTheme, heroDataUrl: HERO });
  assert.ok(css.includes(".conversation-list-logo .logo-workbuddy-title"));
  assert.ok(css.includes("linear-gradient(90deg, var(--wb-text) 0 44%, var(--wb-accent) 44% 100%)"));
  const logoBlock = css.slice(css.indexOf(".conversation-list-logo .logo-workbuddy-title"));
  assert.ok(!/#[0-9a-f]{6}/i.test(logoBlock), "字标不应硬编码色值（哨兵替换覆盖不到 data URL 编码色值）");
});

test("「为你推荐」技能推荐条：原生不透明白条改为磨砂半透明，全 var() 引用", () => {
  const css = buildSkinCss({ theme: baseTheme, heroDataUrl: HERO });
  // 条本体 + 上方 32px 渐变托底（::before）必须覆盖，否则壁纸上呈整块白版
  assert.ok(css.includes(".wb-skill-rec-bar {"));
  assert.ok(css.includes(".wb-skill-rec-bar::before"));
  assert.ok(css.includes(".wb-skill-rec-bar__label"));
  assert.ok(css.includes(".wb-skill-rec-chip"));
  const barBlock = css.slice(css.indexOf(".wb-skill-rec-bar {"), css.indexOf("/* 首页快捷 chips"));
  assert.ok(barBlock.includes("color-mix(in srgb, var(--wb-surface) 55%, transparent) !important"));
  assert.ok(barBlock.includes("backdrop-filter: blur(14px)"));
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(barBlock), "推荐条规则不应硬编码色值");
});

test("首页快捷 chips 与滚动渐隐：白底/白色渐变改为皮肤表面色磨砂", () => {
  const css = buildSkinCss({ theme: baseTheme, heroDataUrl: HERO });
  assert.ok(css.includes(".wb-home-composer__chips .quick-actions__item"));
  assert.ok(css.includes(".wb-home-composer__chip"));
  assert.ok(css.includes(".quick-actions--fade-right::after"));
  assert.ok(css.includes(".quick-actions--fade-left::before"));
  assert.ok(css.includes(".quick-actions__arrow"));
  // 渐隐不再用硬编码 #fff，改走 surface 半透明渐变
  const fadeBlock = css.slice(css.indexOf(".quick-actions--fade-right::after"));
  assert.ok(!fadeBlock.includes("#fff"), "滚动渐隐不应硬编码白色");
});

// ---- buildPaletteCss：配色主题（无图纯配色）换色基座 ----

test("配色主题基座：与图片主题共享同一 --cb-* 变量覆盖块（防模板漂移）", () => {
  const palette = buildPaletteCss({ theme: baseTheme });
  const image = buildSkinCss({ theme: baseTheme, heroDataUrl: HERO });
  // 变量块逐字节一致：两者同源于 buildVariableOverrides
  const extractBlock = (css) => css.slice(css.indexOf("body[data-application-name=workbuddy]"), css.indexOf("--cb-markdown-hr-border-color"));
  assert.equal(extractBlock(palette), extractBlock(image));
  // 四色落到 --wb-* 变量
  assert.ok(palette.includes("--wb-accent: #5141F2"));
  assert.ok(palette.includes("--wb-surface: #F5F6F8"));
  assert.ok(palette.includes("--cb-bg-primary: var(--wb-surface) !important"));
  assert.ok(palette.includes("--cb-text-link: var(--wb-accent) !important"));
});

test("配色主题基座：无 hero 实底表面，容器透化透出根层，侧边栏文字色微浮层", () => {
  const css = buildPaletteCss({ theme: baseTheme });
  assert.ok(css.includes("/* WORKBUDDY_PALETTE:demo */"));
  // 不需要 hero：#root 与 teams-container 实底表面色（无 url() 背景图）
  assert.ok(css.includes("#root {\n  background: var(--wb-surface) !important;"));
  assert.ok(!css.includes("url("), "配色基座不应含任何背景图引用");
  const containerBlock = css.slice(css.indexOf(".teams-container,"), css.indexOf(".teams-grid-scroll-content,"));
  assert.ok(containerBlock.includes("background: var(--wb-surface) !important"));
  // grid 容器与 [data-view-id] 透化
  assert.ok(css.includes("[class*=gridView] {\n  background: transparent !important;"));
  assert.ok(css.includes("[data-view-id] {\n  background: transparent !important;"));
  // 侧边栏：surface 混文字色的双向明暗自适应浮层 + accent 选中微光
  assert.ok(css.includes("color-mix(in srgb, var(--wb-surface) 92%, var(--wb-text) 5%)"));
  assert.ok(css.includes('[data-view-id=sidebar] [aria-selected="true"]'));
  // 首页路由钉为表面色
  assert.ok(css.includes(".wb-home-route {\n  background: var(--wb-surface) !important;"));
});

test("配色主题基座：复用组件点缀块（主标题渐变/字标/推荐条），无 brand/headline 伪元素", () => {
  const css = buildPaletteCss({ theme: baseTheme });
  assert.ok(css.includes(".wb-home-header__title"));
  assert.ok(css.includes(".conversation-list-logo .logo-workbuddy-title"));
  assert.ok(css.includes(".wb-skill-rec-bar {"));
  // 配色主题无 copy 文案概念：不注入 #root 伪元素
  assert.ok(!css.includes("#root::before"));
  assert.ok(!css.includes("#root::after"));
});

test("配色主题基座：非法色值拒绝，id 消毒与图片主题同规则", () => {
  assert.throws(() => buildPaletteCss({ theme: { ...baseTheme, colors: { accent: "red" } } }), /无效主题颜色/);
  const css = buildPaletteCss({ theme: { ...baseTheme, id: "Focus Night!!" } });
  assert.ok(css.includes("WORKBUDDY_PALETTE:FocusNight"));
});
