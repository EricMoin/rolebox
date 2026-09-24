import type { HostExecutionObservation } from "../../../graph/host/outcome-host.ts";
import type { DshSessionEventLike, DshSessionStoreLike } from "./session.ts";

export async function readDshExecutionEvents(sessions: DshSessionStoreLike, persistence: unknown, id: string): Promise<readonly DshSessionEventLike[] | undefined> {
  const live = sessions.get(id);
  if (live) return live.events;
  const storage = persistence as {
    inspect?(id: string): Promise<{ events: readonly DshSessionEventLike[] }>;
    open?(id: string, access: "read"): Promise<{ read(): Promise<{ events: readonly DshSessionEventLike[] }>; close(): Promise<void> }>;
  } | undefined;
  if (storage?.open) {
    const handle = await storage.open(id, "read");
    try { return (await handle.read()).events; } finally { await handle.close(); }
  }
  return storage?.inspect ? (await storage.inspect(id)).events : undefined;
}

/** Only a terminal turn after this one-shot child's own descriptor proves an end. */
export function observeDshExecutionEvents(events: readonly DshSessionEventLike[], label: string): HostExecutionObservation {
  const unknown = { kind: "unknown" as const, reason: "No confirmed terminal turn for this dsh graph execution" };
  let owned = false;
  let terminal: HostExecutionObservation = unknown;
  for (const event of events) {
    const data = event.data as Record<string, unknown> | undefined;
    if (event.type === "subagent/descriptor") {
      owned = data?.version === 2 && data.mode === "one-shot" && data.label === label;
      terminal = unknown;
    } else if (owned && event.type === "turn/start") terminal = unknown;
    else if (owned && event.type === "turn/end") {
      const reason = data?.reason as { kind?: string } | undefined;
      terminal = reason?.kind === "completed" ? { kind: "completed" }
        : ["aborted", "error", "max-tokens", "refusal"].includes(reason?.kind ?? "")
          ? { kind: "failed", reason: "dsh execution ended: " + reason!.kind } : unknown;
    }
  }
  return terminal;
}
