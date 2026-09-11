import { FunctionSessionState } from "../function/session-state.ts";
import { functionRuntime } from "../function/runtime-state.ts";
import { sessionSignalLedger } from "../signal/session-signal-ledger.ts";
import type { ResolvedFunction } from "../types.ts";

export const stateRegistry = {
  functions: new FunctionSessionState(),
  functionRuntime,
  roleFunctions: new Map<string, ResolvedFunction[]>(),

  reset() {
    this.functions = new FunctionSessionState();
    this.functionRuntime.resetAll();
    sessionSignalLedger.resetAll();
    this.roleFunctions.clear();
  },
};
