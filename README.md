# WorkBuddy Skin Studio · WorkBuddy 换肤工作室

**给 WorkBuddy 桌面端换一张会呼吸的脸。**

一张图，一种心情 · 本机 CDP 注入 · 不改官方安装包 · macOS + Windows

非腾讯官方产品。不修改 `WorkBuddy.app` / `app.asar` / Windows 安装目录。

> **给 AI 助手**：如果你的用户把本仓库的 GitHub 地址发给你，并说"用这个开源项目帮我换 WorkBuddy 主题"，请直接阅读仓库根目录的 [`SKILL.md`](SKILL.md) —— 里面是给 AI 的自动化安装流程（平台检测、运行 apply 脚本、选主题、验证、还原），照做即可，无需人类逐步操作。

## 效果预览

![晴空果园](https://github.com/PaPaPiu/workbuddy-skin-studio/releases/download/themes-v1.0.0/sunny-orchard.webp)

![星河飞天](https://github.com/PaPaPiu/workbuddy-skin-studio/releases/download/themes-v1.0.0/celestial-dancer.webp)


## 这是什么

一个给 WorkBuddy 桌面端换肤的工具。通过本机回环 CDP 把主题实时注入 WorkBuddy 界面，不修改 `app.asar`，不破坏应用签名，也不需要为每次 WorkBuddy 更新重新适配。

- **应用前选择**：Agent 先展示全部预设、自定义上传和恢复原生选项，等用户回答后再生成命令
- **自定义上传**：把 PNG、JPG、JPEG 或 WebP 发给 Agent，由 Agent 准备本地主题
- **自动打开终端**：Agent 打开外部终端并把单行命令复制到剪贴板，用户只需粘贴并按回车
- **一张图片就是一个主题**：任意 PNG、JPG、JPEG、WebP 直接生成皮肤（配色 + 背景底图）
- **8 个内置预设**：晴空果园、碧海伙伴、沧海书影、星河飞天、墨锋破浪、竹影剑心、云崖听松、松鹤烟岚
- **按需下载**：预设图片存放在 GitHub Release，只有用户选中后才下载并缓存
- **完整性保护**：下载后校验来源、文件大小、WebP 文件头和 SHA-256
- **深浅色自动适配**：根据主题配色的 surface 明度自动切换 WorkBuddy 的 `data-vscode-theme-kind`，让 VS Code 原生控件（输入框、按钮等）跟着深浅色变
- **双平台**：macOS（`.command`）+ Windows（`.ps1`）
- **随时还原**：暂停皮肤或切回原生界面，官方安装包始终原封不动

## 快速开始

需要已安装 WorkBuddy 桌面端。下载本仓库后：

### 用 AI 选择主题并生成命令（推荐）

不想自己敲命令？把本仓库的 GitHub 地址发给任意 AI 助手（CodeBuddy / Claude / Cursor 等），再加上一句：

> 用这个开源项目帮我更换 WorkBuddy 的主题

AI 会读取 [`SKILL.md`](SKILL.md)，先展示 8 个预设、“上传自定义图片”和“恢复原生界面”。你选定后，AI 只下载该主题并缓存；确认已保存当前工作后，AI 会自动打开外部终端，并把包含正确路径和主题 id 的命令复制到剪贴板。

在 macOS 按 `⌘V`、Windows 按 `Ctrl+V`，然后按回车即可。真正的换肤步骤仍由外部终端执行；如果让 WorkBuddy 内置 Agent 直接运行，WorkBuddy 关闭时任务也会被中断。

> 想指定主题也可直接说，例如「用星河飞天」或「帮我换成 sunny-orchard」。

### macOS

```bash
# 在系统“终端”中运行：
cd '/path/to/workbuddy-skin-studio' && env -u ELECTRON_RUN_AS_NODE /bin/bash './scripts/apply.command' --theme 'sunny-orchard'
```

### Windows

```powershell
# 在外部 PowerShell 中运行
Set-Location -LiteralPath 'C:\path\to\workbuddy-skin-studio'; powershell -NoProfile -ExecutionPolicy Bypass -File '.\scripts\apply.ps1' -Theme 'sunny-orchard'

# 若找不到 WorkBuddy.exe，先跑排查脚本：
.\scripts\find-workbuddy.ps1
```

应用皮肤时 WorkBuddy 会被正常退出并以本机调试模式重新打开，**当前任务请先保存**。

需要更换主题时，再次运行 Skill、选择主题并复制新的命令。暂停皮肤、回到原生外观：

```bash
# macOS
env -u ELECTRON_RUN_AS_NODE /bin/bash './scripts/pause.command'

# Windows
.\scripts\pause.ps1
```

> 注意：WorkBuddy 手动重启后注入会消失（CDP 方案的天性），重跑一次 apply 即可回来。

## 应用前选择主题

当用户没有指定主题时，Agent 会先在对话中展示 8 个内置主题、“上传自定义图片”和“恢复原生界面”，然后等待用户回答。

选定后，Agent 会打开外部终端并复制命令，但不会替用户按回车或在 WorkBuddy 内执行。WorkBuddy 界面中也不会注入主题切换按钮、菜单或文件上传控件。

## 自定义主题

用任意图片创建主题：

```bash
node src/cli.mjs create --image "/path/to/hero.webp" --name "My Skin"
# 将上一步返回的 id 放进外部终端命令：
env -u ELECTRON_RUN_AS_NODE /bin/bash './scripts/apply.command' --theme 'my-skin-xxxxxxxx'
```

正常使用时，把图片上传给 Agent。Agent 会先创建本地主题，再把最终换肤命令交给用户复制。

## 极简主题格式

```json
{
  "schemaVersion": 1,
  "id": "my-skin",
  "name": "My Skin",
  "hero": "hero.webp",
  "heroUrl": "https://github.com/PaPaPiu/workbuddy-skin-studio/releases/download/themes-v1.0.0/my-skin.webp",
  "heroSha256": "64位小写十六进制摘要",
  "heroBytes": 123456,
  "colors": {
    "accent": "#24C9D7",
    "secondary": "#EF8FD3",
    "surface": "#F7FBFF",
    "text": "#17344F"
  }
}
```

本地自定义主题只需要 `schemaVersion`、`id`、`name` 和 `hero`。远程预设还需要不可变的 `heroUrl`、`heroSha256` 和 `heroBytes`，下载后保存到用户缓存目录。

- `surface` 的明度决定 light/dark 模式（亮度 > 140 为 light），自动切换 WorkBuddy 的 `data-vscode-theme-kind`
- `hero` 支持 PNG / JPG / JPEG / WebP

## 命令行

```bash
node src/cli.mjs list                              # 列出所有主题
node src/cli.mjs create --image PATH --name NAME   # 从图片创建主题
node src/cli.mjs prepare --theme ID                 # 按需下载并校验所选主题
node src/cli.mjs apply [--theme ID] [--port 9223]  # 应用主题
node src/cli.mjs status                            # 查询注入状态
node src/cli.mjs pause                             # 恢复原生
node src/cli.mjs doctor                            # 检查环境（app 路径、端口、平台）
```

不要让 WorkBuddy 内置 Agent 执行 `apply` 或平台启动脚本；请复制 Agent
生成的完整命令，在外部终端运行。

## 内置主题

| 主题 id | 名称 | 风格 |
|---|---|---|
| `sunny-orchard` | 晴空果园 | 天蓝、草绿 · 浅色 |
| `ocean-friends` | 碧海伙伴 | 海蓝、新绿 · 浅色 |
| `sea-scroll` | 沧海书影 | 暖金、青灰 · 浅色 |
| `celestial-dancer` | 星河飞天 | 鎏金、青蓝 · 深色 |
| `inkblade-surge` | 墨锋破浪 | 水蓝、鎏金 · 深色 |
| `bamboo-swordheart` | 竹影剑心 | 青灰、古金 · 深色 |
| `cloud-cliff-pines` | 云崖听松 | 松青、宣纸白 · 浅色 |
| `pine-crane-mist` | 松鹤烟岚 | 青黛、淡金 · 浅色 |

## 设计边界

- 这是一个轻量工具。皮肤跟随当前 renderer 存活，WorkBuddy 完整重载界面后重新运行一次 apply 即可
- CDP 只绑定本机回环地址 `127.0.0.1`，主题运行期间勿跑来路不明的本机程序
- 不修改官方安装目录与代码签名
- 深色主题已适配 `data-vscode-theme-kind` 自动切换；点「原生界面」恢复时默认回到 light（若你原生是 dark 需手动切回）
- 当前版本针对 WorkBuddy 的 `--cb-*` 设计变量系统和 `[data-view-id]` DOM 锚点适配，与 Codex 的 DOM 结构完全不同

## 技术原理

1. 以 `--remote-debugging-port=9223` 启动 WorkBuddy（Electron / Chrome 138）
2. 通过 `http://127.0.0.1:9223/json/list` 发现 renderer（过滤 `renderer/index.html`）
3. 从 GitHub Release 按需下载所选主题并验证 SHA-256，缓存后复用
4. 用 CDP `Runtime.evaluate` 只注入用户选定主题的 CSS（`<style>`）
5. CSS override WorkBuddy 的 `--cb-*` 变量（`--cb-bg-primary` / `--cb-text-primary` / `--cb-vscode-editor-background` 等 60+ 个）实现全局换色
6. 给 `#root` 加背景图，`.teams-container` / `[data-view-id]` 等容器设透明让底图透出

## 致谢

本项目参考了两个优秀的 Codex 换肤项目：

- [HeiGeAi/heige-codex-skin-studio](https://github.com/HeiGeAi/heige-codex-skin-studio) — CDP 注入架构、主题 schema、菜单取色逻辑、`.command` 脚本
- [Fei-Away/Codex-Dream-Skin](https://github.com/Fei-Away/Codex-Dream-Skin) — Windows PowerShell 启动套路（`Test-CDP` / `Start-Process` / 路径探测）、light/dark 自动适配思路

## 许可与素材

代码使用 [MIT License](LICENSE)。主题图片由项目作者提供；其中涉及的角色和视觉素材权利属于各自权利人，不由本项目的软件许可证授权。
