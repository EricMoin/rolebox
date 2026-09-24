import { APPROVAL_POLICY_ENV, createApprovalPolicy, type ApprovalPolicy } from "./approval-policy.ts";
import { spawnSync } from "node:child_process";

import type { ApprovalRequestStatus } from "../ledger/types.ts";
import { putArtifact } from "../store/artifacts.ts";
import { loadGraphStoreSync } from "../store/load.ts";
import { loadGraphCompletionPolicies } from "./declarations.ts";
import type {
  CompletionPolicyLoadIssue,
  CompletionPolicyRef,
  CompletionPolicyRegistry,
} from "./completion-policy.ts";
import {
  ARTIFACT_REFERENCE_VALIDATOR_ID,
  ARTIFACT_REFERENCE_VALIDATOR_VERSION,
  createArtifactReferenceValidator,
  createValidatorRegistry,
  readArtifact,
  type AcceptanceCapabilitySet,
  type ArtifactEvidence,
  type ValidationOutcome,
  type ValidatorImplementation,
  type ValidatorRegistry,
  type ValidatorRequest,
} from "../outcome/validators.ts";

// ── The closed set's identities ─────────────────────────────────────────────

/** The schema primitive's validator id. */
export const SCHEMA_VALIDATOR_ID = "schema";
/** The schema primitive's exact version. */
export const SCHEMA_VALIDATOR_VERSION = 1;
/** The artifact primitive's validator id (re-exported for one place to read). */
export const ARTIFACT_VALIDATOR_ID = ARTIFACT_REFERENCE_VALIDATOR_ID;
/** The artifact primitive's exact version. */
export const ARTIFACT_VALIDATOR_VERSION = ARTIFACT_REFERENCE_VALIDATOR_VERSION;
/** The command-exit primitive's validator id. */
export const COMMAND_EXIT_VALIDATOR_ID = "command-exit";
/** The command-exit primitive's exact version. */
export const COMMAND_EXIT_VALIDATOR_VERSION = 1;
/** The principal-approval primitive's validator id. */
export const PRINCIPAL_APPROVAL_VALIDATOR_ID = "principal-approval";
/** The principal-approval primitive's exact version. */
export const PRINCIPAL_APPROVAL_VALIDATOR_VERSION = 1;

// ── Schema ──────────────────────────────────────────────────────────────────

/** What one installed schema answers about one payload. */
export type SchemaVerdict =
  | { readonly kind: "valid" }
  | { readonly kind: "invalid"; readonly reason: string };

/**
 * One schema implementation the host installs under an exact identity.
 *
 * A schema is CODE, not a document: the outcome's plan-declared data contract
 * names `{ schema, version }`, and the implementation behind that identity
 * decides the payload. That keeps the primitive closed (no agent-authored
 * expressions, no general-purpose rule language) while still letting one
 * host ship several named contracts.
 */
export interface SchemaRegistration {
  /** Schema identity, as an outcome's `data.schema` declares it. */
  readonly schema: string;
  /** Exact version; matching is identity, never ordering. */
  readonly version: number;
  /** The check itself; a throw is reported as indeterminate by the caller. */
  readonly validate: (data: unknown) => SchemaVerdict;
}

/** The schema the repository itself substantiates: a JSON record payload. */
export const SHIPPED_JSON_OBJECT_SCHEMA_ID = "json-object";
/** The shipped JSON-record schema's exact version. */
export const SHIPPED_JSON_OBJECT_SCHEMA_VERSION = 1;

/**
 * The one schema this repository ships: the payload is a JSON RECORD — a
 * non-null, non-array object. It is deliberately the narrowest useful contract
 * (no property DSL, no keywords), and it is a real check: an array, a scalar or
 * a missing payload is refused.
 */
export function createJsonObjectSchema(): SchemaRegistration {
  return Object.freeze({
    schema: SHIPPED_JSON_OBJECT_SCHEMA_ID,
    version: SHIPPED_JSON_OBJECT_SCHEMA_VERSION,
    validate: (data: unknown): SchemaVerdict => {
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        return {
          kind: "invalid",
          reason:
            "the payload is not a JSON record: a " +
            describeValue(data) +
            " cannot satisfy the json-object contract",
        };
      }
      return { kind: "valid" };
    },
  });
}

/** The schemas the shipped assembly installs. */
export const REPOSITORY_SCHEMAS: readonly SchemaRegistration[] = Object.freeze([
  createJsonObjectSchema(),
]);

/**
 * The payload-shape primitive.
 *
 * The schema IDENTITY is resolved from `request.dataContract` — the compiled
 * plan's declaration for the claimed outcome — never from the submission. Each
 * way the plan's contract cannot be checked is its own answer:
 * - no declared contract: `fail`. A required shape gate whose subject the plan
 *   never declared is precisely a gate that cannot be shown to hold, and the
 *   protocol forbids reporting it as passed;
 * - a contract with no exact version, or one this host installs no
 *   implementation for: `indeterminate`. The check could not be completed, and
 *   an indeterminate result never satisfies a required gate;
 * - a payload that is absent: `fail`, for the same reason the artifact
 *   validator fails an empty subject set — absence of a payload is not a
 *   payload;
 * - an implementation that throws: `indeterminate`, never an accidental pass.
 */
