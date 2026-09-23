/**
 * DshDispatchAdapter — dsh dispatch seam for loop mode.
 *
 * When rolebox runs as a dsh (DeepSeek Harness) cordis plugin, loop worker
 * rounds must go through dsh services instead of the opencode SDK client. This
 * adapter implements {@link IDispatchAdapter} (`src/loop/dispatch-adapter.ts`),
 * the seam the loop coordinator uses to drive rounds, over the same dsh
 * services.
 *
 * The adapter's former graph-node surface (`NodeDispatchPort.executeNode`) was
 * deleted with the legacy graph runtime; a declared (outcome-protocol) graph is
 * dispatched by the host capability layer (`src/graph/host/dispatch-host.ts`),
 * not through this loop adapter.
 *
 * ── Per-role agent mapping ────────────────────────────────────────────────
 * A loop round's `agent` IS the rolebox agent id registered by
 * {@link DshAgentRegistrar} (`agent-registrar.ts`) — the registrar registers
 * one `SubagentProvider` per `AgentDefinition` keyed by `definition.id`. The
 * adapter therefore resolves the agent directly as the provider name for
 * `SubagentRuntime.start`; when the agent is not registered the start rejects
 * with a descriptive error. Per-role tool allowlists / model overrides are
 * applied by the registrar's provider at spawn time (capabilities.toolFilter /
 * agentOptions merge) — not duplicated here.
 *
 * ── Graceful degradations (documented) ───────────────────────────────────
 *   - Per-run hard timeout: dsh's `SubagentStartRequest` has no
 *     `timeout_ms` field (the dsh vocabulary is `agentOptions.maxTokens`).
 *     A round that declares `timeoutMs` is enforced with an AbortController
 *     timer (abort signal + dispose) that settles the run as `timeout`.
 *   - `injectNote` (loop progress markers): dsh has no `prompt` on the
 *     SessionStore (`DshSessionAdapter.prompt` returns null — prompting is
 *     driven by the dsh agent loop), so it is a no-op.
 *   - Result sidecars: the dsh run's output ContentBlocks are materialized to
 *     `{directory}/.rolebox/state/results/{taskId}.txt` (the same layout the
 *     opencode sidecar uses) so the loop `loop_output` tool reads round
 *     results. When the sidecar write fails the MaterializedResultRef carries a
 *     `fetchError` and readers degrade.
 *
 * This module does NOT import from any host SDK — neither the opencode
 * plugin/SDK nor any dsh package. The dsh surface is consumed structurally
 * (duck-typed) against the shapes verified in `docs/dsh-plugin-contract.md`
 * §4.1/§4.3, so a fake dsh service double can drive it in tests.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Fire-once termination listener signature (the loop coordinator's contract). */
type TaskTerminatedCallback = (taskId: string, status: string) => void;
import type {
  DispatchTask,
  MaterializedResultRef,
} from "../../../dispatch/types.ts";
import type { IDispatchAdapter } from "../../../loop/dispatch-adapter.ts";
import { SUMMARY_INPUT_CHAR_CAP } from "../../../loop/constants.ts";
import type { ISessionClient } from "../../ports/session-client.ts";
import type {
  DshContentBlock,
  DshSubagentProvider,
  DshSubagentResult,
  DshSubagentRun,
  DshSubagentRuntime,
  DshSubagentStartRequest,
} from "./agent-registrar.ts";
import { extractResultBlock, writeResultSidecar } from "../../../dispatch/completion/result-extractor.ts";
import { sessionSignalLedger } from "../../../signal/session-signal-ledger.ts";
import { SYNTHETIC_ANSWER_SIGNAL } from "../../../signal/signal-constants.ts";
import { createSubLogger } from "../../../logger.ts";

// Re-exported for existing consumers/tests that import the run-result shape
// from the dispatch module; the single declaration lives in agent-registrar.ts.
export type { DshSubagentResult } from "./agent-registrar.ts";

// ── Structural dsh types for the dispatch seam (contract §4.3) ──────────────

/**
 * The dsh `SubagentRuntime` surface the dispatch path consumes. A superset of
 * {@link DshSubagentRuntime} (the registrar's catalog seam) — adds `start`,
 * which routes to the registered provider for the given name. Consumed
 * structurally so the real `ctx.subagents` service and a test double both
 * satisfy it.
 */
