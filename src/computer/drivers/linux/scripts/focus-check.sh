if ! active=$(xdotool getactivewindow); then
  echo 'could not verify the active X11 window' >&2
  exit 3
fi
if [ "$active" != "$rolebox_window_id" ]; then
  echo 'the window manager refused foreground activation; select the target window manually and retry' >&2
  exit 3
fi