export function createSchemaValidator(
  schemas: readonly SchemaRegistration[] = REPOSITORY_SCHEMAS,
): ValidatorImplementation {
  const installed = new Map<string, SchemaRegistration>();
  for (const registration of schemas) {
    if (
      typeof registration.schema !== "string" ||
      registration.schema.length === 0
    ) {
      throw new Error(
        "schema-validator: a schema registration needs a non-empty schema identity",
      );
    }
    if (!Number.isSafeInteger(registration.version) || registration.version <= 0) {
      throw new Error(
        "schema-validator: schema " +
        JSON.stringify(registration.schema) +
        " needs a positive safe-integer version",
      );
    }
    if (typeof registration.validate !== "function") {
      throw new Error(
        "schema-validator: schema " +
        JSON.stringify(registration.schema) +
        "@" +
        String(registration.version) +
        " has no validate function — a schema is an implementation, never a name",
      );
    }
    const key = schemaKey(registration.schema, registration.version);
    if (installed.has(key)) {
      throw new Error(
        "schema-validator: schema " +
        JSON.stringify(registration.schema) +
        "@" +
        String(registration.version) +
        " is registered twice",
      );
    }
    installed.set(key, registration);
  }
  return (request: ValidatorRequest): ValidationOutcome => {
    const contract = request.dataContract;
    if (contract === undefined) {
      return {
        kind: "fail",
        reason:
          "the compiled plan declares no data contract for this outcome, so a required schema gate has nothing to check — an undeclared contract is not a passing one",
      };
    }
    if (
      !Number.isSafeInteger(contract.version) ||
      (contract.version as number) <= 0
    ) {
      return {
        kind: "indeterminate",
        reason:
          "the compiled plan's data contract names schema " +
          JSON.stringify(contract.schema) +
          " without an exact version, and capability matching is identity — the gate cannot be resolved",
      };
    }
    const registration = installed.get(
      schemaKey(contract.schema, contract.version as number),
    );
    if (registration === undefined) {
      return {
        kind: "indeterminate",
        reason:
          "schema " +
          JSON.stringify(contract.schema) +
          "@" +
          String(contract.version) +
          " is declared by the compiled plan and is not installed in this host — the payload cannot be checked against it",
      };
    }
    if (request.proposal.data === undefined) {
      return {
        kind: "fail",
        reason:
          "the submission carries no payload, so schema " +
          JSON.stringify(contract.schema) +
          "@" +
          String(contract.version) +
          " has nothing to validate — an absent payload is not a valid one",
      };
    }
    let verdict: SchemaVerdict;
    try {
      verdict = registration.validate(request.proposal.data);
    } catch (error) {
      return {
        kind: "indeterminate",
        reason:
          "schema " +
          JSON.stringify(contract.schema) +
          "@" +
          String(contract.version) +
          " threw while checking the payload (" +
          errorText(error) +
          ") — an indeterminate check never satisfies a required gate",
      };
    }
    return verdict.kind === "valid"
      ? { kind: "pass" }
      : { kind: "fail", reason: verdict.reason };
  };
}

// ── Command exit ────────────────────────────────────────────────────────────

/**
 * One command the HOST authorizes as a check for one exact mapping.
 *
 * The mapping is the plan's identity — the graph id, the node id and the
 * outcome id — not a submission field. `cwd` and `artifactRefs` are the
 * binding the result is recorded against: the command runs IN that working
 * directory, and the artifacts it judges are read (and re-read) by this module,
 * so "the check passed" always means "it passed for this revision".
 */
export interface TrustedCommandBinding {
  /** The graph the check belongs to. */
  readonly graphId: string;
  /** The node the check belongs to. */
  readonly nodeId: string;
  /** The outcome the check belongs to. */
  readonly outcome: string;
  /** Program and arguments, executed WITHOUT a shell. */
  readonly argv: readonly string[];
  /** The working directory the command runs in (absolute). */
  readonly cwd: string;
  /** Wall-clock limit; a command still running at the limit is indeterminate. */
  readonly timeoutMs: number;
  /** The one exit code that means the check passed. */
  readonly expectExitCode: number;
  /** Artifacts the check is bound to, resolved under the artifact root. */
  readonly artifactRefs: readonly string[];
}

/** What one command run answered. */
export type CommandRunResult =
  | {
    readonly kind: "exited";
    readonly exitCode: number | null;
    readonly signal: string | null;
  }
  /** The command could not be run at all (a missing program, a spawn error). */
  | { readonly kind: "unavailable"; readonly reason: string };

/** How a command is executed; the default runs it directly, without a shell. */
export type CommandRunner = (
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
) => CommandRunResult;

/** One recorded check: what ran, against which revision, and what it answered. */
export interface CommandExitEvidence {
  readonly graphId: string;
  readonly nodeId: string;
  readonly outcome: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly expectExitCode: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** The artifact revision the command was bound to, as it was read. */
  readonly artifactRevisions: readonly ArtifactEvidence[];
  readonly verdict: "pass" | "fail" | "indeterminate";
  readonly reason: string;
}

/** Options for {@link createCommandExitValidator}. */
export interface CommandExitValidatorOptions {
  /** The commands this host authorizes, by exact mapping. */
  readonly commands: readonly TrustedCommandBinding[];
  /** Override the runner (tests inject a deterministic one). */
  readonly run?: CommandRunner;
  /** Called once per checked requirement with what actually happened. */
  readonly onCheck?: (evidence: CommandExitEvidence) => void;
  /**
   * The immutable content store this check DEPOSITS the revision it verified
   * into — the SAME store the artifact-reference primitive retains into.
   *
   * A pass NAMES an artifact identity, and naming one whose bytes were never
   * deposited leaves every consumer permanently refused: the accepted result
   * points at a revision nobody can materialize. The deposit is therefore part
   * of the gate, not an optimization, and a host that configures no store root
   * here can never deliver a command-gated result — this implementation says
   * exactly that by answering `indeterminate` rather than passing.
   */
  readonly artifactStoreRoot?: string;
}

/**
 * The command-exit primitive.
 *
 * A mapping the host authorized runs the HOST's command; a mapping it did not
 * authorize is `indeterminate` (the gate cannot be completed and is never
 * skipped). A command that cannot be started, is killed, or outlives its limit
 * is `indeterminate`; an exit other than the expected code is `fail`; the
 * expected code is `pass` — but only when the artifact revision the check was
 * bound to is the same one read after the command finished. A command that
 * changed (or could not re-read) its own subject is `indeterminate`, because
 * "it passed for revision A while the artifacts are at revision B" is exactly
 * the mutable-artifact defect the protocol forbids.
 *
 * A PASS NAMES THE REVISION IT VERIFIED (D5), AND DEPOSITS IT (A1). Its outcome
 * carries the artifact revisions RE-READ AFTER the command finished — the same
 * reading the pre-run comparison above accepted — and those exact bytes are
 * PUBLISHED into the host's content store before the pass is returned, so the
 * identity the pass names is one a consumer can actually produce. Dropping that
 * reading left "the version the command verified" inexpressible; returning it
 * without depositing it left a command-only plan accepting once and then
 * refusing every successor forever, because the accepted result named a
 * revision the store had never been given.
 *
 * DEPOSIT-OR-REFUSE. A deposit that cannot be published, and a host with no
 * content store to deposit into, are both `indeterminate` — a required gate
 * that cannot be completed is never skipped and never silently passes. A
 * host that genuinely runs without a content store therefore produces a
 * named non-pass instead of an accepted result that can never be delivered.
 */
