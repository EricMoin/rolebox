/**
 * Pi child-process mode tests (subtask S2).
 *
 * Verifies the child-process guard that stops a spawned Pi subagent from
 * re-running the parent-side prompt/function machinery on top of the
 * `--append-system-prompt` it already received:
 *
 *   1. `isPiChildProcess` (src/platform/adapters/pi/child-mode.ts) —
 *      true when `ROLEBOX_ACTIVE_AGENT` is a non-empty (trimmed) string,
 *      false when unset / empty / whitespace-only.
 *   2. `wirePiChatActivation` with `enabled: false` — the opt-out used by
 *      the child-process path: no `message_start` subscription is created
 *      and `handleChatMessage` is never invoked. The default (`enabled`
 *      omitted) still wires, preserving the parent-side behavior.
 *   3. `resolveChildDispatchStoreDir` (subtask S5) — a spawned child gets
 *      a per-pid temp dispatch store (`<tmpdir>/rolebox-dispatch/<pid>`)
 *      distinct from the host workspace, stable per pid, while the host
 *      (non-child) path stays `process.cwd()`.
 *
 * @module
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  isPiChildProcess,
  resolveChildDispatchStoreDir,
} from "../src/platform/adapters/pi/child-mode.ts";
import {
  wirePiChatActivation,
  resetPiChatActivationDedup,
} from "../src/platform/adapters/pi/chat-activation.ts";
import { HookState } from "../src/hooks/state.ts";
import type { HookDeps } from "../src/hooks/deps.ts";
import type { ResolvedFunction, ResolvedRole } from "../src/types.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

interface DepsFixture {
  runHooks: ReturnType<typeof mock>;
}

/** Minimal HookDeps with an observable customHooks.runHooks spy. */
function makeDeps(dir: string): HookDeps & { __fixture: DepsFixture } {
  const runHooks = mock(() => Promise.resolve());
  const deps = {
    session: { messages: mock(() => Promise.resolve([])) } as never,
    roleFunctionsMap: new Map<string, ResolvedFunction[]>(),
    roleGraphMap: new Map(),
    roleMap: new Map<string, ResolvedRole>(),
    dir,
    dispatchManager: {} as never,
    loopManager: {} as never,
    customHooks: { runHooks } as never,
  } as unknown as HookDeps & { __fixture: DepsFixture };
  (deps as { __fixture: DepsFixture }).__fixture = { runHooks };
  return deps;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-child-mode-"));
  resetPiChatActivationDedup();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── isPiChildProcess predicate ───────────────────────────────────────────────

describe("isPiChildProcess — predicate", () => {
  it("returns false when ROLEBOX_ACTIVE_AGENT is unset", () => {
    expect(isPiChildProcess({})).toBe(false);
    expect(isPiChildProcess({ SOME_OTHER_VAR: "x" })).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(isPiChildProcess({ ROLEBOX_ACTIVE_AGENT: "" })).toBe(false);
  });

  it("returns false for whitespace-only values", () => {
    expect(isPiChildProcess({ ROLEBOX_ACTIVE_AGENT: "   " })).toBe(false);
    expect(isPiChildProcess({ ROLEBOX_ACTIVE_AGENT: "\t\n " })).toBe(false);
  });

  it("returns true when set to an agent id", () => {
    expect(isPiChildProcess({ ROLEBOX_ACTIVE_AGENT: "emperor--jinyiwei" })).toBe(true);
  });

  it("treats a whitespace-padded value as set (trimmed)", () => {
    expect(isPiChildProcess({ ROLEBOX_ACTIVE_AGENT: "  agent-a  " })).toBe(true);
  });

  it("reads process.env by default (production call site)", () => {
    const prev = process.env.ROLEBOX_ACTIVE_AGENT;
    try {
      delete process.env.ROLEBOX_ACTIVE_AGENT;
      expect(isPiChildProcess()).toBe(false);

      process.env.ROLEBOX_ACTIVE_AGENT = "agent-a";
      expect(isPiChildProcess()).toBe(true);

      process.env.ROLEBOX_ACTIVE_AGENT = "   ";
      expect(isPiChildProcess()).toBe(false);
    } finally {
      if (prev === undefined) {
        delete process.env.ROLEBOX_ACTIVE_AGENT;
      } else {
        process.env.ROLEBOX_ACTIVE_AGENT = prev;
      }
    }
  });
});

// ── resolveChildDispatchStoreDir — child dispatch store isolation (S5) ─────

describe("resolveChildDispatchStoreDir — dispatch store isolation (S5)", () => {
  it("returns a per-pid temp dir for a child process, distinct from the workspace", () => {
    const dir = resolveChildDispatchStoreDir(4242, true);
    expect(dir).not.toBe(process.cwd());
    expect(dir).toBe(join(tmpdir(), "rolebox-dispatch", "4242"));
  });

  it("is stable for a given pid", () => {
    const a = resolveChildDispatchStoreDir(777, true);
    const b = resolveChildDispatchStoreDir(777, true);
    expect(a).toBe(b);
    expect(a).toBe(join(tmpdir(), "rolebox-dispatch", "777"));
  });

  it("isolates different pids into different store directories", () => {
    const a = resolveChildDispatchStoreDir(111, true);
    const b = resolveChildDispatchStoreDir(222, true);
    expect(a).not.toBe(b);
    expect(a).toContain("111");
    expect(b).toContain("222");
  });

  it("keeps the host path unchanged — process.cwd() — when not a child", () => {
    expect(resolveChildDispatchStoreDir(process.pid, false)).toBe(process.cwd());
  });
});

// ── wirePiChatActivation enabled opt-out ─────────────────────────────────────

describe("wirePiChatActivation — enabled opt-out", () => {
  it("does not subscribe message_start when enabled:false", () => {
    const handlers: Record<string, unknown> = {};
    const pi = {
      on: mock((name: string, handler: unknown) => {
        handlers[name] = handler;
      }),
    };

    const wiring = wirePiChatActivation({
      pi,
      state: new HookState(),
      deps: makeDeps(tmpDir),
      enabled: false,
    });

    expect(pi.on).not.toHaveBeenCalled();
    expect(handlers["message_start"]).toBeUndefined();
    wiring.unsubscribe(); // no-op — must not throw
  });

  it("does not invoke handleChatMessage when enabled:false", () => {
    const deps = makeDeps(tmpDir);

    wirePiChatActivation({
      pi: { on: mock(() => {}) },
      state: new HookState(),
      deps,
      enabled: false,
    });

    // The custom-hook spy is the only observable side effect of the
    // handleChatMessage pipeline — zero calls means the pipeline never ran.
    expect(deps.__fixture.runHooks.mock.calls.length).toBe(0);
  });

  it("still wires message_start by default (enabled omitted → true)", () => {
    const handlers: Record<string, unknown> = {};
    const pi = {
      on: mock((name: string, handler: unknown) => {
        handlers[name] = handler;
      }),
    };

    wirePiChatActivation({
      pi,
      state: new HookState(),
      deps: makeDeps(tmpDir),
    });

    expect(pi.on).toHaveBeenCalledWith("message_start", expect.any(Function));
    expect(typeof handlers["message_start"]).toBe("function");
  });
});
