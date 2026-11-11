function quote(value, out, i, character) {
  out = "\""
  for (i = 1; i <= length(value); i++) {
    character = substr(value, i, 1)
    if (character == "\"" || character == "\\") out = out "\\"
    out = out character
  }
  return out "\""
}
{
  printf "%s{\"id\":%d,\"x\":%d,\"y\":%d,\"width\":%d,\"height\":%d,\"scale\":1,\"primary\":%s,\"name\":%s}", (NR == 1 ? "[" : ","), $1, $2, $3, $4, $5, ($6 ? "true" : "false"), quote($7)
}
END { if (!NR) exit 3; print "]" }