export function createCommandExitValidator(
  options: CommandExitValidatorOptions,
): ValidatorImplementation {
  const commands = new Map<string, TrustedCommandBinding>();
  for (const binding of options.commands) {
    assertCommandBinding(binding);
    const key = commandMappingKey(binding);
    if (commands.has(key)) {
      throw new Error(
        "command-exit-validator: mapping " +
        describeMapping(binding) +
        " is authorized twice — one mapping has exactly one trusted command",
      );
    }
    commands.set(key, binding);
  }
  const run = options.run ?? runCommandDirectly;
  const onCheck = options.onCheck;
  const storeRoot = options.artifactStoreRoot;
  return (request: ValidatorRequest): ValidationOutcome => {
    const key = commandMappingKey({
      graphId: request.identity.graphId,
      nodeId: request.proposal.nodeId,
      outcome: request.proposal.outcomeId,
    });
    const binding = commands.get(key);
    if (binding === undefined) {
      return {
        kind: "indeterminate",
        reason:
          "no trusted command policy authorizes a check for " +
          describeMapping({
            graphId: request.identity.graphId,
            nodeId: request.proposal.nodeId,
            outcome: request.proposal.outcomeId,
          }) +
          " — the command a requirement is judged by comes from the host, never from the submission, and an unauthorized mapping is never treated as passed",
      };
    }
    // NOWHERE TO DEPOSIT, SO THIS GATE CAN NEVER PASS (A1). The check is made
    // BEFORE the command runs: an authorized command whose verdict could never
    // be retained must not be started at all, and "this host has no content
    // store" is a fact about the host, not a verdict about the work. The
    // answer is a NAMED non-pass, so the deliberate exception — a host that
    // genuinely runs without a content store — is honest rather than an
    // accepted result that can never be delivered.
    if (storeRoot === undefined) {
      return indeterminate(
        binding,
        [],
        null,
        null,
        "this host has no artifact store root to deposit the revision into, so a required command-exit gate could never retain the bytes it verified — no command was run, and the gate is never treated as passed",
        onCheck,
      );
    }
    const before = readRevisions(request.artifactRoot, binding.artifactRefs);
    if (before.kind === "problem") {
      return indeterminate(
        binding,
        [],
        null,
        null,
        "the artifacts this check is bound to could not be read before the command ran: " +
        before.reason,
        onCheck,
      );
    }
    let result: CommandRunResult;
    try {
      result = run(binding.argv, binding.cwd, binding.timeoutMs);
    } catch (error) {
      return indeterminate(
        binding,
        evidenceOf(before.entries),
        null,
        null,
        "the trusted command could not be executed (" + errorText(error) + ")",
        onCheck,
      );
    }
    if (result.kind === "unavailable") {
      return indeterminate(
        binding,
        evidenceOf(before.entries),
        null,
        null,
        "the trusted command could not be executed: " + result.reason,
        onCheck,
      );
    }
    const after = readRevisions(request.artifactRoot, binding.artifactRefs);
    if (after.kind === "problem") {
      return indeterminate(
        binding,
        evidenceOf(before.entries),
        result.exitCode,
        result.signal,
        "the artifacts this check is bound to could not be re-read after the command ran: " +
        after.reason,
        onCheck,
      );
    }
    if (!sameRevisions(before.entries, after.entries)) {
      return indeterminate(
        binding,
        evidenceOf(before.entries),
        result.exitCode,
        result.signal,
        "the artifacts changed while the trusted command ran (" +
        describeRevisionChange(before.entries, after.entries) +
        "), so its result describes no fixed artifact revision",
        onCheck,
      );
    }
    if (result.signal !== null || result.exitCode === null) {
      return indeterminate(
        binding,
        evidenceOf(before.entries),
        result.exitCode,
        result.signal,
        "the trusted command did not exit on its own (signal " +
        JSON.stringify(result.signal) +
        ") — a killed or timed-out check never satisfies a required gate",
        onCheck,
      );
    }
    if (result.exitCode !== binding.expectExitCode) {
      return record(
        binding,
        evidenceOf(before.entries),
        result.exitCode,
        result.signal,
        "fail",
        "the trusted command exited with code " +
        String(result.exitCode) +
        ", and this mapping requires " +
        String(binding.expectExitCode),
        onCheck,
      );
    }
    // THE PASS CARRIES THE POST-RUN READING AND DEPOSITS IT. The artifacts were
    // re-read after the command finished and compared with the pre-run reading
    // above; DEPOSITING those exact bytes is what lets an acceptance retain a
    // revision a consumer can actually produce (D5, A1). A deposit that cannot
    // be published refuses the pass rather than naming an identity nobody can
    // materialize.
    const retained = depositRevisions(storeRoot, after.entries);
    if (retained.kind === "problem") {
      return indeterminate(
        binding,
        evidenceOf(after.entries),
        result.exitCode,
        result.signal,
        "the trusted command exited with the required code " +
        String(binding.expectExitCode) +
        " against a fixed artifact revision, but that revision could not be deposited (" +
        retained.reason +
        ") — an acceptance naming it could never produce it, so the gate does not pass",
        onCheck,
      );
    }
    return record(
      binding,
      retained.evidence,
      result.exitCode,
      result.signal,
      "pass",
      "the trusted command exited with the required code " +
      String(binding.expectExitCode) +
      " in " +
      JSON.stringify(binding.cwd) +
      " against the recorded artifact revision, which was deposited as the revision this pass names",
      onCheck,
    );
  };
}

