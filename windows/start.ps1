param([switch]$Watch,[switch]$NoTray)
$ErrorActionPreference = 'Stop'
$bridgeRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $bridgeRoot 'runtime'
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' }
if (-not (Test-Path -LiteralPath $nodePath)) { throw '未找到运行环境。请在 Codex 打开此项目，或安装 Node.js。' }
$entry = Join-Path $bridgeRoot 'src/main.mjs'
if(-not $NoTray){$trayScript=Join-Path $PSScriptRoot 'tray.ps1';Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',('"'+$trayScript+'"'))}
do {
    if(Test-Path -LiteralPath (Join-Path $runtimeDir 'stop-service.flag')){if(-not $Watch){exit 0};Start-Sleep -Seconds 5;continue}
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:17861/health' -TimeoutSec 2
        if ($health.service -eq 'codex-feishu-bridge') { exit 0 }
    } catch { }
    & $nodePath $entry 1>> (Join-Path $runtimeDir 'service.log') 2>> (Join-Path $runtimeDir 'service-error.log')
    if ($Watch) { Start-Sleep -Seconds 5 }
} while ($Watch)
