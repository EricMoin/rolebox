read_geometry() {
  monitors=$(read_monitors) || return 3
  displays_json=$(printf '%s\n' "$monitors" | display_json) || return 3
  screen_info=$(LC_ALL=C xrandr --current) || return 3
  root_size=$(printf '%s\n' "$screen_info" | awk "$rolebox_root_size") || return 3
  read_capture_bounds || return 3
  set -- $rectangle $root_size
  if [ "$#" != 6 ] || [ "$1" -lt 0 ] || [ "$2" -lt 0 ] || [ "$(($1 + $3))" -gt "$5" ] || [ "$(($2 + $4))" -gt "$6" ]; then
    echo 'capture bounds must be fully inside the current X11 root screen' >&2
    return 3
  fi
  capture_x=$1 capture_y=$2 capture_w=$3 capture_h=$4
  geometry_json=$(printf '{"bounds":{"x":%s,"y":%s,"w":%s,"h":%s},"displays":%s}' "$1" "$2" "$3" "$4" "$displays_json")
}
