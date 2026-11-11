/^(WINDOW|X|Y|WIDTH|HEIGHT|SCREEN)=-?[0-9]+$/ {
  if ($1 in fields) invalid = 1
  fields[$1] = $2
}
END {
  if (invalid || length(fields) != 6 || fields["WINDOW"] != window || fields["SCREEN"] != screen || fields["WIDTH"] <= 0 || fields["HEIGHT"] <= 0) exit 3
  printf "%d %d %d %d\n", fields["X"], fields["Y"], fields["WIDTH"], fields["HEIGHT"]
}
