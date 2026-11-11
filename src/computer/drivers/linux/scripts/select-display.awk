$1 == wanted { printf "%d %d %d %d\n", $2, $3, $4, $5; found = 1 } END { if (!found) exit 3 }
