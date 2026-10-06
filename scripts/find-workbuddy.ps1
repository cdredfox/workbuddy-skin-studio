<#
.SYNOPSIS
  WorkBuddy Skin Studio - 探测 WorkBuddy.exe 和 node 路径
.DESCRIPTION
  打印自动探测到的 WorkBuddy.exe 和 node 路径，用于排查 apply.ps1 找不到应用的问题
#>
$ErrorActionPreference = 'Continue'

. (Join-Path $PSScriptRoot 'common.ps1')

$exe = Find-WorkBuddyExe
$node = Find-Node
Write-Host "=== WorkBuddy Skin Studio 探测结果 ==="
Write-Host "WorkBuddy.exe: $(if ($exe) { $exe } else { '未找到' })"
Write-Host "node:          $(if ($node) { $node } else { '未找到' })"
if (-not $exe) {
  Write-Host ""
  Write-Host "未找到 WorkBuddy.exe，请用以下方式之一指定："
  Write-Host "  1. 设置环境变量：`$env:WORKBUDDY_EXE = 'C:\path\to\WorkBuddy.exe'"
  Write-Host "  2. 运行 apply.ps1 时传参：.\apply.ps1 -WorkBuddyExe 'C:\path\to\WorkBuddy.exe'"
}
if (-not $node) {
  Write-Host ""
  Write-Host "未找到 node，请安装 node.js 或确认 WorkBuddy 自带 node 路径。"
}
