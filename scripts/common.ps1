<#
.SYNOPSIS
  WorkBuddy Skin Studio - shared helpers for apply.ps1 / pause.ps1 / find-workbuddy.ps1
.DESCRIPTION
  Dot-source this file:  . (Join-Path $PSScriptRoot 'common.ps1')
  Kept ASCII-only so Windows PowerShell 5.1 parses it correctly with or without a BOM.
#>

function Find-WorkBuddyExe {
  param([string]$Explicit)
  if ($Explicit -and (Test-Path -LiteralPath $Explicit)) { return $Explicit }
  if ($env:WORKBUDDY_EXE -and (Test-Path -LiteralPath $env:WORKBUDDY_EXE)) { return $env:WORKBUDDY_EXE }
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'workbuddy\WorkBuddy.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\workbuddy\WorkBuddy.exe'),
    (Join-Path $env:ProgramFiles 'WorkBuddy\WorkBuddy.exe')
  )
  if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'WorkBuddy\WorkBuddy.exe') }
  foreach ($c in $candidates) { if (Test-Path -LiteralPath $c) { return $c } }

  # Registry Uninstall entries. Use foreach statements (not ForEach-Object):
  # 'return' inside a ForEach-Object script block only ends that iteration and leaks
  # every match plus the trailing $null into the function output as an array.
  $keys = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($k in $keys) {
    $items = @(Get-ItemProperty $k -ErrorAction SilentlyContinue)
    foreach ($item in $items) {
      if ($item.DisplayName -like '*WorkBuddy*' -and $item.InstallLocation) {
        $p = Join-Path $item.InstallLocation 'WorkBuddy.exe'
        if (Test-Path -LiteralPath $p) { return $p }
      }
    }
  }
  return $null
}

function Find-Node {
  $g = Get-Command node -ErrorAction SilentlyContinue
  if ($g) { return $g.Source }
  $homeNode = Join-Path $env:USERPROFILE '.workbuddy\binaries\node\versions'
  if (Test-Path -LiteralPath $homeNode) {
    # Sort by parsed version, not by name: as strings '8.0.0' > '22.22.2'.
    # Directory names may carry a suffix such as '22.22.2-5'; unparsable names sort last.
    $dirs = Get-ChildItem -LiteralPath $homeNode -Directory |
      Sort-Object -Descending -Property @{ Expression = { (($_.Name -replace '-.*$', '') -as [version]) } }, Name
    foreach ($d in $dirs) {
      $exe = Join-Path $d.FullName 'node.exe'
      if (Test-Path -LiteralPath $exe) { return $exe }
    }
  }
  return $null
}
