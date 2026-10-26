import { findGraphWorkerRole } from "../../../prompt/graph-worker.ts";
import type { ResolvedRole } from "../../../types.ts";
import type { DshWorkerStartupTools } from "./graph-worker.ts";
import { readDshSessionEvents, type DshEventSource } from "./session-events.ts";

export interface DshContextAgent {
  id?: string;
  session?: DshEventSource & {
    id?: string;
    /**
     * Durable session creation metadata. Only `cwd` is read for the workspace;
     * `origin`/`parentSession` let the turn-recall scout recognize a subagent
     * session without importing the dsh session format.
     */
    header?: { cwd?: string; origin?: string; parentSession?: string };
    inheritedEventCount?: number;
  };
}

export interface DshContextOptions {
  roles(): readonly ResolvedRole[];
  activeRole(sessionId: string): string | null | undefined;
  session(sessionId: string): DshContextAgent["session"];
  workspace?(session: NonNullable<DshContextAgent["session"]>): string | undefined;
  tools(agent?: DshContextAgent): readonly string[];
  names?(): ReadonlyMap<string, string>;
  worker?(agent: DshContextAgent): DshWorkerStartupTools | undefined;
}

export function resolveDshSessionContext(options: DshContextOptions, agent: DshContextAgent, roleOverride?: string, workerOverride?: DshWorkerStartupTools) {
  const sessionId = agent.session?.id ?? agent.id ?? "";
  const session = agent.session ?? options.session(sessionId);
  const worker = workerOverride ?? options.worker?.(agent);
  const events = readDshSessionEvents(session);
  const ownEvents = events.slice(session?.inheritedEventCount ?? 0);
  const descriptor = ownEvents?.find(event => event.type === "subagent/descriptor")?.data;
  const provider = descriptor && typeof descriptor === "object" && "provider" in descriptor && typeof descriptor.provider === "string"
    ? descriptor.provider : undefined;
  const id = roleOverride ?? (worker ? worker.agent ?? provider : provider ?? options.activeRole(sessionId));
  const role = id ? findGraphWorkerRole(options.roles(), id) : undefined;
  let directory = session?.id ? options.workspace?.(session) : undefined;
  if (directory === undefined) {
    const change = events.slice().reverse().find(event => event.type === "working-directory/change");
    const data = change?.data;
    directory = change
      ? data && typeof data === "object" && "cwd" in data && typeof data.cwd === "string" ? data.cwd : undefined
      : session?.header?.cwd;
  }
  return { requestedRoleId: id, role, roleId: role?.id ?? "", directory, worker };
}
