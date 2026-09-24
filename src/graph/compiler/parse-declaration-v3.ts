/**
 * Graph Execution Engine v2 — Authoring Grammar v3 Front-End (C1)
 *
 * Version: 1.0
 * Date: 2026-09-22
 *
 * The STRICT ingress from authored data to {@link GraphDeclarationV3}: JSON text
 * or an already-parsed value in, a validated declaration or a list of STRUCTURED
 * issues out. It is the producer-side counterpart of the compiler's structural
 * guard `isGraphDeclarationV3`, and it owns the strictness the guard
 * deliberately does not:
 *
 * - the value must be a JSON object (or JSON text that parses to one);
 * - every key at every level must be a key the v3 grammar declares — an unknown
 *   key is REJECTED, so the grammar cannot drift silently while a typo'd field
 *   is ignored;
 * - every field must have the JSON type the grammar declares, and a value of
 *   the right type that the grammar does not admit (an empty identifier, a
 *   blank graph name, a non-positive or fractional loop cap, a non-finite
 *   number, an out-of-bound per-node budget, a completion policy that is not
 *   exactly one policy object) is REJECTED at its own path;
 * - every failure NAMES ITS PATH (`$.nodes[1].outcomes[0].id`) and carries a
 *   stable code, so a caller branches on the code and shows the path.
 *
 * TOTALITY is part of the contract: this function answers a result for every
 * input and never throws — JSON text that does not parse is `not-json`, and a
 * value that throws while being read (an accessor that raises, a Proxy with a
 * hostile trap) is contained as `unreadable` instead of escaping into the
 * caller.
 *
 * `isGraphDeclarationV3` is still used, as a final agreement check over the
 * value this module BUILT: the front-end's own walker is the authority on
 * strictness, and the shared guard confirms the result is the same
 * `GraphDeclarationV3` the compiler consumes. A disagreement is reported as an
 * `invalid-value` issue rather than a declaration handed onward.
 *
 * The declaration this module returns is a FRESH, deeply frozen value: it never
 * aliases the caller's containers, so a later mutation of the input cannot move
 * a declaration that has already been validated (the same discipline the
 * construction tools follow when they copy their arguments).
 *
 * This module adds no dependency beyond the grammar it validates and the
 * canonical digest used by its caller — it does not compile, persist or execute
 * anything (docs/graph-outcome-protocol.md § "Compiler and runtime boundary").
 */

import { errorText } from "../../utils/error-text.ts";
import {
  isGraphDeclarationV3,
  type AcceptanceRequirementV3,
  type CompletionPolicyRequestV3,
  type CompletionPolicyV3,
  type EdgeDeclarationV3,
  type GraphDeclarationV3,
  type InputDeclarationV3,
  type LoopGroupDeclarationV3,
  type NodeDeclarationV3,
  type OutcomeDataV3,
  type OutcomeDeclarationV3,
  type ProgressPolicyV3,
} from "./declaration-v3.ts";
import type { ContractRef } from "../contracts/contract-definition.ts";
import type { JoinConfig, NodeBudgetSpec } from "../../types.graph-v2.ts";

// ── Result shapes ───────────────────────────────────────────────────────────

/**
 * Stable issue codes. A caller branches on these strings; message wording is
 * not part of the contract.
 *
 * - `not-json` — the input was text and is not valid JSON;
 * - `not-an-object` — the input (or the JSON it parsed to) is not a JSON
 *   object, so there is no declaration to read;
 * - `unreadable` — reading the value threw (an accessor or Proxy trap), so no
 *   field-level verdict is possible;
 * - `unsupported-version` — `version` is present and is not the grammar's 3;
 * - `missing-field` — a field the grammar requires is absent;
 * - `wrong-type` — a field's JSON type is not the one the grammar declares;
 * - `unknown-key` — the grammar is CLOSED and the object carries a key it does
 *   not declare;
 * - `invalid-value` — the type is right and the value is not one the grammar
 *   admits (an empty identifier, a blank graph name, a non-positive /
 *   fractional limit, a non-finite number, a negative budget bound, a
 *   fractional retry count, a malformed completion policy, a `quorum` on the
 *   wrong strategy).
 */
export type DeclarationV3ErrorCode =
  | "not-json"
  | "not-an-object"
  | "unreadable"
  | "unsupported-version"
  | "missing-field"
  | "wrong-type"
  | "unknown-key"
  | "invalid-value";

