import type { ArtifactStore } from "./artifact-store.ts";
import type { FunctionRuntimeManager, FnState } from "./runtime-state.ts";

export interface PendingActivation { activate: string[]; deactivate: string[]; }

export class FunctionContext {
  readonly injects: string[] = [];
  readonly continuationReasons: string[] = [];
  readonly pendingActivations: PendingActivation = { activate: [], deactivate: [] };

  constructor(
    private sessionID: string,
    private fnName: string,
    private rt: FunctionRuntimeManager,
    private artifacts: ArtifactStore,
    private lastAssistantMessage: string | null,
  ) {}

  private self(): FnState { return this.rt.init(this.sessionID, this.fnName, 1); }

  state = {
    get: (k: string): unknown => this.self().kv[k],
    set: (k: string, v: unknown): void => { this.self().kv[k] = v; this.rt.markDirty(); },
  };

  artifact = {
    read: (name: string) => this.artifacts.read(this.sessionID, name),
    write: (name: string, c: string) => this.artifacts.write(this.sessionID, name, c),
    append: (name: string, c: string) => this.artifacts.append(this.sessionID, name, c),
    exists: (name: string) => this.artifacts.exists(this.sessionID, name),
  };

  query = {
    lastMessage: () => this.lastAssistantMessage,
    state: (fn: string, k: string) => this.rt.get(this.sessionID, fn)?.kv[k],
    artifacts: () => this.artifacts.list(this.sessionID),
  };

  inject(content: string): void { this.injects.push(content); }
  requestContinuation(reason: string): void { this.continuationReasons.push(reason); }
  // TRANSITION sugar — self-deactivate enforced by the caller applying these.
  activate(fn: string): void { this.pendingActivations.activate.push(fn); }
  deactivate(fn: string): void { this.pendingActivations.deactivate.push(fn); }
}
