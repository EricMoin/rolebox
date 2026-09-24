/// <reference types="bun-types" />

/**
 * A command-gated acceptance DELIVERS the revision the command verified (A1).
 *
 * The command-exit primitive re-reads the bound artifact revision around its
 * command and names the POST-RUN reading on its pass (D5), but nothing
 * DEPOSITED those bytes: the accepted result named a content identity no
 * consumer could ever materialize, so a plan gated ONLY by command-exit
 * accepted once and then refused every successor with an unreadable input
 * forever. The gate judged real bytes and threw them away.
 *
 * This file drives the REAL entry — \`createGraphToolSet(...).graph_declare\` and
 * \`.graph_submit_outcome\`, with the HOST's own dispatch adapter as the run path's
 * dispatch seam — over a graph WITH EDGES (\`work -> ship\`) where \`work/done\` is
 * gated ONLY by command-exit. That is the composition the defect is about: the
 * successor must receive the bytes the command validated, materialized as a real
 * file AND readable through the content identity the acceptance recorded.
 *
 * The negative case is the honest non-pass: a host with NO content store cannot
 * deliver a command-gated result at all, so the gate answers \`indeterminate\`
 * (never a pass), the submission is REJECTED, no accepted result is written and
 * no successor is launched.
 *
 * Every case owns its \`mkdtemp\` directory and removes it in a \`finally\` block;
 * nothing here touches the workspace store.
 *
 * @module
 */

import { describe, it, expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AcceptanceRequirementV3,
  GraphDeclarationV3,
} from "../../src/graph/compiler/declaration-v3.ts";
import type { HostDispatchDelivery } from "../../src/graph/host/dispatch-host.ts";
import type { DeliveredInputView } from "../../src/graph/host/input-view.ts";
import { OutcomeHost } from "../../src/graph/host/outcome-host.ts";
import { SqliteAcceptanceLedger } from "../../src/graph/ledger/sqlite-ledger.ts";
import type { OutcomeDispatchRequest } from "../../src/graph/outcome/dispatch-effects.ts";
import { readResolvedArtifact } from "../../src/graph/outcome/inputs.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
import { engineStateDir } from "../../src/graph/persistence/engine-persistence.ts";
import {
  COMMAND_EXIT_VALIDATOR_ID,
  COMMAND_EXIT_VALIDATOR_VERSION,
  createCommandExitValidator,
} from "../../src/graph/policy/acceptance-primitives.ts";
import {
  artifactIdOf,
  digestOf,
  readArtifactById,
} from "../../src/graph/store/artifacts.ts";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { testHostCredentialIsolation } from "./helpers/credential-isolation.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const GRAPH = "p42.command-gate-delivery";
const REF = "evidence/report.txt";

/** What the command judges, and what the source path holds afterwards. */
const A = Buffer.from("revision A: what the trusted command verified\n", "utf-8");
const B = Buffer.from("revision B: what the path holds later\n", "utf-8");

const COMMAND_REQUIREMENT: AcceptanceRequirementV3 = {
  validator: COMMAND_EXIT_VALIDATOR_ID,
  version: COMMAND_EXIT_VALIDATOR_VERSION,
};

/**
 * \`work -> ship\`, where ONLY the command gate stands between work and its
 * consumer, and the consumer DECLARES work's accepted result as its input.
 */
function declaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: GRAPH,
    nodes: [
      {
        id: "work",
        agent: "agent.work",
        prompt: "Do the work.",
        outcomes: [{ id: "done", acceptance: [COMMAND_REQUIREMENT] }],
      },
      {
        id: "ship",
        agent: "agent.ship",
        prompt: "Ship it.",
        outcomes: [{ id: "delivered" }],
        inputs: [{ from: "work", outcome: "done" }],
      },
    ],
    edges: [{ from: "work", to: "ship", outcome: "done" }],
  };
}

/** One delivery the host's dispatch seam received. */
interface RecordedDelivery {
  readonly request: OutcomeDispatchRequest;
  readonly inputView: DeliveredInputView | undefined;
}

interface GateFixture {
  readonly dir: string;
  readonly artifactRoot: string;
  readonly storeRoot: string;
  readonly reportPath: string;
  readonly markerPath: string;
  readonly deliveries: RecordedDelivery[];
  readonly toolset: ReturnType<typeof createGraphToolSet>;
  readonly host: OutcomeHost;
}

/** The command the HOST authorizes: exit 0, after proving it ran. */
function commandArgv(markerPath: string): readonly string[] {
  return [
    process.execPath,
    "-e",
    "require('node:fs').writeFileSync(" +
      JSON.stringify(markerPath) +
      ", 'ran\\n'); process.exit(0);",
  ];
}

