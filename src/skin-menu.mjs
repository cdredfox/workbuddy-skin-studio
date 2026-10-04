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
      css: entry.css,
      kind: entry.kind === "video" || entry.kind === "animated" ? entry.kind : "image",
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

  // 水平位置锚定原生按钮行（.workbuddy-topbar-actions）右缘：右侧详情栏打开时
  // 主 topbar 右缘左移，固定 right:7px 会把按钮甩进面板区域；跟随 actions 则始终
  // 停在「第一行按钮下方」。右缘偏移 = 行右缘 + 5px（与既有视觉一致，常态即 right:7px）。
  // actions 不存在时回落视口右缘 7px。仅调 right，root 始终挂 body，无挂载生命周期问题
  let cachedRight = null;
  const reposition = () => {
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
  // 且读布局落在浏览器本就要做布局的帧内，不再在每次变更后额外触发一次 reflow
  let repositionQueued = false;
  const scheduleReposition = () => {
    if (repositionQueued) return;
    repositionQueued = true;
    requestAnimationFrame(() => { repositionQueued = false; reposition(); });
  };
  const layoutObserver = new MutationObserver(scheduleReposition);
  layoutObserver.observe(document.body, { childList: true, subtree: true });
  // 仍挂到 window：回退到旧版本注入时，旧脚本据此断开本轮观察者
  window.__workbuddySkinLayoutObserver = layoutObserver;
  window.addEventListener("resize", scheduleReposition);
  reposition();
  // actions 行可能晚于本脚本挂载，下一帧再校准一次
  scheduleReposition();

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "\\u{1F3A8}";
  button.title = "WorkBuddy Skin Studio";
  // 无底图：去掉圆底/描边/阴影/磨砂，只留色盘图标本体；line-height 保证垂直居中
  button.style.cssText = "display:block;margin-left:auto;width:38px;height:38px;border:0;background:transparent;cursor:pointer;font-size:19px;padding:0;line-height:38px;";

  const panel = document.createElement("div");
  // absolute 相对 root 定位：挂进工具栏时面板从按钮正下方展开，且不再撑大 root
  panel.style.cssText = "display:none;position:absolute;top:calc(100% + 8px);right:0;min-width:200px;padding:6px;border-radius:12px;border:1px solid rgba(0,0,0,.1);background:rgba(255,255,255,.94);backdrop-filter:blur(16px);box-shadow:0 10px 30px rgba(0,0,0,.18);color:#17344f;-webkit-app-region:no-drag;app-region:no-drag;";

  const rows = new Map();
  const paint = (id) => {
    for (const [rowId, row] of rows) {
      row.style.background = rowId === id ? "rgba(36,201,215,.16)" : "transparent";
      row.style.fontWeight = rowId === id ? "700" : "500";
    }
  };
  const row = (label, dotColor, onPick, before) => {
    const item = document.createElement("div");
    item.style.cssText = "display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;cursor:pointer;";
    const dot = document.createElement("span");
    dot.style.cssText = "width:10px;height:10px;border-radius:50%;flex:none;background:" + dotColor + ";";
    const text = document.createElement("span");
    text.textContent = label;
    item.append(dot, text);
    item.addEventListener("mouseenter", () => { if (item.style.fontWeight !== "700") item.style.background = "rgba(0,0,0,.05)"; });
    item.addEventListener("mouseleave", () => paint(document.documentElement.dataset.workbuddySkin ?? null));
    // 兜底：onPick（切换/上传入口）任何同步异常都不允许打断菜单，统一落日志
    item.addEventListener("click", () => {
      try { onPick(item); } catch (error) { logError("主题列表项点击处理失败", label, error); }
    });
    if (before) panel.insertBefore(item, before); else panel.appendChild(item);
    return item;
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
    } catch (error) {
      logError("切换主题失败", id, error);
    }
  };
  const clearTheme = () => {
    try {
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

  // 视频/动图主题在列表行尾加标注（汉字走双反斜杠 unicode 转义，模板内不直接写中文）
  const KIND_BADGE = { video: "\\u52a8\\u6001", animated: "\\u52a8\\u56fe" };
  const kindBadge = (kind) => {
    const label = KIND_BADGE[kind];
    if (!label) return null;
    const tag = document.createElement("span");
    tag.textContent = label;
    tag.style.cssText = "flex:none;margin-left:auto;font-size:10px;line-height:14px;padding:0 4px;border-radius:4px;border:1px solid rgba(0,0,0,.18);color:rgba(0,0,0,.5);";
    return tag;
  };

  for (const theme of data.themes) {
    const item = row(theme.name, theme.accent, () => { setTheme(theme.id); panel.style.display = "none"; });
    const badge = kindBadge(theme.kind);
    if (badge) item.appendChild(badge);
    rows.set(theme.id, item);
  }

  // ---- 自定义皮肤：本地选图/选视频 -> 压缩 -> 取色 -> 生成 CSS -> 持久化（多槽位） ----
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
  };
  const ensureCustomRow = (theme) => {
    if (rows.has(theme.id)) return;
    const customRow = row(theme.name, theme.colors.accent, () => {
      applyCustomTheme(loadCustoms().find((saved) => saved.id === theme.id) ?? theme);
      panel.style.display = "none";
    }, uploadRow);
    const text = customRow.querySelector("span + span");
    text.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    // 自定义视频/动图主题同样加标注（text 已 flex:1，badge 的 margin-left:auto 无副作用）
    const badge = kindBadge(theme.kind);
    if (badge) customRow.appendChild(badge);
    // 明暗模式三选：自（自动按主色亮度）→ 浅 → 深 循环，持久化；正应用此主题时立即重渲染
    const MODE_SEQUENCE = ["auto", "light", "dark"];
    const MODE_LABEL = { auto: "\\u81ea", light: "\\u6d45", dark: "\\u6df1" };
    const MODE_TITLE = { auto: "\\u81ea\\u52a8\\uff08\\u6309\\u4e3b\\u8272\\u660e\\u6697\\uff09", light: "\\u6d45\\u8272", dark: "\\u6df1\\u8272" };
    const currentMode = () => (theme.mode === "light" || theme.mode === "dark" ? theme.mode : "auto");
    const modeBtn = document.createElement("span");
    modeBtn.style.cssText = "flex:none;min-width:18px;height:18px;line-height:17px;text-align:center;border-radius:5px;color:rgba(0,0,0,.55);font-size:11px;border:1px solid rgba(0,0,0,.2);cursor:pointer;padding:0 2px;box-sizing:border-box;";
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
    customRow.appendChild(modeBtn);
    const del = document.createElement("span");
    del.textContent = "\\u00d7";
    del.title = "\\u5220\\u9664\\u81ea\\u5b9a\\u4e49\\u4e3b\\u9898";
    del.style.cssText = "flex:none;width:18px;height:18px;line-height:18px;text-align:center;border-radius:50%;color:rgba(0,0,0,.45);font-size:14px;";
    del.addEventListener("mouseenter", () => { del.style.background = "rgba(220,60,60,.15)"; del.style.color = "#c03030"; });
    del.addEventListener("mouseleave", () => { del.style.background = "transparent"; del.style.color = "rgba(0,0,0,.45)"; });
    del.addEventListener("click", (event) => { event.stopPropagation(); deleteCustom(theme.id); });
    customRow.appendChild(del);
    rows.set(theme.id, customRow);
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
    panel.style.display = "none";
  });

  const uploadRow = row("\\uff0b \\u81ea\\u5b9a\\u4e49\\u76ae\\u80a4", "rgba(36,201,215,.9)", () => picker.click());
  uploadRow.style.borderTop = "1px solid rgba(0,0,0,.08)";

  const native = row("\\u539f\\u751f\\u754c\\u9762", "rgba(0,0,0,.24)", () => { clearTheme(); panel.style.display = "none"; });
  rows.set(null, native);

  for (const saved of loadCustoms()) ensureCustomRow(saved);

  button.addEventListener("click", () => {
    panel.style.display = panel.style.display === "none" ? "block" : "none";
  });

  // 点击弹窗外部自动收起：capture 阶段监听，即使页面组件 stopPropagation 也能收到；
  // root 涵盖按钮/面板/文件选择器，点击其内部不关闭
  const onOutsideMouseDown = (event) => {
    if (panel.style.display === "none") return;
    if (!root.contains(event.target)) panel.style.display = "none";
  };
  document.addEventListener("mousedown", onOutsideMouseDown, true);

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
    window.removeEventListener("resize", scheduleReposition);
    window.removeEventListener("storage", onStorage);
    document.removeEventListener("mousedown", onOutsideMouseDown, true);
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

  root.append(button, panel, picker);
  document.body.appendChild(root);

  // 自愈重挂：Slate/React 整树重建（路由切换、流式渲染根替换等）可能把挂在 body
  // 末尾的菜单根节点或 head 里的 <style> 一并移除，表现为「主题/按钮突然消失」。
  // 观察 body/head 的直接子节点（两个节点都是直接子节点，无需 subtree——subtree 会
  // 在流式输出时高频回调），节点脱离 document 即重挂。重挂的是同一批节点，
  // 闭包状态（rows/panel/选中主题/视频层）全部保留。重挂本身会再触发一次回调，
  // 但此时 isConnected 已为 true，空转收敛。
  const reviveObserver = new MutationObserver(() => {
    if (!style.isConnected) document.head.appendChild(style);
    if (!root.isConnected) document.body.appendChild(root);
  });
  reviveObserver.observe(document.head, { childList: true });
  reviveObserver.observe(document.body, { childList: true });
  // 仍挂到 window：回退到旧版本注入时，旧脚本据此断开本轮观察者（同 layoutObserver）
  window.__workbuddySkinReviveObserver = reviveObserver;
  if (data.activeId === null) clearTheme();
  else setTheme(data.activeId);

  // 供脚本化调用与测试：window.__workbuddySkin.importFromDataUrl(dataUrl, name)
  window.__workbuddySkin = {
    importFromDataUrl, importFromVideoFile, setTheme, clearTheme, deleteCustom, listCustoms: loadCustoms,
    applyCustom: (id) => { const saved = loadCustoms().find((theme) => theme.id === id); if (saved) applyCustomTheme(saved); },
  };
  return true;
})()`;
}
