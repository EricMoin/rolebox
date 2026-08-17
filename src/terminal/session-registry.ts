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
 * This module MUST NOT import any platform SDK.
 */

import { spawn as cpSpawn } from "node:child_process";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("interactive-terminal");

// ── Tunables ─────────────────────────────────────────────────────────────────

/** Cap on retained output per session (chars). Oldest output is dropped. */
const MAX_BUFFER_CHARS = 500_000;
/** Default idle timeout before a session is auto-killed (ms). */
const DEFAULT_IDLE_MS = 10 * 60_000;
/** Default overall wait budget for a read that blocks (ms). */
const DEFAULT_READ_TIMEOUT_MS = 10_000;
/** Default settle window when a plain read is issued with no wait spec (ms). */
const DEFAULT_SETTLE_MS = 150;
/** Poll interval for blocking reads (ms). */
const POLL_MS = 50;

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
  /**
   * Backend preference. Default "auto" (prefer node-pty, fall back to pipes).
   * Env `ROLEBOX_TERMINAL_BACKEND` overrides the default when this is unset.
   * NOTE: node-pty is unreliable under the Bun runtime (input written after a
   * short delay can be dropped) — force "pipe" there for line-oriented programs.
   */
  backend?: TerminalBackendPref;
}

export interface ReadOptions {
  waitMs?: number;
  until?: string;
  timeoutMs?: number;
  fromStart?: boolean;
  stripAnsi?: boolean;
  abort?: AbortSignal;
}