/** One machine-readable front-end issue. */
export interface DeclarationV3Issue {
  /** Stable code; see {@link DeclarationV3ErrorCode}. */
  readonly code: DeclarationV3ErrorCode;
  /** Human-readable explanation naming what was received. Wording is not API. */
  readonly message: string;
  /** Location in the authored value, e.g. `$.nodes[0].outcomes[1].id`. */
  readonly path: string;
}

/**
 * The parse result. The failure arm carries EVERY issue the front-end found,
 * in declaration order, so one call reports the whole malformed surface instead
 * of only the first defect.
 */
export type DeclarationV3ParseResult =
  | { readonly ok: true; readonly declaration: GraphDeclarationV3 }
  | { readonly ok: false; readonly errors: readonly DeclarationV3Issue[] };

/**
 * Parse authored data into a strict {@link GraphDeclarationV3}.
 *
 * Accepts JSON text or an already-parsed value. PURE and TOTAL: no I/O, no
 * mutation of the input, and no exception for any input.
 */
export function parseGraphDeclarationV3(
  input: unknown,
): DeclarationV3ParseResult {
  try {
    // TEXT is parsed; a non-string is already a value. The two failure modes
    // are distinct on purpose: text that does not parse is `not-json`, while a
    // value that is not a JSON object (including `undefined`) is
    // `not-an-object` — a caller must not read a missing argument as bad JSON.
    let candidate: unknown = input;
    if (typeof input === "string") {
      candidate = parseJsonText(input);
      if (candidate === undefined) {
        return failed([
          issue("not-json", "the declaration text is not valid JSON", "$"),
        ]);
      }
    }
    if (!isRecord(candidate)) {
      return failed([
        issue(
          "not-an-object",
          `the declaration must be a JSON object, received ${describeValue(candidate)}`,
          "$",
        ),
      ]);
    }
    const log: IssueLog = { issues: [] };
    const parsed = readRoot(candidate, log);
    if (parsed === undefined || log.issues.length > 0) {
      return failed(log.issues);
    }
    // The shared structural guard is the final AGREEMENT check over the value
    // this module built. It is unreachable for a declaration the walker
    // produced (the walker is strictly narrower), and it exists so the
    // front-end and the compiler cannot silently disagree about the grammar's
    // shape.
    if (!isGraphDeclarationV3(parsed)) {
      return failed([
        issue(
          "invalid-value",
          "the parsed declaration does not satisfy the shared v3 structural guard",
          "$",
        ),
      ]);
    }
    freezeDeep(parsed);
    return Object.freeze({ ok: true as const, declaration: parsed });
  } catch (error) {
    return failed([
      issue(
        "unreadable",
        `the declaration could not be read: ${errorText(error)}`,
        "$",
      ),
    ]);
  }
}

// ── Root ────────────────────────────────────────────────────────────────────

/**
 * The keys each grammar level declares. The grammar is CLOSED: any own key
 * outside its level's list is `unknown-key`, so a misspelled field is a
 * refusal instead of a silently ignored one.
 */
const ROOT_KEYS = [
  "version",
  "name",
  "nodes",
  "edges",
  "loop_groups",
  "completion_policy",
] as const;
const NODE_KEYS = [
  "id",
  "agent",
  "prompt",
  "outcomes",
  "completion",
  "contractRef",
  "join",
  "budget",
  "inputs",
] as const;
const INPUT_KEYS = ["from", "outcome"] as const;
const OUTCOME_KEYS = ["id", "data", "acceptance"] as const;
const OUTCOME_DATA_KEYS = ["schema", "version"] as const;
const ACCEPTANCE_KEYS = ["validator", "version"] as const;
const EDGE_KEYS = ["from", "to", "outcome"] as const;
const LOOP_GROUP_KEYS = [
  "id",
  "nodes",
  "max_traversals",
  "continuation_outcome",
  "exit_outcome",
  "progress",
] as const;
const PROGRESS_KEYS = [
  "evaluator",
  "version",
  "subject",
  "max_unchanged",
] as const;
const CONTRACT_REF_KEYS = ["id", "revision", "digest"] as const;
const COMPLETION_POLICY_REQUEST_KEYS = ["id", "revision"] as const;
const JOIN_KEYS = ["strategy", "quorum"] as const;
const BUDGET_KEYS = [
  "max_input_tokens",
  "max_output_tokens",
  "max_cost_usd",
  "timeout_ms",
  "max_retries",
] as const;

