# WorkBuddy Skin Studio · WorkBuddy 换肤工作室

**给 WorkBuddy 桌面端换一张会呼吸的脸。**

一张图，一种心情 · 本机 CDP 注入 · 不改官方安装包 · macOS + Windows

非腾讯官方产品。不修改 `WorkBuddy.app` / `app.asar` / Windows 安装目录。

> **给 AI 助手**：如果你的用户把本仓库的 GitHub 地址发给你，并说"用这个开源项目帮我换 WorkBuddy 主题"，请直接阅读仓库根目录的 [`SKILL.md`](SKILL.md) —— 里面是给 AI 的自动化安装流程（平台检测、运行 apply 脚本、选主题、验证、还原），照做即可，无需人类逐步操作。

## 效果预览

![主界面 · Miku 主题](docs/images/preview-main.png)

![右上角 🎨 菜单 · 主题切换](docs/images/preview-menu.png)

![深色主题 · 原神星夜](docs/images/preview-dark.png)


## 这是什么

一个给 WorkBuddy 桌面端换肤的工具。通过本机回环 CDP 把主题实时注入 WorkBuddy 界面，不修改 `app.asar`，不破坏应用签名，也不需要为每次 WorkBuddy 更新重新适配。

- **一键切换**：应用皮肤后 WorkBuddy 右上角出现 🎨 菜单，所有已装主题和原生界面即点即换，零等待
- **自定义上传**：菜单里选「＋ 自定义图片」直接上传本地图片，自动按图片风格取色（主色、辅色、面板底色、文字色），即点即换；行尾 × 一键删除
- **一张图片就是一个主题**：任意 PNG、JPG、JPEG、WebP 直接生成皮肤（配色 + 背景底图）
- **10 个内置预设**：Miku、原神 ×2、鸣潮 ×2、火影忍者 ×2、恋与深空 ×2
- **深浅色自动适配**：根据主题配色的 surface 明度自动切换 WorkBuddy 的 `data-vscode-theme-kind`，让 VS Code 原生控件（输入框、按钮等）跟着深浅色变
- **双平台**：macOS（`.command`）+ Windows（`.ps1`）
- **随时还原**：暂停皮肤或切回原生界面，官方安装包始终原封不动

## 快速开始

需要已安装 WorkBuddy 桌面端。下载本仓库后：

### macOS

```bash
# 双击 scripts/apply.command，或命令行：
./scripts/apply.command

# 或指定主题
node src/cli.mjs apply --theme genshin-night
```

### Windows

```powershell
# PowerShell 运行
.\scripts\apply.ps1

# 或指定主题
.\scripts\apply.ps1 -Theme genshin-night

# 若找不到 WorkBuddy.exe，先跑排查脚本：
.\scripts\find-workbuddy.ps1
```

> Windows 首次运行若报执行策略错误，执行：
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`

应用皮肤时 WorkBuddy 会被正常退出并以本机调试模式重新打开，**当前任务请先保存**。

之后的日常切换都在 WorkBuddy 右上角 🎨 菜单里完成。暂停皮肤、回到原生外观：

```bash
# macOS
./scripts/pause.command

