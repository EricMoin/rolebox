foreach ($handle in [RoleboxWindowList]::VisibleWindows()) {
  $ownerId = [uint32]0
  [void][RoleboxWindowList]::GetWindowThreadProcessId($handle, [ref]$ownerId)
  $owner = Get-Process -Id $ownerId -ErrorAction SilentlyContinue
  $ownerName = if ($null -eq $owner) { '' } else { $owner.ProcessName }
  $titleBuffer = New-Object System.Text.StringBuilder(32768)
  [void][RoleboxWindowList]::GetWindowText($handle, $titleBuffer, $titleBuffer.Capacity)
  $title = $titleBuffer.ToString()
  if (& $windowFilter) { @($handle.ToInt64(), $ownerName, $title) -join ([char]9) }
}
