import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { removeTempTrees } from "../helpers/temp-dirs.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAcceptanceLedger } from "../../../src/graph/ledger/sqlite-ledger.ts";
import { OutcomeGraphRuntime } from "../../../src/graph/outcome/runtime.ts";
import { buildDeclaredOutcomeGraph } from "../../../src/graph/tools/declare-graph.ts";
import { testHostCredentialIsolation } from "../helpers/credential-isolation.ts";
import { EMPTY_VALIDATORS, NOW, plainDeclaration } from "../helpers/host-graph-fixture.ts";

const roots: string[] = [];
afterEach(() => {
  // Release the fixture's stores, then remove each tree ONCE — a removal that
  // throws must not leave the directory queued for the next sweep.
  removeTempTrees(roots);
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
      // NO CAST: the ingress takes `unknown`, so a malformed value is handed to
      // it exactly as a caller would hand one over.
      const result = runtime.recordUsage(value);
      expect(result.kind).toBe("refused");
      if (result.kind !== "refused") throw new Error("Expected malformed usage refusal");
      expect(result.refusals.map((refusal) => refusal.code)).toEqual(["budget-usage-malformed"]);
      expect(runtime.budgetReport()).toEqual(before);
    } finally {
      ledger.close();
    }
  });

  it("refuses a non-numeric now with the clock's own refusal, writing nothing", async () => {
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
      // `now` IS NOT JUDGED BY THE REPORT READER. The runtime clock's own reader
      // owns that rule, and the value is handed to it — so a `now` that is not a
      // number is refused with `invalid-timestamp` and the clock reader's own
      // wording, never silently replaced by the clock. The report's own record
      // is valid, so nothing else could have refused it.
      const result = runtime.recordUsage({
        attempts: [{ nodeId: "work", attemptId: "work#1" }],
        now: "not-a-time",
      });
      expect(result.kind).toBe("refused");
      if (result.kind !== "refused") throw new Error("Expected an invalid-timestamp refusal");
      expect(result.refusals).toEqual([
        {
          code: "invalid-timestamp",
          path: "$.now",
          message:
            "outcome-runtime: now is \"not-a-time\", not epoch milliseconds — time is an " +
            "explicit input and the receipt records exactly the value this call was given",
        },
      ]);
      expect(runtime.budgetReport()).toEqual(before);
    } finally {
      ledger.close();
    }
  });
});
