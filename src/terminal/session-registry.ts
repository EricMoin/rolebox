/**
 * session-registry.ts — live interactive-terminal session management.
 *
 * Backs the `interactive_terminal` tool. Keeps child processes alive across
 * multiple tool calls so the model can drive REPLs, interactive prompts, and
 * (when a real PTY is available) full-screen TUI apps.
 *
 * Backend selection is a HYBRID:
 *   1. Prefer `node-pty` (a real pseudo-terminal → correct isatty, resize,
 *      full-screen TUIs). It is an OPTIONAL dependency — absent on platforms
 *      where it cannot be built.
 *   2. Fall back to `node:child_process` pipes. Works for line-oriented
 *      interactive programs; does NOT satisfy programs that require a TTY.
 *
 * PTY sessions additionally feed a VT100 screen emulator (screen-buffer.ts)
 * so reads can return the CURRENT RENDERED SCREEN (like `tmux capture-pane`)
 * instead of the raw repaint stream — essential for full-screen TUIs that
 * redraw in place. The emulator also auto-answers terminal queries (cursor
 * position, device attributes, window size) that TUIs block on.
 *
 * This module MUST NOT import any platform SDK.
 */

import { spawn as cpSpawn } from "node:child_process";
import { createSubLogger } from "../logger.ts";
import { TerminalScreen } from "./screen-buffer.ts";

const log = createSubLogger("interactive-terminal");

// ── Tunables ─────────────────────────────────────────────────────────────────

/** Cap on retained output per session (chars). Oldest output is dropped. */
const MAX_BUFFER_CHARS = 500_000;
/** Cap on a single read's returned text (chars). Keeps tool output sane. */
const MAX_READ_CHARS = 64_000;
/** Default idle timeout before a session is auto-killed (ms). */
const DEFAULT_IDLE_MS = 10 * 60_000;
/** Default overall wait budget for a read that blocks (ms). */
const DEFAULT_READ_TIMEOUT_MS = 10_000;
/** Hard ceiling on any read wait budget (ms). */
const MAX_READ_TIMEOUT_MS = 10 * 60_000;
/** Default settle window when a plain read is issued with no wait spec (ms). */
const DEFAULT_SETTLE_MS = 200;
/** Poll interval for blocking reads (ms). */
const POLL_MS = 25;
/** How long open() waits for the program's first output (ms). */
const OPEN_FIRST_OUTPUT_MS = 1_500;
/** How long open() waits to catch an immediate spawn failure (ms). */
const OPEN_SPAWN_ERROR_MS = 250;
/** Grace period between SIGTERM and SIGKILL on close (ms). */
const CLOSE_GRACE_MS = 1_500;
/** Max concurrent sessions per owner. */
const MAX_SESSIONS_PER_OWNER = 8;
/** Screen paint operations before a pty session is considered a full-screen TUI. */
const TUI_PAINT_OPS_THRESHOLD = 16;

// ── Backend abstraction ───────────────────────────────────────────────────────

export type TerminalBackendKind = "pty" | "pipe";
/** Backend selection: auto prefers a real PTY, falling back to pipes. */
export type TerminalBackendPref = "auto" | "pty" | "pipe";

