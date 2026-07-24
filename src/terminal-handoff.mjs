#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const THEME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function posixQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function buildTerminalCommand({
  platform = process.platform,
  root = projectRoot,
  action = "apply",
  theme,
} = {}) {
  if (action !== "apply" && action !== "pause") {
    throw new Error("action 必须是 apply 或 pause");
  }
  if (action === "apply" && (typeof theme !== "string" || !THEME_ID.test(theme))) {
    throw new Error("theme id 只能包含小写字母、数字和连字符");
  }

  if (platform === "darwin") {
    const launcher = action === "apply" ? "./scripts/apply.command" : "./scripts/pause.command";
    const themeArg = action === "apply" ? ` --theme ${posixQuote(theme)}` : "";
    return `cd ${posixQuote(root)} && env -u ELECTRON_RUN_AS_NODE /bin/bash ${posixQuote(launcher)}${themeArg}`;
  }
  if (platform === "win32") {
    const launcher = action === "apply" ? ".\\scripts\\apply.ps1" : ".\\scripts\\pause.ps1";
    const themeArg = action === "apply" ? ` -Theme ${powershellQuote(theme)}` : "";
    return `Set-Location -LiteralPath ${powershellQuote(root)}; powershell -NoProfile -ExecutionPolicy Bypass -File ${powershellQuote(launcher)}${themeArg}`;
  }
  throw new Error(`不支持的平台：${platform}`);
}

function checked(result, label) {
  if (result.error) throw new Error(`${label}失败：${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${label}失败，退出码 ${result.status}: ${result.stderr?.toString().trim() || "未知错误"}`);
  }
}

export function copyAndOpenTerminal(command, { platform = process.platform, spawn = spawnSync } = {}) {
  if (platform === "darwin") {
    checked(spawn("pbcopy", [], { input: command, encoding: "utf8" }), "复制命令");
    checked(spawn("open", ["-a", "Terminal"], { encoding: "utf8" }), "打开终端");
    return;
  }
  if (platform === "win32") {
    const commandBase64 = Buffer.from(command, "utf8").toString("base64");
    const script = [
      `$value=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${commandBase64}'))`,
      "Set-Clipboard -Value $value",
      "Start-Process powershell.exe",
    ].join("; ");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    checked(spawn("powershell.exe", ["-NoProfile", "-EncodedCommand", encoded], {
      encoding: "utf8",
      windowsHide: true,
    }), "复制命令并打开 PowerShell");
    return;
  }
  throw new Error(`不支持的平台：${platform}`);
}

function parseArgs(argv) {
  const result = { action: "apply" };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error(`参数无效：${key ?? ""}`);
    result[key.slice(2)] = value;
  }
  return result;
}

export function runTerminalHandoff(argv, overrides = {}) {
  const args = parseArgs(argv);
  const command = buildTerminalCommand({
    platform: overrides.platform,
    root: overrides.root,
    action: args.action,
    theme: args.theme,
  });
  (overrides.copyAndOpen ?? copyAndOpenTerminal)(command, {
    platform: overrides.platform,
    spawn: overrides.spawn,
  });
  return { opened: true, copied: true, command };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const result = runTerminalHandoff(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`workbuddy-skin：${error.message}\n`);
    process.exitCode = 1;
  }
}
