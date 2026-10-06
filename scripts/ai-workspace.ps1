<#
.SYNOPSIS
    一键启动 Windows Terminal 多窗格 AI 工作区
.DESCRIPTION
    布局说明（左侧为大窗格）：
      dual   : [ AI CLI | Shell ]
      triple : [ AI CLI | Shell ]      右上 Shell / 右下 git watch
               [        | Git watch ]
      quad   : [ AI CLI  | Shell    ]
               [ AI CLI2 | Git watch ]
.PARAMETER Path
    工作目录（默认当前目录）
.PARAMETER Layout
    dual | triple | quad（默认 triple）
.PARAMETER AiCli
    主 AI CLI 命令。留空则自动探测 claude -> gemini -> codex -> 普通 pwsh
.PARAMETER AiCli2
    quad 布局左下窗格命令，默认与 AiCli 相同
.PARAMETER InCurrentWindow
    在当前 WT 窗口开新标签页，而非新窗口
.EXAMPLE
    .\ai-workspace.ps1
    .\ai-workspace.ps1 -Path F:\github\workbuddy-skin-studio -Layout quad
    .\ai-workspace.ps1 -AiCli claude -InCurrentWindow
#>
[CmdletBinding()]
param(
    [string]$Path = (Get-Location).Path,
    [ValidateSet('dual', 'triple', 'quad')]
    [string]$Layout = 'triple',
    [string]$AiCli = '',
    [string]$AiCli2 = '',
    [switch]$InCurrentWindow
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command wt -ErrorAction SilentlyContinue)) {
    throw '未找到 wt (Windows Terminal)，请先安装 Windows Terminal。'
}
$Path = (Resolve-Path $Path).Path
$gitWatch = Join-Path $PSScriptRoot 'git-watch.ps1'

# 自动探测 AI CLI
if (-not $AiCli) {
    foreach ($c in 'claude', 'gemini', 'codex') {
        if (Get-Command $c -ErrorAction SilentlyContinue) { $AiCli = $c; break }
    }
}
if (-not $AiCli2) { $AiCli2 = $AiCli }

function New-AiPaneArgs([string]$cli, [string]$title) {
    if ($cli) { return @('--title', $title, 'pwsh', '-NoLogo', '-NoExit', '-Command', $cli) }
    return @('--title', $title, 'pwsh', '-NoLogo')
}

$shellPane = @('--title', 'Shell', 'pwsh', '-NoLogo')
$gitPane   = @('--title', 'Git Watch', 'pwsh', '-NoLogo', '-NoExit', '-File', $gitWatch, '-RepoPath', $Path)

# 组装 wt 参数（';' 作为子命令分隔符）
$wtArgs = @()
if ($InCurrentWindow) { $wtArgs += @('-w', '0', 'new-tab') }
$wtArgs += @('-d', $Path) + (New-AiPaneArgs $AiCli 'AI CLI')

switch ($Layout) {
    'dual' {
        $wtArgs += @(';', 'split-pane', '-V', '--size', '0.4', '-d', $Path) + $shellPane
    }
    'triple' {
        $wtArgs += @(';', 'split-pane', '-V', '--size', '0.4', '-d', $Path) + $shellPane
        $wtArgs += @(';', 'split-pane', '-H', '--size', '0.45', '-d', $Path) + $gitPane
        $wtArgs += @(';', 'move-focus', 'left')
    }
    'quad' {
        $wtArgs += @(';', 'split-pane', '-V', '--size', '0.4', '-d', $Path) + $shellPane
        $wtArgs += @(';', 'split-pane', '-H', '--size', '0.45', '-d', $Path) + $gitPane
        $wtArgs += @(';', 'move-focus', 'left')
        $wtArgs += @(';', 'split-pane', '-H', '--size', '0.4', '-d', $Path) + (New-AiPaneArgs $AiCli2 'AI CLI 2')
        $wtArgs += @(';', 'move-focus', 'up')
    }
}

Write-Host "启动 AI 工作区: Layout=$Layout  Path=$Path  AiCli=$(if ($AiCli) { $AiCli } else { '(pwsh)' })" -ForegroundColor Cyan
& wt @wtArgs
