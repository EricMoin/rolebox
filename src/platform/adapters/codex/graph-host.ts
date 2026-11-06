import type { ResolvedRole } from "../../../types.ts";
import type { CanonicalToolDef } from "../../types.ts";
import { GraphApplication } from "../../../graph/application/graph-application.ts";
import { GraphWait } from "../../../graph/application/graph-wait.ts";
import { createGraphWaitTool } from "../../../graph/tools/wait.ts";
import { buildAttemptDeliveryPrompt, type HostDispatchDelivery, type DeliveredInputView } from "../../../graph/host/index.ts";
import type { OutcomeHost, HostExecutionObservation } from "../../../graph/host/outcome-host.ts";
import type { OutcomeDispatchEffectKey, OutcomeDispatchRequest } from "../../../graph/outcome/dispatch-effects.ts";
import { buildGraphWorkerToolGrantBlock, findGraphWorkerRole } from "../../../prompt/graph-worker.ts";
import { codexRecord } from "./app-server.ts";
import { CodexSessionAdapter } from "./session.ts";
import { GraphStore } from "../../../graph/store/graph-store.ts";
import { decodeStoredDefinition } from "../../../graph/persistence/declared-record.ts";
import { applyGraphControl } from "../../../graph/control/application.ts";
import { createSubLogger } from "../../../logger.ts";
import type { CodexParentNotifications } from "./parent-notifications.ts";

export interface CodexGraphHostOptions {
  directory: string;
  storeRoot: string;
  roles: readonly ResolvedRole[];
  sessions: CodexSessionAdapter;
  env?: Readonly<Record<string, string | undefined>>;
  parentNotifications?: CodexParentNotifications;
}

export class CodexGraphHost {
  readonly application: GraphApplication;
  readonly host: OutcomeHost;
  private closed = false;
  private readonly waits: GraphWait;
  private readonly deadlines = new Set<ReturnType<typeof setTimeout>>();
  private readonly log = createSubLogger("codex-graph");

