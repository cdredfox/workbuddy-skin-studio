// 注入渲染进程的 JS 源码片段（字符串形态）。injector 的 CDP 表达式与 skin-menu 的菜单脚本
// 都要在页面里打开同一个 IndexedDB、做同样的 base64 解码，统一从这里取，避免多处手写漂移。
import { VIDEO_DB_NAME, VIDEO_DB_STORE } from "./constants.mjs";

const DB = JSON.stringify(VIDEO_DB_NAME);
const STORE = JSON.stringify(VIDEO_DB_STORE);

// 定义 wbSkinIdbOpen()：打开（必要时创建）视频库，返回 Promise<IDBDatabase>
export const IDB_OPEN_SNIPPET = `const wbSkinIdbOpen = () => new Promise((resolve, reject) => {
  const req = indexedDB.open(${DB}, 1);
  req.onupgradeneeded = () => { req.result.createObjectStore(${STORE}); };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});`;

// 定义 wbSkinDecodeBase64(b64)：base64 → Uint8Array。
// 优先原生 Uint8Array.fromBase64（Chromium 133+，比 atob+逐字节循环快一个数量级），
// 旧内核回退 atob 循环；非法输入抛异常，由调用方兜底
export const BASE64_DECODE_SNIPPET = `const wbSkinDecodeBase64 = (b64) => {
  if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};`;

// 页面内视频库的库名/表名字面量（已 JSON 转义，可直接拼进表达式）
export const VIDEO_DB_LITERALS = { db: DB, store: STORE };