/** The default runner: an argv vector executed directly, with no shell. */
function runCommandDirectly(
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
): CommandRunResult {
  const executable = argv[0];
  if (executable === undefined) {
    return { kind: "unavailable", reason: "the command has no program" };
  }
  const result = spawnSync(executable, argv.slice(1), {
    cwd,
    timeout: timeoutMs,
    encoding: "utf8",
    stdio: "ignore",
  });
  if (result.error !== undefined && result.error !== null) {
    return { kind: "unavailable", reason: errorText(result.error) };
  }
  return {
    kind: "exited",
    exitCode: result.status,
    signal: result.signal === null ? null : String(result.signal),
  };
}

/** Build one indeterminate answer and record its evidence. */
function indeterminate(
  binding: TrustedCommandBinding,
  revisions: readonly ArtifactEvidence[],
  exitCode: number | null,
  signal: string | null,
  reason: string,
  onCheck: ((evidence: CommandExitEvidence) => void) | undefined,
): ValidationOutcome {
  return record(binding, revisions, exitCode, signal, "indeterminate", reason, onCheck);
}

/** Record one check's evidence and return the matching validation outcome. */
function record(
  binding: TrustedCommandBinding,
  revisions: readonly ArtifactEvidence[],
  exitCode: number | null,
  signal: string | null,
  verdict: "pass" | "fail" | "indeterminate",
  reason: string,
  onCheck: ((evidence: CommandExitEvidence) => void) | undefined,
): ValidationOutcome {
  if (onCheck !== undefined) {
    onCheck(
      Object.freeze({
        graphId: binding.graphId,
        nodeId: binding.nodeId,
        outcome: binding.outcome,
        argv: Object.freeze([...binding.argv]),
        cwd: binding.cwd,
        expectExitCode: binding.expectExitCode,
        exitCode,
        signal,
        artifactRevisions: Object.freeze([...revisions]),
        verdict,
        reason,
      }),
    );
  }
  if (verdict === "pass") {
    // The revisions this check re-read after the command finished. A caller that
    // RETURNS a pass without them loses the only channel by which "the revision
    // the command verified" reaches the acceptance transaction.
    return { kind: "pass", evidence: Object.freeze([...revisions]) };
  }
  if (verdict === "fail") return { kind: "fail", reason };
  return { kind: "indeterminate", reason };
}

/** One binding's policy shape, checked where the binding is installed. */
function assertCommandBinding(binding: TrustedCommandBinding): void {
  for (const [field, value] of [
    ["graphId", binding.graphId],
    ["nodeId", binding.nodeId],
    ["outcome", binding.outcome],
  ] as const) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        "command-exit-validator: a trusted command binding needs a non-empty " +
        field +
        " identity",
      );
    }
  }
  if (!Array.isArray(binding.argv) || binding.argv.length === 0) {
    throw new Error(
      "command-exit-validator: " +
      describeMapping(binding) +
      " has no argv — a command is a program and its arguments",
    );
  }
  for (const part of binding.argv) {
    if (typeof part !== "string" || part.length === 0) {
      throw new Error(
        "command-exit-validator: " +
        describeMapping(binding) +
        " has an empty argv element",
      );
    }
  }
  if (typeof binding.cwd !== "string" || binding.cwd.length === 0) {
    throw new Error(
      "command-exit-validator: " +
      describeMapping(binding) +
      " has no working directory — the command's directory is part of the binding",
    );
  }
  if (!Number.isSafeInteger(binding.timeoutMs) || binding.timeoutMs <= 0) {
    throw new Error(
      "command-exit-validator: " +
      describeMapping(binding) +
      " needs a positive safe-integer timeout",
    );
  }
  if (!Number.isSafeInteger(binding.expectExitCode)) {
    throw new Error(
      "command-exit-validator: " +
      describeMapping(binding) +
      " needs an integer expected exit code",
    );
  }
  if (!Array.isArray(binding.artifactRefs) || binding.artifactRefs.length === 0) {
    throw new Error(
      "command-exit-validator: " +
      describeMapping(binding) +
      " names no artifact revision — a command gate must be bound to the artifacts it judges",
    );
  }
  for (const ref of binding.artifactRefs) {
    if (typeof ref !== "string" || ref.length === 0) {
      throw new Error(
        "command-exit-validator: " +
        describeMapping(binding) +
        " has an empty artifact reference",
      );
    }
  }
}

/**
 * One artifact as this gate read it: the evidence it recorded, and THE EXACT
 * BYTES that evidence was taken over.
 *
 * The bytes are carried rather than re-read by the depositor on purpose: a
 * second read is a different byte range, and depositing THOSE bytes under this
 * digest would retain something the command never judged — the very
 * "validated A, stored B" hole the content store exists to close.
 */
interface RevisionEntry {
  readonly evidence: ArtifactEvidence;
  readonly bytes: Buffer;
}

/** One reading of every bound artifact, in reference order. */
type RevisionReading =
  | { readonly kind: "ok"; readonly entries: readonly RevisionEntry[] }
  | { readonly kind: "problem"; readonly reason: string };

/** Read every bound artifact once, or name the first that could not be read. */
function readRevisions(root: string, refs: readonly string[]): RevisionReading {
  const entries: RevisionEntry[] = [];
  for (const ref of refs) {
    const read = readArtifact(root, ref);
    if (read.kind === "problem") return { kind: "problem", reason: read.reason };
    entries.push({ evidence: read.evidence, bytes: read.bytes });
  }
  return { kind: "ok", entries };
}

/** The recorded evidence of one reading, in reference order. */
function evidenceOf(entries: readonly RevisionEntry[]): readonly ArtifactEvidence[] {
  return entries.map((entry) => entry.evidence);
}

/**
 * DEPOSIT-OR-REFUSE (A1): publish the exact bytes one reading was taken over,
 * and answer the evidence that names the published identity.
 *
 * The SAME content store the artifact-reference primitive retains into, and the
 * same publish-once contract: a deposit that finds its identity already
 * published reuses the verified object, and an object that does not verify is a
 * problem. A caller that cannot publish must refuse the pass — naming a
 * revision nobody can produce is not a weaker way of retaining it.
 */
