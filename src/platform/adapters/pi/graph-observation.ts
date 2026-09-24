import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HostExecutionObservation } from "../../../graph/host/outcome-host.ts";

/** The parent writes this stream; graph workers can write only their separate native session file. */
export function readPiGraphObservation(workspace: string, sessionId: string): HostExecutionObservation {
  const unknown = { kind: "unknown" as const, reason: "No confirmed terminal Pi event in the host transcript" };
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return unknown;
  try {
    const source = readFileSync(join(workspace, ".rolebox", "pi-sessions", `${sessionId}.jsonl`), "utf8");
    let observation: HostExecutionObservation = unknown;
    for (const line of source.split("\n")) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event?.type === "agent_start" || event?.type === "turn_start") observation = unknown;
      if (event?.type !== "agent_end") continue;
      const last = Array.isArray(event.messages) ? event.messages.at(-1) : undefined;
      if (event.willRetry === true || last?.role !== "assistant") { observation = unknown; continue; }
      if (last.stopReason === "stop") observation = { kind: "completed" };
      else if (["error", "aborted", "length"].includes(last.stopReason)) {
        observation = { kind: "failed", reason: "Pi reported an unsuccessful terminal response" };
      } else observation = unknown;
    }
    return observation;
  } catch { return unknown; }
}
