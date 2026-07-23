import { applyParams } from "../function/file-resolver.ts";
import { functionSessionState } from "../function/session-state.ts";
import { graphSessionState, buildGraphStateBlock } from "../graph/index.ts";
import { functionRuntime } from "../function/runtime-state.ts";
import { ArtifactStore } from "../function/artifact-store.ts";
import { evaluateGateAndTransitions } from "../function/phase-machine.ts";
import { evaluateCondition, type CondEnv } from "../function/conditions.ts";
import { buildFunctionBlock, buildActiveArtifactBlock, buildAvailableFunctionsBlock, buildMemoryBlock } from "../prompt/builder.ts";
import { collectAllFunctions, appendCorrection } from "./context.ts";
import { createSubLogger } from "../logger.ts";
import type { ResolvedFunction } from "../types.ts";
import type { HookState } from "./state.ts";
import type { HookDeps } from "./deps.ts";

const log = createSubLogger("hook-sys-xform");

export async function handleSystemTransform(
  input: { sessionID?: string; agent?: string },
  output: { system: string[] },
  state: HookState,
  deps: HookDeps,
): Promise<void> {
  if (!input.sessionID) return;
  const sid: string = input.sessionID;

  // Built-in hooks: before phase (runs before custom hooks)
  await deps.builtInHooks?.runHooks(
    "system.transform",
    "before",
    () => ({
      hookName: "[builtin.before]",
      config: undefined,
      sessionID: sid,
      agent: input.agent,
      inject: (text: string) => appendCorrection(state.pendingCorrections, sid, text),
      log: createSubLogger("hook:builtin-before"),
    }),
    { system: output.system },
    deps.builtinConfig ?? {},
  );

  // Custom hooks: before phase
  await deps.customHooks.runHooks(
    "system.transform",
    "before",
    () => ({
      hookName: "[custom.before]",
      config: undefined,
      sessionID: sid,
      agent: input.agent,
      inject: (text: string) => appendCorrection(state.pendingCorrections, sid, text),
      log: createSubLogger("hook:custom-before"),
    }),
    { system: output.system },
  );

  const correction = state.pendingCorrections.get(input.sessionID);
  if (correction) {
    output.system.push(correction);
    state.pendingCorrections.delete(input.sessionID);
    log.debug("guardrail correction injected", { sessionID: input.sessionID });
  }

  const agentId = input.agent ?? state.sessionAgentRegistry.get(sid);
  let graphState = graphSessionState.getState(input.sessionID);
  if (!graphState && agentId) {
    const graph = deps.roleGraphMap.get(agentId);
    if (graph) {
      graphSessionState.initGraph(input.sessionID, graph);
      graphState = graphSessionState.getState(input.sessionID);
    }
  }

  // Available functions block — lists all resolved functions for the current agent
  // even when none are active, so the user can see what's available.
  if (agentId) {
    const agentFunctions = deps.roleFunctionsMap.get(agentId);
    if (agentFunctions && agentFunctions.length > 0) {
      const availBlock = buildAvailableFunctionsBlock(agentFunctions);
      if (availBlock) {
        output.system.push(availBlock);
      }
    }
  }

  // Memory injection — runs in BOTH code paths (functions active and inactive)
  if (agentId) {
    const role = deps.roleMap?.get(agentId);
    const memConfig = role?.config?.memory ?? { inject: true, max_inject: 10, min_relevance: "medium", scope: "both" };

    if (memConfig.inject !== false) {
      try {
        const { MemoryStore } = await import("../memory/store.ts");
        const store = await MemoryStore.create(deps.dir);
        const memories = store.list({
          scope: memConfig.scope ?? "both",
          limit: memConfig.max_inject ?? 10,
          minRelevance: memConfig.min_relevance ?? "medium",
        });
        store.close();
        const block = buildMemoryBlock(memories);
        if (block) {
          output.system.push(block);
        }
      } catch (err) {
        log.warn("Failed to inject memory block", { error: String(err) });
      }
    }
  }

  const activeNames = functionSessionState.getActive(input.sessionID);
  if (activeNames.size === 0) {
    // Still inject graph state block even without active functions
    if (graphState) {
      const graph = graphSessionState.getGraph(input.sessionID);
      if (graph) {
        const stateBlock = buildGraphStateBlock(graphState, graph);
        output.system.push(stateBlock);
      }
    }
    const totalChars = output.system.reduce((sum, s) => sum + s.length, 0);
    log.debug("System prompt augmented", { totalChars, addedFunctions: 0, hasGraphBlock: !!graphState });

    await deps.customHooks.runHooks(
      "system.transform",
      "after",
      () => ({
        hookName: "[custom.after]",
        config: undefined,
        sessionID: sid,
        agent: input.agent,
        inject: (text: string) => appendCorrection(state.pendingCorrections, sid, text),
        log: createSubLogger("hook:custom-after"),
      }),
      { system: output.system },
    );

    // Built-in hooks: after phase (runs after custom hooks)
    await deps.builtInHooks?.runHooks(
      "system.transform",
      "after",
      () => ({
        hookName: "[builtin.after]",
        config: undefined,
        sessionID: sid,
        agent: input.agent,
        inject: (text: string) => appendCorrection(state.pendingCorrections, sid, text),
        log: createSubLogger("hook:builtin-after"),
      }),
      { system: output.system },
      deps.builtinConfig ?? {},
    );
    return;
  }

  const allFunctions = collectAllFunctions(deps.roleFunctionsMap);

  const seen = new Set<string>();
  const activeFunctions: ResolvedFunction[] = [];
  for (const fn of allFunctions) {
    if (activeNames.has(fn.name) && !seen.has(fn.name)) {
      const call = functionSessionState.getCall(input.sessionID, fn.name);
      if (call && fn.params && Object.keys(call.args).length > 0) {
        activeFunctions.push({ ...fn, content: applyParams(fn, call) });
      } else {
        activeFunctions.push(fn);
      }
      seen.add(fn.name);
    }
  }

  // --- function kernel: increment turns, evaluate gates + transitions ---
  const runtimeStates = functionRuntime.all(input.sessionID);
  const userMessagedThisTurn = state.userMessagedSessions.has(input.sessionID);
  state.userMessagedSessions.delete(input.sessionID);
  for (const [, st] of runtimeStates) {
    st.currentTurn += 1;
  }
  const artifacts = new ArtifactStore(deps.dir);
  for (const fn of activeFunctions) {
    const st = functionRuntime.get(input.sessionID, fn.name);
    if (!st) continue;
    const env: CondEnv = {
      sessionID: input.sessionID,
      fnName: fn.name,
      state: st,
      artifacts,
      requiredEvidence: fn.requires_evidence ?? [],
      userMessagedThisTurn,
      workspaceDir: deps.dir,
    };
    const tr = evaluateGateAndTransitions(fn, env);
    // Collect transitions (applied atomically after loop)
    for (const name of tr.activate) {
      functionSessionState.activate(input.sessionID, [name]);
      const resolved = allFunctions.find((f) => f.name === name);
      const st2 = functionRuntime.init(
        input.sessionID,
        name,
        resolved?.state_schema_version ?? 1,
      );
      st2.activatedAtTurn = st2.currentTurn;
    }
    for (const name of tr.deactivate) {
      // Self-deactivation rule: a function can only deactivate itself
      if (name === fn.name) {
        functionSessionState.deactivate(input.sessionID, name);
      }
    }
  }
  functionRuntime.markDirty();

  // Priority-ordered injection + requires dependency guard
  const activeSet = functionSessionState.getActive(input.sessionID);
  const guarded: ResolvedFunction[] = [];
  for (const fn of activeFunctions) {
    const missing = (fn.requires ?? []).filter((d) => !activeSet.has(d));
    if (missing.length > 0) {
      output.system.push(`<system-reminder>Function '${fn.name}' requires ${missing.map((m) => `'${m}'`).join(", ")} active first.</system-reminder>`);
      continue;
    }
    guarded.push(fn);
  }
  guarded.sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));

  if (guarded.length === 0) {
    // Inject graph state block even when functions are active but empty
    if (graphState) {
      const graph = graphSessionState.getGraph(input.sessionID);
      if (graph) {
        const stateBlock = buildGraphStateBlock(graphState, graph);
        output.system.push(stateBlock);
      }
    }
    const totalChars = output.system.reduce((sum, s) => sum + s.length, 0);
    log.debug("System prompt augmented", { totalChars, addedFunctions: 0, hasGraphBlock: !!graphState });

    await deps.customHooks.runHooks(
      "system.transform",
      "after",
      () => ({
        hookName: "[custom.after]",
        config: undefined,
        sessionID: sid,
        agent: input.agent,
        inject: (text: string) => appendCorrection(state.pendingCorrections, sid, text),
        log: createSubLogger("hook:custom-after"),
      }),
      { system: output.system },
    );

    // Built-in hooks: after phase (runs after custom hooks)
    await deps.builtInHooks?.runHooks(
      "system.transform",
      "after",
      () => ({
        hookName: "[builtin.after]",
        config: undefined,
        sessionID: sid,
        agent: input.agent,
        inject: (text: string) => appendCorrection(state.pendingCorrections, sid, text),
        log: createSubLogger("hook:builtin-after"),
      }),
      { system: output.system },
      deps.builtinConfig ?? {},
    );
    return;
  }

  const block = buildFunctionBlock(guarded);
  output.system.push(block);

  // --- function kernel: inject consumed artifacts ---
  for (const fn of guarded) {
    if (fn.consumes) {
      const content = artifacts.read(input.sessionID, fn.consumes);
      if (content) output.system.push(buildActiveArtifactBlock(fn.consumes, content));
    }
  }

  // graphState already resolved above
  if (graphState) {
    const graph = graphSessionState.getGraph(input.sessionID);
    if (graph) {
      const stateBlock = buildGraphStateBlock(graphState, graph);
      output.system.push(stateBlock);
    }
  }

  const totalChars = output.system.reduce((sum, s) => sum + s.length, 0);
  log.debug("System prompt augmented", { totalChars, addedFunctions: guarded.length, hasGraphBlock: !!graphState });

  // Custom hooks: after phase
  await deps.customHooks.runHooks(
    "system.transform",
    "after",
    () => ({
      hookName: "[custom.after]",
      config: undefined,
      sessionID: sid,
      agent: input.agent,
      inject: (text: string) => appendCorrection(state.pendingCorrections, sid, text),
      log: createSubLogger("hook:custom-after"),
    }),
    { system: output.system },
  );

  // Built-in hooks: after phase (runs after custom hooks)
  await deps.builtInHooks?.runHooks(
    "system.transform",
    "after",
    () => ({
      hookName: "[builtin.after]",
      config: undefined,
      sessionID: sid,
      agent: input.agent,
      inject: (text: string) => appendCorrection(state.pendingCorrections, sid, text),
      log: createSubLogger("hook:builtin-after"),
    }),
    { system: output.system },
    deps.builtinConfig ?? {},
  );
}
