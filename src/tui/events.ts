/**
 * TUI live event streaming bridge.
 *
 * Provides an in-memory event buffer that the render cycle reads in addition
 * to the polled snapshot — enabling sub-250ms UI updates without waiting for
 * the 1-second disk poll.
 *
 * Three event sources are merged:
 *   1. Opencode host events via `api.event.on()`
 *   2. Fast-poll (250ms) of dispatch-*.json files for rolebox task transitions
 *   3. Fast-poll (250ms) of fnstate-*.json files for rolebox function transitions
 *
 * Attention notifications are dispatched for error/timeout events.
 *
 * @module
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tryReadJson, listStateFiles } from "../cli/commands/monitor/monitor-reader-utils.ts";
import { stateDirFor } from "../utils/state-paths.ts";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";

// ── Event types ────────────────────────────────────────────────────────────

export interface DispatchStartEvent {
  type: "dispatch_start";
  ts: string;
  taskId: string;
  agent: string;
  description?: string;
  sessionId: string;
}

export interface DispatchEndEvent {
  type: "dispatch_end";
  ts: string;
  taskId: string;
  agent: string;
  status: "completed" | "cancelled";
}

export interface DispatchErrorEvent {
  type: "dispatch_error";
  ts: string;
  taskId: string;
  agent: string;
  error: string;
  status: "error" | "timeout";
}

export interface FunctionActivateEvent {
  type: "function_activate";
  ts: string;
  name: string;
  sessionId: string;
  phase: string;
}

export interface FunctionDeactivateEvent {
  type: "function_deactivate";
  ts: string;
  name: string;
  sessionId: string;
}

export interface SessionOpenEvent {
  type: "session_status";
  ts: string;
  sessionId: string;
  opencodeStatus: string;
}

export interface SessionErrorEvent {
  type: "session_error";
  ts: string;
  sessionId?: string;
  errorMessage?: string;
}

export type RoleboxEvent =
  | DispatchStartEvent
  | DispatchEndEvent
  | DispatchErrorEvent
  | FunctionActivateEvent
  | FunctionDeactivateEvent
  | SessionOpenEvent
  | SessionErrorEvent;

// ── Ring buffer ────────────────────────────────────────────────────────────

const DEFAULT_BUFFER_CAPACITY = 100;

/**
 * Lightweight ring buffer for rolebox events.
 *
 * Supports push, drain, and peek operations. The render cycle calls
 * `drain()` to consume new events since the last read.
 */
export class EventBuffer {
  private buffer: RoleboxEvent[] = [];
  private readonly capacity: number;

  constructor(capacity = DEFAULT_BUFFER_CAPACITY) {
    this.capacity = capacity;
  }

  /** Push one or more events into the buffer, evicting oldest if over capacity. */
  push(...events: RoleboxEvent[]): void {
    for (const evt of events) {
      if (this.buffer.length >= this.capacity) {
        this.buffer.shift();
      }
      this.buffer.push(evt);
    }
  }

  /** Return all buffered events and clear the buffer. */
  drain(): RoleboxEvent[] {
    const events = [...this.buffer];
    this.buffer = [];
    return events;
  }

  /** Peek at buffered events without clearing them. */
  peek(): readonly RoleboxEvent[] {
    return this.buffer;
  }

  /** Number of events currently in the buffer. */
  get size(): number {
    return this.buffer.length;
  }

  /** Clear all events. */
  clear(): void {
    this.buffer = [];
  }
}

// ── Raw file types (subset of dispatch-*.json / fnstate-*.json) ───────────

interface RawDispatchTask {
  id: string;
  sessionId: string;
  status: string;
  agent: string;
  description?: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
}

interface RawDispatchFile {
  version: number;
  tasks: RawDispatchTask[];
}

interface RawFnEntry {
  name: string;
  state: {
    phase: string;
    continuationCount?: number;
  };
}

interface RawFnSession {
  sessionId: string;
  fns: RawFnEntry[];
}

interface RawFnStateFile {
  version: number;
  sessions: RawFnSession[];
}

// ── Polling state (delta detection) ────────────────────────────────────────

interface TaskState {
  status: string;
  agent: string;
  description?: string;
  sessionId: string;
}

interface FunctionState {
  phase: string;
}

// ── Event bridge ───────────────────────────────────────────────────────────

