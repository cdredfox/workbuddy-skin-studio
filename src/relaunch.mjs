import { execFile, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

// WorkBuddy 进程级操作：探测进程是否存活、结束进程、以 CDP 调试模式拉起。
// 供 watcher 在「用户手动重启 WorkBuddy（无调试端口）」后自动恢复换肤。
// 全部依赖可注入（exec / spawnImpl / exists / sleep），单元测试不碰真实进程。

const execFileAsync = promisify(execFile);
const MACOS_APP = "/Applications/WorkBuddy.app";
const MACOS_BINARY = `${MACOS_APP}/Contents/MacOS/Electron`;

const defaultExists = (path) => access(path).then(() => true, () => false);

// 与 scripts/common.ps1 的 Find-WorkBuddyExe 同一套候选顺序：显式环境变量优先，
// 其次用户级/系统级安装目录。注册表探测留在 PowerShell 侧，Node 端不重复实现
export async function findWorkBuddyExe({ env = process.env, exists = defaultExists } = {}) {
  const candidates = [
    env.WORKBUDDY_EXE,
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "workbuddy", "WorkBuddy.exe"),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "workbuddy", "WorkBuddy.exe"),
    env.ProgramFiles && join(env.ProgramFiles, "WorkBuddy", "WorkBuddy.exe"),
    env["ProgramFiles(x86)"] && join(env["ProgramFiles(x86)"], "WorkBuddy", "WorkBuddy.exe"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

export async function isWorkBuddyRunning({
  platform = process.platform,
  exec = execFileAsync,
} = {}) {
  try {
    if (platform === "win32") {
      // /NH /FO CSV：无表头 CSV 输出，命中时输出行含 "WorkBuddy.exe"
      const { stdout } = await exec("tasklist", ["/FI", "IMAGENAME eq WorkBuddy.exe", "/NH", "/FO", "CSV"]);
      return stdout.includes("WorkBuddy.exe");
    }
    // macOS：pgrep 命中退出码 0，未命中退出码 1（execFile 以 reject 呈现）
    await exec("pgrep", ["-f", MACOS_BINARY]);
    return true;
  } catch {
    return false;
  }
}

async function quitWorkBuddy({ platform, exec, sleep }) {
  if (platform === "win32") {
    // /F 强制结束：等价 apply.ps1 的 Stop-Process -Force；进程本就不在也算成功
    await exec("taskkill", ["/IM", "WorkBuddy.exe", "/F"]).catch(() => {});
  } else {
    await exec("osascript", ["-e", 'tell application "WorkBuddy" to quit']).catch(() => {});
    await sleep(2000);
    await exec("pkill", ["-f", MACOS_BINARY]).catch(() => {});
  }
  // 等进程真正退出，避免紧跟着拉起时端口/单实例锁冲突
  await sleep(2000);
}

// 以 CDP 调试模式拉起 WorkBuddy：detached + stdio:ignore + unref，
//  watcher 进程退出不会连带杀死 WorkBuddy
export async function relaunchWorkBuddy({
  port,
  platform = process.platform,
  env = process.env,
  exec = execFileAsync,
  spawnImpl = spawn,
  exists = defaultExists,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new TypeError("port must be an integer from 1024 through 65535");
  }
  const target = platform === "win32" ? await findWorkBuddyExe({ env, exists }) : MACOS_BINARY;
  if (!target || !(await exists(target))) {
    throw new Error("未找到 WorkBuddy 可执行文件，无法自动拉起（可设置 WORKBUDDY_EXE 指定路径）");
  }
  await quitWorkBuddy({ platform, exec, sleep });
  const child = spawnImpl(target, [`--remote-debugging-port=${port}`], { detached: true, stdio: "ignore" });
  child.unref();
  return { exe: target, pid: child.pid ?? null };
}
