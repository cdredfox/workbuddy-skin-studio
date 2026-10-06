<#
.SYNOPSIS
    git 状态监控窗格：循环刷新 status + log，供 Windows Terminal 分屏使用
.EXAMPLE
    pwsh -NoLogo -NoExit -File .\git-watch.ps1 -RepoPath F:\github\myrepo
#>
param(
    [string]$RepoPath = (Get-Location).Path,
    [int]$IntervalSec = 5
)

Set-Location $RepoPath
while ($true) {
    Clear-Host
    Write-Host "git watch  $RepoPath  ($(Get-Date -Format 'HH:mm:ss'))" -ForegroundColor Cyan
    Write-Host ('-' * 60) -ForegroundColor DarkGray
    git status -sb
    Write-Host ''
    git log --oneline --graph --decorate -n 10 --color=always
    Start-Sleep $IntervalSec
}