function depositRevisions(
  storeRoot: string,
  entries: readonly RevisionEntry[],
):
  | { readonly kind: "retained"; readonly evidence: readonly ArtifactEvidence[] }
  | { readonly kind: "problem"; readonly reason: string } {
  const retained: ArtifactEvidence[] = [];
  for (const entry of entries) {
    const deposit = putArtifact(storeRoot, entry.bytes);
    if (deposit.kind === "problem") {
      return {
        kind: "problem",
        reason:
          "artifact " +
          JSON.stringify(entry.evidence.ref) +
          " could not be retained: " +
          deposit.reason,
      };
    }
    retained.push(
      Object.freeze({
        ...entry.evidence,
        artifactId: deposit.artifactId,
        digest: deposit.digest,
        size: deposit.size,
      }),
    );
  }
  return { kind: "retained", evidence: Object.freeze(retained) };
}

/** Whether two revision readings describe the same bytes at the same refs. */
function sameRevisions(
  before: readonly RevisionEntry[],
  after: readonly RevisionEntry[],
): boolean {
  if (before.length !== after.length) return false;
  return before.every((entry, index) => {
    const other = after[index];
    return (
      other !== undefined &&
      entry.evidence.ref === other.evidence.ref &&
      entry.evidence.digest === other.evidence.digest &&
      entry.evidence.size === other.evidence.size
    );
  });
}

/** Name the references whose recorded revision moved. */
function describeRevisionChange(
  before: readonly RevisionEntry[],
  after: readonly RevisionEntry[],
): string {
  const changed: string[] = [];
  before.forEach((entry, index) => {
    const other = after[index];
    if (other === undefined || other.evidence.digest !== entry.evidence.digest) {
      changed.push(JSON.stringify(entry.evidence.ref));
    }
  });
  return changed.length === 0 ? "a reference set changed" : changed.join(", ");
}

// ── Command policy configuration ────────────────────────────────────────────

/** One entry of the host's command-policy configuration that was not readable. */
export interface CommandPolicyIssue {
  /** Position in the configured array. */
  readonly index: number;
  /** Human-readable explanation. Wording is not part of the contract. */
  readonly message: string;
}

/** What one configured command policy resolved to. */
export interface TrustedCommandPolicyReading {
  readonly bindings: readonly TrustedCommandBinding[];
  /** Every entry that was offered and not installed, in configured order. */
  readonly issues: readonly CommandPolicyIssue[];
}

/**
 * Read the host's trusted command policy from its JSON text.
 *
 * THE HOST'S OWN DECISION SURFACE. The text is the operator's configuration
 * (the shipped entries read it from `ROLEBOX_GRAPH_COMMAND_CHECKS`), never a
 * workspace file and never anything a submission can reach; a declaration may
 * REQUEST a `command-exit` requirement but cannot name a command, and a mapping
 * this list does not carry is refused at validation time.
 *
 * TOTAL: malformed JSON, a non-array document, and every malformed entry are
 * issues with the entry's index; a valid document installs only its valid
 * entries. A mapping configured MORE THAN ONCE is ambiguous — the host cannot
 * say which command judges it — so it installs NO command and every configured
 * position is reported. Nothing here throws.
 */
export function readTrustedCommandPolicy(
  text: string | undefined,
): TrustedCommandPolicyReading {
  const issues: CommandPolicyIssue[] = [];
  const trimmed = (text ?? "").trim();
  if (trimmed.length === 0) return { bindings: Object.freeze([]), issues: Object.freeze([]) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return {
      bindings: Object.freeze([]),
      issues: Object.freeze([
        Object.freeze({
          index: 0,
          message:
            "the configured trusted command policy is not JSON (" +
            errorText(error) +
            ") — no command is authorized",
        }),
      ]),
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      bindings: Object.freeze([]),
      issues: Object.freeze([
        Object.freeze({
          index: 0,
          message:
            "the configured trusted command policy is not an array of bindings — no command is authorized",
        }),
      ]),
    };
  }
  const candidates: Array<{
    readonly index: number;
    readonly binding: TrustedCommandBinding;
  }> = [];
  parsed.forEach((entry, index) => {
    const binding = readCommandBinding(entry, index, issues);
    if (binding !== undefined) candidates.push({ index, binding });
  });
  // One mapping has exactly ONE trusted command. Two configured bindings for
  // the same (graph, node, outcome) make it ambiguous — neither is the host's
  // decision — so NEITHER installs, and each is reported at its own position.
  // Resolving it HERE is what keeps the assembly's totality true: the
  // duplicate throw in createCommandExitValidator is a programmer-error guard
  // for direct construction and is unreachable through this reader.
  const byMapping = new Map<
    string,
    Array<{ readonly index: number; readonly binding: TrustedCommandBinding }>
  >();
  for (const candidate of candidates) {
    const key = commandMappingKey(candidate.binding);
    const group = byMapping.get(key);
    if (group === undefined) byMapping.set(key, [candidate]);
    else group.push(candidate);
  }
  const bindings: TrustedCommandBinding[] = [];
  byMapping.forEach((group) => {
    const only = group[0];
    if (group.length === 1 && only !== undefined) {
      bindings.push(only.binding);
      return;
    }
    const positions = group.map((candidate) => candidate.index).join(", ");
    for (const candidate of group) {
      issues.push(
        Object.freeze({
          index: candidate.index,
          message:
            "mapping " +
            describeMapping(candidate.binding) +
            " is authorized more than once (configured positions " +
            positions +
            ") — an ambiguous mapping installs no command",
        }),
      );
    }
  });
  issues.sort((left, right) => left.index - right.index);
  return { bindings: Object.freeze(bindings), issues: Object.freeze(issues) };
}

