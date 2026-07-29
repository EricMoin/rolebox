import { FunctionSessionState } from "../function/session-state.ts";
import { functionRuntime } from "../function/runtime-state.ts";
import { sessionSignalLedger } from "../signal/session-signal-ledger.ts";
import type { ResolvedFunction, ResolvedGraph } from "../types.ts";

export const stateRegistry = {
  functions: new FunctionSessionState(),
  functionRuntime,
  roleFunctions: new Map<string, ResolvedFunction[]>(),
  roleGraphs: new Map<string, ResolvedGraph>(),

  reset() {
    this.functions = new FunctionSessionState();
    this.functionRuntime.resetAll();
    sessionSignalLedger.resetAll();
    this.roleFunctions.clear();
    this.roleGraphs.clear();
  },
};
