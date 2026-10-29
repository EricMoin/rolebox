import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ISessionClient } from "../../ports/session-client.ts";
import type { Message, SessionInfo, SessionStatus } from "../../types.ts";
import { getSystem } from "../../system/index.ts";
import { DshSessionAdapter, type DshSessionEventLike, type DshSessionLike, type DshSessionStoreLike } from "./session.ts";
import { DshTeamSessionLease } from "./team-session-lease.ts";
import type { DshWorkerAgent } from "./graph-worker.ts";

export interface DshTeamAgentOptions {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  maxTokens?: number;
}

interface TeamPrompt {
  id: string;
  role: "user";
  content: Array<{ type: "text"; text: string }>;
  source: { kind: "rolebox"; form: "notice"; summary: string };
}

interface PendingMessage {
  readonly id: string;
  readonly source?: { readonly kind?: string };
  readonly content: readonly unknown[];
}

/** The live DSH agent operations required to execute a team turn. */
export interface DshTeamAgent {
  readonly id: string;
  readonly session: DshSessionLike;
  readonly status: "idle" | "running";
  readonly ctx?: NonNullable<DshWorkerAgent["ctx"]> & {
    on?(event: "agent/request", listener: (payload: unknown, next: () => Promise<DshTeamAgentOptions>) => Promise<DshTeamAgentOptions>): () => void;
  };
  readonly inbox: {
    readonly nextTurn: readonly PendingMessage[];
    readonly nextStep: readonly PendingMessage[];
    remove(messageId: string): boolean;
  };
  followup(message: TeamPrompt): void;
  inject(message: TeamPrompt): void;
  cancel(cause: { kind: "hook"; reason: string }, options?: { keepInbox?: boolean }): void;
  whenIdle(): Promise<void>;
}

export interface DshTeamAgentHandle {
  agent: DshTeamAgent;
  dispose(): Promise<void>;
}

type AgentSetup = (context: unknown, agent: DshTeamAgent) => void;

/** DSH's registry delegates create/resume to the mounted agent-loop factory. */
export interface DshTeamAgents {
  get(id: string): DshTeamAgent | undefined;
  create(options: {
    sessionId: string;
    meta: { cwd: string };
    agentOptions?: DshTeamAgentOptions;
    setup: AgentSetup;
    signal: AbortSignal;
  }): Promise<DshTeamAgentHandle>;
  resume(options: {
    resumeSessionId: string;
    agentOptions?: DshTeamAgentOptions;
    setup: AgentSetup;
    signal: AbortSignal;
  }): Promise<DshTeamAgentHandle>;
}

export interface DshTeamSessionAdapterOptions {
  directory: string;
  sessions: DshSessionStoreLike;
  agents: DshTeamAgents;
  /** Bind before publication so prompt, skill and permission readers see the role. */
  bindRole(sessionId: string, roleId: string): void;
  /** Detect user role changes on resident peers without overwriting their selection. */
  roleOf?(sessionId: string): string | null | undefined;
  /**
   * Resolve a role's CURRENT spawn options. Returning `undefined` means the
   * role is unknown (or is no longer a top-level candidate); a known role with
   * no `agentOptions` has no usable provider/model.
   */
  resolveRole(roleId: string): { agentOptions?: DshTeamAgentOptions } | undefined;
  /** Read resident or persisted history without creating a live agent. */
  readExecutionEvents(id: string): Promise<readonly DshSessionEventLike[] | undefined>;
}

