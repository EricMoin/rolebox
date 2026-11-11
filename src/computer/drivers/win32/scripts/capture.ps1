$beforeGeometry = Get-RoleboxGeometry
$sourceX = $beforeGeometry.bounds.x
$sourceY = $beforeGeometry.bounds.y
$width = $beforeGeometry.bounds.w
$height = $beforeGeometry.bounds.h
$bitmap = New-Object System.Drawing.Bitmap($width, $height)
try {
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($sourceX, $sourceY, 0, 0, $bitmap.Size)
    $bitmap.Save($capturePath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $graphics.Dispose() }
} finally { $bitmap.Dispose() }
try {
  $afterGeometry = Get-RoleboxGeometry
  Assert-RoleboxGeometry $beforeGeometry $afterGeometry
} catch { throw 'screenshot geometry changed; take a fresh screenshot' }
ConvertTo-Json -InputObject $beforeGeometry -Depth 6 -Compress
