/// <reference types="bun-types" />

/**
 * Node `inputs` enter through the REAL declaration entry (D8).
 *
 * `NodeDeclarationV3.inputs` and the compiler's fixed-reference rules existed
 * before this slice, but the strict v3 front-end's closed `NODE_KEYS` did not
 * admit the field: every legal declaration carrying `inputs` was refused
 * `unknown-key $.nodes[1].inputs`, so the compiler's pinning was unreachable
 * from the entry that authors graphs (`graph_declare`). The existing compiler
 * tests call `compileGraph` directly and therefore never crossed that hole.
 *
 * Every case here goes through the TOOLSET entry — `createGraphToolSet(...)
 * .graph_declare` — exactly as the model-facing tool does, in its own temp
 * workspace, and asserts what the entry PERSISTED. A refused declaration is
 * refused before anything is written: no store file, no declaration seam.
 *
 * @module
 */

import { describe, it, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  GraphDeclareRefusedError,
} from "../../src/graph/tools/declare-graph.ts";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { readStoredDefinition } from "../../src/graph/persistence/declared-record.ts";
import { engineStateDir } from "../../src/graph/persistence/engine-persistence.ts";
import { graphStoreFilePath } from "../../src/graph/store/index.ts";

const GRAPH = "p42.declared-inputs";

/**
 * The chain `work -> review` whose consumer declares `inputs`.
 *
 * `inputs` is `unknown` on purpose: the strictness cases below feed values the
 * grammar must REFUSE, and the entry reads the authored value untyped — a
 * helper that could only be called with a well-formed list would not exercise
 * the refusal at all.
 */
function chain(inputs: unknown, opts: { extraNode?: boolean } = {}) {
  return {
    version: 3,
    name: GRAPH,
    nodes: [
      {
        id: "work",
        agent: "agent.work",
        prompt: "Produce.",
        outcomes: [{ id: "done" }],
        completion: { mode: "explicit" },
      },
      ...(opts.extraNode === true
        ? [
            {
              id: "other",
              agent: "agent.other",
              prompt: "Unrelated.",
              outcomes: [{ id: "spare" }],
              completion: { mode: "explicit" },
            },
          ]
        : []),
      {
        id: "review",
        agent: "agent.review",
        prompt: "Consume.",
        outcomes: [{ id: "ok" }],
        completion: { mode: "explicit" },
        ...(inputs === undefined ? {} : { inputs }),
      },
    ],
    edges: [{ from: "work", to: "review", outcome: "done" }],
  };
}

/**
 * A fresh temp workspace with the REAL toolset entry over it.
 *
 * The declaration seam is recorded, so "nothing was dispatched" is observable
 * rather than asserted about a function that was never reached.
 */
