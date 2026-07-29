/**
 * Graph Execution Engine v2 — Subtask 2: `collaboration:` auto-conversion.
 *
 * Verifies `autoConvertCollaboration` (src/graph/collaboration-bridge.ts):
 *   (a) returns the SAME v2 `GraphDeclaration` as an explicit
 *       `convertCollaborationToGraphDeclaration` call — the auto-convert
 *       bridge delegates losslessly to the subtask-1 converter;
 *   (b) a deprecation warning is logged, noting `collaboration:` is a legacy
 *       import path auto-converted to the v2 imperative `graph_*` / `graph:`
 *       schema.
 *
 * Test criterion (c) — the auto-converted declaration bridges back to a legacy
 * `ResolvedGraph` with the same topology — is checked here, mirroring what the
 * removed `parseCollaboration` path used to resolve.
 *
 * Logging capture note: tslog snapshots each logger's transport array at
 * construction (BaseLogger.js:608), so the module-level `log` in parser.ts
 * would not forward to a transport attached afterwards. The deprecation is
 * therefore routed through the live `rootLogger` proxy, which resolves the
 * root logger at call time — so a transport attached to `getRootLogger()`
 * observes the warning regardless of module import order.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  autoConvertCollaboration,
  graphDeclarationToResolvedGraph,
} from "../../src/graph/collaboration-bridge";
import { convertCollaborationToGraphDeclaration } from "../../src/graph/collaboration-bridge";
import { getRootLogger } from "../../src/logger";
import type { ILogObj } from "tslog";
import type { CollaborationConfig } from "../../src/types";
import type { GraphDeclaration } from "../../src/types.graph-v2";

const PARENT_AGENT_ID = "emperor--parent";
const ROLE_NAME = "my-graph-role";

let captured: ILogObj[] = [];

beforeEach(() => {
  captured = [];
  const root = getRootLogger();
  root.attachTransport((logObj) => {
    captured.push(logObj);
  });
});

/** Configs covering template expansion, explicit flow, cycles, and termination. */
const COLLAB_CASES: { name: string; collab: CollaborationConfig }[] = [
  {
    name: "pipeline template",
    collab: { topology: "pipeline", agents: ["a", "b", "c"], max_iterations: 5 },
  },
  {
    name: "review-loop template (default cap)",
    collab: { topology: "review-loop", agents: ["coder", "reviewer"] },
  },
  {
    name: "explicit flow with exit edge and termination",
    // String flow entries are accepted at runtime by parseFlow; the wider
    // shape is cast to the narrower CollaborationConfig type (as in
    // converter.test.ts:98-107).
    collab: {
      flow: [
        "parent -> researcher",
        "researcher -> writer: research findings",
        { from: "writer", to: "researcher", label: "revise" },
        { from: "writer", to: "parent", label: "approved", exit: true },
      ],
      max_iterations: 2,
      termination: { any_of: [{ converged: "writer" }] },
    } as unknown as CollaborationConfig,
  },
  {
    name: "star template",
    collab: { topology: "star", agents: ["x", "y", "z"], max_iterations: 2 },
  },
];

// ── (a) Same GraphDeclaration as the explicit converter ────────────────────

describe("autoConvertCollaboration — delegates to convertCollaborationToGraphDeclaration", () => {
  for (const { name, collab } of COLLAB_CASES) {
    it(`produces the identical declaration for "${name}"`, () => {
      const explicit = convertCollaborationToGraphDeclaration(collab, {
        parentAgentId: PARENT_AGENT_ID,
        name: ROLE_NAME,
      });
      const auto = autoConvertCollaboration(collab, {
        parentAgentId: PARENT_AGENT_ID,
        roleName: ROLE_NAME,
      });

      expect(auto.version).toBe(2);
      expect(auto.name).toBe(ROLE_NAME);
      expect(auto).toEqual(explicit);
    });
  }
});

// ── (b) Deprecation warning is logged ──────────────────────────────────────

describe("autoConvertCollaboration — deprecation warning", () => {
  it("logs a deprecation notice naming the legacy import path", () => {
    const before = captured.length;
    autoConvertCollaboration(
      { topology: "pipeline", agents: ["a", "b"] },
      { parentAgentId: PARENT_AGENT_ID, roleName: ROLE_NAME },
    );

    const delta = captured.slice(before);
    expect(delta.length).toBeGreaterThan(0);

    const text = delta.map((e) => String(e[0] ?? "")).join("\n");
    expect(text).toMatch(/collaboration:/);
    expect(text).toMatch(/legacy/);
    expect(text).toMatch(/graph_*|graph:/);
  });
});

// ── (c) auto-converted declaration bridges back to a legacy ResolvedGraph ──

describe("autoConvertCollaboration — legacy path intact", () => {
  it("bridges back to the same ResolvedGraph topology (still resolves)", () => {
    const collab: CollaborationConfig = {
      topology: "review-loop",
      agents: ["coder", "reviewer"],
      max_iterations: 4,
    };
    const decl = autoConvertCollaboration(collab, {
      parentAgentId: PARENT_AGENT_ID,
      roleName: ROLE_NAME,
    });
    const graph = graphDeclarationToResolvedGraph(decl);
    expect(graph).not.toBeNull();
    expect(graph!.nodes.sort()).toEqual(["coder", "reviewer"]);
    expect(graph!.maxIterations).toBe(4);
  });

  it("auto-convert returns a GraphDeclaration, not the legacy ResolvedGraph shape", () => {
    const collab: CollaborationConfig = {
      topology: "pipeline",
      agents: ["a", "b"],
    };
    const decl = autoConvertCollaboration(collab, {
      parentAgentId: PARENT_AGENT_ID,
      roleName: ROLE_NAME,
    });
    // v2 declaration shape: version + nodes + edges.
    const g: GraphDeclaration = decl;
    expect(g.version).toBe(2);
    expect(g.nodes.length).toBeGreaterThan(0);
    expect(g.edges.length).toBeGreaterThan(0);
  });
});