export interface DshSubagentDispatchRuntime extends DshSubagentRuntime {
  /** Start a subagent run through the named provider (§4.3 `start`). */
  start(name: string, request: DshSubagentStartRequest): Promise<DshSubagentRun>;
}

/**
 * dsh `SubagentResult` — the terminal outcome a `SubagentRun.result` promise
 * resolves with. The single structural declaration lives in
 * `agent-registrar.ts` (`DshSubagentResult`) so `DshSubagentRun.result` is
 * typed and the dispatch adapter reads it without a cast ; this module
 * re-exports it for existing consumers.
 */

// ── Errors ──────────────────────────────────────────────────────────────────

/**
 * Thrown when a dsh dispatch cannot resolve a live parent `Agent` for the
 * spawn's parent session.
 *
 * dsh declares `SubagentStartRequest.parent` REQUIRED (`readonly parent:
 * Agent` — `dsh-subagent/lib/types/types.d.ts:101`) and the in-process driver
 * dereferences it (`parent.ctx` / `parent.session` / `parent.options`) while
 * composing the child. Rolebox therefore fails loud here instead of forwarding
 * `parent: undefined` and letting a real provider raise an opaque `TypeError`
 * at spawn.
 */
export class DshParentUnresolvedError extends Error {
  /** The parent/origin session id that did not resolve to a live agent. */
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(
      `dsh dispatch: no live parent agent resolved for session "${sessionId}" ` +
        `(SubagentStartRequest.parent requires an Agent; wire a parentResolver ` +
        `over the live-agent registry ctx.agents)`,
    );
    this.name = "DshParentUnresolvedError";
    this.sessionId = sessionId;
  }
}

// ── Options ─────────────────────────────────────────────────────────────────

/** Options for constructing a {@link DshDispatchAdapter}. */
export interface DshDispatchAdapterOptions {
  /**
   * The dsh subagent seam (`ctx.subagents`, a `SubagentRuntime`). Injected so
   * the adapter stays SDK-free; tests inject a fake double.
   */
  subagents: DshSubagentDispatchRuntime;
  /**
   * Optional dsh session client (`DshSessionAdapter` over `ctx.sessions`).
   * Used to read origin-session summaries for loop rounds
   * (`readOriginSummary` / `getLastMessageId`). Absent → those methods return
   * empty/undefined (documented degradation).
   */
  sessionClient?: ISessionClient;
  /**
   * Resolve the live parent `Agent` for a spawn from the session it runs under
   * (`parentSessionId`). dsh declares `SubagentStartRequest.parent` REQUIRED
   * (`readonly parent: Agent` — `dsh-subagent/lib/types/types.d.ts:101`) and
   * the in-process driver dereferences it (`parent.ctx` / `parent.session` /
   * `parent.options`) while composing the child, so a parent-less start is a
   * hard failure — never a graceful degradation.
   *
   * The adapter resolves the parent BEFORE building the start request and
   * fails loud with {@link DshParentUnresolvedError} when this returns
   * `undefined`/`null` (or when no resolver is wired at all). Wire it from the
   * probed live-agent registry: `(sid) => registry?.get(sid)`.
   */
  parentResolver?: (sessionId: string) => unknown;
  /**
   * Optional workspace directory for result sidecars
   * (`{directory}/.rolebox/state/results/`). Defaults to `process.cwd()`.
   */
  directory?: string;
  /** Optional logger name override. */
  loggerName?: string;
}

// ── Internal registry ───────────────────────────────────────────────────────

/** Per-run bookkeeping shared by the graph port and the loop adapter. */
interface DshTaskEntry {
  /** The live DispatchTask record (status mutates as the run settles). */
  task: DispatchTask;
  /** The dsh run handle (`SubagentRun` — dispose() is the abort surface). */
  run: DshSubagentRun;
  /** One-time termination listeners (fire-once semantics). */
  listeners: Set<TaskTerminatedCallback>;
  /**
   * Settles when the task reaches a terminal status. Deliberately NOT tied to
   * the run's `result` promise — a cancelled/aborted run may never settle its
   * result promise (the provider resolves it only on genuine completion), so
   * `getRoundResult` must not hang on cancellation.
   */
  done: Promise<void>;
  /** Resolves {@link DshTaskEntry.done} (terminal settle). */
  doneResolve: () => void;
}

