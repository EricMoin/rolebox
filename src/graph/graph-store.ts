import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { createSubLogger } from "../logger.ts";
import type { GraphExecutionState } from "./state.ts";

export interface SerializedGraphSession {
  sessionId: string;
  agentId: string;
  state: GraphExecutionState;
}

interface GraphStateFile {
  version: 1;
  sessions: SerializedGraphSession[];
}

const log = createSubLogger("graph:store");

export class GraphStore {
  private directory: string;
  private dirHash: string;
  private _saveLock: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    this.directory = directory;
    this.dirHash = createHash("sha256").update(directory).digest("hex").slice(0, 12);
  }

  async save(
    sessions: Map<string, { agentId: string; state: GraphExecutionState }>,
  ): Promise<void> {
    this._saveLock = this._saveLock.then(
      () => this._doSave(sessions),
      () => this._doSave(sessions),
    );
    return this._saveLock;
  }

  private async _doSave(
    sessions: Map<string, { agentId: string; state: GraphExecutionState }>,
  ): Promise<void> {
    try {
      const { json, statePath, tmp } = this._prepareSave(sessions);
      await writeFile(tmp, json, "utf-8");
      this._commitSave(statePath, tmp);
    } catch (err) {
      log.warn("Failed to persist graph state", err);
    }
  }

  saveSync(
    sessions: Map<string, { agentId: string; state: GraphExecutionState }>,
  ): void {
    try {
      const { json, statePath, tmp } = this._prepareSave(sessions);
      writeFileSync(tmp, json, "utf-8");
      this._commitSave(statePath, tmp);
    } catch (err) {
      log.warn("Failed to persist graph state (sync)", err);
    }
  }

  private _prepareSave(
    sessions: Map<string, { agentId: string; state: GraphExecutionState }>,
  ): { json: string; statePath: string; tmp: string } {
    const json = this.serialize(sessions);
    const statePath = this.getStatePath();
    mkdirSync(join(statePath, ".."), { recursive: true });
    return { json, statePath, tmp: statePath + ".tmp" };
  }

  private _commitSave(statePath: string, tmp: string): void {
    try { unlinkSync(statePath); } catch {}
    renameSync(tmp, statePath);
  }

  load(): Map<string, { agentId: string; state: GraphExecutionState }> | null {
    let raw: string;
    try {
      raw = readFileSync(this.getStatePath(), "utf-8");
    } catch (err: unknown) {
      if (isErrnoException(err) && err.code === "ENOENT") {
        return null;
      }
      log.warn("Failed to read graph state file", err);
      return null;
    }

    const parsed = this.deserialize(raw);
    if (!parsed) return null;

    if (parsed.version !== 1) {
      log.warn(
        `Unsupported graph state schema version ${parsed.version}, starting fresh`,
      );
      return null;
    }

    const map = new Map<string, { agentId: string; state: GraphExecutionState }>();
    for (const raw of parsed.sessions as unknown[]) {
      if (!isValidSession(raw)) {
        const id = typeof raw === "object" && raw !== null && "sessionId" in raw
          ? String((raw as Record<string, unknown>).sessionId)
          : "unknown";
        log.warn(`Skipping corrupt session entry "${id}"`);
        continue;
      }
      map.set(raw.sessionId, { agentId: raw.agentId, state: raw.state });
    }
    return map;
  }

  clear(): void {
    try {
      unlinkSync(this.getStatePath());
    } catch {}
  }

  private getStatePath(): string {
    return join(this.directory, ".rolebox", "state", `graph-${this.dirHash}.json`);
  }

  private serialize(
    sessions: Map<string, { agentId: string; state: GraphExecutionState }>,
  ): string {
    const serialized: SerializedGraphSession[] = [];
    for (const [sessionId, entry] of sessions) {
      serialized.push({
        sessionId,
        agentId: entry.agentId,
        state: entry.state,
      });
    }

    const file: GraphStateFile = {
      version: 1,
      sessions: serialized,
    };

    return JSON.stringify(file, null, 2);
  }

  private deserialize(data: string): GraphStateFile | null {
    try {
      const parsed = JSON.parse(data) as unknown;
      if (!isGraphStateFile(parsed)) {
        log.warn("Corrupt graph state file format, starting fresh");
        return null;
      }
      return parsed;
    } catch {
      log.warn("Corrupt graph state file (JSON parse error), starting fresh");
      return null;
    }
  }
}

function isGraphStateFile(value: unknown): value is GraphStateFile {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (obj.version !== 1) return false;
  if (!Array.isArray(obj.sessions)) return false;
  return true;
}

const VALID_STATUSES = new Set(["active", "complete", "exhausted"]);

function isValidSession(value: unknown): value is SerializedGraphSession {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.sessionId !== "string") return false;
  if (typeof obj.agentId !== "string") return false;
  if (typeof obj.state !== "object" || obj.state === null) return false;
  const state = obj.state as Record<string, unknown>;
  if (!Array.isArray(state.frontier)) return false;
  if (!Array.isArray(state.completed)) return false;
  if (typeof state.iterationCount !== "number") return false;
  if (!VALID_STATUSES.has(state.status as string)) return false;
  return true;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
