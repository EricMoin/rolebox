/**
 * P4 — the shipped capability set (items 1, 2, 3 and 4).
 *
 * Three properties, each with the shape that can actually fail:
 *
 * 1. ONE SOURCE OF TRUTH. The capability set `graph_declare` compiles against is
 *    the host-installed validator registry — the same one the run path looks
 *    implementations up in. A caller's `supported_validators` may only narrow
 *    it, and an entry the host cannot substantiate refuses the declaration
 *    before anything is persisted.
 * 2. THE SHIPPED AUTHORIZATION PATH. The completion policies the shipped hosts
 *    install are loaded by `assembleHostCapabilities` from the operator's
 *    environment, and a natural mapping compiled with that registry really runs:
 *    the graph is declared executable, its first attempt is dispatched, and a
 *    natural settlement is accepted.
 * 3. THE SHIPPED ASSEMBLY IS NOT EMPTY. Both entry files assemble the four
 *    primitives and hand the ONE registry (and the ONE policy registry) to both
 *    the host and the toolset. The last assertion is a STATIC wiring check —
 *    this environment cannot boot either platform — and is labelled as such.
 *
 * Every case uses its own mkdtemp directory, removed in afterEach.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  capabilitiesOfValidatorRegistry,
  resolveDeclaredValidatorCapabilities,
} from "../../src/graph/compiler/capability-set.ts";
import type { AcceptanceRequirementV3, GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import { readStoredDefinition } from "../../src/graph/persistence/declared-record.ts";
import { engineStateDir } from "../../src/graph/persistence/engine-persistence.ts";
import { SqliteAcceptanceLedger } from "../../src/graph/ledger/sqlite-ledger.ts";
import { OutcomeGraphRuntime } from "../../src/graph/outcome/runtime.ts";
import type { OutcomeDispatchRequest } from "../../src/graph/outcome/runtime.ts";
import type { AttemptCredentialSource } from "../../src/graph/outcome/attempt-credential.ts";
import {
  createValidatorRegistry,
  type ValidatorRegistry,
} from "../../src/graph/outcome/validators.ts";
import {
  assembleHostCapabilities,
  createShippedAcceptanceValidators,
} from "../../src/graph/policy/acceptance-primitives.ts";
import {
  GraphDeclareRefusedError,
  buildDeclaredOutcomeGraph,
} from "../../src/graph/tools/declare-graph.ts";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { testHostCredentialIsolation } from "./helpers/credential-isolation.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const GRAPH = "graph.shipped-natural";
const GATE_ID = "gate.check";
const GATE_VERSION = 2;
const NOW = 1_700_000_000_000;

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

const GATE_REQUIREMENT: AcceptanceRequirementV3 = {
  validator: GATE_ID,
  version: GATE_VERSION,
};

/** A one-node graph whose `done` outcome requires the gate. */
function gatedDeclaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: "graph.gated",
    nodes: [
      {
        id: "work",
        agent: "agent.work",
        prompt: "Do the work.",
        outcomes: [{ id: "done", acceptance: [GATE_REQUIREMENT] }],
      },
    ],
    edges: [],
  };
}

/** The registry the host installed: one gate, at version 2. */
function hostRegistry(): ValidatorRegistry {
  return createValidatorRegistry([
    { id: GATE_ID, version: GATE_VERSION, implementation: () => ({ kind: "pass" }) },
  ]);
}

/**
 * work --done--> ship, where ship completes NATURALLY into "shipped" and the
 * graph requests the policy revision the operator authorizes below.
 */
function naturalDeclaration(policyId: string): GraphDeclarationV3 {
  return {
    version: 3,
    name: GRAPH,
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
    completion_policy: { id: policyId, revision: "1" },
  };
}

// ── 1. One capability set ───────────────────────────────────────────────────

