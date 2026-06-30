/**
 * Prompt snapshot tests — immutable golden file regression gate.
 *
 * Captures CURRENT output of buildCollaborationBlock, buildSubagentRoleBlock,
 * and buildGraphStateBlock across 4 representative graph topologies and 3
 * execution states each.
 *
 * Run: bun test tests/graph/prompt-snapshots.test.ts
 * Update: bun test --update-snapshots tests/graph/prompt-snapshots.test.ts
 */
import { describe, it, expect } from "bun:test";
import { parseCollaboration } from "../../src/graph/parser";
import { buildGraphStateBlock } from "../../src/graph/state";
import type { GraphExecutionState } from "../../src/graph/state";
import {
  buildCollaborationBlock,
  buildSubagentRoleBlock,
} from "../../src/graph/prompt-builder";
import { computeNodeRole } from "../../src/resolver/orchestrator";
import type { ResolvedGraph } from "../../src/types";

// ── Fixture Configurations ─────────────────────────────────────────

/** review-loop 2-agent (mirrors examples/review-team/role.yaml) */
const COLLAB_REVIEW_2 = {
  topology: "review-loop",
  agents: ["coder", "reviewer"],
  max_iterations: 3,
};

/** review-loop 3-agent */
const COLLAB_REVIEW_3 = {
  topology: "review-loop",
  agents: ["writer", "editor", "publisher"],
  max_iterations: 5,
};

/** star 3-agent */
const COLLAB_STAR = {
  topology: "star",
  agents: ["frontend", "backend", "devops"],
};

/** custom flow with back-edge (mirrors examples/review-team-custom/role.yaml) */
const COLLAB_CUSTOM = {
  flow: [
    "parent -> researcher",
    "researcher -> writer: research findings",
    "writer -> editor: draft content",
    { from: "editor", to: "writer", label: "revision requests" },
    { from: "editor", to: "parent", label: "approved", exit: true },
  ],
  max_iterations: 2,
};

// ── Subagent Metadata ─────────────────────────────────────────────
// (id, name, description triplets matching each fixture's agent list)

const META_REVIEW_2 = [
  { id: "coder", name: "Coder", description: "Writes code" },
  { id: "reviewer", name: "Reviewer", description: "Reviews code" },
];

const META_REVIEW_3 = [
  { id: "writer", name: "Writer", description: "Writes content" },
  { id: "editor", name: "Editor", description: "Edits for clarity" },
  { id: "publisher", name: "Publisher", description: "Publishes final work" },
];

const META_STAR = [
  { id: "frontend", name: "Frontend", description: "Builds UI" },
  { id: "backend", name: "Backend", description: "Builds API" },
  { id: "devops", name: "DevOps", description: "Manages infra" },
];

const META_CUSTOM = [
  { id: "researcher", name: "Researcher", description: "Researches topics" },
  { id: "writer", name: "Writer", description: "Writes content" },
  { id: "editor", name: "Editor", description: "Edits for quality" },
];

// ── Parse graphs once ─────────────────────────────────────────────

let graphs: Record<string, ResolvedGraph> = {};

function parseAll(): void {
  graphs = {
    review2: parseCollaboration(COLLAB_REVIEW_2, ["coder", "reviewer"])!,
    review3: parseCollaboration(COLLAB_REVIEW_3, [
      "writer",
      "editor",
      "publisher",
    ])!,
    star: parseCollaboration(COLLAB_STAR, [
      "frontend",
      "backend",
      "devops",
    ])!,
    custom: parseCollaboration(COLLAB_CUSTOM, [
      "researcher",
      "writer",
      "editor",
    ])!,
  };
}

parseAll();

// ── Graph Execution States (per fixture) ───────────────────────────

type StateTriple = {
  initial: GraphExecutionState;
  mid: GraphExecutionState;
  exhausted: GraphExecutionState;
};

function review2States(): StateTriple {
  return {
    initial: { frontier: ["coder"], completed: [], iterationCount: 0, status: "active" },
    mid: { frontier: ["reviewer"], completed: ["coder"], iterationCount: 0, status: "active" },
    exhausted: { frontier: ["coder"], completed: ["coder", "reviewer"], iterationCount: 4, status: "exhausted" },
  };
}

