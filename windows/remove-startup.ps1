$ErrorActionPreference = 'Stop'
$taskName = 'Codex-Feishu-Bridge'
$expectedScript = Join-Path $PSScriptRoot 'start.ps1'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and $existing.Actions.Arguments.Contains($expectedScript)) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Output '已取消登录后自动启动。当前运行进程未停止。'
} elseif ($existing) { throw '同名启动任务不属于本项目，未修改。' }
