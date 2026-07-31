/**
 * PiProcessSessionAdapter — ISessionClient adapter with spawn-based
 * process session management.
 *
 * Composes PiSessionAdapter for read-only delegation (list, get, children,
 * todo, diff, fork) and implements active session operations (create, prompt,
 * promptSync, status, abort) via child process spawning of the Pi CLI in
 * JSON event mode.
 *
 * Each active session maintains a ProcessRecord with accumulated messages,
 * stderr buffer, exit code, and agent configuration. The spawn pattern
 * follows the project convention established in lsp/client-manager.ts.
 *
 * Must NOT import from @earendil-works/pi-coding-agent.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile, unlink, rmdir } from "node:fs/promises";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSubLogger } from "../../../logger.ts";
import type { Logger } from "tslog";
import type { ILogObj } from "tslog";
import type { ISessionClient } from "../../ports/session-client.ts";
import type { IEventBridge } from "../../ports/event-bridge.ts";
import { PiSessionAdapter, hasInFlightToolPart } from "./session.ts";
import {
  appendEvent,
  cleanup as cleanupSidecar,
  scanOrphanedSessions,
  readSession,
} from "./sidecar-persister.ts";
import type {
  SessionInfo,
  Message,
  FileDiff,
  Todo,
  SessionStatus,
} from "../../types.ts";
import type { Part, MessageInfo } from "../../../session/types.ts";

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Agent configuration for a spawned Pi process session.
 * Holds the model identifier, tool list, and system prompt text
 * that are passed as CLI arguments to the Pi binary.
 */
export interface PiProcessAgentConfig {
  /** Model identifier string (e.g., "claude-sonnet-4-20250514"). */
  model: string;
  /** Tool names available to this agent session. */
  tools: string[];
  /** System prompt text written to a temp file for --append-system-prompt. */
  systemPrompt: string;
}

/**
 * Internal record tracking a spawned Pi process session.
 * Each entry in the processes Map corresponds to one session.
 */
interface ProcessRecord {
  /** Session ID — mirrored onto the record so event handlers can emit. */
  id: string;
  /** The spawned child process, or null before/after spawn. */
  proc: ChildProcess | null;
  /** Messages accumulated from parsed JSON events. */
  messages: Message[];
  /** Exit code from the completed process, or null if still running. */
  exitCode: number | null;
  /** Aggregated stderr output from the child process. */
  stderr: string;
  /** Agent configuration used for the spawn CLI arguments. */
  agentConfig: PiProcessAgentConfig;
  /** Resolver for the pending prompt/process completion. */
  resolve: ((value: { parts: Array<{ type: string; text?: string }> } | null) => void) | null;
  /** Rejecter for process errors. */
  reject: ((err: Error) => void) | null;
  /**
   * True once a synthetic session.idle has been emitted for this record
   * (either by turn_end early completion or by the process exit handler).
   * Guards against double-emission now that completion can be driven by
   * the event stream instead of process exit.
   */
  idleEmitted: boolean;
  /** Sidecar file path for appending JSON events (null if not available). */
  sidecarPath: string | null;
}

/**
 * Finalized agent message carried inside pi 0.81.x message_start / message_end
 * events. Mirrors the AgentMessage shapes in the pi dist:
 * @earendil-works/pi-ai/dist/types.d.ts — UserMessage / AssistantMessage /
 * ToolResultMessage / custom messages. Content is a string (user prompt) or an
 * array of content entries (text / thinking / toolCall / image / ...).
 */
interface PiAgentMessage {
  role?: string;
  content?: string | Array<Record<string, unknown>>;
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
  [key: string]: unknown;
}

/**
 * Streaming sub-event carried inside pi 0.81.x message_update events.
 * Mirrors AssistantMessageEvent from
 * @earendil-works/pi-ai/dist/types.d.ts:344-395 — variants include
 * text_delta { delta }, thinking_delta { delta }, plus start/end markers.
 */
interface PiAssistantMessageEvent {
  type?: string;
  contentIndex?: number;
  delta?: string;
  [key: string]: unknown;
}

/**
 * Shape of a single JSON event line emitted by `pi --mode json` on stdout.
 * Each line is one JSON event object with at minimum a `type` field.
 */
interface PiJsonEvent {
  type: string;
  /** Unique identifier for the event/message element. */
  id?: string;
  /** Session identifier associated with the event. */
  sessionID?: string;
  /** Message identifier this event belongs to. */
  messageID?: string;
  /** Role of the message sender ("user" | "assistant"). */
  role?: string;
  /** Text content for text/reasoning events. */
  text?: string;
  /** Tool name for tool events. */
  tool?: string;
  /** Tool call identifier for tool events. */
  callID?: string;
  /** Tool state for tool result events. */
  state?: Record<string, unknown>;
  /** Reason for step-finish events. */
  reason?: string;
  /** Cost data. */
  cost?: number;
  /** Token usage data. */
  tokens?: Record<string, unknown>;
  /** Tool input for legacy tool_call events. */
  input?: Record<string, unknown>;
  /** Tool output for legacy tool_result events. */
  output?: string;
  /** Tool result title for legacy tool_result events. */
  title?: string;
  /** Tool result metadata for legacy tool_result events. */
  metadata?: Record<string, unknown>;
  // ── pi 0.81.x agent-run vocabulary (dist/core/extensions/types.d.ts) ──
  /** Finalized agent message (message_start / message_end). */
  message?: PiAgentMessage;
  /** Streaming delta sub-event (message_update). */
  assistantMessageEvent?: PiAssistantMessageEvent;
  /** Tool call id (tool_execution_start / update / end). */
  toolCallId?: string;
  /** Tool name (tool_execution_start / update / end). */
  toolName?: string;
  /** Tool arguments (tool_execution_start / update). */
  args?: Record<string, unknown>;
  /** Partial streaming result (tool_execution_update). */
  partialResult?: unknown;
  /** Final tool result (tool_execution_end). */
  result?: unknown;
  /** Whether the tool failed (tool_execution_end). */
  isError?: boolean;
  /** Turn index (turn_start / turn_end). */
  turnIndex?: number;
  /** Event timestamp (turn_start). */
  timestamp?: number;
  /** Any additional event-specific properties. */
  [key: string]: unknown;
}

/**
 * Default agent configuration used when no agent config is provided
 * for a session. Uses a reasonable default model and empty tools.
 */
