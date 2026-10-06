<#
.SYNOPSIS
    AI CLI 终端增强环境一键安装配置脚本 (Windows)
.DESCRIPTION
    安装并配置: PowerShell 7 / Oh My Posh / Nerd Font / PSReadLine / Terminal-Icons / bat / delta / eza / fzf / ripgrep
.PARAMETER SkipInstall
    跳过软件安装，仅写入配置（profile / git / Windows Terminal）
.PARAMETER SkipWTConfig
    不修改 Windows Terminal 的 settings.json
.PARAMETER SkipGitConfig
    不修改 git 全局配置（delta pager）
.EXAMPLE
    .\setup-terminal.ps1
    .\setup-terminal.ps1 -SkipInstall   # 只配置不安装
#>
[CmdletBinding()]
param(
    [switch]$SkipInstall,
    [switch]$SkipWTConfig,
    [switch]$SkipGitConfig
)

$ErrorActionPreference = 'Stop'
$FontName  = 'JetBrainsMono Nerd Font'
$ThemeName = 'tokyonight_storm'   # Oh My Posh 主题，可换成 catppuccin_mocha / powerlevel10k_rainbow 等

function Write-Step([string]$msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Skip([string]$msg) { Write-Host "  [SKIP] $msg" -ForegroundColor DarkGray }

# ---------------------------------------------------------------- 1. 安装软件
if (-not $SkipInstall) {
    Write-Step "检查 winget"
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Host @"
未找到 winget。请先安装「应用安装程序」：
  - Microsoft Store 搜索 "App Installer"，或
  - https://aka.ms/getwinget
安装后重新运行本脚本，或改用 scoop（需手动调整脚本中的安装段）。
"@
        exit 1
    }

    Write-Step "winget 安装软件包"
    $packages = @(
        @{ Id = 'Microsoft.PowerShell';        Name = 'PowerShell 7' },
        @{ Id = 'JanDeDobbeleer.OhMyPosh';     Name = 'Oh My Posh' },
        @{ Id = 'sharkdp.bat';                 Name = 'bat (高亮 cat)' },
        @{ Id = 'dandavison.delta';            Name = 'delta (美化 git diff)' },
        @{ Id = 'eza-community.eza';           Name = 'eza (现代 ls)' },
        @{ Id = 'junegunn.fzf';                Name = 'fzf (模糊搜索)' },
        @{ Id = 'BurntSushi.ripgrep.MSVC';     Name = 'ripgrep (极速搜索)' }
    )
    foreach ($p in $packages) {
        $installed = winget list --id $p.Id --exact 2>$null | Select-String $p.Id
        if ($installed) { Write-Skip "$($p.Name) 已安装"; continue }
        Write-Host "  安装 $($p.Name) ..."
        winget install --id $p.Id --exact --silent --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -eq 0) { Write-Ok $p.Name } else { Write-Host "  [FAIL] $($p.Name) exit=$LASTEXITCODE" -ForegroundColor Yellow }
    }

    Write-Step "安装 Nerd Font: $FontName"
    $fontInstalled = (New-Object -ComObject Shell.Application).Namespace(0x14).Items() |
        Where-Object { $_.Name -like "*JetBrainsMono*" } | Select-Object -First 1
    if ($fontInstalled) {
        Write-Skip "字体已存在"
    } else {
        oh-my-posh font install JetBrainsMono
        Write-Ok "字体已安装（如提示选择，请选 JetBrainsMono）"
    }
} else {
    Write-Skip "已跳过软件安装 (-SkipInstall)"
}

# ---------------------------------------------------------------- 2. PowerShell 模块
Write-Step "安装/更新 PowerShell 模块"
# 信任 PSGallery，避免交互式确认
if ((Get-PSRepository PSGallery).InstallationPolicy -ne 'Trusted') {
    Set-PSRepository PSGallery -InstallationPolicy Trusted
}
$modules = @('PSReadLine', 'Terminal-Icons', 'posh-git')
foreach ($m in $modules) {
    $cur = Get-Module -ListAvailable $m | Sort-Object Version -Descending | Select-Object -First 1
    if ($m -eq 'PSReadLine') {
        # PSReadLine 需 >= 2.2 才支持历史预测
        if ($cur -and $cur.Version -ge [version]'2.2.0') { Write-Skip "PSReadLine $($cur.Version) 已满足"; continue }
        Install-Module PSReadLine -Force -Scope CurrentUser -AllowClobber -SkipPublisherCheck
        Write-Ok "PSReadLine 已更新"
    } elseif ($cur) {
        Write-Skip "$m $($cur.Version) 已安装"
    } else {
        Install-Module $m -Force -Scope CurrentUser
        Write-Ok "$m 已安装"
    }
}

# ---------------------------------------------------------------- 3. 写入 PowerShell Profile
Write-Step "配置 PowerShell profile"
$profileDir = Split-Path (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'PowerShell\profile.ps1')
if (-not (Test-Path $profileDir)) { New-Item -ItemType Directory -Path $profileDir -Force | Out-Null }