/** A tiny deferred helper (settle `done` independently of run.result). */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Dispatch statuses that end a task. */
const TERMINAL_STATUSES = new Set<string>([
  "completed",
  "error",
  "cancelled",
  "timeout",
]);

/** Default parent session id when the engine supplies no parent context. */
const DEFAULT_PARENT_SESSION_ID = "dsh";

// ── Adapter ─────────────────────────────────────────────────────────────────

/**
 * dsh-backed dispatch seam implementing {@link NodeDispatchPort} (graph
 * engine) AND {@link IDispatchAdapter} (loop coordinator).
 *
 * The two surfaces share one internal run registry:
 *   - `executeNode` / `dispatchRound` start a dsh subagent run and register it.
 *   - the run's `result` promise settles the task: stopReason → DispatchTask
 *     status (completed/error/cancelled/timeout), output materialized to a
 *     sidecar on completion.
 *   - `onTaskTerminated` / `registerTerminatedListener` bridge run settlement
 *     into the engine's dispatch→signal seam (immediate-fire guard mirrors
 *     `DispatchManager.onTaskTerminated`).
 *   - `cancelTask` / `cancelRound` map to the dsh abort surface: abort the
 *     run's signal + `run.dispose()`, settle as `cancelled`.
 *
 * `getSessionUsage` is intentionally absent (dsh has no budget accounting —
 * the engine's `captureNodeUsage` guards on absence).
 */
export class DshDispatchAdapter implements IDispatchAdapter {
  private readonly tasks = new Map<string, DshTaskEntry>();
  private readonly log;
  private readonly directory: string;
  /**
   * Dispatch-parent index: child session id (a `SubagentRun.id`) → the REAL
   * live parent session recorded at spawn (`liveParentSessionId`). Lets a
   * caller walk a dispatched child's session chain up to the outermost live
   * session (see {@link resolveSessionChain}). Entries are never evicted (the
   * run registry itself is lifetime-long), so a chain resolved after the child
   * agent's session has ended still resolves.
   */
  private readonly childToParent = new Map<string, string>();

  constructor(private readonly opts: DshDispatchAdapterOptions) {
    this.log = createSubLogger(opts.loggerName ?? "dsh-dispatch");
    this.directory = opts.directory ?? process.cwd();
  }

  // ── Shared run lifecycle ─────────────────────────────────────────────────

