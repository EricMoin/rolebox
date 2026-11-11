for id in $ids; do
  name=$(xdotool getwindowname "$id" 2>/dev/null) || continue
  printf '%s\t%s\n' "$id" "$name"
done
