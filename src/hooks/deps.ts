import type { PluginInput } from "@opencode-ai/plugin";
import type { ResolvedFunction, ResolvedGraph } from "../types.ts";
import type { DispatchManager } from "../dispatch/manager.ts";
import type { LoopManager } from "../loop/manager.ts";
import type { LoopCoordinator } from "../loop/coordinator.ts";

export interface HookDeps {
  client: PluginInput["client"];
  roleFunctionsMap: Map<string, ResolvedFunction[]>;
  roleGraphMap: Map<string, ResolvedGraph>;
  dir: string;
  dispatchManager: DispatchManager;
  loopManager: LoopManager | LoopCoordinator;
}