interface Backend {
  readonly kind: TerminalBackendKind;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

// Lazy, cached node-pty module resolution. `undefined` = not yet attempted.
let ptyModule: unknown | null | undefined = undefined;
async function loadPty(): Promise<Record<string, unknown> | null> {
  if (ptyModule !== undefined) return ptyModule as Record<string, unknown> | null;
  try {
    // Optional dependency — may be absent.
    ptyModule = (await import("node-pty")) as unknown as Record<string, unknown>;
    log.debug("node-pty loaded — PTY backend available");
  } catch {
    ptyModule = null;
    log.debug("node-pty unavailable — falling back to pipe backend");
  }
  return ptyModule as Record<string, unknown> | null;
}

// ── Session model ──────────────────────────────────────────────────────────────

export interface OpenOptions {
  command?: string;
  args?: string[];
  shell?: boolean;
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  idleTimeoutMs?: number;
  /** Caller-requested session id (sanitized; suffixed on collision). */
  requestedId?: string;
  /**
   * Backend preference. Default "auto" (prefer node-pty, fall back to pipes).
   * Env `ROLEBOX_TERMINAL_BACKEND` overrides the default when this is unset.
   * NOTE: node-pty is unreliable under the Bun runtime (input written after a
   * short delay can be dropped) — force "pipe" there for line-oriented programs.
   */
  backend?: TerminalBackendPref;
}

export type ReadMode = "auto" | "stream" | "screen";

export interface ReadOptions {
  waitMs?: number;
  until?: string;
  timeoutMs?: number;
  fromStart?: boolean;
  stripAnsi?: boolean;
  /**
   * What to read:
   *  - "stream": raw output stream since the last read (append-only view).
   *  - "screen": the current rendered screen snapshot (pty only) — the right
   *    view for full-screen TUIs that repaint in place.
   *  - "auto" (default): "screen" when the pty session behaves like a
   *    full-screen TUI (alt-screen or heavy cursor addressing), else "stream".
   */
  mode?: ReadMode;
  abort?: AbortSignal;
}

export interface ReadResult {
  text: string;
  /** Which view produced `text`. */
  mode: "stream" | "screen";
  /** For `until` reads: whether the pattern matched. null when no `until`. */
  matched: boolean | null;
  /** True when the wait budget expired before the wait condition was met. */
  timedOut: boolean;
  /** True when the read was cancelled via the abort signal. */
  aborted: boolean;
  /** True when the read text was truncated to the last MAX_READ_CHARS chars. */
  truncated: boolean;
  /** For screen reads: whether the snapshot differs from the previous one. */
  screenChanged: boolean | null;
}

export interface TerminalSession {
  id: string;
  owner: string;
  backend: TerminalBackendKind;
  command: string;
  cols: number;
  rows: number;
  createdAt: number;
  lastActivityAt: number;
  lastDataAt: number;
  alive: boolean;
  exitCode: number | null;
  exitSignal: string | null;
  /** Spawn-time failure message (e.g. ENOENT), if any. */
  spawnError: string | null;
  /** Retained output chunks (rolling, capped). */
  chunks: string[];
  /** Read cursor: index into the logical concatenation of `chunks`. */
  readCursor: number;
  /** Total chars currently retained across `chunks`. */
  retained: number;
  /** Total chars ever produced (for cursor math after trimming). */
  produced: number;
  /** VT100 screen emulator (pty backend only). */
  screen: TerminalScreen | null;
  /** Last screen snapshot returned to a reader (for change detection). */
  lastScreenSnapshot: string | null;
  handle: Backend;
  idleTimer: ReturnType<typeof setTimeout> | null;
  idleTimeoutMs: number;
}

const sessions = new Map<string, TerminalSession>();
let counter = 0;

// ── Helpers ─────────────────────────────────────────────────────────────────

const ANSI_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function nowShellDefault(): string {
  if (process.platform === "win32") return process.env.COMSPEC ?? "powershell.exe";
  return process.env.SHELL ?? "/bin/bash";
}

function touch(sess: TerminalSession): void {
  sess.lastActivityAt = Date.now();
  armIdleTimer(sess);
}

function armIdleTimer(sess: TerminalSession): void {
  if (sess.idleTimer) clearTimeout(sess.idleTimer);
  if (!sess.alive) return;
  sess.idleTimer = setTimeout(() => {
    log.debug("idle timeout — killing session", { id: sess.id });
    appendOutput(sess, `\n[interactive_terminal] session "${sess.id}" killed after ${sess.idleTimeoutMs}ms idle\n`);
    try {
      sess.handle.kill();
    } catch {
      /* ignore */
    }
  }, sess.idleTimeoutMs);
  // Do not keep the event loop alive solely for the idle timer.
  (sess.idleTimer as unknown as { unref?: () => void }).unref?.();
}

function appendOutput(sess: TerminalSession, data: string): void {
  if (!data) return;
  sess.chunks.push(data);
  sess.retained += data.length;
  sess.produced += data.length;
  sess.lastDataAt = Date.now();
  // Trim from the front when over the cap.
  while (sess.retained > MAX_BUFFER_CHARS && sess.chunks.length > 1) {
    const dropped = sess.chunks.shift()!;
    sess.retained -= dropped.length;
    // Shift the logical baseline; clamp the read cursor if it fell behind.
    const baseline = sess.produced - sess.retained;
    if (sess.readCursor < baseline) sess.readCursor = baseline;
  }
}

/** Return currently-buffered text from `readCursor` (or from start). */
function peek(sess: TerminalSession, fromStart: boolean): string {
  const all = sess.chunks.join("");
  if (fromStart) return all;
  const baseline = sess.produced - all.length;
  const offset = Math.max(0, sess.readCursor - baseline);
  return all.slice(offset);
}

/** Advance the read cursor to consume everything currently buffered. */
function consume(sess: TerminalSession): void {
  sess.readCursor = sess.produced;
}

/** Whether the pty session looks like a full-screen TUI. */
export function isTuiSession(sess: TerminalSession): boolean {
  return !!sess.screen && (sess.screen.altActive || sess.screen.paintOps >= TUI_PAINT_OPS_THRESHOLD);
}

// ── Backend construction ────────────────────────────────────────────────────

interface SpawnResolved {
  file: string;
  args: string[];
  command: string;
}

function resolveSpawn(opts: OpenOptions): SpawnResolved {
  const command = opts.command?.trim() || nowShellDefault();
  if (opts.shell) {
    if (process.platform === "win32") {
      return { file: nowShellDefault(), args: ["/c", command], command };
    }
    return { file: "/bin/sh", args: ["-c", command], command };
  }
  return { file: command, args: opts.args ?? [], command };
}

async function makeBackend(sess: TerminalSession, opts: OpenOptions): Promise<void> {
  const { file, args } = resolveSpawn(opts);
  const cols = sess.cols;
  const rows = sess.rows;
  const env = { ...process.env, TERM: process.env.TERM ?? "xterm-256color", ...(opts.env ?? {}) };
  const cwd = opts.cwd || process.cwd();

  const pref: TerminalBackendPref =
    opts.backend ??
    ((process.env.ROLEBOX_TERMINAL_BACKEND as TerminalBackendPref | undefined) || "auto");

  const pty = pref === "pipe" ? null : await loadPty();
  if (pty && typeof (pty as { spawn?: unknown }).spawn === "function") {
    const spawnFn = (pty as { spawn: (...a: unknown[]) => unknown }).spawn;
    let proc: {
      write(d: string): void;
      resize(c: number, r: number): void;
      kill(s?: string): void;
      onData(cb: (d: string) => void): void;
      onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
    };
    try {
      proc = spawnFn(file, args, { name: "xterm-256color", cols, rows, cwd, env }) as typeof proc;
    } catch (err) {
      if (pref === "pty") {
        throw new Error(`Failed to spawn "${file}" on the pty backend: ${(err as Error).message}`);
      }
      // auto — fall through to pipes below.
      log.debug("pty spawn failed — falling back to pipe backend", { error: String(err) });
      proc = null as unknown as typeof proc;
    }
    if (proc) {
      sess.backend = "pty";
      // Screen emulator: mirrors the byte stream into a rendered cols×rows
      // grid and auto-answers terminal queries the TUI would block on.
      sess.screen = new TerminalScreen({
        cols,
        rows,
        respond: (d) => {
          try {
            if (sess.alive) proc.write(d);
          } catch {
            /* ignore */
          }
        },
      });
      proc.onData((d) => {
        appendOutput(sess, d);
        try {
          sess.screen?.feed(d);
        } catch (err) {
          // The emulator must never take the session down.
          log.debug("screen emulator feed error", { id: sess.id, error: String(err) });
        }
      });
      proc.onExit((e) => onExit(sess, e.exitCode ?? 0, e.signal != null ? String(e.signal) : null));
      sess.handle = {
        kind: "pty",
        write: (d) => proc.write(d),
        resize: (c, r) => proc.resize(c, r),
        kill: (s) => proc.kill(s),
      };
      return;
    }
  }
  if (pref === "pty") {
    throw new Error(
      "PTY backend requested but node-pty is not available. Install the optional " +
        "`node-pty` dependency, or use backend \"auto\"/\"pipe\".",
    );
  }

  // Pipe fallback.
  const cp = cpSpawn(file, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  sess.backend = "pipe";
  cp.stdout?.setEncoding("utf8");
  cp.stderr?.setEncoding("utf8");
  cp.stdout?.on("data", (d: string) => appendOutput(sess, d));
  cp.stderr?.on("data", (d: string) => appendOutput(sess, d));
  cp.on("exit", (code, signal) => onExit(sess, code ?? 0, signal ?? null));
  cp.on("error", (err) => {
    sess.spawnError = (err as Error).message;
    appendOutput(sess, `\n[interactive_terminal] spawn error: ${(err as Error).message}\n`);
    onExit(sess, -1, null);
  });
  cp.stdin?.on("error", (err) => {
    // EPIPE etc. — surface in the output stream instead of crashing the host.
    appendOutput(sess, `\n[interactive_terminal] stdin error: ${(err as Error).message}\n`);
  });
  sess.handle = {
    kind: "pipe",
    write: (d) => {
      if (!cp.stdin || cp.stdin.destroyed || cp.stdin.writableEnded) {
        throw new Error(`stdin of session "${sess.id}" is closed`);
      }
      // Pipe line-discipline emulation: a real TTY turns Ctrl-D (VEOF, 0x04)
      // into end-of-input; a raw pipe would just forward the byte and the
      // program would hang waiting for more input. Emulate: write everything
      // before the first 0x04, then end stdin.
      const eof = d.indexOf("\u0004");
      if (eof >= 0) {
        const before = d.slice(0, eof);
        if (before) cp.stdin.write(before);
        cp.stdin.end();
        appendOutput(sess, `\n[interactive_terminal] stdin closed (EOF)\n`);
        return;
      }
      cp.stdin.write(d);
    },
    resize: () => {
      /* pipe backend has no TTY to resize — no-op */
    },
    kill: (s) => {
      cp.kill((s as NodeJS.Signals) ?? "SIGTERM");
    },
  };
}

function onExit(sess: TerminalSession, code: number, signal: string | null): void {
  if (!sess.alive) return;
  sess.alive = false;
  sess.exitCode = code;
  sess.exitSignal = signal;
  if (sess.idleTimer) {
    clearTimeout(sess.idleTimer);
    sess.idleTimer = null;
  }
  appendOutput(
    sess,
    `\n[interactive_terminal] process exited (code=${code}${signal ? `, signal=${signal}` : ""})\n`,
  );
  log.debug("session exited", { id: sess.id, code, signal });
}

// ── Public registry API ─────────────────────────────────────────────────────

function allocateId(requested?: string): string {
  if (requested) {
    const clean = requested.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
    if (clean && !sessions.has(clean)) return clean;
    if (clean) return `${clean}_${++counter}`;
  }
  return `term_${++counter}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function openSession(owner: string, opts: OpenOptions): Promise<TerminalSession> {
  const owned = [...sessions.values()].filter((s) => s.owner === owner);
  if (owned.length >= MAX_SESSIONS_PER_OWNER) {
    throw new Error(
      `Session limit reached (${MAX_SESSIONS_PER_OWNER} live terminals). ` +
        `Close one first: ${owned.map((s) => s.id).join(", ")}`,
    );
  }
  const id = allocateId(opts.requestedId);
  const { command } = resolveSpawn(opts);
  const sess: TerminalSession = {
    id,
    owner,
    backend: "pipe",
    command,
    cols: Math.max(2, opts.cols ?? 80),
    rows: Math.max(1, opts.rows ?? 24),
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    lastDataAt: 0,
    alive: true,
    exitCode: null,
    exitSignal: null,
    spawnError: null,
    chunks: [],
    readCursor: 0,
    retained: 0,
    produced: 0,
    screen: null,
    lastScreenSnapshot: null,
    handle: { kind: "pipe", write: () => {}, resize: () => {}, kill: () => {} },
    idleTimer: null,
    idleTimeoutMs: opts.idleTimeoutMs ?? DEFAULT_IDLE_MS,
  };
  await makeBackend(sess, opts);

  // Catch immediate spawn failures (ENOENT etc.) before registering.
  const errDeadline = Date.now() + OPEN_SPAWN_ERROR_MS;
  while (sess.alive && sess.produced === 0 && Date.now() < errDeadline) await sleep(POLL_MS);
  if (!sess.alive && sess.spawnError) {
    throw new Error(`Failed to start "${command}": ${sess.spawnError}`);
  }

  sessions.set(id, sess);
  armIdleTimer(sess);

  // Give the program a moment to print its first prompt/banner so open()
  // can return meaningful initial output.
  const firstDeadline = Date.now() + OPEN_FIRST_OUTPUT_MS;
  while (sess.alive && sess.produced === 0 && Date.now() < firstDeadline) await sleep(POLL_MS);
  return sess;
}

/** Resolve a session for an owner. Throws if missing or owned by another session. */
export function getOwned(owner: string, id: string): TerminalSession {
  const sess = sessions.get(id);
  if (!sess) {
    const mine = [...sessions.values()].filter((s) => s.owner === owner).map((s) => s.id);
    const hint = mine.length ? ` Live sessions: ${mine.join(", ")}` : " No live sessions — use action \"open\" first.";
    throw new Error(`No terminal session with id "${id}".${hint}`);
  }
  if (sess.owner !== owner) throw new Error(`Terminal session "${id}" is not owned by this session`);
  return sess;
}

export function writeSession(sess: TerminalSession, data: string): void {
  if (!sess.alive) {
    throw new Error(
      `Terminal session "${sess.id}" has exited (code ${sess.exitCode}` +
        `${sess.exitSignal ? `, signal ${sess.exitSignal}` : ""}). Open a new session.`,
    );
  }
  sess.handle.write(data);
  touch(sess);
}

export function resizeSession(sess: TerminalSession, cols: number, rows: number): void {
  sess.cols = Math.max(2, cols);
  sess.rows = Math.max(1, rows);
  try {
    sess.handle.resize(sess.cols, sess.rows);
  } catch (err) {
    throw new Error(`Failed to resize session "${sess.id}": ${(err as Error).message}`);
  }
  sess.screen?.resize(sess.cols, sess.rows);
  touch(sess);
}

/**
 * Close a session gracefully: send the signal (default SIGTERM), wait a grace
 * period, then escalate to SIGKILL if the process is still alive.
 */
export async function closeSession(
  owner: string,
  id: string,
  signal?: string,
): Promise<TerminalSession> {
  const sess = getOwned(owner, id);
  if (sess.idleTimer) {
    clearTimeout(sess.idleTimer);
    sess.idleTimer = null;
  }
  if (sess.alive) {
    try {
      sess.handle.kill(signal);
    } catch {
      /* ignore */
    }
    const deadline = Date.now() + CLOSE_GRACE_MS;
    while (sess.alive && Date.now() < deadline) await sleep(POLL_MS);
    if (sess.alive) {
      try {
        sess.handle.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      const hardDeadline = Date.now() + CLOSE_GRACE_MS;
      while (sess.alive && Date.now() < hardDeadline) await sleep(POLL_MS);
    }
  }
  sessions.delete(id);
  return sess;
}

export function listSessions(owner: string): TerminalSession[] {
  return [...sessions.values()].filter((s) => s.owner === owner);
}

function tailTruncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_READ_CHARS) return { text, truncated: false };
  return { text: text.slice(text.length - MAX_READ_CHARS), truncated: true };
}

/**
 * Read output from a session.
 *
 * Views (see ReadOptions.mode): raw output stream, or (pty) the rendered
 * screen snapshot. "auto" picks the screen view for full-screen TUIs.
 *
 * Wait behaviour:
 *  - `until` (regex): block until the pattern appears (stream: in new output,
 *    ANSI-stripped; screen: in the snapshot), the process exits, the read
 *    aborts, or the wait budget expires.
 *  - `waitMs` (quiet period): block until no new output for waitMs (i.e. the
 *    output has settled), exit, abort, or budget expiry. If the session is
 *    already quiet, this returns after ~waitMs.
 *  - neither: settle briefly, then return.
 *
 * The stream read-cursor is always consumed (unless `fromStart`), regardless
 * of view, so consecutive reads never replay old output.
 */
export async function readSession(sess: TerminalSession, opts: ReadOptions): Promise<ReadResult> {
  const fromStart = opts.fromStart ?? false;
  const settleMs = opts.waitMs ?? 0;
  const requestedTimeout = opts.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  // The budget must always exceed the quiet window or it can never be satisfied.
  const timeout = Math.min(Math.max(requestedTimeout, settleMs + 1_000), MAX_READ_TIMEOUT_MS);

  let untilRe: RegExp | null = null;
  if (opts.until) {
    try {
      untilRe = new RegExp(opts.until);
    } catch (err) {
      throw new Error(`Invalid \`until\` regex: ${(err as Error).message}`);
    }
  }

  const mode: "stream" | "screen" = (() => {
    const want = opts.mode ?? "auto";
    if (want === "screen") {
      if (!sess.screen) {
        throw new Error(
          `Session "${sess.id}" runs on the pipe backend — there is no rendered screen. ` +
            "Use mode \"stream\" (or open with a pty backend).",
        );
      }
      return "screen";
    }
    if (want === "stream") return "stream";
    return isTuiSession(sess) ? "screen" : "stream";
  })();

  const matchText = (): string =>
    mode === "screen" ? sess.screen!.snapshot() : stripAnsi(peek(sess, fromStart));

  const readStart = Date.now();
  const deadline = readStart + timeout;
  let matched: boolean | null = untilRe ? false : null;
  let timedOut = false;
  let aborted = false;

  if (untilRe || settleMs > 0) {
    for (;;) {
      if (opts.abort?.aborted) {
        aborted = true;
        break;
      }
      if (untilRe) {
        if (untilRe.test(matchText())) {
          matched = true;
          break;
        }
      } else {
        // Quiet-period wait: silence measured from the later of the last data
        // arrival and the start of this read.
        const last = Math.max(sess.lastDataAt, readStart);
        if (Date.now() - last >= settleMs) break;
      }
      if (!sess.alive) break;
      if (Date.now() >= deadline) {
        timedOut = true;
        break;
      }
      await sleep(POLL_MS);
    }
  } else {
    // Plain read: give output a brief moment to arrive, then return.
    await sleep(DEFAULT_SETTLE_MS);
  }

  let text: string;
  let screenChanged: boolean | null = null;
  if (mode === "screen") {
    text = sess.screen!.snapshot();
    screenChanged = text !== sess.lastScreenSnapshot;
    sess.lastScreenSnapshot = text;
    // Screen reads still consume the stream cursor so a later stream read
    // does not replay the whole repaint history.
    if (!fromStart) consume(sess);
  } else {
    const raw = peek(sess, fromStart);
    if (!fromStart) consume(sess);
    text = opts.stripAnsi ? stripAnsi(raw) : raw;
  }
  touch(sess);
  const { text: bounded, truncated } = tailTruncate(text);
  return { text: bounded, mode, matched, timedOut, aborted, truncated, screenChanged };
}

/** Test-only: reset all sessions. */
export function __resetForTests(): void {
  for (const s of sessions.values()) {
    try {
      s.handle.kill();
    } catch {
      /* ignore */
    }
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.alive = false;
  }
  sessions.clear();
  counter = 0;
}
