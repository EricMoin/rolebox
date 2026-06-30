/**
 * Extract the contents of a fenced block opened by ```{name} and closed by ```.
 * When several such blocks exist the LAST one wins (the assistant typically
 * restates the final version last). Only exact triple-backtick fences on their
 * own line are recognized — longer (````) or indented fences are ignored.
 * Returns null when no matching block is found.
 */
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
