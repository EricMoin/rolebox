/**
 * Natural-completion authorization (D6).
 *
 * Covers the four outcomes of the draft rule table end to end, plus the
 * machinery they stand on:
 *
 * 1. a declaration that REQUESTS natural completion without a usable policy
 *    revision compiles to a NON-EXECUTABLE DRAFT naming the mapping and the
 *    stable reason — never to an executable plan and never to an \`explicit\`
 *    downgrade;
 * 2. a policy that EXPLICITLY denies the mapping is a compile refusal
 *    (\`completion-policy-denied\`), distinct from "not authorized yet";
 * 3. a policy that GRANTS the mapping with the acceptance capability complete
 *    produces an executable plan that PINS the authorization, the policy body
 *    and that body's identity — all inside the plan body, so the record
 *    round-trips without loss;
 * 4. a PERSISTED executable plan whose policy this process does not hold is
 *    BLOCKED at recovery (and at every other run-path entry) with the state
 *    left exactly as it was.
 *
 * It also covers the authority rules the table depends on: the host's
 * content-pinned authorization list decides what is installed, a declaration
 * cannot smuggle rules, a policy that merely exists in the repository is not an
 * authorization, and the installed capability is never trusted to match a
 * pinned digest it does not hash to.
 *
 * Every filesystem case runs in its own mkdtemp directory and removes it in an
 * afterEach; the test file writes nothing outside a temp dir.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import { compileGraph } from "../../src/graph/compiler/compile.ts";
import {
  createPersistedCompiledPlan,
  readPlanExecutability,
  type CompiledPlan,
} from "../../src/graph/compiler/plan.ts";
import { parseGraphDeclarationV3 } from "../../src/graph/compiler/parse-declaration-v3.ts";
import {
  completionPolicyRefOf,
  createCompletionPolicyRegistry,
  decideCompletion,
  loadCompletionPolicies,
  readCompletionPolicyBody,
  resolveCompletionPolicy,
  verifyCompletionPolicy,
  type CompletionPolicyBody,
  type CompletionPolicyRef,
  type CompletionPolicyRegistry,
} from "../../src/graph/policy/completion-policy.ts";
import {
  REPOSITORY_COMPLETION_POLICIES,
  REPOSITORY_COMPLETION_POLICY_ID,
  type RepositoryCompletionPolicyDeclaration,
} from "../../src/graph/policy/declarations.ts";
import { engineStateDir, verifyPersistedCompiledPlan } from "../../src/graph/engine/engine-persistence.ts";
import { SqliteAcceptanceLedger } from "../../src/graph/ledger/sqlite-ledger.ts";
import { OutcomeGraphRuntime } from "../../src/graph/outcome/runtime.ts";
import { resumePersistedOutcomeGraph } from "../../src/graph/outcome/recovery.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
import {
  GraphDeclareRefusedError,
  buildDeclaredOutcomeGraph,
} from "../../src/graph/tools/declare-graph.ts";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { testHostCredentialIsolation } from "./helpers/credential-isolation.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const POLICY_ID = "test.natural-completion";
const POLICY_REVISION = "1";
const GRAPH_ID = "flow.natural";

/** The one mapping the granting policy authorizes. */
const GRANT_BODY: CompletionPolicyBody = {
  version: 1,
  default: "ungranted",
  rules: [
    {
      graphId: GRAPH_ID,
      nodeId: "ship",
      outcome: "shipped",
      decision: "allow",
    },
  ],
};

/** A policy that explicitly denies every mapping it does not list. */
const DENY_BODY: CompletionPolicyBody = {
  version: 1,
  default: "deny",
  rules: [],
};

/** A policy that grants nothing and forbids nothing. */
const UNGRANTED_BODY: CompletionPolicyBody = {
  version: 1,
  default: "ungranted",
  rules: [],
};

function refOf(body: CompletionPolicyBody, revision = POLICY_REVISION): CompletionPolicyRef {
  return completionPolicyRefOf({ id: POLICY_ID, revision, body });
}

function registryOf(
  ...bodies: readonly (readonly [CompletionPolicyBody, string])[]
): CompletionPolicyRegistry {
  return createCompletionPolicyRegistry({
    policies: bodies.map(([body, revision]) => ({
      ref: refOf(body, revision),
      body,
    })),
  });
}

