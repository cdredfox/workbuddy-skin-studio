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
  指定主题 id（默认用 miku-light）
.EXAMPLE
  .\apply.ps1
  .\apply.ps1 -Theme mice-cat
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

. (Join-Path $PSScriptRoot 'common.ps1')

function Test-CDP([int]$P) {
  try {
    $r = Invoke-RestMethod "http://127.0.0.1:$P/json/list" -TimeoutSec 1
    return [bool]($r | Where-Object { $_.type -eq 'page' -and $_.url -like '*renderer/index.html*' })
  } catch { return $false }
}

$exe = Find-WorkBuddyExe -Explicit $WorkBuddyExe
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
  # 用 Win32_Process.Create 启动：进程由 WMI 服务派生，不附着本控制台，
  # 关闭本 PowerShell 窗口不会连带退出 WorkBuddy（Start-Process 会附着控制台，
  # 关窗时 conhost 向附着进程发送 CTRL_CLOSE_EVENT 导致 WorkBuddy 被终止）
  $cmdLine = '"{0}" --remote-debugging-port={1}' -f $exe, $Port
  $spawn = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdLine }
  if ($spawn.ReturnValue -ne 0) { Write-Error "启动 WorkBuddy 失败（ReturnValue=$($spawn.ReturnValue)）"; exit 1 }
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
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
