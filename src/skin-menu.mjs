import { MAX_ANIMATED_DIMENSION, MAX_THEME_VIDEO_BYTES } from "./constants.mjs";
import { BASE64_DECODE_SNIPPET, VIDEO_DB_LITERALS } from "./renderer-snippets.mjs";

const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;
const DEFAULT_ACCENT = "#24c9d7";

// 菜单脚本在 window 上登记的拆除函数名：重复注入与 pause（removeSkin）都先调它，
// 断开上一轮的观察者/监听器/视频层，避免多轮注入并存互相改写
export const TEARDOWN_GLOBAL = "__workbuddySkinTeardown";

// 客户端 CSS 由 Node 端模板加哨兵生成，替换后与内置主题同源，避免两套模板漂移
export const CSS_SENTINELS = {
  id: "workbuddy-custom-sentinel-id",
  hero: "data:image/png;base64,WORKBUDDYHEROSENTINEL",
  accent: "#010203",
  secondary: "#040506",
  surface: "#070809",
  text: "#0a0b0c",
};

// 视频皮肤（内置/自定义共用）：<video> 固定层挂 #root 之下，需要 isolate 叠层上下文。
// 内置视频主题在 Node 端把它追加到 CSS 末尾，自定义视频主题在客户端拼接，同源一份避免漂移
export const VIDEO_LAYER_CSS = "\n#root { isolation: isolate !important; }\n";

