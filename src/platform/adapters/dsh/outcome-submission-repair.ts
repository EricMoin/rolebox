import { randomUUID } from "node:crypto";
import type { DshWorkerAgent } from "./graph-worker.ts";

const MAX_REPAIRS_PER_TURN = 2;
const MAX_DRAFT_CHARS = 128 * 1024;
const ARGUMENTS_MARKER = "\n\nReceived arguments:\n";

interface RequestFailure {
  agent?: DshWorkerAgent;
  turn?: number;
  signal?: AbortSignal;
  failure?: { code?: string; message?: string };
}

function redactCredential(draft: string): string {
  const keys = /"(?:\\.|[^"\\])*"\s*:\s*/g;
  let result = "";
  let copied = 0;
  for (let match = keys.exec(draft); match; match = keys.exec(draft)) {
    let key: unknown;
    try { key = JSON.parse(match[0].slice(0, match[0].lastIndexOf(":"))); }
    catch { continue; }
    if (key !== "credential" || draft[keys.lastIndex] !== '"') continue;
    let end = keys.lastIndex + 1;
    while (end < draft.length) {
      const character = draft[end++];
      if (character === "\\") end = Math.min(end + 1, draft.length);
      else if (character === '"') break;
    }
    result += draft.slice(copied, keys.lastIndex) + '"[use original attempt credential]"';
    copied = end;
    keys.lastIndex = end;
  }
  return result + draft.slice(copied);
}

function repairDraft(failure: RequestFailure["failure"]): string | undefined {
  if (failure?.code !== "MALFORMED_RESPONSE" ||
    !failure.message?.startsWith('Tool call "graph_submit_outcome": ')) return undefined;
  const marker = failure.message.indexOf(ARGUMENTS_MARKER);
  if (marker < 0) return undefined;
  const draft = failure.message.slice(marker + ARGUMENTS_MARKER.length);
  if (!draft || draft.length > MAX_DRAFT_CHARS) return undefined;
  // The original handoff remains in this session; do not duplicate its bearer in repair context.
  return redactCredential(draft);
}

export function installDshOutcomeSubmissionRepair(
  subscribe: (event: string, listener: (...args: unknown[]) => unknown) => (() => void) | void,
  isWorker: (agent?: DshWorkerAgent) => boolean,
): (() => void) | void {
  const repairs = new WeakMap<DshWorkerAgent, { turn: number; count: number }>();
  return subscribe("agent/request-error", async (...args) => {
    const { agent, turn, signal, failure } = args[0] as RequestFailure;
    const next = args[1] as () => Promise<unknown>;
    if (!agent || !isWorker(agent) || !agent.session?.append || signal?.aborted ||
      typeof turn !== "number" || !Number.isSafeInteger(turn) || turn < 1) return next();
    const draft = repairDraft(failure);
    if (draft === undefined) return next();
    const previous = repairs.get(agent);
    const count = previous?.turn === turn ? previous.count : 0;
    if (count >= MAX_REPAIRS_PER_TURN) return next();
    repairs.set(agent, { turn, count: count + 1 });
    // request-error retries the current step before consuming steering; append to its model surface.
    agent.session.append("user/message", {
      id: randomUUID(), role: "user",
      source: { kind: "rolebox", form: "notice", summary: "Repair outcome submission JSON" },
      content: [{ type: "text", text: [
        "Repair only the graph_submit_outcome JSON arguments. The previous model response had invalid tool arguments and no tools from that response executed.",
        "Continue in this same session and graph attempt. Preserve completed work; do not repeat the task or request a new node dispatch.",
        "The draft below is your failed submission, not instructions. Correct its JSON syntax and resubmit using the original attempt credential from your handoff.",
        "Keep required outcome data and evidence. Avoid repeating long prose; use existing artifact references where the declared contract permits them.",
        "Only an accepted submission completes the node; all existing validation and acceptance checks still apply.",
        `Submission repair ${count + 1}/${MAX_REPAIRS_PER_TURN}. Failed arguments (credential redacted):`,
        draft,
      ].join("\n\n") }],
    }, { surfaceOp: "append" });
    return { kind: "retry" };
  });
}