  /**
   * Start a dsh subagent run for an agent, register it, and wire settlement.
   *
   * `agent` is the rolebox agent id — it IS the provider name registered by
   * {@link DshAgentRegistrar} (per-role agent mapping). When the provider is
   * missing the start rejects with a descriptive error; graph dispatch
   * failures are contained by the engine and escalate the node.
   *
   * @param agent               Rolebox agent id (== dsh provider name).
   * @param prompt              The prompt text for the subagent.
   * @param description         Human-readable label (run `label`).
   * @param parentSessionId     Context session carried onto the task record AND
   *                            the start request's `sessionId` (the registrar's
   *                            per-session active-role key). Unchanged by the
   *                            parent-resolution split.
   * @param liveParentSessionId REAL platform session used to resolve the live
   *                            parent `Agent` via `parentResolver`. Equals
   *                            `parentSessionId` on the loop path; on the graph
   *                            path it is the graph's live parent session
   *                            (`parentContext.parentSessionId`) rather than the
   *                            graph-scoped budget key.
   * @param timeoutMs           Optional per-run hard timeout — enforced with an
   *                            AbortController timer (dsh has no native
   *                            `timeout_ms` on the start request).
   */
  private async startRun(
    agent: string,
    prompt: string,
    description: string | undefined,
    parentSessionId: string,
    liveParentSessionId: string,
    timeoutMs?: number,
  ): Promise<DispatchTask> {
    // Per-role agent mapping guard: resolve the provider the registrar
    // registered for this agent id. A missing provider fails fast with a
    // descriptive error (the engine escalates the node) instead of a generic
    // dsh "no provider" rejection.
    if (this.opts.subagents.getProvider) {
      const provider = this.opts.subagents.getProvider(agent);
      if (!provider) {
        const known = this.opts.subagents.list?.() ?? [];
        throw new Error(
          `dsh dispatch: no subagent provider registered for agent "${agent}" ` +
            `(registered: ${known.length > 0 ? known.join(", ") : "none"})`,
        );
      }
    }

    // dsh REQUIRES a live parent Agent on every start request and the
    // in-process driver dereferences it while composing the child. Resolve it
    // from the parent/origin session BEFORE building the request; fail loud
    // when it is unresolvable (missing registry entry or no resolver wired)
    // rather than shipping `parent: undefined`.
    const parent = this.opts.parentResolver?.(liveParentSessionId);
    if (parent === undefined || parent === null) {
      throw new DshParentUnresolvedError(liveParentSessionId);
    }

    const controller = new AbortController();
    const request: DshSubagentStartRequest = {
      label: description,
      prompt: [{ type: "text", text: prompt }],
      parent,
      signal: controller.signal,
      // rolebox extension: carry the CONTEXT session onto the spawn so the
      // registered provider (DshAgentRegistrar.buildProvider) can apply the
      // per-session ACTIVE role at spawn time. On the loop path this is the
      // origin dsh session id (matches the web dock's key). The live parent
      // `Agent` (dsh requires one) is resolved separately from
      // `liveParentSessionId` above, so the context session key and the parent
      // Agent never have to be the same value. Graph dispatch does not run
      // through this adapter (the host layer dispatches it).
      sessionId: parentSessionId,
    };
    const run = await this.opts.subagents.start(agent, request);

    const id = run.id;
    // Record the dispatch-parent edge BEFORE any settlement can fire so the
    // chain is resolvable even if the run completes immediately (a subagent
    // that drives a graph run ends its turn at once).
    this.childToParent.set(id, liveParentSessionId);
    const task: DispatchTask = {
      id,
      sessionId: id,
      parentSessionId,
      depth: 0,
      status: "running",
      agent,
      prompt,
      description,
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
      priority: 0,
    };
    const done = deferred<void>();
    const entry: DshTaskEntry = {
      task,
      run,
      listeners: new Set(),
      done: done.promise,
      doneResolve: done.resolve,
    };
    this.tasks.set(id, entry);
    // Fire-and-forget: translate the run's result into a task status when the
    // provider settles it. The registry's `done` is resolved separately by the
    // terminal-settle paths, so cancellation never hangs `getRoundResult`.
    void this.wireRunSettlement(id, run);

    // Per-run hard timeout (node `budget.timeout_ms` / loop round timeout).
    // dsh's SubagentStartRequest has no native timeout field — enforce with a
    // timer that settles the run as `timeout` (documented degradation for the
    // missing native capability).
    if (timeoutMs !== undefined && timeoutMs > 0) {
      const timer = setTimeout(() => {
        this.forceSettle(
          id,
          "timeout",
          `dsh subagent run exceeded its ${timeoutMs}ms timeout`,
        );
      }, timeoutMs);
      if (typeof timer === "object" && timer !== null && "unref" in timer) {
        (timer as { unref?: () => unknown }).unref?.();
      }
    }

    this.log.debug("dsh subagent run started", { id, agent, description });
    return task;
  }

  /**
   * Wire the run's `result` promise into the registry: on settle, translate
   * the dsh stopReason into a DispatchTask status, materialize output, and
   * fire termination listeners. Fire-and-forget — the returned promise never
   * rejects (both handlers contain their work).
   */
  private wireRunSettlement(id: string, run: DshSubagentRun): Promise<void> {
    return Promise.resolve(run.result).then(
      (value) => {
        this.settleFromResult(id, value);
      },
      (err) => {
        this.log.warn("dsh subagent run result rejected", {
          id,
          error: err instanceof Error ? err.message : String(err),
        });
        this.settleError(id, err);
      },
    );
  }