function workspace(): {
  readonly storeRoot: string;
  readonly declaredIds: string[];
  readonly toolset: ReturnType<typeof createGraphToolSet>;
  readonly dispose: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "p42-declared-inputs-"));
  const declaredIds: string[] = [];
  const toolset = createGraphToolSet({
    stateDir: dir,
    onGraphDeclared: (graphId) => {
      declaredIds.push(graphId);
    },
  });
  return {
    storeRoot: engineStateDir(dir),
    declaredIds,
    toolset,
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Run a declaration expected to be REFUSED and return the refusal. */
function refusalOf(declaration: unknown): {
  readonly error: GraphDeclareRefusedError;
  readonly storeFileExists: boolean;
  readonly declaredIds: string[];
  readonly dispose: () => void;
} {
  const fixture = workspace();
  let error: unknown;
  try {
    fixture.toolset.graph_declare({ declaration });
  } catch (caught) {
    error = caught;
  }
  if (!(error instanceof GraphDeclareRefusedError)) {
    fixture.dispose();
    throw new Error("expected graph_declare to refuse this declaration");
  }
  return {
    error,
    storeFileExists: existsSync(graphStoreFilePath(fixture.storeRoot)),
    declaredIds: fixture.declaredIds,
    dispose: fixture.dispose,
  };
}

/** The diagnostic codes one refusal carries. */
function codesOf(error: GraphDeclareRefusedError): string[] {
  return error.diagnostics.map((entry) => entry.code);
}

/** The paths one refusal carries. */
function pathsOf(error: GraphDeclareRefusedError): string[] {
  return error.diagnostics.map((entry) => entry.path);
}

/** The plan the ENTRY persisted for one graph id. */
function storedPlan(storeRoot: string) {
  const reading = readStoredDefinition(storeRoot, GRAPH);
  expect(reading.kind).toBe("ok");
  if (reading.kind !== "ok") throw new Error("the entry persisted no definition");
  return reading.declared.plan;
}

describe("declared inputs enter through the graph_declare entry", () => {
  it("compiles a legal declaration with inputs and pins each (from, outcome)", () => {
    const fixture = workspace();
    try {
      const result = fixture.toolset.graph_declare({
        declaration: chain([{ from: "work", outcome: "done" }]),
      });
      expect(result.graph_id).toBe(GRAPH);
      expect(result.executability).toBe("executable");
      expect(result.persisted).toBe(true);
      expect(fixture.declaredIds).toEqual([GRAPH]);

      const plan = storedPlan(fixture.storeRoot);
      const review = plan.nodes.find((node) => node.id === "review");
      expect(review?.inputs).toEqual([{ from: "work", outcome: "done" }]);
      // The producer declares no inputs of its own.
      const work = plan.nodes.find((node) => node.id === "work");
      expect(work?.inputs).toBeUndefined();
    } finally {
      fixture.dispose();
    }
  });

  it("accepts an EMPTY inputs list and a node with no inputs at all", () => {
    const withEmpty = workspace();
    try {
      const result = withEmpty.toolset.graph_declare({ declaration: chain([]) });
      expect(result.executability).toBe("executable");
      // "Consumes none" is a legal declaration, not a missing field.
      const review = storedPlan(withEmpty.storeRoot).nodes.find(
        (node) => node.id === "review",
      );
      expect(review?.inputs).toBeUndefined();
    } finally {
      withEmpty.dispose();
    }

    const withoutField = workspace();
    try {
      const result = withoutField.toolset.graph_declare({
        declaration: chain(undefined),
      });
      expect(result.executability).toBe("executable");
    } finally {
      withoutField.dispose();
    }
  });

  it("refuses an input naming a node the graph does not declare, before anything is dispatched", () => {
    const refusal = refusalOf(chain([{ from: "ghost", outcome: "done" }]));
    try {
      expect(refusal.error.reason).toBe("invalid-declaration");
      expect(codesOf(refusal.error)).toContain("unknown-input-node");
      // The PINNING refusals carry the compiler's own path convention (the
      // front-end's `$.…` spelling belongs to the shape issues below).
      expect(pathsOf(refusal.error)).toContain("nodes.review.inputs[0]");
      // REFUSED BEFORE ANYTHING HAPPENED: no store was created for it and the
      // declaration seam never fired, so no run was armed.
      expect(refusal.storeFileExists).toBe(false);
      expect(refusal.declaredIds).toEqual([]);
    } finally {
      refusal.dispose();
    }
  });

  it("refuses an outcome the producing node does not declare", () => {
    const refusal = refusalOf(chain([{ from: "work", outcome: "nope" }]));
    try {
      expect(codesOf(refusal.error)).toContain("unknown-input-outcome");
      expect(pathsOf(refusal.error)).toContain("nodes.review.inputs[0]");
      expect(refusal.storeFileExists).toBe(false);
    } finally {
      refusal.dispose();
    }
  });

  it("refuses a producer no declared edge path reaches", () => {
    const refusal = refusalOf(
      chain([{ from: "other", outcome: "spare" }], { extraNode: true }),
    );
    try {
      expect(codesOf(refusal.error)).toContain("input-not-upstream");
      expect(pathsOf(refusal.error)).toContain("nodes.review.inputs");
      expect(refusal.storeFileExists).toBe(false);
    } finally {
      refusal.dispose();
    }
  });
});

describe("the entry's strict grammar covers each input entry", () => {
  it("refuses an unknown key INSIDE an input entry", () => {
    const refusal = refusalOf(
      chain([{ from: "work", outcome: "done", ref: "report.txt" }]),
    );
    try {
      expect(codesOf(refusal.error)).toContain("unknown-key");
      expect(pathsOf(refusal.error)).toContain("$.nodes[1].inputs[0].ref");
      // The refusal names the CLOSED key set, so the repair is unambiguous.
      expect(refusal.error.message).toContain("allowed keys: from, outcome");
    } finally {
      refusal.dispose();
    }
  });

  it("refuses a wrong-typed inputs list and a wrong-typed entry field", () => {
    const notAnArray = refusalOf(chain("work"));
    try {
      expect(codesOf(notAnArray.error)).toContain("wrong-type");
      expect(pathsOf(notAnArray.error)).toContain("$.nodes[1].inputs");
    } finally {
      notAnArray.dispose();
    }

    const badField = refusalOf(chain([{ from: 7, outcome: "done" }]));
    try {
      expect(codesOf(badField.error)).toContain("wrong-type");
      expect(pathsOf(badField.error)).toContain("$.nodes[1].inputs[0].from");
    } finally {
      badField.dispose();
    }
  });

  it("refuses an empty identifier in an input entry", () => {
    const refusal = refusalOf(chain([{ from: "work", outcome: "" }]));
    try {
      expect(codesOf(refusal.error)).toContain("invalid-value");
      expect(pathsOf(refusal.error)).toContain("$.nodes[1].inputs[0].outcome");
    } finally {
      refusal.dispose();
    }
  });
});
