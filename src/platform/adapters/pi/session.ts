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

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename, extname, dirname } from "node:path";
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
 * ISessionClient adapter for the Pi platform.
 *
 * Supports read-only session operations via filesystem scanning
 * of Pi's JSONL session directory. All mutation methods
 * (prompt, promptSync, create, abort, fork) remain unsupported
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
   * Pi doesn't allow extensions to fork sessions — return null.
   */
  async fork(
    _id: string,
    _options?: { directory?: string; messageID?: string },
  ): Promise<SessionInfo | null> {
    this._log.debug("fork() is unsupported on Pi — returning null");
    return null;
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
   */
  async get(
    id: string,
    directory?: string,
  ): Promise<SessionInfo | null> {
    this._log.debug("get() looking up session", { id, directory });

    const filePath = this._findSessionFile(id, directory);
    if (!filePath) {
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
   */
  async messages(
    id: string,
    options?: { directory?: string; limit?: number },
  ): Promise<Message[]> {
    this._log.debug("messages() reading session", { id, options });

    const filePath = this._findSessionFile(id, options?.directory);
    if (!filePath) {
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
   */
  async status(
    id: string,
    directory?: string,
  ): Promise<SessionStatus | null> {
    this._log.debug("status() for session", { id });

    const filePath = this._findSessionFile(id, directory);
    if (!filePath) return null;

    const messages = this._parseMessages(filePath);
    if (messages.length === 0) return null;

    const lastMsg = messages[messages.length - 1];
    const lastInfo = lastMsg?.info;

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