describe("the compile-time capability set is derived from the installed registry", () => {
  it("lists every installed key at its exact version, in registration order", () => {
    const registry = createValidatorRegistry([
      { id: "b", version: 2, implementation: () => ({ kind: "pass" }) },
      { id: "a", version: 1, implementation: () => ({ kind: "pass" }) },
      { id: "a", version: 3, implementation: () => ({ kind: "pass" }) },
    ]);
    expect(capabilitiesOfValidatorRegistry(registry)).toEqual([
      { validator: "b", version: 2 },
      { validator: "a", version: 1 },
      { validator: "a", version: 3 },
    ]);
  });

  it("narrows to the declared subset, pins an unversioned entry to its only installed version, and refuses anything else", () => {
    const single = createValidatorRegistry([
      { id: GATE_ID, version: GATE_VERSION, implementation: () => ({ kind: "pass" }) },
    ]);
    expect(capabilitiesOfValidatorRegistry(single)).toEqual([
      { validator: GATE_ID, version: GATE_VERSION },
    ]);
    expect(
      resolveDeclaredValidatorCapabilities(
        [{ validator: GATE_ID, version: GATE_VERSION }],
        single,
      ),
    ).toEqual({
      kind: "effective",
      capabilities: [{ validator: GATE_ID, version: GATE_VERSION }],
    });
    expect(
      resolveDeclaredValidatorCapabilities([{ validator: GATE_ID }], single),
    ).toEqual({
      kind: "effective",
      capabilities: [{ validator: GATE_ID, version: GATE_VERSION }],
    });

    const wrongVersion = resolveDeclaredValidatorCapabilities(
      [{ validator: GATE_ID, version: 1 }],
      single,
    );
    expect(wrongVersion.kind).toBe("refused");
    if (wrongVersion.kind === "refused") {
      expect(wrongVersion.issues.map((issue) => issue.code)).toEqual([
        "validator-capability-not-installed",
      ]);
    }

    const unknownName = resolveDeclaredValidatorCapabilities(
      [{ validator: "not.installed", version: 1 }],
      single,
    );
    expect(unknownName.kind).toBe("refused");

    const twoVersions = createValidatorRegistry([
      { id: GATE_ID, version: 1, implementation: () => ({ kind: "pass" }) },
      { id: GATE_ID, version: 2, implementation: () => ({ kind: "pass" }) },
    ]);
    const ambiguous = resolveDeclaredValidatorCapabilities(
      [{ validator: GATE_ID }],
      twoVersions,
    );
    expect(ambiguous.kind).toBe("refused");
    if (ambiguous.kind === "refused") {
      expect(ambiguous.issues[0]?.code).toBe("ambiguous-validator-version");
    }
    // Omitted: every installed capability is in scope, never none.
    expect(
      resolveDeclaredValidatorCapabilities(undefined, twoVersions),
    ).toEqual({
      kind: "effective",
      capabilities: [
        { validator: GATE_ID, version: 1 },
        { validator: GATE_ID, version: 2 },
      ],
    });
  });

  it("refuses graph_declare for a caller-declared capability the host did not install, and writes nothing", () => {
    const dir = makeTmpDir("capability-refusal-");
    const toolset = createGraphToolSet({
      stateDir: dir,
      outcomeValidators: hostRegistry(),
    });
    let refusal: unknown;
    try {
      toolset.graph_declare({
        declaration: gatedDeclaration(),
        supported_validators: [{ validator: GATE_ID, version: 1 }],
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(GraphDeclareRefusedError);
    if (refusal instanceof GraphDeclareRefusedError) {
      expect(refusal.reason).toBe("validator-capability-not-installed");
      expect(refusal.diagnostics[0]?.code).toBe(
        "validator-capability-not-installed",
      );
      expect(refusal.message).toContain("supported_validators");
    }
    // Nothing was compiled and nothing was persisted: the store is still absent.
    expect(readStoredDefinition(engineStateDir(dir), "graph.gated")).toEqual({
      kind: "blocked",
      verdict: { kind: "absent" },
    });

    // The SAME declaration with the host's own capability — declared not at all
    // — compiles against the installed set and persists the exact version.
    const declared = toolset.graph_declare({ declaration: gatedDeclaration() });
    expect(declared.graph_id).toBe("graph.gated");
    const stored = readStoredDefinition(engineStateDir(dir), "graph.gated");
    expect(stored.kind).toBe("ok");
    if (stored.kind === "ok") {
      const node = stored.declared.plan.nodes[0];
      expect(node?.outcomes[0]?.acceptance).toEqual([
        { validator: GATE_ID, version: GATE_VERSION },
      ]);
    }
  });

  it("treats a host that installed nothing as the empty set, not as 'the caller decides'", () => {
    const dir = makeTmpDir("capability-empty-");
    const toolset = createGraphToolSet({ stateDir: dir });
    let refusal: unknown;
    try {
      toolset.graph_declare({
        declaration: gatedDeclaration(),
        supported_validators: [{ validator: GATE_ID, version: GATE_VERSION }],
      });
    } catch (error) {
      refusal = error;
    }
    // The caller's entry is refused because THIS host installed no such
    // capability — the argument can never install one.
    expect(refusal).toBeInstanceOf(GraphDeclareRefusedError);
    if (refusal instanceof GraphDeclareRefusedError) {
      expect(refusal.reason).toBe("validator-capability-not-installed");
    }
  });
});

// ── 2. The shipped authorization path, end to end ───────────────────────────

describe("the shipped completion-policy authorization path compiles and runs", () => {
  const POLICY_ID = "test.shipped-natural-policy";
  const GRANT_BODY = {
    version: 1,
    default: "ungranted",
    rules: [
      { graphId: GRAPH, nodeId: "ship", outcome: "shipped", decision: "allow" },
    ],
  };

  it("authorizes a host declaration from the environment, and a natural mapping then compiles and settles", async () => {
    const dir = makeTmpDir("shipped-natural-");
    const storeRoot = join(dir, "host-store");
    const env = {
      ROLEBOX_GRAPH_COMPLETION_POLICIES: JSON.stringify({
        declare: [{ id: POLICY_ID, revision: "1", body: GRANT_BODY }],
        authorize: [POLICY_ID + "@1"],
      }),
    };
    const capabilities = assembleHostCapabilities({
      artifactRoot: dir,
      storeRoot,
      env,
    });
    expect(capabilities.completionPolicyIssues).toEqual([]);
    expect(capabilities.authorizedCompletionPolicies).toHaveLength(1);
    expect(capabilities.completionPolicies.policies).toHaveLength(1);
    expect(capabilities.validatorIds).toHaveLength(4);

    // COMPILE: the same two registries the host would hand the toolset.
    const declared = buildDeclaredOutcomeGraph({
      declaration: naturalDeclaration(POLICY_ID),
      installedValidators: capabilities.validators,
      completionPolicies: capabilities.completionPolicies,
    });
    expect(declared.plan.executability).toEqual({ kind: "executable" });
    expect(declared.plan.completionAuthorizations).toEqual([
      {
        nodeId: "ship",
        outcome: "shipped",
        policy: {
          id: POLICY_ID,
          revision: "1",
          digest: capabilities.authorizedCompletionPolicies[0]?.digest,
        },
      },
    ]);

    // RUN: the same registries again — one source of truth for both halves.
    const ledger = await SqliteAcceptanceLedger.create(dir);
    try {
      const requests: OutcomeDispatchRequest[] = [];
      const mintCredential: AttemptCredentialSource = (binding) =>
        "test-credential:" + binding.nodeId + "#" + binding.attemptId;
      const runtime = new OutcomeGraphRuntime({
        plan: declared.plan,
        ledger,
        dispatch: (request) => {
          requests.push(request);
        },
        validators: capabilities.validators,
        artifactRoot: dir,
        clock: () => NOW,
        mintCredential,
        credentialIsolation: testHostCredentialIsolation(dir),
        completionPolicies: capabilities.completionPolicies,
      });
      expect(runtime.start(NOW).kind).toBe("started");
      const workCredential = requests.find(
        (request) => request.attemptId === "work#1",
      )?.credential;
      expect(typeof workCredential).toBe("string");
      const worked = runtime.submit(
        { nodeId: "work", outcomeId: "done", credential: workCredential ?? "" },
        NOW + 1,
      );
      expect(worked.kind).toBe("accepted");

      const shipCredential = requests.find(
        (request) => request.attemptId === "ship#2",
      )?.credential;
      const settled = runtime.settleNatural(
        {
          nodeId: "ship",
          attemptId: "ship#2",
          credential: shipCredential ?? "",
        },
        NOW + 2,
      );
      expect(settled.kind).toBe("accepted");
      if (settled.kind === "accepted") {
        expect(settled.completion.outcomeId).toBe("shipped");
        expect(settled.completion.policy.id).toBe(POLICY_ID);
        expect(settled.state.phase).toBe("complete");
      }
    } finally {
      ledger.close();
    }
  });

  it("installs nothing without an authorization, and reports every configuration it could not install", async () => {
    const dir = makeTmpDir("shipped-policy-default-");
    const none = assembleHostCapabilities({
      artifactRoot: dir,
      storeRoot: join(dir, "store"),
      env: {},
    });
    expect(none.completionPolicies.policies).toEqual([]);
    expect(none.completionPolicyIssues).toEqual([]);

    // A repository declaration is NOT an authorization: naming revision 1
    // installs it (the operator asked), while revision 2 stays uninstalled and
    // is reported.
    const revision1 = assembleHostCapabilities({
      artifactRoot: dir,
      storeRoot: join(dir, "store"),
      env: {
        ROLEBOX_GRAPH_COMPLETION_POLICIES: JSON.stringify({
          authorize: ["rolebox.graph.completion@1"],
        }),
      },
    });
    expect(revision1.completionPolicies.policies).toHaveLength(1);
    expect(revision1.completionPolicies.policies[0]?.ref.revision).toBe("1");
    // The catalog's OTHER revision (2) is simply not installed; that is normal,
    // not a configuration problem, so it is not reported as an issue.
    expect(revision1.completionPolicyIssues).toEqual([]);

    const bogus = assembleHostCapabilities({
      artifactRoot: dir,
      storeRoot: join(dir, "store"),
      env: {
        ROLEBOX_GRAPH_COMPLETION_POLICIES: JSON.stringify({
          authorize: ["rolebox.graph.completion@9"],
        }),
      },
    });
    expect(bogus.completionPolicies.policies).toEqual([]);
    expect(bogus.completionPolicyIssues[0]?.kind).toBe("malformed-authorization");

    const malformed = assembleHostCapabilities({
      artifactRoot: dir,
      storeRoot: join(dir, "store"),
      env: { ROLEBOX_GRAPH_COMPLETION_POLICIES: "{ not json" },
    });
    expect(malformed.completionPolicies.policies).toEqual([]);
    expect(malformed.completionPolicyIssues).toHaveLength(1);
  });

  it("compiles a natural mapping to a draft when the installed revision does not grant it", () => {
    const dir = makeTmpDir("shipped-policy-ungranted-");
    // THE SHIPPED SHAPE: the same assembly the entries call, with the operator
    // configuring nothing. The validator registry is NOT empty (the four
    // primitives), and the completion-policy registry is DEFINED and empty.
    const shipped = assembleHostCapabilities({
      artifactRoot: dir,
      storeRoot: join(dir, "store"),
      env: {},
    });
    expect(shipped.validators.keys).toHaveLength(4);
    expect(shipped.completionPolicies.policies).toEqual([]);
    // The natural mapping requests an id the empty registry does not carry, so
    // the compilation is a DRAFT naming the missing authorization and the
    // builder REFUSES it — never an executable plan and never a silent
    // `explicit` downgrade. THIS is the code the shipped path produces.
    let refusal: unknown;
    try {
      buildDeclaredOutcomeGraph({
        declaration: naturalDeclaration(POLICY_ID),
        installedValidators: shipped.validators,
        completionPolicies: shipped.completionPolicies,
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(GraphDeclareRefusedError);
    if (refusal instanceof GraphDeclareRefusedError) {
      expect(refusal.reason).toBe("draft-plan");
      expect(refusal.unauthorizedCompletions).toEqual([
        {
          nodeId: "ship",
          outcome: "shipped",
          code: "completion-policy-unknown",
          request: { id: POLICY_ID, revision: "1" },
        },
      ]);
    }
  });

  it("names completion-policy-unavailable only for a compile handed NO policy registry at all", () => {
    // Kept separately and labelled: this is the shape an EMBEDDING caller
    // produces by OMITTING the option, not the shape either shipped entry
    // produces (both always pass a defined registry). Pinning both keeps the
    // two codes distinguishable from each other.
    const dir = makeTmpDir("shipped-policy-no-registry-");
    let refusal: unknown;
    try {
      buildDeclaredOutcomeGraph({
        declaration: naturalDeclaration(POLICY_ID),
        installedValidators: createShippedAcceptanceValidators({
          artifactRoot: dir,
          approvals: { read: () => ({ kind: "absent" }) },
        }),
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(GraphDeclareRefusedError);
    if (refusal instanceof GraphDeclareRefusedError) {
      expect(refusal.reason).toBe("draft-plan");
      expect(refusal.unauthorizedCompletions[0]?.code).toBe(
        "completion-policy-unavailable",
      );
    }
  });
});

// ── 2b. A mistaken command configuration is reported, never fatal ──────────

describe("the shipped assembly stays total under a broken trusted-command configuration", () => {
  it("installs nothing for a mapping authorized twice and still installs its unambiguous neighbours", () => {
    const dir = makeTmpDir("shipped-command-ambiguous-");
    const mapping = {
      graph: GRAPH,
      node: "work",
      outcome: "done",
      argv: [process.execPath, "-e", "process.exit(0);"],
      cwd: dir,
      timeout_ms: 5000,
      expect_exit_code: 0,
      artifact_refs: ["report.txt"],
    };
    // The operator typo repeats ONE mapping with a contradictory command. The
    // assembly must not throw out of host initialization (its documented
    // totality); the ambiguous mapping installs NO command; each configured
    // position is reported; and the unambiguous mapping beside it still
    // installs, so one bad entry cannot disarm the whole policy.
    const capabilities = assembleHostCapabilities({
      artifactRoot: dir,
      storeRoot: join(dir, "store"),
      env: {
        ROLEBOX_GRAPH_COMMAND_CHECKS: JSON.stringify([
          mapping,
          { ...mapping, expect_exit_code: 1 },
          { ...mapping, node: "other" },
        ]),
      },
    });
    expect(capabilities.commandBindings).toBe(1);
    expect(capabilities.commandPolicyIssues.map((issue) => issue.index)).toEqual([
      0, 1,
    ]);
    expect(capabilities.commandPolicyIssues[0]?.message).toContain(
      "authorized more than once",
    );
  });

  it("installs a single valid mapping and reports no issue", () => {
    const dir = makeTmpDir("shipped-command-single-");
    const capabilities = assembleHostCapabilities({
      artifactRoot: dir,
      storeRoot: join(dir, "store"),
      env: {
        ROLEBOX_GRAPH_COMMAND_CHECKS: JSON.stringify([
          {
            graph: GRAPH,
            node: "work",
            outcome: "done",
            argv: [process.execPath, "-e", "process.exit(0);"],
            cwd: dir,
            timeout_ms: 5000,
            expect_exit_code: 0,
            artifact_refs: ["report.txt"],
          },
        ]),
      },
    });
    expect(capabilities.commandBindings).toBe(1);
    expect(capabilities.commandPolicyIssues).toEqual([]);
  });
});

// ── 3. The shipped entries actually wire it (STATIC) ────────────────────────

describe("the shipped entries assemble the capability set (static wiring check)", () => {
  const entries = ["src/entries/dsh.ts", "src/entries/pi.ts"];

  it("calls the one assembly, hands the registry to host and toolset, and constructs no empty registry", () => {
    const repoRoot = join(import.meta.dir, "..", "..");
    for (const entry of entries) {
      const text = readFileSync(join(repoRoot, entry), "utf8");
      // The one assembly both hosts use (P4 items 1, 2 and 3).
      expect(text).toContain("assembleHostCapabilities({");
      // ONE validator registry, given to the host (run) ...
      expect(text).toContain("validators: shippedValidators,");
      // ... and to the toolset (compile).
      expect(text).toContain("outcomeValidators: shippedValidators,");
      // ONE completion-policy registry, given to both halves as well.
      expect(
        text.match(/completionPolicies: \w+\.completionPolicies,/g) ?? [],
      ).toHaveLength(2);
      // The frozen gap this package closes: no shipped entry may install an
      // EMPTY validator registry again.
      expect(text).not.toContain("createValidatorRegistry([])");
      expect(text).not.toContain("createValidatorRegistry([");
    }
  });
});
