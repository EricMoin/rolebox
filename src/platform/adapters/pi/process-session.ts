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
import { PiSessionAdapter } from "./session.ts";
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
  /** Sidecar file path for appending JSON events (null if not available). */
  sidecarPath: string | null;
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
        proc: null,
        messages: [],
        exitCode: 0,
        stderr: "",
        agentConfig: { ...DEFAULT_AGENT_CONFIG },
        resolve: null,
        reject: null,
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
      proc: null,
      messages: [],
      exitCode: null,
      stderr: "",
      agentConfig: config ?? { ...DEFAULT_AGENT_CONFIG },
      resolve: null,
      reject: null,
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
    const sysPrompt = options.system ?? record.agentConfig.systemPrompt;
    const model = record.agentConfig.model;
    const tools = record.agentConfig.tools;

    // Build the prompt text: prepend system prompt if provided.
    const fullPrompt = sysPrompt
      ? `${sysPrompt}\n\n${promptText}`
      : promptText;

    try {
      await this._spawnProcess(id, model, tools, fullPrompt, record);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error("prompt() — spawn failed", { id, error: msg });
      record.exitCode = 1;
      record.stderr += `\nSpawn error: ${msg}`;
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
    const sysPrompt = record.agentConfig.systemPrompt;
    const model = record.agentConfig.model;
    const tools = record.agentConfig.tools;

    // Build the full prompt including system prompt.
    const fullPrompt = sysPrompt
      ? `${sysPrompt}\n\n${promptText}`
      : promptText;

    // Register abort signal handler.
    const abortHandler = (): void => {
      const p = record.proc;
      if (p && !p.killed) {
        this.log.debug("promptSync() — abort signal received, killing process", { id });
        p.kill("SIGTERM");
        setTimeout(() => {
          try {
            if (p && !p.killed) {
              p.kill("SIGKILL");
            }
          } catch {
            // Best-effort SIGKILL after timeout.
          }
        }, 5000);
      }
    };

    if (options.signal) {
      options.signal.addEventListener("abort", abortHandler, { once: true });
    }

    try {
      await this._spawnProcess(id, model, tools, fullPrompt, record);

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
      setTimeout(() => {
        try {
          if (proc && !proc.killed) {
            proc.kill("SIGKILL");
            this.log.debug("abort() — sent SIGKILL after fallback", { id });
          }
        } catch {
          // Best-effort: process may have already exited.
        }
      }, 5000);

      this.log.debug("abort() — sent SIGTERM", { id });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error("abort() — failed", { id, error: msg });
      return false;
    }
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
  ): Promise<void> {
    // Set up the sidecar path before spawning.
    record.sidecarPath = join(process.cwd(), ".rolebox", "pi-sessions", `${id}.jsonl`);

    // Create a temp directory for this session's artifacts.
    const tmpDir = mkdtempSync(join(tmpdir(), `pi-process-${id.slice(0, 8)}-`));
    const sysPromptPath = join(tmpDir, "system-prompt.txt");

    // Write the system prompt to the temp file.
    // If the agent config has no system prompt, write an empty file.
    await writeFile(sysPromptPath, record.agentConfig.systemPrompt, "utf-8");

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

    this.log.debug("Spawning Pi process", { id, model, toolCount: tools.length });

    const proc = spawn(this._resolvePiBinary(), args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    record.proc = proc;

    // ── Per-process timeout (default 600s) ────────────────────────
    const timeoutHandle = setTimeout(() => {
      if (record.proc && !record.proc.killed && record.exitCode === null) {
        this.log.warn("Pi process timeout — sending SIGTERM", { id });
        record.proc.kill("SIGTERM");
        setTimeout(() => {
          if (record.proc && !record.proc.killed) {
            record.proc.kill("SIGKILL");
          }
        }, 5000);
      }
    }, PiProcessSessionAdapter.DEFAULT_PROCESS_TIMEOUT_MS);

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
    });

    // ── error handler ──────────────────────────────────────────────
    proc.on("error", (err: Error) => {
      clearTimeout(timeoutHandle);
      this.log.error("Pi process error", { id, error: err.message });
      record.stderr += `\nProcess error: ${err.message}`;

      if (record.reject) {
        record.reject(err);
        record.resolve = null;
        record.reject = null;
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
        // Start a new message entry.
        const msgInfo: MessageInfo = {
          id: event.id ?? `msg-${record.messages.length}-${Date.now()}`,
          sessionID: "",
          role: (event.role as "user" | "assistant") ?? "assistant",
          time: { created: Date.now() },
        };
        if (event.sessionID) msgInfo.sessionID = event.sessionID as string;
        record.messages.push({ info: msgInfo, parts: [] });
        break;
      }

      case "message_end": {
        // Mark the last message as completed.
        const last = record.messages[record.messages.length - 1];
        if (last) {
          last.info.time = {
            ...last.info.time,
            completed: Date.now(),
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
