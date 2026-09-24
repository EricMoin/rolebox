import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The child CLI must use the same real session identity recorded by dispatch. */
export async function childSessionFile(directory: string, sessionId: string): Promise<string> {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const root = join(directory, ".rolebox", "pi-sessions", "native");
  mkdirSync(root, { recursive: true });
  const path = join(root, `${sessionId}.jsonl`);
  if (existsSync(path)) {
    if (SessionManager.open(path).getSessionId() !== sessionId) throw new Error("Pi child session identity mismatch");
    return path;
  }
  const manager = SessionManager.inMemory(directory, { id: sessionId });
  const header = manager.getHeader();
  if (header?.id !== sessionId) throw new Error("Pi did not create the requested child identity");
  writeFileSync(path, JSON.stringify(header) + "\n", { flag: "wx", mode: 0o600 });
  return path;
}
