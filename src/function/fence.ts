export function extractResultBlockNamed(fullText: string, name: string): string | null {
  const open = "```" + name;
  const lines = fullText.split("\n");
  let inFence = false, buf: string[] = [], last: string | null = null;
  for (const line of lines) {
    if (!inFence && line.trim() === open) { inFence = true; buf = []; }
    else if (inFence && line.trim() === "```") { last = buf.join("\n"); inFence = false; }
    else if (inFence) buf.push(line);
  }
  return last;
}
