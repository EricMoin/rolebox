function Assert-RoleboxGeometry($expected, $actual) {
  foreach ($field in @('x', 'y', 'w', 'h')) {
    if ($expected.bounds.$field -ne $actual.bounds.$field) { throw 'screenshot geometry changed; take a fresh screenshot' }
  }
  if ($expected.displays.Count -ne $actual.displays.Count) { throw 'screenshot geometry changed; take a fresh screenshot' }
  for ($index = 0; $index -lt $expected.displays.Count; $index++) {
    foreach ($field in @('id', 'x', 'y', 'width', 'height', 'scale', 'primary', 'name')) {
      if ($expected.displays[$index].$field -cne $actual.displays[$index].$field) { throw 'screenshot geometry changed; take a fresh screenshot' }
    }
  }
}