const AUTHORIZED = registryOf([GRANT_BODY, POLICY_REVISION]);
/** The same authorization with different policy content: a different identity. */
const GRANT_BODY_ALT: CompletionPolicyBody = { ...GRANT_BODY, default: "deny" };
const AUTHORIZED_ALT = registryOf([GRANT_BODY_ALT, POLICY_REVISION]);
const DENYING = registryOf([DENY_BODY, POLICY_REVISION]);
const UNGRANTED = registryOf([UNGRANTED_BODY, POLICY_REVISION]);
const OTHER_REVISION = registryOf([GRANT_BODY, "2"]);
const OTHER_ID = createCompletionPolicyRegistry({
  policies: [
    {
      ref: completionPolicyRefOf({
        id: "test.other-policy",
        revision: POLICY_REVISION,
        body: GRANT_BODY,
      }),
      body: GRANT_BODY,
    },
  ],
});
/** The same identity, republished with different content. */
const REPUBLISHED = registryOf([{ ...UNGRANTED_BODY }, POLICY_REVISION]);

/**
 * work --done--> ship, where ship completes NATURALLY into "shipped" and the
 * graph requests {@link POLICY_ID}@1.
 */
function naturalDeclaration(
  overrides: Partial<GraphDeclarationV3> = {},
): GraphDeclarationV3 {
  return {
    version: 3,
    name: GRAPH_ID,
    nodes: [
      {
        id: "work",
        agent: "agent.work",
        prompt: "Do the work.",
        outcomes: [{ id: "done" }],
      },
      {
        id: "ship",
        agent: "agent.ship",
        prompt: "Ship it.",
        outcomes: [{ id: "shipped" }],
        completion: { mode: "natural", outcome: "shipped" },
      },
    ],
    edges: [{ from: "work", to: "ship", outcome: "done" }],
    completion_policy: { id: POLICY_ID, revision: POLICY_REVISION },
    ...overrides,
  };
}

/** A draft's unauthorized-completion reasons, failing when it is not a draft. */
function unauthorizedOf(result: ReturnType<typeof compileGraph>) {
  if (!result.ok) {
    throw new Error(
      "expected a compilation result, got errors: " +
        result.errors.map((error) => error.code).join(", "),
    );
  }
  if (result.kind !== "draft") {
    throw new Error("expected a non-executable draft, got " + result.kind);
  }
  return result.unauthorizedCompletions;
}

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

// ── The declaration shape and the installed capability ──────────────────────

describe("completion-policy declarations", () => {
  it("reads the closed shape and refuses an extra key, a duplicate mapping and an unknown version", () => {
    expect(readCompletionPolicyBody(GRANT_BODY)).toEqual(GRANT_BODY);
    // An own key the reader does not copy would still be part of an authorized
    // digest, so the reader refuses the whole declaration instead of narrowing it.
    expect(
      readCompletionPolicyBody({ ...GRANT_BODY, extra: true }),
    ).toBeUndefined();
    expect(
      readCompletionPolicyBody({
        version: 1,
        default: "ungranted",
        rules: [
          { graphId: "g", nodeId: "n", outcome: "o", decision: "allow" },
          { graphId: "g", nodeId: "n", outcome: "o", decision: "deny" },
        ],
      }),
    ).toBeUndefined();
    expect(
      readCompletionPolicyBody({ ...GRANT_BODY, version: 2 }),
    ).toBeUndefined();
    expect(
      readCompletionPolicyBody({
        version: 1,
        default: "maybe",
        rules: [],
      }),
    ).toBeUndefined();
    expect(
      readCompletionPolicyBody({
        version: 1,
        default: "ungranted",
        rules: [
          { graphId: "g", nodeId: "n", outcome: "o", decision: "maybe" },
        ],
      }),
    ).toBeUndefined();
  });

  it("decides an exact mapping and falls back to the declared default", () => {
    const mapping = { graphId: GRAPH_ID, nodeId: "ship", outcome: "shipped" };
    expect(decideCompletion(GRANT_BODY, mapping).kind).toBe("allowed");
    expect(decideCompletion(DENY_BODY, mapping).kind).toBe("denied");
    expect(decideCompletion(UNGRANTED_BODY, mapping).kind).toBe("undecided");
    // Exact matching: a different graph, node or outcome never matches.
    expect(
      decideCompletion(GRANT_BODY, { ...mapping, outcome: "shipped-later" }).kind,
    ).toBe("undecided");
  });

  it("resolves by exact identity and never falls back to another revision", () => {
    const request = { id: POLICY_ID, revision: POLICY_REVISION };
    expect(resolveCompletionPolicy(request, AUTHORIZED).kind).toBe("resolved");
    expect(
      resolveCompletionPolicy({ id: "test.absent", revision: "1" }, AUTHORIZED),
    ).toEqual({ kind: "unknown-policy", id: "test.absent" });
    expect(resolveCompletionPolicy({ id: POLICY_ID, revision: "9" }, AUTHORIZED)).toEqual({
      kind: "unknown-revision",
      request: { id: POLICY_ID, revision: "9" },
    });
    // A pinned ref is re-hashed, never trusted: the same identity with other
    // content is a digest mismatch.
    expect(
      verifyCompletionPolicy(refOf(UNGRANTED_BODY), AUTHORIZED),
    ).toMatchObject({ kind: "digest-mismatch" });
    expect(verifyCompletionPolicy(refOf(GRANT_BODY), AUTHORIZED).kind).toBe(
      "resolved",
    );
  });

  it("rejects a registry whose body does not hash to its ref, or repeats an identity", () => {
    expect(() =>
      createCompletionPolicyRegistry({
        policies: [{ ref: refOf(UNGRANTED_BODY), body: GRANT_BODY }],
      }),
    ).toThrow(/hashes to/);
    expect(() =>
      createCompletionPolicyRegistry({
        policies: [
          { ref: refOf(GRANT_BODY), body: GRANT_BODY },
          { ref: refOf(GRANT_BODY), body: GRANT_BODY },
        ],
      }),
    ).toThrow(/duplicate policy/);
    // A body this build cannot read is refused by the READER (the factory's own
    // guard for an untyped caller) and by the host loader below.
    expect(readCompletionPolicyBody({ version: 1 })).toBeUndefined();
  });
});