/** Read one configured binding, reporting why it was not installed. */
function readCommandBinding(
  raw: unknown,
  index: number,
  issues: CommandPolicyIssue[],
): TrustedCommandBinding | undefined {
  const problem = (message: string): undefined => {
    issues.push(Object.freeze({ index, message }));
    return undefined;
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return problem("a trusted command binding is not a record");
  }
  const record = raw as Record<string, unknown>;
  const graphId = nonEmptyString(record.graph);
  const nodeId = nonEmptyString(record.node);
  const outcome = nonEmptyString(record.outcome);
  const cwd = nonEmptyString(record.cwd);
  if (graphId === undefined || nodeId === undefined || outcome === undefined) {
    return problem(
      "a trusted command binding needs non-empty graph, node and outcome identities",
    );
  }
  if (cwd === undefined) {
    return problem("a trusted command binding needs a working directory (cwd)");
  }
  if (
    !Array.isArray(record.argv) ||
    record.argv.length === 0 ||
    !record.argv.every((part) => nonEmptyString(part) !== undefined)
  ) {
    return problem("argv must be a non-empty array of non-empty strings");
  }
  const timeoutMs = record.timeout_ms;
  if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) <= 0) {
    return problem("timeout_ms must be a positive safe integer");
  }
  const expectExitCode = record.expect_exit_code;
  if (!Number.isSafeInteger(expectExitCode)) {
    return problem("expect_exit_code must be a safe integer");
  }
  const rawRefs = record.artifact_refs;
  if (
    !Array.isArray(rawRefs) ||
    rawRefs.length === 0 ||
    !rawRefs.every((ref) => nonEmptyString(ref) !== undefined)
  ) {
    return problem(
      "artifact_refs must name at least one non-empty artifact the command is bound to",
    );
  }
  const binding: TrustedCommandBinding = Object.freeze({
    graphId,
    nodeId,
    outcome,
    argv: Object.freeze((record.argv as readonly string[]).map((part) => String(part))),
    cwd,
    timeoutMs: timeoutMs as number,
    expectExitCode: expectExitCode as number,
    artifactRefs: Object.freeze((rawRefs as readonly string[]).map((ref) => String(ref))),
  });
  try {
    assertCommandBinding(binding);
  } catch (error) {
    return problem(errorText(error));
  }
  return binding;
}

// ── Human approval ──────────────────────────────────────────────────────────

/**
 * The approval row one attempt carries, as the primitive needs it.
 *
 * A narrowed view of the durable record: the status is the decision the trusted
 * control entry wrote, and the deciding principal and reason are carried so a
 * refusal can name who decided and why — never to re-decide anything here.
 */
export interface ApprovalEvidence {
  readonly graphId: string;
  readonly attemptId: string;
  readonly nodeId: string;
  readonly status: ApprovalRequestStatus;
  /** The one session whose decision resolves this request. */
  readonly approverSessionId: string;
  readonly decisionReason?: string;
  readonly decidedAt?: number;
  readonly decidedBy?: { readonly sessionId: string; readonly agentId?: string };
}

/**
 * Where the approval primitive reads the durable row from.
 *
 * THREE-VALUED on purpose: `absent` (this attempt has no request) is a
 * different fact from `unavailable` (the store could not be read), and
 * collapsing them would report a damaged store as "no approval was required".
 */
export type ApprovalEvidenceReading =
  | { readonly kind: "found"; readonly evidence: ApprovalEvidence }
  | { readonly kind: "absent" }
  | { readonly kind: "unavailable"; readonly reason: string };

/** The host's read-only approval-evidence port. */
export interface ApprovalEvidenceReader {
  read(graphId: string, attemptId: string): ApprovalEvidenceReading;
}

/** Options for {@link createPrincipalApprovalValidator}. */
export interface PrincipalApprovalValidatorOptions {
  /** The host's approval-evidence port (the durable store, in production). */
  readonly approvals: ApprovalEvidenceReader;
}

/**
 * The principal-approval primitive.
 *
 * The gate passes only for an attempt whose durable row was APPROVED by the
 * principal the control entry authorized. Every other fact is its own answer:
 * a rejection is `fail` (and names the deciding principal and reason), an
 * expired request is `fail`, a still-pending request is `indeterminate`,
 * and an attempt with no request at all is `fail` — the gate is not satisfied
 * by the absence of a request, and a submission has no path to raise one.
 */
export function createPrincipalApprovalValidator(
  options: PrincipalApprovalValidatorOptions,
): ValidatorImplementation {
  const approvals = options.approvals;
  return (request: ValidatorRequest): ValidationOutcome => {
    let reading: ApprovalEvidenceReading;
    try {
      reading = approvals.read(request.identity.graphId, request.identity.attemptId);
    } catch (error) {
      return {
        kind: "indeterminate",
        reason:
          "the approval record could not be read (" +
          errorText(error) +
          ") — an unreadable approval is never an approval",
      };
    }
    if (reading.kind === "unavailable") {
      return {
        kind: "indeterminate",
        reason: "the approval record could not be read: " + reading.reason,
      };
    }
    if (reading.kind === "absent") {
      return {
        kind: "fail",
        reason:
          "no approval request is recorded for attempt " +
          JSON.stringify(request.identity.attemptId) +
          ", so a required principal-approval gate is not satisfied — a submission cannot raise or decide one",
      };
    }
    const evidence = reading.evidence;
    switch (evidence.status) {
      case "approved":
        return { kind: "pass" };
      case "rejected":
        return {
          kind: "fail",
          reason:
            "the approver " +
            JSON.stringify(evidence.approverSessionId) +
            " rejected this attempt" +
            (evidence.decisionReason === undefined
              ? ""
              : ": " + evidence.decisionReason),
        };
      case "expired":
        return {
          kind: "fail",
          reason:
            "the approval request for this attempt expired before a decision was recorded, and an expired request is never approved afterwards",
        };
      case "pending":
        return {
          kind: "indeterminate",
          reason:
            "the approval request for this attempt is still pending: the decision has not been taken, so the gate cannot be completed",
        };
    }
  };
}

/**
 * The production approval port: the workspace's own graph store, read through
 * the SAME read-only load verdict every other reader uses.
 *
 * A store this build cannot read is `unavailable` with the verdict named — it
 * is never reported as "no request", because that would turn a damaged store
 * into a missing approval request. An `absent` store is unavailable for the
 * same reason: an acceptance is only reached for a graph whose definition the
 * store holds, so "no store" here is a contradiction, not a fact about the
 * attempt.
 */