/**
 * One isolated workspace: the real toolset entry over a real host, with the
 * command gate installed under the command-exit identity.
 *
 * \`contentStore: false\` builds the gate exactly as a host that has no content
 * store would: no \`artifactStoreRoot\`, so the gate has nowhere to deposit the
 * revision it verified.
 */
async function withGateFixture<T>(
  options: { readonly contentStore: boolean },
  fn: (fixture: GateFixture) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "p42-command-gate-"));
  let host: OutcomeHost | undefined;
  try {
    const artifactRoot = join(dir, "workspace");
    mkdirSync(join(artifactRoot, "evidence"), { recursive: true });
    const reportPath = join(artifactRoot, REF);
    writeFileSync(reportPath, A);
    const markerPath = join(dir, "command-ran.txt");
    const storeRoot = engineStateDir(dir);

    const validators = createValidatorRegistry([
      {
        id: COMMAND_EXIT_VALIDATOR_ID,
        version: COMMAND_EXIT_VALIDATOR_VERSION,
        implementation: createCommandExitValidator({
          commands: [
            {
              graphId: GRAPH,
              nodeId: "work",
              outcome: "done",
              argv: commandArgv(markerPath),
              cwd: dir,
              timeoutMs: 10_000,
              expectExitCode: 0,
              artifactRefs: [REF],
            },
          ],
          ...(options.contentStore ? { artifactStoreRoot: storeRoot } : {}),
        }),
      },
    ]);

    const deliveries: RecordedDelivery[] = [];
    const deliver: HostDispatchDelivery = (request, _effect, _invocation, inputView) => {
      deliveries.push({ request, inputView });
    };
    host = OutcomeHost.open({
      workspaceDir: dir,
      storeRoot,
      artifactRoot,
      validators,
      deliver,
      clock: () => NOW,
      durability: "memory",
    });

    const toolset = createGraphToolSet({
      stateDir: dir,
      outcomeNow: NOW,
      outcomeArtifactRoot: artifactRoot,
      outcomeValidators: validators,
      outcomeAcceptanceCapabilities: {
        validators: validators.keys,
        schemas: [],
        commandMappings: [{ graphId: GRAPH, nodeId: "work", outcome: "done" }],
      },
      outcomeDispatch: host.dispatch,
      credentialIsolation: testHostCredentialIsolation(storeRoot),
    });

    return await fn({
      dir,
      artifactRoot,
      storeRoot,
      reportPath,
      markerPath,
      deliveries,
      toolset,
      host,
    });
  } finally {
    host?.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

/** One ledger read of the same store the host and the toolset wrote. */
async function withLedger<T>(
  storeRoot: string,
  fn: (ledger: SqliteAcceptanceLedger) => T,
): Promise<T> {
  const ledger = await SqliteAcceptanceLedger.create(storeRoot);
  try {
    return fn(ledger);
  } finally {
    ledger.close();
  }
}

/** The delivery one attempt's dispatch produced, failing when it never ran. */
function deliveryOf(
  deliveries: readonly RecordedDelivery[],
  attemptId: string,
): RecordedDelivery {
  const found = deliveries.find((entry) => entry.request.attemptId === attemptId);
  if (found === undefined) {
    throw new Error(
      "fixture: attempt " +
        attemptId +
        " was never delivered (delivered: " +
        deliveries.map((entry) => entry.request.attemptId).join(", ") +
        ")",
    );
  }
  return found;
}

// ── The accepted result reaches its consumer ────────────────────────────────

describe("a command-only gate deposits the revision it verified (A1)", () => {
  it("accepts, and the successor receives a readable file holding those bytes", async () => {
    await withGateFixture({ contentStore: true }, async (fixture) => {
      const declared = fixture.toolset.graph_declare({ declaration: declaration() });
      expect(declared.graph_id).toBe(GRAPH);
      expect(declared.executability).toBe("executable");

      // FIRST EXECUTION through the host's own entry: the run starts from the
      // SAVED plan and hands work#1 its attempt credential.
      await fixture.host.recoverDeclaredGraphs();
      const started = deliveryOf(fixture.deliveries, "work#1");

      // The worker submits through the model-facing ingress, carrying the
      // credential its dispatch handed it and the evidence reference the
      // host's trusted command is bound to.
      const accepted = await fixture.toolset.graph_submit_outcome({
        graph_id: GRAPH,
        node_id: "work",
        outcome_id: "done",
        credential: started.request.credential,
        evidence_refs: [REF],
      });
      expect(accepted.decision).toBe("accepted");
      expect(accepted.verdict).toBe("committed");
      expect(accepted.refusals).toEqual([]);
      // The gate really ran the HOST's command.
      expect(existsSync(fixture.markerPath)).toBe(true);

      // THE SUCCESSOR WAS ACTUALLY DELIVERED, with a materialized view.
      const successor = deliveryOf(fixture.deliveries, "ship#2");
      const artifacts = successor.request.inputs?.[0]?.artifacts ?? [];
      expect(artifacts).toHaveLength(1);
      const artifactId = artifacts[0]?.artifactId ?? "";
      expect(artifactId).toBe(artifactIdOf(digestOf(A)));
      expect(successor.request.inputs?.[0]?.attemptId).toBe("work#1");

      const file = successor.inputView?.entries[0]?.artifacts[0];
      expect(file).toBeDefined();
      if (file === undefined) return;
      expect(readFileSync(file.path).equals(A)).toBe(true);

      // ... AND THE BYTES READ BACK THROUGH THE CONTENT IDENTITY the accepted
      // result names — the store the acceptance deposited into, not the path.
      const object = readArtifactById(fixture.storeRoot, artifactId);
      expect(object.kind).toBe("read");
      if (object.kind !== "read") return;
      expect(Buffer.compare(object.bytes, A)).toBe(0);

      const resolved = readResolvedArtifact(
        successor.request.inputs ?? [],
        { from: "work", ref: REF },
        (id) => readArtifactById(fixture.storeRoot, id),
      );
      expect(resolved.kind).toBe("read");
      if (resolved.kind !== "read") return;
      expect(Buffer.compare(resolved.bytes, A)).toBe(0);

      // The PERSISTED accepted result names the SAME identity and can produce
      // its bytes; no consumer has to guess and none reads the mutable path.
      await withLedger(fixture.storeRoot, (ledger) => {
        expect(
          (ledger.retainedArtifacts(GRAPH, "work#1") ?? []).map(
            (entry) => entry.artifactId,
          ),
        ).toEqual([artifactId]);
        const consumed = ledger.readAcceptedArtifact(GRAPH, "work#1", REF);
        expect(consumed.kind).toBe("read");
        if (consumed.kind !== "read") return;
        expect(Buffer.compare(consumed.bytes, A)).toBe(0);
      });

      // THE SOURCE PATH MOVING DOES NOT CHANGE WHAT WAS DELIVERED.
      writeFileSync(fixture.reportPath, B);
      const stillA = readArtifactById(fixture.storeRoot, artifactId);
      expect(stillA.kind).toBe("read");
      if (stillA.kind !== "read") return;
      expect(Buffer.compare(stillA.bytes, A)).toBe(0);
      expect(readFileSync(file.path).equals(A)).toBe(true);
      await withLedger(fixture.storeRoot, (ledger) => {
        const consumed = ledger.readAcceptedArtifact(GRAPH, "work#1", REF);
        expect(consumed.kind).toBe("read");
        if (consumed.kind !== "read") return;
        expect(Buffer.compare(consumed.bytes, A)).toBe(0);
      });
    });
  });
});

// ── The honest non-pass when there is nowhere to deposit ────────────────────

describe("a command gate with no content store never accepts (A1)", () => {
  it("answers the required gate indeterminate, writes no accepted result and launches no successor", async () => {
    await withGateFixture({ contentStore: false }, async (fixture) => {
      const declared = fixture.toolset.graph_declare({ declaration: declaration() });
      expect(declared.executability).toBe("executable");
      await fixture.host.recoverDeclaredGraphs();
      const started = deliveryOf(fixture.deliveries, "work#1");

      const refused = await fixture.toolset.graph_submit_outcome({
        graph_id: GRAPH,
        node_id: "work",
        outcome_id: "done",
        credential: started.request.credential,
        evidence_refs: [REF],
      });
      // NOT an accepted result that can never be delivered: the gate cannot be
      // completed, so it does not pass.
      expect(refused.decision).toBe("rejected");
      expect(refused.requirements?.[0]?.outcome).toBe("indeterminate");
      // The reason NAMES the missing capability and the rule: a required gate
      // that cannot be completed is never treated as passed.
      const reason = refused.requirements?.[0]?.reason ?? "";
      expect(reason).toContain("no artifact store root");
      expect(reason).toContain("never treated as passed");
      // The gate refused BEFORE running an authorized command whose verdict it
      // could never retain.
      expect(existsSync(fixture.markerPath)).toBe(false);

      // NOTHING was accepted and no successor was launched.
      expect(
        fixture.deliveries.map((entry) => entry.request.attemptId),
      ).toEqual(["work#1"]);
      await withLedger(fixture.storeRoot, (ledger) => {
        expect(ledger.acceptedEvents(GRAPH)).toEqual([]);
        expect(ledger.retainedArtifacts(GRAPH, "work#1")).toBeUndefined();
        expect(ledger.readAcceptedArtifact(GRAPH, "work#1", REF).kind).toBe(
          "problem",
        );
      });
    });
  });
});