/** Mutable issue accumulator for one parse pass. */
interface IssueLog {
  readonly issues: DeclarationV3Issue[];
}

/**
 * Read the declaration root. Fields are read in grammar order and every
 * failure is collected before the verdict, so the caller sees the whole
 * malformed surface at once.
 */
function readRoot(value: unknown, log: IssueLog): GraphDeclarationV3 | undefined {
  const record = readRecord(value, "$", log);
  if (record === undefined) return undefined;
  rejectUnknownKeys(record, ROOT_KEYS, "$", log);

  const version = readRootVersion(record.version, log);
  const name = readGraphName(record.name, "$.name", log);

  const nodes = readList(
    record.nodes,
    "$.nodes",
    log,
    (entry, path) => readNode(entry, path, log),
  );

  const edges = readList(
    record.edges,
    "$.edges",
    log,
    (entry, path) => readEdge(entry, path, log),
  );

  const loopGroups =
    record.loop_groups === undefined
      ? undefined
      : readList(
          record.loop_groups,
          "$.loop_groups",
          log,
          (entry, path) => readLoopGroup(entry, path, log),
        );

  const completionPolicy = readCompletionPolicyRequest(
    record.completion_policy,
    "$.completion_policy",
    log,
  );

  if (
    version === undefined ||
    name === undefined ||
    nodes === undefined ||
    edges === undefined ||
    (record.loop_groups !== undefined && loopGroups === undefined) ||
    (record.completion_policy !== undefined && completionPolicy === undefined)
  ) {
    return undefined;
  }

  return {
    version: 3,
    name,
    nodes,
    edges,
    ...(loopGroups === undefined ? {} : { loop_groups: loopGroups }),
    ...(completionPolicy === undefined
      ? {}
      : { completion_policy: completionPolicy }),
  };
}

/**
 * Read the OPTIONAL completion-policy request: `{ id, revision }` of
 * non-empty strings.
 *
 * A request names a policy revision; it cannot carry rules or a digest, so a
 * declaration can ask for an authorization but never supply one. The grammar
 * is closed here like everywhere else — an extra key is `unknown-key`, so a
 * document that tries to smuggle rules past this front-end is refused rather
 * than silently narrowed to its id and revision.
 */
function readCompletionPolicyRequest(
  value: unknown,
  path: string,
  log: IssueLog,
): CompletionPolicyRequestV3 | undefined {
  if (value === undefined) return undefined;
  const record = readRecord(value, path, log);
  if (record === undefined) return undefined;
  rejectUnknownKeys(record, COMPLETION_POLICY_REQUEST_KEYS, path, log);

  const id = readNonEmptyString(record.id, `${path}.id`, log);
  const revision = readNonEmptyString(record.revision, `${path}.revision`, log);
  if (id === undefined || revision === undefined) return undefined;
  return { id, revision };
}

/** Read the authoring-grammar tag: present, the number 3, and nothing else. */
function readRootVersion(value: unknown, log: IssueLog): 3 | undefined {
  if (value === undefined) {
    log.issues.push(
      issue(
        "missing-field",
        "the declaration carries no version — the v3 grammar requires version 3",
        "$.version",
      ),
    );
    return undefined;
  }
  if (typeof value !== "number") {
    log.issues.push(
      issue(
        "wrong-type",
        `$.version must be the number 3, received ${describeValue(value)}`,
        "$.version",
      ),
    );
    return undefined;
  }
  if (value !== 3) {
    log.issues.push(
      issue(
        "unsupported-version",
        `$.version is ${value}; this front-end reads authoring grammar 3 only (the v2 authoring grammar and its parser were deleted with the legacy runtime)`,
        "$.version",
      ),
    );
    return undefined;
  }
  return 3;
}

// ── Nodes ───────────────────────────────────────────────────────────────────

