import assert from "node:assert/strict";
import test from "node:test";

import { buildSkinCss } from "../src/skin-css.mjs";

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
