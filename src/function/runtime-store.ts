import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, atomicWriteSync, hashId } from "./fs-util.ts";
import type { FnState } from "./runtime-state.ts";

interface FileShape {
  version: 1;
  sessions: { sessionId: string; fns: { name: string; state: FnState }[] }[];
}

export class FunctionRuntimeStore {
  private directory: string;
  private dirHash: string;
  private _lock: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    this.directory = directory;
    this.dirHash = hashId(directory);
  }

  private statePath(): string {
    return join(this.directory, ".rolebox", "state", `fnstate-${this.dirHash}.json`);
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
      await atomicWrite(this.statePath(), this.toFile(states));
    } catch {}
  }

  saveSync(states: Map<string, Map<string, FnState>>): void {
    try {
      atomicWriteSync(this.statePath(), this.toFile(states));
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