  /** Translate a resolved dsh SubagentResult into a task status + output. */
  private settleFromResult(id: string, result: DshSubagentResult): void {
    const entry = this.tasks.get(id);
    if (!entry || entry.task.status !== "running") return; // superseded/cancelled
    const task = entry.task;
    const outputText = blocksToText(result?.output ?? []);
    switch (result?.stopReason) {
      case "completed": {
        task.status = "completed";
        task.completedAt = new Date();
        task.result = this.materialize(id, outputText);
        this.recordTerminatingSignal(task);
        break;
      }
      case "aborted":
        task.status = "cancelled";
        task.completedAt = new Date();
        break;
      case "max-tokens":
        task.status = "timeout";
        task.completedAt = new Date();
        task.error = outputText || "dsh subagent exceeded max-tokens";
        break;
      case "error":
      case "refusal":
      default: {
        task.status = "error";
        task.completedAt = new Date();
        task.error =
          outputText ||
          (result?.stopReason === "refusal"
            ? "dsh subagent refused the task"
            : "dsh subagent errored");
        break;
      }
    }
    this.log.debug("dsh subagent run settled", { id, status: task.status });
    // Best-effort run cleanup (the dsh abort surface) after settlement.
    void entry.run.dispose().catch(() => undefined);
    this.finishTerminal(id);
  }