const DEFAULT_AGENT_CONFIG: PiProcessAgentConfig = {
  model: "default",
  tools: [],
  systemPrompt: "",
};

/**
 * Separator character sequence used to delimit the context-inclusive
 * continuation prompt when reopening a session.
 */
const CONTINUATION_SEPARATOR =
  "\n\n— Previous messages reproduced above for context —\n\n";

// ── Adapter ────────────────────────────────────────────────────────────────

/**
 * ISessionClient adapter that manages sessions by spawning Pi CLI
 * child processes and parsing JSON event output.
 *
 * Read-only operations (list, get, children, todo, diff, fork) delegate
 * to an internal PiSessionAdapter instance. Mutation operations
 * (create, prompt, promptSync, abort, status) use process management.
 */
export class PiProcessSessionAdapter implements ISessionClient {
  /** Map of active and completed process sessions keyed by session ID. */
  private readonly processes: Map<string, ProcessRecord> = new Map();

  /** Read-only delegate for filesystem-backed session queries. */
  private readonly piSession: PiSessionAdapter;

  /** Logger instance scoped to this adapter. */
  private readonly log: Logger<ILogObj>;

  /**
   * Map of named agent configurations keyed by agent identifier.
   * Populated by the caller (e.g., dispatch system) before create().
   */
  private readonly agentConfigs: Map<string, PiProcessAgentConfig> = new Map();

  /** Optional event bridge for emitting canonical events (e.g., session.idle on process exit). */
  private eventBridge?: IEventBridge;

  /**
   * @param agentConfigs - Optional pre-configured agent configs keyed by agent name.
   * @param sessionDir   - Optional session directory override (passed to PiSessionAdapter).
   */
  constructor(
    agentConfigs?: Map<string, PiProcessAgentConfig>,
    sessionDir?: string,
  ) {
    this.log = createSubLogger("pi-process-session");
    this.piSession = new PiSessionAdapter(sessionDir);

    if (agentConfigs) {
      for (const [key, value] of agentConfigs) {
        this.agentConfigs.set(key, value);
      }
    }
  }

  /**
   * Set the event bridge for emitting canonical events.
   * Must be set before any spawn operations to enable completion evaluation
   * when child Pi processes exit.
   */
  setEventBridge(bridge: IEventBridge): void {
    this.eventBridge = bridge;
  }

  // ── Recovery ──────────────────────────────────────────────────────────────

  /**
   * Scan the sidecar directory for orphaned sessions and reconstruct
   * in-memory ProcessRecords for each one.
   *
   * Each orphaned session's sidecar JSONL file is read and its events
   * replayed through _handleJsonEvent() to reconstruct the Message[].
   * The recovered ProcessRecord has `proc: null` and `exitCode: 0`.
   *
   * This method should be called during startup/recovery, before any
   * new sessions are created.
   *
   * @returns The number of orphaned sessions recovered.
   */
  async recoverOrphanedSessions(): Promise<number> {
    const orphanedIds = scanOrphanedSessions();
    let recovered = 0;

    for (const id of orphanedIds) {
      // Skip sessions already in memory.
      if (this.processes.has(id)) continue;

      const events = await readSession(id);
      if (!events || events.length === 0) continue;

      const record: ProcessRecord = {
        id,
        proc: null,
        messages: [],
        exitCode: 0,
        stderr: "",
        agentConfig: { ...DEFAULT_AGENT_CONFIG },
        resolve: null,
        reject: null,
        idleEmitted: false,
        sidecarPath: join(process.cwd(), ".rolebox", "pi-sessions", `${id}.jsonl`),
      };

      // Replay events through the handler to reconstruct messages.
      for (const event of events) {
        try {
          this._handleJsonEvent(event as PiJsonEvent, record);
        } catch {
          this.log.debug("Recovery — failed to replay event for session", { id });
        }
      }

      this.processes.set(id, record);
      recovered++;
      this.log.debug("Recovered orphaned Pi session", { id, messageCount: record.messages.length });
    }

    return recovered;
  }

  // ── Agent config registration ───────────────────────────────────────────

  /**
   * Register or update an agent configuration for a named agent.
   *
   * @param agentId - Agent identifier used in create() options.
   * @param config  - Agent configuration (model, tools, systemPrompt).
   */
  registerAgentConfig(agentId: string, config: PiProcessAgentConfig): void {
    this.agentConfigs.set(agentId, config);
  }

  // ── create() ─────────────────────────────────────────────────────────────

  /**
   * Create a new process session.
   *
   * Generates a UUID as the session ID, allocates a ProcessRecord slot
   * with the matching agent configuration, and returns a synthetic
   * SessionInfo object.
   *
   * No process is spawned at this point — the actual spawn happens
   * when prompt() or promptSync() is called.
   */
  async create(
    options: { directory: string; agent?: string; parentID?: string },
  ): Promise<SessionInfo | null> {
    const id = randomUUID();
    const config = options.agent
      ? this.agentConfigs.get(options.agent)
      : undefined;

    const record: ProcessRecord = {
      id,
      proc: null,
      messages: [],
      exitCode: null,
      stderr: "",
      agentConfig: config ?? { ...DEFAULT_AGENT_CONFIG },
      resolve: null,
      reject: null,
      idleEmitted: false,
      sidecarPath: null,
    };

    this.processes.set(id, record);

    this.log.debug("Created process session", { id, agent: options.agent });

    return {
      id,
      projectID: options.directory,
      directory: options.directory,
      parentID: options.parentID,
      summary: { additions: 0, deletions: 0, files: 0 },
      title: `Pi Process Session ${id.slice(0, 8)}`,
      version: config?.model ?? "1.0",
      time: { created: Date.now(), updated: Date.now() },
    };
  }

  // ── prompt() — async fire-and-forget ────────────────────────────────────

