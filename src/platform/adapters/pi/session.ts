/**
 * PiSessionAdapter — ISessionClient adapter for the Pi (plugin) platform.
 *
 * Pi does NOT expose a programmatic session management API to extensions.
 * Extensions get an ExtensionContext (ctx) which has ctx.sessionManager
 * for the CURRENT session only. This adapter provides graceful degradation
 * for all unsupported operations and filesystem-backed reading for
 * session data by scanning Pi JSONL session files.
 *
 * Pi stores sessions as JSONL files organized by workspace path within
 * the session directory. Each JSONL file represents one session, with one
 * JSON object per line (each line is a message).
 *
 * Session directory structure:
 *   {sessionDir}/{workspace-dir-name}/{sessionId}.jsonl
 *
 * Must NOT import from any Pi or opencode SDK.
 *
 * @module
 */

import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, basename, extname, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "tslog";
import type { ILogObj } from "tslog";
import { createSubLogger } from "../../../logger.ts";
import type { ISessionClient } from "../../ports/session-client.ts";
import type {
  SessionInfo,
  Message,
  FileDiff,
  Todo,
  SessionStatus,
} from "../../types.ts";
import type { Part } from "../../../session/types.ts";
import { readSession } from "./sidecar-persister.ts";

/**
 * Default directory where Pi stores session JSONL files.
 * Organized by working directory (workspace subdirectory).
 */
const DEFAULT_PI_SESSION_DIR = "~/.pi/agent/sessions/";

/**
 * Separator character used by Pi to encode paths into
 * workspace directory names.
 */
const PI_PATH_SEPARATOR = ";";

/**
 * Safely expand a file path, handling the ~ prefix.
 */
function expandPath(p: string): string {
  if (p.startsWith("~")) {
    return join(process.env.HOME ?? "/tmp", p.slice(1));
  }
  return p;
}

/**
 * Derive the Pi workspace directory name from an absolute path.
 * Pi replaces path separators with ";" in workspace directory names.
 * E.g., "/Users/mgl/project" becomes ";Users;mgl;project".
 */
function workspaceDirFromPath(absPath: string): string {
  // Normalize, strip leading slash, replace remaining slashes with separator.
  const normalized = absPath.replace(/^\/+/, "");
  const result = PI_PATH_SEPARATOR + normalized.split("/").join(PI_PATH_SEPARATOR);
  return result;
}

/**
 * Return true when a message contains any tool part whose state is
 * 'pending' or 'running' — i.e. an active tool/shell command.
 *
 * Mirrors the tool-part state vocabulary in src/session/types.ts
 * (ToolPart.state.status: "pending" | "running" | "completed" | "error").
 * Used by status() to avoid deriving a false 'idle' while a node executes
 * shell commands, regardless of the message's `time.completed`.
 */
export function hasInFlightToolPart(msg?: Message): boolean {
  if (!msg?.parts) return false;
  return msg.parts.some((p) => {
    if (p.type !== "tool") return false;
    const tool = p as { state?: { status?: string } };
    const status = tool.state?.status;
    return status === "pending" || status === "running";
  });
}

/**
 * ISessionClient adapter for the Pi platform.
 *
 * Supports read-only session operations via filesystem scanning
 * of Pi's JSONL session directory, plus filesystem-backed forking
 * (copying a session JSONL to a new id). The remaining mutation
 * methods (prompt, promptSync, create, abort) remain unsupported
 * and return null/false.
 */
export class PiSessionAdapter implements ISessionClient {
  private _log: Logger<ILogObj>;

