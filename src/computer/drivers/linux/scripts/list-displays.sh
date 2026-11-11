monitors=$(read_monitors)
printf '%s\n' "$monitors" | display_json