  /**
   * Prompt a session asynchronously (fire-and-forget).
   *
   * Extracts model and tools from the session's ProcessRecord agentConfig,
   * writes the system prompt to a temporary file, spawns the Pi CLI with
   * `--mode json`, and parses stdout line-by-line as JSON events to
   * accumulate Message objects.
   *
   * The process continues running in the background. Use status() to
   * check completion and messages() to read accumulated output.
   *
   * Returns the session ID on successful spawn, or null on failure.
   */
  async prompt(
    id: string,
    options: {
      parts: Array<{ type: string; text: string }>;
      noReply?: boolean;
      system?: string;
      agent?: string;
      model?: { providerID: string; modelID: string };
    },
  ): Promise<{ id: string } | null> {
    const record = this.processes.get(id);
    if (!record) {
      this.log.warn("prompt() — session not found", { id });
      return null;
    }

    // If a previous process is still running, reject the new prompt.
    if (record.proc && record.exitCode === null) {
      this.log.warn("prompt() — session already has a running process", { id });
      return null;
    }

    const promptText = this._buildPromptText(options.parts);
    // Honor the per-prompt agent selection: the dispatch layer passes the
    // subagent's full id via `options.agent` to BOTH create() and prompt().
    // Resolve that agent's registered config so the correct model + system
    // prompt are applied, and remember it on the record for continuation.
    const agentConfig = options.agent
      ? this.agentConfigs.get(options.agent)
      : undefined;
    if (agentConfig) record.agentConfig = agentConfig;
    const sysPrompt = options.system ?? record.agentConfig.systemPrompt;
    const model = record.agentConfig.model;
    const tools = record.agentConfig.tools;

    // The system prompt is delivered via `--append-system-prompt` inside
    // _spawnProcess (not prepended to the user text), so it is applied exactly
    // once. This mirrors reopenForContinuation().
    try {
      await this._spawnProcess(id, model, tools, promptText, record, options.agent, sysPrompt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error("prompt() — spawn failed", { id, error: msg });
      record.exitCode = 1;

      // Emit a session.error so dispatchManager transitions to error state
      // immediately instead of waiting for the watchdog timeout.
      if (this.eventBridge) {
        void this.eventBridge.emit({
          type: "session.error",
          rawType: "process.spawn_error",
          properties: { sessionID: id, error: msg },
        }).catch((emitErr: unknown) => {
          this.log.debug("Failed to emit session.error for spawn failure", {
            id,
            error: emitErr instanceof Error ? emitErr.message : String(emitErr),
          });
        });
      }

      return null;
    }

    return { id };
  }

  // ── promptSync() ────────────────────────────────────────────────────────

  /**
   * Prompt a session synchronously — spawns the Pi CLI and awaits
   * process exit before returning the last assistant text part.
   *
   * Accepts an optional AbortSignal for cancellation.
   */
  async promptSync(
    id: string,
    options: {
      parts: Array<{ type: string; text: string }>;
      agent?: string;
      signal?: AbortSignal;
    },
  ): Promise<{ parts: Array<{ type: string; text?: string }> } | null> {
    const record = this.processes.get(id);
    if (!record) {
      this.log.warn("promptSync() — session not found", { id });
      return null;
    }

    // If already running, reject.
    if (record.proc && record.exitCode === null) {
      this.log.warn("promptSync() — session already has a running process", {
        id,
      });
      return null;
    }

    const promptText = this._buildPromptText(options.parts);
    // Honor the per-prompt agent selection (see prompt()): resolve the
    // subagent's registered config so its model + system prompt are applied.
    const agentConfig = options.agent
      ? this.agentConfigs.get(options.agent)
      : undefined;
    if (agentConfig) record.agentConfig = agentConfig;
    const sysPrompt = record.agentConfig.systemPrompt;
    const model = record.agentConfig.model;
    const tools = record.agentConfig.tools;

    // Register abort signal handler.
    const abortHandler = (): void => {
      const p = record.proc;
      if (p && !p.killed) {
        this.log.debug("promptSync() — abort signal received, killing process", { id });
        p.kill("SIGTERM");
        const sigkillHandle = setTimeout(() => {
          try {
            if (p && !p.killed) {
              p.kill("SIGKILL");
            }
          } catch {
            // Best-effort SIGKILL after timeout.
          }
        }, 5000);
        if (sigkillHandle && typeof sigkillHandle === "object" && "unref" in sigkillHandle) (sigkillHandle as any).unref();
      }
    };

    if (options.signal) {
      options.signal.addEventListener("abort", abortHandler, { once: true });
    }

    try {
      await this._spawnProcess(id, model, tools, promptText, record, options.agent, sysPrompt);

      // Await completion via the stored resolver promise.
      const result = await new Promise<{ parts: Array<{ type: string; text?: string }> } | null>(
        (resolve, reject) => {
          record.resolve = resolve;
          record.reject = reject;
        },
      );

      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error("promptSync() — failed", { id, error: msg });
      return null;
    } finally {
      if (options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }
    }
  }

  // ── messages() ──────────────────────────────────────────────────────────

  /**
   * Return a snapshot copy of accumulated messages for a session.
   * Delegates to PiSessionAdapter for sessions not managed by this adapter.
   */
  async messages(
    id: string,
    options?: { directory?: string; limit?: number },
  ): Promise<Message[]> {
    const record = this.processes.get(id);
    if (!record) {
      return this.piSession.messages(id, options);
    }

    // If the record has a sidecar path and no in-memory messages,
    // attempt to read from the sidecar (recovery path).
    if (record.messages.length === 0 && record.sidecarPath) {
      const sidecarEvents = await readSession(id);
      if (sidecarEvents && sidecarEvents.length > 0) {
        for (const event of sidecarEvents) {
          this._handleJsonEvent(event as PiJsonEvent, record);
        }
      }
    }

    const msgs = [...record.messages];
    if (options?.limit && options.limit > 0) {
      return msgs.slice(0, options.limit);
    }
    return msgs;
  }

  // ── status() ────────────────────────────────────────────────────────────

  /**
   * Get the session's current status.
   *
   * - For process-managed sessions: checks proc.exitCode.
   *   null = busy (process still running), non-null = idle.
   * - For unknown sessions: delegates to PiSessionAdapter.
   */
  async status(
    id: string,
    _directory?: string,
  ): Promise<SessionStatus | null> {
    const record = this.processes.get(id);
    if (!record) {
      return this.piSession.status(id, _directory);
    }

    if (record.proc && record.exitCode === null) {
      return { type: "busy" };
    }

    // Even when the process is no longer alive (exited or recovered), if the
    // last accumulated message still contains an in-flight tool/shell command,
    // the session is actively executing — report busy rather than idle.
    const lastMsg = record.messages[record.messages.length - 1];
    if (hasInFlightToolPart(lastMsg)) {
      return { type: "busy" };
    }

    return { type: "idle" };
  }

  // ── abort() ─────────────────────────────────────────────────────────────

  /**
   * Abort a running process session.
   *
   * Sends SIGTERM to the child process, with a 5-second fallback to
   * SIGKILL if the process does not terminate gracefully.
   */
  async abort(id: string): Promise<boolean> {
    const record = this.processes.get(id);
    if (!record) {
      this.log.debug("abort() — session not found", { id });
      return false;
    }

    const proc = record.proc;
    if (!proc || proc.killed) {
      this.log.debug("abort() — no running process to abort", { id });
      return false;
    }

    try {
      proc.kill("SIGTERM");

      // 5-second SIGKILL fallback.
      const sigkillHandle = setTimeout(() => {
        try {
          if (proc && !proc.killed) {
            proc.kill("SIGKILL");
            this.log.debug("abort() — sent SIGKILL after fallback", { id });
          }
        } catch {
          // Best-effort: process may have already exited.
        }
      }, 5000);
      if (sigkillHandle && typeof sigkillHandle === "object" && "unref" in sigkillHandle) (sigkillHandle as any).unref();

      this.log.debug("abort() — sent SIGTERM", { id });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error("abort() — failed", { id, error: msg });
      return false;
    }
  }

  // ── compact() ──────────────────────────────────────────────────────────

  /**
   * Pi does not support session compaction — always returns false.
   */
  async compact(_id: string): Promise<boolean> {
    this.log.debug("compact() is unsupported on Pi — returning false");
    return false;
  }

  // ── reopenForContinuation() ─────────────────────────────────────────────

  /**
   * Reopen a session for continuation by reading its accumulated
   * messages, constructing a context-inclusive prompt that includes
   * the prior conversation, and spawning a fresh process.
   *
   * This is used by the dispatch system's task retry mechanism.
   *
   * @param id      - The session ID to reopen.
   * @param newPrompt - The new prompt text to send.
   * @returns The session ID on success, or null on failure.
   */
  async reopenForContinuation(
    id: string,
    newPrompt: string,
  ): Promise<string | null> {
    const record = this.processes.get(id);
    if (!record) {
      this.log.warn("reopenForContinuation() — session not found", { id });
      return null;
    }

    // If there's an active process, abort it first.
    if (record.proc && record.exitCode === null) {
      try {
        record.proc.kill("SIGTERM");
      } catch {
        // Process may already be exiting.
      }
      record.proc = null;
    }

    // Read prior messages and serialize to text for context.
    const priorMessages = record.messages;
    const contextText = this._serializeMessagesForContext(priorMessages);

    // Build the continuation prompt: prior context + separator + new prompt.
    const continuationPrompt = priorMessages.length > 0
      ? `${contextText}${CONTINUATION_SEPARATOR}${newPrompt}`
      : newPrompt;

    const model = record.agentConfig.model;
    const tools = record.agentConfig.tools;
    const sysPrompt = record.agentConfig.systemPrompt;

    // Reset state for the new process.
    record.exitCode = null;
    record.stderr = "";

    try {
      await this._spawnProcess(id, model, tools, continuationPrompt, record);
      return id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error("reopenForContinuation() — spawn failed", {
        id,
        error: msg,
      });
      record.exitCode = 1;
      record.stderr += `\nSpawn error: ${msg}`;
      return null;
    }
  }

  // ── Delegated read-only methods ─────────────────────────────────────────

  /**
   * List sessions. Delegates to PiSessionAdapter.
   */
  async list(directory?: string): Promise<SessionInfo[]> {
    return this.piSession.list(directory);
  }

  /**
   * Get a single session. Delegates to PiSessionAdapter.
   */
  async get(
    id: string,
    directory?: string,
  ): Promise<SessionInfo | null> {
    return this.piSession.get(id, directory);
  }

  /**
   * Get child sessions. Delegates to PiSessionAdapter.
   */
  async children(
    id: string,
    directory?: string,
  ): Promise<SessionInfo[]> {
    return this.piSession.children(id, directory);
  }

  /**
   * Get todo items. Delegates to PiSessionAdapter.
   */
  async todo(
    id: string,
    directory?: string,
  ): Promise<Todo[]> {
    return this.piSession.todo(id, directory);
  }

  /**
   * Get file diffs. Delegates to PiSessionAdapter.
   */
  async diff(
    id: string,
    options?: { directory?: string; messageID?: string },
  ): Promise<FileDiff[]> {
    return this.piSession.diff(id, options);
  }

  /**
   * Fork a session. Delegates to PiSessionAdapter (returns null
   * as forking via process is not supported).
   */
  async fork(
    id: string,
    options?: { directory?: string; messageID?: string },
  ): Promise<SessionInfo | null> {
    return this.piSession.fork(id, options);
  }

  // ── Private methods ─────────────────────────────────────────────────────

  /**
   * Build a flat prompt text from the parts array.
   * Concatenates text parts with newline separators.
   */
  private _buildPromptText(
    parts: Array<{ type: string; text: string }>,
  ): string {
    return parts
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text)
      .join("\n");
  }

