import type { ResolvedFunction } from "../types.ts";
import type { FunctionSessionState } from "../session-state.ts";
import type { FunctionRuntimeManager } from "../function/runtime-state.ts";
import type { FunctionContext } from "../function/context.ts";
import { appendCorrection } from "./context.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("handler-drain");

const INJECT_CAP_BYTES = 4096;
const ACTIVATION_CAP = 3;

export function drainHandlerContext(
  ctx: FunctionContext,
  sessionID: string,
  fnName: string,
  pendingCorrections: Map<string, string>,
  sessionState: FunctionSessionState,
  runtime: FunctionRuntimeManager,
  allFns: ResolvedFunction[],
): void {
  let injBytes = 0;
  for (const inj of ctx.injects) {
    injBytes += inj.length;
    if (injBytes > INJECT_CAP_BYTES) { log.warn("handler inject cap reached", { fn: fnName }); break; }
    appendCorrection(pendingCorrections, sessionID, inj);
  }

  let actCount = 0;
  for (const name of ctx.pendingActivations.activate) {
    if (++actCount > ACTIVATION_CAP) { log.warn("handler activation cap reached", { fn: fnName }); break; }
    sessionState.activate(sessionID, [name]);
    const resolved = allFns.find((f) => f.name === name);
    runtime.init(sessionID, name, resolved?.state_schema_version ?? 1);
  }

  for (const name of ctx.pendingActivations.deactivate) {
    if (name === fnName) sessionState.deactivate(sessionID, name);
  }

  if (ctx.continuationReasons.length > 0) {
    const st = runtime.get(sessionID, fnName);
    if (st) {
      const existing = (st.kv.__pendingContinuationReasons as string[]) ?? [];
      st.kv.__pendingContinuationReasons = [...existing, ...ctx.continuationReasons];
      runtime.markDirty();
    }
  }
}
