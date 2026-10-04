import assert from "node:assert/strict";
import test from "node:test";

import { buildSkinMenuScript } from "../src/skin-menu.mjs";

// 皮肤菜单脚本是字符串模板：无法直接在 Node 里跑 DOM，
// 采用「语法编译 + 关键结构片段断言」，与 injector.test.mjs 的表达式断言风格一致
const ENTRIES = [
  { id: "night", name: "暗夜", accent: "#24c9d7", surface: "#101418", css: ":root{--wb-a:1}" },
  { id: "waves", name: "海浪", css: ":root{--wb-b:2}", kind: "video" },
];

const build = (overrides = {}) =>
  buildSkinMenuScript({ entries: ENTRIES, activeId: "night", styleId: "sid", menuId: "mid", ...overrides });

test("buildSkinMenuScript：生成的注入脚本可被 JS 引擎编译", () => {
  assert.doesNotThrow(() => new Function(build()));
  // activeId 指向自定义皮肤（注入后由 activateSavedSkin 激活）时同样可编译
  assert.doesNotThrow(() => new Function(build({ activeId: null })));
});

test("切换路径：setTheme/applyCustomTheme/clearTheme 均有异常兜底与错误日志", () => {
  const script = build();
  assert.ok(script.includes('logError("切换主题失败", id, error)'));
  assert.ok(script.includes('logError("应用自定义主题失败", theme?.id, error)'));
  assert.ok(script.includes('logError("恢复原生界面失败", null, error)'));
  // 列表行点击的最后一道兜底，覆盖内置/自定义/上传/原生所有 onPick
  assert.ok(script.includes("主题列表项点击处理失败"));
});

test("切换路径：主题不在列表中时输出警告而非静默忽略", () => {
  assert.ok(build().includes("主题不在菜单列表中，切换已忽略"));
});

test("asCssUrl：非法 data URL 与 base64 解码失败均回退并告警，不抛异常打断切换", () => {
  const script = build();
  assert.ok(script.includes("不是合法 data URL，已跳过 blob 转换"));
  assert.ok(script.includes("base64 解码失败，回退原始 data URL"));
});

test("asCssUrl：大图解码优先 Uint8Array.fromBase64 快路径，避免逐字节循环卡主线程", () => {
  const script = build();
  assert.ok(script.includes('typeof Uint8Array.fromBase64 === "function"'));
  assert.ok(script.includes("atob(b64)")); // 旧内核回退仍保留
});

test("videoStore：onblocked 告警 + onabort reject，IndexedDB 阻塞/中止不再静默挂起", () => {
  const script = build();
  assert.ok(script.includes("req.onblocked"));
  assert.ok(script.includes("IndexedDB 打开被阻塞"));
  assert.ok(script.includes("tx.onabort"));
});

test("mountVideo：视频缺失与加载失败的日志均带主题 id，自动播放失败不再静默", () => {
  const script = build();
  assert.ok(script.includes('视频皮肤加载失败（" + theme.id + "）'));
  assert.ok(script.includes('主题：" + theme.id + "'));
  assert.ok(script.includes('视频自动播放失败（" + theme.id + "）'));
});

test("teardown：脚本开头先拆上一轮注入，结尾登记本轮拆除（断观察者/解钉/移除全局监听）", () => {
  const script = build();
  const callPrevious = script.indexOf('window["__workbuddySkinTeardown"]?.()');
  const register = script.indexOf('window["__workbuddySkinTeardown"] = () =>');
  assert.ok(callPrevious > 0 && register > callPrevious);
  const body = script.slice(register, script.indexOf("};", register));
  for (const fragment of [
    "layoutObserver.disconnect()",
    "modeObserver.disconnect()",
    "pinnedDark = null",
    'removeEventListener("resize", scheduleReposition)',
    'removeEventListener("storage", onStorage)',
    'removeEventListener("mousedown", onOutsideMouseDown, true)',
    "releaseVideo()",
    "videoStore.close()",
    "root.remove()",
  ]) {
    assert.ok(body.includes(fragment), fragment);
  }
});

test("自愈重挂：菜单根节点 / <style> 被 React 重建移除后自动重挂回 body/head", () => {
  const script = build();
  assert.ok(script.includes("if (!style.isConnected) document.head.appendChild(style);"));
  assert.ok(script.includes("if (!root.isConnected) document.body.appendChild(root);"));
  // 只观察直接子节点（两个节点都挂在 body/head 末尾），不开 subtree 避免流式输出高频回调
  assert.ok(script.includes('reviveObserver.observe(document.head, { childList: true })'));
  assert.ok(script.includes('reviveObserver.observe(document.body, { childList: true })'));
});