  /**
   * Serialize accumulated messages into a text block for inclusion
   * as context in a continuation prompt.
   */
  private _serializeMessagesForContext(messages: Message[]): string {
    const lines: string[] = [];
    for (const msg of messages) {
      const role = msg.info?.role ?? "unknown";
      lines.push(`[${role}]`);

      for (const part of msg.parts ?? []) {
        if (part.type === "text" && "text" in part) {
          lines.push((part as { text: string }).text);
        } else if (part.type === "reasoning" && "text" in part) {
          lines.push(`[reasoning]: ${(part as { text: string }).text}`);
        } else if (part.type === "tool" && "tool" in part) {
          const toolPart = part as { tool: string; state?: { output?: string } };
          lines.push(`[tool: ${toolPart.tool}]`);
          const output = toolPart.state?.output;
          if (output) {
            lines.push(output);
          }
        }
      }

      lines.push(""); // blank line between messages.
    }

    return lines.join("\n");
  }

  /**
   * Resolve the Pi binary path.
   * Checks PI_BIN_PATH env var first, falls back to "pi" on PATH.
   */
  private _resolvePiBinary(): string {
    const envPath = process.env.PI_BIN_PATH;
    if (envPath && envPath.trim().length > 0) {
      return envPath.trim();
    }
    return "pi";
  }

  /**
   * Default timeout for child Pi processes in milliseconds (10 minutes).
   */
  private static readonly DEFAULT_PROCESS_TIMEOUT_MS = 600_000;

