/**
 * The shipped acceptance primitives (P4 item 2) — the closed set.
 *
 * Four primitives, one implementation each, and the property that matters for
 * every one of them: a WORKER cannot make the gate pass by what it submits.
 * The schema comes from the compiled plan, the artifacts are read from the
 * host's root, the command comes from the host's trusted policy, and the
 * approval comes from the durable row the trusted control entry wrote.
 *
 * The command cases run a REAL child process (`process.execPath`, the runtime
 * that is already running this test) in a policy-fixed working directory and
 * assert against files it actually wrote, so "the host's command ran and the
 * submission's command did not" is observed rather than mocked. Every case uses
 * its own mkdtemp directory, removed in afterEach; nothing here writes outside
 * a temp dir.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compileGraph,
  type SupportedValidatorV3,
} from "../../src/graph/compiler/compile.ts";
import type {
  AcceptanceRequirementV3,
  GraphDeclarationV3,
} from "../../src/graph/compiler/declaration-v3.ts";
import type { CompiledPlan } from "../../src/graph/compiler/plan.ts";
import { SqliteAcceptanceLedger } from "../../src/graph/ledger/sqlite-ledger.ts";
import {
  validateSubmission,
  type AcceptanceRequest,
  type SubmissionValidation,
} from "../../src/graph/outcome/acceptance.ts";
import {
  createValidatorRegistry,
  validatorKeyText,
  type ValidatorRegistry,
} from "../../src/graph/outcome/validators.ts";
import {
  GraphDeclareRefusedError,
} from "../../src/graph/tools/declare-graph.ts";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import {
  ARTIFACT_VALIDATOR_ID,
  ARTIFACT_VALIDATOR_VERSION,
  COMMAND_EXIT_VALIDATOR_ID,
  COMMAND_EXIT_VALIDATOR_VERSION,
  HUMAN_APPROVAL_VALIDATOR_ID,
  HUMAN_APPROVAL_VALIDATOR_VERSION,
  SCHEMA_VALIDATOR_ID,
  SCHEMA_VALIDATOR_VERSION,
  SHIPPED_VALIDATOR_IDS,
  approvalEvidenceFromStoreRoot,
  createCommandExitValidator,
  createHumanApprovalValidator,
  createSchemaValidator,
  createShippedAcceptanceValidators,
  readTrustedCommandPolicy,
  type ApprovalEvidenceReader,
  type CommandExitEvidence,
  type SchemaRegistration,
  type TrustedCommandBinding,
} from "../../src/graph/policy/acceptance-primitives.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const GRAPH = "graph.primitives";
const NODE = "worker";
const NOW = 1_700_000_000_000;
const IDENTITY = {
  graphId: GRAPH,
  attemptId: "attempt-1",
  submissionId: "submission-1",
} as const;

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

/** A one-node graph whose `done` outcome carries the given contract/gates. */
function declarationOf(options: {
  readonly acceptance?: readonly AcceptanceRequirementV3[];
  readonly data?: { readonly schema: string; readonly version?: number };
}): GraphDeclarationV3 {
  return {
    version: 3,
    name: GRAPH,
    nodes: [
      {
        id: NODE,
        agent: "agent.worker",
        prompt: "Produce an outcome.",
        outcomes: [
          {
            id: "done",
            ...(options.data === undefined ? {} : { data: options.data }),
            ...(options.acceptance === undefined
              ? {}
              : { acceptance: [...options.acceptance] }),
          },
          { id: "failed" },
        ],
      },
    ],
    edges: [],
  };
}

/** Compile one declaration that must compile, with a useful failure. */
function planOf(
  acceptance: readonly AcceptanceRequirementV3[] | undefined,
  supported: readonly SupportedValidatorV3[],
  data?: { readonly schema: string; readonly version?: number },
): CompiledPlan {
  const result = compileGraph(declarationOf({ acceptance, ...(data === undefined ? {} : { data }) }), {
    supportedValidators: [...supported],
  });
  if (!result.ok) {
    throw new Error(
      "fixture did not compile: " +
        result.errors.map((error) => error.code + "@" + error.path).join(", "),
    );
  }
  return result.plan;
}

/** One registry installing exactly one implementation under one identity. */
function registryOf(
  id: string,
  version: number,
  implementation: Parameters<typeof createValidatorRegistry>[0][number]["implementation"],
): ValidatorRegistry {
  return createValidatorRegistry([{ id, version, implementation }]);
}

