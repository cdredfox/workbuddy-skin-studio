// WorkBuddy 皮肤 CSS 生成
// 基于实测：WorkBuddy renderer 的 body[data-application-name=workbuddy] 上有完整的
// --cb-* 设计变量系统（60+ 个），override 它们即可全局换色；#root 作背景图层。
// 不使用 CSS module 哈希类名（._grid_xxx），只用稳定锚点。

const DEFAULT_COLORS = {
  accent: "#24c9d7",
  secondary: "#ef8fd3",
  surface: "#f7fbff",
  text: "#17344f",
};

function color(value, fallback) {
  const result = value ?? fallback;
  if (!/^#[0-9a-f]{3,8}$/i.test(result)) throw new Error(`无效主题颜色：${result}`);
  return result;
}

function copy(value, fallback = "") {
  return JSON.stringify(typeof value === "string" ? value : fallback);
}

// ---- 共享模板片段：图片主题（buildSkinCss）与配色主题（buildPaletteCss）同源，防漂移 ----

// --cb-* 设计变量覆盖块：WorkBuddy renderer 的全局换色核心（60+ 变量，accent/secondary/
// surface/text 四色驱动）。配色主题无 hero 底图，同样以此块为换色基座
function buildVariableOverrides(colors) {
  return `body[data-application-name=workbuddy] {
  --wb-accent: ${colors.accent};
  --wb-secondary: ${colors.secondary};
  --wb-surface: ${colors.surface};
  --wb-text: ${colors.text};

  /* 背景 */
  --cb-bg-primary: var(--wb-surface) !important;
  --cb-bg-secondary: color-mix(in srgb, var(--wb-surface) 94%, transparent) !important;
  --cb-panel-bg-primary: color-mix(in srgb, var(--wb-surface) 88%, transparent) !important;
  --cb-team-member-card-background: color-mix(in srgb, var(--wb-surface) 88%, transparent) !important;

  /* 文字 */
  --cb-text-primary: var(--wb-text) !important;
  --cb-text-secondary: color-mix(in srgb, var(--wb-text) 70%, transparent) !important;
  --cb-text-disabled: color-mix(in srgb, var(--wb-text) 42%, transparent) !important;
  --cb-text-link: var(--wb-accent) !important;
  --cb-text-error-active: var(--wb-accent) !important;

  /* VS Code 主题色包装 */
  --cb-vscode-editor-background: var(--wb-surface) !important;
  --cb-vscode-sideBar-background: color-mix(in srgb, var(--wb-surface) 90%, transparent) !important;
  --cb-vscode-foreground: var(--wb-text) !important;
  --cb-vscode-editor-foreground: var(--wb-text) !important;
  --cb-vscode-descriptionForeground: color-mix(in srgb, var(--wb-text) 70%, transparent) !important;
  --cb-vscode-titleBar-activeBackground: var(--wb-accent) !important;
  --cb-vscode-titleBar-activeForeground: #ffffff !important;
  --cb-vscode-titleBar-inactiveBackground: color-mix(in srgb, var(--wb-accent) 80%, var(--wb-surface)) !important;
  --cb-vscode-titleBar-inactiveForeground: color-mix(in srgb, #ffffff 70%, transparent) !important;
  --cb-titlebar-control-hover-background: color-mix(in srgb, var(--wb-accent) 16%, transparent) !important;
  --cb-vscode-input-background: color-mix(in srgb, var(--wb-surface) 88%, transparent) !important;
  --cb-vscode-dropdown-background: color-mix(in srgb, var(--wb-surface) 94%, transparent) !important;
  --cb-vscode-list-hoverBackground: color-mix(in srgb, var(--wb-accent) 16%, transparent) !important;
  --cb-vscode-toolbar-hoverBackground: color-mix(in srgb, var(--wb-accent) 16%, transparent) !important;
  --cb-vscode-scrollbarSlider-background: color-mix(in srgb, var(--wb-accent) 30%, transparent) !important;
  --cb-vscode-scrollbarSlider-hoverBackground: color-mix(in srgb, var(--wb-accent) 50%, transparent) !important;
  --cb-vscode-textLink-foreground: var(--wb-accent) !important;
  --cb-vscode-widget-border: color-mix(in srgb, var(--wb-accent) 45%, transparent) !important;
  --cb-vscode-panel-border: color-mix(in srgb, var(--wb-accent) 30%, transparent) !important;

  /* 侧边栏桥接变量：.conversation-section-label 等 sticky 分组标题读
     --wb-sidebar-bg → --cb-sidebar-bg → --vscode-sideBar-background；
     其 dark 值由 body[data-vscode-theme-name="IDE Night"] 等作用域驱动，
     皮肤模式下可能被应用原生主题设置顶住，这里直接钉为皮肤表面色兜底 */
  --wb-sidebar-bg: var(--wb-surface) !important;
  --cb-sidebar-bg: var(--wb-surface) !important;

  /* 按钮 */
  --cb-button-dark-background: var(--wb-accent) !important;
  --cb-button-dark-foreground: #ffffff !important;
  --cb-button-dark-hover-background: color-mix(in srgb, var(--wb-accent) 85%, #000000) !important;
  --cb-vscode-button-background: var(--wb-accent) !important;
  --cb-vscode-button-foreground: #ffffff !important;
  --cb-vscode-button-hoverBackground: color-mix(in srgb, var(--wb-accent) 85%, #000000) !important;

  /* 描边 */
  --cb-stroke-secondary: color-mix(in srgb, var(--wb-accent) 45%, transparent) !important;
  --cb-markdown-hr-border-color: color-mix(in srgb, var(--wb-accent) 30%, transparent) !important;
}`;
}

// 组件点缀块：全部 var() 引用、不依赖 hero 底图，图片/配色主题共用——
// 「为你推荐」推荐条磨砂化、首页快捷 chips 透化、详情面板磨砂、
// 首页主标题 accent→secondary 渐变、左上角 WorkBuddy 双色字标
function buildComponentAccents() {
  return `/* 「为你推荐」技能推荐条（.wb-skill-rec-bar，挂在 .wb-home-composer__skill-recommend 下）：
   原生浅色 background:var(--wb-home-bg-secondary,#fafafa) —— 不透明白条 flex:1 横贯 composer，
   ::before 还在条上方叠 32px 同色渐变托底，壁纸皮肤上呈整块白版、右端硬边；
   且该条读的是 --wb-home-bg-secondary / --wb-color-palette-gray-3，不在 --cb-* 覆盖范围内。
   改为磨砂半透明（与侧边栏同一语言），chips 同步透化，全 var() 引用随主题取色自适应 */
.wb-skill-rec-bar {
  background: color-mix(in srgb, var(--wb-surface) 55%, transparent) !important;
  backdrop-filter: blur(14px) saturate(1.1);
}
.wb-skill-rec-bar::before {
  background: linear-gradient(to bottom, transparent, color-mix(in srgb, var(--wb-surface) 55%, transparent)) !important;
}
.wb-skill-rec-bar__label,
.wb-skill-rec-bar__placeholder-text,
.wb-skill-rec-bar__empty-text {
  color: color-mix(in srgb, var(--wb-text) 78%, transparent) !important;
  text-shadow: 0 1px 6px var(--wb-surface);
}
.wb-skill-rec-chip {
  background: color-mix(in srgb, var(--wb-surface) 62%, transparent) !important;
  color: var(--wb-text) !important;
  border: 1px solid color-mix(in srgb, var(--wb-accent) 32%, transparent) !important;
  backdrop-filter: blur(10px);
}
.wb-skill-rec-chip:hover {
  background: color-mix(in srgb, var(--wb-accent) 22%, var(--wb-surface)) !important;
}

/* 首页快捷 chips（quick-actions 模式）与左右滚动渐隐、翻页箭头：
   浅色原生分别是 #fff 底、#fff 硬编码渐变、#fff 箭头底，壁纸上同属一类白块 */
.wb-home-composer__chips .quick-actions__item,
.wb-home-composer__chip {
  background: color-mix(in srgb, var(--wb-surface) 62%, transparent) !important;
  color: var(--wb-text) !important;
  border-color: color-mix(in srgb, var(--wb-accent) 32%, transparent) !important;
  backdrop-filter: blur(10px);
}
.quick-actions--fade-right::after {
  background: linear-gradient(270deg, color-mix(in srgb, var(--wb-surface) 72%, transparent) 40%, transparent) !important;
}
.quick-actions--fade-left::before {
  background: linear-gradient(90deg, color-mix(in srgb, var(--wb-surface) 72%, transparent) 40%, transparent) !important;
}
.quick-actions__arrow {
  background: color-mix(in srgb, var(--wb-surface) 72%, transparent) !important;
  color: var(--wb-text) !important;
}

/* 详情面板半透明磨砂 */
[data-view-id=detail-panel] {
  background: color-mix(in srgb, var(--wb-surface) 88%, transparent) !important;
  backdrop-filter: blur(18px) saturate(1.08);
}

/* 首页/空会话主标题：主题色渐变文字（accent→secondary，随主题/自定义取色自适应）。
   不用 text-shadow 而用 filter:drop-shadow —— 透明填充文字上 text-shadow 会透过字形
   显影发脏，drop-shadow 按字形 alpha 描光晕，繁忙壁纸上依然可读 */
.wb-home-header__title,
.claw-agent-chat-pane .colleague-chat-empty-profile__title {
  background: linear-gradient(135deg, var(--wb-accent), var(--wb-secondary)) !important;
  -webkit-background-clip: text !important;
  background-clip: text !important;
  color: transparent !important;
  -webkit-text-fill-color: transparent !important;
  font-weight: 750 !important;
  filter: drop-shadow(0 1px 6px var(--wb-surface));
}

/* 左上角 WorkBuddy 字标变身（参照 TDP 的双色 SVG 字标）：硬切渐变实现双色——
   "Work" 用文本色、"Buddy" 用 accent（4/9 字符 ≈ 44% 处硬切）。全 var() 引用，
   自定义皮肤随上传图片取色自动适配；无需 SVG 资源，避免哨兵色值在 data URL
   编码后替换不到的坑 */
.conversation-list-logo .logo-workbuddy-title {
  background: linear-gradient(90deg, var(--wb-text) 0 44%, var(--wb-accent) 44% 100%) !important;
  -webkit-background-clip: text !important;
  background-clip: text !important;
  color: transparent !important;
  -webkit-text-fill-color: transparent !important;
  font-weight: 800 !important;
  letter-spacing: -.4px;
}`;
}

export function buildSkinCss({ theme, heroDataUrl }) {
  if (!/^data:image\/(?:png|jpeg|webp|gif|avif);base64,[a-z0-9+/=]+$/i.test(heroDataUrl)) {
    throw new Error("hero 必须是本地 PNG、JPEG、WebP、GIF 或 AVIF 数据");
  }
  const colors = {
    accent: color(theme.colors?.accent, DEFAULT_COLORS.accent),
    secondary: color(theme.colors?.secondary, DEFAULT_COLORS.secondary),
    surface: color(theme.colors?.surface, DEFAULT_COLORS.surface),
    text: color(theme.colors?.text, DEFAULT_COLORS.text),
  };
  const id = String(theme.id ?? "custom").replace(/[^a-z0-9_-]/gi, "");

  return `/* WORKBUDDY_SKIN:${id} */
${buildVariableOverrides(colors)}

#root {
  color: var(--wb-text) !important;
  /* 左遮罩收窄降强度：只托住侧边栏宽度（0→14%），72% 强度，30% 处全透明；
     下遮罩收窄到 85%→100%，强度降到 50%，四周大面积透出壁纸 */
  background:
    linear-gradient(90deg, color-mix(in srgb, var(--wb-surface) 72%, transparent) 0 14%, transparent 30%),
    linear-gradient(180deg, transparent 0 70%, color-mix(in srgb, var(--wb-surface) 50%, transparent) 85% 100%),
    url(${JSON.stringify(heroDataUrl)}) right center / cover no-repeat fixed !important;
}

/* 关键：teams-container 是 #root 直接子层，默认有不透明灰底，会完全盖住背景图 */
.teams-container,
.teams-container.is-mac {
  background: transparent !important;
}

/* 滚动层与 grid 容器同样带不透明底色（teams-grid-scroll-content 为纯色 rgb(20,20,20)；
   gridView 容器是 CSS module 哈希类，底色来自 --cb-panel-* 变量）。
   用类名子串匹配规避构建哈希；必须放在 [data-view-id] 系列规则之前，
   使 sidebar 磨砂 / main-content 渐变在同优先级下靠后胜出 */
.teams-grid-scroll-content,
[class*=gridView] {
  background: transparent !important;
}

/* 所有 grid 项容器透明，让 #root 背景图大面积透出 */
[data-view-id] {
  background: transparent !important;
}

/* 内容区内的子层也透明（否则会盖住背景图和磨砂层） */
.conversation-list,
.main-content,
.main-content--welcome,
.conversation-shell,
.sidebar-next {
  background: transparent !important;
}

/* 侧边栏磨砂玻璃（覆盖上面的 transparent）；强度降到 78%，让更多壁纸透出 */
[data-view-id=sidebar] {
  background: color-mix(in srgb, var(--wb-surface) 78%, transparent) !important;
  border-right: 1px solid color-mix(in srgb, var(--wb-accent) 45%, transparent) !important;
  backdrop-filter: blur(20px) saturate(1.12);
}

/* 主内容区：顶部透出底图，底部轻微渐变保证内容可读（与 #root 下遮罩同步收窄降强度） */
[data-view-id=main-content] {
  background: linear-gradient(180deg, transparent 0 70%, color-mix(in srgb, var(--wb-surface) 50%, transparent) 100%) !important;
}

/* 新建任务/首页路由（5.7.x 起独立的 main.wb-home-route，不走 [data-view-id] 结构）：
   默认不透明深底 rgb(20,20,20)，会完全盖住 #root 背景图，处理同 main-content */
.wb-home-route {
  background: linear-gradient(180deg, transparent 0 70%, color-mix(in srgb, var(--wb-surface) 50%, transparent) 100%) !important;
}

${buildComponentAccents()}

/* brand 文案（copy 为空时不显示） */
#root::before {
  position: fixed;
  z-index: 20;
  top: 60px;
  left: max(300px, 22vw);
  content: ${copy(theme.copy?.brand)};
  color: var(--wb-accent);
  font: 800 clamp(16px, 2vw, 30px)/1.2 ui-rounded, system-ui;
  /* 无左遮罩后文字直压壁纸：双层 surface 色光晕托底，深浅主题自适应 */
  text-shadow: 0 0 8px var(--wb-surface), 0 2px 12px var(--wb-surface);
  pointer-events: none;
}

/* headline 文案 */
#root::after {
  position: fixed;
  z-index: 20;
  top: 104px;
  left: max(300px, 22vw);
  max-width: 42vw;
  content: ${copy(theme.copy?.headline)};
  color: var(--wb-text);
  font: 750 clamp(18px, 2.7vw, 42px)/1.15 ui-rounded, system-ui;
  text-shadow: 0 0 8px var(--wb-surface), 0 2px 14px var(--wb-surface);
  pointer-events: none;
}
${theme.copy?.tagline ? `
/* 主题标语（仅 copy.tagline 配置时输出，自定义皮肤 copy 为 null 不注入文案） */
.wb-home-header::after {
  content: ${copy(theme.copy.tagline)} !important;
  display: block !important;
  width: fit-content;
  margin: 10px auto 2px;
  background: linear-gradient(90deg, var(--wb-accent), var(--wb-secondary));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  -webkit-text-fill-color: transparent;
  font: 600 15px/1.5 ui-rounded, system-ui;
  letter-spacing: .3px;
  filter: drop-shadow(0 1px 4px var(--wb-surface));
}
` : ""}`;
}

// 配色主题（group:"palette"，无图纯配色移植）：与图片主题共享 --cb-* 变量覆盖块与
// 组件点缀块，区别在容器层——无 hero 底图，根层与各容器用表面色实底/浮层，
// 各主题的视觉签名（主内容区渐变等）由主题目录 skin.css 装饰层叠加（注入器前置拼接本基座）
export function buildPaletteCss({ theme }) {
  const colors = {
    accent: color(theme.colors?.accent, DEFAULT_COLORS.accent),
    secondary: color(theme.colors?.secondary, DEFAULT_COLORS.secondary),
    surface: color(theme.colors?.surface, DEFAULT_COLORS.surface),
    text: color(theme.colors?.text, DEFAULT_COLORS.text),
  };
  const id = String(theme.id ?? "palette").replace(/[^a-z0-9_-]/gi, "");

  return `/* WORKBUDDY_PALETTE:${id} */
${buildVariableOverrides(colors)}

/* 配色主题无壁纸：#root 实底表面色；容器逐层透明透出根层，构成均匀底色 */
#root {
  background: var(--wb-surface) !important;
  color: var(--wb-text) !important;
}

.teams-container,
.teams-container.is-mac {
  background: var(--wb-surface) !important;
}

/* teams-grid-scroll-content / gridView 自带不透明底色（rgb(20,20,20)），透化让根层透出 */
.teams-grid-scroll-content,
[class*=gridView] {
  background: transparent !important;
}

[data-view-id] {
  background: transparent !important;
}

.conversation-list,
.main-content,
.main-content--welcome,
.conversation-shell,
.sidebar-next {
  background: transparent !important;
}

/* 侧边栏浮层：surface 混入少量文字色——文字色恒为表面的对立极，
   深色主题得微亮浮层、浅色主题得微深浮层，双向自适应无需分模式 */
[data-view-id=sidebar] {
  background: color-mix(in srgb, var(--wb-surface) 92%, var(--wb-text) 5%) !important;
  border-right: 1px solid color-mix(in srgb, var(--wb-accent) 45%, transparent) !important;
}

/* 首页路由默认不透明深底，配色主题下钉为表面色（签名渐变由装饰层叠加） */
.wb-home-route {
  background: var(--wb-surface) !important;
}

/* 侧边栏选中态：accent 微光，让主题色在导航层可见（替代原生灰块） */
[data-view-id=sidebar] [aria-selected="true"],
[data-view-id=sidebar] [data-state="active"] {
  background: color-mix(in srgb, var(--wb-accent) 16%, transparent) !important;
}

/* 底部输入框容器（cr-input-* 设计系统类）：不读 --cb-vscode-input-background，
   原生明暗模式下都是固定灰底，配色主题下与表面色脱节；表面色混入少量文字色抬升 */
.cr-input-container {
  background: color-mix(in srgb, var(--wb-surface) 90%, var(--wb-text) 4%) !important;
  border-color: color-mix(in srgb, var(--wb-accent) 30%, transparent) !important;
}

${buildComponentAccents()}
`;
}