export function approvalEvidenceFromStoreRoot(
  storeRoot: string,
): ApprovalEvidenceReader {
  return Object.freeze({
    read(graphId: string, attemptId: string): ApprovalEvidenceReading {
      const loaded = loadGraphStoreSync(storeRoot);
      if (loaded.kind !== "valid") {
        return {
          kind: "unavailable",
          reason: "the graph store is " + loaded.kind,
        };
      }
      const store = loaded.value;
      try {
        const record = store.approvals.readApprovalRequest(graphId, attemptId);
        if (record === undefined) return { kind: "absent" };
        return {
          kind: "found",
          evidence: Object.freeze({
            graphId: record.graphId,
            attemptId: record.attemptId,
            nodeId: record.nodeId,
            status: record.status,
            approverSessionId: record.approverSessionId,
            ...(record.decisionReason === undefined
              ? {}
              : { decisionReason: record.decisionReason }),
            ...(record.decidedAt === undefined ? {} : { decidedAt: record.decidedAt }),
            ...(record.decidedBy === undefined
              ? {}
              : {
                decidedBy: Object.freeze({
                  sessionId: record.decidedBy.sessionId,
                  ...(record.decidedBy.agentId === undefined
                    ? {}
                    : { agentId: record.decidedBy.agentId }),
                }),
              }),
          }),
        };
      } catch (error) {
        return {
          kind: "unavailable",
          reason: "the approval record could not be read (" + errorText(error) + ")",
        };
      } finally {
        store.close();
      }
    },
  });
}

// ── The shipped registry ────────────────────────────────────────────────────

/** Inputs to {@link createShippedAcceptanceValidators}. */
export interface ShippedAcceptanceValidatorOptions {
  /** Root every evidence reference must resolve inside. */
  readonly artifactRoot: string;
  /** The host's approval-evidence port. */
  readonly approvals: ApprovalEvidenceReader;
  /** Schema implementations this host installs. Defaults to the repository's. */
  readonly schemas?: readonly SchemaRegistration[];
  /** Commands this host authorizes. Default: none. */
  readonly commands?: readonly TrustedCommandBinding[];
  /**
   * The immutable content store BOTH retaining primitives deposit validated
   * bytes into (P4 item 5 / A17, A1): the artifact primitive retains the bytes
   * each evidence reference named, and the command primitive retains the
   * revision it re-read after its command finished.
   *
   * Without it the artifact gate still reads and digests, and an accepted result
   * simply carries no retained revision — a refusal downstream, never a re-read
   * of the mutable path. The command gate is STRICTER on purpose: its pass
   * exists to name a revision, so with nowhere to deposit it can never pass and
   * answers `indeterminate`.
   */
  readonly artifactStoreRoot?: string;
}

/**
 * Build the registry the shipped hosts install: the closed set, one
 * implementation per primitive.
 *
 * WHICH HOST CAN SUBSTANTIATE WHICH. The artifact and approval primitives are
 * fully substantiated by every shipped host (a real artifact root, and the
 * durable store above). The schema primitive is installed with the repository's
 * schema implementations, and the command primitive with whatever trusted
 * bindings the operator configured — a mapping without one is refused by that
 * implementation rather than silently passing, and an empty configuration is
 * therefore honest rather than permissive.
 *
 * A registration that cannot be constructed — a malformed binding, or two
 * bindings for one mapping — is a programmer error and throws HERE, at
 * assembly, rather than becoming a validator that always misses. The shipped
 * assembly cannot reach that throw: {@link readTrustedCommandPolicy} reports
 * every malformed entry and every ambiguous mapping as an issue and never
 * hands either to this function.
 */
export function createShippedAcceptanceValidators(
  options: ShippedAcceptanceValidatorOptions,
): ValidatorRegistry {
  const schemas = options.schemas ?? REPOSITORY_SCHEMAS;
  return createValidatorRegistry([
    {
      id: SCHEMA_VALIDATOR_ID,
      version: SCHEMA_VALIDATOR_VERSION,
      implementation: createSchemaValidator(schemas),
      description:
        "resolves the compiled plan's declared data contract and checks the submission payload against the installed schema implementation",
    },
    {
      id: ARTIFACT_VALIDATOR_ID,
      version: ARTIFACT_VALIDATOR_VERSION,
      implementation: createArtifactReferenceValidator({
        ...(options.artifactStoreRoot === undefined
          ? {}
          : { artifactStoreRoot: options.artifactStoreRoot }),
      }),
      description:
        "reads every declared evidence reference inside the artifact root and digests the bytes actually read",
    },
    {
      id: COMMAND_EXIT_VALIDATOR_ID,
      version: COMMAND_EXIT_VALIDATOR_VERSION,
      implementation: createCommandExitValidator({
        commands: options.commands ?? [],
        ...(options.artifactStoreRoot === undefined
          ? {}
          : { artifactStoreRoot: options.artifactStoreRoot }),
      }),
      description:
        "runs the trusted command the host authorized for this exact mapping, in the policy's working directory, against a re-read artifact revision",
    },
    {
      id: PRINCIPAL_APPROVAL_VALIDATOR_ID,
      version: PRINCIPAL_APPROVAL_VALIDATOR_VERSION,
      implementation: createPrincipalApprovalValidator({
        approvals: options.approvals,
      }),
      description:
        "requires the durable approval row of this attempt to have been approved by the authorized approver",
    },
  ]);
}

// ── The shipped host's capability assembly ──────────────────────────────────

/** The environment variable an operator configures trusted commands with. */
export const TRUSTED_COMMAND_POLICY_ENV = "ROLEBOX_GRAPH_COMMAND_CHECKS";