/** Validate one proposal against one plan, with the fixture identity. */
function validate(
  plan: CompiledPlan,
  validators: ValidatorRegistry,
  proposal: unknown,
  artifactRoot: string,
  identity: AcceptanceRequest["identity"] = IDENTITY,
): SubmissionValidation {
  return validateSubmission({
    plan,
    submittedPlanRevision: plan.planRevision,
    identity,
    proposal,
    validators,
    artifactRoot,
    now: NOW,
  });
}

/** The single requirement outcome of a validated submission. */
function onlyRequirement(
  validation: SubmissionValidation,
): { readonly kind: string; readonly reason?: string } {
  if (validation.kind !== "validated") {
    throw new Error(
      "fixture: expected a validated submission, got refusals " +
        validation.refusals.map((refusal) => refusal.code).join(", "),
    );
  }
  const entry = validation.decision.requirements[0];
  if (entry === undefined) throw new Error("fixture: expected one requirement");
  return {
    kind: entry.outcome.kind,
    ...(entry.outcome.kind === "pass" ? {} : { reason: entry.outcome.reason }),
  };
}

/** The artifact root the artifact cases read, with one file in it. */
function artifactRootWithReport(dir: string): string {
  const root = join(dir, "artifacts");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "report.txt"), "artifact-bytes");
  return root;
}

/** A bun one-liner that appends a line to `file` and exits with `code`. */
function script(file: string, code: number): string {
  return (
    "require('node:fs').appendFileSync(" +
    JSON.stringify(file) +
    ", 'ran\\n'); process.exit(" +
    String(code) +
    ");"
  );
}

/** A bun one-liner that writes its own working directory to `file`. */
function writeCwdScript(file: string): string {
  return (
    "require('node:fs').writeFileSync(" +
    JSON.stringify(file) +
    ", process.cwd());"
  );
}

/** A bun one-liner that does not finish before a short timeout. */
const SLEEP_SCRIPT = "setTimeout(function () {}, 5000);";

/** One trusted command binding, with overridable fields. */
function bindingOf(
  overrides: Partial<TrustedCommandBinding> = {},
): TrustedCommandBinding {
  return {
    graphId: GRAPH,
    nodeId: NODE,
    outcome: "done",
    argv: [process.execPath, "-e", "process.exit(0);"],
    cwd: tmpdir(),
    timeoutMs: 10_000,
    expectExitCode: 0,
    artifactRefs: ["report.txt"],
    ...overrides,
  };
}

/** A command-exit plan: the outcome requires the primitive at its exact version. */
const COMMAND_REQUIREMENT: AcceptanceRequirementV3 = {
  validator: COMMAND_EXIT_VALIDATOR_ID,
  version: COMMAND_EXIT_VALIDATOR_VERSION,
};
const COMMAND_PLAN = planOf([COMMAND_REQUIREMENT], [COMMAND_REQUIREMENT]);

// ── The closed set ──────────────────────────────────────────────────────────

describe("the shipped acceptance primitives are a closed, code-backed set", () => {
  it("installs exactly schema, artifact, command-exit and human-approval", () => {
    const registry = createShippedAcceptanceValidators({
      artifactRoot: tmpdir(),
      approvals: { read: () => ({ kind: "absent" }) },
    });
    expect(registry.keys.map((key) => validatorKeyText(key))).toEqual([
      SCHEMA_VALIDATOR_ID + "@" + String(SCHEMA_VALIDATOR_VERSION),
      ARTIFACT_VALIDATOR_ID + "@" + String(ARTIFACT_VALIDATOR_VERSION),
      COMMAND_EXIT_VALIDATOR_ID + "@" + String(COMMAND_EXIT_VALIDATOR_VERSION),
      HUMAN_APPROVAL_VALIDATOR_ID + "@" + String(HUMAN_APPROVAL_VALIDATOR_VERSION),
    ]);
    expect(SHIPPED_VALIDATOR_IDS).toHaveLength(4);
    // Every key has a real implementation behind it — not a declaration.
    for (const key of registry.keys) {
      expect(typeof registry.lookup(key)).toBe("function");
    }
  });
});

// ── schema ──────────────────────────────────────────────────────────────────

