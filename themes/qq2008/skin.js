// QQ 2008 交互行为：音效（消息/失败/敲门）+ 企鹅挂件（移植自旧 runtime.js）。
// 本文件作为函数体在主题激活时执行（new Function），返回值是拆除函数。
// "./qq-*.wav|mp3" 等相对资源会在注入前被替换为 data URL，渲染进程内自包含。
return (() => {
  // ---- 音效：localStorage 键与旧项目一致（WORKBUDDY_THEME_SOUND_ENABLED/VOLUME）----
  const SOUND_ENABLED_KEY = "WORKBUDDY_THEME_SOUND_ENABLED";
  const SOUND_VOLUME_KEY = "WORKBUDDY_THEME_SOUND_VOLUME";
  const THROTTLE_MS = 1200;
  const messageSound = new Audio("./qq-message.wav");
  const failureSound = new Audio("./qq-failure.wav");
  const knockSound = new Audio("./qq-knock.mp3");
  messageSound.preload = "auto";
  failureSound.preload = "auto";
  knockSound.preload = "auto";
  let lastPlayAt = 0;

  const soundEnabled = () => {
    try { return localStorage.getItem(SOUND_ENABLED_KEY) !== "false"; } catch { return true; }
  };
  const soundVolume = () => {
    try {
      const raw = localStorage.getItem(SOUND_VOLUME_KEY);
      if (raw === null) return 0.8;
      const value = Number(raw);
      return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.8;
    } catch { return 0.8; }
  };
  const play = (audio) => {
    if (!soundEnabled()) return;
    const now = Date.now();
    if (now - lastPlayAt < THROTTLE_MS) return;
    lastPlayAt = now;
    for (const item of [messageSound, failureSound, knockSound]) {
      item.pause();
      item.currentTime = 0;
    }
    audio.volume = soundVolume();
    // 自动播放策略：页面尚无用户手势时 play() 会被拒，降级为警告（与旧行为一致）
    audio.play().catch((error) => console.warn("[workbuddy-skin] 音频播放失败，可能未获权限。", error));
  };

  // ---- 会话状态机：卡片状态从 working/pending 跃迁到 completed/failed 时播音 ----
  const ACTIVE_STATES = new Set(["working", "pending"]);
  const statusOf = (card) => {
    if (!(card instanceof HTMLElement)) return "unknown";
    if (card.querySelector('.status-error, [class*="_trailingStatus_"] path[fill="#F64041"]')) return "failed";
    if (card.querySelector(".status-success, .wb-icon--spin")) return "working";
    if (card.querySelector(".status-warning")) return "pending";
    if (card.querySelector(".status-completed")) return "completed";
    if (card.querySelector(".status-secondary")) return "other";
    const statusEl = card.querySelector('[class*="_status_"]');
    const text = (statusEl?.textContent || "").trim().toLowerCase();
    if (/已完成|完成|completed|complete|done/.test(text)) return "completed";
    if (/失败|错误|已终止|终止|failed|error|terminated|killed/.test(text)) return "failed";
    if (/处理中|工作中|规划中|运行中|执行中|生成中|working|planning|running/.test(text)) return "working";
    if (/等待中|排队中|pending|queued/.test(text)) return "pending";
    return text ? "other" : card.querySelector('[class*="_trailingStatus_"]') ? "pending" : "completed";
  };
  const conversationKey = (el) =>
    el.closest?.("[data-conversation-id]")?.getAttribute("data-conversation-id") || el;

  const states = new Map();
  let knockInitialized = false;
  let knockWaiting = false;

  const scan = () => {
    const seen = new Set();
    for (const card of document.querySelectorAll(".conversation-agent-card")) {
      const key = conversationKey(card);
      seen.add(key);
      const now = statusOf(card);
      const prev = states.get(key);
      states.set(key, now);
      if (prev && prev !== now && ACTIVE_STATES.has(prev)) {
        if (now === "completed") play(messageSound);
        else if (now === "failed") play(failureSound);
      }
    }
    for (const key of states.keys()) {
      if (!seen.has(key)) states.delete(key);
    }
    // 敲门声：提问等待出现（上升沿）；首次扫描只初始化状态，不补响
    const waiting = document.querySelectorAll(".ask-user-question--waiting").length > 0;
    if (!knockInitialized) {
      knockInitialized = true;
      knockWaiting = waiting;
      return;
    }
    if (waiting && !knockWaiting) play(knockSound);
    knockWaiting = waiting;
  };

  // 状态变化来自 class/文本变更：attributes(class) + characterData 足够覆盖；
  // rAF 防抖合帧，避免流式渲染期间每帧重复全量扫描
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      scan();
    });
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class"],
  });
  scan();

  return () => {
    observer.disconnect();
    for (const audio of [messageSound, failureSound, knockSound]) audio.pause();
  };
})();