  /**
   * Write the system prompt to a temporary file, spawn the Pi CLI
   * process, and set up stdout/stderr/data/exit handlers.
   *
   * The spawned process uses:
   *   pi --mode json -p --no-session --model <model> --tools <tools>
   *      --append-system-prompt <tmpfile> "Task: <prompt>"
   */
  private async _spawnProcess(
    id: string,
    model: string,
    tools: string[],
    promptText: string,
    record: ProcessRecord,
    agentId?: string,
    systemPrompt?: string,
  ): Promise<void> {
    // Set up the sidecar path before spawning.
    record.sidecarPath = join(process.cwd(), ".rolebox", "pi-sessions", `${id}.jsonl`);

    // Create a temp directory for this session's artifacts.
    const tmpDir = mkdtempSync(join(tmpdir(), `pi-process-${id.slice(0, 8)}-`));
    const sysPromptPath = join(tmpDir, "system-prompt.txt");

    // Write the effective system prompt to the temp file (delivered via
    // --append-system-prompt). Falls back to the record's config when no
    // explicit prompt is passed (e.g. reopenForContinuation).
    // If there is no system prompt, an empty file is written.
    await writeFile(sysPromptPath, systemPrompt ?? record.agentConfig.systemPrompt, "utf-8");

    // Build CLI arguments.
    const args: string[] = [
      "--mode", "json",
      "-p",
      "--no-session",
      "--model", model,
    ];

    // Add tools if any are configured.
    if (tools.length > 0) {
      args.push("--tools", tools.join(","));
    }

    // Add system prompt file reference.
    if (existsSync(sysPromptPath)) {
      args.push("--append-system-prompt", sysPromptPath);
    }

    // Add the prompt text as the final positional argument.
    args.push(`Task: ${promptText}`);

    this.log.debug("Spawning Pi process", { id, model, toolCount: tools.length, agent: agentId });

    // Seed the child process with its own agent identity so that its dispatch
    // tool (which sees an empty `context.agent` on Pi) can resolve *its* direct
    // children for nested dispatch. Read back in pi-extension.ts at startup.
    const childEnv = { ...process.env };
    if (agentId) {
      childEnv.ROLEBOX_ACTIVE_AGENT = agentId;
    }

    const proc = spawn(this._resolvePiBinary(), args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
    });

    record.proc = proc;

    // Close stdin immediately — the Pi CLI receives the prompt via a positional
    // argument (`Task: ...`) and --no-session prevents interactive input. An
    // open but unwritten stdin pipe can cause the child to hang indefinitely.
    if (proc.stdin) {
      proc.stdin.end();
    }

    // ── Per-process timeout (default 600s) ────────────────────────
    const timeoutHandle = setTimeout(() => {
      if (record.proc && !record.proc.killed && record.exitCode === null) {
        this.log.warn("Pi process timeout — sending SIGTERM", { id });
        record.proc.kill("SIGTERM");
        const sigkillHandle = setTimeout(() => {
          if (record.proc && !record.proc.killed) {
            record.proc.kill("SIGKILL");
          }
        }, 5000);
        if (sigkillHandle && typeof sigkillHandle === "object" && "unref" in sigkillHandle) (sigkillHandle as any).unref();
      }
    }, PiProcessSessionAdapter.DEFAULT_PROCESS_TIMEOUT_MS);
    if (timeoutHandle && typeof timeoutHandle === "object" && "unref" in timeoutHandle) (timeoutHandle as any).unref();

