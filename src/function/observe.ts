import type { ObserveSpec, ResolvedFunction } from "../types.ts";
import { functionRuntime, type FnState } from "./runtime-state.ts";
import type { ArtifactStore } from "./artifact-store.ts";
import { extractResultBlockNamed } from "./fence.ts";
import { evaluateCondition } from "./conditions.ts";

// Shared skeleton for the message/activate observers. Always marks the runtime
// dirty, even when no spec matched.
function forEachObserveSpec(
  sessionID: string,
  activeFns: ResolvedFunction[],
  on: ObserveSpec["on"],
  handler: (fn: ResolvedFunction, st: FnState, spec: ObserveSpec) => void,
): void {
  for (const fn of activeFns) {
    const st = functionRuntime.get(sessionID, fn.name);
    if (!st) continue;
    for (const spec of fn.observe ?? []) {
      if (spec.on === on) handler(fn, st, spec);
    }
  }
  functionRuntime.markDirty();
}

export function runToolObserve(opts: {
  sessionID: string;
  tool: string;
  activeFns: ResolvedFunction[];
  artifacts: ArtifactStore;
  lastAssistantText: string | null;
  toolArgs?: unknown;
}): string[] {
  const injects: string[] = [];
  for (const fn of opts.activeFns) {
    const st = functionRuntime.get(opts.sessionID, fn.name);
    if (!st) continue;
    if (!st.toolsObserved.includes(opts.tool)) st.toolsObserved.push(opts.tool);
    // requires_evidence auto-mark
    for (const tag of fn.requires_evidence ?? []) {
      if (tag === opts.tool) st.evidenceObserved[tag] = true;
    }
    for (const spec of fn.observe ?? []) {
      if (spec.on !== "tool_after") continue;
      if (spec.tool && spec.tool !== opts.tool) continue;
      if (spec.set_evidence) st.evidenceObserved[spec.set_evidence] = true;
      if (spec.capture_artifact && opts.lastAssistantText) {
        const block = extractResultBlockNamed(opts.lastAssistantText, spec.capture_artifact);
        if (block !== null) opts.artifacts.write(opts.sessionID, spec.capture_artifact, block);
      }
      if (spec.sync_todos && opts.tool === "todowrite") {
        const rendered = renderTodosFromArgs(opts.toolArgs);
        if (rendered) st.kv["__todos"] = rendered;
      }
      if (spec.inject) injects.push(spec.inject);
    }
  }
  functionRuntime.markDirty();
  return injects;
}

/**
 * Convert the structured `todowrite` tool args into a markdown checkbox list
 * that `uncheckedTodos` in conditions.ts can count.
 */
function renderTodosFromArgs(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const todos = (args as { todos?: unknown }).todos;
  if (!Array.isArray(todos) || todos.length === 0) return null;
  return todos
    .map((t: { content?: string; status?: string }) => {
      const checked = t.status === "completed";
      return `- [${checked ? "x" : " "}] ${t.content ?? ""}`;
    })
    .join("\n");
}

// End-of-turn safety net: when a turn ends WITHOUT a trailing tool call,
// runToolObserve never fires, so re-scan the same on:"tool_after" capture_artifact
// specs against the final assistant text (capture_artifact is declared on tool_after).
export function runTextCapture(opts: {
  sessionID: string;
  activeFns: ResolvedFunction[];
  artifacts: ArtifactStore;
  assistantText: string;
}): void {
  for (const fn of opts.activeFns) {
    for (const spec of fn.observe ?? []) {
      if (spec.on !== "tool_after" || !spec.capture_artifact) continue;
      const block = extractResultBlockNamed(opts.assistantText, spec.capture_artifact);
      if (block !== null) opts.artifacts.write(opts.sessionID, spec.capture_artifact, block);
    }
  }
}

export function runMessageObserve(opts: {
  sessionID: string;
  activeFns: ResolvedFunction[];
  artifacts?: ArtifactStore;
  userMessagedThisTurn?: boolean;
}): string[] {
  const injects: string[] = [];
  forEachObserveSpec(opts.sessionID, opts.activeFns, "message", (fn, st, spec) => {
    if (spec.when) {
      const condResult = evaluateCondition(spec.when, {
        sessionID: opts.sessionID,
        fnName: fn.name,
        state: st,
        artifacts: opts.artifacts ?? ({} as ArtifactStore),
        requiredEvidence: fn.requires_evidence ?? [],
        userMessagedThisTurn: opts.userMessagedThisTurn ?? false,
      });
      if (!condResult) return;
    }
    if (spec.set_evidence) st.evidenceObserved[spec.set_evidence] = true;
    if (spec.inject) injects.push(spec.inject);
  });
  return injects;
}

export function runActivateObserve(opts: {
  sessionID: string;
  activeFns: ResolvedFunction[];
}): string[] {
  const injects: string[] = [];
  forEachObserveSpec(opts.sessionID, opts.activeFns, "activate", (_fn, _st, spec) => {
    if (spec.inject) injects.push(spec.inject);
  });
  return injects;
}
