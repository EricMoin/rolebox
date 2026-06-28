import { mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

function safe(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}

export class ArtifactStore {
  constructor(private workspaceDir: string) {}

  private dir(sessionID: string): string {
    const sid = createHash("sha256").update(sessionID).digest("hex").slice(0, 12);
    return join(this.workspaceDir, ".rolebox", "artifacts", sid);
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
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      return null;
    }
  }

  write(sessionID: string, name: string, content: string): void {
    const target = this.path(sessionID, name);
    mkdirSync(this.dir(sessionID), { recursive: true });
    const tmp = target + ".tmp";
    writeFileSync(tmp, content, "utf-8");
    try { unlinkSync(target); } catch {}
    renameSync(tmp, target);
  }

  append(sessionID: string, name: string, content: string): void {
    mkdirSync(this.dir(sessionID), { recursive: true });
    appendFileSync(this.path(sessionID, name), content, "utf-8");
  }

  list(sessionID: string): string[] {
    const d = this.dir(sessionID);
    try {
      const { readdirSync } = require("node:fs");
      return readdirSync(d).filter((f: string) => f.endsWith(".md")).map((f: string) => f.slice(0, -3));
    } catch { return []; }
  }
}