/** Read one node, or `undefined` when it is not one the grammar admits. */
function readNode(
  value: unknown,
  path: string,
  log: IssueLog,
): NodeDeclarationV3 | undefined {
  const record = readRecord(value, path, log);
  if (record === undefined) return undefined;
  rejectUnknownKeys(record, NODE_KEYS, path, log);

  const id = readNonEmptyString(record.id, `${path}.id`, log);
  const agent = readString(record.agent, `${path}.agent`, log);
  const prompt = readString(record.prompt, `${path}.prompt`, log);

  const outcomes = readList(
    record.outcomes,
    `${path}.outcomes`,
    log,
    (entry, entryPath) => readOutcome(entry, entryPath, log),
  );

  const completion = readCompletion(record.completion, `${path}.completion`, log);
  const contractRef = readContractRef(record.contractRef, `${path}.contractRef`, log);
  const join = readJoin(record.join, `${path}.join`, log);
  const budget = readBudget(record.budget, `${path}.budget`, log);
  const inputs =
    record.inputs === undefined
      ? undefined
      : readList(
          record.inputs,
          `${path}.inputs`,
          log,
          (entry, entryPath) => readInput(entry, entryPath, log),
        );

  if (
    id === undefined ||
    agent === undefined ||
    prompt === undefined ||
    outcomes === undefined ||
    (record.inputs !== undefined && inputs === undefined)
  ) {
    return undefined;
  }

  return {
    id,
    agent,
    prompt,
    outcomes,
    ...(completion === undefined ? {} : { completion }),
    ...(contractRef === undefined ? {} : { contractRef }),
    ...(join === undefined ? {} : { join }),
    ...(budget === undefined ? {} : { budget }),
    ...(inputs === undefined ? {} : { inputs }),
  };
}

/**
 * Read one declared DOWNSTREAM INPUT: exactly `{ from, outcome }`, both
 * non-empty strings.
 *
 * The grammar is closed here like everywhere else — an extra key inside an entry
 * is `unknown-key`, so a document cannot smuggle a third member (a path, a
 * version, a "latest" flag) past the front-end and have it silently dropped.
 * Whether the reference can actually be PINNED is the compiler's question, not
 * this one: this reader owns the shape, and an EMPTY list is a legal
 * declaration of a node that consumes nothing.
 */
function readInput(
  value: unknown,
  path: string,
  log: IssueLog,
): InputDeclarationV3 | undefined {
  const record = readRecord(value, path, log);
  if (record === undefined) return undefined;
  rejectUnknownKeys(record, INPUT_KEYS, path, log);

  const from = readNonEmptyString(record.from, `${path}.from`, log);
  const outcome = readNonEmptyString(record.outcome, `${path}.outcome`, log);
  if (from === undefined || outcome === undefined) return undefined;
  return { from, outcome };
}

/** Read one outcome declaration. */
function readOutcome(
  value: unknown,
  path: string,
  log: IssueLog,
): OutcomeDeclarationV3 | undefined {
  const record = readRecord(value, path, log);
  if (record === undefined) return undefined;
  rejectUnknownKeys(record, OUTCOME_KEYS, path, log);

  const id = readNonEmptyString(record.id, `${path}.id`, log);
  const data = readOutcomeData(record.data, `${path}.data`, log);
  const acceptance =
    record.acceptance === undefined
      ? undefined
      : readList(
          record.acceptance,
          `${path}.acceptance`,
          log,
          (entry, entryPath) =>
            readAcceptanceRequirement(entry, entryPath, log),
        );

  if (
    id === undefined ||
    (record.acceptance !== undefined && acceptance === undefined)
  ) {
    return undefined;
  }

  return {
    id,
    ...(data === undefined ? {} : { data }),
    ...(acceptance === undefined ? {} : { acceptance }),
  };
}

/** Read one outcome's optional data contract. */
function readOutcomeData(
  value: unknown,
  path: string,
  log: IssueLog,
): OutcomeDataV3 | undefined {
  if (value === undefined) return undefined;
  const record = readRecord(value, path, log);
  if (record === undefined) return undefined;
  rejectUnknownKeys(record, OUTCOME_DATA_KEYS, path, log);

  const schema = readNonEmptyString(record.schema, `${path}.schema`, log);
  const version =
    record.version === undefined
      ? undefined
      : readFiniteNumber(record.version, `${path}.version`, log);
  if (schema === undefined || (record.version !== undefined && version === undefined)) {
    return undefined;
  }
  return {
    schema,
    ...(version === undefined ? {} : { version }),
  };
}

