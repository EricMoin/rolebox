// ── Ambient log scope (AsyncLocalStorage) ───────────────────────────────────
//
// IDENTITY TRAVELS WITH THE WORK, NOT WITH EVERY CALL. A graph advance, a
// dispatch and a tool call all belong to a session / graph / run / node /
// attempt, and without ambient scope every diagnostic has to repeat those ids by
// hand — which is how a call site ends up naming the wrong attempt. withLogScope
// makes the identity ambient for the duration of a callback; the record builder
// reads it once per record (src/log/runtime.ts), so a record's `scope` is filled
// in by whoever owns the work rather than by whoever wrote the log line.
//
// WHAT PROPAGATES, AND WHAT DOES NOT — read this before relying on the scope.
//
//   AsyncLocalStorage propagates through asynchronous continuations that are
//   CREATED INSIDE the callback: an `await`, a promise chain built there, a
//   timer or microtask scheduled there all still see the scope.
//
//   A callback created OUTSIDE the scope does NOT see it, no matter what is
//   running when it finally executes. A boot-time watchdog `setInterval`, a
//   process-level event listener whose emit happens elsewhere, and a
//   fire-and-forget task started in another context are all in this class:
//   when they run, `currentLogScope()` answers `{}`. Those entry points are
//   exactly the places that must re-enter explicitly, or their diagnostics lose
//   the identity the rest of the run carries.
//
//   // CORRECT — the detached entry point re-enters for the work it starts.
//   const watchdog = setInterval(() => {
//     const pending = collectPendingAttempts();
//     if (pending.length === 0) return;
//     for (const attempt of pending) {
//       withLogScope(
//         { graphId: attempt.graphId, attemptId: attempt.attemptId },
//         () => settle(attempt), // this call and everything it awaits see the scope
//       );
//     }
//   }, 5_000);
//
//   // WRONG — the interval was created at boot, outside any scope, so this
//   // line reports an empty scope even while a graph is running.
//   setInterval(() => log.info("watchdog tick"), 5_000);
//
//   // CORRECT — work created inside a scope keeps it across awaits.
//   await withLogScope({ graphId: "g1" }, async () => {
//     await advance();                     // sees graphId: "g1"
//     setTimeout(() => settle(), 0);       // created here, so it sees it too
//   });
//
// Scopes NEST by merging: a child inherits everything the parent carried and
// overrides only the keys it names with a defined value. `{ attemptId }` inside
// `{ graphId }` therefore produces `{ graphId, attemptId }`, which is why the
// engine can enter the scope once per graph and refine it per attempt.
//
// Both halves of the propagation rule are pinned by tests/log/context.test.ts
// with real promises and timers.

import { AsyncLocalStorage } from "node:async_hooks";

import type { LogScope } from "./types.ts";

/** The store the ambient scope lives in. Never handed out directly. */
const storage = new AsyncLocalStorage<LogScope>();

/** Copy `scope` without its empty and undefined entries. */
function definedScope(scope: LogScope): LogScope {
  const defined: Record<string, string> = {};
  for (const key of Object.keys(scope)) {
    const value = (scope as Record<string, string | undefined>)[key];
    if (typeof value === "string" && value.length > 0) defined[key] = value;
  }
  return defined;
}

/**
 * The scope the current execution belongs to, or `{}` when none is active.
 *
 * The answer is a fresh copy: mutating it cannot change what later records
 * carry, and the ambient value itself is unreachable. Returns `{}` (never
 * `undefined`) so a caller can read `currentLogScope().graphId` directly.
 */
export function currentLogScope(): LogScope {
  try {
    const scope = storage.getStore();
    return scope === undefined ? {} : { ...scope };
  } catch {
    return {};
  }
}

/**
 * Run `fn` with `scope` active, and return what `fn` returns.
 *
 * The scope is the merge of the ambient scope and `scope` (the argument wins on
 * a key both name), so nested calls refine the identity instead of replacing
 * it. A key whose value is `undefined` or an empty string is treated as absent:
 * it inherits, and it cannot clear an inherited key.
 *
 * The scope is active for the synchronous extent of `fn` plus every
 * asynchronous continuation created inside it — see the module header for the
 * detached callbacks that are NOT covered and must re-enter with this function.
 * An error thrown by `fn` propagates unchanged; this wrapper adds no error
 * handling of its own.
 */
export function withLogScope<T>(scope: LogScope, fn: () => T): T {
  const merged = Object.freeze({ ...definedScope(storage.getStore() ?? {}), ...definedScope(scope) });
  return storage.run(merged, fn);
}
