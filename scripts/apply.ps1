<#
.SYNOPSIS
  WorkBuddy Skin Studio - Windows apply
.DESCRIPTION
  以 CDP 调试模式重启 WorkBuddy 并应用当前主题
.PARAMETER Port
  CDP 调试端口，默认 9223
.PARAMETER WorkBuddyExe
  显式指定 WorkBuddy.exe 路径（覆盖自动探测）
.PARAMETER Theme
  指定主题 id（默认用 sunny-orchard）
.EXAMPLE
  .\apply.ps1
  .\apply.ps1 -Theme celestial-dancer
  .\apply.ps1 -WorkBuddyExe "D:\apps\WorkBuddy\WorkBuddy.exe"
#>
[CmdletBinding()]
param(
  [int]$Port = 9223,
  [string]$WorkBuddyExe,
  [string]$Theme
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

function Find-WorkBuddyExe {
  if ($WorkBuddyExe -and (Test-Path -LiteralPath $WorkBuddyExe)) { return $WorkBuddyExe }
  if ($env:WORKBUDDY_EXE -and (Test-Path -LiteralPath $env:WORKBUDDY_EXE)) { return $env:WORKBUDDY_EXE }
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'workbuddy\WorkBuddy.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\workbuddy\WorkBuddy.exe'),
    (Join-Path $env:ProgramFiles 'WorkBuddy\WorkBuddy.exe')
  )
  if ($env:ProgramFiles(x86)) { $candidates += (Join-Path $env:ProgramFiles(x86) 'WorkBuddy\WorkBuddy.exe') }
  foreach ($c in $candidates) { if (Test-Path -LiteralPath $c) { return $c } }
  # 注册表 Uninstall 项
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

function Test-CDP([int]$P) {
  try {
    $r = Invoke-RestMethod "http://127.0.0.1:$P/json/list" -TimeoutSec 1
    return [bool]($r | Where-Object { $_.type -eq 'page' -and $_.url -like '*renderer/index.html*' })
  } catch { return $false }
}

$exe = Find-WorkBuddyExe
if (-not $exe) {
  Write-Error "未找到 WorkBuddy.exe。请用 -WorkBuddyExe 参数或设置 `$env:WORKBUDDY_EXE 指向 WorkBuddy.exe"
  exit 1
}
$node = Find-Node
if (-not $node) {
  Write-Error "未找到 node。请确保 node 在 PATH，或 WorkBuddy 自带 node 存在。"
  exit 1
}

Write-Host "WorkBuddy: $exe"
Write-Host "Node:      $node"
Write-Host "Port:      $Port"

if (Test-CDP $Port) {
  Write-Host "CDP 已就绪（端口 $Port），跳过重启"
} else {
  Write-Host "退出 WorkBuddy..."
  Get-Process WorkBuddy -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Write-Host "以 CDP 调试模式启动（端口 $Port）..."
  Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=$Port"
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Test-CDP $Port)) {
    if ((Get-Date) -ge $deadline) { Write-Error "CDP 在 30 秒内未就绪"; exit 1 }
    Start-Sleep -Milliseconds 400
  }
  Write-Host "CDP 就绪"
}

Write-Host "应用皮肤..."
$cli = Join-Path $Root 'src/cli.mjs'
$applyArgs = @('apply', '--port', "$Port")
if ($Theme) { $applyArgs += @('--theme', $Theme) }
& $node $cli @applyArgs
