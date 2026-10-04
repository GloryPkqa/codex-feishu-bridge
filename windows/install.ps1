param([switch]$Startup,[switch]$Hooks,[switch]$NoShortcut,[switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$bridgeRoot = Split-Path -Parent $PSScriptRoot
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' }
if (-not (Test-Path -LiteralPath $nodePath)) { throw '未找到 Node.js。请先安装 Node.js 24，并重新打开终端。' }
$nodeVersionText = (& $nodePath --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersionText -notmatch '^v24\.') { throw ('本项目需要 Node.js 24（>=24 且 <25）。当前检测到：' + $nodeVersionText + '。请安装 Node.js 24 并重新打开终端。') }
if (-not (Test-Path -LiteralPath (Join-Path $bridgeRoot 'node_modules/@larksuiteoapi/node-sdk/package.json'))) { throw '未安装依赖。请先在项目目录运行 pnpm install --frozen-lockfile --ignore-scripts。' }
$launchScript = Join-Path $PSScriptRoot 'launch.ps1'
$powerShellPath = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$shortcutArguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $launchScript + '" -OpenWeb'
$desktopPath = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktopPath 'Codex 飞书助手.lnk'
if ($CheckOnly) {
  [pscustomobject]@{Node=$nodePath;Project=$bridgeRoot;Shortcut=$shortcutPath;ShortcutTarget=$powerShellPath;ShortcutArguments=$shortcutArguments;Startup=[bool]$Startup;Hooks=[bool]$Hooks} | ConvertTo-Json
  exit 0
}
if ($Startup) { & (Join-Path $PSScriptRoot 'install-startup.ps1') }
if ($Hooks) {
  & $nodePath (Join-Path $PSScriptRoot 'install-hooks.mjs')
  if ($LASTEXITCODE -ne 0) { throw '同步 Hooks 安装失败。' }
}
if (-not $NoShortcut) {
  $shell = New-Object -ComObject WScript.Shell
  if (Test-Path -LiteralPath $shortcutPath) {
    $existingShortcut = $shell.CreateShortcut($shortcutPath)
    if ($existingShortcut.TargetPath -ne $powerShellPath -or $existingShortcut.Arguments -ne $shortcutArguments) { throw '桌面存在另一套同名快捷方式，请检查或移走它后重新安装。' }
  }
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $powerShellPath
  $shortcut.Arguments = $shortcutArguments
  $shortcut.WorkingDirectory = $bridgeRoot
  $shortcut.WindowStyle = 7
  $shortcut.Description = '启动 Codex 飞书助手并打开本机管理页面'
  $shortcut.Save()
  Write-Output '已创建桌面快捷方式。双击后，在本机管理页面登录 Codex 并连接飞书。'
}
if ($Hooks) { Write-Output '最后请在 Codex 的 Hooks 设置中审查并信任本项目命令。安装器不会代替你信任。' }
