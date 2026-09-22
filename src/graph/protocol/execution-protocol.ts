/**
 * Graph Execution Engine v2 — Execution Protocol Registry
 *
 * Version: 1.0
 * Date: 2026-09-22
 *
 * The execution-protocol axis of the persistence contract: which SEMANTIC
 * decision rules a persisted graph runs under. This module owns that identity,
 * so the loader selects a registered protocol HANDLER for an exact version
 * instead of comparing a persisted number with a latest-version constant
 * (docs/graph-outcome-protocol.md § "Version ownership and load contract").
 *
 * Scope of this delivery (B stage, third slice):
 * - `LEGACY_SIGNAL_PROTOCOL` / `OUTCOME_PROTOCOL` — the two protocol
 *   identities. Only the legacy protocol has a handler: `OUTCOME_PROTOCOL` is
 *   a RESERVED identity, and naming it anywhere does not make outcome
 *   semantics runnable — no compiled outcome plan, submission ingress,
 *   reducer or receipt store exists yet.
 * - `ExecutionProtocolHandler` — the protocol's own capability surface. For the
 *   legacy protocol this is a MARKER identity, not a dispatch seam: the legacy
 *   engine keeps deciding completions from severity-ranked signals exactly as
 *   it does today, so the handler deliberately exposes no completion rule. The
 *   dispatch completion bridge switch-over is deferred until the outcome
 *   protocol has a real handler — with one authoritative completion source,
 *   and protocol selection already enforced at the load boundary.
 * - `createExecutionProtocolRegistry` — the only constructor for a registry
 *   that is consistent by construction: a version is a positive safe integer
 *   and has exactly one owner, the same legality rule the storage-format
 *   registry enforces. A registry built here is deeply frozen, so widening
 *   support is an explicit new registry rather than a later in-place mutation.
 * - `classifyExecutionProtocol` — a PURE verdict over one raw `version` value
 *   that carries the matched handler, and the single owner of which protocol
 *   identifiers are legal at all. Registry MEMBERSHIP decides support: the
 *   bare number 2 being named above grants it nothing.
 *
 * Dependency leaf: this module imports nothing (not even a type), so any
 * persistence, loader, dispatch or engine module may depend on it without
 * creating a cycle — the same rationale as `storage-format.ts` and
 * `log-warn.ts`.
 */

// ── Protocol identities ─────────────────────────────────────────────────────

/**
 * The legacy signal protocol: completions are interpreted by the existing
 * signal bridge and severity-ranked completion evaluator, and node lifecycle
 * is the pre-outcome engine. Every v2 snapshot written so far runs under this
 * identity, so it is the one protocol the format-2 decoder may backfill when a
 * file predates the field.
 */
export const LEGACY_SIGNAL_PROTOCOL = 1 as const;

/**
 * The outcome protocol of docs/graph-outcome-protocol.md — RESERVED, with NO
 * registered handler in this build.
 *
 * The constant exists so the identity is named in one place, not so it can
 * run: with the shipped registry
 * ({@link LEGACY_EXECUTION_PROTOCOL_REGISTRY}) a persisted 2 classifies as
 * `unsupported` and the load is refused. Registering a marker handler under
 * this version (as a registry test does) still implements no outcome
 * semantics — there is no compiled plan, submission ingress, reducer or
 * receipt store behind it.
 */
export const OUTCOME_PROTOCOL = 2 as const;

// ── Capabilities ────────────────────────────────────────────────────────────

/**
 * A registered handler for exactly one execution protocol.
 *
 * `version` is the exact protocol identifier this handler owns. The
 * capability surface is deliberately MINIMAL and honest: the legacy handler is
 * a marker identity, not a dispatch seam, and adding a method here is a
 * promise that a real decision rule reads it. A future outcome handler grows
 * this interface with the capabilities it actually implements; it does not
 * inherit a fake one.
 */
export interface ExecutionProtocolHandler {
  /** The exact execution protocol this handler owns. */
  readonly version: number;
}

/**
 * Installable execution-protocol support: the exact protocol HANDLERS this
 * build has.
 *
 * Capability — never a numeric comparison or a bare membership check — decides
 * support, so a build that can run protocol 1 cannot accept protocol 2 merely
 * because 2 is a legal, named number. Build one with
 * {@link createExecutionProtocolRegistry}, which enforces the consistency
 * rules the loader relies on.
 */
export interface ExecutionProtocolRegistry {
  /** The installed handlers, one per exact protocol version. */
  readonly handlers: readonly ExecutionProtocolHandler[];
}

/** Input accepted by {@link createExecutionProtocolRegistry}. */
export interface ExecutionProtocolRegistryInput {
  /** The handlers to install; at most one per version. */
  readonly handlers: readonly ExecutionProtocolHandler[];
}