// ── The host decides what is installed ──────────────────────────────────────

describe("loadCompletionPolicies — the host decides, the digest proves", () => {
  it("installs an authorized, digest-matching declaration and reports the rest", () => {
    const result = loadCompletionPolicies({
      catalog: [
        { id: POLICY_ID, revision: POLICY_REVISION, body: GRANT_BODY },
        { id: POLICY_ID, revision: "9", body: UNGRANTED_BODY },
      ],
      authorized: [refOf(GRANT_BODY)],
    });
    expect(result.registry.policies).toHaveLength(1);
    expect(result.registry.policies[0]?.body).toEqual(GRANT_BODY);
    // The catalog entry the host did not authorize is REPORTED, never installed.
    expect(result.issues).toEqual([
      { kind: "not-authorized", id: POLICY_ID, revision: "9" },
    ]);
  });

  it("refuses a tampered body, a missing catalog entry and a contradictory authorization", () => {
    const tampered = loadCompletionPolicies({
      catalog: [{ id: POLICY_ID, revision: POLICY_REVISION, body: UNGRANTED_BODY }],
      authorized: [refOf(GRANT_BODY)],
    });
    expect(tampered.registry.policies).toEqual([]);
    expect(tampered.issues[0]?.kind).toBe("digest-mismatch");

    const missing = loadCompletionPolicies({
      catalog: [],
      authorized: [refOf(GRANT_BODY)],
    });
    expect(missing.registry.policies).toEqual([]);
    expect(missing.issues[0]?.kind).toBe("catalog-missing");

    const malformed = loadCompletionPolicies({
      catalog: [
        { id: POLICY_ID, revision: POLICY_REVISION, body: { version: 1 } },
      ],
      authorized: [refOf({ ...GRANT_BODY })],
    });
    expect(malformed.registry.policies).toEqual([]);
    expect(malformed.issues[0]?.kind).toBe("malformed-policy");

    const conflicting = loadCompletionPolicies({
      catalog: [{ id: POLICY_ID, revision: POLICY_REVISION, body: GRANT_BODY }],
      authorized: [refOf(GRANT_BODY), refOf(UNGRANTED_BODY)],
    });
    expect(conflicting.registry.policies).toEqual([]);
    expect(conflicting.issues[0]?.kind).toBe("conflicting-authorization");
  });

  it("ships two repository revisions that mean opposite things, and loads one only when authorized", () => {
    const shipped = REPOSITORY_COMPLETION_POLICIES;
    expect(shipped.map((entry) => entry.revision)).toEqual(["1", "2"]);
    const rev1 = shipped.find((entry) => entry.revision === "1");
    const rev2 = shipped.find((entry) => entry.revision === "2");
    if (rev1 === undefined || rev2 === undefined) {
      throw new Error("the repository must ship revisions 1 and 2");
    }
    expect(rev1.body.default).toBe("ungranted");
    expect(rev2.body.default).toBe("deny");

    // Unauthorized: the declaration EXISTS in the repository and is still not
    // installed — a file being present is not authority.
    const unauthorized = loadCompletionPolicies({
      catalog: shipped,
      authorized: [],
    });
    expect(unauthorized.registry.policies).toEqual([]);
    expect(unauthorized.issues).toHaveLength(2);

    // Authorized with the digest computed from the reviewed body: installed.
    const authorized = loadCompletionPolicies({
      catalog: shipped,
      authorized: [completionPolicyRefOf(rev1)],
    });
    expect(authorized.registry.policies).toHaveLength(1);
    expect(authorized.registry.policies[0]?.ref.id).toBe(
      REPOSITORY_COMPLETION_POLICY_ID,
    );
    // A body edited after review no longer matches the authorized digest.
    const edited: RepositoryCompletionPolicyDeclaration = {
      ...rev1,
      body: { ...rev1.body, default: "deny" },
    };
    const tampered = loadCompletionPolicies({
      catalog: [edited],
      authorized: [completionPolicyRefOf(rev1)],
    });
    expect(tampered.registry.policies).toEqual([]);
    expect(tampered.issues[0]?.kind).toBe("digest-mismatch");
  });
});

