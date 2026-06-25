import { FunctionSessionState } from "./session-state.js";
import { GraphSessionState } from "./graph/index.js";
import type { ResolvedFunction, ResolvedGraph } from "./types.js";

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
