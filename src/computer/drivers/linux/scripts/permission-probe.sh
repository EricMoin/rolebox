case "${XDG_SESSION_TYPE:-}" in [Ww][Aa][Yy][Ll][Aa][Nn][Dd]) wayland=1 ;; *) wayland=0 ;; esac
if [ "$wayland" = 1 ] || [ -n "${WAYLAND_DISPLAY:-}" ]; then
  echo 'Wayland session: rolebox drives X11 only, so input cannot be injected here.' >&2
  exit 3
fi
if ! command -v xdotool >/dev/null 2>&1; then
  echo "$rolebox_xdotool_install_hint" >&2
  exit 4
fi
if [ -z "${DISPLAY:-}" ]; then
  echo 'DISPLAY is not set; run rolebox inside the target X11 desktop session.' >&2
  exit 5
fi
if ! xdotool getmouselocation >/dev/null; then
  echo 'cannot access the X server; check DISPLAY and XAUTHORITY for the target desktop session.' >&2
  exit 6
fi
echo 'X11 session: xdotool can access the X server. Input still requires the XTEST extension and target application support.'