// ── The draft rule table ────────────────────────────────────────────────────

describe("compileGraph — natural completion authorization (the draft rule table)", () => {
  it("row 1: a request with no installed capability is a DRAFT, never an explicit downgrade", () => {
    const result = compileGraph(naturalDeclaration());
    const reasons = unauthorizedOf(result);
    expect(reasons).toEqual([
      {
        nodeId: "ship",
        outcome: "shipped",
        code: "completion-policy-unavailable",
        request: { id: POLICY_ID, revision: POLICY_REVISION },
      },
    ]);
    // The node's declared policy SURVIVES: the plan does not rewrite natural
    // completion into explicit to make itself look runnable.
    if (!result.ok) throw new Error("expected a draft plan, not errors");
    const ship = result.plan.nodes.find((node) => node.id === "ship");
    expect(ship?.completion).toEqual({ mode: "natural", outcome: "shipped" });
    expect(result.plan.completionAuthorizations).toEqual([]);
  });

  it("row 1: a declaration with NO request at all is a draft for the same reason", () => {
    const { completion_policy: _omitted, ...withoutRequest } = naturalDeclaration();
    const result = compileGraph(withoutRequest, {
      completionPolicies: AUTHORIZED,
    });
    expect(unauthorizedOf(result)).toEqual([
      { nodeId: "ship", outcome: "shipped", code: "completion-policy-unavailable" },
    ]);
  });

  it("row 1: an unknown policy id and an unknown revision are distinct draft reasons", () => {
    expect(
      unauthorizedOf(
        compileGraph(naturalDeclaration(), { completionPolicies: OTHER_ID }),
      ),
    ).toEqual([
      {
        nodeId: "ship",
        outcome: "shipped",
        code: "completion-policy-unknown",
        request: { id: POLICY_ID, revision: POLICY_REVISION },
      },
    ]);
    expect(
      unauthorizedOf(
        compileGraph(naturalDeclaration(), {
          completionPolicies: OTHER_REVISION,
        }),
      ),
    ).toEqual([
      {
        nodeId: "ship",
        outcome: "shipped",
        code: "completion-policy-unknown-revision",
        request: { id: POLICY_ID, revision: POLICY_REVISION },
      },
    ]);
  });

  it("row 1: a resolved policy that is SILENT about the mapping is a draft, not a refusal", () => {
    const result = compileGraph(naturalDeclaration(), {
      completionPolicies: UNGRANTED,
    });
    expect(unauthorizedOf(result)).toEqual([
      {
        nodeId: "ship",
        outcome: "shipped",
        code: "completion-policy-ungranted",
        request: { id: POLICY_ID, revision: POLICY_REVISION },
      },
    ]);
  });

  it("row 2: a policy that explicitly denies the mapping is a compile REFUSAL", () => {
    const byDefault = compileGraph(naturalDeclaration(), {
      completionPolicies: DENYING,
    });
    expect(byDefault.ok).toBe(false);
    if (!byDefault.ok) {
      expect(byDefault.errors.map((error) => error.code)).toEqual([
        "completion-policy-denied",
      ]);
      expect(byDefault.errors[0]?.path).toBe("nodes.ship.completion");
      expect(byDefault.errors[0]?.message).toContain("declared default");
    }
    const byRule = compileGraph(naturalDeclaration(), {
      completionPolicies: registryOf([
        {
          version: 1,
          default: "ungranted",
          rules: [
            {
              graphId: GRAPH_ID,
              nodeId: "ship",
              outcome: "shipped",
              decision: "deny",
            },
          ],
        },
        POLICY_REVISION,
      ]),
    });
    expect(byRule.ok).toBe(false);
    if (!byRule.ok) {
      expect(byRule.errors.map((error) => error.code)).toEqual([
        "completion-policy-denied",
      ]);
      expect(byRule.errors[0]?.message).toContain("denies the mapping");
    }
  });

  it("row 3: an allowed mapping with complete acceptance is executable and PINS the authorization", () => {
    const result = compileGraph(
      naturalDeclaration({
        nodes: naturalDeclaration().nodes.map((node) =>
          node.id === "ship"
            ? {
                ...node,
                outcomes: [
                  {
                    id: "shipped",
                    acceptance: [{ validator: "schema.ship", version: 4 }],
                  },
                ],
              }
            : node,
        ),
      }),
      {
        completionPolicies: AUTHORIZED,
        supportedValidators: [{ validator: "schema.ship", version: 4 }],
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("executable");
    const policyRef = refOf(GRANT_BODY);
    expect(result.plan.completionAuthorizations).toEqual([
      { nodeId: "ship", outcome: "shipped", policy: policyRef },
    ]);
    expect(result.plan.completionPolicySnapshots[policyRef.digest]).toEqual(
      GRANT_BODY,
    );
    expect(result.plan.completionPolicyIdentities).toEqual({
      [POLICY_ID]: { [POLICY_REVISION]: policyRef.digest },
    });
    // The acceptance version is pinned beside the authorization: both are part
    // of "what this executable plan is allowed to do".
    const ship = result.plan.nodes.find((node) => node.id === "ship");
    expect(ship?.outcomes[0]?.acceptance).toEqual([
      { validator: "schema.ship", version: 4 },
    ]);
    // The writer satisfies its own reader with the completion bundle included.
    expect(result.plan.executability).toEqual({ kind: "executable" });
  });

  it("row 3: an allowed mapping whose ACCEPTANCE is unresolved is still a draft, and says both things", () => {
    const result = compileGraph(
      naturalDeclaration({
        nodes: naturalDeclaration().nodes.map((node) =>
          node.id === "ship"
            ? {
                ...node,
                outcomes: [
                  {
                    id: "shipped",
                    acceptance: [{ validator: "schema.ship", version: 4 }],
                  },
                ],
              }
            : node,
        ),
      }),
      { completionPolicies: AUTHORIZED },
    );
    if (!result.ok) throw new Error("expected a draft");
    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") return;
    expect(result.unresolved.map((entry) => entry.validator)).toEqual([
      "schema.ship",
    ]);
    expect(result.unauthorizedCompletions).toEqual([]);
    // The mapping WAS authorized, so the plan pins it even though the plan as a
    // whole cannot execute yet.
    expect(result.plan.completionAuthorizations).toHaveLength(1);
  });
});

// ── The declaration proposes; it never authorizes ───────────────────────────

describe("a declaration can request a policy but never grant itself one", () => {
  it("refuses rules smuggled into the request at the strict front-end", () => {
    const parsed = parseGraphDeclarationV3({
      ...naturalDeclaration(),
      completion_policy: {
        id: POLICY_ID,
        revision: POLICY_REVISION,
        rules: [
          {
            graphId: GRAPH_ID,
            nodeId: "ship",
            outcome: "shipped",
            decision: "allow",
          },
        ],
      },
    });
    if (parsed.ok) throw new Error("expected the front-end to refuse the key");
    expect(
      parsed.errors.some(
        (issue) =>
          issue.code === "unknown-key" &&
          issue.path === "$.completion_policy.rules",
      ),
    ).toBe(true);
  });

  it("ignores an inlined rule list that reaches the compiler through the shallow guard", () => {
    // The untyped declaration is what a caller that skips the front-end can
    // pass. The inlined rules are NOT consulted: with no installed capability
    // the mapping is still unauthorized, and with a denying policy it is still
    // denied.
    const raw: unknown = {
      ...naturalDeclaration(),
      completion_policy: {
        id: POLICY_ID,
        revision: POLICY_REVISION,
        rules: [
          {
            graphId: GRAPH_ID,
            nodeId: "ship",
            outcome: "shipped",
            decision: "allow",
          },
        ],
      },
    };
    expect(unauthorizedOf(compileGraph(raw)).map((entry) => entry.code)).toEqual([
      "completion-policy-unavailable",
    ]);
    const denied = compileGraph(raw, { completionPolicies: DENYING });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.errors.map((error) => error.code)).toEqual([
        "completion-policy-denied",
      ]);
    }
  });

  it("does not treat a repository declaration as authorized until the host says so", () => {
    const shipped = REPOSITORY_COMPLETION_POLICIES[0];
    if (shipped === undefined) throw new Error("the repository ships no policy");
    const declared: GraphDeclarationV3 = naturalDeclaration({
      completion_policy: { id: shipped.id, revision: shipped.revision },
    });
    // The declaration exists in reviewed source and the host installed nothing:
    // the mapping is a draft, not a grant.
    expect(
      unauthorizedOf(
        compileGraph(declared, {
          completionPolicies: registryOf([GRANT_BODY, POLICY_REVISION]),
        }),
      ).map((entry) => entry.code),
    ).toEqual(["completion-policy-unknown"]);
    // The SAME declaration with the shipped revision installed answers exactly
    // what that reviewed revision declares: revision 1 grants nothing, so the
    // mapping is an UNGRANTED draft rather than a refusal.
    const withRevision1 = compileGraph(declared, {
      completionPolicies: loadCompletionPolicies({
        catalog: REPOSITORY_COMPLETION_POLICIES,
        authorized: [completionPolicyRefOf(shipped)],
      }).registry,
    });
    expect(unauthorizedOf(withRevision1).map((entry) => entry.code)).toEqual([
      "completion-policy-ungranted",
    ]);
    // Revision 2 explicitly denies every natural mapping, so the same request
    // at that revision is REFUSED.
    const revision2 = REPOSITORY_COMPLETION_POLICIES.find(
      (entry) => entry.revision === "2",
    );
    if (revision2 === undefined) throw new Error("the repository ships revision 2");
    const withRevision2 = compileGraph(
      naturalDeclaration({
        completion_policy: { id: revision2.id, revision: revision2.revision },
      }),
      {
        completionPolicies: loadCompletionPolicies({
          catalog: REPOSITORY_COMPLETION_POLICIES,
          authorized: [completionPolicyRefOf(revision2)],
        }).registry,
      },
    );
    expect(withRevision2.ok).toBe(false);
    if (!withRevision2.ok) {
      expect(withRevision2.errors.map((error) => error.code)).toEqual([
        "completion-policy-denied",
      ]);
    }
  });

  it("keeps the host capability out of graph_declare's arguments and refuses the draft without it", async () => {
    const dir = makeTmpDir("completion-policy-declare-");
    const withoutCapability = createGraphToolSet({ stateDir: dir });
    expect(() =>
      withoutCapability.graph_declare({ declaration: naturalDeclaration() }),
    ).toThrow(GraphDeclareRefusedError);
    try {
      withoutCapability.graph_declare({ declaration: naturalDeclaration() });
    } catch (error) {
      expect(error).toBeInstanceOf(GraphDeclareRefusedError);
      if (error instanceof GraphDeclareRefusedError) {
        expect(error.reason).toBe("draft-plan");
        expect(error.unauthorizedCompletions).toEqual([
          {
            nodeId: "ship",
            outcome: "shipped",
            code: "completion-policy-unavailable",
            request: { id: POLICY_ID, revision: POLICY_REVISION },
          },
        ]);
        expect(error.message).toContain("completion-policy-unavailable");
        expect(error.message).toContain("HOST install");
      }
    }
    // The HOST injects the capability; the same declaration then persists.
    const withCapability = createGraphToolSet({
      stateDir: dir,
      completionPolicies: AUTHORIZED,
    });
    const declared = withCapability.graph_declare({
      declaration: naturalDeclaration(),
    });
    expect(declared.executability).toBe("executable");
    expect(declared.persisted).toBe(true);
  });
});

