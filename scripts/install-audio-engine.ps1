# One-time setup for the interview coach's audio engine: a Python 3.12 venv with faster-whisper
# (speech to text on the GPU) and PyAudioWPatch (microphone + speaker capture), plus the speech model.
# Re-running is safe. Needs: Python 3.12 (py -3.12) and an NVIDIA GPU for speed (CPU works, slowly).
param([string]$Model = 'large-v3-turbo')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$engine = Join-Path $root 'apps\audio-engine'
$venv = Join-Path $engine '.venv'
$python = Join-Path $venv 'Scripts\python.exe'

if (-not (Test-Path $python)) {
  $py = Get-Command py -ErrorAction SilentlyContinue
  if (-not $py) { throw 'Python launcher (py) not found. Install Python 3.12 from python.org first.' }
  & py -3.12 --version
  if ($LASTEXITCODE -ne 0) { throw 'Python 3.12 not found. Install it from python.org (3.13 is too new for some of the audio wheels).' }
  Write-Host "Creating $venv ..."
  & py -3.12 -m venv $venv
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the virtual environment.' }
}

Write-Host 'Installing packages (the CUDA libraries are large; this takes a few minutes) ...'
& $python -m pip install --upgrade pip
& $python -m pip install -r (Join-Path $engine 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'pip install failed.' }

Write-Host "Downloading the speech model '$Model' (about 1.6 GB, once) ..."
& $python -c "from faster_whisper.utils import download_model; print(download_model('$Model'))"
if ($LASTEXITCODE -ne 0) { throw 'Model download failed.' }

Write-Host 'Audio devices found:'
& $python -c "import sys; sys.path.insert(0, r'$engine'); import pyaudiowpatch as pa, devices; p = pa.PyAudio(); d = devices.list_devices(p); [print('  mic   ', x['name'], '(default)' if x['isDefault'] else '') for x in d['inputs']]; [print('  speaker', x['name'], '(default)' if x['isDefault'] else '') for x in d['outputs']]; p.terminate()"

Write-Host ''
Write-Host "Done. Python: $python"
Write-Host 'Open Job Matrix > an application > Interview coach to use it.'