export interface EventBridge {
  /** The event buffer — read by the render cycle. */
  buffer: EventBuffer;

  /** Stop polling and cleanup subscriptions. */
  dispose: () => void;

  /** Whether attention notifications are enabled (reads from api.attention). */
  attentionEnabled: boolean;
}

/**
 * Create the event bridge for the TUI plugin.
 *
 * Must be called from within the TUI plugin setup function where `api` is
 * available. Returns an EventBridge with the event buffer and dispose handle.
 */
export function createEventBridge(
  api: TuiPluginApi,
  workspaceDir: string,
): EventBridge {
  const buffer = new EventBuffer();
  const stateDir = stateDirFor(workspaceDir);
  const FAST_POLL_MS = 250;
  const ATTENTION_THROTTLE_MS = 1_000;

  // ── Delta tracking ──
  const knownTasks = new Map<string, TaskState>();
  const knownFunctions = new Map<string, FunctionState>();
  const lastErrorNotify = new Map<string, number>(); // agent → last notification time

  let polling = true;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  // ── Helper: read state files without importing the full monitor reader ──

  function readDispatchEvents(): RoleboxEvent[] {
    const events: RoleboxEvent[] = [];
    try {
      for (const dispatchPath of listStateFiles(stateDir, "dispatch-")) {
        const raw = tryReadJson(dispatchPath);
        if (!raw || typeof raw !== "object" || !("tasks" in raw)) continue;
        const file = raw as RawDispatchFile;
        if (!Array.isArray(file.tasks)) continue;

        for (const st of file.tasks) {
          const prev = knownTasks.get(st.id);
          const now: TaskState = {
            status: st.status,
            agent: st.agent,
            description: st.description,
            sessionId: st.sessionId,
          };

          if (!prev) {
            // New task appeared
            knownTasks.set(st.id, now);
            const ts = st.startedAt || new Date().toISOString();
            if (st.status === "running" || st.status === "pending") {
              events.push({
                type: "dispatch_start",
                ts,
                taskId: st.id,
                agent: st.agent,
                description: st.description,
                sessionId: st.sessionId,
              });
            }
            // If it already terminal, emit error immediately
            if (st.status === "error" || st.status === "timeout") {
              events.push({
                type: "dispatch_error",
                ts: st.completedAt || ts,
                taskId: st.id,
                agent: st.agent,
                error: st.error ?? st.status,
                status: st.status,
              });
            }
          } else if (prev.status !== st.status) {
            // Status transition
            knownTasks.set(st.id, now);

            if (st.status === "running" && prev.status === "pending") {
              events.push({
                type: "dispatch_start",
                ts: st.startedAt || new Date().toISOString(),
                taskId: st.id,
                agent: st.agent,
                description: st.description,
                sessionId: st.sessionId,
              });
            } else if (st.status === "completed" || st.status === "cancelled") {
              events.push({
                type: "dispatch_end",
                ts: st.completedAt || new Date().toISOString(),
                taskId: st.id,
                agent: st.agent,
                status: st.status,
              });
            } else if (st.status === "error" || st.status === "timeout") {
              events.push({
                type: "dispatch_error",
                ts: st.completedAt || new Date().toISOString(),
                taskId: st.id,
                agent: st.agent,
                error: st.error ?? st.status,
                status: st.status,
              });
            }
          }
        }
      }
    } catch {
      // State directory may not exist yet — silent
    }
    return events;
  }

  function readFunctionEvents(): RoleboxEvent[] {
    const events: RoleboxEvent[] = [];
    try {
      for (const fnstatePath of listStateFiles(stateDir, "fnstate-")) {
        const raw = tryReadJson(fnstatePath);
        if (!raw || typeof raw !== "object" || !("sessions" in raw)) continue;
        const file = raw as RawFnStateFile;
        if (!Array.isArray(file.sessions)) continue;

        for (const session of file.sessions) {
          if (!session.sessionId || !Array.isArray(session.fns)) continue;
          for (const fn of session.fns) {
            const key = `${session.sessionId}\u0000${fn.name}`;
            const prev = knownFunctions.get(key);
            const now: FunctionState = { phase: fn.state.phase };

            if (!prev) {
              knownFunctions.set(key, now);
              if (fn.state.phase !== "complete") {
                events.push({
                  type: "function_activate",
                  ts: new Date().toISOString(),
                  name: fn.name,
                  sessionId: session.sessionId,
                  phase: fn.state.phase,
                });
              }
            } else if (prev.phase !== fn.state.phase) {
              knownFunctions.set(key, now);
              if (fn.state.phase === "complete") {
                events.push({
                  type: "function_deactivate",
                  ts: new Date().toISOString(),
                  name: fn.name,
                  sessionId: session.sessionId,
                });
              } else if (prev.phase === "complete" && fn.state.phase !== "complete") {
                // Reactivation
                events.push({
                  type: "function_activate",
                  ts: new Date().toISOString(),
                  name: fn.name,
                  sessionId: session.sessionId,
                  phase: fn.state.phase,
                });
              }
            }
          }
        }
      }
    } catch {
      // Silent
    }
    return events;
  }

  // ── Attention notification ──

  function shouldThrottleNotification(agent: string): boolean {
    const last = lastErrorNotify.get(agent);
    const now = Date.now();
    if (last && now - last < ATTENTION_THROTTLE_MS) return true;
    lastErrorNotify.set(agent, now);
    return false;
  }

  async function handleErrorEvent(evt: DispatchErrorEvent): Promise<void> {
    if (shouldThrottleNotification(evt.agent)) return;
    try {
      await api.attention.notify({
        title: `Task ${evt.status}: ${evt.agent}`,
        message: evt.error.length > 120 ? evt.error.slice(0, 120) + "\u2026" : evt.error,
        notification: { when: "always" },
        sound: { name: "error" },
      });
    } catch {
      // Attention API call failed — silent (TUI may not support it in headless mode)
    }
  }

  // ── Poll tick ──

  function tick(): void {
    if (!polling) return;

    const dispatchEvents = readDispatchEvents();
    const functionEvents = readFunctionEvents();
    const allEvents = [...dispatchEvents, ...functionEvents];

    if (allEvents.length === 0) return;

    buffer.push(...allEvents);

    // Fire attention notifications for error/timeout events
    for (const evt of allEvents) {
      if (evt.type === "dispatch_error") {
        handleErrorEvent(evt);
      }
    }
  }

  // ── Opencode event subscriptions ──

  const opencodeCleanups: Array<() => void> = [];

  try {
    // Subscribe to session status changes (session started, error, idle)
    const unsubStatus = api.event.on("session.status", (event) => {
      buffer.push({
        type: "session_status",
        ts: new Date().toISOString(),
        sessionId: event.properties.sessionID,
        opencodeStatus: event.properties.status.type,
      });
    });
    opencodeCleanups.push(unsubStatus);
  } catch {
    // api.event subscription not available in all environments — silent
  }

  try {
    const unsubError = api.event.on("session.error", (event) => {
      buffer.push({
        type: "session_error",
        ts: new Date().toISOString(),
        sessionId: event.properties.sessionID,
        errorMessage: event.properties.error
          ? "type" in event.properties.error
            ? (event.properties.error as { type: string }).type
            : "unknown"
          : undefined,
      });
    });
    opencodeCleanups.push(unsubError);
  } catch {
    // Silent
  }

  // ── Start fast-poll ──

  if (existsSync(stateDir)) {
    // Pre-populate known state so first tick only emits deltas
    tick();
  }
  pollTimer = setInterval(tick, FAST_POLL_MS);

  // ── Cleanup ──

  const dispose = () => {
    polling = false;
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    for (const cleanup of opencodeCleanups) {
      try { cleanup(); } catch { /* ignore */ }
    }
    buffer.clear();
    knownTasks.clear();
    knownFunctions.clear();
    lastErrorNotify.clear();
  };

  // Register lifecycle cleanup via api.lifecycle.onDispose
  try {
    api.lifecycle.onDispose(dispose);
  } catch {
    // Fallback: also register on the AbortSignal
    try {
      api.lifecycle.signal.addEventListener("abort", dispose, { once: true });
    } catch {
      // No lifecycle available — caller must call dispose() manually
    }
  }

  // Also clean up on signal abort
  try {
    api.lifecycle.signal.addEventListener("abort", dispose, { once: true });
  } catch {
    // Signal not available — ok
  }

  return {
    buffer,
    dispose,
    attentionEnabled: true,
  };
}
