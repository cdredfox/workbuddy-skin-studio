import { skinStatus } from "./injector.mjs";
import { isWorkBuddyRunning, relaunchWorkBuddy } from "./relaunch.mjs";

// watch 常驻看护：把「重启丢皮肤」从 CDP 方案的天性补成可恢复。
// 每轮探测三种情形：
//   1. CDP 端口存活 + 有 renderer 未注入（整页重载/新窗口）→ 直接重注；
//   2. CDP 端口不存在 + WorkBuddy 进程存活（用户手动以非调试模式重启）→ 拉起调试模式并重注；
//   3. CDP 端口不存在 + 进程不在（用户主动退出）→ 待命，绝不擅自拉起。
// 动作失败进入退避（最长 60s），避免每 3s 反复强杀用户的 WorkBuddy。

const DEFAULT_INTERVAL_MS = 3000;
const MAX_BACKOFF_MS = 60_000;

export async function runWatchLoop({
  port,
  intervalMs = DEFAULT_INTERVAL_MS,
  probePort,
  readStatuses,
  isRunning,
  relaunch,
  reapply,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onEvent = () => {},
  signal,
}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new TypeError("port must be an integer from 1024 through 65535");
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 500) {
    throw new TypeError("intervalMs must be at least 500");
  }
  for (const [name, fn] of Object.entries({ probePort, readStatuses, isRunning, relaunch, reapply })) {
    if (typeof fn !== "function") throw new TypeError(`${name} must be a function`);
  }

  let backoffMs = intervalMs;
  let reapplied = 0;
  let relaunched = 0;

  while (!signal?.aborted) {
    let acted = false;
    try {
      if (await probePort()) {
        const statuses = await readStatuses();
        // statuses 为 null 表示状态读取失败（如 renderer 正在导航），本轮不动；
        // 空数组（启动初期尚无 renderer 页面）同样不动，等下一轮
        if (statuses && statuses.length > 0 && statuses.some((entry) => !entry?.installed)) {
          onEvent("检测到 renderer 皮肤缺失（页面可能重载），重新注入");
          await reapply();
          reapplied += 1;
          acted = true;
        }
      } else if (await isRunning()) {
        onEvent("检测到 WorkBuddy 以非调试模式运行，以 CDP 模式重新拉起并恢复皮肤");
        await relaunch();
        relaunched += 1;
        await reapply();
        reapplied += 1;
        acted = true;
      }
      backoffMs = intervalMs; // 成功（含无需动作）即复位退避
    } catch (error) {
      onEvent(`watch 本轮失败：${error instanceof Error ? error.message : String(error)}`);
      if (!acted) backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }
    await sleep(backoffMs);
  }
  return { stopped: true, reapplied, relaunched };
}

// CDP 端点存活性探测：/json/version 与 renderer 是否已加载无关，
// 避免把「调试模式启动中、页面尚未出现」误判为「非调试模式重启」而误杀进程
async function probeCdpEndpoint(port, { fetchImpl = globalThis.fetch } = {}) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`);
    return response?.ok === true;
  } catch {
    return false;
  }
}

export function startWatch({ port, intervalMs = DEFAULT_INTERVAL_MS, reapply, onEvent, signal, deps = {} }) {
  if (typeof reapply !== "function") throw new TypeError("reapply must be a function");
  const log = onEvent ?? ((message) => process.stdout.write(`[watch ${new Date().toLocaleTimeString()}] ${message}\n`));
  return runWatchLoop({
    port,
    intervalMs,
    signal,
    onEvent: log,
    probePort: deps.probePort ?? (() => probeCdpEndpoint(port, { fetchImpl: deps.fetchImpl })),
    readStatuses: deps.readStatuses ?? (async () => {
      // 端口刚活、页面尚在加载时 skinStatus 返回空数组；抛错（连接中断等）则本轮放弃
      try {
        return await skinStatus({ port });
      } catch {
        return null;
      }
    }),
    isRunning: deps.isRunning ?? (() => isWorkBuddyRunning()),
    relaunch: deps.relaunch ?? (() => relaunchWorkBuddy({ port })),
    reapply,
    sleep: deps.sleep,
  });
}
