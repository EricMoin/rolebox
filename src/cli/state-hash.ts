import { createHash } from "node:crypto";

export function stateFileHash(directory: string): string {
  return createHash("sha256").update(directory).digest("hex").slice(0, 12);
}