function review3States(): StateTriple {
  return {
    initial: { frontier: ["writer"], completed: [], iterationCount: 0, status: "active" },
    mid: {
      frontier: ["writer"],
      completed: ["writer", "editor", "publisher"],
      iterationCount: 1,
      status: "active",
    },
    exhausted: {
      frontier: ["writer"],
      completed: ["writer", "editor", "publisher"],
      iterationCount: 6,
      status: "exhausted",
    },
  };
}

function starStates(): StateTriple {
  return {
    initial: {
      frontier: ["frontend", "backend", "devops"],
      completed: [],
      iterationCount: 0,
      status: "active",
    },
    mid: {
      frontier: ["devops"],
      completed: ["frontend", "backend"],
      iterationCount: 0,
      status: "active",
    },
    exhausted: {
      frontier: ["frontend", "backend", "devops"],
      completed: [],
      iterationCount: 1,
      status: "exhausted",
    },
  };
}

function customStates(): StateTriple {
  return {
    initial: { frontier: ["researcher"], completed: [], iterationCount: 0, status: "active" },
    mid: { frontier: ["writer"], completed: ["researcher"], iterationCount: 0, status: "active" },
    exhausted: {
      frontier: ["writer"],
      completed: ["researcher", "writer", "editor"],
      iterationCount: 3,
      status: "exhausted",
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// 1. buildCollaborationBlock snapshots (stable per graph)
// ═══════════════════════════════════════════════════════════════════

describe("buildCollaborationBlock", () => {
  it("review-loop 2-agent (coder, reviewer)", () => {
    expect(buildCollaborationBlock(graphs.review2, META_REVIEW_2)).toMatchSnapshot();
  });

  it("review-loop 3-agent (writer, editor, publisher)", () => {
    expect(buildCollaborationBlock(graphs.review3, META_REVIEW_3)).toMatchSnapshot();
  });

  it("star 3-agent (frontend, backend, devops)", () => {
    expect(buildCollaborationBlock(graphs.star, META_STAR)).toMatchSnapshot();
  });

  it("custom flow with back-edge (researcher, writer, editor)", () => {
    expect(buildCollaborationBlock(graphs.custom, META_CUSTOM)).toMatchSnapshot();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. buildSubagentRoleBlock snapshots (entry / middle / exit)
// ═══════════════════════════════════════════════════════════════════

describe("buildSubagentRoleBlock", () => {
  describe("review-loop 2-agent", () => {
    it("entry (coder)", () => {
      const role = computeNodeRole(graphs.review2, "coder", "coder")!;
      expect(buildSubagentRoleBlock(role)).toMatchSnapshot();
    });

    it("exit (reviewer)", () => {
      const role = computeNodeRole(graphs.review2, "reviewer", "reviewer")!;
      expect(buildSubagentRoleBlock(role)).toMatchSnapshot();
    });
  });

  describe("review-loop 3-agent", () => {
    it("entry (writer)", () => {
      const role = computeNodeRole(graphs.review3, "writer", "writer")!;
      expect(buildSubagentRoleBlock(role)).toMatchSnapshot();
    });

    it("middle (editor)", () => {
      const role = computeNodeRole(graphs.review3, "editor", "editor")!;
      expect(buildSubagentRoleBlock(role)).toMatchSnapshot();
    });

    it("exit (publisher)", () => {
      const role = computeNodeRole(graphs.review3, "publisher", "publisher")!;
      expect(buildSubagentRoleBlock(role)).toMatchSnapshot();
    });
  });

  describe("star 3-agent", () => {
    it("entry/exit (frontend)", () => {
      const role = computeNodeRole(graphs.star, "frontend", "frontend")!;
      expect(buildSubagentRoleBlock(role)).toMatchSnapshot();
    });

    it("entry/exit (backend)", () => {
      const role = computeNodeRole(graphs.star, "backend", "backend")!;
      expect(buildSubagentRoleBlock(role)).toMatchSnapshot();
    });

    it("entry/exit (devops)", () => {
      const role = computeNodeRole(graphs.star, "devops", "devops")!;
      expect(buildSubagentRoleBlock(role)).toMatchSnapshot();
    });
  });

  describe("custom flow with back-edge", () => {
    it("entry (researcher)", () => {
      const role = computeNodeRole(graphs.custom, "researcher", "researcher")!;
      expect(buildSubagentRoleBlock(role)).toMatchSnapshot();
    });

    it("middle (writer)", () => {
      const role = computeNodeRole(graphs.custom, "writer", "writer")!;
      expect(buildSubagentRoleBlock(role)).toMatchSnapshot();
    });

    it("exit (editor)", () => {
      const role = computeNodeRole(graphs.custom, "editor", "editor")!;
      expect(buildSubagentRoleBlock(role)).toMatchSnapshot();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. buildGraphStateBlock snapshots (initial / mid-loop / exhausted)
// ═══════════════════════════════════════════════════════════════════

describe("buildGraphStateBlock", () => {
  describe("review-loop 2-agent", () => {
    const s = review2States();

    it("initial (just parsed)", () => {
      expect(buildGraphStateBlock(s.initial, graphs.review2)).toMatchSnapshot();
    });

    it("mid-loop (frontier moved)", () => {
      expect(buildGraphStateBlock(s.mid, graphs.review2)).toMatchSnapshot();
    });

    it("exhausted (iteration cap hit)", () => {
      expect(buildGraphStateBlock(s.exhausted, graphs.review2)).toMatchSnapshot();
    });
  });

  describe("review-loop 3-agent", () => {
    const s = review3States();

    it("initial (just parsed)", () => {
      expect(buildGraphStateBlock(s.initial, graphs.review3)).toMatchSnapshot();
    });

    it("mid-loop (after one full loop)", () => {
      expect(buildGraphStateBlock(s.mid, graphs.review3)).toMatchSnapshot();
    });

    it("exhausted (iteration cap hit)", () => {
      expect(buildGraphStateBlock(s.exhausted, graphs.review3)).toMatchSnapshot();
    });
  });

  describe("star 3-agent", () => {
    const s = starStates();

    it("initial (all workers in frontier)", () => {
      expect(buildGraphStateBlock(s.initial, graphs.star)).toMatchSnapshot();
    });

    it("mid-loop (one worker remaining)", () => {
      expect(buildGraphStateBlock(s.mid, graphs.star)).toMatchSnapshot();
    });

    it("exhausted (simulated)", () => {
      expect(buildGraphStateBlock(s.exhausted, graphs.star)).toMatchSnapshot();
    });
  });

  describe("custom flow with back-edge", () => {
    const s = customStates();

    it("initial (just parsed)", () => {
      expect(buildGraphStateBlock(s.initial, graphs.custom)).toMatchSnapshot();
    });

    it("mid-loop (first agent completed)", () => {
      expect(buildGraphStateBlock(s.mid, graphs.custom)).toMatchSnapshot();
    });

    it("exhausted (iteration cap hit)", () => {
      expect(buildGraphStateBlock(s.exhausted, graphs.custom)).toMatchSnapshot();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Determinism verification (re-run produces identical output)
// ═══════════════════════════════════════════════════════════════════

describe("determinism", () => {
  it("buildCollaborationBlock is deterministic for review-loop 2-agent", () => {
    const a = buildCollaborationBlock(graphs.review2, META_REVIEW_2);
    const b = buildCollaborationBlock(graphs.review2, META_REVIEW_2);
    expect(a).toBe(b);
  });

  it("buildSubagentRoleBlock is deterministic for entry agent", () => {
    const role = computeNodeRole(graphs.review2, "coder", "coder")!;
    const a = buildSubagentRoleBlock(role);
    const b = buildSubagentRoleBlock(role);
    expect(a).toBe(b);
  });

  it("buildGraphStateBlock is deterministic for exhausted state", () => {
    const s = review2States();
    const a = buildGraphStateBlock(s.exhausted, graphs.review2);
    const b = buildGraphStateBlock(s.exhausted, graphs.review2);
    expect(a).toBe(b);
  });
});
