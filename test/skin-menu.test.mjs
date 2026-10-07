import assert from "node:assert/strict";
import test from "node:test";

import { buildSkinCss } from "../src/skin-css.mjs";
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
    'removeEventListener("keydown", onEscKey, true)',
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

test("定位按钮：位置锚定对话框上方右侧，resize 触发重算并在 teardown 拆除", () => {
  const script = build();
  // 对话框探测：textarea / contenteditable / composer 类，限视口下半部、取最宽者
  assert.ok(script.includes("findComposer"));
  assert.ok(script.includes("textarea,[contenteditable=true]"));
  assert.ok(script.includes("r.top < viewportHeight * 0.4"));
  // 底边固定在输入框顶上方 12px，右缘对齐输入框右缘外侧 6px；上下限防出屏
  assert.ok(script.includes("window.innerHeight - composer.top + 12"));
  assert.ok(script.includes("Math.max(-6, Math.round(window.innerWidth - composer.right - 6))"));
  assert.ok(script.includes("Math.min(Math.max(8, bottom), window.innerHeight - 160)"));
  // 探测失败兜底固定位置
  assert.ok(script.includes('navRoot.style.bottom = "96px";'));
  // 仅在显示时重算定位与边界灰化
  assert.ok(script.includes("updateNavPlacement();"));
  assert.ok(script.includes("updateNavEdges(box);"));
  // 边界灰化：顶部禁用回到顶部/上一个提问，底部禁用下一个提问/回到底部；disabled 阻断点击
  assert.ok(script.includes("const [navBtnTop, navBtnPrev, navBtnNext, navBtnBottom] = navRoot.children;"));
  assert.ok(script.includes("btn.disabled = !enabled;"));
  assert.ok(script.includes("box.scrollTop <= NAV_TOLERANCE"));
  assert.ok(script.includes("box.scrollTop >= max - NAV_TOLERANCE"));
  assert.ok(script.includes("setNavEnabled(navBtnTop, !atTop);"));
  assert.ok(script.includes("setNavEnabled(navBtnBottom, !atBottom);"));
  // resize 重算 + teardown 拆除
  assert.ok(script.includes('addEventListener("resize", scheduleNavUpdate)'));
  const register = script.indexOf('window["__workbuddySkinTeardown"] = () =>');
  const body = script.slice(register, script.indexOf("};", register));
  assert.ok(body.includes('removeEventListener("resize", scheduleNavUpdate)'));
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

test("按钮拖拽：默认锚定 reposition，拖拽切自由定位并持久化，双击复位", () => {
  const script = build();
  assert.doesNotThrow(() => new Function(script));
  // 持久化键进入 payload
  assert.ok(script.includes('"posKey":"workbuddySkinMenuPos"'));
  // 默认位置仍锚定原生按钮行（customPos 为空时走原 right 逻辑）
  assert.ok(script.includes('document.querySelector(".workbuddy-topbar-actions")'));
  assert.ok(script.includes("if (customPos) { applyCustomPos(); return; }"));
  // 指针拖拽：capture + 5px 阈值 + 拖后抑制 click
  assert.ok(script.includes('button.addEventListener("pointerdown"'));
  assert.ok(script.includes("button.setPointerCapture(event.pointerId)"));
  assert.ok(script.includes("Math.hypot(dx, dy) < 5"));
  assert.ok(script.includes("if (suppressClick) { suppressClick = false; return; }"));
  // 拖拽结束持久化 + 双击复位默认位置
  assert.ok(script.includes("if (dragState.moved) { savePos(customPos); suppressClick = true; }"));
  assert.ok(script.includes('button.addEventListener("dblclick"'));
  assert.ok(script.includes("resetPos()"));
  // 挂载后按真实尺寸再夹取一次
  assert.ok(script.includes("if (customPos) applyCustomPos();"));
});

test("按钮拖拽：坐标按视口比例（fx/fy）持久化，窗口最大化/缩放时自适应换算并夹取", () => {
  const script = build();
  // 拖拽中即按比例记录，应用时按当前视口换算像素
  assert.ok(script.includes("(dragState.baseX + dx) / Math.max(1, window.innerWidth)"));
  assert.ok(script.includes("(dragState.baseY + dy) / Math.max(1, window.innerHeight)"));
  assert.ok(script.includes("customPos.fx * window.innerWidth"));
  assert.ok(script.includes("customPos.fy * window.innerHeight"));
  // 视口夹取（按钮不甩出可视区）
  assert.ok(script.includes("window.innerWidth - root.offsetWidth"));
  // 读取兼容旧版绝对像素坐标
  assert.ok(script.includes("saved.x / Math.max(1, window.innerWidth)"));
  // resize 时经 reposition → applyCustomPos 重算
  assert.ok(script.includes('window.addEventListener("resize", scheduleReposition)'));
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

test("伴随 JS：激活执行、返回值作拆除回调，切换/恢复原生/全局 teardown 均拆除", () => {
  const cssJsEntry = { id: "css-js", name: "CssJs", css: "body{}", group: "custom", js: "return () => {}" };
  const script = buildSkinMenuScript({ entries: [cssJsEntry], activeId: null, styleId: "s", menuId: "m" });
  // 脚本可编译，js 文本进入 payload
  assert.doesNotThrow(() => new Function(script));
  assert.ok(script.includes("return () => {}"));
  // 生命周期：setTheme 内最后执行；clearTheme 与全局 teardown 均先拆旧 JS
  assert.ok(script.includes("runThemeJs(theme)"));
  assert.ok(/clearTheme = \(\) => \{[\s\S]*?teardownThemeJs\(\)/.test(script));
  assert.ok(/__workbuddySkinTeardown"\] = \(\) => \{[\s\S]*?teardownThemeJs\(\)/.test(script));
  // CSP 禁 eval 时降级为警告而非炸掉换肤
  assert.ok(script.includes("new Function(theme.js)()"));
  assert.ok(script.includes("执行主题 JS 失败"));
});

test("伴随 JS：无 js 的条目归一为 null，不进入 payload", () => {
  const script = build();
  assert.ok(script.includes('"js":null'));
});

test("原生主题组：拆分为浅色/深色两行，分别钉住明暗并持久化 native-light/native-dark", () => {
  const script = build();
  assert.doesNotThrow(() => new Function(script));
  // 两行（模板内汉字走双反斜杠转义，生成脚本中为单反斜杠  转义字面量）
  assert.ok(script.includes(String.raw`card("\u539f\u751f\u754c\u9762 \u00b7 \u6d45\u8272"`));
  assert.ok(script.includes(String.raw`card("\u539f\u751f\u754c\u9762 \u00b7 \u6df1\u8272"`));
  // setNative：清空皮肤但钉住目标明暗（区别于 clearTheme 的 pin:false 交还应用）
  assert.ok(script.includes('const setNative = (mode) => {'));
  assert.ok(script.includes('"native-dark" : "native-light"'));
  assert.ok(script.includes('applyMode(mode === "dark" ? "#101418" : "#ffffff")'));
  assert.ok(script.includes('api.setNative') || script.includes('setNative,'));
  // 行键入 rows Map，paint 可高亮
  assert.ok(script.includes('rows.set("native-light"'));
  assert.ok(script.includes('rows.set("native-dark"'));
});

test("皮肤弹窗：遮罩 + 居中对话框 + 分类网格，Esc/backdrop/关闭按钮均可关", () => {
  const script = build();
  assert.doesNotThrow(() => new Function(script));
  // 遮罩与对话框
  assert.ok(script.includes("position:fixed;inset:0;z-index:2147483001"));
  assert.ok(script.includes("grid-template-columns:repeat(auto-fill,minmax(128px,1fr))"));
  // 分类小节：原生/定制/CSS/图片/自定义（定制=整页 CSS 移植；CSS 组合并 palette/scenery）
  assert.ok(script.includes(String.raw`section("\u539f\u751f\u4e3b\u9898")`));
  assert.ok(script.includes(String.raw`section("\u5b9a\u5236\u4e3b\u9898")`));
  assert.ok(script.includes(String.raw`section("CSS\u4e3b\u9898")`));
  assert.ok(script.includes(String.raw`section("\u56fe\u7247\u4e3b\u9898")`));
  assert.ok(script.includes(String.raw`section("\u81ea\u5b9a\u4e49\u4e3b\u9898\uff08\u53ef\u5207\u6362\u660e\u6697\u4e3b\u8272\uff09")`));
  // 分区顺序：自定义 > 定制 > 图片 > CSS > 原生（section() 调用次序即渲染次序）
  const sectionOrder = ["\\u81ea\\u5b9a\\u4e49\\u4e3b\\u9898", "\\u5b9a\\u5236\\u4e3b\\u9898", "\\u56fe\\u7247\\u4e3b\\u9898", "CSS\\u4e3b\\u9898", "\\u539f\\u751f\\u4e3b\\u9898"].map((label) => script.indexOf('section("' + label));
  assert.ok(sectionOrder.every((pos, index, list) => pos >= 0 && (index === 0 || list[index - 1] < pos)), "分区顺序应为 自定义>定制>图片>CSS>原生，实际位置：" + sectionOrder.join(","));
  // 缩略图：图片主题从条目 CSS 提取内联图（零额外负载），定制主题用渐变色块兜底
  assert.ok(script.includes("const thumbOf = (css) =>"));
  assert.ok(script.includes("const swatchOf = (theme) =>"));
  // 槽位计数（x/n）随增删刷新；槽位满时隐藏新增卡（上传入口），删除后恢复
  assert.ok(script.includes(String.raw`"\u69fd\u4f4d " + count + "/" + data.maxCustomSlots`));
  assert.ok(script.includes('uploadCard.style.display = count >= data.maxCustomSlots ? "none" : "";'));
  // 关闭路径：backdrop 点击、Esc（capture）、关闭按钮；teardown 移除 Esc 监听
  assert.ok(script.includes("event.target === overlay"));
  assert.ok(script.includes('event.key === "Escape"'));
  assert.ok(script.includes('removeEventListener("keydown", onEscKey, true)'));
});

test("皮肤弹窗：thumbOf 在生成脚本中能从真实主题 CSS 提取 hero（防模板字面量吃掉正则转义）", () => {
  const script = build();
  // 从生成后的脚本（而非源码）截取 thumbOf 函数体执行：源码里的 \( 进入模板字面量会被吃成
  // 裸括号，曾导致内置图片主题缩略图全部回退渐变色块，字符串包含断言无法发现
  const start = script.indexOf("const thumbOf = (css) =>");
  const end = script.indexOf("\n  };", start) + 4;
  const thumbOf = new Function(script.slice(start, end) + "\nreturn thumbOf;")();
  const hero = "data:image/webp;base64,UklGRkJD+/=";
  const css = buildSkinCss({
    theme: { id: "t", name: "t", colors: { accent: "#24c9d7", secondary: "#e86fb7", surface: "#f4fbff", text: "#16323a" }, copy: null },
    heroDataUrl: hero,
  });
  assert.equal(thumbOf(css), hero);
  assert.equal(thumbOf(":root{--wb-a:1}"), null);
});

test("皮肤弹窗：缩略图以 <img> 元素直渲（规避 Blink 超长 data URL CSS 静默丢弃），删除按钮为垃圾桶图标，标题栏固定不滚", () => {
  const script = build();
  assert.doesNotThrow(() => new Function(script));
  // thumb 为 data URL 时走 <img> 属性通道（不受 CSS 声明长度限制），object-fit 铺满封面
  assert.ok(script.includes('document.createElement("img")'));
  assert.ok(script.includes("img.src = thumb;"));
  assert.ok(script.includes("img.draggable = false;"));
  assert.ok(script.includes("object-fit:cover"));
  // 无 thumb（定制/原生主题）时 swatch 渐变兜底
  assert.ok(script.includes('swatch = "rgba(0,0,0,.08)"'));
  // 删除按钮：垃圾桶 SVG（trash-2），非 × 字符
  assert.ok(script.includes("trash") || script.includes('viewBox="0 0 24 24"'));
  assert.ok(script.includes('stroke="currentColor"'));
  // 标题栏固定不滚（flex:none），正文独立滚动（滚动条从标题栏下方开始）
  assert.ok(script.includes("flex:none;display:flex;align-items:center;justify-content:space-between"));
  assert.ok(script.includes("overflow-y:auto"));
});

test("皮肤弹窗：标题为「选择主题」，applyMode 同步弹窗背景/文字色（深色主题弹窗变深）", () => {
  const script = build();
  assert.doesNotThrow(() => new Function(script));
  assert.ok(script.includes(String.raw`"\u9009\u62e9\u4e3b\u9898"`));
  // applyMode 内同步弹窗色调（surface 深则弹窗深、文字浅；恢复原生 pin:false 也回白）
  assert.ok(script.includes('dialog.style.background = "color-mix(in srgb, " + surface + " 94%, transparent)"'));
  assert.ok(script.includes('dialog.style.color = isLightSurface(surface) ? "#17344f" : "#eef2f8"'));
  // 卡片/小节/关闭按钮颜色走 currentColor 混合，随弹窗文字色自适应深浅
  assert.ok(script.includes("color-mix(in srgb, currentColor 5%, transparent)"));
  assert.ok(script.includes("color-mix(in srgb, currentColor 55%, transparent)"));
});

test("皮肤弹窗：条目 thumb（theme.json thumbnail）优先作封面，非 data:image 值被丢弃", () => {
  const thumb = "data:image/webp;base64,QUJD";
  const script = build({
    entries: [
      { ...ENTRIES[0], thumb },
      { ...ENTRIES[1], thumb: "https://evil.test/x.png" },
      { id: "qq", name: "QQ", css: "a{}", group: "custom", thumb },
    ],
  });
  assert.doesNotThrow(() => new Function(script));
  const payload = JSON.parse(script.slice(script.indexOf("const data = ") + 13, script.indexOf(";\n", script.indexOf("const data = "))));
  assert.deepEqual(payload.themes.map((theme) => theme.thumb), [thumb, null, thumb]);
  // 定制主题卡用 theme.thumb；CSS 主题卡 palette 用显式 thumb（无则 mock），scenery thumb 优先、内联图兜底
  assert.ok(script.includes("card(theme.name, { thumb: theme.thumb, swatch: swatchOf(theme)"));
  assert.ok(script.includes('thumb: theme.group === "palette" ? theme.thumb : theme.thumb ?? thumbOf(theme.css)'));
});

test("皮肤弹窗：group 归一化为 custom/palette/scenery/image 四值，配色主题独立成组不混入图片组", () => {
  const script = build({
    entries: [
      { id: "img", name: "图", css: "a{}" },                                    // 缺省归 image
      { id: "tdp", name: "TDP", css: "b{}", group: "custom" },
      { id: "fn", name: "FocusNight", css: "c{}", group: "palette" },
      { id: "aur", name: "Aurora", css: "e{}", group: "scenery" },
      { id: "bogus", name: "假", css: "d{}", group: "palette2" },               // 非法值归 image
    ],
    activeId: null,
  });
  assert.doesNotThrow(() => new Function(script));
  const payload = JSON.parse(script.slice(script.indexOf("const data = ") + 13, script.indexOf(";\n", script.indexOf("const data = "))));
  assert.deepEqual(
    payload.themes.map((theme) => [theme.id, theme.group]),
    [["img", "image"], ["tdp", "custom"], ["fn", "palette"], ["aur", "scenery"], ["bogus", "image"]],
  );
  // 四个分组过滤器互斥：palette/scenery 不再落入「非 custom 即图片」的旧口径
  assert.ok(script.includes('theme.group === "custom"'));
  assert.ok(script.includes('theme.group === "palette"'));
  assert.ok(script.includes('theme.group === "scenery"'));
  assert.ok(script.includes('theme.group === "image"'));
});

test("皮肤弹窗：配色主题卡用四色迷你界面模型（surface 实底 + accent 渐变标题条），显式 thumbnail 优先", () => {
  const script = build({
    entries: [{ id: "fn", name: "FocusNight", css: "c{}", group: "palette", accent: "#67E8F9", secondary: "#2563EB", surface: "#090D13", text: "#EDF4FF" }],
    activeId: null,
  });
  assert.doesNotThrow(() => new Function(script));
  // palette 卡在合并后的 CSS 分区中仍传 mock（theme 本体），swatch 仅作 mock 之外的兜底
  assert.ok(/cssSection\.grid \}\);/.test(script));
  assert.ok(script.includes('mock: theme.group === "palette" ? theme : null'));
  // mock 构建器：surface 实底（与基座同式 surface 92% + text 5% 侧栏浮层）、accent→secondary 标题条、accent 胶囊按钮
  assert.ok(script.includes("const paletteMock = (preview, theme) => {"));
  assert.ok(script.includes('color-mix(in srgb," + surface + " 92%," + text + " 5%)'));
  assert.ok(script.includes('linear-gradient(90deg," + accent + "," + secondary + ")'));
  assert.ok(script.includes("border-radius:999px;background:\" + accent"));
  // 封面优先级：显式 thumbnail > mock > swatch
  assert.ok(script.includes("const useMock = mock && !thumb;"));
  // payload 归一化：合法 text 透传，非法/缺失为 null（mock 内按 surface 明暗推导兜底色）
  const payload = JSON.parse(script.slice(script.indexOf("const data = ") + 13, script.indexOf(";\n", script.indexOf("const data = "))));
  assert.equal(payload.themes[0].text, "#EDF4FF");
  const noText = build({ entries: [{ id: "x", name: "X", css: "a{}", text: "not-a-color" }], activeId: null });
  const payload2 = JSON.parse(noText.slice(noText.indexOf("const data = ") + 13, noText.indexOf(";\n", noText.indexOf("const data = "))));
  assert.equal(payload2.themes[0].text, null);
});
