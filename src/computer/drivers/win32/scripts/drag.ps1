try {
  [RoleboxMouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  for ($step = 1; $step -le $dragSteps; $step++) {
    Start-Sleep -Milliseconds $dragDelay
    $x = [int][Math]::Round($dragFromX + ($dragToX - $dragFromX) * $step / $dragSteps)
    $y = [int][Math]::Round($dragFromY + ($dragToY - $dragFromY) * $step / $dragSteps)
    if (-not [RoleboxMouse]::SetCursorPos($x, $y)) { throw 'could not move the pointer during drag' }
  }
} finally {
  [RoleboxMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}
