<#
.SYNOPSIS
  workbuddy-skin - Windows pause
.DESCRIPTION
  暂停皮肤，恢复原生界面（不重启 WorkBuddy）
.PARAMETER Port
  CDP 调试端口，默认 9223
#>
[CmdletBinding()]
param([int]$Port = 9223)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

function Find-Node {
  $g = Get-Command node -ErrorAction SilentlyContinue
  if ($g) { return $g.Source }
  $homeNode = Join-Path $env:USERPROFILE '.workbuddy\binaries\node\versions'
  if (Test-Path $homeNode) {
    $n = Get-ChildItem $homeNode -Directory | Sort-Object Name -Descending | Select-Object -First 1
    if ($n) {
      $exe = Join-Path $n.FullName 'node.exe'
      if (Test-Path -LiteralPath $exe) { return $exe }
    }
  }
  return $null
}

$node = Find-Node
if (-not $node) { Write-Error "未找到 node。"; exit 1 }
& $node (Join-Path $Root 'src/cli.mjs') pause --port $Port