export function buildSkinMenuScript({ entries, activeId, styleId, menuId, cssTemplate = "" }) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("皮肤菜单至少需要一个主题");
  }
  const themes = entries.map((entry) => {
    if (!entry?.id || typeof entry.css !== "string") throw new Error("主题条目缺少 id 或 css");
    return {
      id: String(entry.id),
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name : String(entry.id),
      accent: HEX_COLOR.test(entry.accent ?? "") ? entry.accent : DEFAULT_ACCENT,
      surface: typeof entry.surface === "string" ? entry.surface : "#ffffff",
      text: HEX_COLOR.test(entry.text ?? "") ? entry.text : null,
      css: entry.css,
      kind: entry.kind === "video" || entry.kind === "animated" ? entry.kind : "image",
      // 分组四值：custom=定制主题（整页 CSS 移植）、palette=配色主题（纯配色 CSS 移植）、
      // scenery=风景主题（场景插画 CSS 移植）、image=图片/视频主题
      group: entry.group === "custom" || entry.group === "palette" || entry.group === "scenery" ? entry.group : "image",
      js: typeof entry.js === "string" && entry.js ? entry.js : null,
      secondary: HEX_COLOR.test(entry.secondary ?? "") ? entry.secondary : null,
      // theme.json thumbnail 内联后的封面图；仅接受 data:image（防任意 URL 进 <img src>）
      thumb: typeof entry.thumb === "string" && /^data:image\/[a-z+]+;base64,/i.test(entry.thumb) ? entry.thumb : null,
    };
  });
  if (activeId !== null && !themes.some((theme) => theme.id === activeId)) {
    throw new Error(`当前主题不在菜单列表中：${activeId}`);
  }
  const payload = JSON.stringify({
    styleId,
    menuId,
    activeId,
    themes,
    cssTemplate,
    sentinels: CSS_SENTINELS,
    customPrefix: "custom-",
    storageKey: "workbuddyCustomThemes",
    legacyKey: "workbuddyCustomTheme",
    activeKey: "workbuddySkinActive",
    posKey: "workbuddySkinMenuPos",
    maxCustomSlots: 10,
  });

  return `(() => {
  const data = ${payload};

  // 统一诊断日志：切换/加载失败时控制台输出阶段名+主题 id，便于定位「点了没反应」类问题
  const logError = (stage, detail, error) => {
    console.error("WorkBuddy Skin：" + stage + (detail ? "（" + detail + "）" : ""), error);
  };

  // 拆掉上一轮注入：断开其 layout/mode 观察者、移除 resize/mousedown/storage 监听、释放视频层。
  // 不拆的话旧 modeObserver 仍钉着旧主题的明暗，新旧两轮对 body/html 类互相改写成死循环
  try { window[${JSON.stringify(TEARDOWN_GLOBAL)}]?.(); } catch (error) { logError("拆除上一轮注入失败", null, error); }
  // 兼容更早版本注入（无 teardown）：至少杀掉其挂在 window 上的观察者，防止旧菜单复活
  window.__workbuddySkinObserver?.disconnect();
  window.__workbuddySkinLayoutObserver?.disconnect();
  window.__workbuddySkinReviveObserver?.disconnect();

  let style = document.getElementById(data.styleId);
  if (!style) {
    style = document.createElement("style");
    style.id = data.styleId;
    document.head.appendChild(style);
  }

  document.getElementById(data.menuId)?.remove();
  const root = document.createElement("div");
  root.id = data.menuId;
  // no-drag：新建任务页等路由的 workbuddy-topbar 声明了 -webkit-app-region:drag
  // （矩形 240,30-1838,86 覆盖按钮位置），真实鼠标点击会被吞成窗口拖动；
  // DOM 命中测试与程序化 click 均绕过该机制，只有真实输入可复现
  // top:74px = topbar（30~86，所有路由都存在）内的原生按钮行（42~74）下沿起，
  // 与原生按钮恰好相切不重叠；上半段落在 drag 区靠继承的 no-drag 保证可点击
  root.style.cssText = "position:fixed;top:74px;right:7px;z-index:2147483000;font:500 13px/1.4 system-ui;user-select:none;-webkit-app-region:no-drag;app-region:no-drag;";

  // ---- 按钮拖拽定位：默认位置走下方 reposition（锚定原生按钮行）；用户拖拽后
  // 切换为 left/top 自由定位并持久化到 localStorage（posKey），重新注入/重启后恢复；
  // 双击按钮复位回默认位置。坐标按视口宽高比例（fx/fy ∈ [0,1]）存储，
  // 窗口最大化/缩放时按当前视口同比例换算，按钮相对位置随窗口自适应 ----
  const readPos = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(data.posKey) ?? "null");
      if (!saved) return null;
      if (Number.isFinite(saved.fx) && Number.isFinite(saved.fy)) return { fx: saved.fx, fy: saved.fy };
      // 兼容旧版绝对像素坐标：按当前视口换算成比例
      if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
        return { fx: saved.x / Math.max(1, window.innerWidth), fy: saved.y / Math.max(1, window.innerHeight) };
      }
    } catch {}
    return null;
  };
  const savePos = (pos) => {
    try {
      if (pos) localStorage.setItem(data.posKey, JSON.stringify(pos));
      else localStorage.removeItem(data.posKey);
    } catch {}
  };
  let customPos = readPos();
  // 比例坐标 → 像素并夹取进视口：拖到屏幕边缘、或窗口变小后，按钮不允许被甩出可视区
  const applyCustomPos = () => {
    const x = Math.max(0, Math.min(customPos.fx * window.innerWidth, window.innerWidth - root.offsetWidth));
    const y = Math.max(0, Math.min(customPos.fy * window.innerHeight, window.innerHeight - root.offsetHeight));
    root.style.right = "auto";
    root.style.left = Math.round(x) + "px";
    root.style.top = Math.round(y) + "px";
  };

  // 水平位置锚定原生按钮行（.workbuddy-topbar-actions）右缘：右侧详情栏打开时
  // 主 topbar 右缘左移，固定 right:7px 会把按钮甩进面板区域；跟随 actions 则始终
  // 停在「第一行按钮下方」。右缘偏移 = 行右缘 + 5px（与既有视觉一致，常态即 right:7px）。
  // actions 不存在时回落视口右缘 7px。仅调 right，root 始终挂 body，无挂载生命周期问题
  let cachedRight = null;
  const reposition = () => {
    // 用户拖过按钮：改用自由定位，按视口比例换算并夹取（resize 也会走到这里）
    if (customPos) { applyCustomPos(); return; }
    let next = 7;
    const actions = document.querySelector(".workbuddy-topbar-actions");
    if (actions) {
      const r = actions.getBoundingClientRect();
      if (r.width > 0) next = Math.max(0, Math.round(window.innerWidth - r.right - 5));
    }
    if (next !== cachedRight) {
      cachedRight = next;
      root.style.right = next + "px";
    }
  };
  // 合帧调度：body 子树 MutationObserver 在流式输出时每个 DOM 变更任务都会回调，
  // reposition 读 getBoundingClientRect 会强制同步布局；按 rAF 合并到每帧最多一次，
  // 且读布局落在浏览器本就要做布局的帧内，不再在每次变更后额外触发一次 reflow。
  // 定位按钮的显隐更新挂同一 observer（scheduleNavUpdate 在下方声明，回调只可能在
  // 脚本同步执行完之后触发，无 TDZ 问题），不另开 observer 避免流式输出双倍回调
  let repositionQueued = false;
  const scheduleReposition = () => {
    if (repositionQueued) return;
    repositionQueued = true;
    requestAnimationFrame(() => { repositionQueued = false; reposition(); });
  };
  const layoutObserver = new MutationObserver(() => { scheduleReposition(); scheduleNavUpdate(); });
  layoutObserver.observe(document.body, { childList: true, subtree: true });
  // 仍挂到 window：回退到旧版本注入时，旧脚本据此断开本轮观察者
  window.__workbuddySkinLayoutObserver = layoutObserver;
  window.addEventListener("resize", scheduleReposition);
  // 窗口尺寸变化会移动内容列右缘，定位按钮需一并重算：resize 监听在 scheduleNavUpdate
  // 声明之后注册（见下方导航区），此处直接传引用会踩 TDZ
  reposition();
  // actions 行可能晚于本脚本挂载，下一帧再校准一次
  scheduleReposition();

  // 复位默认位置：清除持久化坐标，交还 right 锚定逻辑；cachedRight 置空强制重算
  const resetPos = () => {
    customPos = null;
    savePos(null);
    root.style.left = "auto";
    root.style.top = "74px";
    cachedRight = null;
    reposition();
  };

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "\\u{1F3A8}";
  button.title = "WorkBuddy Skin Studio\\uff08\\u62d6\\u62fd\\u79fb\\u52a8\\uff0c\\u53cc\\u51fb\\u590d\\u4f4d\\uff09";
  // 无底图：去掉圆底/描边/阴影/磨砂，只留色盘图标本体；line-height 保证垂直居中；
  // cursor:grab + touch-action:none 服务拖拽（触屏拖时不滚页面）
  button.style.cssText = "display:block;margin-left:auto;width:38px;height:38px;border:0;background:transparent;cursor:grab;font-size:19px;padding:0;line-height:38px;touch-action:none;";

  // 拖拽移动：pointer capture 保证指针移出按钮后事件仍落在按钮上（沿途经过 topbar
  // 拖拽区/其他元素都不影响）；5px 位移阈值区分点击与拖拽，拖拽结束时抑制随之而来的
  // click 避免误开弹窗；双击复位默认位置（两次 click 一开一关相互抵消，弹窗状态不变）
  let dragState = null;
  let suppressClick = false;
  button.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const rect = root.getBoundingClientRect();
    dragState = { startX: event.clientX, startY: event.clientY, baseX: rect.left, baseY: rect.top, moved: false };
    try { button.setPointerCapture(event.pointerId); } catch {}
  });
  button.addEventListener("pointermove", (event) => {
    if (!dragState) return;
    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;
    if (!dragState.moved && Math.hypot(dx, dy) < 5) return;
    dragState.moved = true;
    button.style.cursor = "grabbing";
    // 存视口比例而非绝对像素：窗口最大化/缩放后仍保持相同的相对位置
    customPos = {
      fx: (dragState.baseX + dx) / Math.max(1, window.innerWidth),
      fy: (dragState.baseY + dy) / Math.max(1, window.innerHeight),
    };
    applyCustomPos();
  });
  const endDrag = () => {
    if (!dragState) return;
    if (dragState.moved) { savePos(customPos); suppressClick = true; }
    dragState = null;
    button.style.cursor = "grab";
  };
  button.addEventListener("pointerup", endDrag);
  button.addEventListener("pointercancel", endDrag);
  button.addEventListener("dblclick", () => { suppressClick = true; resetPos(); });

  // 主题选择弹窗：遮罩 + 居中对话框，按分类网格陈列缩略图卡片。
  // 弹窗挂 root 内（root 无 transform/filter，fixed 仍相对视口），随 root 一并 teardown。
  // 结构：header 固定不滚 + body 独立滚动（滚动条从标题栏下方开始）；
  // 背景/文字色跟随当前主题 surface/text（applyMode 时同步更新，见 updateDialogTone）
  const overlay = document.createElement("div");
  overlay.style.cssText = "display:none;position:fixed;inset:0;z-index:2147483001;background:rgba(15,20,35,.42);backdrop-filter:blur(6px);align-items:center;justify-content:center;-webkit-app-region:no-drag;app-region:no-drag;";
  const dialog = document.createElement("div");
  dialog.style.cssText = "width:min(760px,92vw);max-height:82vh;display:flex;flex-direction:column;overflow:hidden;border-radius:16px;border:1px solid color-mix(in srgb, currentColor 12%, transparent);background:rgba(255,255,255,.96);backdrop-filter:blur(20px);box-shadow:0 24px 60px rgba(0,0,0,.28);color:#17344f;";
  const dialogBody = document.createElement("div");
  dialogBody.style.cssText = "overflow-y:auto;padding:12px 20px 20px;scrollbar-width:thin;scrollbar-color:rgba(128,128,128,.45) transparent;";
  overlay.appendChild(dialog);

  const closeDialog = () => { overlay.style.display = "none"; };
  const openDialog = () => { overlay.style.display = "flex"; };
  overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) closeDialog(); });
  const onEscKey = (event) => {
    if (event.key === "Escape" && overlay.style.display !== "none") {
      event.stopPropagation();
      closeDialog();
    }
  };
  document.addEventListener("keydown", onEscKey, true);

  const rows = new Map();
  const paint = (id) => {
    for (const [rowId, row] of rows) {
      const active = rowId === id;
      row.style.borderColor = active ? "rgba(36,201,215,.9)" : "transparent";
      row.style.background = active ? "rgba(36,201,215,.10)" : "color-mix(in srgb, currentColor 5%, transparent)";
      const label = row.lastElementChild;
      if (label) label.style.fontWeight = active ? "700" : "500";
    }
  };
  // 缩略图卡片：thumb 为 data URL 时以 <img> 元素作封面（属性通道不受 Blink 对超长
  // data URL CSS 声明的静默丢弃限制，内置大 hero 与动图都能正常显示），否则用
  // swatch 渐变兜底（定制/原生主题）；mock 为配色主题的迷你界面模型预览（见 paletteMock）
  const card = (label, { thumb = null, swatch = "rgba(0,0,0,.08)", mock = null, onPick, before = null, parent }) => {
    const item = document.createElement("div");
    item.style.cssText = "display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:12px;cursor:pointer;border:2px solid transparent;background:color-mix(in srgb, currentColor 5%, transparent);box-sizing:border-box;";
    const preview = document.createElement("div");
    // 封面优先级：显式 thumbnail > 配色 mock > swatch 色块
    const useMock = mock && !thumb;
    preview.style.cssText = "position:relative;width:100%;aspect-ratio:16/10;border-radius:8px;background:" + (useMock ? mock.surface : swatch) + ";overflow:hidden;";
    if (thumb) {
      const img = document.createElement("img");
      img.src = thumb;
      img.alt = "";
      img.draggable = false;
      img.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;";
      preview.appendChild(img);
    } else if (useMock) {
      paletteMock(preview, mock);
    }
    const name = document.createElement("div");
    name.textContent = label;
    // 主题名最多两行（中英双语名普遍超一行）：-webkit-line-clamp 换行展示，超出仍截断
    name.style.cssText = "font-size:12px;line-height:18px;font-weight:500;text-align:center;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;";
    item.append(preview, name);
    item.addEventListener("mouseenter", () => { if (item.style.borderColor === "transparent") item.style.borderColor = "rgba(36,201,215,.45)"; });
    item.addEventListener("mouseleave", () => paint(document.documentElement.dataset.workbuddySkin ?? null));
    // 兜底：onPick（切换/上传入口）任何同步异常都不允许打断菜单，统一落日志
    item.addEventListener("click", () => {
      try { onPick(item); } catch (error) { logError("主题列表项点击处理失败", label, error); }
    });
    if (before) parent.insertBefore(item, before); else parent.appendChild(item);
    return item;
  };
  // 配色主题预览卡：纯配色主题无图可展示，单 accent→secondary 色块掩盖了主题的
  // 视觉主体（surface 底色，深浅完全不可辨）。用四色搭迷你界面模型——surface 实底 +
  // 侧边栏浮层（与 buildPaletteCss 同一 surface/text 混合式）+ accent 选中条 +
  // accent→secondary 标题条 + 文字线 + accent 胶囊按钮，深浅/取色所见即所得
  const paletteMock = (preview, theme) => {
    const accent = theme.accent;
    const secondary = theme.secondary ?? theme.accent;
    const surface = theme.surface;
    const text = theme.text ?? (isLightSurface(surface) ? "#1f2430" : "#eef2f8");
    const soft = (c, p) => "color-mix(in srgb," + c + " " + p + "%,transparent)";
    const bar = (css) => {
      const d = document.createElement("div");
      d.style.cssText = "position:absolute;pointer-events:none;" + css;
      preview.appendChild(d);
    };
    // 侧边栏浮层 + accent 分隔线（与配色基座同式：surface 92% + text 5%）
    bar("left:0;top:0;bottom:0;width:24%;background:color-mix(in srgb," + surface + " 92%," + text + " 5%);border-right:1px solid " + soft(accent, 45) + ";");
    // 侧栏选中项与文字线
    bar("left:4%;top:15%;width:16%;height:9%;border-radius:3px;background:" + soft(accent, 22) + ";");
    bar("left:4%;top:33%;width:15%;height:4.5%;border-radius:2px;background:" + soft(text, 22) + ";");
    bar("left:4%;top:43%;width:13%;height:4.5%;border-radius:2px;background:" + soft(text, 16) + ";");
    // 主区标题条（accent→secondary 渐变，同首页主标题处理）
    bar("left:32%;top:15%;width:42%;height:10%;border-radius:3px;background:linear-gradient(90deg," + accent + "," + secondary + ");");
    // 主区文字线 ×2
    bar("left:32%;top:36%;width:54%;height:5%;border-radius:2px;background:" + soft(text, 28) + ";");
    bar("left:32%;top:47%;width:42%;height:5%;border-radius:2px;background:" + soft(text, 18) + ";");
    // accent 胶囊按钮
    bar("left:32%;top:66%;width:19%;height:12%;border-radius:999px;background:" + accent + ";");
  };
  // 从条目 CSS 中提取首个内联图片作缩略图（hero/poster 均为 data URL，零额外负载）。
  // 注意：本段位于模板字面量内，反斜杠转义会被吃掉——\/ 变 / 提前终结正则，
  // \( \) 变成裸括号（分组）导致对 url("data:...") 永远匹配失败。斜杠/括号一律走字符类
  const thumbOf = (css) => {
    const match = /url[(]"?(data:image[/][a-z+]+;base64,[^")]+)"?[)]/i.exec(css);
    return match ? match[1] : null;
  };

  const isLightSurface = (hex) => {
    const m = /^#([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return true;
    const v = parseInt(m[1], 16);
    return (0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) > 140;
  };
  // 同步切换 WorkBuddy 的主题模式，让原生控件跟着深浅色变。
  // 两个坑：
  // 1. dark token 作用域含 body[data-vscode-theme-name="IDE Night"]，主题名必须写
  //    应用真实值（dark=IDE Night / light=IDE Light，旧版误用 IDE Dark 匹配不上）；
  // 2. 应用启动/主题同步会异步回写 themeName 和 body/html 的深浅类——注入若早于
  //    应用初始化完成，我们写的 light 类会被覆盖，cb 类名驱动的区域（如 composer）
  //    滞留深色。故钉住整个模式（themeName + themeKind + 六个类），观察 body/html
  //    属性，不一致才重写（写后状态一致，observer 回调空转，收敛无环）
  const MODE_CLASSES = ["light", "vscode-light", "cb-light", "dark", "vscode-dark", "cb-dark"];
  const isDarkClass = (cls) => cls === "dark" || cls === "vscode-dark" || cls === "cb-dark";
  let pinnedDark = null;
  const writeMode = () => {
    const dark = pinnedDark;
    const body = document.body;
    const html = document.documentElement;
    body.dataset.vscodeThemeKind = dark ? "vscode-dark" : "vscode-light";
    body.dataset.vscodeThemeName = dark ? "IDE Night" : "IDE Light";
    html.style.colorScheme = dark ? "dark" : "light";
    MODE_CLASSES.forEach((cls) => {
      const want = dark ? isDarkClass(cls) : !isDarkClass(cls);
      body.classList.toggle(cls, want);
      html.classList.toggle(cls, want);
    });
  };
  const modeMatches = () => {
    if (pinnedDark === null) return true;
    const dark = pinnedDark;
    const body = document.body;
    const html = document.documentElement;
    if (body.dataset.vscodeThemeName !== (dark ? "IDE Night" : "IDE Light")) return false;
    if (body.dataset.vscodeThemeKind !== (dark ? "vscode-dark" : "vscode-light")) return false;
    return MODE_CLASSES.every((cls) => {
      const want = dark ? isDarkClass(cls) : !isDarkClass(cls);
      return body.classList.contains(cls) === want && html.classList.contains(cls) === want;
    });
  };
  const modeObserver = new MutationObserver(() => {
    if (pinnedDark !== null && !modeMatches()) writeMode();
  });
  const applyMode = (surface, { pin = true } = {}) => {
    modeObserver.disconnect();
    // 弹窗背景/文字色与当前主题一致（恢复原生时回到白色默认）
    dialog.style.background = "color-mix(in srgb, " + surface + " 94%, transparent)";
    dialog.style.color = isLightSurface(surface) ? "#17344f" : "#eef2f8";
    if (!pin) {
      // 恢复原生：解除钉住，类与属性的所有权还给应用
      pinnedDark = null;
      return;
    }
    pinnedDark = !isLightSurface(surface);
    writeMode();
    // 应用的回写是异步的，补写两轮覆盖（observer 持续兜底）
    setTimeout(() => { if (pinnedDark !== null && !modeMatches()) writeMode(); }, 60);
    setTimeout(() => { if (pinnedDark !== null && !modeMatches()) writeMode(); }, 350);
    modeObserver.observe(document.body, { attributes: true, attributeFilter: ["class", "data-vscode-theme-kind", "data-vscode-theme-name"] });
    modeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  };
  const persistActive = (id) => {
    // 记住当前皮肤：重启后 apply 不带 --theme 时恢复（见 cli.mjs）
    try {
      if (id) localStorage.setItem(data.activeKey, id);
      else localStorage.removeItem(data.activeKey);
    } catch {}
  };
  // 主题伴随 JS（如 TDP 英雄层 DOM 注入）：约定 js 文本作为函数体执行，
  // 返回值若是函数则作为拆除回调（切换/暂停/重复注入时调用）。
  // 页面 CSP 若禁 eval（new Function 抛错）只记警告，CSS 皮肤本体不受影响
  let activeJsTeardown = null;
  const teardownThemeJs = () => {
    const teardown = activeJsTeardown;
    activeJsTeardown = null;
    if (typeof teardown === "function") {
      try { teardown(); } catch (error) { logError("拆除主题 JS 失败", null, error); }
    }
  };
  const runThemeJs = (theme) => {
    teardownThemeJs();
    if (!theme.js) return;
    try {
      const result = new Function(theme.js)();
      activeJsTeardown = typeof result === "function" ? result : null;
    } catch (error) {
      logError("执行主题 JS 失败", theme.id, error);
    }
  };
  const setTheme = (id) => {
    const theme = data.themes.find((candidate) => candidate.id === id);
    if (!theme) {
      console.warn("WorkBuddy Skin：主题不在菜单列表中，切换已忽略：" + id);
      return;
    }
    try {
      releaseHeroBlob();
      style.textContent = theme.css;
      document.documentElement.dataset.workbuddySkin = theme.id;
      applyMode(theme.surface);
      persistActive(theme.id);
      paint(theme.id);
      // 内置视频主题：海报帧 CSS 已就位，按主题 id 从 IndexedDB 取视频挂 <video> 固定层；
      // 普通图片主题则释放上一个视频层
      if (theme.kind === "video") mountVideo(theme);
      else releaseVideo();
      // 伴随 JS 最后执行：CSS 与明暗钉住已就位，DOM 注入直接落在最终样式环境里
      runThemeJs(theme);
    } catch (error) {
      logError("切换主题失败", id, error);
    }
  };
  const clearTheme = () => {
    try {
      teardownThemeJs();
      releaseHeroBlob();
      releaseVideo();
      style.textContent = "";
      delete document.documentElement.dataset.workbuddySkin;
      // 恢复原生：pin:false 解除模式钉住，把类与属性的所有权还给应用
      applyMode("#ffffff", { pin: false });
      persistActive(null);
      paint(null);
    } catch (error) {
      logError("恢复原生界面失败", null, error);
    }
  };
  // 原生浅色/深色：清空皮肤 CSS，但把明暗钉在指定模式（区别于 clearTheme 的完全交还应用）。
  // 持久化为 native-light/native-dark，重新 apply 时据此恢复（见 cli 的 savedNative 分支）
  const setNative = (mode) => {
    const id = mode === "dark" ? "native-dark" : "native-light";
    try {
      teardownThemeJs();
      releaseHeroBlob();
      releaseVideo();
      style.textContent = "";
      delete document.documentElement.dataset.workbuddySkin;
      applyMode(mode === "dark" ? "#101418" : "#ffffff");
      persistActive(id);
      paint(id);
    } catch (error) {
      logError("切换原生界面失败", id, error);
    }
  };

  // 视频/动图主题在卡片缩略图左上角加闪电角标（feather zap 内联 SVG，stroke=currentColor）
  const attachBadge = (item, kind) => {
    if (kind !== "video" && kind !== "animated") return;
    const tag = document.createElement("span");
    tag.style.cssText = "position:absolute;left:6px;top:6px;width:16px;height:16px;color:#ffd54a;box-sizing:border-box;filter:drop-shadow(0 1px 2px rgba(0,0,0,.55));";
    tag.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>';
    item.firstElementChild.appendChild(tag);
  };

  // 弹窗标题栏：固定不滚（滚动条从其下方的 body 开始），颜色跟随弹窗主题色
  const header = document.createElement("div");
  header.style.cssText = "flex:none;display:flex;align-items:center;justify-content:space-between;padding:14px 20px 10px;border-bottom:1px solid color-mix(in srgb, currentColor 10%, transparent);";
  const titleEl = document.createElement("div");
  titleEl.textContent = "\\u9009\\u62e9\\u4e3b\\u9898";
  titleEl.style.cssText = "font-size:15px;font-weight:700;";
  const closeBtn = document.createElement("span");
  closeBtn.textContent = "\\u00d7";
  closeBtn.title = "\\u5173\\u95ed";
  closeBtn.style.cssText = "width:26px;height:26px;line-height:24px;text-align:center;border-radius:8px;font-size:16px;color:color-mix(in srgb, currentColor 60%, transparent);cursor:pointer;";
  closeBtn.addEventListener("mouseenter", () => { closeBtn.style.background = "color-mix(in srgb, currentColor 8%, transparent)"; });
  closeBtn.addEventListener("mouseleave", () => { closeBtn.style.background = "transparent"; });
  closeBtn.addEventListener("click", closeDialog);
  header.append(titleEl, closeBtn);
  dialog.append(header, dialogBody);

  // 分类小节：标题行（extra 挂槽位计数等附加信息）+ 卡片网格，挂进滚动 body
  const section = (label) => {
    const wrap = document.createElement("div");
    wrap.style.cssText = "margin-top:10px;";
    const head = document.createElement("div");
    head.style.cssText = "display:flex;align-items:baseline;justify-content:space-between;padding:2px 2px 6px;";
    const text = document.createElement("span");
    text.textContent = label;
    text.style.cssText = "font-size:12px;font-weight:600;color:color-mix(in srgb, currentColor 55%, transparent);";
    const extra = document.createElement("span");
    extra.style.cssText = "font-size:11px;color:color-mix(in srgb, currentColor 45%, transparent);";
    head.append(text, extra);
    const grid = document.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(128px,1fr));gap:10px;";
    wrap.append(head, grid);
    dialogBody.appendChild(wrap);
    return { grid, extra };
  };
  const swatchOf = (theme) => "linear-gradient(135deg," + theme.accent + "," + (theme.secondary ?? theme.accent) + ")";

  // 自定义主题单独分类小节（置顶展示），标题行右侧显示槽位占用（x/n）
  const customsSection = section("\\u81ea\\u5b9a\\u4e49\\u4e3b\\u9898\\uff08\\u53ef\\u5207\\u6362\\u660e\\u6697\\u4e3b\\u8272\\uff09");

  // 定制主题（整页 CSS 移植，无 hero 底图）：theme.json thumbnail 作封面，
  // 未配置时 accent→secondary 渐变色块兜底
  const customBuiltins = data.themes.filter((theme) => theme.group === "custom");
  if (customBuiltins.length > 0) {
    const customSection = section("\\u5b9a\\u5236\\u4e3b\\u9898");
    for (const theme of customBuiltins) {
      const item = card(theme.name, { thumb: theme.thumb, swatch: swatchOf(theme), onPick: () => { setTheme(theme.id); closeDialog(); }, parent: customSection.grid });
      attachBadge(item, theme.kind);
      rows.set(theme.id, item);
    }
  }

  // 图片/视频主题：theme.json thumbnail 优先，否则从条目 CSS 提取首个内联图（hero/poster）
  const imageThemes = data.themes.filter((theme) => theme.group === "image");
  if (imageThemes.length > 0) {
    const imageSection = section("\\u56fe\\u7247\\u4e3b\\u9898");
    for (const theme of imageThemes) {
      const item = card(theme.name, { thumb: theme.thumb ?? thumbOf(theme.css), swatch: swatchOf(theme), onPick: () => { setTheme(theme.id); closeDialog(); }, parent: imageSection.grid });
      attachBadge(item, theme.kind);
      rows.set(theme.id, item);
    }
  }

  // CSS 主题（纯配色 palette + 场景插画 scenery 合一展示）：
  // group 值保留注入语义（palette 触发换色基座 buildPaletteCss），仅展示层合并。
  // 封面优先级沿用 card 规则：显式 thumbnail > 配色 mock > CSS 内联图提取 > 渐变色块
  const cssBuiltins = data.themes.filter((theme) => theme.group === "palette" || theme.group === "scenery");
  if (cssBuiltins.length > 0) {
    const cssSection = section("CSS\\u4e3b\\u9898");
    for (const theme of cssBuiltins) {
      // palette 卡走四色迷你界面模型（mock），不做内联图提取以免误盖 mock；
      // scenery 卡 thumbnail 优先、CSS 内联图提取兜底
      const item = card(theme.name, { thumb: theme.group === "palette" ? theme.thumb : theme.thumb ?? thumbOf(theme.css), mock: theme.group === "palette" ? theme : null, swatch: swatchOf(theme), onPick: () => { setTheme(theme.id); closeDialog(); }, parent: cssSection.grid });
      attachBadge(item, theme.kind);
      rows.set(theme.id, item);
    }
  }

  // 原生主题（置底）：浅色/深色两张色块卡，分别钉住明暗模式
  const nativeSection = section("\\u539f\\u751f\\u4e3b\\u9898");
  const nativeLight = card("\\u539f\\u751f\\u754c\\u9762 \\u00b7 \\u6d45\\u8272", { swatch: "linear-gradient(135deg,#ffffff,#dde6f0)", onPick: () => { setNative("light"); closeDialog(); }, parent: nativeSection.grid });
  rows.set("native-light", nativeLight);
  const nativeDark = card("\\u539f\\u751f\\u754c\\u9762 \\u00b7 \\u6df1\\u8272", { swatch: "linear-gradient(135deg,#262b36,#101318)", onPick: () => { setNative("dark"); closeDialog(); }, parent: nativeSection.grid });
  rows.set("native-dark", nativeDark);

  // ---- 自定义皮肤：本地选图/选视频 -> 压缩 -> 取色 -> 生成 CSS -> 持久化（多槽位） ----
  // updateSlots 同时负责上传卡显隐：uploadCard 是下方才声明的 const，但本函数首次调用
  // （初始化/增删皮肤）都发生在 uploadCard 声明之后，不存在 TDZ 问题
  const updateSlots = () => {
    const count = loadCustoms().length;
    customsSection.extra.textContent = "\\u69fd\\u4f4d " + count + "/" + data.maxCustomSlots;
    // 槽位满时隐藏新增入口（点击也只会弹已满提示）；删除皮肤后自动恢复显示
    uploadCard.style.display = count >= data.maxCustomSlots ? "none" : "";
  };
  // hero 放最后替换：它可能是数 MB 的 data URL，先替换会让后续 5 轮 split 都扫一遍大串
  const buildCustomCss = (heroUrl, colors, themeId) => data.cssTemplate
    .split(data.sentinels.accent).join(colors.accent)
    .split(data.sentinels.secondary).join(colors.secondary)
    .split(data.sentinels.surface).join(colors.surface)
    .split(data.sentinels.text).join(colors.text)
    .split(data.sentinels.id).join(themeId)
    .split(data.sentinels.hero).join(heroUrl);

  const hex = (r, g, b) => "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const hexToRgb = (value) => {
    const m = /^#([0-9a-f]{6})$/i.exec(value || "");
    if (!m) return null;
    const v = parseInt(m[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  };
  const lumOf = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  // 由主色派生浅/深两套面板底色+文字色，运行时按模式挑选（见 effectiveColors）
  const buildSurfaces = (accentRgb) => ({
    light: {
      surface: hex(...mix(accentRgb, [252, 252, 255], 0.92)),
      text: hex(...mix(accentRgb, [16, 24, 40], 0.82)),
    },
    dark: {
      surface: hex(...mix(accentRgb, [12, 12, 18], 0.86)),
      text: hex(...mix(accentRgb, [244, 246, 252], 0.85)),
    },
  });

  const extractPalette = (canvas) => {
    const ctx = canvas.getContext("2d");
    const { data: px } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const buckets = new Map();
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const sat = max === 0 ? 0 : (max - min) / max;
      if (sat < 0.18 || lum < 24 || lum > 245) continue;   // 灰、过暗、过曝不参与取主色
      const d = max - min || 1;
      let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      const bucket = Math.round(h) % 6 * 2 + (sat > 0.55 ? 1 : 0);
      const entry = buckets.get(bucket) ?? { w: 0, r: 0, g: 0, b: 0, h: h * 60 };
      const weight = sat * sat;
      entry.w += weight; entry.r += r * weight; entry.g += g * weight; entry.b += b * weight;
      buckets.set(bucket, entry);
    }
    const ranked = [...buckets.values()].sort((a, b2) => b2.w - a.w)
      .map((e) => ({ rgb: [e.r / e.w, e.g / e.w, e.b / e.w], h: e.h, w: e.w }));
    const accent = ranked[0]?.rgb ?? [36, 201, 215];
    const second = ranked.find((e) => Math.abs(e.h - (ranked[0]?.h ?? 0)) > 50)?.rgb
      ?? mix(accent, [255, 255, 255], 0.35);
    // 明暗不再由全图平均亮度决定：同一主题生成浅/深两套 surface/text，
    // 运行时按「自动（主色亮度）/浅色/深色」三选挑选
    return {
      accent: hex(...accent),
      secondary: hex(...second),
      ...buildSurfaces(accent),
    };
  };

  // Blink 的 CSS 解析器会静默丢弃含超长 data URL 的 background 声明（实测 4MB 动图
  // 必现，整个 background 简写失效背景消失），大体积 hero 统一转 blob: URL 再注入。
  // blob URL 生命周期与 renderer 一致，正好匹配注入的生命周期；localStorage 里仍存
  // data URL，每次应用现场转换，重启后重新注入时自然重建
  ${BASE64_DECODE_SNIPPET}
  let heroBlobUrl = null;
  const releaseHeroBlob = () => {
    if (!heroBlobUrl) return;
    URL.revokeObjectURL(heroBlobUrl);
    heroBlobUrl = null;
  };
  const asCssUrl = (dataUrl) => {
    // 无论走哪条分支都先释放上一张 hero 的 blob：小图返回 data URL 后旧 blob 已无人引用
    releaseHeroBlob();
    if (typeof dataUrl !== "string" || dataUrl.length < 256 * 1024) return dataUrl;
    // localStorage 数据可能被手动改坏：格式/base64 非法时 atob 会抛异常打断切换，
    // 校验失败一律回退原始 data URL 并落日志（CSS 静默失效好于整次切换崩溃）
    const comma = dataUrl.indexOf(",");
    if (!dataUrl.startsWith("data:") || comma < 0) {
      console.warn("WorkBuddy Skin：主题图片数据不是合法 data URL，已跳过 blob 转换");
      return dataUrl;
    }
    const mime = dataUrl.slice(5, comma).split(";")[0];
    const b64 = dataUrl.slice(comma + 1);
    try {
      // 大图逐字节 atob 循环会同步阻塞主线程（切换卡顿的主要来源），走共享快路径解码
      const bytes = wbSkinDecodeBase64(b64);
      heroBlobUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
      return heroBlobUrl;
    } catch (error) {
      console.warn("WorkBuddy Skin：主题图片 base64 解码失败，回退原始 data URL", error);
      return dataUrl;
    }
  };

  // ---- 视频皮肤（MP4）：CSS 无法播放视频背景，做法是海报帧作 CSS 底图兜底，
  // 另挂 <video> 固定层透出动画；视频体积普遍超 localStorage 配额，
  // 原始文件存 IndexedDB（自定义皮肤元数据仍走 localStorage；内置视频主题由
  // Node 端注入时按主题 id 预置进同一个库），blob URL 会话内缓存复用 ----
  const VIDEO_LAYER_CSS = ${JSON.stringify(VIDEO_LAYER_CSS)};
  const MAX_VIDEO_BYTES = ${MAX_THEME_VIDEO_BYTES};
  let videoLayer = null;
  const videoUrlCache = new Map();
  const releaseVideo = () => {
    videoLayer?.remove();
    videoLayer = null;
  };
  const VIDEO_STORE = ${VIDEO_DB_LITERALS.store};
  const videoStore = {
    db: null,
    close() {
      this.db?.close();
      this.db = null;
    },
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(${VIDEO_DB_LITERALS.db}, 1);
        req.onupgradeneeded = () => { req.result.createObjectStore(VIDEO_STORE); };
        req.onsuccess = () => {
          this.db = req.result;
          // 其他连接要升级/删库时主动让出，避免对方被本连接 block
          this.db.onversionchange = () => this.close();
          resolve(this.db);
        };
        req.onerror = () => reject(req.error);
        // 旧连接未关闭（如页面刷新残留）时 open 会被 block：Promise 挂起但 onerror
        // 不触发，表现为「切换视频主题后毫无反应」——只落日志，保持等待（阻塞解除后仍可用）
        req.onblocked = () => console.warn("WorkBuddy Skin：IndexedDB 打开被阻塞（可能存在未关闭的旧连接），视频皮肤加载将延迟");
      });
    },
    txn(mode, run) {
      return this.open().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(VIDEO_STORE, mode);
        const req = run(tx.objectStore(VIDEO_STORE));
        tx.oncomplete = () => resolve(req?.result);
        tx.onerror = () => reject(tx.error);
        // 事务中止既不触发 oncomplete 也不触发 onerror，缺了它 Promise 会永远挂起
        tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
      }));
    },
    put(id, blob) { return this.txn("readwrite", (store) => store.put(blob, id)); },
    get(id) { return this.txn("readonly", (store) => store.get(id)); },
    del(id) { return this.txn("readwrite", (store) => store.delete(id)); },
  };
  // 渐变遮罩与 CSS 模板里 #root 背景的两层渐变一致，保证视频上内容可读
  const mountVideo = (theme) => {
    releaseVideo();
    const attach = (url) => {
      // 异步取 blob 期间用户可能已切换主题，避免把视频挂到错误主题上
      if (document.documentElement.dataset.workbuddySkin !== theme.id) return;
      releaseVideo();
      const wrapper = document.createElement("div");
      wrapper.style.cssText = "position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden;";
      const video = document.createElement("video");
      video.autoplay = true; video.muted = true; video.loop = true; video.playsInline = true;
      video.style.cssText = "width:100%;height:100%;object-fit:cover;object-position:right center;display:block;";
      video.src = url;
      // 自动播放被策略拦截不算故障（ muted+playsInline 下少见），但静默吞掉不利于诊断
      video.play().catch((error) => console.warn("WorkBuddy Skin：视频自动播放失败（" + theme.id + "）", error));
      const overlay = document.createElement("div");
      overlay.style.cssText = "position:absolute;inset:0;background:"
        + "linear-gradient(90deg, color-mix(in srgb, var(--wb-surface) 72%, transparent) 0 14%, transparent 30%),"
        + "linear-gradient(180deg, transparent 0 70%, color-mix(in srgb, var(--wb-surface) 50%, transparent) 85% 100%);";
      wrapper.append(video, overlay);
      (document.getElementById("root") ?? document.body).appendChild(wrapper);
      videoLayer = wrapper;
    };
    const cached = videoUrlCache.get(theme.id);
    if (cached) { attach(cached); return; }
    videoStore.get(theme.id).then((blob) => {
      if (!blob) { console.warn("WorkBuddy Skin：视频数据缺失（IndexedDB 中未找到，主题：" + theme.id + "），请重新上传"); return; }
      const url = URL.createObjectURL(blob);
      videoUrlCache.set(theme.id, url);
      attach(url);
    }).catch((error) => console.warn("WorkBuddy Skin：视频皮肤加载失败（" + theme.id + "）", error));
  };

  // 旧格式 colors（扁平 surface/text）按 accent 重算浅/深两套，无损升级；新格式原样返回
  const normalizeColors = (colors) => {
    if (!colors || typeof colors !== "object") return null;
    if (colors.light?.surface && colors.light?.text && colors.dark?.surface && colors.dark?.text) return colors;
    const accentRgb = hexToRgb(colors.accent);
    if (!accentRgb) return null;
    return {
      accent: colors.accent,
      secondary: colors.secondary ?? colors.accent,
      ...buildSurfaces(accentRgb),
    };
  };
  // 兼容旧自定义主题：补双套配色，补 mode 字段（默认 auto）；
  // 视频皮肤无 dataUrl，以 poster（海报帧）为必备字段
  const normalizeTheme = (theme) => {
    if (!theme || !theme.id || !theme.colors) return null;
    if (theme.kind === "video" ? !theme.poster : !theme.dataUrl) return null;
    const colors = normalizeColors(theme.colors);
    if (!colors) return null;
    const mode = theme.mode === "light" || theme.mode === "dark" ? theme.mode : "auto";
    return { ...theme, colors, mode };
  };
  // 运行时把双套配色压平成 buildCustomCss 需要的扁平结构；
  // auto 用主色 accent 亮度判定明暗（亮主色→浅，深主色→深），阈值 128 与原全图判定一致
  const effectiveColors = (theme) => {
    const colors = theme.colors;
    const accentRgb = hexToRgb(colors.accent);
    const autoKey = accentRgb && lumOf(accentRgb) > 128 ? "light" : "dark";
    const mode = theme.mode === "light" || theme.mode === "dark" ? theme.mode : "auto";
    const variant = colors[mode === "auto" ? autoKey : mode] ?? colors.light;
    return {
      accent: colors.accent,
      secondary: colors.secondary,
      surface: variant.surface,
      text: variant.text,
    };
  };

  const applyCustomTheme = (theme) => {
    try {
      applyCustomThemeUnsafe(theme);
    } catch (error) {
      logError("应用自定义主题失败", theme?.id, error);
    }
  };
  const applyCustomThemeUnsafe = (theme) => {
    const flat = effectiveColors(theme);
    const isVideo = theme.kind === "video";
    // 视频：海报帧作 CSS 底图（小图，无需 blob），视频异步挂载前/解码失败时兜底；
    // 图片：大图经 asCssUrl 转 blob URL（内部会释放上一张 hero blob）
    if (isVideo) releaseHeroBlob();
    else releaseVideo();
    const heroUrl = isVideo ? theme.poster : asCssUrl(theme.dataUrl);
    style.textContent = buildCustomCss(heroUrl, flat, theme.id) + (isVideo ? VIDEO_LAYER_CSS : "");
    document.documentElement.dataset.workbuddySkin = theme.id;
    applyMode(flat.surface);
    ensureCustomRow(theme);
    persistActive(theme.id);
    paint(theme.id);
    if (isVideo) mountVideo(theme);
  };

  const deleteCustom = (id) => {
    const list = loadCustoms().filter((theme) => theme.id !== id);
    saveCustoms(list);
    if (document.documentElement.dataset.workbuddySkin === id) clearTheme();
    const cachedUrl = videoUrlCache.get(id);
    if (cachedUrl) { URL.revokeObjectURL(cachedUrl); videoUrlCache.delete(id); }
    videoStore.del(id).catch(() => {});
    rows.get(id)?.remove();
    rows.delete(id);
    updateSlots();
  };
  const ensureCustomRow = (theme) => {
    if (rows.has(theme.id)) return;
    const customCard = card(theme.name, {
      thumb: theme.kind === "video" ? theme.poster : theme.dataUrl,
      swatch: "linear-gradient(135deg," + theme.colors.accent + "," + theme.colors.secondary + ")",
      onPick: () => {
        applyCustomTheme(loadCustoms().find((saved) => saved.id === theme.id) ?? theme);
        closeDialog();
      },
      before: uploadCard,
      parent: customsSection.grid,
    });
    const preview = customCard.firstElementChild;
    // 自定义视频/动图主题同样加标注（缩略图右下角）
    attachBadge(customCard, theme.kind);
    // 明暗模式三选：自（自动按主色亮度）→ 浅 → 深 循环，持久化；正应用此主题时立即重渲染
    const MODE_SEQUENCE = ["auto", "light", "dark"];
    const MODE_LABEL = { auto: "\\u81ea", light: "\\u6d45", dark: "\\u6df1" };
    const MODE_TITLE = { auto: "\\u81ea\\u52a8\\uff08\\u6309\\u4e3b\\u8272\\u660e\\u6697\\uff09", light: "\\u6d45\\u8272", dark: "\\u6df1\\u8272" };
    const currentMode = () => (theme.mode === "light" || theme.mode === "dark" ? theme.mode : "auto");
    const modeBtn = document.createElement("span");
    modeBtn.style.cssText = "position:absolute;left:6px;bottom:6px;min-width:20px;height:20px;line-height:19px;text-align:center;border-radius:6px;color:rgba(0,0,0,.6);font-size:11px;background:rgba(255,255,255,.88);cursor:pointer;padding:0 3px;box-sizing:border-box;";
    const refreshModeBtn = () => {
      modeBtn.textContent = MODE_LABEL[currentMode()];
      modeBtn.title = "\\u660e\\u6697\\u6a21\\u5f0f\\uff1a" + MODE_TITLE[currentMode()] + "\\uff08\\u70b9\\u51fb\\u5207\\u6362\\uff09";
    };
    refreshModeBtn();
    modeBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      theme.mode = MODE_SEQUENCE[(MODE_SEQUENCE.indexOf(currentMode()) + 1) % MODE_SEQUENCE.length];
      saveCustoms(loadCustoms().map((t) => (t.id === theme.id ? { ...t, mode: theme.mode } : t)));
      refreshModeBtn();
      if (document.documentElement.dataset.workbuddySkin === theme.id) {
        applyCustomTheme(loadCustoms().find((saved) => saved.id === theme.id) ?? theme);
      }
    });
    preview.appendChild(modeBtn);
    const del = document.createElement("span");
    // 垃圾桶删除图标（feather trash-2 内联 SVG，颜色跟随 currentColor 便于悬停反白）
    del.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
    del.title = "\\u5220\\u9664\\u81ea\\u5b9a\\u4e49\\u4e3b\\u9898";
    del.style.cssText = "position:absolute;right:6px;top:6px;width:20px;height:20px;display:flex;align-items:center;justify-content:center;border-radius:50%;color:rgba(0,0,0,.55);background:rgba(255,255,255,.88);box-sizing:border-box;";
    del.addEventListener("mouseenter", () => { del.style.background = "rgba(220,60,60,.9)"; del.style.color = "#ffffff"; });
    del.addEventListener("mouseleave", () => { del.style.background = "rgba(255,255,255,.88)"; del.style.color = "rgba(0,0,0,.55)"; });
    del.addEventListener("click", (event) => { event.stopPropagation(); deleteCustom(theme.id); });
    preview.appendChild(del);
    rows.set(theme.id, customCard);
    updateSlots();
  };

  // ---- 动图支持：GIF / 动态 WebP 跳过 canvas 重编码，原数据直接注入 CSS 以保留动画 ----
  // localStorage 配额约 5MB，base64 膨胀 4/3，故原始动图限制 3MB；
  // 动图不走 canvas 压缩，需单独卡分辨率上限，避免超大尺寸拖慢渲染
  const MAX_ANIMATED_BYTES = 3 * 1024 * 1024;
  const MAX_ANIMATED_DIMENSION = ${MAX_ANIMATED_DIMENSION};
  const sniffAnimated = (dataUrl) => {
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return false;
    const header = dataUrl.slice(0, comma).toLowerCase();
    if (header.indexOf("image/gif") >= 0) return true;   // GIF 一律保留原数据（GIF87a/89a）
    if (header.indexOf("image/avif") >= 0) {
      try {
        // AVIF 是 ISO BMFF：第 8-11 字节为 ftyp 主品牌，avis = 动图序列，avif = 静态
        const bytes = atob(dataUrl.slice(comma + 1, comma + 1 + 64));
        return bytes.length >= 12 && bytes.slice(8, 12) === "avis";
      } catch { return false; }
    }
    if (header.indexOf("image/webp") < 0) return false;
    try {
      // 动态 WebP 的 VP8X + ANIM chunk 位于文件头部，解码前 400 个 base64 字符足够判定
      const b64 = dataUrl.slice(comma + 1, comma + 1 + 400);
      return atob(b64).includes("ANIM");
    } catch { return false; }
  };

  // 多槽位持久化：storageKey 存数组；legacyKey（单主题旧格式）读取时自动迁移。
  // 自定义主题内嵌 MB 级 data URL，每次点击都 JSON.parse 整个数组代价不小：内存缓存一份，
  // saveCustoms 时同步更新，其他窗口改写 localStorage 时经 storage 事件失效。
  // 返回浅拷贝数组，防止调用方（含 window.__workbuddySkin.listCustoms）改动缓存本身
  let customsCache = null;
  const onStorage = (event) => {
    if (event.key === null || event.key === data.storageKey || event.key === data.legacyKey) customsCache = null;
  };
  window.addEventListener("storage", onStorage);
  const loadCustoms = () => {
    if (!customsCache) customsCache = readCustoms();
    return customsCache.slice();
  };
  const readCustoms = () => {
    let list = [];
    try {
      const parsed = JSON.parse(localStorage.getItem(data.storageKey) ?? "[]");
      if (Array.isArray(parsed)) list = parsed.map(normalizeTheme).filter(Boolean);
    } catch {}
    try {
      const legacy = JSON.parse(localStorage.getItem(data.legacyKey) ?? "null");
      if (legacy && legacy.dataUrl && legacy.colors) {
        legacy.id = data.customPrefix + "legacy";
        const normalized = normalizeTheme(legacy);
        if (normalized) list = [normalized, ...list];
        localStorage.setItem(data.storageKey, JSON.stringify(list));
        localStorage.removeItem(data.legacyKey);
      }
    } catch {}
    return list;
  };
  const saveCustoms = (list) => {
    // 先更新缓存：配额超限时本会话仍可用（与告警文案「本次生效但重启后不保留」一致）
    customsCache = list.slice();
    try { localStorage.setItem(data.storageKey, JSON.stringify(list)); }
    catch (error) { console.warn("WorkBuddy Skin：自定义主题占用超出 localStorage 配额，本次生效但重启后不保留", error); }
  };

  const slotsFullError = () => new Error("\\u81ea\\u5b9a\\u4e49\\u69fd\\u4f4d\\u5df2\\u6ee1\\uff08\\u6700\\u591a " + data.maxCustomSlots + " \\u4e2a\\uff09\\uff0c\\u8bf7\\u5148\\u5220\\u9664\\u4e00\\u4e2a\\u518d\\u4e0a\\u4f20");

  const importFromDataUrl = (dataUrl, name) => new Promise((resolve, reject) => {
    if (loadCustoms().length >= data.maxCustomSlots) {
      reject(slotsFullError());
      return;
    }
    const animated = sniffAnimated(dataUrl);
    // base64 长度 * 3/4 ≈ 原始字节数；动图不压缩直接持久化，必须卡上限
    if (animated && Math.floor((dataUrl.length - dataUrl.indexOf(",") - 1) * 3 / 4) > MAX_ANIMATED_BYTES) {
      reject(new Error("动图超过 3MB 上限（需存入 localStorage 以便重启后保留），请压缩后再试"));
      return;
    }
    const img = new Image();
    img.onload = () => {
      if (animated && Math.max(img.width, img.height) > MAX_ANIMATED_DIMENSION) {
        reject(new Error("动图分辨率过高（" + img.width + "×" + img.height + "，最长边限 " + MAX_ANIMATED_DIMENSION + "px），请缩小尺寸后再试"));
        return;
      }
      // canvas drawImage 对动图只取第一帧，正好用于取色
      const sample = document.createElement("canvas");
      sample.width = 48; sample.height = Math.max(1, Math.round(48 * img.height / img.width));
      sample.getContext("2d").drawImage(img, 0, 0, sample.width, sample.height);
      let heroUrl = dataUrl;
      if (!animated) {
        const scale = Math.min(1, 1600 / img.width);
        const full = document.createElement("canvas");
        full.width = Math.round(img.width * scale);
        full.height = Math.round(img.height * scale);
        full.getContext("2d").drawImage(img, 0, 0, full.width, full.height);
        heroUrl = full.toDataURL("image/webp", 0.8);
      }
      const theme = {
        id: data.customPrefix + Date.now().toString(36),
        name: name || "\\u6211\\u7684\\u56fe\\u7247",
        dataUrl: heroUrl,
        colors: extractPalette(sample),
        mode: "auto",
        ...(animated ? { kind: "animated" } : {}),
      };
      saveCustoms([...loadCustoms(), theme]);
      applyCustomTheme(theme);
      resolve(theme.colors);
    };
    img.onerror = () => reject(new Error("图片读取失败"));
    img.src = dataUrl;
  });

  // 视频导入：<video> 解码抽帧取色 + 生成海报帧，原始文件存 IndexedDB
  const importFromVideoFile = (file, name) => new Promise((resolve, reject) => {
    if (loadCustoms().length >= data.maxCustomSlots) {
      reject(slotsFullError());
      return;
    }
    if (file.size > MAX_VIDEO_BYTES) {
      reject(new Error("\\u89c6\\u9891\\u8d85\\u8fc7 " + Math.round(MAX_VIDEO_BYTES / 1048576) + "MB \\u4e0a\\u9650\\uff0c\\u8bf7\\u538b\\u7f29\\u6216\\u526a\\u8f91\\u540e\\u518d\\u8bd5"));
      return;
    }
    const url = URL.createObjectURL(file);
    const probe = document.createElement("video");
    probe.muted = true;
    probe.playsInline = true;
    probe.preload = "auto";
    // 探测用 <video> 用完即释放：撤销 blob URL 并卸载 src，及时回收解码器与文件句柄
    const releaseProbe = () => { URL.revokeObjectURL(url); probe.removeAttribute("src"); probe.load(); };
    const fail = (message) => { releaseProbe(); reject(new Error(message)); };
    probe.addEventListener("loadeddata", () => {
      // 跳过纯黑/纯白的片头帧，取 0.5s 处画面取色
      probe.currentTime = Math.min(0.5, (probe.duration || 1) / 2);
    });
    probe.addEventListener("seeked", () => {
      try {
        const w = probe.videoWidth, h = probe.videoHeight;
        if (!w || !h) throw new Error("no frame");
        const sample = document.createElement("canvas");
        sample.width = 48; sample.height = Math.max(1, Math.round(48 * h / w));
        sample.getContext("2d").drawImage(probe, 0, 0, sample.width, sample.height);
        // 海报帧限 640px 宽，保住 localStorage 配额
        const posterScale = Math.min(1, 640 / w);
        const poster = document.createElement("canvas");
        poster.width = Math.max(1, Math.round(w * posterScale));
        poster.height = Math.max(1, Math.round(h * posterScale));
        poster.getContext("2d").drawImage(probe, 0, 0, poster.width, poster.height);
        const theme = {
          id: data.customPrefix + Date.now().toString(36),
          name: name || "\\u6211\\u7684\\u76ae\\u80a4",
          kind: "video",
          poster: poster.toDataURL("image/webp", 0.72),
          colors: extractPalette(sample),
          mode: "auto",
        };
        releaseProbe();
        videoStore.put(theme.id, file).then(() => {
          saveCustoms([...loadCustoms(), theme]);
          applyCustomTheme(theme);
          resolve(theme.colors);
        }).catch((error) => reject(new Error("\\u89c6\\u9891\\u4fdd\\u5b58\\u5931\\u8d25\\uff1a" + (error?.message ?? error))));
      } catch {
        fail("\\u89c6\\u9891\\u89e3\\u7801\\u5931\\u8d25");
      }
    });
    probe.addEventListener("error", () => fail("\\u89c6\\u9891\\u8bfb\\u53d6\\u5931\\u8d25\\uff08\\u4ec5\\u652f\\u6301 Chromium \\u53ef\\u89e3\\u7801\\u7684 MP4/H.264\\uff09"));
    probe.src = url;
  });

  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = "image/png,image/jpeg,image/webp,image/gif,image/avif,video/mp4";
  picker.style.display = "none";
  picker.addEventListener("change", () => {
    const file = picker.files?.[0];
    if (!file) return;
    const name = file.name.replace(/\\.[a-z0-9]+$/i, "");
    const onError = (error) => alert("WorkBuddy Skin\\uff1a" + (error?.message ?? error));
    if (file.type === "video/mp4") {
      importFromVideoFile(file, name).catch(onError);
    } else {
      const reader = new FileReader();
      reader.onload = () => importFromDataUrl(reader.result, name).catch(onError);
      reader.readAsDataURL(file);
    }
    picker.value = "";
    closeDialog();
  });

  // 上传卡：虚线占位卡，永远在自定义网格末尾；新皮肤卡插到它前面
  const uploadCard = card("\\u81ea\\u5b9a\\u4e49\\u4e3b\\u9898", { swatch: "transparent", onPick: () => picker.click(), parent: customsSection.grid });
  uploadCard.style.borderStyle = "dashed";
  uploadCard.style.borderColor = "color-mix(in srgb, currentColor 30%, transparent)";
  uploadCard.addEventListener("mouseenter", () => { uploadCard.style.borderColor = "rgba(36,201,215,.9)"; });
  uploadCard.addEventListener("mouseleave", () => { uploadCard.style.borderColor = "color-mix(in srgb, currentColor 30%, transparent)"; });
  const plus = document.createElement("div");
  plus.textContent = "\\uff0b";
  plus.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:26px;color:color-mix(in srgb, currentColor 45%, transparent);";
  uploadCard.firstElementChild.appendChild(plus);

  for (const saved of loadCustoms()) ensureCustomRow(saved);
  updateSlots();

  button.addEventListener("click", () => {
    // 拖拽/双击结束后会尾随一个 click，吞掉它避免误开弹窗
    if (suppressClick) { suppressClick = false; return; }
    if (overlay.style.display === "none") openDialog();
    else closeDialog();
  });

  // ---- 右侧定位按钮：回到顶部 / 上一个提问 / 下一个提问 / 回到底部 ----
  // 参考 .workbuddy-themes 运行时的滚动按钮实现移植：WorkBuddy 未暴露稳定的会话
  // DOM 锚点，滚动容器与提问锚点都走启发式探测。容器按「可滚动 + 宽度≥40% 视口 +
  // 高度≥200 + 面积最大」挑选并缓存 500ms；提问锚点优先 data-role/class 启发式
  // （剔除嵌套命中、排除 assistant/bot 类名），兜底取容器最高子节点的直接子项
  const navRoot = document.createElement("div");
  // 位置锚定对话框（见 updateNavPlacement），right/bottom 初始值为探测失败时的兜底
  navRoot.style.cssText = "position:fixed;right:14px;bottom:96px;z-index:2147483000;display:none;flex-direction:column;align-items:center;gap:8px;user-select:none;-webkit-app-region:no-drag;app-region:no-drag;";

  let scrollBox = null;
  let scrollBoxCachedAt = 0;
  const findScrollBox = () => {
    const now = Date.now();
    // 缓存有效期内且节点仍在文档中直接复用；断开/过期才重新全量扫描
    if (scrollBox && scrollBox.isConnected && now - scrollBoxCachedAt < 500) return scrollBox;
    scrollBoxCachedAt = now;
    scrollBox = null;
    const preferred = document.querySelector(".messages-container");
    if (preferred && preferred.scrollHeight > preferred.clientHeight + 20) {
      scrollBox = preferred;
      return scrollBox;
    }
    let best = null;
    let bestArea = 0;
    const viewportWidth = window.innerWidth || 1200;
    for (const el of document.querySelectorAll("*")) {
      if (el.scrollHeight <= el.clientHeight + 20) continue;
      if (!/(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 0.4 * viewportWidth || rect.height < 200) continue;
      const area = rect.width * rect.height;
      if (area > bestArea) { bestArea = area; best = el; }
    }
    if (best) scrollBox = best;
    return scrollBox;
  };

  const USER_ANCHOR_SELECTOR = "[data-role=user],[data-author=user],[data-message-role=user],[data-from=user],[class*=user-message],[class*=message-user],[class*=message--user],[class*=is-user],[class*=--user],[class*=_user],[class*=human],[class*=-self],[class*=sender]";
  const findAnchors = (box) => {
    let anchors = Array.from(box.querySelectorAll(USER_ANCHOR_SELECTOR))
      .filter((el) => !/assistant|agent|\bai\b|bot|robot|menu|avatar|trigger|reply|answer|response/i.test(el.getAttribute("class") || ""));
    // 只留最外层命中：嵌套命中时丢弃被包含者，避免定位到同一条提问的内部碎片
    anchors = anchors.filter((el) => !anchors.some((other) => other !== el && other.contains(el)));
    anchors = anchors.filter((el) => el.getBoundingClientRect().height >= 8);
    if (anchors.length === 0) {
      // 兜底：容器最高子节点的直接子项（>=2 条才有定位意义），再退到通用消息类
      let tallest = null;
      let maxHeight = 0;
      for (const child of box.children) {
        if (child.scrollHeight > maxHeight) { maxHeight = child.scrollHeight; tallest = child; }
      }
      let candidates = tallest && tallest.children.length >= 2 ? Array.from(tallest.children) : [];
      if (candidates.length < 2) {
        const generic = box.querySelectorAll("[class*=message],[class*=msg],[class*=chat-item]");
        if (generic.length >= 2) candidates = Array.from(generic);
      }
      anchors = candidates.filter((el) => el.getBoundingClientRect().height >= 8);
    }
    return anchors.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  };

  // 元素在滚动容器坐标系里的纵向偏移（含当前滚动量）
  const offsetInBox = (box, el) => Math.round(el.getBoundingClientRect().top - (box.getBoundingClientRect().top - box.scrollTop));

  // rAF 三次缓出 420ms 平滑滚动；用户滚轮/触摸介入立即让出控制权（捕获阶段取消动画）
  let navAnim = 0;
  const cancelNavAnim = () => {
    if (!navAnim) return;
    cancelAnimationFrame(navAnim);
    navAnim = 0;
  };
  const smoothScrollTo = (box, targetTop) => {
    cancelNavAnim();
    const startTop = box.scrollTop;
    const startAt = performance.now();
    const easeOut = (t) => 1 - Math.pow(1 - t, 3);
    const step = () => {
      navAnim = 0;
      if (!box.isConnected) return;
      // 目标每帧重新夹取：流式输出使 scrollHeight 增长时，回到底部能跟随到底
      const max = Math.max(0, box.scrollHeight - box.clientHeight);
      const target = Math.max(0, Math.min(targetTop, max));
      const progress = Math.min(1, (performance.now() - startAt) / 420);
      box.scrollTop = startTop + (target - startTop) * easeOut(progress);
      if (progress < 1) navAnim = requestAnimationFrame(step);
      else box.scrollTop = target;
    };
    navAnim = requestAnimationFrame(step);
  };

  const NAV_TOLERANCE = 4;
  const scrollToEdge = (direction) => {
    const box = findScrollBox();
    if (!box) return;
    const max = Math.max(0, box.scrollHeight - box.clientHeight);
    smoothScrollTo(box, direction < 0 ? 0 : max);
  };
  const scrollToQuestion = (direction) => {
    const box = findScrollBox();
    if (!box) return;
    const anchors = findAnchors(box);
    const current = box.scrollTop;
    let target = null;
    if (direction < 0) {
      for (let i = anchors.length - 1; i >= 0; i -= 1) {
        if (offsetInBox(box, anchors[i]) < current - NAV_TOLERANCE) { target = anchors[i]; break; }
      }
    } else {
      for (const el of anchors) {
        if (offsetInBox(box, el) > current + NAV_TOLERANCE) { target = el; break; }
      }
    }
    if (target) smoothScrollTo(box, offsetInBox(box, target));
  };

  const navButton = (label, svgBody, onClick) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.style.cssText = "width:32px;height:32px;border-radius:50%;border:1px solid rgba(0,0,0,.12);background:rgba(255,255,255,.85);backdrop-filter:blur(10px);box-shadow:0 2px 8px rgba(0,0,0,.12);cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;color:#17344f;";
    // svgBody 为下方静态字面量，无用户输入，innerHTML 安全
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + svgBody + "</svg>";
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      try { onClick(); } catch (error) { logError("定位按钮点击处理失败", label, error); }
    });
    return btn;
  };

  navRoot.append(
    navButton("\u56de\u5230\u9876\u90e8", '<line x1="6" y1="4.5" x2="18" y2="4.5"></line><polyline points="7 12 12 7 17 12"></polyline><line x1="12" y1="7" x2="12" y2="19"></line>', () => scrollToEdge(-1)),
    navButton("\u4e0a\u4e00\u4e2a\u63d0\u95ee", '<polyline points="6 14 12 8 18 14"></polyline>', () => scrollToQuestion(-1)),
    navButton("\u4e0b\u4e00\u4e2a\u63d0\u95ee", '<polyline points="6 10 12 16 18 10"></polyline>', () => scrollToQuestion(1)),
    navButton("\u56de\u5230\u5e95\u90e8", '<line x1="12" y1="5" x2="12" y2="17"></line><polyline points="7 12 12 17 17 12"></polyline><line x1="6" y1="19.5" x2="18" y2="19.5"></line>', () => scrollToEdge(1)),
  );
  document.body.appendChild(navRoot);

  // 边界灰化：已在顶部时「回到顶部/上一个提问」无意义（上方没有更早的提问），
  // 底部同理；用 disabled 置灰（同时阻断点击），随滚动实时刷新
  const [navBtnTop, navBtnPrev, navBtnNext, navBtnBottom] = navRoot.children;
  const setNavEnabled = (btn, enabled) => {
    btn.disabled = !enabled;
    btn.style.opacity = enabled ? "1" : ".38";
    btn.style.cursor = enabled ? "pointer" : "default";
  };
  const updateNavEdges = (box) => {
    const max = Math.max(0, box.scrollHeight - box.clientHeight);
    const atTop = box.scrollTop <= NAV_TOLERANCE;
    const atBottom = box.scrollTop >= max - NAV_TOLERANCE;
    setNavEnabled(navBtnTop, !atTop);
    setNavEnabled(navBtnPrev, !atTop);
    setNavEnabled(navBtnNext, !atBottom);
    setNavEnabled(navBtnBottom, !atBottom);
  };

  // 显隐与定位：容器可滚才显示；scroll 捕获监听 + layoutObserver（见上）双路驱动，均按
  // rAF 合帧。位置锚定对话框（输入框）上方右侧——内容列会随消息布局漂移，输入框是
  // 会话页最稳定的地标；底边固定在输入框顶上方 12px，右缘与输入框右缘外侧 6px 对齐
  const findComposer = () => {
    let best = null;
    let bestWidth = 0;
    const viewportHeight = window.innerHeight || 800;
    for (const el of document.querySelectorAll("textarea,[contenteditable=true],[contenteditable=''],[class*=composer],[class*=chat-input],[class*=input-area]")) {
      const r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 20) continue;
      if (r.top < viewportHeight * 0.4) continue; // 输入框应在视口下半部
      if (r.width > bestWidth) { bestWidth = r.width; best = r; }
    }
    return best;
  };
  const updateNavPlacement = () => {
    const composer = findComposer();
    if (!composer) {
      navRoot.style.right = "14px";
      navRoot.style.bottom = "96px";
      return;
    }
    navRoot.style.right = Math.max(-6, Math.round(window.innerWidth - composer.right - 6)) + "px";
    const bottom = Math.round(window.innerHeight - composer.top + 12);
    // 上下限：不低于 8px（输入框贴底时），不高于视口高减菜单高（异常布局时防出顶）
    navRoot.style.bottom = Math.min(Math.max(8, bottom), window.innerHeight - 160) + "px";
  };
  let navUpdateQueued = false;
  const updateNavVisibility = () => {
    // 主页（欢迎页）不显示：欢迎区内容列可滚，会被 findScrollBox 兜底扫描误命中。
    // 反向门控——按主页地标（标题头/主页容器/空会话占位）判定，进入会话后这些节点消失
    if (document.querySelector(".wb-home-page,.wb-home-header,.colleague-chat-empty-profile")) {
      navRoot.style.display = "none";
      return;
    }
    const box = findScrollBox();
    const show = !!box && box.scrollHeight > box.clientHeight + 20;
    if (show) {
      updateNavPlacement();
      updateNavEdges(box);
    }
    navRoot.style.display = show ? "flex" : "none";
  };
  const scheduleNavUpdate = () => {
    if (navUpdateQueued) return;
    navUpdateQueued = true;
    requestAnimationFrame(() => { navUpdateQueued = false; updateNavVisibility(); });
  };
  document.addEventListener("scroll", scheduleNavUpdate, true);
  window.addEventListener("resize", scheduleNavUpdate);
  // 用户滚轮/触摸滚动时取消进行中的定位动画，避免与动画抢滚动条
  document.addEventListener("wheel", cancelNavAnim, true);
  document.addEventListener("touchstart", cancelNavAnim, true);
  scheduleNavUpdate();

  // 本轮注入的完整拆除：重复注入（脚本开头）与 pause（removeSkin）都会调用。
  // 只拆运行时资源，不动 <style>（重复注入复用同一节点、pause 由 removeSkin 自行移除）；
  // 解除明暗钉住后类与属性的所有权还给应用
  window[${JSON.stringify(TEARDOWN_GLOBAL)}] = () => {
    // 先断自愈观察者再移除 root：observer 回调是微任务，若不先 disconnect
    // （同时丢弃已排队的变更记录），下面的 root.remove() 会在 teardown 结束后被重挂回去
    reviveObserver.disconnect();
    layoutObserver.disconnect();
    modeObserver.disconnect();
    pinnedDark = null;
    cancelNavAnim();
    window.removeEventListener("resize", scheduleReposition);
    window.removeEventListener("resize", scheduleNavUpdate);
    window.removeEventListener("storage", onStorage);
    document.removeEventListener("keydown", onEscKey, true);
    document.removeEventListener("scroll", scheduleNavUpdate, true);
    document.removeEventListener("wheel", cancelNavAnim, true);
    document.removeEventListener("touchstart", cancelNavAnim, true);
    navRoot.remove();
    teardownThemeJs();
    releaseVideo();
    releaseHeroBlob();
    for (const url of videoUrlCache.values()) URL.revokeObjectURL(url);
    videoUrlCache.clear();
    videoStore.close();
    root.remove();
    if (window.__workbuddySkinLayoutObserver === layoutObserver) delete window.__workbuddySkinLayoutObserver;
    if (window.__workbuddySkinReviveObserver === reviveObserver) delete window.__workbuddySkinReviveObserver;
    delete window.__workbuddySkin;
    delete window[${JSON.stringify(TEARDOWN_GLOBAL)}];
  };

  root.append(button, overlay, picker);
  document.body.appendChild(root);
  // 挂载后 offsetWidth 才有效：持久化坐标此时再做一次真实尺寸的视口夹取
  if (customPos) applyCustomPos();

  // 自愈重挂：Slate/React 整树重建（路由切换、流式渲染根替换等）可能把挂在 body
  // 末尾的菜单根节点或 head 里的 <style> 一并移除，表现为「主题/按钮突然消失」。
  // 观察 body/head 的直接子节点（两个节点都是直接子节点，无需 subtree——subtree 会
  // 在流式输出时高频回调），节点脱离 document 即重挂。重挂的是同一批节点，
  // 闭包状态（rows/panel/选中主题/视频层）全部保留。重挂本身会再触发一次回调，
  // 但此时 isConnected 已为 true，空转收敛。
  const reviveObserver = new MutationObserver(() => {
    if (!style.isConnected) document.head.appendChild(style);
    if (!root.isConnected) document.body.appendChild(root);
    if (!navRoot.isConnected) document.body.appendChild(navRoot);
  });
  reviveObserver.observe(document.head, { childList: true });
  reviveObserver.observe(document.body, { childList: true });
  // 仍挂到 window：回退到旧版本注入时，旧脚本据此断开本轮观察者（同 layoutObserver）
  window.__workbuddySkinReviveObserver = reviveObserver;
  if (data.activeId === null) clearTheme();
  else setTheme(data.activeId);

  // 供脚本化调用与测试：window.__workbuddySkin.importFromDataUrl(dataUrl, name)
  window.__workbuddySkin = {
    importFromDataUrl, importFromVideoFile, setTheme, clearTheme, setNative, deleteCustom, listCustoms: loadCustoms,
    applyCustom: (id) => { const saved = loadCustoms().find((theme) => theme.id === id); if (saved) applyCustomTheme(saved); },
  };
  return true;
})()`;
}