/** Read one acceptance requirement (a validator identity and exact version). */
function readAcceptanceRequirement(
  value: unknown,
  path: string,
  log: IssueLog,
): AcceptanceRequirementV3 | undefined {
  const record = readRecord(value, path, log);
  if (record === undefined) return undefined;
  rejectUnknownKeys(record, ACCEPTANCE_KEYS, path, log);

  const validator = readNonEmptyString(record.validator, `${path}.validator`, log);
  const version =
    record.version === undefined
      ? undefined
      : readFiniteNumber(record.version, `${path}.version`, log);
  if (
    validator === undefined ||
    (record.version !== undefined && version === undefined)
  ) {
    return undefined;
  }
  return {
    validator,
    ...(version === undefined ? {} : { version }),
  };
}

/**
 * Read the optional completion policy.
 *
 * The grammar admits exactly ONE policy object — `{ mode: "explicit" }` or
 * `{ mode: "natural", outcome }`. An array (the shape in which a second
 * natural claim could reach the compiler) is refused here as a wrong type: the
 * front-end owns strictness, so a caller never gets a declaration the compiler
 * would only diagnose later.
 */
function readCompletion(
  value: unknown,
  path: string,
  log: IssueLog,
): CompletionPolicyV3 | undefined {
  if (value === undefined) return undefined;
  const record = readRecord(value, path, log);
  if (record === undefined) return undefined;

  const mode = record.mode;
  if (mode === "explicit") {
    rejectUnknownKeys(record, ["mode"], path, log);
    return { mode: "explicit" };
  }
  if (mode === "natural") {
    rejectUnknownKeys(record, ["mode", "outcome"], path, log);
    const outcome = readNonEmptyString(record.outcome, `${path}.outcome`, log);
    if (outcome === undefined) return undefined;
    return { mode: "natural", outcome };
  }
  log.issues.push(
    issue(
      "invalid-value",
      `${path}.mode is ${describeValue(mode)}, not "explicit" or "natural"`,
      `${path}.mode`,
    ),
  );
  return undefined;
}

/** Read one optional contract reference. */
function readContractRef(
  value: unknown,
  path: string,
  log: IssueLog,
): ContractRef | undefined {
  if (value === undefined) return undefined;
  const record = readRecord(value, path, log);
  if (record === undefined) return undefined;
  rejectUnknownKeys(record, CONTRACT_REF_KEYS, path, log);

  const id = readNonEmptyString(record.id, `${path}.id`, log);
  const revision = readNonEmptyString(record.revision, `${path}.revision`, log);
  const digest = readNonEmptyString(record.digest, `${path}.digest`, log);
  if (id === undefined || revision === undefined || digest === undefined) {
    return undefined;
  }
  return { id, revision, digest };
}

/** Read one optional fan-in strategy (the runtime's own discriminated union). */
function readJoin(
  value: unknown,
  path: string,
  log: IssueLog,
): JoinConfig | undefined {
  if (value === undefined) return undefined;
  const record = readRecord(value, path, log);
  if (record === undefined) return undefined;
  rejectUnknownKeys(record, JOIN_KEYS, path, log);

  const strategy = record.strategy;
  if (strategy === "all" || strategy === "any") {
    if (record.quorum !== undefined) {
      log.issues.push(
        issue(
          "invalid-value",
          `${path}.quorum is only meaningful for strategy "quorum", not "${strategy}"`,
          `${path}.quorum`,
        ),
      );
      return undefined;
    }
    return { strategy };
  }
  if (strategy === "quorum") {
    if (record.quorum === undefined) {
      log.issues.push(
        issue(
          "missing-field",
          `${path}.quorum is required when strategy is "quorum" — a quorum without a count names no fan-in rule`,
          `${path}.quorum`,
        ),
      );
      return undefined;
    }
    const quorum = readPositiveSafeInteger(record.quorum, `${path}.quorum`, log);
    if (quorum === undefined) return undefined;
    return { strategy: "quorum", quorum };
  }
  log.issues.push(
    issue(
      "invalid-value",
      `${path}.strategy is ${describeValue(strategy)}, not "all", "any" or "quorum"`,
      `${path}.strategy`,
    ),
  );
  return undefined;
}

