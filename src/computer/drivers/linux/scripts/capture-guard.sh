if ! read_geometry || [ "$geometry_json" != "$rolebox_expected_geometry" ]; then
  echo 'ROLEBOX_SCREENSHOT_STALE: screenshot geometry changed; take a fresh screenshot' >&2
  exit 3
fi
