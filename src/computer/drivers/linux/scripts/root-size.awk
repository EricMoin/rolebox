/^Screen [0-9]+:/ {
  for (i = 1; i <= NF; i++) {
    if ($i == "current" && $(i+1) ~ /^[0-9]+$/ && $(i+2) == "x" && $(i+3) ~ /^[0-9]+,$/) {
      width = $(i+1); height = $(i+3); sub(/,$/, "", height)
      if (width > 0 && height > 0) { printf "%d %d\n", width, height; found = 1; exit }
    }
  }
}
END { if (!found) exit 3 }
