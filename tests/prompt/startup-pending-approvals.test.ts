/**
 * Startup pending-approvals reminder (subtask 4).
 *
 * Verifies the startup aggregation path wired in `src/pi-extension.ts`:
 * - `collectStartupPendingApprovals(stateDir)` enumerates every `blocked`
 *   `needs_approval` gate recovered from the persisted store;
 * - `buildPendingApprovalsReminder(pending)` produces EXACTLY one
 *   `[PENDING APPROVALS]` reminder listing each gate's graph_id, node_id, and a
 *   paste-ready `graph_approve` call;
 * - with a mock session client, the injected reminder is delivered via
 *   `enqueueNotify` with `noReply: false` (emperor wakes to decide);
 * - zero pending gates ⇒ empty reminder text ⇒ silent no-op (no prompt sent);
 * - the new marker belongs to DISPATCH_NOTIFICATION_MARKERS so the re-entering
 *   chat.message hook treats it as a non-user turn and does NOT reset the
 *   auto-continue counter (see tests/hooks/chat-message.test.ts for the hook
 *   that keys on isDispatchNotification).
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type { ISessionClient } from "../../src/platform/ports/session-client.ts";
import { createEngineState } from "../../src/graph/engine/engine-state.ts";
import { EnginePhase } from "../../src/constants.ts";
import { EnginePersistence } from "../../src/graph/engine/engine-persistence.ts";
import {
  collectStartupPendingApprovals,
  buildPendingApprovalsReminder,
} from "../../src/pi-extension.ts";
import {
  DISPATCH_NOTIFICATION_MARKERS,
  PENDING_APPROVALS_MARKER,
  enqueueNotify,
  isDispatchNotification,
  clearParentQueues,
} from "../../src/dispatch/notification.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const EMPEROR_SESSION = "emperor-session-1";
const T0 = 1_700_000_000_000;

function declaration(name: string, nodeId: string, agent: string): GraphDeclaration {
  return {
    version: 2,
    name,
    nodes: [{ id: nodeId, agent, prompt: "decide", needs_approval: true }],
    edges: [],
  };
}

/** Build a persisted state with one blocked needs_approval gate. */
function persistBlockedGraph(stateDir: string, graphId: string, nodeId: string, agent: string): void {
  const state = createEngineState(declaration(graphId, nodeId, agent), graphId);
  state.phase = EnginePhase.Executing;
  state.startedAt = T0;
  state.updatedAt = T0;
  state.nodes.set(nodeId, {
    nodeId,
    agent,
    prompt: "decide",
    needsApproval: true,
    status: NodeStatus.Blocked,
    signalsObserved: {
      approval_payload: {
        node_id: nodeId,
        timestamp: "2026-07-24T10:00:00.000Z",
      },
    },
    sessionsSpawned: 0,
    tokensConsumed: { inputTokens: 0, outputTokens: 0, cost: 0 },
    upstreamResults: new Map(),
    joinStrategy: "all",
    joinSatisfied: true,
    traversalCount: 0,
    startedAt: T0,
    retryCount: 0,
  });
  new EnginePersistence(stateDir).save(state);
}

/** Minimal fake session client capturing prompts, mirrors graph-notify.test.ts. */
class FakeSessionClient implements ISessionClient {
  prompts: Array<{ id: string; text: string; noReply?: boolean }> = [];

  async prompt(
    id: string,
    options: { parts: Array<{ type: string; text: string }>; noReply?: boolean },
  ): Promise<{ id: string } | null> {
    this.prompts.push({
      id,
      text: options.parts.map((p) => p.text).join("\n"),
      noReply: options.noReply,
    });
    return { id };
  }

