/**
 * Cross-process worker fixture for the P4.2 input-binding evidence (criterion 3).
 *
 * Version: 1.0
 * Date: 2026-09-25
 *
 * WHY THIS FILE EXISTS. Criterion 3 requires that a NEW OS PROCESS recovers a
 * successor's persisted input binding and continues its dispatch. Closing and
 * reopening the runtime in one process is not that boundary: the in-process
 * regression (`tests/graph/runtime-input-binding.test.ts`) proves the recovery
 * RULE, and this fixture proves the process BOUNDARY. The parent
 * (`tests/graph/input-binding-cross-process.test.ts`) arranges the crash window
 * — an accepted producer result with a retained revision, and a successor whose
 * dispatch effect is committed `pending` because its create threw before
 * delivery — and then spawns THIS file with `Bun.spawn(process.execPath, …)`,
 * the pattern `tests/graph/host-restart-cross-process.test.ts` established.
 * Every mode opens its OWN connection to the one store file under an OS temp
 * directory: no `.rolebox` path, no workspace store, and nothing from the
 * parent's memory is reachable from here.
 *
 * THE CREDENTIAL STORE IS `platform-isolated`, AND THAT IS AN ASSERTION, NOT A
 * PROOF. Re-delivering an attempt this process never minted needs the value to
 * be resolvable here, and the shipped default (`"none"`) deliberately retains
 * none. Declaring `platform-isolated` is the host's claim about an OS boundary
 * the test process cannot provide; this fixture exercises the BINDING and the
 * CONSUMPTION, never vault isolation.
 *
 *     bun tests/graph/helpers/input-binding-xproc-worker.ts --mode resume --root <dir>
 *
 * One JSON line on stdout is the parent's evidence, and its `pid` is the parent's
 * proof that the work happened in a different OS process.
 *
 * PRIVACY: store roots are OS temp directories, and every report carries ids,
 * digests, counts and booleans — never a credential value.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { GraphDeclarationV3 } from "../../../src/graph/compiler/declaration-v3.ts";
import { HostCredentialVault } from "../../../src/graph/host/credential-vault.ts";
import {
  INPUT_DELIVERY_DIR,
  materializeInputView,
  type InputViewMaterialization,
} from "../../../src/graph/host/input-view.ts";
import { SqliteAcceptanceLedger } from "../../../src/graph/ledger/sqlite-ledger.ts";
import type { AttemptCredentialSource } from "../../../src/graph/outcome/attempt-credential.ts";
import type { CredentialIsolationAdapterV3 } from "../../../src/graph/outcome/credential-isolation.ts";
import type {
  OutcomeDispatchAdapter,
  OutcomeDispatchHost,
  OutcomeDispatchRequest,
} from "../../../src/graph/outcome/dispatch-effects.ts";
import { readResolvedArtifact, type ResolvedInput } from "../../../src/graph/outcome/inputs.ts";
import { OutcomeGraphRuntime } from "../../../src/graph/outcome/runtime.ts";
import {
  ARTIFACT_REFERENCE_VALIDATOR_ID,
  ARTIFACT_REFERENCE_VALIDATOR_VERSION,
  createArtifactReferenceValidator,
  createValidatorRegistry,
  type ValidatorRegistry,
} from "../../../src/graph/outcome/validators.ts";
import { digestOf, readArtifactById } from "../../../src/graph/store/artifacts.ts";
import {
  buildDeclaredOutcomeGraph,
  type DeclaredOutcomeGraph,
} from "../../../src/graph/tools/declare-graph.ts";

// ── The one graph this fixture drives ───────────────────────────────────────

/** The graph every case uses: `work -> review`, and review consumes work's done. */
export const INPUT_BINDING_GRAPH_NAME = "p42.input-binding-xproc";

/** The one reference both processes read. */
export const INPUT_BINDING_REF = "evidence/report.json";

/** The revisions: A is accepted and retained, B replaces the mutable path. */
export const INPUT_BINDING_A = Buffer.from("{revision:A}", "utf-8");
export const INPUT_BINDING_B = Buffer.from("{revision:B}", "utf-8");

/** The fixture clock every process uses, so nothing depends on wall time. */
export const INPUT_BINDING_NOW = 1_700_000_000_000;

/** The producer attempt the acceptance settles. */
export const INPUT_BINDING_PRODUCER = "work#1";
/** The successor attempt the acceptance arms with the bound view. */
export const INPUT_BINDING_SUCCESSOR = "review#2";

const GATE = {
  validator: ARTIFACT_REFERENCE_VALIDATOR_ID,
  version: ARTIFACT_REFERENCE_VALIDATOR_VERSION,
} as const;

/**
 * A deterministic credential source, so both processes spell the same value and
 * the durable row the parent writes is the one the child resolves.
 */
