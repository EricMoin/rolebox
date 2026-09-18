/**
 * Graph Execution Engine v2 — Thenable Predicate
 *
 * Version: 2.0
 * Date: 2026-09-18
 *
 * A seam that accepts "a listener whose result may or may not be awaited"
 * declares `void | Promise<unknown>`; the consumer has to decide at runtime
 * whether the returned value can be awaited. This predicate is that decision,
 * in one place — replacing the `as unknown` + `as PromiseLike<unknown>` probes
 * the callbacks used to need.
 *
 * Dependency-free on purpose: the modules that use it are the ones that would
 * otherwise form an import cycle.
 */

/**
 * Whether `v` can be awaited — a non-null object or function whose `then` is a
 * function.
 *
 * Only `then` matters, which is the same check `Promise.resolve` makes, so a
 * value accepted here is safe to hand to it. Primitives answer `false` without
 * a property lookup (the `in` test would throw on them).
 */
export function isThenable(v: unknown): v is PromiseLike<unknown> {
  if (v === null || (typeof v !== "object" && typeof v !== "function")) {
    return false;
  }
  if (!("then" in v)) return false;
  return typeof v.then === "function";
}
