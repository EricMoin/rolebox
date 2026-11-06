import { GraphStore } from "../store/graph-store.ts";
import { readGraphView } from "../query/graph-query.ts";
import { graphSnapshot } from "../query/render.ts";
import { graphRunNotices } from "./graph-notifications.ts";

export const GRAPH_WAIT_TIMEOUT_MS = 540_000;

export interface GraphWaitArgs {
  readonly graph_id: string;
  readonly run_id?: string;
  readonly timeout_ms?: number;
  readonly include_output?: boolean;
}

export interface GraphWaitResult {
  readonly graph_id: string;
  readonly run_id: string;
  readonly status: "complete" | "stopped" | "attention" | "timeout" | "cancelled";
  readonly reason: string;
  readonly notices: readonly Omit<ReturnType<typeof graphRunNotices>[number], "key">[];
  readonly graph: ReturnType<typeof graphSnapshot>;
}

/** Waits observe committed state independently of notification delivery or graph execution. */
export class GraphWait {
  private closed = false;
  private readonly cancellations = new Set<() => void>();

  constructor(private readonly storeRoot: string) {}

  async wait(args: GraphWaitArgs, sessionId: string, signal: AbortSignal): Promise<GraphWaitResult> {
    if (this.closed) throw new Error("Graph wait host closed");
    if (!sessionId) throw new Error("Graph wait requires a host-supplied session identity");
    const timeout = args.timeout_ms ?? GRAPH_WAIT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > GRAPH_WAIT_TIMEOUT_MS) {
      throw new Error(`timeout_ms must be an integer from 1 to ${GRAPH_WAIT_TIMEOUT_MS}`);
    }
    const store = GraphStore.openFile(this.storeRoot);
    let runId = args.run_id;

    return new Promise<GraphWaitResult>((resolve, reject) => {
      let settled = false;
      let queued = false;
      let changed = false;
      let unsubscribe = () => {};
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let fallback: ReturnType<typeof setInterval> | undefined;
      const cleanup = () => {
        settled = true;
        unsubscribe();
        clearTimeout(deadline);
        clearInterval(fallback);
        signal.removeEventListener("abort", cancel);
        this.cancellations.delete(cancel);
        store.close();
      };
      const check = (ending?: "timeout" | "cancelled") => {
        if (settled) return;
        try {
          const result = store.transaction(() => {
            if (store.readInvocationOrigin(args.graph_id)?.sessionId !== sessionId) {
              throw new Error("Unknown graph in this session");
            }
            const graph = readGraphView(store, args.graph_id);
            runId ??= graph.current?.runId;
            const run = graph.runs.find(item => item.runId === runId);
            if (!run) throw new Error("Unknown graph run to wait for");
            const notices = graphRunNotices(run, run.recordedPhase, id => store.readExecutionObservation(id));
            const notice = notices.at(0);
            const status = ending === "cancelled" ? ending : notice?.kind ??
              (run.phase === "stopped" ? "stopped" : ending);
            if (status === undefined) return undefined;
            return {
              graph_id: args.graph_id, run_id: run.runId, status,
              reason: status === "cancelled" ? "Waiting cancelled; graph execution was not cancelled." :
                notice?.reason ?? (status === "timeout" ? "Wait timed out; call graph_wait again to continue waiting." :
                  "The selected run was superseded by a retry."),
              notices: notices.map(({ key: _key, ...notice }) => notice),
              graph: graphSnapshot(graph, { run_id: run.runId, include_output: args.include_output ?? true }),
            };
          });
          if (result !== undefined) { cleanup(); resolve(result); }
        } catch (error) { cleanup(); reject(error); }
      };
      const cancel = () => check("cancelled");
      const schedule = () => {
        if (settled || queued) return;
        queued = true;
        queueMicrotask(() => { queued = false; check(); });
      };
      try {
        // Subscribe before the initial read so a completion cannot fall between reading and waiting.
        unsubscribe = store.observeTransactions({
          beforeCommit: graphIds => { changed = graphIds.includes(args.graph_id); },
          afterCommit: () => { if (changed) schedule(); },
        });
        deadline = setTimeout(() => check("timeout"), timeout);
        deadline.unref();
        // Also covers commits from other processes and terminal execution observations.
        fallback = setInterval(() => check(), 1_000);
        fallback.unref();
        this.cancellations.add(cancel);
        signal.addEventListener("abort", cancel, { once: true });
        check(signal.aborted ? "cancelled" : undefined);
      } catch (error) { cleanup(); reject(error); }
    });
  }

  close(): void {
    this.closed = true;
    for (const cancel of this.cancellations) cancel();
  }
}
