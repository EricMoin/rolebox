/**
 * `graph_*` tool registration — the outcome run path's tool face.
 *
 * The legacy construction/execution entries are gone with the legacy runtime,
 * so the shipped face is exactly four keys: `graph_declare`,
 * `graph_submit_outcome`, `graph_audit` and `graph_status`. This file pins
 * that key set, the zod arg schemas around the surviving methods, the
 * declare end-to-end execution, and the absence of the deleted keys from the
 * canonical tool assembly.
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { buildCanonicalTools } from "../../src/platform/tool-assembly.ts";
import type { BuildToolsOptions } from "../../src/platform/tool-assembly.ts";
import type { CanonicalToolContext, CanonicalToolDef } from "../../src/platform/types.ts";
import { createOutcomeGraphTools } from "../../src/graph/tools/index.ts";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import type { ResolvedRole } from "../../src/types.ts";
import { opencodeCapabilities } from "../../src/platform/capabilities.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeResolvedRole(): ResolvedRole {
  return {
    id: "test-role",
    config: { name: "Test Role", description: "A minimal test role", prompt: "You are a test role." },
    prompt: "You are a test role.",
    skills: [],
    functions: [],
    references: [],
    subagents: [],
  } as ResolvedRole;
}

function makeBaseOpts(): BuildToolsOptions {
  return {
    resolvedRoles: [makeResolvedRole()],
    directory: "/tmp/test",
    capabilities: opencodeCapabilities(),
  };
}

/** The OUTCOME run path's tool face a shipping host registers. */
const OUTCOME_GRAPH_KEYS = [
  "graph_declare",
  "graph_submit_outcome",
  "graph_audit",
  "graph_status",
  // THE ONE EXPLICIT CONTROL ENTRY (P3 item 1). It is part of the shipped face
  // and NOT part of what a dispatched worker is granted: the host's own worker
  // boundary refuses it before its body runs (see worker-tool-face.test.ts).
  "graph_control",
];

/** The legacy execution entries that no longer exist. */
const LEGACY_GRAPH_KEYS = [
  "graph_create",
  "graph_add_node",
  "graph_add_edge",
  "graph_add_loop",
  "graph_run",
  "graph_cancel",
  "graph_approve",
];

/** A stand-in for the host-built outcome tool face. */
function makeOutcomeTools(): Record<string, CanonicalToolDef> {
  return Object.fromEntries(
    OUTCOME_GRAPH_KEYS.map((key) => [
      key,
      {
        description: key,
        args: {},
        async execute() {
          return "{}";
        },
      } as CanonicalToolDef,
    ]),
  );
}

function makeContext(): CanonicalToolContext {
  return { sessionID: "ses-test" } as unknown as CanonicalToolContext;
}

// ── createOutcomeGraphTools: schema shape ───────────────────────────────────

