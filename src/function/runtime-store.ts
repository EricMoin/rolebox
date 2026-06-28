import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { getDataDir } from "../cli/paths.ts";
import type { FnState } from "./runtime-state.ts";

interface FileShape {
  version: 1;
  sessions: { sessionId: string; fns: { name: string; state: FnState }[] }[];
}

export class FunctionRuntimeStore {
  private dirHash: string;
  private _lock: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    this.dirHash = createHash("sha256").update(directory).digest("hex").slice(0, 12);
  }

  private statePath(): string {
    return join(getDataDir(), "state", `fnstate-${this.dirHash}.json`);
  }

  private toFile(states: Map<string, Map<string, FnState>>): string {
    const sessions = [...states].map(([sessionId, fns]) => ({
      sessionId,
      fns: [...fns].map(([name, state]) => ({ name, state })),
    }));
    return JSON.stringify({ version: 1, sessions } satisfies FileShape, null, 2);
  }

  async save(states: Map<string, Map<string, FnState>>): Promise<void> {
    this._lock = this._lock.then(
      () => this._doSave(states),
      () => this._doSave(states),
    );
    return this._lock;
  }

  private async _doSave(states: Map<string, Map<string, FnState>>): Promise<void> {
    try {
      const p = this.statePath();
      const stateDir = join(p, "..");
      mkdirSync(stateDir, { recursive: true });

      const tmp = p + ".tmp";
      await writeFile(tmp, this.toFile(states), "utf-8");

      try {
        unlinkSync(p);
      } catch {}

      renameSync(tmp, p);
    } catch {}
  }

  saveSync(states: Map<string, Map<string, FnState>>): void {
    try {
      const p = this.statePath();
      const stateDir = join(p, "..");
      mkdirSync(stateDir, { recursive: true });

      const tmp = p + ".tmp";
      writeFileSync(tmp, this.toFile(states), "utf-8");

      try {
        unlinkSync(p);
      } catch {}

      renameSync(tmp, p);
    } catch {}
  }

  load(): Map<string, Map<string, FnState>> | null {
    let raw: string;
    try {
      raw = readFileSync(this.statePath(), "utf-8");
    } catch {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as FileShape;
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) return null;
      const out = new Map<string, Map<string, FnState>>();
      for (const s of parsed.sessions) {
        const m = new Map<string, FnState>();
        for (const f of s.fns) m.set(f.name, f.state);
        out.set(s.sessionId, m);
      }
      return out;
    } catch {
      return null;
    }
  }
}