export interface TerminalSession {
  id: string;
  owner: string;
  backend: TerminalBackendKind;
  command: string;
  createdAt: number;
  lastActivityAt: number;
  lastDataAt: number;
  alive: boolean;
  exitCode: number | null;
  exitSignal: string | null;
  /** Retained output chunks (rolling, capped). */
  chunks: string[];
  /** Read cursor: index into the logical concatenation of `chunks`. */
  readCursor: number;
  /** Total chars currently retained across `chunks`. */
  retained: number;
  /** Total chars ever produced (for cursor math after trimming). */
  produced: number;
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

async function makeBackend(
  sess: TerminalSession,
  opts: OpenOptions,
): Promise<void> {
  const { file, args } = resolveSpawn(opts);
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;
  const env = { ...process.env, TERM: process.env.TERM ?? "xterm-256color", ...(opts.env ?? {}) };
  const cwd = opts.cwd || process.cwd();

  const pref: TerminalBackendPref =
    opts.backend ??
    ((process.env.ROLEBOX_TERMINAL_BACKEND as TerminalBackendPref | undefined) || "auto");

  const pty = pref === "pipe" ? null : await loadPty();
  if (pty && typeof (pty as { spawn?: unknown }).spawn === "function") {
    const spawnFn = (pty as { spawn: (...a: unknown[]) => unknown }).spawn;
    const proc = spawnFn(file, args, { name: "xterm-256color", cols, rows, cwd, env }) as {
      write(d: string): void;
      resize(c: number, r: number): void;
      kill(s?: string): void;
      onData(cb: (d: string) => void): void;
      onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
    };
    sess.backend = "pty";
    proc.onData((d) => appendOutput(sess, d));
    proc.onExit((e) => onExit(sess, e.exitCode ?? 0, e.signal != null ? String(e.signal) : null));
    sess.handle = {
      kind: "pty",
      write: (d) => proc.write(d),
      resize: (c, r) => proc.resize(c, r),
      kill: (s) => proc.kill(s),
    };
    return;
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
    appendOutput(sess, `\n[interactive_terminal] spawn error: ${(err as Error).message}\n`);
    onExit(sess, -1, null);
  });
  sess.handle = {
    kind: "pipe",
    write: (d) => {
      cp.stdin?.write(d);
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
  sess.alive = false;
  sess.exitCode = code;
  sess.exitSignal = signal;
  if (sess.idleTimer) {
    clearTimeout(sess.idleTimer);
    sess.idleTimer = null;
  }
  log.debug("session exited", { id: sess.id, code, signal });
}

// ── Public registry API ─────────────────────────────────────────────────────

export async function openSession(owner: string, opts: OpenOptions): Promise<TerminalSession> {
  const id = `term_${++counter}_${Math.random().toString(36).slice(2, 8)}`;
  const { command } = resolveSpawn(opts);
  const sess: TerminalSession = {
    id,
    owner,
    backend: "pipe",
    command,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    lastDataAt: 0,
    alive: true,
    exitCode: null,
    exitSignal: null,
    chunks: [],
    readCursor: 0,
    retained: 0,
    produced: 0,
    handle: { kind: "pipe", write: () => {}, resize: () => {}, kill: () => {} },
    idleTimer: null,
    idleTimeoutMs: opts.idleTimeoutMs ?? DEFAULT_IDLE_MS,
  };
  await makeBackend(sess, opts);
  sessions.set(id, sess);
  armIdleTimer(sess);
  return sess;
}

/** Resolve a session for an owner. Throws if missing or owned by another session. */
export function getOwned(owner: string, id: string): TerminalSession {
  const sess = sessions.get(id);
  if (!sess) throw new Error(`No terminal session with id "${id}"`);
  if (sess.owner !== owner) throw new Error(`Terminal session "${id}" is not owned by this session`);
  return sess;
}

export function writeSession(sess: TerminalSession, data: string): void {
  if (!sess.alive) throw new Error(`Terminal session "${sess.id}" has exited (code ${sess.exitCode})`);
  sess.handle.write(data);
  touch(sess);
}

export function resizeSession(sess: TerminalSession, cols: number, rows: number): void {
  sess.handle.resize(cols, rows);
  touch(sess);
}

export function closeSession(owner: string, id: string, signal?: string): TerminalSession {
  const sess = getOwned(owner, id);
  try {
    sess.handle.kill(signal);
  } catch {
    /* ignore */
  }
  if (sess.idleTimer) {
    clearTimeout(sess.idleTimer);
    sess.idleTimer = null;
  }
  sessions.delete(id);
  return sess;
}

export function listSessions(owner: string): TerminalSession[] {
  return [...sessions.values()].filter((s) => s.owner === owner);
}

/**
 * Read output from a session.
 *  - `until` (regex): block until the pattern appears in new output, exit, or timeout.
 *  - `waitMs` (quiet period): block until no new data for waitMs, exit, or timeout.
 *  - neither: settle briefly, then return new output.
 * Returns the text and consumes the read cursor (unless `fromStart`).
 */
export async function readSession(sess: TerminalSession, opts: ReadOptions): Promise<string> {
  const fromStart = opts.fromStart ?? false;
  const timeout = opts.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  const deadline = Date.now() + timeout;
  const untilRe = opts.until ? new RegExp(opts.until) : null;
  const settleMs = opts.waitMs ?? 0;

  const matches = (): boolean => {
    if (opts.abort?.aborted) return true;
    if (!sess.alive) return true;
    if (Date.now() >= deadline) return true;
    const pending = peek(sess, fromStart);
    if (untilRe) {
      const hay = opts.stripAnsi ? stripAnsi(pending) : pending;
      return untilRe.test(hay);
    }
    if (settleMs > 0) {
      return pending.length > 0 && sess.lastDataAt > 0 && Date.now() - sess.lastDataAt >= settleMs;
    }
    return false;
  };

  if (untilRe || settleMs > 0) {
    while (!matches()) await sleep(POLL_MS);
  } else {
    // Plain read: give output a brief moment to arrive, then return.
    await sleep(DEFAULT_SETTLE_MS);
  }

  const out = peek(sess, fromStart);
  if (!fromStart) consume(sess);
  touch(sess);
  return opts.stripAnsi ? stripAnsi(out) : out;
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
  }
  sessions.clear();
  counter = 0;
}
