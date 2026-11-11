/^Monitors: [0-9]+$/ { expected = $2; next }
/^[[:space:]]*[0-9]+:/ {
  line = $0
  sub(/^[[:space:]]*/, "", line)
  id = line; sub(/:.*/, "", id)
  sub(/^[0-9]+: /, "", line)
  primary = line ~ /^[+]*[*]/ ? 1 : 0
  sub(/^[+*]+/, "", line)
  if (!match(line, / [0-9]+\/[0-9]+x[0-9]+\/[0-9]+[+-][0-9]+[+-][0-9]+( |$)/)) { invalid = 1; next }
  name = substr(line, 1, RSTART - 1)
  geometry = substr(line, RSTART + 1, RLENGTH - 1)
  if (!length(name) || name ~ /[[:cntrl:]]/) { invalid = 1; next }
  width = geometry; sub(/\/.*/, "", width)
  sub(/^[0-9]+\/[0-9]+x/, "", geometry)
  height = geometry; sub(/\/.*/, "", height)
  sub(/^[0-9]+\/[0-9]+/, "", geometry)
  match(geometry, /^[+-][0-9]+/)
  x = substr(geometry, 1, RLENGTH) + 0
  y = substr(geometry, RLENGTH + 1) + 0
  if (width + 0 <= 0 || height + 0 <= 0 || id in rows) { invalid = 1; next }
  rows[id] = sprintf("%d\t%d\t%d\t%d\t%d\t%d\t%s", id, x, y, width, height, primary, name)
  count++
}
END {
  if (invalid || !count || count != expected) exit 3
  for (i = 0; i < count; i++) { if (!(i in rows)) exit 3; print rows[i] }
}