    // ── stdout handler: parse JSON events line by line ─────────────
    let stdoutBuffer = "";
    const processStdout = (chunk: Buffer): void => {
      stdoutBuffer += chunk.toString("utf-8");
      const lines = stdoutBuffer.split("\n");

      // Keep the last (potentially incomplete) line in the buffer.
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const event: PiJsonEvent = JSON.parse(trimmed);
          this._handleJsonEvent(event, record);
          // Persist the raw event to the sidecar file (best-effort, fire-and-forget).
          if (record.sidecarPath) {
            void appendEvent(id, event);
          }
        } catch {
          // Non-JSON lines from pi's stderr or status output are ignored.
          this.log.debug("Non-JSON stdout line", { id, line: trimmed.slice(0, 120) });
        }
      }
    };

    proc.stdout?.on("data", processStdout);

    // ── stderr handler: accumulate ─────────────────────────────────
    proc.stderr?.on("data", (chunk: Buffer) => {
      record.stderr += chunk.toString("utf-8");
    });

    // ── exit handler ───────────────────────────────────────────────
    proc.on("exit", (code: number | null) => {
      record.exitCode = code;
      this.log.debug("Pi process exited", { id, code });

      // Clear the timeout.
      clearTimeout(timeoutHandle);

      // Clean up the sidecar file (best-effort).
      if (record.sidecarPath) {
        void cleanupSidecar(id);
      }

      // Clean up the temp directory.
      this._cleanupTempDir(tmpDir, sysPromptPath);

      // If there are pending resolver(s), resolve with the last assistant text.
      if (record.resolve) {
        const lastAssistantText = this._extractLastAssistantText(record.messages);
        record.resolve({
          parts: [{ type: "text", text: lastAssistantText }],
        });
        record.resolve = null;
        record.reject = null;
      }

      // Emit a synthetic session.idle event so completion evaluation triggers
      // immediately instead of waiting for the watchdog to time out. Skipped
      // when the turn already completed from the event stream (turn_end)
      // and already emitted its own session.idle.
      if (this.eventBridge && !record.idleEmitted) {
        record.idleEmitted = true;
        void this.eventBridge.emit({
          type: "session.idle",
          rawType: "process.exit",
          properties: { sessionID: id, exitCode: code },
        }).catch((err: unknown) => {
          this.log.debug("Failed to emit session.idle for process exit", {
            id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    });

    // ── error handler ──────────────────────────────────────────────
    proc.on("error", (err: Error) => {
      clearTimeout(timeoutHandle);
      this.log.error("Pi process error", { id, error: err.message });
      record.stderr += `\nProcess error: ${err.message}`;

      if (record.reject) {
        record.reject(err);
        record.resolve = null;
      }

      // Emit a session.error so dispatchManager transitions to error state
      // immediately instead of waiting for the watchdog timeout.
      if (this.eventBridge) {
        void this.eventBridge.emit({
          type: "session.error",
          rawType: "process.error",
          properties: { sessionID: id, error: err.message },
        }).catch((emitErr: unknown) => {
          this.log.debug("Failed to emit session.error for process error", {
            id,
            error: emitErr instanceof Error ? emitErr.message : String(emitErr),
          });
        });
      }
    });
  }

  /**
   * Handle a single parsed JSON event from the Pi CLI's JSON mode stdout.
   * Mutates the ProcessRecord's messages array in place.
   */
  private _handleJsonEvent(event: PiJsonEvent, record: ProcessRecord): void {
    switch (event.type) {
      case "message_start": {
        // pi 0.81.x payload: { type, message } — create (or adopt) a message
        // shell. The role comes from event.message.role, NOT event.role
        // (types.d.ts MessageStartEvent — the event itself has no role field).
        const m = event.message;
        const role: "user" | "assistant" =
          m?.role === "user" ? "user" : "assistant";
        const msgInfo: MessageInfo = {
          id: event.messageID ?? event.id ??
            `msg-${record.messages.length}-${Date.now()}`,
          sessionID: (event.sessionID as string) ?? "",
          role,
          time: { created: (m?.timestamp as number) ?? Date.now() },
        };

        // Adopt an empty shell (duplicate message_start or a shell from a
        // prior fixup) instead of stacking a second entry for one message.
        const last = record.messages[record.messages.length - 1];
        if (last && last.parts.length === 0) {
          last.info = msgInfo;
        } else {
          record.messages.push({ info: msgInfo, parts: [] });
        }
        break;
      }

      case "message_update": {
        // pi 0.81.x payload: { type, message, assistantMessageEvent }.
        // Streams deltas: text_delta { delta } appends to the open text part,
        // thinking_delta { delta } appends to the reasoning part. The part is
        // created on the first delta for its (type, contentIndex) slot —
        // keying by slot id mirrors pi's text_start/contentIndex indexing
        // (pi-ai/dist/types.d.ts AssistantMessageEvent).
        const deltaEvent = event.assistantMessageEvent;
        const last = record.messages[record.messages.length - 1];
        if (!deltaEvent || !last) break;

        const deltaText = typeof deltaEvent.delta === "string"
          ? deltaEvent.delta
          : "";
        const contentIndex = typeof deltaEvent.contentIndex === "number"
          ? deltaEvent.contentIndex
          : 0;
        const isText = deltaEvent.type === "text_delta";
        if (!isText && deltaEvent.type !== "thinking_delta") break;
        if (!deltaText) break;

        const slotId = `${isText ? "text" : "reasoning"}-slot-${contentIndex}`;
        let part = last.parts.find((p) => p.id === slotId);
        if (!part) {
          part = isText
            ? {
                id: slotId,
                sessionID: (event.sessionID as string) ?? "",
                messageID: last.info.id,
                type: "text" as const,
                text: "",
                time: { start: Date.now() },
              }
            : {
                id: slotId,
                sessionID: (event.sessionID as string) ?? "",
                messageID: last.info.id,
                type: "reasoning" as const,
                text: "",
                time: { start: Date.now() },
              };
          last.parts.push(part);
        }
        (part as { text: string }).text += deltaText;
        break;
      }

      case "message_end": {
        // pi 0.81.x payload: { type, message } — the finalized message is the
        // single source of truth. Replace the message's parts wholesale from
        // event.message.content (avoids delta double-count: message_update
        // deltas were already applied, and agent-core re-emits the SAME
        // message object in later turn_end events, which we ignore).
        const m = event.message;
        const last = record.messages[record.messages.length - 1];
        if (last) {
          // Persist role and complete timestamp.
          if (m?.role === "user" || m?.role === "assistant") {
            last.info.role = m.role;
          }
          last.info.time = { ...last.info.time, completed: Date.now() };

          // Replace parts wholesale from the finalized content.
          const rebuilt: Part[] = [];
          if (typeof m?.content === "string") {
            // UserMessage content can be a plain prompt string.
            rebuilt.push({
              id: `text-0-${Date.now()}`,
              sessionID: (event.sessionID as string) ?? "",
              messageID: last.info.id,
              type: "text",
              text: m.content,
              time: { start: Date.now() },
            });
          } else if (Array.isArray(m?.content)) {
            for (const entry of m.content) {
              const partId = `p-${rebuilt.length}-${Date.now()}`;
              switch (entry.type) {
                case "text":
                  rebuilt.push({
                    id: partId,
                    sessionID: (event.sessionID as string) ?? "",
                    messageID: last.info.id,
                    type: "text",
                    text: String(entry.text ?? ""),
                    time: { start: Date.now() },
                  });
                  break;
                case "thinking":
                  rebuilt.push({
                    id: partId,
                    sessionID: (event.sessionID as string) ?? "",
                    messageID: last.info.id,
                    type: "reasoning",
                    text: String(entry.thinking ?? ""),
                    time: { start: Date.now() },
                  });
                  break;
                case "toolCall": {
                  // AssistantMessage toolCall entries carry the provider-level
                  // call id — reuse the live tool part (built by
                  // tool_execution_* when those events precede message_end) so
                  // its state is not lost by the wholesale replacement.
                  const tcId = String(entry.id ?? "");
                  const live = this._findToolPart(record, tcId);
                  rebuilt.push(live ?? {
                    id: partId,
                    sessionID: (event.sessionID as string) ?? "",
                    messageID: last.info.id,
                    type: "tool",
                    callID: tcId || `call-${Date.now()}`,
                    tool: String(entry.name ?? "unknown"),
                    state: {
                      status: "running",
                      input: (entry.arguments as Record<string, unknown>) ?? {},
                    },
                  });
                  break;
                }
                default:
                  // Unknown content types (image, custom, ...) pass through
                  // as raw parts so finalized content is never dropped.
                  rebuilt.push({
                    ...(entry as Record<string, unknown>),
                    id: partId,
                    sessionID: (event.sessionID as string) ?? "",
                    messageID: last.info.id,
                    type: String(entry.type ?? "content"),
                  });
                  break;
              }
            }
          }
          if (rebuilt.length > 0) {
            last.parts = rebuilt;
          }

          // Finish reason and error detail from the finalized message.
          if (typeof m?.stopReason === "string" && m.stopReason) {
            last.info.finish = m.stopReason;
          }
          if (m?.stopReason === "error") {
            last.info.error = typeof m.errorMessage === "string" && m.errorMessage
              ? m.errorMessage
              : "error";
          }
        }
        break;
      }

      case "turn_end": {
        // pi 0.81.x payload: { type, message, turnIndex, ... }.
        //
        // THE critical completion signal: a live `pi --mode json -p`
        // (verified against real pi 0.81.1) emits turn_end after the
        // finalized message_end but then NEVER exits the process — it
        // idles indefinitely after agent_settled. Completion therefore
        // must be driven by this event, not by waiting for process exit
        // (which previously only resolved via the 600s SIGTERM timeout,
        // leaving sync dispatches hanging and async completions starved).
        this._completeTurn(record);
        break;
      }

      case "tool_execution_start": {
        // pi 0.81.x payload: { type, toolCallId, toolName, args }.
        // Match an existing part by call id (e.g. created by the assistant's
        // toolCall content), otherwise append a new one to the last message.
        const callID = (event.toolCallId as string) ?? (event.callID as string) ?? "";
        const existing = this._findToolPart(record, callID);
        if (existing) {
          const toolPart = existing as unknown as {
            type: "tool";
            tool: string;
            state: Record<string, unknown>;
          };
          if (event.toolName) toolPart.tool = event.toolName;
          toolPart.state = {
            status: "running",
            input: (event.args as Record<string, unknown>) ??
              (toolPart.state as { input?: Record<string, unknown> }).input ?? {},
          };
          break;
        }

        if (record.messages.length === 0) {
          // Defensive: a tool event with no preceding message shell.
          record.messages.push({
            info: {
              id: `msg-${record.messages.length}-${Date.now()}`,
              sessionID: (event.sessionID as string) ?? "",
              role: "assistant",
              time: { created: Date.now() },
            },
            parts: [],
          });
        }
        const target = record.messages[record.messages.length - 1];
        if (!target) break;
        target.parts.push({
          id: event.id ?? `tool-${Date.now()}`,
          sessionID: (event.sessionID as string) ?? "",
          messageID: target.info.id,
          type: "tool",
          callID: callID || `call-${Date.now()}`,
          tool: event.toolName ?? "unknown",
          state: {
            status: "running",
            input: (event.args as Record<string, unknown>) ?? {},
          },
        });
        break;
      }

      case "tool_execution_update": {
        // pi 0.81.x payload: { type, toolCallId, toolName, args, partialResult }.
        // Merge the partial result into the matching tool part's state.
        const callID = (event.toolCallId as string) ?? (event.callID as string) ?? "";
        const match = this._findToolPart(record, callID);
        if (!match) break;
        const pr = event.partialResult;
        if (pr === undefined) break;

        const toolPart = match as unknown as { state: Record<string, unknown> };
        const prev = toolPart.state.partialResult;
        if (typeof prev === "string" && typeof pr === "string") {
          toolPart.state.partialResult = prev + pr;
        } else if (this._isPlainObject(prev) && this._isPlainObject(pr)) {
          toolPart.state.partialResult = {
            ...(prev as Record<string, unknown>),
            ...(pr as Record<string, unknown>),
          };
        } else {
          toolPart.state.partialResult = pr;
        }
        break;
      }

      case "tool_execution_end": {
        // pi 0.81.x payload: { type, toolCallId, toolName, result, isError }.
        const callID = (event.toolCallId as string) ?? (event.callID as string) ?? "";
        const match = this._findToolPart(record, callID);
        if (!match) break;

        const toolPart = match as unknown as {
          tool: string;
          state: Record<string, unknown>;
        };
        if (event.toolName) toolPart.tool = event.toolName;
        const start =
          (toolPart.state.time as { start?: number } | undefined)?.start ??
          Date.now();
        const output = event.result === undefined
          ? ""
          : typeof event.result === "string"
            ? event.result
            : JSON.stringify(event.result);
        if (event.isError === true) {
          toolPart.state = {
            status: "error",
            error: output || "Tool execution failed",
            time: { start, end: Date.now() },
          };
        } else {
          toolPart.state = {
            ...toolPart.state,
            status: "completed",
            output,
            time: { start, end: Date.now() },
          };
        }
        break;
      }

      case "text": {
        // Add or append to the last message's text content.
        const last = record.messages[record.messages.length - 1];
        if (!last) break;

        const textContent = event.text ?? "";
        const existingTextPart = last.parts.find(
          (p): p is { id: string; sessionID: string; messageID: string; type: "text"; text: string } =>
            p.type === "text",
        ) as { type: "text"; text: string; id?: string } | undefined;

        if (existingTextPart) {
          existingTextPart.text += textContent;
        } else {
          last.parts.push({
            id: event.id ?? `text-${Date.now()}`,
            sessionID: event.sessionID ?? "",
            messageID: event.messageID ?? last.info.id,
            type: "text",
            text: textContent,
          });
        }
        break;
      }

      case "reasoning": {
        const last = record.messages[record.messages.length - 1];
        if (!last) break;

        const reasoningText = event.text ?? "";
        last.parts.push({
          id: event.id ?? `reasoning-${Date.now()}`,
          sessionID: event.sessionID ?? "",
          messageID: event.messageID ?? last.info.id,
          type: "reasoning",
          text: reasoningText,
          time: { start: Date.now() },
        });
        break;
      }

      case "tool_call": {
        const last = record.messages[record.messages.length - 1];
        if (!last) break;

        last.parts.push({
          id: event.id ?? `tool-${Date.now()}`,
          sessionID: event.sessionID ?? "",
          messageID: event.messageID ?? last.info.id,
          type: "tool",
          callID: (event.callID as string) ?? `call-${Date.now()}`,
          tool: (event.tool as string) ?? "unknown",
          state: {
            status: "running",
            input: (event.input as Record<string, unknown>) ?? {},
          },
        });
        break;
      }

      case "tool_result": {
        // Update the matching tool call part with its result.
        const last = record.messages[record.messages.length - 1];
        if (!last) break;

        const callID = event.callID as string | undefined;
        if (callID) {
          const match = last.parts.find(
            (p): boolean =>
              p.type === "tool" &&
              "callID" in p &&
              (p as Record<string, unknown>).callID === callID,
          );

          if (match) {
            const toolPart = match as unknown as {
              type: "tool";
              callID: string;
              state: Record<string, unknown>;
            };
            toolPart.state = {
              ...toolPart.state,
              status: "completed",
              output: (event.output as string) ?? "",
              title: (event.title as string) ?? "",
              metadata: (event.metadata as Record<string, unknown>) ?? {},
              time: {
                start: (toolPart.state.time as { start?: number })?.start ?? Date.now(),
                end: Date.now(),
              },
            };
          }
        }
        break;
      }

      case "step-finish": {
        const last = record.messages[record.messages.length - 1];
        if (!last) {
          // step-finish may arrive as its own event without a preceding message_start.
          // Create a synthetic message for it.
          const stepMsg: Message = {
            info: {
              id: event.id ?? `step-${Date.now()}`,
              sessionID: event.sessionID ?? "",
              role: "assistant",
              time: { created: Date.now(), completed: Date.now() },
            },
            parts: [],
          };
          record.messages.push(stepMsg);
          // Don't break — fall through to add the step-finish part.
        }

        if (last) {
          last.parts.push({
            id: event.id ?? `step-finish-${Date.now()}`,
            sessionID: event.sessionID ?? "",
            messageID: last.info.id,
            type: "step-finish",
            reason: (event.reason as string) ?? "unknown",
            cost: (event.cost as number) ?? 0,
            tokens: (event.tokens as {
              input: number;
              output: number;
              reasoning: number;
              cache: { read: number; write: number };
            }) ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          });
        }
        break;
      }

      case "agent_start":
      case "turn_start":
      case "turn_end":
      case "agent_end":
      case "agent_settled":
        // pi 0.81.x agent lifecycle events — no parser state to update.
        this.log.debug("Pi agent lifecycle event", {
          type: event.type,
          turnIndex: event.turnIndex,
        });
        break;

      case "session.idle":
      case "session.updated":
      case "message.updated":
      case "message.completed":
      case "part.created":
      case "part.updated":
        // Canonical event types from the bridge — log and skip for now.
        this.log.debug("Canonical event received from pi JSON mode", {
          type: event.type,
        });
        break;

      default:
        // Unknown event types are logged at debug level and skipped.
        if (event.type) {
          this.log.debug("Unhandled pi JSON event type", {
            type: event.type,
          });
        }
        break;
    }
  }

  /**
   * Find a tool part by its call id, scanning accumulated messages backwards.
   * pi 0.81.x tool_execution_* events carry toolCallId but no message id, so
   * the match is keyed on the call id alone.
   */
  private _findToolPart(record: ProcessRecord, callID: string): Part | undefined {
    if (!callID) return undefined;
    for (let i = record.messages.length - 1; i >= 0; i--) {
      const msg = record.messages[i];
      for (let j = msg.parts.length - 1; j >= 0; j--) {
        const part = msg.parts[j];
        if (
          part.type === "tool" &&
          "callID" in part &&
          (part as unknown as { callID: string }).callID === callID
        ) {
          return part;
        }
      }
    }
    return undefined;
  }

  /**
   * True for plain objects (not arrays/null) — used to decide whether a
   * tool_execution_update partialResult should be shallow-merged.
   */
  private _isPlainObject(value: unknown): value is Record<string, unknown> {
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    );
  }

  /**
   * Complete the session from the JSON event stream (turn_end).
   *
   * A live pi 0.81.1 `--mode json -p` child does not exit after the turn
   * finishes (verified empirically: after turn_end/agent_settled the
   * process idles indefinitely), so completion here mirrors what the
   * process exit handler used to do exclusively:
   *
   *   1. Resolve the pending promptSync wait with the accumulated last
   *      assistant text.
   *   2. SIGTERM the still-running child so the record is not left
   *      "busy" until the 600s timeout.
   *   3. Emit session.idle so completion evaluation runs while the
   *      messages are still on the record (the exit handler's own idle
   *      emission is suppressed via record.idleEmitted).
   *
   * Idempotent per record — safe if both turn_end and process exit fire.
   */
  private _completeTurn(record: ProcessRecord): void {
    if (record.idleEmitted) return;
    record.idleEmitted = true;

    const id = record.id;

    // 1. Resolve the pending promptSync/prompt wait.
    if (record.resolve) {
      const lastAssistantText = this._extractLastAssistantText(record.messages);
      this.log.debug("Completing turn from event stream", {
        id,
        textLength: lastAssistantText.length,
      });
      record.resolve({
        parts: [{ type: "text", text: lastAssistantText }],
      });
      record.resolve = null;
      record.reject = null;
    }

    // 2. Terminate the child that would otherwise idle until the timeout.
    const proc = record.proc;
    if (proc && !proc.killed && record.exitCode === null) {
      proc.kill("SIGTERM");
    }

    // The turn is terminal from the adapter's perspective: mark the record
    // non-busy NOW so status() reports idle immediately at idle-event time.
    // The exit handler overwrites this with the child's real exit code once
    // the SIGTERM above lands.

    // The turn is terminal from the adapter's perspective: mark the record
    // non-busy NOW so status() reports idle immediately at idle-event time.
    // The exit handler overwrites this with the child's real exit code once
    // the SIGTERM above lands.
    record.exitCode = 0;

    // 3. Emit session.idle so completion evaluation triggers immediately.
    if (this.eventBridge) {
      void this.eventBridge.emit({
        type: "session.idle",
        rawType: "pi.turn_end",
        properties: { sessionID: id },
      }).catch((err: unknown) => {
        this.log.debug("Failed to emit session.idle for turn_end", {
          id,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      // 3b. Emit session.status idle so the dispatch status pipeline
      // (pi-extension.ts bridge → dispatchManager.handleSessionStatus)
      // observes the turn-level idle transition too. Additive — the
      // canonical session.idle emission above is unchanged.
      void this.eventBridge.emit({
        type: "session.status",
        rawType: "pi.turn_end",
        properties: { sessionID: id, status: "idle" },
      }).catch((err: unknown) => {
        this.log.debug("Failed to emit session.status for turn_end", {
          id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  /**
   * Extract the last assistant text part from accumulated messages.
   * Searches messages in reverse order for the first assistant text.
   */
  private _extractLastAssistantText(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.info?.role !== "assistant") continue;

      for (let j = msg.parts.length - 1; j >= 0; j--) {
        const part = msg.parts[j];
        if (part.type === "text" && "text" in part) {
          return (part as { text: string }).text;
        }
      }
    }
    return "";
  }

  /**
   * Clean up the temporary directory and system prompt file.
   * Best-effort: failures are logged but do not throw.
   */
  private async _cleanupTempDir(tmpDir: string, sysPromptPath: string): Promise<void> {
    try {
      await unlink(sysPromptPath);
    } catch {
      // Temp file may have already been cleaned up.
    }
    try {
      await rmdir(tmpDir);
    } catch {
      // Temp dir may already be removed or have other contents.
    }
  }
}
