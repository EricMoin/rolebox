/// <reference types="bun-types" />

/**
 * A22 — the CONCRETE capability pre-check.
 *
 * An installed validator IDENTITY is not an installed CAPABILITY. Before this
 * work a plan whose outcome declared a schema the host never registered, or
 * whose `command-exit` requirement had no mapping a trusted policy authorized,
 * still compiled `executable`; the gate then answered a fail-closed but LATE
 * `indeterminate` at acceptance, so the plan could never settle and the operator
 * learned it submission by submission.
 *
 * Every case here resolves the concrete identity against the SAME host
 * capability description the run path holds (`assembleHostCapabilities`), and
 * every negative case asserts the declaration is REFUSED — i.e. blocked before
 * anything can be dispatched. Storage is an isolated temp root per case.
 *
 * @module
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildDeclaredOutcomeGraph,
  GraphDeclareRefusedError,
} from "../../src/graph/tools/declare-graph.ts";
import { compileGraph } from "../../src/graph/compiler/compile.ts";
import {
  assembleHostCapabilities,
  COMMAND_EXIT_VALIDATOR_ID,
  SCHEMA_VALIDATOR_ID,
  SHIPPED_JSON_OBJECT_SCHEMA_ID,
  SHIPPED_JSON_OBJECT_SCHEMA_VERSION,
} from "../../src/graph/policy/acceptance-primitives.ts";
import type { AcceptanceCapabilitySet } from "../../src/graph/outcome/validators.ts";

const GRAPH = "a22.precheck";
const NODE = "work";

/** One isolated host root per case; nothing is shared between cases. */
function withHostRoot<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "a22-precheck-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The shipped assembly, built from an EMPTY operator configuration. */
function shippedAssembly(root: string) {
  return assembleHostCapabilities({
    artifactRoot: root,
    storeRoot: join(root, "store"),
    env: {},
  });
}

type Outcome = Record<string, unknown>;

function declarationFor(outcome: Outcome) {
  return {
    version: 3,
    name: GRAPH,
    nodes: [
      {
        id: NODE,
        agent: "agent.worker",
        prompt: "Produce an outcome.",
        outcomes: [outcome],
      },
    ],
    edges: [],
  };
}

/** A data contract naming the schema the shipped assembly actually installs. */
const installedContract = {
  schema: SHIPPED_JSON_OBJECT_SCHEMA_ID,
  version: SHIPPED_JSON_OBJECT_SCHEMA_VERSION,
};

function describeRefusal(build: () => unknown): string {
  try {
    build();
  } catch (error) {
    if (error instanceof GraphDeclareRefusedError) return error.message;
    throw error;
  }
  throw new Error("expected the declaration to be refused");
}

