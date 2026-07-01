/** Extract `<Name>...</Name>` content (case-insensitive, last wins). */
function extractXmlBlock(fullText: string, name: string): string | null {
  const openTag = `<${name}>`;
  const closeTag = `</${name}>`;
  const lower = fullText.toLowerCase();
  const openLower = openTag.toLowerCase();
  const closeLower = closeTag.toLowerCase();
  let last: string | null = null;
  let searchFrom = 0;
  while (true) {
    const start = lower.indexOf(openLower, searchFrom);
    if (start === -1) break;
    const contentStart = start + openTag.length;
    const end = lower.indexOf(closeLower, contentStart);
    if (end === -1) break;
    last = fullText.slice(contentStart, end).trim();
    searchFrom = end + closeTag.length;
  }
  return last;
}

/** Extract ` ```name\n...\n``` ` content (exact line match, last wins). */
function extractCodeFenceBlock(fullText: string, name: string): string | null {
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

/** Try XML tag first (`<Name>...</Name>`), fall back to code fence (` ```name `). */
export function extractResultBlockNamed(fullText: string, name: string): string | null {
  return extractXmlBlock(fullText, name) ?? extractCodeFenceBlock(fullText, name);
}