  constructor(private readonly options: CodexGraphHostOptions) {
    const deliver: HostDispatchDelivery = (request, effect, invocation, inputView) => {
      if (this.closed) throw new Error("Codex graph host closed");
      options.sessions.assertLaunchable(invocation?.sessionId);
      if (request.toolPresentation && request.toolPresentation.mode !== "native") {
        throw new Error("Codex graph workers currently support native tool presentation only");
      }
      if (!request.agent || !findGraphWorkerRole(options.roles, request.agent)) {
        throw new Error("The graph worker role is not installed");
      }
      const timeout = this.timeoutOf(request);
      let expired = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeout !== undefined && timeout > 0) {
        const deadline = Date.now() + timeout;
        const arm = () => {
          timer = setTimeout(() => {
            this.deadlines.delete(timer!);
            if (this.closed) return;
            if (Date.now() < deadline) { arm(); return; }
            expired = true;
            void this.expire(request, invocation?.sessionId).catch(() => this.log.warn("Codex graph timeout could not be recorded"));
          }, Math.min(Math.max(0, deadline - Date.now()), 2_147_483_647));
          timer.unref();
          this.deadlines.add(timer);
        };
        arm();
      }
      void this.start(request, effect, invocation?.sessionId, inputView, () => expired).finally(() => {
        if (timer) { clearTimeout(timer); this.deadlines.delete(timer); }
      });
    };
    this.application = GraphApplication.open({
      workspaceDir: options.directory, storeRoot: options.storeRoot, env: options.env ?? process.env,
      ...(options.parentNotifications?.configured ? { notifications: {
        send: notice => options.parentNotifications!.send(notice),
      } } : {}),
      deliver, declareInvocationIdentity: false, workerSessionOf: execution => execution.executionId,
      workerTaskToolsOf: () => ["load_role_skill", "load_reference", "reference_search", "asset_search", "asset_inspect", "asset_validate"],
      observeExecution: execution => this.observe(execution.executionId),
      watchCompletion: (entry, onEnded) => {
        if (this.observe(entry.executionId).kind === "unknown") return "unsupported";
        void options.sessions.wait(entry.executionId).then(() => { if (!this.closed) onEnded(); }).catch(() => {});
        return "watching";
      },
      cancelExecution: { cancel: async probe => {
        const id = probe.execution?.executionId;
        if (!id) return { kind: "unsupported", reason: "The host has no confirmed Codex thread" };
        if (options.sessions.wasInterrupted(id)) return { kind: "confirmed", reason: "Codex reported the turn interrupted" };
        try {
          if (!await options.sessions.abort(id)) return { kind: "unsupported", reason: "Codex has no running owned turn to interrupt" };
          return options.sessions.wasInterrupted(id)
            ? { kind: "confirmed", reason: "Codex reported the turn interrupted" }
            : { kind: "requested", reason: "The interrupt is requested; no terminal event has arrived" };
        } catch { return { kind: "unsupported", reason: "The Codex interrupt request could not be delivered" }; }
      } },
    });
    this.host = this.application.host;
    this.waits = new GraphWait(options.storeRoot);
  }

  createTools(): Record<string, CanonicalToolDef> {
    const agentOf = (id?: string) => this.options.sessions.agentOf(id);
    const tools: Record<string, CanonicalToolDef> = {
      ...this.application.createTools(agentOf),
      ...this.host.bindTools({ graph_wait: createGraphWaitTool(this.waits) }, agentOf),
    };
    return Object.fromEntries(Object.entries(tools).map(([name, tool]) => [name, {
      ...tool,
      execute: async (input, context) => {
        if (!this.options.sessions.hasThreadIdentity(context.sessionID)) {
          throw new Error("Codex graph tools require host-supplied _meta.threadId. Update Codex and restart the MCP connection.");
        }
        if (name === "graph_declare") {
          this.options.sessions.assertLaunchable(context.sessionID);
          this.validateTargets(input.declaration, context.agent);
          const notification = await this.options.parentNotifications?.inspect(context.sessionID) ?? {
            available: false, reason: "No shared parent app-server connection is configured; use graph_wait.",
          };
          const result = await tool.execute(input, context);
          if (typeof result === "string") {
            try {
              const declaration = codexRecord(JSON.parse(result));
              if (declaration) return JSON.stringify({ ...declaration, parent_notification: notification }, null, 2);
            } catch { /* Preserve plain-text declaration errors. */ }
          }
          return result;
        }
        return tool.execute(input, context);
      },
    } satisfies CanonicalToolDef]));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const deadline of this.deadlines) clearTimeout(deadline);
    this.deadlines.clear();
    this.waits.close();
    this.application.close();
    this.options.parentNotifications?.close();
  }

  private observe(id: string): HostExecutionObservation {
    const reading = this.options.sessions.executionState(id);
    return reading.kind === "failed" || reading.kind === "unknown"
      ? { kind: reading.kind, reason: reading.reason ?? "Codex execution state unavailable" }
      : { kind: reading.kind };
  }

  private validateTargets(declaration: unknown, actor: string): void {
    let value = declaration;
    if (typeof value === "string") {
      try { value = JSON.parse(value); } catch { return; }
    }
    const nodes = codexRecord(value)?.nodes;
    if (!Array.isArray(nodes)) return;
    const own = findGraphWorkerRole(this.options.roles, actor);
    const allowed = new Set([...this.options.roles.map(role => role.id), ...(own?.subagents.map(child => child.id) ?? [])]);
    for (const node of nodes) {
      const record = codexRecord(node);
      if (typeof record?.agent === "string" && !allowed.has(record.agent)) {
        throw new Error("Codex graph targets must be public roles or a direct private child of the acting role");
      }
      const presentation = codexRecord(record?.toolPresentation);
      if (presentation && presentation.mode !== "native") {
        throw new Error("Codex graph workers currently support native tool presentation only");
      }
      const budget = codexRecord(record?.budget);
      if (budget && ["max_input_tokens", "max_output_tokens", "max_cost_usd"].some(key => key in budget)) {
        throw new Error("Codex graph workers do not yet report measured token/cost usage. Use execution-count and timeout budgets instead of token/cost ceilings.");
      }
    }
  }

  private timeoutOf(request: OutcomeDispatchRequest): number | undefined {
    const store = GraphStore.openFile(this.options.storeRoot);
    try {
      const row = store.readDefinition(request.graphId);
      const reading = row && decodeStoredDefinition(row);
      if (!reading || reading.kind !== "ok" || reading.declared.plan.planRevision !== request.planRevision) {
        throw new Error("The Codex worker's compiled budget could not be read");
      }
      return reading.declared.plan.nodes.find(node => node.id === request.nodeId)?.budget?.timeout_ms;
    } finally { store.close(); }
  }

  private async expire(request: OutcomeDispatchRequest, parentID?: string): Promise<void> {
    if (this.closed || !parentID) return;
    const store = GraphStore.openFile(this.options.storeRoot);
    try {
      const result = applyGraphControl(store, {
        graphId: request.graphId, nodeId: request.nodeId, attemptId: request.attemptId,
        command: "timeout", reason: "The Codex worker exceeded its declared timeout_ms",
        principal: { sessionId: parentID, agentId: this.options.sessions.agentOf(parentID) || undefined }, at: Date.now(),
      });
      if (result.kind === "applied") await this.host.deliverCancelIntents(request.graphId);
    } finally { store.close(); }
  }

  private stopped(request: OutcomeDispatchRequest): boolean {
    const store = GraphStore.openFile(this.options.storeRoot);
    try { return store.readStoppingDecision(request.graphId, request.attemptId) !== undefined; }
    finally { store.close(); }
  }

  private async start(request: OutcomeDispatchRequest, effect: OutcomeDispatchEffectKey, parentID?: string, inputView?: DeliveredInputView, expired: () => boolean = () => false): Promise<void> {
    try {
      const session = await this.options.sessions.create({ directory: this.options.directory, agent: request.agent, parentID });
      if (!session) throw new Error("Codex did not create a worker thread");
      if (this.closed) { await this.options.sessions.abort(session.id); return; }
      if (!this.host.confirmExecution(effect, { executionId: session.id })) {
        throw new Error("The Codex execution could not be bound to this attempt");
      }
      if (expired() || this.stopped(request)) { await this.host.deliverCancelIntents(request.graphId); return; }
      await this.options.sessions.prompt(session.id, { parts: [{ type: "text", text:
        buildAttemptDeliveryPrompt(request, inputView) + "\n\n" +
        buildGraphWorkerToolGrantBlock(request.declaredTools, request.toolPresentation) +
        "\nUse native Codex tools for file and shell operations. The rolebox dynamic tools expose outcome submission and role-scoped resource reads only.",
      }] });
      await this.options.sessions.wait(session.id);
      if (this.closed) return;
      const observation = this.host.recordExecutionObservation(request.graphId, request.attemptId);
      if (observation.kind === "failed") {
        await this.host.failObservedExecution(request.graphId, request.nodeId, request.attemptId);
      } else if (observation.kind === "completed") {
        await this.host.complete(request.graphId, request.attemptId);
      }
    } catch {
      if (!this.closed) this.host.reportDeliveryFailure(effect, "Codex worker delivery failed; the execution claim is retained. Inspect the app-server connection and retry explicitly.");
    }
  }
}
