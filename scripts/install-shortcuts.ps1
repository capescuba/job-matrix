# Creates "Job Matrix" shortcuts (Start menu + Desktop) that run the hidden launcher with the app icon.
# Pin either one to the taskbar: right-click > Pin to taskbar (Windows 11: Show more options first).
$root = Split-Path -Parent $PSScriptRoot
$shell = New-Object -ComObject WScript.Shell
$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'Job Matrix.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Job Matrix.lnk')
)
foreach ($path in $targets) {
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
  $lnk.Arguments = '"' + (Join-Path $PSScriptRoot 'launch.vbs') + '"'
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = (Join-Path $PSScriptRoot 'job-matrix.ico') + ',0'
  $lnk.Description = 'Job Matrix: job search tracker'
  $lnk.Save()
  Write-Output "Created $path"
}
