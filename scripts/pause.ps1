<#
.SYNOPSIS
  WorkBuddy Skin Studio - Windows pause
.DESCRIPTION
  暂停皮肤，恢复原生界面（不重启 WorkBuddy）
.PARAMETER Port
  CDP 调试端口，默认 9223
#>
[CmdletBinding()]
param([int]$Port = 9223)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

. (Join-Path $PSScriptRoot 'common.ps1')

$node = Find-Node
if (-not $node) { Write-Error "未找到 node。"; exit 1 }
& $node (Join-Path $Root 'src/cli.mjs') pause --port $Port
