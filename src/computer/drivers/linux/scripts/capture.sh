if ! read_geometry; then
  echo 'could not determine the capture geometry on the current X11 screen' >&2
  exit 3
fi
before_geometry=$geometry_json
if command -v import >/dev/null 2>&1; then
  import -window root -crop "${capture_w}x${capture_h}+${capture_x}+${capture_y}" +repage "$rolebox_capture_path" >/dev/null
elif command -v scrot >/dev/null 2>&1; then
  scrot -o -a "${capture_x},${capture_y},${capture_w},${capture_h}" "$rolebox_capture_path" >/dev/null
else
  echo "no X11 screenshot helper is installed; $rolebox_capture_install_hint" >&2
  exit 127
fi
if ! read_geometry || [ "$before_geometry" != "$geometry_json" ]; then
  echo 'screenshot geometry changed; take a fresh screenshot' >&2
  exit 3
fi
printf '%s\n' "$geometry_json"