/**
 * Read one optional per-node budget from the five numeric runtime fields.
 *
 * Each field carries the bound the rest of the stack already enforces, so a
 * budget that reaches a plan is one the runtime can act on:
 *
 * - `timeout_ms` is a NON-NEGATIVE number — 0 is the documented per-node
 *   "disable the staleness watchdog" opt-out, while a negative one would
 *   silently disable the watchdog for a node that is not opting out
 *   (the deleted v2 validator's rule 10);
 * - `max_retries` is a NON-NEGATIVE SAFE INTEGER — a retry count is an integer
 *   threshold at runtime, so a fractional or negative one is meaningless;
 * - the three ceilings are non-negative numbers.
 *
 * The zod tool layer enforces the same bounds up front (`nodeBudgetSchema` in
 * src/graph/tools/index.ts); this front-end is the gate for callers that never
 * pass through zod.
 */
function readBudget(
  value: unknown,
  path: string,
  log: IssueLog,
): NodeBudgetSpec | undefined {
  if (value === undefined) return undefined;
  const record = readRecord(value, path, log);
  if (record === undefined) return undefined;
  rejectUnknownKeys(record, BUDGET_KEYS, path, log);

  const budget: NodeBudgetSpec = {};
  let ok = true;
  for (const field of BUDGET_KEYS) {
    if (record[field] === undefined) continue;
    const parsed =
      field === "max_retries"
        ? readNonNegativeSafeInteger(record[field], `${path}.${field}`, log)
        : readNonNegativeNumber(record[field], `${path}.${field}`, log);
    if (parsed === undefined) {
      ok = false;
      continue;
    }
    budget[field] = parsed;
  }
  return ok ? budget : undefined;
}

// ── Edges ───────────────────────────────────────────────────────────────────

/** Read one control edge; every v3 edge binds exactly one outcome. */
function readEdge(
  value: unknown,
  path: string,
  log: IssueLog,
): EdgeDeclarationV3 | undefined {
  const record = readRecord(value, path, log);
  if (record === undefined) return undefined;
  rejectUnknownKeys(record, EDGE_KEYS, path, log);

  const from = readNonEmptyString(record.from, `${path}.from`, log);
  const to = readNonEmptyString(record.to, `${path}.to`, log);
  const outcome = readNonEmptyString(record.outcome, `${path}.outcome`, log);
  if (from === undefined || to === undefined || outcome === undefined) {
    return undefined;
  }
  return { from, to, outcome };
}

// ── Loop groups ─────────────────────────────────────────────────────────────

/** Read one bounded loop group, including its positive-integer traversal cap. */
function readLoopGroup(
  value: unknown,
  path: string,
  log: IssueLog,
): LoopGroupDeclarationV3 | undefined {
  const record = readRecord(value, path, log);
  if (record === undefined) return undefined;
  rejectUnknownKeys(record, LOOP_GROUP_KEYS, path, log);

  const id = readNonEmptyString(record.id, `${path}.id`, log);
  const nodes = readList(
    record.nodes,
    `${path}.nodes`,
    log,
    (entry, entryPath) => readNonEmptyString(entry, entryPath, log),
  );
  const maxTraversals = readPositiveSafeInteger(
    record.max_traversals,
    `${path}.max_traversals`,
    log,
  );
  const continuation = readNonEmptyString(
    record.continuation_outcome,
    `${path}.continuation_outcome`,
    log,
  );
  const exit = readNonEmptyString(
    record.exit_outcome,
    `${path}.exit_outcome`,
    log,
  );

  const progress =
    record.progress === undefined
      ? undefined
      : readProgressPolicy(record.progress, `${path}.progress`, log);

  if (
    id === undefined ||
    nodes === undefined ||
    maxTraversals === undefined ||
    continuation === undefined ||
    exit === undefined ||
    (record.progress !== undefined && progress === undefined)
  ) {
    return undefined;
  }
  return {
    id,
    nodes,
    max_traversals: maxTraversals,
    continuation_outcome: continuation,
    exit_outcome: exit,
    ...(progress === undefined ? {} : { progress }),
  };
}

/**
 * Read one loop group's optional progress policy.
 *
 * The same strictness as every other level: a closed key set, a required field
 * of the declared JSON type, and a positive safe integer wherever the grammar
 * says "exact version" or "threshold". The comparison SEMANTICS and the
 * comparison OBJECT are declared here and persisted in the plan; whether this
 * build implements the declared evaluator is a RUN-PATH refusal, not a parse
 * question.
 */