# Windows
.\scripts\pause.ps1
```

> 注意：WorkBuddy 手动重启后注入会消失（CDP 方案的天性），重跑一次 apply 即可回来。

## 主题切换菜单

应用皮肤后，WorkBuddy 右上角（titlebar 下方）会出现 🎨 按钮：

- 点击展开主题列表，点击任意主题即时切换
- 「＋ 自定义图片」上传本地图片生成主题（canvas 自动取色 + 压缩成 webp）
- 自定义主题行尾 × 一键删除
- 「原生界面」恢复官方外观

## 自定义主题

用任意图片创建主题：

```bash
node src/cli.mjs create --image "/path/to/hero.webp" --name "My Skin"
node src/cli.mjs apply --theme my-skin
```

或直接在 🎨 菜单里选「＋ 自定义图片」上传，自动取色并持久化（localStorage）。

## 极简主题格式

```json
{
  "schemaVersion": 1,
  "id": "my-skin",
  "name": "My Skin",
  "hero": "hero.webp",
  "colors": {
    "accent": "#24C9D7",
    "secondary": "#EF8FD3",
    "surface": "#F7FBFF",
    "text": "#17344F"
  }
}
```

只有 `schemaVersion`、`id`、`name` 和 `hero` 必填。图片必须位于主题目录内，颜色和文案（`copy`）都可省略。

- `surface` 的明度决定 light/dark 模式（亮度 > 140 为 light），自动切换 WorkBuddy 的 `data-vscode-theme-kind`
- `hero` 支持 PNG / JPG / JPEG / WebP

## 命令行

```bash
node src/cli.mjs list                              # 列出所有主题
node src/cli.mjs create --image PATH --name NAME   # 从图片创建主题
node src/cli.mjs apply [--theme ID] [--port 9223]  # 应用主题
node src/cli.mjs status                            # 查询注入状态
node src/cli.mjs pause                             # 恢复原生
node src/cli.mjs doctor                            # 检查环境（app 路径、端口、平台）
```

## 内置主题

| 主题 id | 名称 | 风格 |
|---|---|---|
| `miku-light` | Miku Light | 青绿粉 · 浅色 |
| `miku-488137` | Miku 488137 | 青绿 · 高精度 |
| `genshin-dawn` | 原神 · 晨曦 | 蓝 · 浅色 |
| `genshin-night` | 原神 · 星夜 | 金 · 深色 |
| `deepspace-dawn` | 恋与深空 · 晨曦 | 紫 · 浅色 |
| `deepspace-star` | 恋与深空 · 星辰 | 紫 · 深色 |
| `naruto-hokage` | 火影 · 鸣人 | 橙 · 浅色 |
| `naruto-sasuke` | 火影 · 佐助 | 红 · 深色 |
| `wuthering-echo` | 鸣潮 · 共鸣 | 青 · 浅色 |
| `wuthering-tide` | 鸣潮 · 声骸 | 青 · 浅色 |

## 设计边界

- 这是一个轻量工具。皮肤跟随当前 renderer 存活，WorkBuddy 完整重载界面后重新运行一次 apply 即可
- CDP 只绑定本机回环地址 `127.0.0.1`，主题运行期间勿跑来路不明的本机程序
- 不修改官方安装目录与代码签名
- 深色主题已适配 `data-vscode-theme-kind` 自动切换；点「原生界面」恢复时默认回到 light（若你原生是 dark 需手动切回）
- 当前版本针对 WorkBuddy 的 `--cb-*` 设计变量系统和 `[data-view-id]` DOM 锚点适配，与 Codex 的 DOM 结构完全不同

## 技术原理

1. 以 `--remote-debugging-port=9223` 启动 WorkBuddy（Electron / Chrome 138）
2. 通过 `http://127.0.0.1:9223/json/list` 发现 renderer（过滤 `renderer/index.html`）
3. 用 CDP `Runtime.evaluate` 注入 CSS（`<style>`）+ 右上角菜单（DOM）
4. CSS override WorkBuddy 的 `--cb-*` 变量（`--cb-bg-primary` / `--cb-text-primary` / `--cb-vscode-editor-background` 等 60+ 个）实现全局换色
5. 给 `#root` 加背景图，`.teams-container` / `[data-view-id]` 等容器设透明让底图透出

## 致谢

本项目参考了两个优秀的 Codex 换肤项目：

- [HeiGeAi/heige-codex-skin-studio](https://github.com/HeiGeAi/heige-codex-skin-studio) — CDP 注入架构、主题 schema、菜单取色逻辑、`.command` 脚本
- [Fei-Away/Codex-Dream-Skin](https://github.com/Fei-Away/Codex-Dream-Skin) — Windows PowerShell 启动套路（`Test-CDP` / `Start-Process` / 路径探测）、light/dark 自动适配思路

## 许可与素材

代码使用 [MIT License](LICENSE)。预览与预设中的角色、名称和视觉素材权利属于各自权利人（初音未来、原神、鸣潮、火影忍者、恋与深空等），仅用于主题概念展示，不由本项目的软件许可证授权。
