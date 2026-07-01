import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, atomicWriteSync } from "../function/fs-util.ts";
import { shortHash } from "../state-paths.ts";
import type { LoopState } from "./types.ts";

interface FileShape {
  version: 1;
  loops: { id: string; state: LoopState }[];
}

export class LoopStore {
  private directory: string;
  private dirHash: string;
  private _lock: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    this.directory = directory;
    this.dirHash = shortHash(directory);
  }

  private statePath(): string {
    return join(this.directory, ".rolebox", "state", `loops-${this.dirHash}.json`);
  }

  private toFile(loops: Map<string, LoopState>): string {
    const entries = [...loops].map(([id, state]) => ({ id, state }));
    return JSON.stringify({ version: 1, loops: entries } satisfies FileShape, null, 2);
  }

  async save(loops: Map<string, LoopState>): Promise<void> {
    this._lock = this._lock.then(
      () => this._doSave(loops),
      () => this._doSave(loops),
    );
    return this._lock;
  }

  private async _doSave(loops: Map<string, LoopState>): Promise<void> {
    try {
      await atomicWrite(this.statePath(), this.toFile(loops));
    } catch {}
  }

  saveSync(loops: Map<string, LoopState>): void {
    try {
      atomicWriteSync(this.statePath(), this.toFile(loops));
    } catch {}
  }

  load(): Map<string, LoopState> | null {
    let raw: string;
    try {
      raw = readFileSync(this.statePath(), "utf-8");
    } catch {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as FileShape;
      if (parsed.version !== 1 || !Array.isArray(parsed.loops)) return null;
      const out = new Map<string, LoopState>();
      for (const entry of parsed.loops) {
        out.set(entry.id, entry.state);
      }
      return out;
    } catch {
      return null;
    }
  }
}
