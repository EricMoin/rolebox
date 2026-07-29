/**
 * `rolebox migrate` — roadmap test standard #3.
 *
 * Runs `migrate` against every examples/review-team-star role.yaml (all the
 * review-team example dirs, enumerated via glob) and verifies the
 * generated `graph:` block deserializes (via parser-v2) to an equivalent
 * topology: same node count, same edge directions, same loop cap
 * (max_traversals == max_iterations), with the original `collaboration:`
 * preserved as YAML comments.
 *
 * Each example is copied to a temp directory — the real examples/ files are
 * never mutated.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import yaml from "js-yaml";
import { migrate } from "../../../src/cli/commands/migrate";
import { convertCollaborationToGraphDeclaration } from "../../../src/graph/collaboration-bridge";
import { parseGraph } from "../../../src/graph/parser-v2";
import { PARENT_NODE } from "../../../src/constants";
import type { CollaborationConfig } from "../../../src/types";

const ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const EXAMPLES_DIR = join(ROOT, "examples");

const PARENT_AGENT_ID = "emperor--parent";

const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-migrate-"));
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Example discovery (enumerate via glob; nothing hard-coded) ────────────

function reviewTeamExampleDirs(): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(EXAMPLES_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^review-team/.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    entries = [];
  }
  // Keep only dirs that actually contain a role.yaml.
  return entries.filter((dir) => existsSync(join(EXAMPLES_DIR, dir, "role.yaml")));
}

const EXAMPLE_DIRS = reviewTeamExampleDirs();

// ── Topology helpers ──────────────────────────────────────────────────────

/** Agent (non-terminal) node ids in the declaration. */
function agentNodeIds(decl: { nodes: { id: string }[] }): string[] {
  return decl.nodes.filter((n) => n.id !== PARENT_NODE).map((n) => n.id);
}

/** `from->to` keys of every edge in the declaration. */
function edgeKeys(decl: { edges: { from: string; to: string }[] }): string[] {
  return decl.edges.map((e) => `${e.from}->${e.to}`);
}

/** Max traversals of every loop group, sorted (or empty when acyclic). */
function loopCaps(decl: { loop_groups?: { max_traversals: number }[] }): number[] {
  return (decl.loop_groups ?? []).map((g) => g.max_traversals).sort((a, b) => a - b);
}

// ── Migration equivalence (roadmap test #3) ───────────────────────────────

describe("migrate — every examples/review-team*/role.yaml produces an equivalent graph", () => {
  it("discovered review-team example directories via glob", () => {
    expect(EXAMPLE_DIRS.length).toBeGreaterThan(0);
  });

  for (const dir of EXAMPLE_DIRS) {
    const originalPath = join(EXAMPLES_DIR, dir, "role.yaml");
    const originalText = readFileSync(originalPath, "utf-8");
    const originalDoc = yaml.load(originalText) as Record<string, unknown>;

    it(`${dir} — equivalent topology + collaboration preserved as comments`, () => {
      // Expected topology: convert the ORIGINAL collaboration config directly.
      const collab = originalDoc.collaboration as unknown as CollaborationConfig;
      const roleName = String(originalDoc.name ?? dir);
      const expected = convertCollaborationToGraphDeclaration(collab, {
        parentAgentId: PARENT_AGENT_ID,
        name: roleName,
      });

      // Run the command on a TEMP COPY — never the real example file.
      const copy = join(tmpDir, `${dir}-copy.yaml`);
      copyFileSync(originalPath, copy);

      const result = migrate(copy, PARENT_AGENT_ID);
      expect(result.action).toBe("migrated");

      // Original file on disk is untouched.
      expect(readFileSync(originalPath, "utf-8")).toBe(originalText);

      // Collaboration preserved as comments; active graph block present.
      const migratedText = readFileSync(copy, "utf-8");
      expect(migratedText).toMatch(/# legacy collaboration:/);
      // No active collaboration: key remains (it was commented out).
      const migratedDoc = yaml.load(migratedText) as Record<string, unknown>;
      expect(migratedDoc.collaboration).toBeUndefined();
      expect(migratedDoc.graph).toBeDefined();

      // Deserialize the graph: block via parser-v2.
      const parsed = parseGraph(migratedText);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const actual = parsed.graph;

      // Same node count + same agent node set.
      expect(actual.nodes.length).toBe(expected.nodes.length);
      expect([...agentNodeIds(actual)].sort()).toEqual([...agentNodeIds(expected)].sort());

      // Same edge directions (independent of order).
      expect([...edgeKeys(actual)].sort()).toEqual([...edgeKeys(expected)].sort());

      // Same loop cap: max_traversals == max_iterations in every loop group.
      expect(loopCaps(actual)).toEqual(loopCaps(expected));

      // Termination, when present, is propagated (topology-level comparison).
      expect(actual.termination ?? undefined).toEqual(expected.termination ?? undefined);
    });
  }
});

// ── No-op behavior ────────────────────────────────────────────────────────

describe("migrate — no-op", () => {
  it("no-ops when collaboration: is absent", () => {
    const copy = join(tmpDir, "no-collab.yaml");
    writeFileSync(copy, "name: Solo\nprompt: do it\n", "utf-8");
    const result = migrate(copy);
    expect(result.action).toBe("no-op");
    expect(readFileSync(copy, "utf-8")).toBe("name: Solo\nprompt: do it\n");
  });

  it("no-ops when graph: is already present", () => {
    const copy = join(tmpDir, "has-graph.yaml");
    writeFileSync(
      copy,
      "name: HasGraph\ncollaboration:\n  agents: [a]\ngraph:\n  version: 2\n  name: HasGraph\n  nodes: []\n  edges: []\n",
      "utf-8",
    );
    const before = readFileSync(copy, "utf-8");
    const result = migrate(copy);
    expect(result.action).toBe("no-op");
    expect(result.reason).toBe("graph block already present");
    expect(readFileSync(copy, "utf-8")).toBe(before);
  });
});