describe("A22 — a missing CONCRETE capability is refused at declaration, not at submission", () => {
  it("refuses a schema requirement whose declared schema this host never registered", () => {
    withHostRoot((root) => {
      const assembly = shippedAssembly(root);
      // The IDENTITY is installed — only the declared schema is not.
      expect(assembly.capabilities.validators.map((key) => key.id)).toContain(
        SCHEMA_VALIDATOR_ID,
      );
      const withoutSchemas: AcceptanceCapabilitySet = {
        ...assembly.capabilities,
        schemas: [],
      };

      const message = describeRefusal(() =>
        buildDeclaredOutcomeGraph({
          declaration: declarationFor({
            id: "done",
            data: installedContract,
            acceptance: [{ validator: SCHEMA_VALIDATOR_ID, version: 1 }],
          }),
          installedValidators: assembly.validators,
          installedAcceptanceCapabilities: withoutSchemas,
        }),
      );

      // The refusal names the CONCRETE reason — which schema is missing — and
      // not the identity-level "no capability has this name".
      expect(message).toContain("is not installed in this host");
      expect(message).toContain(SHIPPED_JSON_OBJECT_SCHEMA_ID);
      expect(message).not.toContain("no declared capability resolves to an exact installed version");
    });
  });

  it("refuses a command-exit requirement no trusted policy authorizes for its mapping", () => {
    withHostRoot((root) => {
      const assembly = shippedAssembly(root);
      // A trusted command policy IS installed; it simply has no binding for
      // this exact (graph, node, outcome).
      expect(assembly.capabilities.commandMappings).toEqual([]);

      const message = describeRefusal(() =>
        buildDeclaredOutcomeGraph({
          declaration: declarationFor({
            id: "done",
            acceptance: [{ validator: COMMAND_EXIT_VALIDATOR_ID, version: 1 }],
          }),
          installedValidators: assembly.validators,
          installedAcceptanceCapabilities: assembly.capabilities,
        }),
      );

      expect(message).toContain("no trusted command policy authorizes a check for");
      expect(message).toContain(GRAPH);
      expect(message).toContain(NODE);
      expect(message).toContain("done");
    });
  });

  it("refuses a schema requirement whose outcome declares no data contract at all", () => {
    withHostRoot((root) => {
      const assembly = shippedAssembly(root);
      const message = describeRefusal(() =>
        buildDeclaredOutcomeGraph({
          declaration: declarationFor({
            id: "done",
            acceptance: [{ validator: SCHEMA_VALIDATOR_ID, version: 1 }],
          }),
          installedValidators: assembly.validators,
          installedAcceptanceCapabilities: assembly.capabilities,
        }),
      );
      expect(message).toContain("declares no data contract");
    });
  });

  it("compiles the SAME declaration once the concrete capability is installed", () => {
    withHostRoot((root) => {
      const assembly = shippedAssembly(root);
      const graph = buildDeclaredOutcomeGraph({
        declaration: declarationFor({
          id: "done",
          data: installedContract,
          acceptance: [{ validator: SCHEMA_VALIDATOR_ID, version: 1 }],
        }),
        installedValidators: assembly.validators,
        installedAcceptanceCapabilities: assembly.capabilities,
      });
      expect(graph.plan.graphId).toBe(GRAPH);
      expect(graph.plan.nodes.map((node) => node.id)).toEqual([NODE]);

      // ...and the command mapping variant, with the mapping authorized for
      // exactly this (graph, node, outcome).
      const withMapping: AcceptanceCapabilitySet = {
        ...assembly.capabilities,
        commandMappings: [{ graphId: GRAPH, nodeId: NODE, outcome: "done" }],
      };
      const commandGraph = buildDeclaredOutcomeGraph({
        declaration: declarationFor({
          id: "done",
          acceptance: [{ validator: COMMAND_EXIT_VALIDATOR_ID, version: 1 }],
        }),
        installedValidators: assembly.validators,
        installedAcceptanceCapabilities: withMapping,
      });
      expect(commandGraph.plan.graphId).toBe(GRAPH);
    });
  });

  it("a DIFFERENT mapping does not authorize this one (identity, never membership)", () => {
    withHostRoot((root) => {
      const assembly = shippedAssembly(root);
      const otherMapping: AcceptanceCapabilitySet = {
        ...assembly.capabilities,
        commandMappings: [{ graphId: GRAPH, nodeId: "other", outcome: "done" }],
      };
      const message = describeRefusal(() =>
        buildDeclaredOutcomeGraph({
          declaration: declarationFor({
            id: "done",
            acceptance: [{ validator: COMMAND_EXIT_VALIDATOR_ID, version: 1 }],
          }),
          installedValidators: assembly.validators,
          installedAcceptanceCapabilities: otherMapping,
        }),
      );
      expect(message).toContain("no trusted command policy authorizes a check for");
    });
  });

  it("resolution needs BOTH halves: the identity alone still refuses, the identity alone resolves nothing", () => {
    withHostRoot((root) => {
      const assembly = shippedAssembly(root);
      const declaration = declarationFor({
        id: "done",
        data: installedContract,
        acceptance: [{ validator: SCHEMA_VALIDATOR_ID, version: 1 }],
      });

      // Identity-level resolution sees an installed schema@1 and would call
      // this executable — the pre-A22 behaviour, kept for a direct embedder
      // that supplies no concrete description.
      const identityOnly = compileGraph(declaration, {
        supportedValidators: [{ validator: SCHEMA_VALIDATOR_ID, version: 1 }],
      });
      expect(identityOnly.ok).toBe(true);

      // With the concrete description present and the schema missing, the same
      // compilation is a DRAFT carrying the reason.
      const concrete = compileGraph(declaration, {
        supportedValidators: [{ validator: SCHEMA_VALIDATOR_ID, version: 1 }],
        acceptanceCapabilities: { ...assembly.capabilities, schemas: [] },
      });
      expect(concrete.ok).toBe(true);
      if (!concrete.ok) return;
      expect(concrete.kind).toBe("draft");
      if (concrete.kind !== "draft") throw new Error("expected a draft plan");
      expect(concrete.unresolved.map((entry) => entry.reason ?? "")).toEqual([
        expect.stringContaining("is not installed in this host"),
      ]);
    });
  });
});