// ── The effective plan is fixed and round-trips ─────────────────────────────

describe("an executable plan pins the policy, its digest and the authorization", () => {
  it("round-trips the pinned policy through the durable record without loss", () => {
    const result = compileGraph(naturalDeclaration(), {
      completionPolicies: AUTHORIZED,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "executable") {
      throw new Error("the fixture must be executable");
    }
    const plan: CompiledPlan = result.plan;
    const record = createPersistedCompiledPlan(plan);
    const roundTripped: unknown = JSON.parse(JSON.stringify(record));
    expect(roundTripped).toEqual(record);
    // The persisted body still addresses the revision the compiler wrote.
    const verified = verifyPersistedCompiledPlan(
      roundTripped,
      GRAPH_ID,
      new Set(["work", "ship"]),
    );
    expect(verified).toEqual({ kind: "verified" });
    // And the authorization is READABLE back from the record, with the policy
    // body the pinned digest names.
    const policyRef = refOf(GRANT_BODY);
    expect(record.completionAuthorizations).toEqual([
      { nodeId: "ship", outcome: "shipped", policy: policyRef },
    ]);
    expect(record.completionPolicySnapshots[policyRef.digest]).toEqual(
      GRANT_BODY,
    );
  });

  it("refuses a persisted plan whose pinned policy content was swapped", () => {
    const result = compileGraph(naturalDeclaration(), {
      completionPolicies: AUTHORIZED,
    });
    if (!result.ok || result.kind !== "executable") {
      throw new Error("the fixture must be executable");
    }
    const record = createPersistedCompiledPlan(result.plan);
    const policyRef = refOf(GRANT_BODY);
    const tampered = {
      ...record,
      completionPolicySnapshots: {
        ...record.completionPolicySnapshots,
        [policyRef.digest]: UNGRANTED_BODY,
      },
    };
    const verified = verifyPersistedCompiledPlan(
      tampered,
      GRAPH_ID,
      new Set(["work", "ship"]),
    );
    expect(verified.kind).toBe("corrupt");
    if (verified.kind === "corrupt") {
      expect(verified.reason).toContain("inconsistent-completion-policy");
    }
  });

  it("moves the plan revision with the pinned policy, so an attempt bound to one revision cannot settle under another", () => {
    // The attempt credential (D2) binds graphId + nodeId + attemptId +
    // planRevision. The authorization lives inside the plan body, so it is
    // covered by that revision: republishing the policy — even granting the
    // SAME mapping — produces a different plan revision, and therefore a
    // different attempt identity. There is no second settlement channel in
    // which an old attempt could meet new authorization semantics.
    const first = compileGraph(naturalDeclaration(), {
      completionPolicies: AUTHORIZED,
    });
    const second = compileGraph(naturalDeclaration(), {
      completionPolicies: AUTHORIZED_ALT,
    });
    if (!first.ok || first.kind !== "executable") {
      throw new Error("the first fixture must be executable");
    }
    if (!second.ok || second.kind !== "executable") {
      throw new Error("the second fixture must be executable");
    }
    // The SAME mapping is authorized by both policies ...
    expect(
      second.plan.completionAuthorizations.map(
        (entry) => entry.nodeId + ":" + entry.outcome,
      ),
    ).toEqual(
      first.plan.completionAuthorizations.map(
        (entry) => entry.nodeId + ":" + entry.outcome,
      ),
    );
    // ... through a DIFFERENT content address, which is why the plans differ.
    expect(second.plan.completionAuthorizations[0]?.policy.digest).not.toBe(
      first.plan.completionAuthorizations[0]?.policy.digest,
    );
    expect(second.plan.planRevision).not.toBe(first.plan.planRevision);
    // And the runtime refuses the ALTERNATE content for the FIRST plan's pinned
    // digest rather than re-binding it.
    const altRef = refOf(GRANT_BODY_ALT);
    expect(verifyCompletionPolicy(refOf(GRANT_BODY), AUTHORIZED_ALT)).toMatchObject(
      { kind: "digest-mismatch" },
    );
    expect(first.plan.completionPolicySnapshots[altRef.digest]).toBeUndefined();
  });

  it("refuses a draft reason outside the closed vocabulary", () => {
    expect(
      readPlanExecutability({
        kind: "draft",
        unresolved: [],
        unauthorizedCompletions: [
          { nodeId: "ship", outcome: "shipped", code: "trust-me" },
        ],
      }),
    ).toEqual({ kind: "malformed" });
    expect(
      readPlanExecutability({
        kind: "draft",
        unresolved: [],
        unauthorizedCompletions: [
          {
            nodeId: "ship",
            outcome: "shipped",
            code: "completion-policy-unavailable",
          },
        ],
      }),
    ).toEqual({ kind: "draft" });
  });
});

// ── The persisted plan's policy is a run precondition ───────────────────────

describe("a plan whose policy this process lacks is blocked, with the state preserved", () => {
  /** Start the fixture graph through the outcome runtime and close the handle. */
  async function startGraph(dir: string): Promise<void> {
    const graph = buildDeclaredOutcomeGraph({
      declaration: naturalDeclaration(),
      completionPolicies: AUTHORIZED,
    });
    const ledger = await SqliteAcceptanceLedger.create(engineStateDir(dir));
    try {
      const runtime = new OutcomeGraphRuntime({
        plan: graph.plan,
        ledger,
        dispatch: () => undefined,
        validators: createValidatorRegistry([]),
        artifactRoot: dir,
        credentialIsolation: testHostCredentialIsolation(engineStateDir(dir)),
        completionPolicies: AUTHORIZED,
      });
      const started = runtime.start(NOW);
      expect(started.kind).toBe("started");
    } finally {
      ledger.close();
    }
  }

  function graph() {
    return buildDeclaredOutcomeGraph({
      declaration: naturalDeclaration(),
      completionPolicies: AUTHORIZED,
    });
  }

  it("refuses start() without the capability and writes NO state", async () => {
    const dir = makeTmpDir("completion-policy-start-");
    const declared = graph();
    const ledger = await SqliteAcceptanceLedger.create(engineStateDir(dir));
    try {
      const runtime = new OutcomeGraphRuntime({
        plan: declared.plan,
        ledger,
        dispatch: () => undefined,
        validators: createValidatorRegistry([]),
        artifactRoot: dir,
        credentialIsolation: testHostCredentialIsolation(engineStateDir(dir)),
      });
      const started = runtime.start(NOW);
      expect(started.kind).toBe("refused");
      if (started.kind === "refused") {
        expect(started.refusals.map((refusal) => refusal.code)).toEqual([
          "completion-policy-unavailable",
        ]);
      }
      // Nothing was written: a blocked start leaves no graph state behind.
      expect(ledger.readGraphState(GRAPH_ID)).toBeUndefined();
    } finally {
      ledger.close();
    }
  });

  it("blocks RECOVERY without the capability, preserves the state, and resumes with it", async () => {
    const dir = makeTmpDir("completion-policy-recover-");
    await startGraph(dir);
    const declared = graph();
    const ledger = await SqliteAcceptanceLedger.create(engineStateDir(dir));
    try {
      const before = JSON.stringify(ledger.readGraphState(GRAPH_ID));
      const effectsBefore = JSON.stringify(ledger.pendingEffects(GRAPH_ID));
      const refused = resumePersistedOutcomeGraph({
        state: declared.state,
        ledger,
        dispatch: () => undefined,
        validators: createValidatorRegistry([]),
        artifactRoot: dir,
        credentialIsolation: testHostCredentialIsolation(engineStateDir(dir)),
        now: NOW,
      });
      expect(refused.kind).toBe("refused");
      if (refused.kind === "refused") {
        expect(refused.refusals.map((refusal) => refusal.code)).toEqual([
          "completion-policy-unavailable",
        ]);
        expect(refused.refusals[0]?.message).toContain(POLICY_ID);
      }
      // The state is PRESERVED: the refused recovery wrote nothing at all.
      expect(JSON.stringify(ledger.readGraphState(GRAPH_ID))).toBe(before);
      expect(JSON.stringify(ledger.pendingEffects(GRAPH_ID))).toBe(effectsBefore);
      // The block is the missing capability, not the state: the same recovery
      // succeeds once the host injects the policy.
      const resumed = resumePersistedOutcomeGraph({
        state: declared.state,
        ledger,
        dispatch: () => undefined,
        validators: createValidatorRegistry([]),
        artifactRoot: dir,
        credentialIsolation: testHostCredentialIsolation(engineStateDir(dir)),
        now: NOW,
        completionPolicies: AUTHORIZED,
      });
      expect(resumed.kind).toBe("resumed");
    } finally {
      ledger.close();
    }
  });

  it("reports an uninstalled revision, an uninstalled id and republished content by name", async () => {
    const dir = makeTmpDir("completion-policy-codes-");
    await startGraph(dir);
    const declared = graph();
    const ledger = await SqliteAcceptanceLedger.create(engineStateDir(dir));
    try {
      const codes = (registry: CompletionPolicyRegistry | undefined): string[] => {
        const runtime = new OutcomeGraphRuntime({
          plan: declared.plan,
          ledger,
          dispatch: () => undefined,
          validators: createValidatorRegistry([]),
          artifactRoot: dir,
          credentialIsolation: testHostCredentialIsolation(engineStateDir(dir)),
          ...(registry === undefined ? {} : { completionPolicies: registry }),
        });
        const result = runtime.resume(NOW);
        expect(result.kind).toBe("refused");
        return result.kind === "refused"
          ? result.refusals.map((refusal) => refusal.code)
          : [];
      };
      expect(codes(OTHER_REVISION)).toEqual(["completion-policy-unknown-revision"]);
      expect(codes(OTHER_ID)).toEqual(["completion-policy-unknown"]);
      // The same identity installed with different content: the plan's pinned
      // digest is the authority and is never re-bound to the installed body.
      const republished = createCompletionPolicyRegistry({
        policies: [{ ref: refOf(UNGRANTED_BODY), body: UNGRANTED_BODY }],
      });
      expect(codes(republished)).toEqual(["completion-policy-digest-mismatch"]);
      // And a submission is refused by the same rule, before any credential is
      // even consulted.
      const runtime = new OutcomeGraphRuntime({
        plan: declared.plan,
        ledger,
        dispatch: () => undefined,
        validators: createValidatorRegistry([]),
        artifactRoot: dir,
        credentialIsolation: testHostCredentialIsolation(engineStateDir(dir)),
      });
      const submitted = runtime.submit(
        { nodeId: "work", outcomeId: "done", credential: "not-a-credential" },
        NOW,
      );
      expect(submitted.kind).toBe("refused");
      if (submitted.kind === "refused") {
        expect(submitted.refusals.map((refusal) => refusal.code)).toEqual([
          "completion-policy-unavailable",
        ]);
      }
    } finally {
      ledger.close();
    }
  });
});
