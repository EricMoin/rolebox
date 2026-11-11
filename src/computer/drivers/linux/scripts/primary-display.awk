NR == 1 { fallback = sprintf("%d %d %d %d", $2, $3, $4, $5) } $6 == 1 { selected = sprintf("%d %d %d %d", $2, $3, $4, $5) } END { print (selected == "" ? fallback : selected) }
