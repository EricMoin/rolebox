$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
if (-not [System.Windows.Forms.SystemInformation]::UserInteractive) { Write-Error 'this Windows session is not interactive, so no window can receive input'; exit 3 }
'Windows input needs no per-application permission grant; this session is interactive and SendKeys is available.'