describe("createOutcomeGraphTools", () => {
  it("returns exactly the outcome-path tools, control included", () => {
    const tools = createOutcomeGraphTools(createGraphToolSet({ directory: "/tmp" }));
    expect(Object.keys(tools).sort()).toEqual([...OUTCOME_GRAPH_KEYS].sort());
  });

  it("wraps each tool with a zod args schema and an execute fn", () => {
    const tools = createOutcomeGraphTools(createGraphToolSet({ directory: "/tmp" }));
    for (const def of Object.values(tools)) {
      expect(typeof def.description).toBe("string");
      expect(def.args).toBeDefined();
      expect(typeof def.execute).toBe("function");
    }
  });

  it("graph_status exposes a summary/tree/json format enum", () => {
    const { graph_status } = createOutcomeGraphTools(createGraphToolSet({ directory: "/tmp" }));
    const format = graph_status.args.format as z.ZodType<unknown>;
    expect(format).toBeInstanceOf(z.ZodOptional);
    const inner = (format as unknown as { _def: { innerType: z.ZodEnum<Record<string, string>> } })._def.innerType;
    expect(inner.options).toEqual(["summary", "tree", "json"]);
    expect(inner.parse("tree")).toBe("tree");
    expect(() => inner.parse("invalid")).toThrow();
  });

  it("graph_status no longer exposes the legacy pending-approvals view", () => {
    const { graph_status } = createOutcomeGraphTools(createGraphToolSet({ directory: "/tmp" }));
    expect(graph_status.args.pending_approvals).toBeUndefined();
  });

  it("graph_control exposes the explicit command vocabulary and no principal argument", () => {
    const { graph_control } = createOutcomeGraphTools(createGraphToolSet({ directory: "/tmp" }));
    // THE COMMANDS ARE EXPLICIT: a closed enum, never inferred from worker data.
    const command = graph_control.args.command as z.ZodType<unknown>;
    expect(command.safeParse("failure").success).toBe(true);
    expect(command.safeParse("cancel").success).toBe(true);
    expect(command.safeParse("timeout").success).toBe(true);
    expect(command.safeParse("retry").success).toBe(true);
    expect(command.safeParse("budget-stop").success).toBe(true);
    // THE APPROVAL COMMANDS ARE EXPLICIT MEMBERS OF THE SAME CLOSED ENUM (P3 item
    // 3): a pause and the two decisions that answer it, never inferred from a
    // submitted payload.
    expect(command.safeParse("approval-request").success).toBe(true);
    expect(command.safeParse("approve").success).toBe(true);
    expect(command.safeParse("reject").success).toBe(true);
    expect(command.safeParse("stop").success).toBe(false);
    expect(command.safeParse("failed").success).toBe(false);
    expect(command.safeParse("approved").success).toBe(false);
    // The minimum a trusted caller states: which graph, which command, why, and
    // optionally which node/attempt — plus, for an approval request, WHO may
    // decide it and WHEN it expires.
    expect(Object.keys(graph_control.args).sort()).toEqual([
      "approver_session_id",
      "attempt_id",
      "command",
      "expires_at",
      "graph_id",
      "node_id",
      "reason",
    ]);
    // NO PRINCIPAL ARGUMENT EXISTS: the caller is the session the platform
    // attributed to the call, never a field it can set. The APPROVER is not a
    // principal argument either — it is the session a request names, and the
    // decision is checked against the call's own attribution.
    expect(graph_control.args.session_id).toBeUndefined();
    expect(graph_control.args.principal).toBeUndefined();
    expect(graph_control.args.decided_by).toBeUndefined();
    expect(graph_control.args.approved).toBeUndefined();
  });

  it("graph_declare exposes the declaration ingress args", () => {
    const { graph_declare } = createOutcomeGraphTools(createGraphToolSet({ directory: "/tmp" }));
    expect(graph_declare.args.declaration).toBeDefined();
    expect(graph_declare.args.graph_id).toBeInstanceOf(z.ZodOptional);
    expect(graph_declare.args.supported_validators).toBeInstanceOf(z.ZodOptional);
    const declaration = graph_declare.args.declaration as z.ZodType<unknown>;
    expect(declaration.safeParse("not json {").success).toBe(true);
    expect(declaration.safeParse({ version: 3 }).success).toBe(true);
    expect(declaration.safeParse(42).success).toBe(true);
    expect(declaration.safeParse(undefined).success).toBe(false);
  });

  it("graph_submit_outcome exposes exactly the minimum model-facing args", () => {
    const { graph_submit_outcome } = createOutcomeGraphTools(createGraphToolSet({ directory: "/tmp" }));
    expect(Object.keys(graph_submit_outcome.args).sort()).toEqual([
      "credential",
      "data",
      "evidence_refs",
      "graph_id",
      "node_id",
      "outcome_id",
    ]);
    expect(graph_submit_outcome.args.attempt_id).toBeUndefined();
    expect(graph_submit_outcome.args.submission_id).toBeUndefined();
    expect(graph_submit_outcome.args.plan_revision).toBeUndefined();
    expect(graph_submit_outcome.args.credential).toBeInstanceOf(z.ZodOptional);
  });

  it("graph_audit takes no arguments", () => {
    const { graph_audit } = createOutcomeGraphTools(createGraphToolSet({ directory: "/tmp" }));
    expect(Object.keys(graph_audit.args)).toEqual([]);
  });

  it("executes graph_declare end-to-end: parses, compiles, persists and reports the run path", async () => {
    const { graph_declare } = createOutcomeGraphTools(createGraphToolSet({ directory: "/tmp" }));
    const out = await graph_declare.execute(
      {
        declaration: {
          version: 3,
          name: "reg-declare",
          nodes: [
            { id: "a", agent: "agent.a", prompt: "Do a.", outcomes: [{ id: "done" }] },
          ],
          edges: [],
        },
      },
      makeContext(),
    );
    expect(typeof out).toBe("string");
    const parsed = JSON.parse(out as string);
    expect(parsed.graph_id).toBe("reg-declare");
    expect(parsed.executability).toBe("executable");
    expect(parsed.runnable).toBe(true);
    expect(parsed.run_path).toContain("OUTCOME run path");
    // No stateDir is configured for this tool set → the plan is registered in
    // memory only, reported honestly.
    expect(parsed.persisted).toBe(false);
  });
});

// ── Canonical assembly ──────────────────────────────────────────────────────

describe("buildCanonicalTools + the outcome graph tool face", () => {
  it("registers the four outcome keys and no legacy graph key", () => {
    const tools = buildCanonicalTools({
      ...makeBaseOpts(),
      outcomeGraphTools: makeOutcomeTools(),
    });
    const graphKeys = Object.keys(tools).filter((key) => key.startsWith("graph_"));
    expect(graphKeys.sort()).toEqual([...OUTCOME_GRAPH_KEYS].sort());
    for (const legacy of LEGACY_GRAPH_KEYS) {
      expect(tools[legacy]).toBeUndefined();
    }
  });
});
