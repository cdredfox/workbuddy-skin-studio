---
name: workbuddy-skin-studio
description: >-
  Prepare and apply reversible themes/skins for the WorkBuddy desktop app
  through local Chromium DevTools Protocol injection. Use when the user wants
  to install, apply, change, upload, pause, or inspect a WorkBuddy theme/skin;
  references the workbuddy-skin-studio GitHub project; or says phrases such as
  "帮我换 WorkBuddy 主题/皮肤". Present theme choices before applying, wait for
  the user's selection, download only that selected preset from a verified
  GitHub Release into the local cache, then open the external system terminal
  and copy one exact command for the user to paste and run. Never run a command
  that closes WorkBuddy from its in-app Agent, and never modify app.asar or the
  official install.
---

# WorkBuddy Skin Studio

Apply one selected theme through local CDP injection. Do not inject an in-app
theme button, menu, or file picker.

## Required interaction

Never run `scripts/apply.command`, `scripts/apply.ps1`, or another command that
closes or restarts WorkBuddy from the in-app Agent. Closing WorkBuddy terminates
that Agent and interrupts its process tree.

1. Detect macOS or Windows and resolve the absolute path of this Skill folder.
2. If the user did not already specify a theme, show the choices below and stop
   to wait for their answer:

   - `sunny-orchard` — 晴空果园，天蓝与草绿浅色
   - `ocean-friends` — 碧海伙伴，海蓝与新绿浅色
   - `sea-scroll` — 沧海书影，暖金与青灰浅色
   - `celestial-dancer` — 星河飞天，鎏金与青蓝深色
   - `inkblade-surge` — 墨锋破浪，水蓝与鎏金深色
   - `bamboo-swordheart` — 竹影剑心，青灰与古金深色
   - `cloud-cliff-pines` — 云崖听松，松青宣纸浅色
   - `pine-crane-mist` — 松鹤烟岚，青黛淡金浅色
   - `上传自定义图片` — attach a PNG, JPG, JPEG, or WebP
   - `恢复原生界面`

   Also include existing user-created themes returned by
   `node src/cli.mjs list`, if any.
3. If the user chooses a built-in or existing custom theme, validate its id
   against `node src/cli.mjs list`.
4. If the user chooses a new custom image, wait for an accessible attachment.
   Infer a display name from the filename or ask for one, then safely prepare
   the theme without restarting WorkBuddy:

   ```bash
   node src/cli.mjs create --image "/absolute/path/to/image" --name "主题名称"
   ```

   Read the returned `id`.
5. Prepare the selected theme before closing WorkBuddy:

   ```bash
   node src/cli.mjs prepare --theme THEME_ID
   ```

   Built-in themes download only at this point, then remain in the verified
   local cache. Custom themes already stored locally do not download anything.
   If preparation fails, report the network or integrity error and do not
   continue to the terminal handoff.
6. Warn the user that WorkBuddy will close and unsaved work will be lost.
7. After the user confirms their work is saved, run the safe handoff helper:

   ```bash
   node src/terminal-handoff.mjs --action apply --theme THEME_ID
   ```

   This copies the exact command and opens the external system Terminal or
   PowerShell. It does not execute the command.
8. Tell the user that the terminal is open and the command is on the clipboard.
   Ask them to press `⌘V` then Enter on macOS, or `Ctrl+V` then Enter on Windows.
   Also display the returned `command` as a fallback.

For `恢复原生界面`, use:

```bash
node src/terminal-handoff.mjs --action pause
```

If the helper cannot access the clipboard or open the terminal, display the
platform-specific command below and ask the user to open a terminal manually.

## Command to give — macOS

Escape single quotes in paths before constructing the command:

```bash
cd '/absolute/path/to/workbuddy-skin-studio' && env -u ELECTRON_RUN_AS_NODE /bin/bash './scripts/apply.command' --theme 'sunny-orchard'
```

For `恢复原生界面`, give:

```bash
cd '/absolute/path/to/workbuddy-skin-studio' && env -u ELECTRON_RUN_AS_NODE /bin/bash './scripts/pause.command'
```

Always invoke macOS `.command` files through `/bin/bash`. Skill installation
may not preserve executable mode bits, so direct `./scripts/apply.command` can
fail with `permission denied`. Unset `ELECTRON_RUN_AS_NODE` so WorkBuddy's
environment cannot make Node treat the launcher path as an Electron module.

## Command to give — Windows

Give one PowerShell command. Use `-ExecutionPolicy Bypass` only for this child
process; never change the user's global execution policy:

```powershell
Set-Location -LiteralPath 'C:\absolute\path\to\workbuddy-skin-studio'; powershell -NoProfile -ExecutionPolicy Bypass -File '.\scripts\apply.ps1' -Theme 'sunny-orchard'
```

For `恢复原生界面`, give:

```powershell
Set-Location -LiteralPath 'C:\absolute\path\to\workbuddy-skin-studio'; powershell -NoProfile -ExecutionPolicy Bypass -File '.\scripts\pause.ps1'
```

## Expected terminal behavior

The user-run launcher closes WorkBuddy, relaunches it with CDP bound to
`127.0.0.1:9223`, waits for `renderer/index.html`, and injects only the selected
theme. WorkBuddy contains no theme-selection controls. To change themes, invoke
this Skill again and run the newly generated terminal command.

## Guardrails

- Never edit `WorkBuddy.app`, `WorkBuddy.exe`, `app.asar`, the official install
  directory, or code signing.
- Never execute the final apply/pause command from WorkBuddy's in-app Agent.
- The Agent may run `src/terminal-handoff.mjs`; it only copies the final command
  and opens an external terminal.
- Never inject selection UI, buttons, menus, or file inputs into WorkBuddy.
- Use only clean wallpapers or character art for custom themes.
- Remind the user not to run untrusted local software while CDP is active
  because the local debugging endpoint has no same-user authentication.

## Safe Agent commands

These do not close WorkBuddy and may be run by the Agent. The handoff command
only opens the external terminal and updates the clipboard:

```bash
node src/cli.mjs list
node src/cli.mjs prepare --theme THEME_ID
node src/cli.mjs doctor
node src/cli.mjs status
node src/terminal-handoff.mjs --action apply --theme THEME_ID
node --check src/cli.mjs
```

## Resources

- `src/cli.mjs` — list, create, apply, pause, status, and doctor commands.
- `src/injector.mjs` — selected-theme-only CSS injection and removal.
- `src/skin-css.mjs` — WorkBuddy CSS variable and background overrides.
- `src/theme-store.mjs` — built-in and user-created theme storage.
- `src/theme-schema.mjs` — validate manifests and securely cache release assets.
- `src/terminal-handoff.mjs` — safely copy the command and open the terminal.
- `scripts/apply.command` / `pause.command` — user-run macOS launchers.
- `scripts/apply.ps1` / `pause.ps1` — user-run Windows launchers.
- `themes/` — eight lightweight manifests; images live in GitHub Release assets.
