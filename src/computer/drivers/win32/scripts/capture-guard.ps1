try {
  $currentGeometry = Get-RoleboxGeometry
  Assert-RoleboxGeometry $expectedGeometry $currentGeometry
} catch { throw 'ROLEBOX_SCREENSHOT_STALE: screenshot geometry changed; take a fresh screenshot' }
