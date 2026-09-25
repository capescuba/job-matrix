# One-time setup for the Job Matrix Chrome extension's native helper (lets the extension start
# Job Matrix and fetch its token). Per user: writes two files under data\ and one registry key in
# HKCU. No admin rights needed. Safe to run again (e.g. after Node.js moves).
# Then, in Chrome: chrome://extensions → Developer mode → Load unpacked → apps\extension.
# -AppRoot: the Job Matrix folder the helper serves (its data\ and launcher). Defaults to this one.
param([string]$AppRoot)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $AppRoot) { $AppRoot = $root }
$dataDir = Join-Path $AppRoot 'data'
New-Item -ItemType Directory -Force $dataDir | Out-Null

# Fixed by the "key" in apps\extension\manifest.json, so it's the same wherever it's loaded from.
$extensionId = 'keiamknmppkefljklkaceniaafephpcf'
$hostName = 'com.jobmatrix.host'

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js was not found on this PC.' }

# Chrome starts this .cmd; it runs the helper with this PC's Node.js.
$cmdPath = Join-Path $dataDir 'native-host.cmd'
$hostScript = Join-Path $root 'scripts\native-host\host.mjs'
Set-Content -Path $cmdPath -Encoding ascii -Value "@echo off`r`n`"$node`" `"$hostScript`" --root `"$AppRoot`" %*"

$manifestPath = Join-Path $dataDir "$hostName.json"
@{
  name            = $hostName
  description     = 'Job Matrix helper: starts the app and hands the extension its token'
  path            = $cmdPath
  type            = 'stdio'
  allowed_origins = @("chrome-extension://$extensionId/")
} | ConvertTo-Json | Set-Content -Path $manifestPath -Encoding utf8

$key = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name '(default)' -Value $manifestPath

Write-Output "Registered $hostName for extension $extensionId"
Write-Output "  helper:   $cmdPath"
Write-Output "  manifest: $manifestPath"
