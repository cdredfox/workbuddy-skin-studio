// TDP 英雄层：主界面宇航员 + 轨道环动效（移植自旧 runtime.js 的 zt()）。
// 本文件作为函数体在主题激活时执行（new Function），返回值是拆除函数。
// 样式全部在 skin.css（#tdp-hero-visual 系列选择器）；此处只负责 DOM 注入与驻留。
// "./hero-tdp-pro.webp" 会在注入前被替换为 data URL，渲染进程内自包含。
return (() => {
  const HERO_ID = "tdp-hero-visual";
  const HOST_SELECTORS = [
    ".teams-container [data-view-id=\"main-content\"]",
    ".teams-main-content",
    ".main-content",
    ".claw-agent-chat-pane",
  ];
  const HERO_HTML =
    '<div class="tdp-vis">' +
    '<div class="tdp-glow tdp-glow--planet"></div>' +
    '<div class="tdp-orbit tdp-orbit--3"></div>' +
    '<div class="tdp-orbit tdp-orbit--2"><i class="tdp-dot tdp-dot--2"></i></div>' +
    '<div class="tdp-orbit tdp-orbit--1"><i class="tdp-dot tdp-dot--1"></i></div>' +
    '<div class="tdp-dome"></div>' +
    '<div class="tdp-ring tdp-ring--back"></div>' +
    '<div class="tdp-spaceman"><img class="tdp-spaceman__img" src="./hero-tdp-pro.webp" alt="" style="max-width:64vh"></div>' +
    '<div class="tdp-ring tdp-ring--front"></div>' +
    '<i class="tdp-deco tdp-deco--a"></i><i class="tdp-deco tdp-deco--b"></i><i class="tdp-deco tdp-deco--c"></i>' +
    "</div>";

  const findHost = () => {
    const home = document.querySelector(".wb-home-page");
    if (home) return { host: home, page: "home" };
    for (const selector of HOST_SELECTORS) {
      for (const el of document.querySelectorAll(selector)) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 400 && rect.height > 300) return { host: el, page: "chat" };
      }
    }
    return null;
  };

  const removeLayer = () => {
    const layer = document.getElementById(HERO_ID);
    if (layer) {
      layer.parentElement?.classList?.remove("tdp-hero-host");
      layer.remove();
    }
    document.body.removeAttribute("data-tdp-page");
  };

  const ensure = () => {
    const found = findHost();
    if (!found) {
      removeLayer();
      return;
    }
    const { host, page } = found;
    document.body.setAttribute("data-tdp-page", page);
    const existing = document.getElementById(HERO_ID);
    if (existing && existing.parentElement === host) return;
    if (existing) removeLayer();
    const layer = document.createElement("div");
    layer.id = HERO_ID;
    layer.setAttribute("aria-hidden", "true");
    layer.innerHTML = HERO_HTML;
    host.classList.add("tdp-hero-host");
    host.insertBefore(layer, host.firstChild);
  };

  ensure();

  // SPA 路由切换（首页 ↔ 对话）会重建宿主节点：监听 body 子树，rAF 防抖后重新就位。
  // ensure 在宿主未变时不产生 DOM 写，观察者不会自我循环
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      ensure();
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return () => {
    observer.disconnect();
    removeLayer();
  };
})();
