import assert from "node:assert/strict";
import test from "node:test";

import { runWatchLoop } from "../src/watcher.mjs";

// runWatchLoop 的全部外部依赖（探测/状态/进程/动作/休眠）均可注入，
// sleep 在跑满 iterations 轮后 abort 信号，循环自然退出
function makeLoop({ probe, statuses, running, iterations = 1, relaunchError = null }) {
  const controller = new AbortController();
  const calls = { relaunch: 0, reapply: 0, events: [], sleeps: [] };
  let ticks = 0;
  const result = runWatchLoop({
    port: 9223,
    intervalMs: 500,
    signal: controller.signal,
    probePort: typeof probe === "function" ? probe : async () => probe,
    readStatuses: typeof statuses === "function" ? statuses : async () => statuses,
    isRunning: typeof running === "function" ? running : async () => running,
    relaunch: async () => {
      calls.relaunch += 1;
      if (relaunchError) throw relaunchError;
    },
    reapply: async () => { calls.reapply += 1; },
    sleep: async (ms) => {
      calls.sleeps.push(ms);
      ticks += 1;
      if (ticks >= iterations) controller.abort();
    },
    onEvent: (message) => calls.events.push(message),
  });
  return { result, calls };
}

test("端口存活且全部 renderer 已注入：无动作", async () => {
  const { result, calls } = makeLoop({ probe: true, statuses: [{ installed: true }], running: true });
  assert.deepEqual(await result, { stopped: true, reapplied: 0, relaunched: 0 });
  assert.equal(calls.relaunch + calls.reapply, 0);
  assert.deepEqual(calls.sleeps, [500]);
});

test("端口存活但有 renderer 缺失皮肤（页面重载）：直接重注，不重启进程", async () => {
  const { result, calls } = makeLoop({
    probe: true,
    statuses: [{ installed: true }, { installed: false }],
    running: true,
  });
  assert.equal((await result).reapplied, 1);
  assert.equal(calls.relaunch, 0);
  assert.ok(calls.events[0].includes("重新注入"));
});

test("端口不存在 + 进程存活（非调试模式重启）：拉起调试模式并重注", async () => {
  const { result, calls } = makeLoop({ probe: false, statuses: null, running: true });
  const summary = await result;
  assert.equal(summary.relaunched, 1);
  assert.equal(summary.reapplied, 1);
  assert.ok(calls.events[0].includes("非调试模式"));
});

test("端口不存在 + 进程不在（用户主动退出）：待命，绝不擅自拉起", async () => {
  const { result, calls } = makeLoop({ probe: false, statuses: null, running: false });
  assert.deepEqual(await result, { stopped: true, reapplied: 0, relaunched: 0 });
  assert.equal(calls.relaunch + calls.reapply, 0);
});

test("端口存活但状态读取失败（null）：本轮不动，等下一轮", async () => {
  const { result, calls } = makeLoop({ probe: true, statuses: null, running: true });
  assert.equal((await result).reapplied, 0);
  assert.equal(calls.events.length, 0);
});

test("端口存活但尚无 renderer 页面（启动中）：不误判为非调试重启", async () => {
  const { result, calls } = makeLoop({ probe: true, statuses: [], running: true });
  assert.equal((await result).reapplied, 0);
  assert.equal(calls.relaunch, 0);
});

test("动作失败进入退避：休眠间隔翻倍，上限 60s，成功后复位", async () => {
  const { result, calls } = makeLoop({
    probe: false,
    statuses: null,
    running: true,
    relaunchError: new Error("relaunch boom"),
    iterations: 2,
  });
  await result;
  assert.equal(calls.relaunch, 2);
  assert.equal(calls.reapply, 0); // 拉起失败不接着重注
  assert.deepEqual(calls.sleeps, [1000, 2000]); // 失败后先翻倍再休眠
  // 每轮先落「检测到非调试模式」事件，再落失败事件
  const failures = calls.events.filter((message) => message.includes("relaunch boom"));
  assert.equal(failures.length, 2);
});

test("探测本身抛异常：落事件日志并继续循环", async () => {
  let probes = 0;
  const { result, calls } = makeLoop({
    probe: async () => {
      probes += 1;
      if (probes === 1) throw new Error("probe boom");
      return true;
    },
    statuses: [{ installed: true }],
    running: false,
    iterations: 2,
  });
  await result;
  assert.equal(probes, 2);
  assert.ok(calls.events[0].includes("probe boom"));
});

test("参数校验：非法端口 / 过小间隔 / 缺依赖函数均拒绝", async () => {
  const base = {
    port: 9223, intervalMs: 500,
    probePort: async () => true, readStatuses: async () => [],
    isRunning: async () => false, relaunch: async () => {}, reapply: async () => {},
  };
  await assert.rejects(runWatchLoop({ ...base, port: 80 }), TypeError);
  await assert.rejects(runWatchLoop({ ...base, intervalMs: 100 }), TypeError);
  await assert.rejects(runWatchLoop({ ...base, reapply: null }), TypeError);
});