function readProgressPolicy(
  value: unknown,
  path: string,
  log: IssueLog,
): ProgressPolicyV3 | undefined {
  const record = readRecord(value, path, log);
  if (record === undefined) return undefined;
  rejectUnknownKeys(record, PROGRESS_KEYS, path, log);

  const evaluator = readNonEmptyString(record.evaluator, `${path}.evaluator`, log);
  const version = readPositiveSafeInteger(record.version, `${path}.version`, log);
  const subject = readNonEmptyString(record.subject, `${path}.subject`, log);
  const maxUnchanged = readPositiveSafeInteger(
    record.max_unchanged,
    `${path}.max_unchanged`,
    log,
  );
  if (
    evaluator === undefined ||
    version === undefined ||
    subject === undefined ||
    maxUnchanged === undefined
  ) {
    return undefined;
  }
  return {
    evaluator,
    version,
    subject,
    max_unchanged: maxUnchanged,
  };
}

// ── Reading primitives ──────────────────────────────────────────────────────

/**
 * Read a required array, mapping every element through `readElement`. The
 * element reader returns `undefined` for its own malformed input and has
 * already recorded why; the whole list is then refused.
 */
function readList<T>(
  value: unknown,
  path: string,
  log: IssueLog,
  readElement: (entry: unknown, entryPath: string) => T | undefined,
): T[] | undefined {
  if (value === undefined) {
    log.issues.push(
      issue("missing-field", `${path} is required and must be an array`, path),
    );
    return undefined;
  }
  if (!isArrayValue(value)) {
    log.issues.push(
      issue(
        "wrong-type",
        `${path} must be an array, received ${describeValue(value)}`,
        path,
      ),
    );
    return undefined;
  }
  const items: T[] = [];
  let ok = true;
  for (let index = 0; index < value.length; index++) {
    const entry = readElement(value[index], `${path}[${index}]`);
    if (entry === undefined) {
      ok = false;
      continue;
    }
    items.push(entry);
  }
  return ok ? items : undefined;
}

/** Read a required object container. */
function readRecord(
  value: unknown,
  path: string,
  log: IssueLog,
): Record<string, unknown> | undefined {
  if (value === undefined) {
    log.issues.push(
      issue(
        "missing-field",
        `${path} is required and must be a JSON object`,
        path,
      ),
    );
    return undefined;
  }
  if (!isRecord(value)) {
    log.issues.push(
      issue(
        "wrong-type",
        `${path} must be a JSON object, received ${describeValue(value)}`,
        path,
      ),
    );
    return undefined;
  }
  return value;
}

/** Read a required string of any length (the grammar allows an empty agent). */
function readString(
  value: unknown,
  path: string,
  log: IssueLog,
): string | undefined {
  if (value === undefined) {
    log.issues.push(
      issue("missing-field", `${path} is required and must be a string`, path),
    );
    return undefined;
  }
  if (typeof value !== "string") {
    log.issues.push(
      issue(
        "wrong-type",
        `${path} must be a string, received ${describeValue(value)}`,
        path,
      ),
    );
    return undefined;
  }
  return value;
}

/** Read a required non-empty string. */
function readNonEmptyString(
  value: unknown,
  path: string,
  log: IssueLog,
): string | undefined {
  const text = readString(value, path, log);
  if (text === undefined) return undefined;
  if (text.length === 0) {
    log.issues.push(
      issue("invalid-value", `${path} must be a non-empty string`, path),
    );
    return undefined;
  }
  return text;
}

/**
 * Read the required graph name — which IS the graph id.
 *
 * A name that is blank after trimming names no graph: `graph_declare` refuses
 * the same input (`name.trim() === ""`), and a whitespace-only id would own a
 * state-file key no caller could address deliberately. The authored spelling is
 * preserved — the ingress does not silently rewrite a declaration it just
 * validated.
 */
function readGraphName(
  value: unknown,
  path: string,
  log: IssueLog,
): string | undefined {
  const text = readNonEmptyString(value, path, log);
  if (text === undefined) return undefined;
  if (text.trim().length === 0) {
    log.issues.push(
      issue(
        "invalid-value",
        `${path} must not be blank — it IS the graph id, and a blank name names no graph`,
        path,
      ),
    );
    return undefined;
  }
  return text;
}

