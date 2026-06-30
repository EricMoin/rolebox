import { FunctionSessionState } from "./session-state.ts";
import { GraphSessionState } from "./graph/index.ts";
import { functionRuntime } from "./function/runtime-state.ts";
import type { ResolvedFunction, ResolvedGraph } from "./types.ts";

export const stateRegistry = {
  functions: new FunctionSessionState(),
  graph: new GraphSessionState(),
  functionRuntime,
  roleFunctions: new Map<string, ResolvedFunction[]>(),
  roleGraphs: new Map<string, ResolvedGraph>(),

  reset() {
    this.functions = new FunctionSessionState();
    this.graph = new GraphSessionState();
    this.functionRuntime.resetAll();
    this.roleFunctions.clear();
    this.roleGraphs.clear();
  },
};
