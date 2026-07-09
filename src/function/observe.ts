import type { ObserveSpec, ResolvedFunction } from "../types.ts";
import { functionRuntime, type FnState } from "./runtime-state.ts";
import type { ArtifactStore } from "./artifact-store.ts";
import { extractResultBlockNamed } from "./fence.ts";
import { evaluateCondition } from "./conditions.ts";
import { wrapObserveCapability } from "../extensions/capabilities.ts";

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
  toolOutput?: unknown;
}): string[] {
  const injects: string[] = [];
  for (const fn of opts.activeFns) {
    const st = functionRuntime.get(opts.sessionID, fn.name);
    if (!st) continue;
    if (!st.toolsObserved.includes(opts.tool)) st.toolsObserved.push(opts.tool);
    // Track signal type for signal_observed(type) condition
    if (opts.tool === "signal" && opts.toolArgs && typeof opts.toolArgs === "object") {
      const signalType = (opts.toolArgs as Record<string, unknown>).type;
      if (typeof signalType === "string") {
        st.kv["__signal_type"] = signalType;
        // Also track in a set for multi-signal scenarios
        const observed = (st.kv["__signals_observed"] as string[] | undefined) ?? [];
        if (!observed.includes(signalType)) {
          observed.push(signalType);
          st.kv["__signals_observed"] = observed;
        }
      }
    }
    // Auto-capture signal payload as artifact when present
    if (opts.tool === "signal" && opts.toolArgs && typeof opts.toolArgs === "object") {
      const payload = (opts.toolArgs as Record<string, unknown>).payload;
      if (payload !== undefined) {
        opts.artifacts.write(opts.sessionID, "__signal_payload", JSON.stringify(payload));
      }
    }
    // requires_evidence auto-mark (skip when output-gated observe covers same pair)
    for (const tag of fn.requires_evidence ?? []) {
      const hasOutputGate = (fn.observe ?? []).some(
        (s) =>
          s.on === "tool_after" &&
          s.tool === opts.tool &&
          s.set_evidence === tag &&
          s.when_output,
      );
      if (hasOutputGate) continue;
      if (tag === opts.tool) st.evidenceObserved[tag] = true;
    }
    for (const spec of fn.observe ?? []) {
      if (spec.on !== "tool_after") continue;
      if (spec.tool && spec.tool !== opts.tool) continue;
      // when_output gate: skip spec if output doesn't meet conditions
      if (spec.when_output) {
        const outputStr =
          typeof opts.toolOutput === "string"
            ? opts.toolOutput
            : JSON.stringify(opts.toolOutput ?? "");
        if (spec.when_output.contains && !outputStr.includes(spec.when_output.contains)) continue;
        if (spec.when_output.not_contains && outputStr.includes(spec.when_output.not_contains)) continue;
      }
      // when_args gate: skip spec if tool args don't meet conditions
      if (spec.when_args && opts.toolArgs !== undefined) {
        const args = typeof opts.toolArgs === "object" && opts.toolArgs !== null
          ? (opts.toolArgs as Record<string, unknown>)
          : {};
        if (spec.when_args.match) {
          const allMatch = Object.entries(spec.when_args.match).every(
            ([key, val]) => JSON.stringify(args[key]) === JSON.stringify(val),
          );
          if (!allMatch) continue;
        }
        if (spec.when_args.not_match) {
          const anyMatch = Object.entries(spec.when_args.not_match).some(
            ([key, val]) => JSON.stringify(args[key]) === JSON.stringify(val),
          );
          if (anyMatch) continue;
        }
      } else if (spec.when_args) {
        // when_args declared but no args available — skip
        continue;
      }
      if (spec.set_evidence) st.evidenceObserved[spec.set_evidence] = true;
      if (spec.capture_artifact && opts.lastAssistantText) {
        const block = extractResultBlockNamed(opts.lastAssistantText, spec.capture_artifact);
        if (block !== null) opts.artifacts.write(opts.sessionID, spec.capture_artifact, block);
      }
      // capture_payload_as: store tool args payload as artifact
      if (spec.capture_payload_as && opts.toolArgs !== undefined) {
        const args = opts.toolArgs as Record<string, unknown> | null;
        const payload = args?.payload;
        if (payload !== undefined) {
          opts.artifacts.write(opts.sessionID, spec.capture_payload_as, JSON.stringify(payload));
        }
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

interface CustomObserveEntry {
  handler: (ctx: unknown, spec: ObserveSpec) => string[];
  /** When true, the handler receives an ObserveCapability instead of raw ctx. */
  capability: boolean;
}

const customObserveHandlers = new Map<string, CustomObserveEntry>();

/**
 * Register a custom observe event handler.
 * @param eventName Event name to listen for.
 * @param handler Handler function receiving (ctx, spec).
 * @param capability When true, the handler's ctx parameter is wrapped into an
 *   ObserveCapability before invocation.
 */
export function registerObserveHandler(
  eventName: string,
  handler: (ctx: unknown, spec: ObserveSpec) => string[],
  capability: boolean = false,
): void {
  customObserveHandlers.set(eventName, { handler, capability });
}

export function runCustomObserve(opts: {
  sessionID: string;
  eventName: string;
  activeFns: ResolvedFunction[];
  ctx?: unknown;
  /** Optional extra fields forwarded to ObserveCapability when capability mode is on. */
  observeExtras?: {
    toolName?: string;
    toolArgs?: unknown;
    toolOutput?: unknown;
    lastAssistantText?: string;
  };
}): string[] {
  const injects: string[] = [];
  const entry = customObserveHandlers.get(opts.eventName);
  if (!entry) return injects;

  for (const fn of opts.activeFns) {
    const st = functionRuntime.get(opts.sessionID, fn.name);
    if (!st) continue;
    for (const spec of fn.observe ?? []) {
      if (spec.on !== opts.eventName) continue;
      const ctx = entry.capability
        ? wrapObserveCapability(
            opts.ctx,
            opts.sessionID,
            opts.eventName,
            opts.observeExtras,
          )
        : opts.ctx;
      const result = entry.handler(ctx, spec);
      injects.push(...result);
    }
  }
  functionRuntime.markDirty();
  return injects;
}
