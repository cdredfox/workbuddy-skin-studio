import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTerminalCommand,
  copyAndOpenTerminal,
  runTerminalHandoff,
} from "../src/terminal-handoff.mjs";

test("builds a quoted macOS apply command", () => {
  assert.equal(
    buildTerminalCommand({
      platform: "darwin",
      root: "/Users/A User/skin's studio",
      theme: "celestial-dancer",
    }),
    `cd '/Users/A User/skin'\"'\"'s studio' && env -u ELECTRON_RUN_AS_NODE /bin/bash './scripts/apply.command' --theme 'celestial-dancer'`,
  );
});

test("builds a quoted Windows apply command", () => {
  assert.equal(
    buildTerminalCommand({
      platform: "win32",
      root: "C:\\Users\\A User\\skin's studio",
      theme: "sunny-orchard",
    }),
    `Set-Location -LiteralPath 'C:\\Users\\A User\\skin''s studio'; powershell -NoProfile -ExecutionPolicy Bypass -File '.\\scripts\\apply.ps1' -Theme 'sunny-orchard'`,
  );
});

test("hands the command to the terminal opener without applying it", () => {
  let handedOff;
  const result = runTerminalHandoff(
    ["--action", "apply", "--theme", "sea-scroll"],
    {
      platform: "darwin",
      root: "/tmp/studio",
      copyAndOpen: (command) => { handedOff = command; },
    },
  );
  assert.equal(
    handedOff,
    "cd '/tmp/studio' && env -u ELECTRON_RUN_AS_NODE /bin/bash './scripts/apply.command' --theme 'sea-scroll'",
  );
  assert.equal(result.opened, true);
  assert.equal(result.copied, true);
});

test("builds pause commands without a theme", () => {
  assert.equal(
    buildTerminalCommand({ platform: "darwin", root: "/tmp/studio", action: "pause" }),
    "cd '/tmp/studio' && env -u ELECTRON_RUN_AS_NODE /bin/bash './scripts/pause.command'",
  );
});

test("macOS handoff copies first and then opens Terminal", () => {
  const calls = [];
  copyAndOpenTerminal("echo safe", {
    platform: "darwin",
    spawn: (program, args, options) => {
      calls.push({ program, args, input: options.input });
      return { status: 0, stderr: "" };
    },
  });
  assert.deepEqual(calls, [
    { program: "pbcopy", args: [], input: "echo safe" },
    { program: "open", args: ["-a", "Terminal"], input: undefined },
  ]);
});

test("Windows handoff opens PowerShell through an encoded helper", () => {
  const calls = [];
  copyAndOpenTerminal("Write-Host safe", {
    platform: "win32",
    spawn: (program, args) => {
      calls.push({ program, args });
      return { status: 0, stderr: "" };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].program, "powershell.exe");
  assert.deepEqual(calls[0].args.slice(0, 2), ["-NoProfile", "-EncodedCommand"]);
  const decoded = Buffer.from(calls[0].args[2], "base64").toString("utf16le");
  assert.match(decoded, /Set-Clipboard/);
  assert.match(decoded, /Start-Process powershell\.exe/);
});

test("rejects unsafe theme ids", () => {
  assert.throws(
    () => buildTerminalCommand({ platform: "darwin", root: "/tmp/studio", theme: "x; rm" }),
    /theme id/,
  );
});