interface Descriptor {
  version: 1;
  sessionId: string;
  roleId: string;
  directory: string;
  createdAt: number;
  agentOptions?: DshTeamAgentOptions;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Compare persisted and freshly resolved options so a descriptor is only rewritten on a real change. */
function sameAgentOptions(a: DshTeamAgentOptions | undefined, b: DshTeamAgentOptions | undefined): boolean {
  return a?.provider === b?.provider && a?.model === b?.model
    && a?.reasoningEffort === b?.reasoningEffort && a?.maxTokens === b?.maxTokens;
}

/** Options for a resolved role, or a clear refusal when the role cannot run a turn. */
function requireAgentOptions(roleId: string, role: { agentOptions?: DshTeamAgentOptions }): DshTeamAgentOptions {
  if (!role.agentOptions?.provider || !role.agentOptions.model) {
    throw new Error(`DSH team member role "${roleId}" has no usable provider/model; set model in its role.yaml or configure a host default model`);
  }
  return role.agentOptions;
}

function sessionEvents(session: DshSessionLike): readonly DshSessionEventLike[] {
  const current = session as unknown as { snapshotEvents?(): readonly DshSessionEventLike[] };
  return current.snapshotEvents ? current.snapshotEvents() : session.events;
}

function sessionDirectory(session: DshSessionLike): string | undefined {
  const change = [...sessionEvents(session)].reverse().find(event => event.type === "working-directory/change");
  if (!change) return session.header?.cwd;
  return record(change.data) && typeof change.data.cwd === "string" ? change.data.cwd : undefined;
}

async function materialize<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("DSH team session setup timed out")), 25_000);
  try { return await operation(controller.signal); } finally { clearTimeout(timer); }
}

function removePendingTeamDeliveries(agent: DshTeamAgent): void {
  for (const message of [...agent.inbox.nextTurn, ...agent.inbox.nextStep]) {
    const firstText = message.content.find(block => record(block) && block.type === "text");
    if (message.source?.kind === "rolebox" && record(firstText) && typeof firstText.text === "string"
      && firstText.text.startsWith("[rolebox-team ")) agent.inbox.remove(message.id);
  }
}

/** Independent, persistent DSH peers; the ordinary SessionStore cannot drive them. */
export class DshTeamSessionAdapter extends DshSessionAdapter {
  private readonly directory: string;
  private readonly leases: DshTeamSessionLease;
  private readonly handles = new Map<string, DshTeamAgentHandle>();
  private readonly loading = new Map<string, Promise<DshTeamAgent>>();
  private readonly forgetting = new Map<string, Promise<void>>();
  private readonly requestOptions = new Map<string, { agent: DshTeamAgent; options?: DshTeamAgentOptions }>();
  private readonly creating = new Set<Promise<SessionInfo | null>>();
  private stopped = false;

  constructor(private readonly options: DshTeamSessionAdapterOptions) {
    super(options.sessions);
    this.directory = resolve(options.directory);
    this.leases = new DshTeamSessionLease(this.directory);
  }

  private descriptorPath(id: string): string | undefined {
    if (!/^rolebox-team-[a-f0-9-]{36}$/.test(id)) return undefined;
    return join(this.directory, ".rolebox", "team-sessions", `${id}.json`);
  }

