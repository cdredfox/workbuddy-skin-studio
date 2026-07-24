<#
.SYNOPSIS
  workbuddy-skin - 探测 WorkBuddy.exe 和 node 路径
.DESCRIPTION
  打印自动探测到的 WorkBuddy.exe 和 node 路径，用于排查 apply.ps1 找不到应用的问题
#>
$ErrorActionPreference = 'Continue'

function Find-WorkBuddyExe {
  if ($env:WORKBUDDY_EXE -and (Test-Path -LiteralPath $env:WORKBUDDY_EXE)) { return $env:WORKBUDDY_EXE }
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'workbuddy\WorkBuddy.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\workbuddy\WorkBuddy.exe'),
    (Join-Path $env:ProgramFiles 'WorkBuddy\WorkBuddy.exe')
  )
  if ($env:ProgramFiles(x86)) { $candidates += (Join-Path $env:ProgramFiles(x86) 'WorkBuddy\WorkBuddy.exe') }
  foreach ($c in $candidates) { if (Test-Path -LiteralPath $c) { return $c } }
  try {
    $keys = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')
    foreach ($k in $keys) {
      Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*WorkBuddy*' -and $_.InstallLocation } | ForEach-Object {
        $p = Join-Path $_.InstallLocation 'WorkBuddy.exe'
        if (Test-Path -LiteralPath $p) { return $p }
      }
    }
  } catch {}
  return $null
}

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

$exe = Find-WorkBuddyExe
$node = Find-Node
Write-Host "=== workbuddy-skin 探测结果 ==="
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
