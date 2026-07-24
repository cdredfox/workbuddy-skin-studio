import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import { CdpSession, fetchRendererTargets, waitForRendererTargets } from "./cdp-client.mjs";
import { buildSkinCss } from "./skin-css.mjs";

const STYLE_ID = "workbuddy-skin-style";
// Remove menu nodes left by releases before 1.1.
const MENU_ID = "workbuddy-skin-menu";
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

async function evaluateTargets(targets, expression, Session) {
  const values = [];
  for (const target of targets) {
    const session = new Session(target.webSocketDebuggerUrl);
    try {
      await session.open();
      values.push(await session.evaluate(expression));
    } finally {
      session.close();
    }
  }
  return values;
}

async function themeCss(loadedTheme) {
  const bytes = await readFile(loadedTheme.heroPath);
  const mime = MIME[extname(loadedTheme.heroPath).toLowerCase()];
  if (!mime) throw new Error("不支持的 hero 图片类型");
  const heroDataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
  return buildSkinCss({ theme: loadedTheme.manifest, heroDataUrl });
}

export async function applySkin({ loadedTheme, port, deps = {} }) {
  const wait = deps.waitForRendererTargets ?? waitForRendererTargets;
  const Session = deps.Session ?? CdpSession;
  const themeId = loadedTheme.manifest.id;
  const css = await themeCss(loadedTheme);
  const surface = loadedTheme.manifest.colors.surface;
  const expression = `(() => {
    const styleId = ${JSON.stringify(STYLE_ID)};
    let style = document.getElementById(styleId);
    if (!style) {
      style = document.createElement("style");
      style.id = styleId;
      document.head.appendChild(style);
    }
    style.textContent = ${JSON.stringify(css)};
    document.getElementById(${JSON.stringify(MENU_ID)})?.remove();
    delete window.__workbuddySkin;
    document.documentElement.dataset.workbuddySkin = ${JSON.stringify(themeId)};

    const match = /^#([0-9a-f]{6})$/i.exec(${JSON.stringify(surface)});
    const value = match ? parseInt(match[1], 16) : 0xffffff;
    const light = (0.299 * ((value >> 16) & 255) + 0.587 * ((value >> 8) & 255) + 0.114 * (value & 255)) > 140;
    const body = document.body;
    const html = document.documentElement;
    body.dataset.vscodeThemeKind = light ? "vscode-light" : "vscode-dark";
    body.dataset.vscodeThemeName = light ? "IDE Light" : "IDE Dark";
    html.style.colorScheme = light ? "light" : "dark";
    ["light", "vscode-light", "cb-light", "dark", "vscode-dark", "cb-dark"].forEach((name) => {
      const darkClass = name === "dark" || name === "vscode-dark" || name === "cb-dark";
      body.classList.toggle(name, light ? !darkClass : darkClass);
      html.classList.toggle(name, light ? !darkClass : darkClass);
    });
    return true;
  })()`;
  const targets = await wait(port, {
    timeoutMs: deps.waitTimeoutMs ?? 20_000,
    pollMs: deps.pollMs ?? 500,
  });
  const values = await evaluateTargets(targets, expression, Session);
  return { applied: values.length, themeId, targets: targets.map(({ id }) => id) };
}

export async function removeSkin({ port, deps = {} }) {
  const fetchTargets = deps.fetchRendererTargets ?? fetchRendererTargets;
  const Session = deps.Session ?? CdpSession;
  const expression = `(() => {
    document.getElementById(${JSON.stringify(STYLE_ID)})?.remove();
    document.getElementById(${JSON.stringify(MENU_ID)})?.remove();
    delete window.__workbuddySkin;
    delete document.documentElement.dataset.workbuddySkin;
    return true;
  })()`;
  const targets = await fetchTargets(port);
  const values = await evaluateTargets(targets, expression, Session);
  return { removed: values.length };
}

export async function skinStatus({ port, deps = {} }) {
  const fetchTargets = deps.fetchRendererTargets ?? fetchRendererTargets;
  const Session = deps.Session ?? CdpSession;
  const expression = `(() => ({
    installed: Boolean(document.getElementById(${JSON.stringify(STYLE_ID)})),
    menu: false,
    themeId: document.documentElement.dataset.workbuddySkin ?? null
  }))()`;
  const targets = await fetchTargets(port);
  return evaluateTargets(targets, expression, Session);
}