  private descriptor(id: string): Descriptor | undefined {
    const path = this.descriptorPath(id);
    if (!path) return undefined;
    let data: unknown;
    try { data = JSON.parse(readFileSync(path, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("Cannot read DSH team session descriptor", { cause: error });
    }
    if (!record(data) || data.version !== 1 || data.sessionId !== id || data.directory !== this.directory
      || typeof data.roleId !== "string" || !data.roleId || !Number.isSafeInteger(data.createdAt) || (data.createdAt as number) < 0
      || (data.agentOptions !== undefined && !record(data.agentOptions))) throw new Error("Invalid DSH team session descriptor");
    return data as unknown as Descriptor;
  }

  private saveDescriptor(descriptor: Descriptor): void {
    const path = this.descriptorPath(descriptor.sessionId)!;
    const directory = join(this.directory, ".rolebox", "team-sessions");
    mkdirSync(directory, { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    let file: number | undefined;
    try {
      file = openSync(temp, "wx", 0o600);
      writeFileSync(file, JSON.stringify(descriptor));
      fsyncSync(file);
      closeSync(file);
      file = undefined;
      renameSync(temp, path);
      if (getSystem().canSyncDirectoryEntries) {
        const directoryFd = openSync(directory, "r");
        try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      }
    } finally {
      if (file !== undefined) closeSync(file);
      rmSync(temp, { force: true });
    }
  }

  private async flush(session: DshSessionLike): Promise<void> {
    if (!this.options.sessions.flush || !await this.options.sessions.flush(session)) {
      throw new Error("DSH did not confirm durable team session storage");
    }
  }

  private setup(descriptor: Descriptor, resume: boolean): AgentSetup {
    return (_context, agent) => {
      if (this.stopped) throw new Error("DSH team adapter is disposed");
      if (agent.id !== descriptor.sessionId || resolve(sessionDirectory(agent.session) ?? "") !== this.directory) {
        throw new Error("DSH team session identity or workspace changed");
      }
      this.options.bindRole(descriptor.sessionId, descriptor.roleId);
      // A replay is authorized by TeamRuntime's new delivery, not by an old inbox.
      if (resume) removePendingTeamDeliveries(agent);
    };
  }

  override async create(input: Parameters<ISessionClient["create"]>[0]): Promise<SessionInfo | null> {
    const creation = this.createPeer(input);
    this.creating.add(creation);
    try { return await creation; } finally { this.creating.delete(creation); }
  }

  private async createPeer(input: Parameters<ISessionClient["create"]>[0]): Promise<SessionInfo | null> {
    if (this.stopped || resolve(input.directory) !== this.directory || !input.agent) return null;
    const role = this.options.resolveRole(input.agent);
    // A role without a usable provider/model would produce a dead peer session;
    // refuse it here so the runtime reports the role instead of a silent no-op.
    if (!role?.agentOptions?.provider || !role.agentOptions.model) return null;
    const id = `rolebox-team-${randomUUID()}`;
    const descriptor: Descriptor = { version: 1, sessionId: id, roleId: input.agent,
      directory: this.directory, createdAt: Date.now(), agentOptions: role.agentOptions };
    if (!this.leases.acquire(id)) return null;
    try {
      this.saveDescriptor(descriptor);
      this.options.bindRole(id, descriptor.roleId);
      const handle = await materialize(signal => this.options.agents.create({ sessionId: id, meta: { cwd: this.directory },
        agentOptions: descriptor.agentOptions, setup: this.setup(descriptor, false), signal }));
      this.handles.set(id, handle);
      if (this.stopped) { await handle.dispose(); this.handles.delete(id); throw new Error("DSH team adapter is disposed"); }
      await this.flush(handle.agent.session);
      return this.info(descriptor, sessionEvents(handle.agent.session));
    } catch (error) {
      const handle = this.handles.get(id);
      if (handle) { await handle.dispose(); this.handles.delete(id); }
      this.leases.release(id);
      throw error;
    }
  }

  private async live(id: string, expectedRole?: string): Promise<DshTeamAgent | undefined> {
    if (this.stopped) return undefined;
    if (this.forgetting.has(id)) throw new Error("DSH team session is being removed");
    const pending = this.loading.get(id);
    if (pending) {
      await pending;
      return this.live(id, expectedRole);
    }
    const descriptor = this.descriptor(id);
    if (!descriptor) return this.options.agents.get(id);
    if (expectedRole && descriptor.roleId !== expectedRole) throw new Error("DSH team member role changed");
    // The role is resolved FRESH on every load so a repaired role.yaml (or a
    // newly registered provider route) reaches an existing member on its next
    // resume instead of being pinned to the options recorded at creation.
    const role = this.options.resolveRole(descriptor.roleId);
    if (!role) throw new Error("DSH team role is no longer available");
    const agentOptions = requireAgentOptions(descriptor.roleId, role);
    if (!this.leases.acquire(id)) throw new Error("DSH team session is owned by another running host");
    const changed = !sameAgentOptions(descriptor.agentOptions, agentOptions);
    const resident = this.options.agents.get(id);
    if (resident) {
      if (this.options.roleOf && this.options.roleOf(id) !== descriptor.roleId) {
        throw new Error("DSH team member's active role changed; restore its assigned role before resuming the team");
      }
      if (!changed) return resident;
      if (resident.status !== "idle") throw new Error("DSH team member must be idle before changing its model");
      if (!this.handles.has(id)) throw new Error("DSH team session handle is not owned by this adapter");
      let current = this.requestOptions.get(id);
      if (!current || current.agent !== resident) {
        if (!resident.ctx?.on) throw new Error("DSH host cannot update a resident member's model");
        const override: { agent: DshTeamAgent; options?: DshTeamAgentOptions } = { agent: resident };
        // The driver reuses logged request config; this hook preserves its inbox while switching models.
        resident.ctx.on("agent/request", async (_payload, next) => {
          const proposed = await next();
          const selected = override.options;
          if (!selected) return proposed;
          const updated = { ...proposed, ...selected };
          if (selected.reasoningEffort === undefined) delete updated.reasoningEffort;
          if (selected.maxTokens === undefined) delete updated.maxTokens;
          return updated;
        });
        this.requestOptions.set(id, override);
        current = override;
      }
      this.saveDescriptor({ ...descriptor, agentOptions });
      current.options = { ...agentOptions };
      return resident;
    }
    const loading = Promise.resolve().then(async () => {
      try {
        if (changed) {
          descriptor.agentOptions = agentOptions;
          this.saveDescriptor(descriptor);
        }
        this.options.bindRole(id, descriptor.roleId);
        const handle = await materialize(signal => this.options.agents.resume({ resumeSessionId: id, agentOptions: descriptor.agentOptions,
          setup: this.setup(descriptor, true), signal }));
        this.handles.set(id, handle);
        if (this.stopped) { await handle.dispose(); this.handles.delete(id); throw new Error("DSH team adapter is disposed"); }
        await this.flush(handle.agent.session);
        return handle.agent;
      } catch (error) {
        const handle = this.handles.get(id);
        if (handle) { await handle.dispose(); this.handles.delete(id); }
        this.leases.release(id);
        throw error;
      }
    }).finally(() => { this.loading.delete(id); });
    this.loading.set(id, loading);
    return loading;
  }

  override async prompt(id: string, input: Parameters<ISessionClient["prompt"]>[1]): Promise<{ id: string } | null> {
    const agent = await this.live(id, input.agent);
    if (this.forgetting.has(id)) throw new Error("DSH team session is being removed");
    if (!agent || resolve(sessionDirectory(agent.session) ?? "") !== this.directory) return null;
    const text = input.parts.filter(part => part.type === "text").map(part => part.text).join("\n");
    if (!text) return null;
    const message: TeamPrompt = { id: randomUUID(), role: "user", content: [{ type: "text", text }],
      source: { kind: "rolebox", form: "notice", summary: text.split(/\r?\n/, 1)[0].slice(0, 120) } };
    if (input.noReply) agent.inject(message);
    else agent.followup(message);
    await this.flush(agent.session);
    return { id: message.id };
  }

  override async abort(id: string): Promise<boolean> {
    // The user's owning conversation belongs to the host and is never resumed here.
    if (!this.descriptor(id) || this.stopped || this.leases.isOwnedElsewhere(id)) return false;
    try {
      const agent = this.options.agents.get(id) ?? await this.live(id);
      if (!agent) return false;
      removePendingTeamDeliveries(agent);
      agent.cancel({ kind: "hook", reason: "rolebox team stopped" }, { keepInbox: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([agent.whenIdle(), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("DSH cancellation timed out")), 10_000);
        })]);
      } finally { if (timer) clearTimeout(timer); }
      if (agent.status !== "idle") return false;
      await this.flush(agent.session);
      return true;
    } catch { return false; }
  }

  /**
   * Release a removed member's team identity. Host-restored peers have no
   * adapter-owned handle, so they keep their session and pending user input.
   * A foreign lease defers cleanup until the owning host releases it.
   */
  async forget(id: string): Promise<void> {
    const path = this.descriptorPath(id);
    if (!path || this.stopped) return;
    const pending = this.forgetting.get(id);
    if (pending) return pending;
    if (!this.descriptor(id) || !this.leases.acquire(id)) return;
    const forgetting = Promise.resolve().then(async () => {
      await this.loading.get(id)?.catch(() => undefined);
      const handle = this.handles.get(id);
      const resident = this.options.agents.get(id);
      if (handle) {
        await handle.dispose();
        this.handles.delete(id);
        this.requestOptions.delete(id);
      } else if (resident) {
        removePendingTeamDeliveries(resident);
        await this.flush(resident.session);
      }
      rmSync(path, { force: true });
      this.leases.release(id);
    }).finally(() => { this.forgetting.delete(id); });
    this.forgetting.set(id, forgetting);
    return forgetting;
  }

  private async events(id: string): Promise<readonly DshSessionEventLike[] | undefined> {
    const session = this.options.sessions.get(id);
    if (session) {
      // Completion cannot advance a durable team cursor before its transcript is durable.
      await this.flush(session);
      return sessionEvents(session);
    }
    return this.options.readExecutionEvents(id);
  }

  override async status(id: string): Promise<SessionStatus | null> {
    if (this.descriptor(id) && this.leases.isOwnedElsewhere(id)) return { type: "busy" };
    const agent = this.options.agents.get(id);
    if (agent) return { type: agent.status === "running" ? "busy" : "idle" };
    // User conversations are only awakened after the host restores them.
    if (!this.descriptor(id)) return null;
    const events = await this.events(id);
    if (!events) return null;
    let busy = false;
    for (const event of events) {
      if (event.type === "turn/start") busy = true;
      else if (event.type === "turn/end") busy = false;
    }
    return { type: busy ? "busy" : "idle" };
  }

  override async messages(id: string, input?: { directory?: string; limit?: number }): Promise<Message[]> {
    const events = await this.events(id);
    if (!events) return [];
    const result: Message[] = [];
    events.forEach((event, index) => {
      const data = record(event.data) ? event.data : {};
      const eventId = `${id}:event:${event.seq ?? index}`;
      if (event.type === "turn/start") {
        result.push({ info: { id: eventId, sessionID: id, role: "user", time: { created: event.time } }, parts: [] });
      } else if (event.type === "turn/end") {
        const reason = record(data.reason) ? data.reason : {};
        const outcome = reason.kind === "completed" ? "succeeded"
          : reason.kind === "aborted" || reason.kind === "interrupted" ? "interrupted" : "failed";
        result.push({ info: { id: eventId, sessionID: id, role: "idle", finish: outcome,
          time: { created: event.time, completed: event.time },
          ...(outcome === "succeeded" ? {} : { error: reason.error ?? `DSH turn ended: ${String(reason.kind)}` }) }, parts: [] });
      } else if (event.type === "user/message" || event.type === "assistant/message") {
        const message = event.type === "user/message" ? data : record(data.message) ? data.message : undefined;
        if (!message || typeof message.id !== "string" || !Array.isArray(message.content)) return;
        const messageId = message.id;
        result.push({ info: { id: messageId, sessionID: id,
          role: event.type === "assistant/message" ? "assistant" : "user", time: { created: event.time } },
          parts: message.content.flatMap((block, partIndex) => record(block) && block.type === "text" && typeof block.text === "string"
            ? [{ id: `${messageId}:${partIndex}`, sessionID: id, messageID: messageId, type: "text" as const, text: block.text }] : []) });
      }
    });
    return input?.limit && input.limit > 0 ? result.slice(-input.limit) : result;
  }

  private info(descriptor: Descriptor, events: readonly DshSessionEventLike[]): SessionInfo {
    return { id: descriptor.sessionId, directory: descriptor.directory, projectID: "dsh", title: descriptor.roleId,
      version: "1", time: { created: descriptor.createdAt, updated: events.at(-1)?.time ?? descriptor.createdAt } };
  }

  override async get(id: string, directory?: string): Promise<SessionInfo | null> {
    const descriptor = this.descriptor(id);
    if (!descriptor) return super.get(id, directory);
    const events = await this.events(id);
    return events ? this.info(descriptor, events) : null;
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled(this.creating);
    await Promise.allSettled(this.loading.values());
    await Promise.allSettled(this.forgetting.values());
    const results = await Promise.allSettled([...this.handles.values()].map(handle => handle.dispose()));
    if (results.some(result => result.status === "rejected")) throw new Error("DSH team agents did not finish disposal");
    this.handles.clear();
    this.requestOptions.clear();
    this.leases.dispose();
  }
}