  async list(): Promise<never> {
    throw new Error("not implemented");
  }
  async get(): Promise<never> {
    throw new Error("not implemented");
  }
  async messages(): Promise<never> {
    throw new Error("not implemented");
  }
  async children(): Promise<never> {
    throw new Error("not implemented");
  }
  async todo(): Promise<never> {
    throw new Error("not implemented");
  }
  async diff(): Promise<never> {
    throw new Error("not implemented");
  }
  async fork(): Promise<never> {
    throw new Error("not implemented");
  }
  async status(): Promise<never> {
    throw new Error("not implemented");
  }
  async promptSync(): Promise<never> {
    throw new Error("not implemented");
  }
  async create(): Promise<never> {
    throw new Error("not implemented");
  }
  async abort(): Promise<never> {
    throw new Error("not implemented");
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("collectStartupPendingApprovals", () => {
  it("enumerates a persisted blocked gate", () => {
    const dir = mkdtempSync(join(tmpdir(), "startup-pending-"));
    try {
      persistBlockedGraph(dir, "wf", "gate", "agent-p");
      const pending = collectStartupPendingApprovals(dir);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ graphId: "wf", nodeId: "gate", agent: "agent-p" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty for a store with no blocked gates", () => {
    const dir = mkdtempSync(join(tmpdir(), "startup-empty-"));
    try {
      const pending = collectStartupPendingApprovals(dir);
      expect(pending).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildPendingApprovalsReminder", () => {
  it("emits an empty string for zero pending gates (silent no-op)", () => {
    expect(buildPendingApprovalsReminder([])).toBe("");
  });

  it("emits exactly one reminder with marker, graph_id, node_id, and graph_approve call", () => {
    const dir = mkdtempSync(join(tmpdir(), "startup-text-"));
    try {
      persistBlockedGraph(dir, "wf", "gate", "agent-p");
      const pending = collectStartupPendingApprovals(dir);
      const reminder = buildPendingApprovalsReminder(pending);

      expect(reminder).toContain(PENDING_APPROVALS_MARKER);
      expect(reminder).toContain("wf");
      expect(reminder).toContain("gate");
      expect(reminder).toContain(
        `graph_approve(graph_id="wf", node_id="gate", action="approve")`,
      );
      // A single aggregated block, not one per gate.
      expect(reminder.split(PENDING_APPROVALS_MARKER).length - 1).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("startup injection via enqueueNotify", () => {
  it("delivers exactly one noReply:false reminder through the queue", async () => {
    clearParentQueues();
    const dir = mkdtempSync(join(tmpdir(), "startup-inject-"));
    try {
      persistBlockedGraph(dir, "wf", "gate", "agent-p");
      const client = new FakeSessionClient();

      const pending = collectStartupPendingApprovals(dir);
      const reminder = buildPendingApprovalsReminder(pending);

      // Mirrors the wiring in pi-extension.ts: no injection when empty.
      if (reminder !== "") {
        await enqueueNotify(EMPEROR_SESSION, async () => {
          await client.prompt(EMPEROR_SESSION, {
            parts: [{ type: "text", text: reminder }],
            noReply: false,
          });
          return true;
        });
      }

      expect(client.prompts).toHaveLength(1);
      expect(client.prompts[0].id).toBe(EMPEROR_SESSION);
      expect(client.prompts[0].noReply).toBe(false);
      expect(client.prompts[0].text).toContain(PENDING_APPROVALS_MARKER);
      expect(client.prompts[0].text).toContain("graph_approve");
    } finally {
      clearParentQueues();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends zero reminders when no gate is pending", async () => {
    clearParentQueues();
    const dir = mkdtempSync(join(tmpdir(), "startup-noinject-"));
    try {
      const client = new FakeSessionClient();
      const pending = collectStartupPendingApprovals(dir);
      const reminder = buildPendingApprovalsReminder(pending);

      if (reminder !== "") {
        await enqueueNotify(EMPEROR_SESSION, async () => {
          await client.prompt(EMPEROR_SESSION, {
            parts: [{ type: "text", text: reminder }],
            noReply: false,
          });
          return true;
        });
      }

      expect(client.prompts).toHaveLength(0);
    } finally {
      clearParentQueues();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("PENDING_APPROVALS_MARKER and auto-continue safety", () => {
  it("is a member of DISPATCH_NOTIFICATION_MARKERS", () => {
    expect(DISPATCH_NOTIFICATION_MARKERS).toContain(PENDING_APPROVALS_MARKER);
  });

  it("is recognized as a dispatch notification (non-user turn)", () => {
    // The chat.message hook uses isDispatchNotification to detect auto-injected
    // reminders so they do NOT reset the auto-continue counter (see
    // tests/hooks/chat-message.test.ts). Membership here is what guarantees the
    // startup reminder never spins the loop-cancel counter.
    expect(isDispatchNotification(PENDING_APPROVALS_MARKER)).toBe(true);
    expect(isDispatchNotification(`<system-reminder>\n${PENDING_APPROVALS_MARKER}\n</system-reminder>`)).toBe(true);
  });
});
