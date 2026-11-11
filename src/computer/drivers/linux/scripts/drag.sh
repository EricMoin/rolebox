trap 'xdotool mouseup 1' 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
xdotool mousedown 1