/** Inputs to {@link assembleHostCapabilities}. */
export interface HostCapabilityAssemblyOptions {
  /** Root every evidence reference must resolve inside. */
  readonly artifactRoot: string;
  /** The workspace's authoritative graph store root. */
  readonly storeRoot: string;
  /** The host process's environment (the operator's configuration surface). */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * The one capability assembly both shipped entries perform.
 *
 * It exists so the two hosts cannot drift into two different capability sets,
 * and so the assembly itself is testable without booting a platform: a test
 * calls this function with the same environment a host would read.
 */
export interface HostCapabilityAssembly {
  readonly approvalPolicy?: ApprovalPolicy;
  readonly approvalPolicyIssues: readonly string[];
  /** The FOUR acceptance primitives, installed for this process. */
  readonly validators: ValidatorRegistry;
  /** The completion policies the operator authorized (possibly none). */
  readonly completionPolicies: CompletionPolicyRegistry;
  /** The content-pinned refs that were authorized and installed. */
  readonly authorizedCompletionPolicies: readonly CompletionPolicyRef[];
  /**
   * Every problem with the CONFIGURED declarations and authorizations, in
   * configuration order. Catalog declarations the operator did not authorize
   * are deliberately NOT listed here: they are normal (this repository ships
   * more revisions than most hosts install) and the installed set below already
   * says what was authorized.
   */
  readonly completionPolicyIssues: readonly CompletionPolicyLoadIssue[];
  /** Every configured trusted command that did NOT install. */
  readonly commandPolicyIssues: readonly CommandPolicyIssue[];
  /** How many trusted commands were installed. */
  readonly commandBindings: number;
  /**
   * THE CONCRETE capabilities this assembly installed (A22): the schemas the
   * schema primitive registered, and the exact command mappings a trusted policy
   * authorized.
   *
   * Derived from the SAME values the validator implementations close over, in
   * this one function — so the set a plan is compiled against cannot drift from
   * the set acceptance resolves against. Compilation uses it to refuse a plan
   * whose gates this host could never satisfy, instead of letting it compile
   * `executable` and fail at every submission.
   */
  readonly capabilities: AcceptanceCapabilitySet;
  /** The validators this assembly installed, in registry order. */
  readonly validatorIds: readonly string[];
}

/**
 * Assemble the shipped host's outcome capabilities from its environment.
 *
 * TOTAL: a malformed configuration installs less (or nothing) and reports it;
 * it never throws and never widens the installed set. Compile and run are both
 * handed these two registries, so the capability set a plan is compiled against
 * is the one acceptance resolves against.
 */
export function assembleHostCapabilities(
  options: HostCapabilityAssemblyOptions,
): HostCapabilityAssembly {
  const loaded = loadGraphCompletionPolicies(options.env);
  let approvalPolicy: ApprovalPolicy | undefined;
  const approvalPolicyIssues: string[] = [];
  try {
    const configured = options.env[APPROVAL_POLICY_ENV];
    if (configured !== undefined) approvalPolicy = createApprovalPolicy(JSON.parse(configured));
  } catch {
    approvalPolicyIssues.push("approval policy configuration is invalid; expected an object with id, revision and unambiguous rules");
  }
  const commandPolicy = readTrustedCommandPolicy(options.env[TRUSTED_COMMAND_POLICY_ENV]);
  // THE VALUES BOTH SIDES ARE BUILT FROM, computed once. The validator
  // implementations close over exactly these, and the concrete capability set
  // below is derived from exactly these, so compile and run cannot disagree
  // about what this host can substantiate (A22).
  const schemas = REPOSITORY_SCHEMAS;
  const commands = commandPolicy.bindings;
  const validators = createShippedAcceptanceValidators({
    artifactRoot: options.artifactRoot,
    approvals: approvalEvidenceFromStoreRoot(options.storeRoot),
    schemas,
    commands,
    // The retained-artifact store lives under the graph store root, beside the
    // rows that name which revision was accepted.
    artifactStoreRoot: options.storeRoot,
  });
  return Object.freeze({
    validators,
    approvalPolicy,
    approvalPolicyIssues: Object.freeze(approvalPolicyIssues),
    capabilities: Object.freeze({
      validators: validators.keys,
      approvalMappings: approvalPolicy?.mappings ?? Object.freeze([]),
      schemas: Object.freeze(
        schemas.map((registration) =>
          Object.freeze({
            schema: registration.schema,
            version: registration.version,
          }),
        ),
      ),
      commandMappings: Object.freeze(
        commands.map((binding) =>
          Object.freeze({
            graphId: binding.graphId,
            nodeId: binding.nodeId,
            outcome: binding.outcome,
          }),
        ),
      ),
    }) as AcceptanceCapabilitySet,
    completionPolicies: loaded.registry,
    authorizedCompletionPolicies: loaded.authorized,
    completionPolicyIssues: Object.freeze(
      loaded.issues.filter((issue) => issue.kind !== "not-authorized"),
    ),
    commandPolicyIssues: commandPolicy.issues,
    commandBindings: commandPolicy.bindings.length,
    // DERIVED FROM THE REGISTRY, never a parallel hand-written list: the log's
    // "installed validators" claim now comes from the same keys acceptance
    // resolves against, so a fifth registration cannot make it lie (G5).
    validatorIds: Object.freeze(validators.keys.map((key) => key.id)),
  });
}

/**
 * The validator ids the shipped assembly installs, in registry order.
 *
 * Extension code and tests read the set from HERE rather than restating it, so
 * "what ships" has one owner.
 */
export const SHIPPED_VALIDATOR_IDS: readonly string[] = Object.freeze([
  SCHEMA_VALIDATOR_ID,
  ARTIFACT_VALIDATOR_ID,
  COMMAND_EXIT_VALIDATOR_ID,
  PRINCIPAL_APPROVAL_VALIDATOR_ID,
]);

// ── Helpers ─────────────────────────────────────────────────────────────────

/** A schema's registry key; NUL cannot occur in an identity. */
function schemaKey(schema: string, version: number): string {
  return schema + "\u0000" + String(version);
}

/** A command binding's mapping key; NUL cannot occur in an id. */
function commandMappingKey(mapping: {
  readonly graphId: string;
  readonly nodeId: string;
  readonly outcome: string;
}): string {
  return mapping.graphId + "\u0000" + mapping.nodeId + "\u0000" + mapping.outcome;
}

/** Describe one mapping as a diagnostic token. */
function describeMapping(mapping: {
  readonly graphId: string;
  readonly nodeId: string;
  readonly outcome: string;
}): string {
  return (
    "graph " +
    JSON.stringify(mapping.graphId) +
    " / node " +
    JSON.stringify(mapping.nodeId) +
    " / outcome " +
    JSON.stringify(mapping.outcome)
  );
}

/** A non-empty string, or `undefined`. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Describe a rejected value for a diagnostic without ever throwing. */
function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return typeof value;
}

/** The message of a caught value, without assuming it is an Error. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