/**
 * Build a deeply frozen execution-protocol registry from explicit handler
 * capabilities.
 *
 * Legality is checked HERE rather than left to the loader, because each
 * violation is a programmer error with exactly one sensible owner:
 * - a version that is not a positive safe integer — missing, `null`, a
 *   string, a non-integer, zero, negative, `NaN` / `Infinity`, or an integer
 *   outside the safe range — is not a protocol identifier at all, so it can
 *   never be registered (the SAME legality rule as storage formats);
 * - a duplicate version — one exact protocol has exactly one handler,
 *   otherwise which decision rules a graph ran under would depend on array
 *   order.
 *
 * Deeply frozen: the outer object, the handlers array (a fresh copy, so the
 * caller's array cannot be mutated afterwards), and every handler object are
 * frozen. An in-place edit of a frozen registry throws in strict mode, so the
 * accepted set a loader sees cannot silently move after construction.
 *
 * Throws a descriptive `Error` on the first violation.
 */
export function createExecutionProtocolRegistry(
  input: ExecutionProtocolRegistryInput,
): ExecutionProtocolRegistry {
  const versions = new Set<number>();
  for (const handler of input.handlers) {
    const version = handler.version;
    if (
      typeof version !== "number" ||
      !Number.isSafeInteger(version) ||
      version <= 0
    ) {
      throw new Error(
        `execution-protocol: handler version ${String(version)} is not a positive safe integer — a protocol identifier must be one`,
      );
    }
    if (versions.has(version)) {
      throw new Error(
        `execution-protocol: duplicate handler for version ${version} — one exact protocol has exactly one handler`,
      );
    }
    versions.add(version);
  }

  // Freeze the handler objects the caller handed us (identity is preserved: a
  // verdict carries the SAME handler object it matched) and copy the array
  // before freezing, so the registry owns its own membership.
  for (const handler of input.handlers) Object.freeze(handler);
  return Object.freeze({
    handlers: Object.freeze([...input.handlers]),
  });
}

/**
 * The registry this build ships: exactly one handler, for
 * {@link LEGACY_SIGNAL_PROTOCOL}.
 *
 * Assembled here rather than next to a decoder because it needs no
 * format-specific hydration — the legacy handler is a marker identity.
 * {@link OUTCOME_PROTOCOL} is deliberately absent: it is a reserved identity,
 * and an unregistered protocol is refused at load, never run under legacy
 * rules.
 */
export const LEGACY_EXECUTION_PROTOCOL_REGISTRY: ExecutionProtocolRegistry =
  createExecutionProtocolRegistry({
    handlers: [{ version: LEGACY_SIGNAL_PROTOCOL }],
  });

// ── Classification ──────────────────────────────────────────────────────────

/**
 * Verdict for one raw protocol `version` value.
 *
 * - `bound` — an exact registered handler owns this protocol. The verdict
 *   CARRIES the handler, so the caller dispatches on a capability instead of
 *   re-deriving support from a number.
 * - `unsupported` — a LEGAL protocol identifier with no installed handler (for
 *   example the reserved {@link OUTCOME_PROTOCOL}, or protocol 1 under an
 *   empty registry). `version` carries the number for diagnostics.
 * - `invalid` — not a protocol identifier at all: missing, `null`, a string,
 *   a non-integer or non-positive number, `NaN` / `Infinity`, or an integer
 *   outside the safe range. `value` carries the RAW value because it may hold
 *   any type; the caller reports it as a malformed discriminator (corrupt
 *   execution semantics), never as an unknown-but-well-formed protocol.
 */
export type ExecutionProtocolVerdict =
  | { kind: "bound"; version: number; handler: ExecutionProtocolHandler }
  | { kind: "unsupported"; version: number }
  | { kind: "invalid"; value: unknown };

/**
 * Classify one persisted execution-protocol value against a registry of exact
 * handler capabilities.
 *
 * Rules (the first matching rule wins):
 * 1. a value that is not a positive safe integer — missing, `null`, a string,
 *    a non-integer, zero, negative, `NaN` / `Infinity`, or an integer outside
 *    the safe range — → `invalid`, carrying the raw value: an illegal
 *    discriminator names no protocol at all, so the caller reports corrupt
 *    execution semantics instead of downgrading it to an unknown protocol;
 * 2. the version of a registered handler → `bound`, carrying that handler;
 * 3. anything else → `unsupported`.
 *
 * PURE by contract: no I/O, no logging, never throws for a registry object
 * that satisfies {@link ExecutionProtocolRegistry} (in particular one built by
 * {@link createExecutionProtocolRegistry}). The loader additionally contains a
 * throwing handler probe, so a hostile registry surfaces as a non-executable
 * load result rather than as a crash — that containment belongs to the
 * boundary that owns totality, the same way a throwing migration
 * `validateSource` is contained in `engine-persistence.ts`.
 */
export function classifyExecutionProtocol(
  version: unknown,
  registry: ExecutionProtocolRegistry,
): ExecutionProtocolVerdict {
  // The identifier rule lives HERE, in one place: a protocol version must be a
  // positive safe integer. 1.5, 0, -1, 2**53, '1', null, NaN and Infinity are
  // all malformed discriminators — not "protocols this build does not support".
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version <= 0
  ) {
    return { kind: "invalid", value: version };
  }
  const handler = registry.handlers.find((h) => h.version === version);
  if (handler) {
    return { kind: "bound", version, handler };
  }
  return { kind: "unsupported", version };
}