test("自愈重挂：teardown 先断 reviveObserver 再 root.remove()，防止移除被重挂回去", () => {
  const script = build();
  const register = script.indexOf('window["__workbuddySkinTeardown"] = () =>');
  const body = script.slice(register, script.indexOf("};", register));
  // 带分号匹配语句本体：teardown 注释里也提到了 root.remove()，裸匹配会先命中注释
  const disconnect = body.indexOf("reviveObserver.disconnect();");
  const remove = body.indexOf("root.remove();");
  assert.ok(disconnect > 0 && remove > disconnect);
  // 挂 window 供旧版本脚本断开（与 layoutObserver 同一套兼容模式），teardown 时清理
  assert.ok(script.includes("window.__workbuddySkinReviveObserver = reviveObserver"));
  assert.ok(body.includes("delete window.__workbuddySkinReviveObserver"));
  // 脚本开头的旧版本兼容拆除也覆盖它
  const head = script.slice(0, script.indexOf("let style"));
  assert.ok(head.includes("window.__workbuddySkinReviveObserver?.disconnect()"));
});

test("定位按钮：四个按钮齐全，容器/锚点启发式探测与兜底齐全", () => {
  const script = build();
  for (const label of ["回到顶部", "上一个提问", "下一个提问", "回到底部"]) {
    assert.ok(script.includes(label), label);
  }
  // 容器探测：优先 .messages-container，回退全量扫描（可滚动 + 宽度阈值 + 高度阈值）
  assert.ok(script.includes('querySelector(".messages-container")'));
  assert.ok(script.includes("/(auto|scroll|overlay)/"));
  // 锚点启发式 + 排除 assistant/bot + 嵌套剔除 + 通用消息类兜底
  assert.ok(script.includes("[data-role=user]"));
  assert.ok(script.includes("assistant|agent"));
  assert.ok(script.includes("other.contains(el)"));
  assert.ok(script.includes("[class*=message],[class*=msg],[class*=chat-item]"));
  // 平滑滚动：三次缓出 + 每帧按最新 scrollHeight 夹取目标（流式增长时可跟随到底）
  assert.ok(script.includes("1 - Math.pow(1 - t, 3)"));
  assert.ok(script.includes("box.scrollHeight - box.clientHeight"));
});

test("定位按钮：用户滚轮/触摸介入取消动画，显隐按 rAF 合帧、不可滚即隐藏", () => {
  const script = build();
  assert.ok(script.includes('addEventListener("wheel", cancelNavAnim, true)'));
  assert.ok(script.includes('addEventListener("touchstart", cancelNavAnim, true)'));
  assert.ok(script.includes('addEventListener("scroll", scheduleNavUpdate, true)'));
  assert.ok(script.includes('navRoot.style.display = show ? "flex" : "none"'));
  // 显隐更新挂既有 layoutObserver，不另开 subtree observer
  assert.ok(script.includes("scheduleReposition(); scheduleNavUpdate();"));
});

test("定位按钮：teardown 拆除动画/监听/节点，自愈重挂覆盖 navRoot", () => {
  const script = build();
  const register = script.indexOf('window["__workbuddySkinTeardown"] = () =>');
  const body = script.slice(register, script.indexOf("};", register));
  for (const fragment of [
    "cancelNavAnim();",
    'removeEventListener("scroll", scheduleNavUpdate, true)',
    'removeEventListener("wheel", cancelNavAnim, true)',
    'removeEventListener("touchstart", cancelNavAnim, true)',
    "navRoot.remove()",
  ]) {
    assert.ok(body.includes(fragment), fragment);
  }
  assert.ok(script.includes("if (!navRoot.isConnected) document.body.appendChild(navRoot);"));
});

test("reposition：MutationObserver 按 rAF 合帧，不再每次变更都同步读布局", () => {
  const script = build();
  // reposition 与定位按钮显隐共用一个 subtree observer，各自内部按 rAF 合帧
  assert.ok(script.includes("new MutationObserver(() => { scheduleReposition(); scheduleNavUpdate(); })"));
  assert.ok(script.includes("requestAnimationFrame(() => { repositionQueued = false; reposition(); })"));
  assert.ok(!script.includes("queueMicrotask"));
});

test("buildCustomCss：hero（可能数 MB）最后替换，前面的 split 只扫小模板", () => {
  const script = build();
  const start = script.indexOf("const buildCustomCss");
  const body = script.slice(start, script.indexOf(";", start));
  assert.ok(body.lastIndexOf("data.sentinels.hero") > body.lastIndexOf("data.sentinels.id"));
});

test("自定义主题：loadCustoms 走内存缓存，storage 事件失效；导入保存时重读最新列表", () => {
  const script = build();
  assert.ok(script.includes("if (!customsCache) customsCache = readCustoms();"));
  assert.ok(script.includes('window.addEventListener("storage", onStorage)'));
  assert.ok(!script.includes("[...existing, theme]"));
  assert.equal(script.split("saveCustoms([...loadCustoms(), theme])").length - 1, 2);
});

test("常量与 Node 端同源：视频上限、动图分辨率、IndexedDB 库名", () => {
  const script = build();
  assert.ok(script.includes(`MAX_VIDEO_BYTES = ${30 * 1024 * 1024}`));
  assert.ok(script.includes("MAX_ANIMATED_DIMENSION = 1920"));
  assert.ok(script.includes('indexedDB.open("workbuddy-skin-studio", 1)'));
});
