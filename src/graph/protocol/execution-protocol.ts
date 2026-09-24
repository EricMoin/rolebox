// ── Protocol identities ─────────────────────────────────────────────────────

/**
 * The outcome protocol of docs/graph-outcome-protocol.md — the only execution
 * protocol this build registers.
 *
 * The run path (`src/graph/outcome/runtime.ts`) dispatches the compiled plan's
 * entry nodes, accepts submissions through the graph-scoped outcome ingress and
 * commits the graph state with the acceptance. Version 1 (the deleted legacy
 * signal protocol) has no handler here, so a record pinned to it is
 * `unsupported(execution)` — intact, refused, never run.
 */
export const OUTCOME_PROTOCOL = 2 as const;

// ── Capabilities ────────────────────────────────────────────────────────────

/**
 * A registered handler for exactly one execution protocol.
 *
 * `version` is the exact protocol identifier this handler owns. The
 * capability surface is deliberately MINIMAL and honest: adding a method here
 * is a promise that a real decision rule reads it.
 */
export interface ExecutionProtocolHandler {
  /** The exact execution protocol this handler owns. */
  readonly version: number;
}

/**
 * The registered handler for the OUTCOME protocol — a real capability surface,
 * not a marker.
 *
 * What it OWNS, stated so the runtime can read it rather than assume it:
 * - `completion` — the accepted-outcome submission is the ONLY completion
 *   source for a graph bound to this handler. No severity-ranked signal, no
 *   free-form payload field and no synthesized second answer settles a node.
 * - `submissionIngress` — submissions arrive at the GRAPH-SCOPED outcome
 *   ingress, whose execution identity is derived by the runtime and whose
 *   proposal carries none.
 * - `legacyCompletion: "unreachable"` — the legacy signal completion path can
 *   never decide such a graph's nodes; making it reachable is a different
 *   protocol handler, not a configuration of this one.
 *
 * The outcome run path checks exactly these fields before dispatching anything
 * ({@link isOutcomeProtocolHandler}), so the declaration is enforced where it is
 * used.
 */
export interface OutcomeProtocolHandler extends ExecutionProtocolHandler {
  /** The exact execution protocol this handler owns. */
  readonly version: typeof OUTCOME_PROTOCOL;
  /** The one authoritative completion source of this protocol. */
  readonly completion: "accepted-outcome-submission";
  /** The ingress an accepted-outcome submission arrives through. */
  readonly submissionIngress: "graph-scoped-outcome-submission";
  /** Whether a legacy signal completion may settle a node of this protocol. */
  readonly legacyCompletion: "unreachable";
}

/**
 * Whether a registered handler declares the OUTCOME protocol's semantics.
 *
 * A type guard, because the runtime must dispatch on the CAPABILITY and never on
 * the bare version number: a handler registered under 2 that does not declare
 * the accepted-outcome submission as its completion source is refused, not
 * trusted.
 */
export function isOutcomeProtocolHandler(
  handler: ExecutionProtocolHandler,
): handler is OutcomeProtocolHandler {
  return (
    handler.version === OUTCOME_PROTOCOL &&
    "completion" in handler &&
    handler.completion === "accepted-outcome-submission" &&
    "submissionIngress" in handler &&
    handler.submissionIngress === "graph-scoped-outcome-submission" &&
    "legacyCompletion" in handler &&
    handler.legacyCompletion === "unreachable"
  );
}

/** The outcome-protocol handler this build registers. */
export const OUTCOME_PROTOCOL_HANDLER: OutcomeProtocolHandler = Object.freeze({
  version: OUTCOME_PROTOCOL,
  completion: "accepted-outcome-submission",
  submissionIngress: "graph-scoped-outcome-submission",
  legacyCompletion: "unreachable",
});

/**
 * Installable execution-protocol support: the exact protocol HANDLERS this
 * build has.
 *
 * Capability — never a numeric comparison or a bare membership check — decides
 * support, so naming a protocol number somewhere cannot make it runnable. Build
 * one with {@link createExecutionProtocolRegistry}, which enforces the
 * consistency rules the loader relies on.
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
 * The registry this build SHIPS and its loader defaults to: the outcome handler
 * alone.
 *
 * Membership is capability: protocol 2 is supported only because
 * {@link OUTCOME_PROTOCOL_HANDLER} declares the outcome protocol's completion
 * source, ingress and unreachable legacy path. Version 1 is a legal identifier
 * with no handler — refused as unsupported, never mapped onto a successor.
 */
export const DEFAULT_EXECUTION_PROTOCOL_REGISTRY: ExecutionProtocolRegistry =
  createExecutionProtocolRegistry({
    handlers: [OUTCOME_PROTOCOL_HANDLER],
  });

// ── Classification ──────────────────────────────────────────────────────────

/**
 * Verdict for one raw protocol `version` value.
 *
 * - `bound` — an exact registered handler owns this protocol. The verdict
 *   CARRIES the handler, so the caller dispatches on a capability instead of
 *   re-deriving support from a number.
 * - `unsupported` — a LEGAL protocol identifier with no installed handler (for
 *   example the deleted legacy signal protocol, or a reserved future one).
 *   `version` carries the number for diagnostics.
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
 * {@link createExecutionProtocolRegistry}).
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
