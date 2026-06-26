import { FunctionSessionState } from "./session-state.ts";
import { GraphSessionState } from "./graph/index.ts";
import type { ResolvedFunction, ResolvedGraph } from "./types.ts";

export const stateRegistry = {
  functions: new FunctionSessionState(),
  graph: new GraphSessionState(),
  roleFunctions: new Map<string, ResolvedFunction[]>(),
  roleGraphs: new Map<string, ResolvedGraph>(),

  reset() {
    this.functions = new FunctionSessionState();
    this.graph = new GraphSessionState();
    this.roleFunctions.clear();
    this.roleGraphs.clear();
  },
};