describe("schema — the plan declares the contract, the payload must satisfy it", () => {
  const SCHEMA = "test.count";
  const countSchema: SchemaRegistration = {
    schema: SCHEMA,
    version: 1,
    validate: (data) => {
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        return { kind: "invalid", reason: "the payload is not a record" };
      }
      return (data as Record<string, unknown>).n === 2
        ? { kind: "valid" }
        : { kind: "invalid", reason: "n must be 2" };
    },
  };
  const REQUIREMENT: AcceptanceRequirementV3 = {
    validator: SCHEMA_VALIDATOR_ID,
    version: SCHEMA_VALIDATOR_VERSION,
  };
  const CONTRACT = { schema: SCHEMA, version: 1 };
  const PLAN = planOf([REQUIREMENT], [REQUIREMENT], CONTRACT);
  const REGISTRY = registryOf(
    SCHEMA_VALIDATOR_ID,
    SCHEMA_VALIDATOR_VERSION,
    createSchemaValidator([countSchema]),
  );

  it("passes only the payload the plan's declared schema accepts", () => {
    const accepted = validate(
      PLAN,
      REGISTRY,
      { nodeId: NODE, outcomeId: "done", data: { n: 2 } },
      tmpdir(),
    );
    expect(onlyRequirement(accepted).kind).toBe("pass");

    const rejected = validate(
      PLAN,
      REGISTRY,
      { nodeId: NODE, outcomeId: "done", data: { n: 3 } },
      tmpdir(),
    );
    expect(onlyRequirement(rejected)).toEqual({
      kind: "fail",
      reason: "n must be 2",
    });
  });

  it("fails an absent payload rather than passing it vacuously", () => {
    const missing = validate(
      PLAN,
      REGISTRY,
      { nodeId: NODE, outcomeId: "done" },
      tmpdir(),
    );
    expect(onlyRequirement(missing).kind).toBe("fail");
  });

  it("fails when the plan declares no data contract at all", () => {
    const contractless = planOf([REQUIREMENT], [REQUIREMENT]);
    const result = validate(
      contractless,
      REGISTRY,
      { nodeId: NODE, outcomeId: "done", data: { n: 2 } },
      tmpdir(),
    );
    expect(onlyRequirement(result).kind).toBe("fail");
  });

  it("is indeterminate for a schema the host does not install, and for an implementation that throws", () => {
    const other = planOf([REQUIREMENT], [REQUIREMENT], {
      schema: "test.not-installed",
      version: 1,
    });
    expect(
      onlyRequirement(
        validate(other, REGISTRY, { nodeId: NODE, outcomeId: "done", data: { n: 2 } }, tmpdir()),
      ).kind,
    ).toBe("indeterminate");

    const throwing = registryOf(
      SCHEMA_VALIDATOR_ID,
      SCHEMA_VALIDATOR_VERSION,
      createSchemaValidator([
        {
          schema: SCHEMA,
          version: 1,
          validate: () => {
            throw new Error("schema implementation blew up");
          },
        },
      ]),
    );
    expect(
      onlyRequirement(
        validate(PLAN, throwing, { nodeId: NODE, outcomeId: "done", data: { n: 2 } }, tmpdir()),
      ).kind,
    ).toBe("indeterminate");
  });

  it("ships a real json-object schema: a record passes, an array does not", () => {
    const jsonObject: AcceptanceRequirementV3 = {
      validator: SCHEMA_VALIDATOR_ID,
      version: SCHEMA_VALIDATOR_VERSION,
    };
    const plan = planOf([jsonObject], [jsonObject], {
      schema: "json-object",
      version: 1,
    });
    const registry = registryOf(
      SCHEMA_VALIDATOR_ID,
      SCHEMA_VALIDATOR_VERSION,
      createSchemaValidator(),
    );
    expect(
      onlyRequirement(
        validate(plan, registry, { nodeId: NODE, outcomeId: "done", data: { any: "record" } }, tmpdir()),
      ).kind,
    ).toBe("pass");
    expect(
      onlyRequirement(
        validate(plan, registry, { nodeId: NODE, outcomeId: "done", data: [1, 2, 3] }, tmpdir()),
      ).kind,
    ).toBe("fail");
  });
});

// ── command exit ────────────────────────────────────────────────────────────

