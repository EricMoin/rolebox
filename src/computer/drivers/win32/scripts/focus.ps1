if (-not [RoleboxWindowApi]::IsWindow($handle)) { throw 'window does not exist' }
if ([RoleboxWindowApi]::IsIconic($handle)) { [void][RoleboxWindowApi]::ShowWindowAsync($handle, 9) }
[void][RoleboxWindowApi]::SetForegroundWindow($handle)
for ($attempt = 0; $attempt -lt 20 -and [RoleboxWindowApi]::GetForegroundWindow() -ne $handle; $attempt++) { Start-Sleep -Milliseconds 50 }
if ([RoleboxWindowApi]::GetForegroundWindow() -ne $handle) { throw 'Windows refused foreground activation; select the target window manually and retry' }
