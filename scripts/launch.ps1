# Job Matrix desktop launcher. Started (hidden) by launch.vbs from the taskbar/desktop shortcut.
# Starts the local server if needed, then opens it in a normal Chrome tab. Chrome only.
# -NoBrowser: just start the server (used by the Chrome extension's native helper).
param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$port = 5174
$url = "http://127.0.0.1:$port/"
$dataDir = Join-Path $root 'data'

function Test-Up {
  try { (Invoke-WebRequest "$($url)api/health" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { $false }
}

function Fail([string]$msg) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show($msg, 'Job Matrix', 'OK', 'Error') | Out-Null
  exit 1
}

$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome -and -not $NoBrowser) { Fail 'Google Chrome was not found. Job Matrix opens in Chrome only.' }

if (-not (Test-Up)) {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { Fail 'Node.js was not found on this PC.' }
  New-Item -ItemType Directory -Force $dataDir | Out-Null

  # Rebuild the web UI when its source (or shared code) is newer than the last build.
  $dist = Join-Path $root 'apps\web\dist\index.html'
  $sources = @('apps\web\src', 'apps\web\public', 'apps\web\index.html', 'packages\shared\src') |
    ForEach-Object { Get-ChildItem (Join-Path $root $_) -Recurse -File -ErrorAction SilentlyContinue }
  $newest = ($sources | Measure-Object LastWriteTime -Maximum).Maximum
  if (-not (Test-Path $dist) -or $newest -gt (Get-Item $dist).LastWriteTime) {
    $build = Start-Process $node -ArgumentList '"node_modules/vite/bin/vite.js"', 'build', 'apps/web' `
      -WorkingDirectory $root -WindowStyle Hidden -Wait -PassThru `
      -RedirectStandardOutput (Join-Path $dataDir 'build.log') -RedirectStandardError (Join-Path $dataDir 'build-error.log')
    if ($build.ExitCode -ne 0) { Fail "Building the app failed. See $dataDir\build-error.log" }
  }

  # Keep the last three runs' logs (server.1.log is the previous run); the Log page shows them.
  foreach ($base in 'server', 'server-error') {
    $cur = Join-Path $dataDir "$base.log"
    if ((Test-Path $cur) -and (Get-Item $cur).Length -gt 0) {
      Remove-Item (Join-Path $dataDir "$base.3.log") -ErrorAction SilentlyContinue
      foreach ($n in 2, 1) {
        $from = Join-Path $dataDir "$base.$n.log"
        if (Test-Path $from) { Move-Item $from (Join-Path $dataDir "$base.$($n + 1).log") -Force }
      }
      Move-Item $cur (Join-Path $dataDir "$base.1.log") -Force
    }
  }

  # The server exits by itself 10 minutes after the last window closes.
  $env:JM_IDLE_EXIT_MINUTES = '10'
  $env:API_PORT = "$port"
  Start-Process $node -ArgumentList '--env-file-if-exists=.env', '--import', 'tsx', 'apps/server/src/index.ts' `
    -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $dataDir 'server.log') -RedirectStandardError (Join-Path $dataDir 'server-error.log')

  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Test-Up)) {
    if ((Get-Date) -gt $deadline) { Fail "Job Matrix didn't start. See $dataDir\server-error.log" }
    Start-Sleep -Milliseconds 300
  }
}

if (-not $NoBrowser) { Start-Process $chrome -ArgumentList $url }