  constructor(
    /** Directory where Pi stores session JSONL files. */
    public readonly sessionDir: string = DEFAULT_PI_SESSION_DIR,
  ) {
    this._log = createSubLogger("pi-session");
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Resolve the session directory, expanding ~ if present.
   */
  private _resolvedDir(): string {
    return expandPath(this.sessionDir);
  }

  /**
   * Get the workspace subdirectory path for a given working directory.
   * When directory is not provided, returns the root session dir.
   */
  private _workspacePath(directory?: string): string {
    const base = this._resolvedDir();
    if (!directory) return base;
    return join(base, workspaceDirFromPath(directory));
  }

  /**
   * Parse a JSONL file into an array of Message objects.
   * Each line of the JSONL file should be a valid JSON object
   * representing a Message (with `info` and `parts` fields).
   * Lines that fail to parse are skipped with a debug log.
   */
  private _parseMessages(filePath: string): Message[] {
    if (!existsSync(filePath)) {
      this._log.debug("Session file not found", { filePath });
      return [];
    }

    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const messages: Message[] = [];

    for (let i = 0; i < lines.length; i++) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed && typeof parsed === "object") {
          messages.push(parsed as Message);
        }
      } catch {
        this._log.debug("Failed to parse JSONL line", {
          filePath,
          line: i + 1,
        });
      }
    }

    return messages;
  }

  /**
   * Build a SessionInfo from parsed messages and session ID.
   * Extracts metadata from the messages: title from first user message,
   * timestamps from first/last messages, model from any message.
   */
  private _buildSessionInfo(
    id: string,
    messages: Message[],
    workspaceDir: string,
    directory?: string,
  ): SessionInfo {
    const first = messages[0];
    const last = messages[messages.length - 1];

    // Derive title from the first user message text.
    let title = id;
    if (first) {
      const userPart = first.parts?.find(
        (p) => p.type === "text" && "text" in p,
      ) as { text?: string } | undefined;
      if (userPart?.text) {
        title = userPart.text.slice(0, 80).replace(/\n/g, " ").trim() || id;
      }
    }

    // Find modelID from the first message that specifies one.
    const firstWithModel = messages.find((m) => m.info?.modelID);
    const version = firstWithModel?.info?.modelID ?? "1.0";

    return {
      id,
      projectID: directory ?? workspaceDir,
      directory: directory ?? workspaceDir,
      parentID: undefined,
      summary: {
        additions: 0,
        deletions: 0,
        files: 0,
        diffs: [],
      },
      title,
      version,
      time: {
        created: first?.info?.time?.created ?? Date.now(),
        updated: last?.info?.time?.created ?? Date.now(),
      },
    };
  }

  /**
   * List all JSONL session files in a given directory.
   * When `recurse` is true (root dir), also scans one level of
   * workspace subdirectories.
   * Returns a generator of { id, filePath } pairs.
   */
  private *_scanSessionFiles(
    scanDir: string,
    recurse?: boolean,
  ): Generator<{ id: string; filePath: string }> {
    if (!existsSync(scanDir)) return;

    const entries = readdirSync(scanDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && extname(entry.name) === ".jsonl") {
        const id = basename(entry.name, ".jsonl");
        yield { id, filePath: join(scanDir, entry.name) };
      }
    }

    // When recursing, scan one level deep into workspace subdirectories.
    if (recurse) {
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const subDir = join(scanDir, entry.name);
        const subEntries = readdirSync(subDir, { withFileTypes: true });
        for (const subEntry of subEntries) {
          if (subEntry.isFile() && extname(subEntry.name) === ".jsonl") {
            const id = basename(subEntry.name, ".jsonl");
            yield { id, filePath: join(subDir, subEntry.name) };
          }
        }
      }
    }
  }

  /**
   * Find a session file by ID across all workspace subdirectories
   * (or within a specific workspace directory if provided).
   */
  private _findSessionFile(
    id: string,
    directory?: string,
  ): string | null {
    const base = this._resolvedDir();
    if (!existsSync(base)) return null;

    // If directory is specified, check only that workspace dir.
    if (directory) {
      const wsDir = this._workspacePath(directory);
      const candidate = join(wsDir, `${id}.jsonl`);
      if (existsSync(candidate)) return candidate;
      return null;
    }

    // Otherwise scan all workspace subdirectories.
    const entries = readdirSync(base, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(base, entry.name, `${id}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }

    return null;
  }

  // ── Unsupported methods ─────────────────────────────────────────────────

  /**
   * Pi doesn't allow extensions to prompt sessions — return null.
   */
  async prompt(
    _id: string,
    _options: {
      parts: Array<{ type: string; text: string }>;
      noReply?: boolean;
      system?: string;
      agent?: string;
      model?: { providerID: string; modelID: string };
    },
  ): Promise<{ id: string } | null> {
    this._log.debug("prompt() is unsupported on Pi — returning null");
    return null;
  }

  /**
   * Pi doesn't allow extensions to prompt sessions — return null.
   */
  async promptSync(
    _id: string,
    _options: {
      parts: Array<{ type: string; text: string }>;
      agent?: string;
      signal?: AbortSignal;
    },
  ): Promise<{ parts: Array<{ type: string; text?: string }> } | null> {
    this._log.debug("promptSync() is unsupported on Pi — returning null");
    return null;
  }

  /**
   * Pi manages session lifecycle internally — return null.
   */
  async create(
    _options: {
      directory: string;
      agent?: string;
      parentID?: string;
    },
  ): Promise<SessionInfo | null> {
    this._log.debug("create() is unsupported on Pi — returning null");
    return null;
  }

  /**
   * Pi manages session lifecycle internally — return false.
   */
  async abort(_id: string): Promise<boolean> {
    this._log.debug("abort() is unsupported on Pi — returning false");
    return false;
  }

  /**
   * Pi does not support session compaction — always returns false.
   */
  async compact(_id: string): Promise<boolean> {
    this._log.debug("compact() is unsupported on Pi — returning false");
    return false;
  }

  /**
   * Fork a session by copying its JSONL file to a new session id within
   * the same workspace directory.
   *
   * When `options.messageID` is provided, the fork keeps only the messages
   * up to and including that message (truncated prefix). When the messageID
   * is not found in the source session, no truncation is applied and all
   * messages are copied.
   *
   * Returns a fresh SessionInfo derived from the copied file, or null only
   * when the source session file does not exist.
   */
  async fork(
    id: string,
    options?: { directory?: string; messageID?: string },
  ): Promise<SessionInfo | null> {
    this._log.debug("fork() forking session", { id, options });

    const sourcePath = this._findSessionFile(id, options?.directory);
    if (!sourcePath) {
      this._log.debug("fork() source session not found", { id });
      return null;
    }

    const sourceMessages = this._parseMessages(sourcePath);

    // Truncate at the given messageID — keep messages up to and including it.
    let forkMessages = sourceMessages;
    if (options?.messageID) {
      const idx = sourceMessages.findIndex(
        (m) => m.info?.id === options.messageID,
      );
      if (idx === -1) {
        this._log.debug("fork() messageID not found — copying full session", {
          messageID: options.messageID,
        });
      } else {
        forkMessages = sourceMessages.slice(0, idx + 1);
      }
    }

    // Write the fork as a new session file next to the source (same workspace dir).
    const newId = randomUUID();
    const forkPath = join(dirname(sourcePath), `${newId}.jsonl`);
    const lines = forkMessages.map((m) => JSON.stringify(m)).join("\n");
    writeFileSync(forkPath, lines ? lines + "\n" : "", "utf-8");

    const info = this._buildSessionInfo(
      newId,
      forkMessages,
      basename(dirname(forkPath)),
      options?.directory,
    );
    info.parentID = id;

    this._log.debug("fork() created fork", { newId, forkPath });
    return info;
  }

  // ── Filesystem-backed read methods ─────────────────────────────────────

  /**
   * List sessions by scanning Pi JSONL session files.
   *
   * When `directory` is provided, filters to sessions in that workspace.
   * Workspace directories are derived from the path using Pi's path encoding.
   *
   * Returns session metadata derived from the JSONL content.
   */
  async list(directory?: string): Promise<SessionInfo[]> {
    const scanDir = this._workspacePath(directory);
    this._log.debug("list() scanning session directory", { scanDir });

    if (!existsSync(scanDir)) {
      this._log.debug("Session directory does not exist", { scanDir });
      return [];
    }

    const results: SessionInfo[] = [];
    // When scanning root (no directory filter), recurse into workspace subdirs.
    const shouldRecurse = !directory;
    for (const { id, filePath } of this._scanSessionFiles(scanDir, shouldRecurse)) {
      const messages = this._parseMessages(filePath);
      const info = this._buildSessionInfo(
        id,
        messages,
        basename(scanDir),
        directory,
      );
      results.push(info);
    }

    // Sort by created time descending (newest first).
    results.sort((a, b) => b.time.created - a.time.created);
    this._log.debug("list() returning sessions", { count: results.length });
    return results;
  }

  /**
   * Get a single session by ID.
   * Searches workspace subdirectories (or a specific directory if provided).
   * Falls back to the retained rolebox sidecar when no Pi-native session
   * file exists (sub-agent transcripts spawned via `pi --no-session`).
   */
  async get(
    id: string,
    directory?: string,
  ): Promise<SessionInfo | null> {
    this._log.debug("get() looking up session", { id, directory });

    const filePath = this._findSessionFile(id, directory);
    if (!filePath) {
      const sidecarMessages = await this._messagesFromSidecar(id);
      if (sidecarMessages !== null && sidecarMessages.length > 0) {
        this._log.debug("get() fell back to retained sidecar", { id });
        return this._buildSessionInfo(
          id,
          sidecarMessages,
          basename(dirname(this._sidecarPath(id))),
          directory,
        );
      }
      this._log.debug("Session not found", { id });
      return null;
    }

    const messages = this._parseMessages(filePath);
    if (messages.length === 0) return null;

    return this._buildSessionInfo(
      id,
      messages,
      basename(dirname(filePath)),
      directory,
    );
  }

  /**
   * Get messages for a session by parsing its JSONL file.
   * Optionally limits the number of messages returned.
   *
   * Falls back to the retained rolebox sidecar
   * (`.rolebox/pi-sessions/{id}.jsonl`) when the session has no Pi-native
   * session file — this is how sub-agent transcripts survive after their
   * `pi --no-session` child exits (see sidecar-persister.ts).
   */
  async messages(
    id: string,
    options?: { directory?: string; limit?: number },
  ): Promise<Message[]> {
    this._log.debug("messages() reading session", { id, options });

    const filePath = this._findSessionFile(id, options?.directory);
    if (!filePath) {
      const sidecarMessages = await this._messagesFromSidecar(id);
      if (sidecarMessages !== null) {
        if (options?.limit && options.limit > 0) {
          return sidecarMessages.slice(0, options.limit);
        }
        return sidecarMessages;
      }
      this._log.debug("Session not found for messages", { id });
      return [];
    }

    const messages = this._parseMessages(filePath);
    if (options?.limit && options.limit > 0) {
      return messages.slice(0, options.limit);
    }
    return messages;
  }

  /**
   * Get child sessions — unsupported on Pi.
   *
   * Pi stores each session as a single JSONL file where all messages
   * share the same sessionID. There is no parent-child relationship
   * data available in the file format, so this always returns empty.
   */
  async children(
    _id: string,
    _directory?: string,
  ): Promise<SessionInfo[]> {
    this._log.debug("children() is unsupported on Pi — returning []");
    return [];
  }

  /**
   * Get todo items from a session's messages.
   * Searches message parts for structured data with todo-like content.
   */
  async todo(
    id: string,
    directory?: string,
  ): Promise<Todo[]> {
    this._log.debug("todo() extracting from session", { id });

    const filePath = this._findSessionFile(id, directory);
    if (!filePath) return [];

    const messages = this._parseMessages(filePath);
    const todos: Todo[] = [];

    // Extract any todo-like data from message parts.
    // Pi sessions may store todos as structured part data.
    for (const msg of messages) {
      for (const part of msg.parts ?? []) {
        // Check for structured parts with todo metadata.
        const maybe = part as Record<string, unknown>;
        if (
          maybe.todos !== undefined &&
          Array.isArray(maybe.todos)
        ) {
          for (const t of maybe.todos as Todo[]) {
            if (t && typeof t === "object" && "content" in t) {
              todos.push(t);
            }
          }
        }
      }
    }

    return todos;
  }

  /**
   * Get file diffs from a session's messages.
   * Searches message parts for tool call results containing file diffs.
   * Optionally filters by messageID.
   */
  async diff(
    id: string,
    options?: { directory?: string; messageID?: string },
  ): Promise<FileDiff[]> {
    this._log.debug("diff() extracting from session", { id, options });

    const filePath = this._findSessionFile(id, options?.directory);
    if (!filePath) return [];

    const messages = this._parseMessages(filePath);
    const diffs: FileDiff[] = [];

    for (const msg of messages) {
      // If messageID filter is set, skip non-matching messages.
      if (options?.messageID && msg.info?.id !== options.messageID) continue;

      for (const part of msg.parts ?? []) {
        // Check tool parts for file diff data in their output.
        if (part.type === "tool") {
          const toolPart = part as { state?: { output?: string } };
          const output = toolPart.state?.output;
          if (output) {
            try {
              const parsed = JSON.parse(output);
              if (Array.isArray(parsed)) {
                for (const item of parsed) {
                  if (item && typeof item === "object" && "file" in item) {
                    diffs.push({
                      file: item.file ?? "",
                      before: item.before ?? "",
                      after: item.after ?? "",
                      additions: item.additions ?? 0,
                      deletions: item.deletions ?? 0,
                    });
                  }
                }
              }
            } catch {
              // Output is not JSON — not a structured diff.
            }
          }
        }

        // Check for structured parts with diff data.
        const maybe = part as Record<string, unknown>;
        if (maybe.diffs !== undefined && Array.isArray(maybe.diffs)) {
          for (const d of maybe.diffs as FileDiff[]) {
            if (d && typeof d === "object" && "file" in d) {
              diffs.push(d);
            }
          }
        }
      }
    }

    // Deduplicate by file path.
    const seen = new Set<string>();
    return diffs.filter((d) => {
      if (seen.has(d.file)) return false;
      seen.add(d.file);
      return true;
    });
  }

  /**
   * Get the status of a session.
   * Derives status from the session's message content.
   * Returns "idle" for sessions with complete messages,
   * "busy" if the last message has no completion time.
   * Falls back to the retained sidecar for sessions without a
   * Pi-native file (sub-agent transcripts).
   */
  async status(
    id: string,
    directory?: string,
  ): Promise<SessionStatus | null> {
    this._log.debug("status() for session", { id });

    const filePath = this._findSessionFile(id, directory);
    if (!filePath) {
      const sidecarMessages = await this._messagesFromSidecar(id);
      if (sidecarMessages === null || sidecarMessages.length === 0) return null;
      return this._deriveStatus(sidecarMessages);
    }

    const messages = this._parseMessages(filePath);
    if (messages.length === 0) return null;
    return this._deriveStatus(messages);
  }

  // ── Sidecar fallback (retained sub-agent transcripts) ────────────────────

  /**
   * Resolve the rolebox sidecar path for a session id:
   * `{cwd}/.rolebox/pi-sessions/{id}.jsonl` (the same layout used by
   * sidecar-persister.ts).
   */
  private _sidecarPath(id: string): string {
    return join(process.cwd(), ".rolebox", "pi-sessions", `${id}.jsonl`);
  }

  /**
   * Read messages from the retained rolebox sidecar for a session.
   * Returns `null` when no sidecar exists (session genuinely unknown),
   * otherwise replays the raw pi JSON events into Message objects.
   */
  private async _messagesFromSidecar(id: string): Promise<Message[] | null> {
    const sidecarPath = this._sidecarPath(id);
    if (!existsSync(sidecarPath)) return null;

    this._log.debug("Reading messages from retained sidecar", {
      id,
      sidecarPath,
    });
    const events = await readSession(id);
    if (!events || events.length === 0) return [];

    const messages: Message[] = [];
    for (const rawEvent of events) {
      const event = rawEvent as Record<string, unknown>;
      const type = typeof event.type === "string" ? event.type : "";
      switch (type) {
        case "message_start": {
          // pi 0.81.x payload: { type, message } — adopt a message shell.
          const m = (event.message ?? {}) as { role?: string; timestamp?: number };
          const role: "user" | "assistant" = m.role === "user" ? "user" : "assistant";
          const msgInfo = {
            id: String(event.messageID ?? event.id ?? `msg-${messages.length}-${Date.now()}`),
            sessionID: String(event.sessionID ?? ""),
            role,
            time: { created: (m.timestamp as number) ?? Date.now() },
          };
          // Adopt an empty shell instead of stacking a duplicate.
          const last = messages[messages.length - 1];
          if (last && last.parts.length === 0 && last.info.role === role) {
            last.info = msgInfo;
          } else {
            messages.push({ info: msgInfo, parts: [] });
          }
          break;
        }
        case "message_update": {
          // Streaming text_delta / thinking_delta.
          const sub = (event.assistantMessageEvent ?? {}) as {
            type?: string;
            contentIndex?: number;
            delta?: string;
          };
          const last = messages[messages.length - 1];
          if (!last || typeof sub.delta !== "string" || !sub.delta) break;
          const isText = sub.type === "text_delta";
          if (!isText && sub.type !== "thinking_delta") break;
          const contentIndex = typeof sub.contentIndex === "number" ? sub.contentIndex : 0;
          const slotId = `${isText ? "text" : "reasoning"}-slot-${contentIndex}`;
          let part = last.parts.find((p) => p.id === slotId);
          if (!part) {
            part = {
              id: slotId,
              sessionID: last.info.sessionID,
              messageID: last.info.id,
              type: isText ? "text" : "reasoning",
              text: "",
              time: { start: Date.now() },
            };
            last.parts.push(part as Part);
          }
          (part as { text: string }).text += sub.delta;
          break;
        }
        case "message_end": {
          // Finalized message replaces parts wholesale.
          const m = (event.message ?? {}) as {
            role?: string;
            content?: string | Array<Record<string, unknown>>;
            stopReason?: string;
            errorMessage?: string;
          };
          const last = messages[messages.length - 1];
          if (!last) break;
          if (m.role === "user" || m.role === "assistant") last.info.role = m.role;
          last.info.time = { ...last.info.time, completed: Date.now() };
          const rebuilt: Part[] = [];
          if (typeof m.content === "string") {
            rebuilt.push({
              id: `text-0-${Date.now()}`,
              sessionID: last.info.sessionID,
              messageID: last.info.id,
              type: "text",
              text: m.content,
              time: { start: Date.now() },
            });
          } else if (Array.isArray(m.content)) {
            for (const entry of m.content) {
              const partId = `p-${rebuilt.length}-${Date.now()}`;
              switch (entry.type) {
                case "text":
                  rebuilt.push({
                    id: partId,
                    sessionID: last.info.sessionID,
                    messageID: last.info.id,
                    type: "text",
                    text: String(entry.text ?? ""),
                    time: { start: Date.now() },
                  });
                  break;
                case "thinking":
                  rebuilt.push({
                    id: partId,
                    sessionID: last.info.sessionID,
                    messageID: last.info.id,
                    type: "reasoning",
                    text: String(entry.thinking ?? ""),
                    time: { start: Date.now() },
                  });
                  break;
                case "toolCall": {
                  // Reuse the live tool part (built by tool_execution_* events)
                  // so its completed/error state survives the wholesale
                  // replacement — mirrors process-session.ts _handleJsonEvent.
                  const tcId = String(entry.id ?? "");
                  const live = last.parts.find(
                    (p) => p.type === "tool" &&
                      "callID" in p &&
                      (p as { callID: string }).callID === tcId,
                  );
                  rebuilt.push(live ?? {
                    id: partId,
                    sessionID: last.info.sessionID,
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
                  break;
              }
            }
          }
          if (rebuilt.length > 0) last.parts = rebuilt;
          if (typeof m.stopReason === "string" && m.stopReason) {
            last.info.finish = m.stopReason;
          }
          if (m.stopReason === "error") {
            last.info.error = typeof m.errorMessage === "string" && m.errorMessage
              ? m.errorMessage
              : "error";
          }
          break;
        }
        case "text": {
          // Legacy/plain text event — append to the last message.
          const last = messages[messages.length - 1];
          if (!last) break;
          const text = typeof event.text === "string" ? event.text : "";
          const existing = last.parts.find((p) => p.type === "text");
          if (existing) {
            (existing as { text: string }).text += text;
          } else {
            last.parts.push({
              id: String(event.id ?? `text-${Date.now()}`),
              sessionID: last.info.sessionID,
              messageID: last.info.id,
              type: "text",
              text,
              time: { start: Date.now() },
            });
          }
          break;
        }
        case "reasoning": {
          const last = messages[messages.length - 1];
          if (!last) break;
          last.parts.push({
            id: String(event.id ?? `reasoning-${Date.now()}`),
            sessionID: last.info.sessionID,
            messageID: last.info.id,
            type: "reasoning",
            text: typeof event.text === "string" ? event.text : "",
            time: { start: Date.now() },
          });
          break;
        }
        case "tool_execution_start": {
          const last = messages[messages.length - 1];
          if (!last) break;
          const callID = String(event.toolCallId ?? event.callID ?? "");
          if (!callID) break;
          if (!last.parts.some((p) => p.type === "tool" && "callID" in p && (p as { callID: string }).callID === callID)) {
            last.parts.push({
              id: String(event.id ?? `tool-${Date.now()}`),
              sessionID: last.info.sessionID,
              messageID: last.info.id,
              type: "tool",
              callID,
              tool: String(event.toolName ?? "unknown"),
              state: {
                status: "running",
                input: (event.args as Record<string, unknown>) ?? {},
              },
            });
          }
          break;
        }
        case "tool_execution_end": {
          const last = messages[messages.length - 1];
          if (!last) break;
          const callID = String(event.toolCallId ?? event.callID ?? "");
          const match = last.parts.find(
            (p) => p.type === "tool" && "callID" in p && (p as { callID: string }).callID === callID,
          ) as (Part & { state?: Record<string, unknown> }) | undefined;
          if (!match) break;
          const output = event.result === undefined
            ? ""
            : typeof event.result === "string"
              ? event.result
              : JSON.stringify(event.result);
          if (event.isError === true) {
            match.state = {
              status: "error",
              error: output || "Tool execution failed",
              time: { start: Date.now(), end: Date.now() },
            };
          } else {
            match.state = {
              ...match.state,
              status: "completed",
              output,
              time: { start: Date.now(), end: Date.now() },
            };
          }
          break;
        }
        case "tool_call": {
          const last = messages[messages.length - 1];
          if (!last) break;
          last.parts.push({
            id: String(event.id ?? `tool-${Date.now()}`),
            sessionID: last.info.sessionID,
            messageID: last.info.id,
            type: "tool",
            callID: String(event.callID ?? `call-${Date.now()}`),
            tool: String(event.tool ?? "unknown"),
            state: {
              status: "running",
              input: (event.input as Record<string, unknown>) ?? {},
            },
          });
          break;
        }
        case "tool_result": {
          const last = messages[messages.length - 1];
          if (!last) break;
          const callID = String(event.callID ?? "");
          const match = last.parts.find(
            (p) => p.type === "tool" && "callID" in p && (p as { callID: string }).callID === callID,
          ) as (Part & { state?: Record<string, unknown> }) | undefined;
          if (!match) break;
          match.state = {
            ...match.state,
            status: "completed",
            output: String(event.output ?? ""),
            title: String(event.title ?? ""),
            metadata: (event.metadata as Record<string, unknown>) ?? {},
            time: {
              start: Date.now(),
              end: Date.now(),
            },
          };
          break;
        }
        default:
          // Non-message events (turn_end, agent_*, session.*, step-finish,
          // tool_execution_update, ...) do not change the transcript.
          break;
      }
    }

    return messages;
  }

  /** Derive a SessionStatus from parsed messages (shared by status paths). */
  private _deriveStatus(messages: Message[]): SessionStatus | null {
    if (messages.length === 0) return null;
    const lastMsg = messages[messages.length - 1];
    const lastInfo = lastMsg?.info;

    // If the last message still contains an in-flight tool/shell command, the
    // session is actively executing — report busy regardless of that message's
    // completed time. This removes the false 'idle' derivation while a node
    // runs shell commands.
    if (hasInFlightToolPart(lastMsg)) {
      return { type: "busy" };
    }

    // If the last message has completed time, session is likely finished.
    if (lastInfo?.time?.completed) {
      return { type: "idle" };
    }

    // If the last message is from the user and has no response,
    // the session is waiting for input (idle).
    if (lastInfo?.role === "user") {
      return { type: "idle" };
    }

    // Otherwise assume busy (assistant message in progress).
    return { type: "busy" };
  }
}