describe("command-exit — the host's command, the host's directory, one artifact revision", () => {
  it("runs the trusted command and ignores the command the submission claims", () => {
    const dir = makeTmpDir("primitive-command-select-");
    const root = artifactRootWithReport(dir);
    const hostMarker = join(dir, "host-command.txt");
    const workerMarker = join(dir, "worker-command.txt");
    const recorded: CommandExitEvidence[] = [];
    const commands = [
      bindingOf({
        argv: [process.execPath, "-e", script(hostMarker, 3)],
        expectExitCode: 0,
        cwd: dir,
      }),
    ];
    const registry = registryOf(
      COMMAND_EXIT_VALIDATOR_ID,
      COMMAND_EXIT_VALIDATOR_VERSION,
      createCommandExitValidator({
        commands,
        onCheck: (evidence) => recorded.push(evidence),
      }),
    );
    // The submission claims a command of its own (one that would exit 0) and a
    // success-shaped payload. Neither is read: the requirement is judged by the
    // host's command, whose exit code is 3.
    const result = validate(
      COMMAND_PLAN,
      registry,
      {
        nodeId: NODE,
        outcomeId: "done",
        data: {
          command: process.execPath + " -e " + script(workerMarker, 0),
          exitCode: 0,
        },
      },
      root,
    );
    expect(onlyRequirement(result).kind).toBe("fail");
    expect(existsSync(hostMarker)).toBe(true);
    expect(existsSync(workerMarker)).toBe(false);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.argv).toEqual(commands[0]?.argv);
    expect(recorded[0]?.exitCode).toBe(3);
    expect(recorded[0]?.verdict).toBe("fail");
  });

  it("runs in the policy's working directory and records the revision it judged", () => {
    const dir = makeTmpDir("primitive-command-cwd-");
    const root = artifactRootWithReport(dir);
    const cwdFile = join(dir, "cwd.txt");
    const recorded: CommandExitEvidence[] = [];
    const registry = registryOf(
      COMMAND_EXIT_VALIDATOR_ID,
      COMMAND_EXIT_VALIDATOR_VERSION,
      createCommandExitValidator({
        commands: [
          bindingOf({
            argv: [process.execPath, "-e", writeCwdScript(cwdFile)],
            cwd: dir,
          }),
        ],
        onCheck: (evidence) => recorded.push(evidence),
      }),
    );
    const result = validate(
      COMMAND_PLAN,
      registry,
      { nodeId: NODE, outcomeId: "done" },
      root,
    );
    expect(onlyRequirement(result).kind).toBe("pass");
    // The command really ran in the policy's directory (the child reports the
    // resolved path, so both sides are resolved before comparing) ...
    expect(realpathSync(readFileSync(cwdFile, "utf8"))).toBe(realpathSync(dir));
    // ... and the recorded evidence names that same directory and revision.
    expect(recorded[0]?.cwd).toBe(dir);
    expect(recorded[0]?.artifactRevisions.map((entry) => entry.ref)).toEqual([
      "report.txt",
    ]);
    expect(recorded[0]?.artifactRevisions[0]?.size).toBe("artifact-bytes".length);
  });

  it("is indeterminate when the bound artifacts move while the command runs", () => {
    const dir = makeTmpDir("primitive-command-revision-");
    const root = artifactRootWithReport(dir);
    const artifact = join(root, "report.txt");
    const registry = registryOf(
      COMMAND_EXIT_VALIDATOR_ID,
      COMMAND_EXIT_VALIDATOR_VERSION,
      createCommandExitValidator({
        commands: [
          bindingOf({
            argv: [
              process.execPath,
              "-e",
              "require('node:fs').appendFileSync(" +
                JSON.stringify(artifact) +
                ", 'mutated');",
            ],
            cwd: dir,
          }),
        ],
      }),
    );
    const result = validate(
      COMMAND_PLAN,
      registry,
      { nodeId: NODE, outcomeId: "done" },
      root,
    );
    // The command exited 0, and it still does not pass: it judged revision A
    // while the artifacts are at revision B.
    expect(onlyRequirement(result).kind).toBe("indeterminate");
  });

  it("is indeterminate for a timeout, a missing program and a mapping with no trusted command", () => {
    const dir = makeTmpDir("primitive-command-limits-");
    const root = artifactRootWithReport(dir);
    const timeout = registryOf(
      COMMAND_EXIT_VALIDATOR_ID,
      COMMAND_EXIT_VALIDATOR_VERSION,
      createCommandExitValidator({
        commands: [
          bindingOf({ argv: [process.execPath, "-e", SLEEP_SCRIPT], timeoutMs: 100, cwd: dir }),
        ],
      }),
    );
    expect(
      onlyRequirement(
        validate(COMMAND_PLAN, timeout, { nodeId: NODE, outcomeId: "done" }, root),
      ).kind,
    ).toBe("indeterminate");

    const missingProgram = registryOf(
      COMMAND_EXIT_VALIDATOR_ID,
      COMMAND_EXIT_VALIDATOR_VERSION,
      createCommandExitValidator({
        commands: [
          bindingOf({ argv: [join(dir, "no-such-program")], cwd: dir }),
        ],
      }),
    );
    expect(
      onlyRequirement(
        validate(COMMAND_PLAN, missingProgram, { nodeId: NODE, outcomeId: "done" }, root),
      ).kind,
    ).toBe("indeterminate");

    // The host authorized a command for a DIFFERENT mapping; this one has none,
    // and "no trusted command" is never treated as "no check needed".
    const otherMapping = registryOf(
      COMMAND_EXIT_VALIDATOR_ID,
      COMMAND_EXIT_VALIDATOR_VERSION,
      createCommandExitValidator({
        commands: [bindingOf({ outcome: "failed", cwd: dir })],
      }),
    );
    expect(
      onlyRequirement(
        validate(COMMAND_PLAN, otherMapping, { nodeId: NODE, outcomeId: "done" }, root),
      ).kind,
    ).toBe("indeterminate");
  });

  it("refuses a DECLARATION that tries to attach a command to a command-exit requirement", () => {
    // The requirement grammar is closed — { validator, version } — so there is
    // no field in which a declaring worker could author the command it is
    // judged by; the front end refuses the unknown key by name.
    const dir = makeTmpDir("primitive-command-declaration-");
    const toolset = createGraphToolSet({
      stateDir: dir,
      outcomeValidators: registryOf(
        COMMAND_EXIT_VALIDATOR_ID,
        COMMAND_EXIT_VALIDATOR_VERSION,
        createCommandExitValidator({
          commands: [bindingOf({ cwd: dir })],
        }),
      ),
    });
    let refusal: unknown;
    try {
      toolset.graph_declare({
        declaration: declarationOf({
          acceptance: [
            {
              validator: COMMAND_EXIT_VALIDATOR_ID,
              version: COMMAND_EXIT_VALIDATOR_VERSION,
              // A smuggled field, not part of the grammar.
              command: "exit 0",
            } as AcceptanceRequirementV3,
          ],
        }),
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(GraphDeclareRefusedError);
    if (refusal instanceof GraphDeclareRefusedError) {
      expect(refusal.reason).toBe("invalid-declaration");
      expect(refusal.diagnostics.map((entry) => entry.code)).toContain(
        "unknown-key",
      );
      expect(refusal.message).toContain("unknown key");
    }
  });

  it("reads the host's command policy from its configuration text, and installs only valid entries", () => {
    const valid = readTrustedCommandPolicy(
      JSON.stringify([
        {
          graph: GRAPH,
          node: NODE,
          outcome: "done",
          argv: [process.execPath, "-e", "process.exit(0);"],
          cwd: tmpdir(),
          timeout_ms: 5000,
          expect_exit_code: 0,
          artifact_refs: ["report.txt"],
        },
      ]),
    );
    expect(valid.issues).toEqual([]);
    expect(valid.bindings).toHaveLength(1);
    expect(valid.bindings[0]?.artifactRefs).toEqual(["report.txt"]);

    // Unset means "no command is authorized", not "any command".
    expect(readTrustedCommandPolicy(undefined).bindings).toEqual([]);
    expect(readTrustedCommandPolicy("").bindings).toEqual([]);
    // Malformed documents and entries are issues; nothing throws.
    expect(readTrustedCommandPolicy("{not json").issues).toHaveLength(1);
    expect(readTrustedCommandPolicy("{}").issues).toHaveLength(1);
    const missingRevision = readTrustedCommandPolicy(
      JSON.stringify([
        {
          graph: GRAPH,
          node: NODE,
          outcome: "done",
          argv: ["/bin/true"],
          cwd: tmpdir(),
          timeout_ms: 5000,
          expect_exit_code: 0,
        },
      ]),
    );
    expect(missingRevision.bindings).toEqual([]);
    expect(missingRevision.issues[0]?.index).toBe(0);
  });
});

// ── human approval ──────────────────────────────────────────────────────────

describe("human-approval — the durable row decides, never the submission", () => {
  const REQUIREMENT: AcceptanceRequirementV3 = {
    validator: HUMAN_APPROVAL_VALIDATOR_ID,
    version: HUMAN_APPROVAL_VALIDATOR_VERSION,
  };
  const PLAN = planOf([REQUIREMENT], [REQUIREMENT]);

  function withStatus(
    reader: ApprovalEvidenceReader,
  ): ValidatorRegistry {
    return registryOf(
      HUMAN_APPROVAL_VALIDATOR_ID,
      HUMAN_APPROVAL_VALIDATOR_VERSION,
      createHumanApprovalValidator({ approvals: reader }),
    );
  }

  it("passes only an approved row, and names the deciding approver on a rejection", () => {
    const approved = withStatus({
      read: () => ({
        kind: "found",
        evidence: {
          graphId: GRAPH,
          attemptId: IDENTITY.attemptId,
          nodeId: NODE,
          status: "approved",
          approverSessionId: "session.approver",
          decidedBy: { sessionId: "session.approver" },
          decidedAt: NOW - 1,
        },
      }),
    });
    expect(
      onlyRequirement(
        validate(PLAN, approved, { nodeId: NODE, outcomeId: "done" }, tmpdir()),
      ).kind,
    ).toBe("pass");

    const rejected = withStatus({
      read: () => ({
        kind: "found",
        evidence: {
          graphId: GRAPH,
          attemptId: IDENTITY.attemptId,
          nodeId: NODE,
          status: "rejected",
          approverSessionId: "session.approver",
          decisionReason: "the evidence is not sufficient",
        },
      }),
    });
    const outcome = onlyRequirement(
      validate(PLAN, rejected, { nodeId: NODE, outcomeId: "done" }, tmpdir()),
    );
    expect(outcome.kind).toBe("fail");
    expect(outcome.reason).toContain("session.approver");
    expect(outcome.reason).toContain("the evidence is not sufficient");
  });

  it("fails a rejected or expired request and is indeterminate while pending", () => {
    for (const status of ["rejected", "expired"] as const) {
      const registry = withStatus({
        read: () => ({
          kind: "found",
          evidence: {
            graphId: GRAPH,
            attemptId: IDENTITY.attemptId,
            nodeId: NODE,
            status,
            approverSessionId: "session.approver",
          },
        }),
      });
      expect(
        onlyRequirement(
          validate(PLAN, registry, { nodeId: NODE, outcomeId: "done" }, tmpdir()),
        ).kind,
      ).toBe("fail");
    }
    const pending = withStatus({
      read: () => ({
        kind: "found",
        evidence: {
          graphId: GRAPH,
          attemptId: IDENTITY.attemptId,
          nodeId: NODE,
          status: "pending",
          approverSessionId: "session.approver",
        },
      }),
    });
    expect(
      onlyRequirement(
        validate(PLAN, pending, { nodeId: NODE, outcomeId: "done" }, tmpdir()),
      ).kind,
    ).toBe("indeterminate");
  });

  it("refuses a submission that claims approval in its own payload, and an unreadable store", () => {
    const absent = withStatus({ read: () => ({ kind: "absent" }) });
    const result = validate(
      PLAN,
      absent,
      { nodeId: NODE, outcomeId: "done", data: { approved: true, approvedBy: "me" } },
      tmpdir(),
    );
    expect(onlyRequirement(result).kind).toBe("fail");

    const unavailable = withStatus({
      read: () => ({ kind: "unavailable", reason: "the graph store is corrupt" }),
    });
    expect(
      onlyRequirement(
        validate(PLAN, unavailable, { nodeId: NODE, outcomeId: "done" }, tmpdir()),
      ).kind,
    ).toBe("indeterminate");

    const throwing = withStatus({
      read: () => {
        throw new Error("store went away");
      },
    });
    expect(
      onlyRequirement(
        validate(PLAN, throwing, { nodeId: NODE, outcomeId: "done" }, tmpdir()),
      ).kind,
    ).toBe("indeterminate");
  });

  it("reads the durable store: an absent request is a fail, an unreadable store is not 'no request'", async () => {
    const dir = makeTmpDir("primitive-approval-store-");
    const ledger = await SqliteAcceptanceLedger.create(dir);
    ledger.close();
    const reader = approvalEvidenceFromStoreRoot(dir);
    expect(reader.read(GRAPH, IDENTITY.attemptId)).toEqual({ kind: "absent" });
    const missing = approvalEvidenceFromStoreRoot(join(dir, "no-such-store"));
    expect(missing.read(GRAPH, IDENTITY.attemptId).kind).toBe("unavailable");
  });
});