/** Read a required finite number (the canonical digest cannot carry others). */
function readFiniteNumber(
  value: unknown,
  path: string,
  log: IssueLog,
): number | undefined {
  if (value === undefined) {
    log.issues.push(
      issue("missing-field", `${path} is required and must be a number`, path),
    );
    return undefined;
  }
  if (typeof value !== "number") {
    log.issues.push(
      issue(
        "wrong-type",
        `${path} must be a number, received ${describeValue(value)}`,
        path,
      ),
    );
    return undefined;
  }
  if (!Number.isFinite(value)) {
    log.issues.push(
      issue(
        "invalid-value",
        `${path} must be a finite number, received ${describeValue(value)}`,
        path,
      ),
    );
    return undefined;
  }
  return value;
}

/** Read a required positive safe integer (a cap, never a fractional one). */
function readPositiveSafeInteger(
  value: unknown,
  path: string,
  log: IssueLog,
): number | undefined {
  const parsed = readFiniteNumber(value, path, log);
  if (parsed === undefined) return undefined;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    log.issues.push(
      issue(
        "invalid-value",
        `${path} must be a positive safe integer, received ${describeValue(value)}`,
        path,
      ),
    );
    return undefined;
  }
  return parsed;
}

/** Read a required finite number that is not negative (a ceiling). */
function readNonNegativeNumber(
  value: unknown,
  path: string,
  log: IssueLog,
): number | undefined {
  const parsed = readFiniteNumber(value, path, log);
  if (parsed === undefined) return undefined;
  if (parsed < 0) {
    log.issues.push(
      issue(
        "invalid-value",
        `${path} must be a non-negative number, received ${describeValue(value)}`,
        path,
      ),
    );
    return undefined;
  }
  return parsed;
}

/** Read a required non-negative safe integer (a retry count). */
function readNonNegativeSafeInteger(
  value: unknown,
  path: string,
  log: IssueLog,
): number | undefined {
  const parsed = readFiniteNumber(value, path, log);
  if (parsed === undefined) return undefined;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    log.issues.push(
      issue(
        "invalid-value",
        `${path} must be a non-negative safe integer, received ${describeValue(value)}`,
        path,
      ),
    );
    return undefined;
  }
  return parsed;
}

/**
 * Reject every own key the level does not declare. Keys are reported in
 * canonical (sorted) order, so the same content produces the same diagnostics
 * whatever order the authored object happened to list its keys in.
 */
function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  log: IssueLog,
): void {
  const unknown = Object.keys(record)
    .filter((key) => !allowed.includes(key))
    .sort(compareText);
  for (const key of unknown) {
    log.issues.push(
      issue(
        "unknown-key",
        `${path} carries unknown key ${JSON.stringify(key)} — the v3 grammar is closed; allowed keys: ${allowed.join(", ")}`,
        path === "$" ? `$.${key}` : `${path}.${key}`,
      ),
    );
  }
}

// ── Primitives ──────────────────────────────────────────────────────────────

/** Build one frozen issue. */
function issue(
  code: DeclarationV3ErrorCode,
  message: string,
  path: string,
): DeclarationV3Issue {
  return Object.freeze({ code, message, path });
}

/** Assemble a failed result with a frozen issue list. */
function failed(errors: readonly DeclarationV3Issue[]): DeclarationV3ParseResult {
  return Object.freeze({
    ok: false as const,
    errors: Object.freeze([...errors]),
  });
}

/**
 * Parse JSON text, answering `undefined` for text that is not JSON. A parsed
 * `null` is a real value, so it is distinguished from the failure sentinel by
 * the null check at the call site.
 */
function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Whether a value is a JSON object container (non-null, non-array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a value is an array, narrowed without an `any` element type. */
function isArrayValue(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** UTF-16 code-unit order, so key diagnostics never depend on the locale. */
function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Name what was received, without ever throwing on the value being described:
 * the diagnostic for a hostile input must not itself raise.
 */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `an array of ${value.length} element(s)`;
  switch (typeof value) {
    case "string":
      return `the string ${JSON.stringify(value)}`;
    case "number":
      return `the number ${String(value)}`;
    case "boolean":
      return `the boolean ${String(value)}`;
    case "object":
      return "an object";
    default:
      return `a ${typeof value}`;
  }
}

/**
 * Deep-freeze a freshly built declaration. Every container is one this module
 * created, and freezing it is what makes "validated" durable: a caller that
 * mutates its own input afterwards cannot move the declaration handed to the
 * compiler.
 */
function freezeDeep(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item);
    return;
  }
  for (const key of Object.keys(value)) {
    freezeDeep((value as Record<string, unknown>)[key]);
  }
}
