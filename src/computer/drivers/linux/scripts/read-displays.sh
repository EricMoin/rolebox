read_monitors() {
  monitor_info=$(LC_ALL=C xrandr --listactivemonitors) || return 3
  printf '%s\n' "$monitor_info" | awk "$rolebox_monitor_rows"
}
display_json() {
  awk -F '\t' "$rolebox_display_json"
}