export const INPUT_BINDING_CREDENTIAL_SOURCE: AttemptCredentialSource = (binding) =>
  "binding-credential:" + binding.nodeId + "#" + binding.attemptId;

/** The declaration both processes compile — the plan is code, the binding is state. */
export function inputBindingDeclaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: INPUT_BINDING_GRAPH_NAME,
    nodes: [
      {
        id: "work",
        agent: "agent.work",
        prompt: "Do the work.",
        outcomes: [{ id: "done", acceptance: [GATE] }],
      },
      {
        id: "review",
        agent: "agent.review",
        prompt: "Review the work.",
        outcomes: [{ id: "checked" }],
        inputs: [{ from: "work", outcome: "done" }],
      },
    ],
    edges: [{ from: "work", to: "review", outcome: "done" }],
  };
}

/** The compiled plan, the installed gate and the workspace root one store has. */
export interface InputBindingFixture {
  readonly declared: DeclaredOutcomeGraph;
  readonly validators: ValidatorRegistry;
  /** The root the proposal's evidence reference resolves inside. */
  readonly artifactRoot: string;
}

/**
 * Build the fixture over one store root.
 *
 * BOTH processes call this with the same root, so the child rebuilds the SAME
 * plan revision the parent's state is bound to — a child that compiled anything
 * else would be refused by the state reader instead of continuing the run.
 */
export function inputBindingFixture(root: string): InputBindingFixture {
  const artifactRoot = join(root, "workspace");
  const validators = createValidatorRegistry([
    {
      id: ARTIFACT_REFERENCE_VALIDATOR_ID,
      version: ARTIFACT_REFERENCE_VALIDATOR_VERSION,
      implementation: createArtifactReferenceValidator({ artifactStoreRoot: root }),
    },
  ]);
  const declared = buildDeclaredOutcomeGraph({
    declaration: inputBindingDeclaration(),
    installedValidators: validators,
    installedAcceptanceCapabilities: {
      validators: validators.keys,
      schemas: [],
      commandMappings: [],
    },
  });
  return { declared, validators, artifactRoot };
}

/** Open the host credential vault the test process and its child both use. */
export function openInputBindingVault(root: string): HostCredentialVault {
  return HostCredentialVault.open({
    root,
    id: "test-host:credential-vault",
    durableCredentialStore: "platform-isolated",
  });
}

/** Build one runtime over the fixture and one ledger connection. */
export function inputBindingRuntime(options: {
  readonly ledger: SqliteAcceptanceLedger;
  readonly fixture: InputBindingFixture;
  readonly dispatch: OutcomeDispatchAdapter;
  readonly isolation: CredentialIsolationAdapterV3;
}): OutcomeGraphRuntime {
  return new OutcomeGraphRuntime({
    plan: options.fixture.declared.plan,
    ledger: options.ledger,
    dispatch: options.dispatch,
    validators: options.fixture.validators,
    artifactRoot: options.fixture.artifactRoot,
    clock: () => INPUT_BINDING_NOW,
    mintCredential: INPUT_BINDING_CREDENTIAL_SOURCE,
    credentialIsolation: options.isolation,
  });
}

/** The mutable source path the proposal's reference names inside one store root. */
export function inputBindingSourcePath(root: string): string {
  return join(root, "workspace", "evidence", "report.json");
}

/** Write the workspace tree and one revision at the source path. */
export function writeInputBindingSource(root: string, bytes: Buffer): void {
  const path = inputBindingSourcePath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

// ── Argument access ─────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

/** The value of `--name`, or undefined. */
function arg(name: string): string | undefined {
  const index = argv.indexOf("--" + name);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** The value of `--name`, refused when absent or empty. */
function required(name: string): string {
  const value = arg(name);
  if (value === undefined || value.length === 0) {
    throw new Error("input-binding-xproc-worker: --" + name + " is required");
  }
  return value;
}

/** Print the one JSON result line. `pid` is the parent's evidence of a REAL process. */
function emit(payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ pid: process.pid, ...payload }) + "\n");
}

// ── Modes ───────────────────────────────────────────────────────────────────

/** The digest of the file a materialized view points at, or null. */
function materializedFileDigest(materialized: InputViewMaterialization): string | null {
  if (materialized.kind !== "ready") return null;
  const file = materialized.view.entries[0]?.artifacts[0];
  if (file === undefined) return null;
  return digestOf(readFileSync(file.path));
}

/**
 * `--mode resume`: a FRESH process rebuilds the runtime from the persisted state
 * and continues the dispatch it finds, with no re-acceptance and no re-selection
 * of the mutable source path.
 */