  /**
   * Record the run's terminating signal on the task before it settles, with
   * parity to the completion evaluator (`completion-evaluator.ts` sets
   * `task.terminatingSignal` on the in-process / opencode / pi paths). The dsh
   * adapter settles its own tasks, so it makes the same assignment instead of
   * diverging from the other paths.
   *
   * The field's only reader was the deleted legacy engine's
   * `mapDispatchStatusToSignal`; it is kept as the dispatch-level record of the
   * task's terminating signal (and as the parity `tests/dsh-dispatch.test.ts`
   * pins), with no surviving consumer.
   *
   * Infallible by construction: settlement is fire-and-forget and must never
   * reject (see {@link wireRunSettlement}), so a throwing ledger falls back to
   * the same synthetic answer the completion evaluator uses.
   */
  private recordTerminatingSignal(task: DispatchTask): void {
    let signal: { type: string; payload: unknown } | null = null;
    try {
      signal = sessionSignalLedger.getTerminating(task.sessionId);
    } catch (err) {
      // Defensive: a broken ledger must not break settlement — degrade to the
      // synthetic answer below rather than propagating out of a settle path.
      this.log.debug("dsh terminating-signal ledger lookup failed", {
        id: task.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    task.terminatingSignal = signal ?? SYNTHETIC_ANSWER_SIGNAL;
  }

  /** Settle a run as `error` from a rejected result promise (defensive). */
  private settleError(id: string, err: unknown): void {
    const entry = this.tasks.get(id);
    if (!entry || entry.task.status !== "running") return;
    entry.task.status = "error";
    entry.task.completedAt = new Date();
    entry.task.error =
      err instanceof Error ? err.message : `dsh subagent run failed: ${String(err)}`;
    void entry.run.dispose().catch(() => undefined);
    this.finishTerminal(id);
  }

  /**
   * Force a terminal status onto a still-running task (cancellation and the
   * per-run timeout timer). No-op for an unknown or already-terminal task.
   */
  private forceSettle(id: string, status: "cancelled" | "timeout", reason: string): void {
    const entry = this.tasks.get(id);
    if (!entry || entry.task.status !== "running") return;
    entry.task.status = status;
    entry.task.completedAt = new Date();
    entry.task.error = reason;
    void entry.run.dispose().catch(() => undefined);
    this.log.debug("dsh subagent run force-settled", { id, status, reason });
    this.finishTerminal(id);
  }

  /**
   * Terminal-settle funnel: fire the termination listeners and resolve the
   * registry's `done` promise (so `getRoundResult` never hangs on a run whose
   * result promise the provider left unsettled after abort).
   */
  private finishTerminal(id: string): void {
    const entry = this.tasks.get(id);
    if (!entry) return;
    entry.doneResolve();
    this.fireTerminated(id);
  }

  /** Fire every one-time termination listener for a settled task, then clear. */
  private fireTerminated(id: string): void {
    const entry = this.tasks.get(id);
    if (!entry) return;
    const status = entry.task.status;
    for (const cb of [...entry.listeners]) {
      try {
        cb(id, status);
      } catch {
        // Swallow — same policy as DispatchManager.notifyTerminated.
      }
    }
    entry.listeners.clear();
  }

  /**
   * Materialize the run's output text to a sidecar file
   * (`{directory}/.rolebox/state/results/{taskId}.txt`, the shared layout).
   * Best-effort — a failed write degrades to a `fetchError` ref.
   */
  private materialize(id: string, text: string): MaterializedResultRef {
    const ref: MaterializedResultRef = {
      sidecarPath: join(this.directory, ".rolebox", "state", "results", `${id}.txt`),
      totalChars: text.length,
      hadFence: extractResultBlock(text).hadFence,
      materializedAt: Date.now(),
    };
    try {
      writeResultSidecar(id, text, this.directory);
    } catch (err) {
      ref.fetchError =
        err instanceof Error ? err.message : "dsh result sidecar write failed";
      this.log.warn("dsh result sidecar write failed", {
        id,
        error: ref.fetchError,
      });
    }
    return ref;
  }

  /**
   * Cancel a running dsh subagent run (the dsh abort surface): dispose the
   * run and settle the task as `cancelled`. Returns `true` when the
   * cancellation was issued (task was running), `false` for unknown or
   * already-terminal tasks.
   */
  async cancelTask(taskId: string): Promise<boolean> {
    const entry = this.tasks.get(taskId);
    if (!entry || entry.task.status !== "running") return false;
    this.forceSettle(taskId, "cancelled", "dsh subagent run cancelled");
    return true;
  }

  /** Look up a dispatched task's current record (status + result ref). */
  getTask(taskId: string): DispatchTask | undefined {
    return this.tasks.get(taskId)?.task;
  }

  /**
   * Walk a dispatched child session up to the outermost live session by
   * following the dispatch-parent index recorded at each
   * {@link startRun} (`childToParent`).
   *
   * In dsh a `SubagentRun.id` IS a `SessionId`; each run records the REAL live
   * parent session that owned its spawn. Starting from a nested graph's
   * invoking session (the child session that declared or drove the run), this
   * returns `[sessionId, parent, ..., outermost]` — the chain a reminder for a
   * nested run must travel to reach the user's orchestrator session. A session
   * with no tracked dispatcher is its own outermost (`[sessionId]`), so a
   * single-level graph (whose invoking session IS the orchestrator) yields a
   * length-1 chain and the caller skips propagation.
   *
   * Cycle-safe: a seen-set stops a malformed parent loop, and the walk is
   * bounded by the registry size.
   */
  resolveSessionChain(sessionId: string): string[] {
    const chain = [sessionId];
    const seen = new Set<string>([sessionId]);
    let current = sessionId;
    for (;;) {
      const parent = this.childToParent.get(current);
      if (!parent || seen.has(parent)) break;
      chain.push(parent);
      seen.add(parent);
      current = parent;
    }
    return chain;
  }

  /**
   * Register a one-time termination listener (fire-once semantics mirroring
   * `DispatchManager.onTaskTerminated`). When the task is already terminal the
   * callback fires async via microtask (the listen-after-terminate race).
   */
  onTaskTerminated(taskId: string, callback: TaskTerminatedCallback): void {
    const entry = this.tasks.get(taskId);
    if (!entry) return;
    entry.listeners.add(callback);
    if (TERMINAL_STATUSES.has(entry.task.status)) {
      entry.listeners.delete(callback);
      const status = entry.task.status;
      queueMicrotask(() => {
        try {
          callback(taskId, status);
        } catch {
          // Swallow — same policy as the manager's immediate-fire guard.
        }
      });
    }
  }

  /** Remove a previously-registered termination listener. */
  removeTaskTerminatedListener(
    taskId: string,
    callback: TaskTerminatedCallback,
  ): void {
    const entry = this.tasks.get(taskId);
    if (!entry) return;
    entry.listeners.delete(callback);
  }

  // `getSessionUsage` is intentionally omitted — dsh has no budget accounting.
  // (The legacy engine's captureNodeUsage was the only consumer that guarded on
  // its absence; that runtime is deleted.)

  // ── IDispatchAdapter (loop coordinator) ───────────────────────────────────

  /** Submit a loop round to a worker agent via the dsh subagent seam. */
  async dispatchRound(input: {
    originSessionId: string;
    agent: string;
    prompt: string;
    description?: string;
    timeoutMs?: number;
  }): Promise<{ workerTaskId: string; workerSessionId: string }> {
    const task = await this.startRun(
      input.agent,
      input.prompt,
      input.description,
      input.originSessionId,
      // Loop path: the origin session IS a real live parent session, so the
      // context key and the live-parent key coincide (behavior unchanged).
      input.originSessionId,
      input.timeoutMs,
    );
    return { workerTaskId: task.id, workerSessionId: task.sessionId };
  }

  /** Retrieve the result of a completed worker round (awaits settlement). */
  async getRoundResult(workerTaskId: string): Promise<{
    text: string;
    hadError: boolean;
    errorReason?: string;
  }> {
    const entry = this.tasks.get(workerTaskId);
    if (!entry) {
      return { text: "", hadError: true, errorReason: "unknown worker task" };
    }
    await entry.done;
    const task = entry.task;
    const text = readMaterializedText(task.result);
    if (task.status === "completed") {
      return { text, hadError: false };
    }
    return { text, hadError: true, errorReason: task.error ?? task.status };
  }

  /** Cancel a running worker round (dsh abort surface). */
  async cancelRound(workerTaskId: string): Promise<void> {
    await this.cancelTask(workerTaskId);
  }

  /**
   * Read the latest assistant output from the origin session, up to
   * `SUMMARY_INPUT_CHAR_CAP` characters (mirrors `DispatchAdapter`). When no
   * session client is wired (or dsh cannot derive messages) returns "".
   */
  async readOriginSummary(
    originSessionId: string,
    sinceMessageId?: string,
  ): Promise<string> {
    const client = this.opts.sessionClient;
    if (!client) return "";
    const messages = await client.messages(originSessionId);
    if (!messages || messages.length === 0) return "";

    const textParts: string[] = [];
    let capture = !sinceMessageId;
    for (const msg of messages) {
      if (!capture && msg.info?.id === sinceMessageId) {
        capture = true;
        continue;
      }
      if (!capture) continue;
      if (msg.info?.role === "assistant" && msg.parts) {
        for (const part of msg.parts) {
          if (part.type === "text" && "text" in part && typeof part.text === "string") {
            textParts.push(part.text);
          }
        }
      }
    }
    let text = textParts.join("");
    if (text.length > SUMMARY_INPUT_CHAR_CAP) {
      text = text.slice(-SUMMARY_INPUT_CHAR_CAP);
    }
    return text;
  }

  /** Return the ID of the most recent message in a session, or undefined. */
  async getLastMessageId(originSessionId: string): Promise<string | undefined> {
    const client = this.opts.sessionClient;
    if (!client) return undefined;
    const messages = await client.messages(originSessionId);
    if (!messages || messages.length === 0) return undefined;
    return messages[messages.length - 1]?.info?.id;
  }

  /**
   * Inject a silent progress note — no-op on dsh (documented degradation):
   * dsh has no `prompt` on the SessionStore (`DshSessionAdapter.prompt`
   * returns null; prompting is driven by the dsh agent loop).
   */
  async injectNote(_sessionId: string, _text: string): Promise<void> {
    this.log.debug("injectNote is a no-op on dsh (no SessionStore prompt)");
  }

  /** Register a one-time terminated listener (returns the callback). */
  registerTerminatedListener(
    taskId: string,
    callback: (taskId: string, status: string) => void,
  ): (taskId: string, status: string) => void {
    this.onTaskTerminated(taskId, callback);
    return callback;
  }

  /** Remove a previously-registered terminated listener. */
  removeTerminatedListener(
    taskId: string,
    callback: (taskId: string, status: string) => void,
  ): void {
    this.removeTaskTerminatedListener(taskId, callback);
  }

  /** Read-only query: current lifecycle status of a dispatched task. */
  async getTaskStatus(taskId: string): Promise<string | undefined> {
    return this.tasks.get(taskId)?.task.status;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Join the text ContentBlocks of a dsh run output into a single string. */
function blocksToText(blocks: DshContentBlock[]): string {
  return blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

/** Read a materialized result's text from its sidecar, best-effort. */
function readMaterializedText(ref: MaterializedResultRef | undefined): string {
  if (!ref) return "";
  if (ref.fetchError) return "";
  try {
    return readFileSync(ref.sidecarPath, "utf8");
  } catch {
    return "";
  }
}