$block = @"

# >>> ai-cli-terminal-setup >>>
# Oh My Posh 主题
`$env:POSH_GIT_ENABLED = `$true
oh-my-posh init pwsh --config "`$env:POSH_THEMES_PATH\$ThemeName.omp.json" | Invoke-Expression

# 图标与 git
Import-Module Terminal-Icons
Import-Module posh-git

# PSReadLine：历史预测 + 补全
Set-PSReadLineOption -PredictionSource HistoryAndPlugin -PredictionViewStyle ListView
Set-PSReadLineOption -Colors @{ InlinePrediction = '#8A8A8A' }
Set-PSReadLineKeyHandler -Key Tab      -Function MenuComplete
Set-PSReadLineKeyHandler -Key UpArrow   -Function HistorySearchBackward
Set-PSReadLineKeyHandler -Key DownArrow -Function HistorySearchForward
Set-PSReadLineKeyHandler -Key Ctrl+r    -ScriptBlock {
    `$line = (Get-History | ForEach-Object CommandLine | Select-Object -Unique |
        fzf --height 40% --reverse --tac)
    if (`$line) { [Microsoft.PowerShell.PSConsoleReadLine]::Insert(`$line) }
}

# eza / bat 便捷函数
function ll { eza -l --icons --git --time-style long-iso @args }
function la { eza -la --icons --git --time-style long-iso @args }
function lt { eza --tree --level=2 --icons @args }
function catp { bat --plain --paging=never @args }

# fzf 集成
`$env:FZF_DEFAULT_OPTS = '--height 40% --reverse --border'
# <<< ai-cli-terminal-setup <<<
"@

# 固定指向 PowerShell 7 的 profile（即使本脚本运行在 5.1 下也写到正确位置）
$profilePath = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'PowerShell\profile.ps1'
$existing = if (Test-Path $profilePath) { Get-Content $profilePath -Raw } else { '' }
if ($existing -match 'ai-cli-terminal-setup') {
    Write-Skip "profile 中已存在配置块: $profilePath"
} else {
    Add-Content -Path $profilePath -Value $block -Encoding UTF8
    Write-Ok "已写入 $profilePath"
    Write-Host "  提示：此 profile 对 pwsh 7 和 Windows PowerShell 5.1 均生效" -ForegroundColor DarkGray
}

# ---------------------------------------------------------------- 4. Git 配置 delta
if (-not $SkipGitConfig) {
    Write-Step "配置 git 使用 delta 美化 diff"
    git config --global core.pager delta
    git config --global interactive.diffFilter 'delta --color-only'
    git config --global delta.navigate true
    git config --global delta.line-numbers true
    git config --global delta.side-by-side false
    git config --global merge.conflictstyle zdiff3
    Write-Ok "git pager = delta (line-numbers + navigate)"
} else {
    Write-Skip "已跳过 git 配置"
}

# ---------------------------------------------------------------- 5. Windows Terminal 设置
if (-not $SkipWTConfig) {
    Write-Step "配置 Windows Terminal (字体: $FontName)"
    $wtSettings = "$env:LOCALAPPDATA\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json"
    if (Test-Path $wtSettings) {
        $backup = "$wtSettings.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
        Copy-Item $wtSettings $backup
        $json = Get-Content $wtSettings -Raw | ConvertFrom-Json

        if (-not $json.profiles.defaults) {
            $json.profiles | Add-Member -NotePropertyName defaults -NotePropertyValue ([pscustomobject]@{}) -Force
        }
        $json.profiles.defaults | Add-Member -NotePropertyName font -NotePropertyValue (
            [pscustomobject]@{ face = $FontName }
        ) -Force

        # 若已装 PowerShell 7，设为默认 profile
        $pwshProfile = $json.profiles.list | Where-Object { $_.name -eq 'PowerShell' } | Select-Object -First 1
        if ($pwshProfile) { $json | Add-Member -NotePropertyName defaultProfile -NotePropertyValue $pwshProfile.guid -Force }

        $json | ConvertTo-Json -Depth 32 | Set-Content $wtSettings -Encoding UTF8
        Write-Ok "settings.json 已更新（备份: $backup）"
    } else {
        Write-Skip "未找到 Windows Terminal settings.json（请至少启动过一次 WT）"
    }
} else {
    Write-Skip "已跳过 Windows Terminal 配置"
}

# ---------------------------------------------------------------- 完成
Write-Step "完成"
Write-Host @"
后续手动步骤：
  1. 重启 Windows Terminal（字体需重启生效）
  2. 验证: 打开新标签应看到 Oh My Posh 主题提示符
  3. 换主题: 编辑 profile 中 '$ThemeName' 为其他主题名
     主题预览: https://ohmyposh.dev/docs/themes
  4. 常用新命令: ll / la / lt / catp / Ctrl+R (fzf 历史搜索)
"@
