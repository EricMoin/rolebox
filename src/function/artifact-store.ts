import { mkdirSync, readFileSync, existsSync, appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteSync, hashId } from "./fs-util.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("function:artifacts");

function safe(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}

export class ArtifactStore {
  constructor(private workspaceDir: string) {}

  private dir(sessionID: string): string {
    return join(this.workspaceDir, ".rolebox", "artifacts", hashId(sessionID));
  }

  private path(sessionID: string, name: string): string {
    return join(this.dir(sessionID), `${safe(name)}.md`);
  }

  exists(sessionID: string, name: string): boolean {
    const p = this.path(sessionID, name);
    try { return existsSync(p) && readFileSync(p, "utf-8").trim().length > 0; }
    catch { return false; }
  }

  read(sessionID: string, name: string): string | null {
    try { return readFileSync(this.path(sessionID, name), "utf-8"); }
    catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") log.warn("artifact read failed", { name, code });
      return null;
    }
  }

  write(sessionID: string, name: string, content: string): void {
    atomicWriteSync(this.path(sessionID, name), content);
  }

  append(sessionID: string, name: string, content: string): void {
    mkdirSync(this.dir(sessionID), { recursive: true });
    appendFileSync(this.path(sessionID, name), content, "utf-8");
  }

  list(sessionID: string): string[] {
    try {
      return readdirSync(this.dir(sessionID))
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.slice(0, -3));
    } catch { return []; }
  }
}
