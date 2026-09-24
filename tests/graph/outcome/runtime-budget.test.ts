import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAcceptanceLedger } from "../../../src/graph/ledger/sqlite-ledger.ts";
import { OutcomeGraphRuntime, type OutcomeBudgetUsageReport } from "../../../src/graph/outcome/runtime.ts";
import { buildDeclaredOutcomeGraph } from "../../../src/graph/tools/declare-graph.ts";
import { testHostCredentialIsolation } from "../helpers/credential-isolation.ts";
import { EMPTY_VALIDATORS, NOW, plainDeclaration } from "../helpers/host-graph-fixture.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime budget input validation", () => {
  it.each([
    { name: "null report", value: null },
    { name: "missing report", value: undefined },
    { name: "null attempt", value: { attempts: [null] } },
    { name: "null after valid attempt", value: { attempts: [
      { nodeId: "work", attemptId: "work#1", inputTokens: 10 }, null,
    ] } },
  ])("refuses $name without throwing or recording usage", async ({ value }) => {
    const root = mkdtempSync(join(tmpdir(), "runtime-budget-"));
    roots.push(root);
    const ledger = await SqliteAcceptanceLedger.create(root);
    const graph = buildDeclaredOutcomeGraph({ declaration: plainDeclaration() });
    const runtime = new OutcomeGraphRuntime({
      plan: graph.plan,
      ledger,
      validators: EMPTY_VALIDATORS,
      artifactRoot: root,
      credentialIsolation: testHostCredentialIsolation(root),
      dispatch: () => {},
      clock: () => NOW,
    });
    try {
      expect(runtime.start().kind).toBe("started");
      const before = runtime.budgetReport();
      const result = runtime.recordUsage(value as OutcomeBudgetUsageReport);
      expect(result.kind).toBe("refused");
      if (result.kind !== "refused") throw new Error("Expected malformed usage refusal");
      expect(result.refusals.map((refusal) => refusal.code)).toEqual(["budget-usage-malformed"]);
      expect(runtime.budgetReport()).toEqual(before);
    } finally {
      ledger.close();
    }
  });
});