async function modeResume(): Promise<Record<string, unknown>> {
  const root = required("root");
  // THE PARENT'S OWN BYTES: the binding it persisted for this successor, written
  // by the parent before this process started. Comparing against the file — not
  // against a value this process decoded — is what makes the equality a
  // cross-process one.
  const expectedText = readFileSync(required("expected-binding"), "utf8");
  const fixture = inputBindingFixture(root);
  const ledger = await SqliteAcceptanceLedger.create(root);
  const vault = openInputBindingVault(root);
  try {
    const creates: OutcomeDispatchRequest[] = [];
    const dispatch: OutcomeDispatchHost = {
      create: (request: OutcomeDispatchRequest): void => {
        // The request, WITH ITS BOUND INPUT VIEW, is what a host would hand a
        // worker; recording it is this fixture's delivery.
        creates.push(request);
      },
      lookup: () => ({ kind: "absent" }),
    };
    const runtime = inputBindingRuntime({
      ledger,
      fixture,
      dispatch,
      isolation: vault.capability(),
    });

    // THE PERSISTED STATE IS READ FIRST: this is the binding the arming process
    // committed, read back by a process that never held it in memory.
    const state = runtime.state();
    if (state === undefined) throw new Error("the store holds no graph state");
    const successor = state.nodes.find((node) => node.nodeId === "review");
    if (successor === undefined) throw new Error("the persisted state names no review node");
    const persistedBinding: readonly ResolvedInput[] | undefined = successor.inputs;
    if (persistedBinding === undefined) {
      throw new Error("the persisted successor carries no bound input view");
    }

    const resumed = runtime.resume(INPUT_BINDING_NOW + 2);
    if (resumed.kind === "refused") {
      throw new Error("the resume was refused: " + JSON.stringify(resumed.refusals));
    }
    const delivered = creates.find(
      (request) => request.attemptId === INPUT_BINDING_SUCCESSOR,
    );
    if (delivered === undefined) {
      throw new Error(
        "the successor was not re-dispatched (attempts: " +
          creates.map((request) => request.attemptId).join(", ") +
          ")",
      );
    }
    const deliveredBinding: readonly ResolvedInput[] | undefined = delivered.inputs;
    if (deliveredBinding === undefined) {
      throw new Error("the re-dispatched successor carried no bound input view");
    }

    // THE ONE ADDRESS RULE the delivery side applies, exercised from here.
    const read = readResolvedArtifact(
      deliveredBinding,
      { from: "work", ref: INPUT_BINDING_REF },
      (artifactId) => readArtifactById(root, artifactId),
    );
    // AND THE VIEW A WORKER WOULD ACTUALLY BE HANDED, materialized in THIS
    // process from the binding this process recovered.
    const materialized = materializeInputView({
      contentStoreRoot: root,
      deliveryRoot: join(root, INPUT_DELIVERY_DIR),
      graphId: runtime.graphId,
      attemptId: INPUT_BINDING_SUCCESSOR,
      inputs: deliveredBinding,
    });

    return {
      graphId: runtime.graphId,
      planRevision: runtime.planRevision,
      resumeKind: resumed.kind,
      dispatchedAttempts: creates.map((request) => request.attemptId),
      resumedAttempts: resumed.dispatched.map((request) => request.attemptId),
      successorAttemptId: successor.attemptId ?? null,
      persistedBinding,
      deliveredBinding,
      // BOTH SPELLED BY THIS PROCESS, so their equality is a byte comparison of
      // one value rather than a structural guess across the boundary.
      persistedBindingJson: JSON.stringify(persistedBinding),
      deliveredBindingJson: JSON.stringify(deliveredBinding),
      // BYTE-EQUAL TO WHAT THE PARENT PERSISTED, on both the recovered and the
      // re-dispatched value.
      persistedMatchesParentBytes: JSON.stringify(persistedBinding) === expectedText,
      deliveredMatchesParentBytes: JSON.stringify(deliveredBinding) === expectedText,
      deliveredArtifactDigest: read.kind === "read" ? read.digest : null,
      deliveredArtifactProblem: read.kind === "problem" ? read.reason : null,
      sourceDigest: digestOf(readFileSync(inputBindingSourcePath(root))),
      acceptedEvents: ledger.acceptedEvents(runtime.graphId).length,
      materializationKind: materialized.kind,
      materializedFileDigest: materializedFileDigest(materialized),
      materializedProblems:
        materialized.kind === "refused"
          ? materialized.refusals.map((refusal) => refusal.code)
          : [],
    };
  } finally {
    vault.close();
    ledger.close();
  }
}

// ── Entry ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const mode = required("mode");
  if (mode !== "resume") {
    throw new Error("input-binding-xproc-worker: unknown --mode " + JSON.stringify(mode));
  }
  emit({ ok: true, mode, ...(await modeResume()) });
}

// Imported by the parent for its fixtures; only run when executed as a script.
if (import.meta.main) {
  main().catch((error: unknown) => {
    emit({
      ok: false,
      mode: arg("mode") ?? "unknown",
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}
