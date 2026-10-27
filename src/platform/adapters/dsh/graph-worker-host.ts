import type { OutcomeHost } from "../../../graph/host/outcome-host.ts";
import type { OutcomeWorkerPrincipal } from "../../../graph/host/tool-binding.ts";
import type { DshGraphWorkerGrantHost } from "./graph-worker.ts";

type WorkerHost = Pick<OutcomeHost, "workerPrincipalOf" | "workerToolGrantOf">;

function sameWorker(left: OutcomeWorkerPrincipal, right: OutcomeWorkerPrincipal): boolean {
  return left.graphId === right.graphId && left.attemptId === right.attemptId &&
    left.executionId === right.executionId && left.workerSessionId === right.workerSessionId;
}

/** Routes each resolved principal's grant to the host that authenticated it. */
export function createDshGraphWorkerGrantHost(hosts: () => Iterable<WorkerHost>): DshGraphWorkerGrantHost {
  const owners = new WeakMap<OutcomeWorkerPrincipal, WorkerHost>();
  const locate = (sessionId: string, expected?: OutcomeWorkerPrincipal) => {
    for (const host of hosts()) {
      const principal = host.workerPrincipalOf(sessionId);
      if (!principal || (expected && !sameWorker(principal, expected))) continue;
      owners.set(principal, host);
      if (expected) owners.set(expected, host);
      return { host, principal };
    }
    return undefined;
  };
  return {
    workerPrincipalOf: sessionId => locate(sessionId)?.principal,
    workerToolGrantOf: principal => {
      const remembered = owners.get(principal);
      const host = remembered && [...hosts()].includes(remembered)
        ? remembered : locate(principal.workerSessionId, principal)?.host;
      return host?.workerToolGrantOf(principal) ?? { inheritedTools: [] };
    },
  };
}
