/// <reference types="bun-types" />
import { describe, it, expect } from "bun:test";
import { createSignalTool } from "../../src/signal/signal-tool.ts";
import type { CanonicalToolContext } from "../../src/platform/types.ts";

// Minimal tool context for isolated tool tests
const makeContext = (): CanonicalToolContext => ({
  sessionID: "test-session",
  messageID: "msg-001",
  agent: "test-agent",
  directory: "/tmp",
  worktree: "/tmp",
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
});

// The 8 signal type enum values — verified against the real source at
// src/signal/signal-tool.ts:12-21
const SIGNAL_TYPES = [
  "answer",
  "need_approval",
  "blocked",
  "need_clarification",
  "handoff",
  "progress",
  "revise_needed",
  "escalate",
] as const;

// Confirmation format verified against src/signal/signal-tool.ts:25
const expectedConfirmation = (type: string) => `signal: ${type} acknowledged`;

describe("signal tool", () => {
  const tool = createSignalTool();
  const ctx = makeContext();

  it("returns a CanonicalToolDef with description, args, and execute", () => {
    expect(tool).toHaveProperty("description");
    expect(typeof tool.description).toBe("string");
    expect(tool).toHaveProperty("args");
    expect(tool).toHaveProperty("execute");
    expect(typeof tool.execute).toBe("function");
  });

  describe("all 8 signal types", () => {
    for (const signalType of SIGNAL_TYPES) {
      it(`emits correct confirmation string for type "${signalType}"`, async () => {
        const result = await tool.execute({ type: signalType }, ctx);
        expect(result).toBe(expectedConfirmation(signalType));
      });
    }
  });

  it("does not throw for any signal type", async () => {
    for (const signalType of SIGNAL_TYPES) {
      const result = await tool.execute({ type: signalType }, ctx);
      // The execute function returns a value — we assert it didn't throw by
      // reaching this assertion
      expect(result).toBeDefined();
    }
  });

  describe("payload handling (optional)", () => {
    it("works without a payload", async () => {
      const result = await tool.execute({ type: "answer" }, ctx);
      expect(result).toBe("signal: answer acknowledged");
    });

    it("works with an explicit payload", async () => {
      const result = await tool.execute(
        { type: "progress", payload: { percent: 50, message: "halfway" } },
        ctx,
      );
      expect(result).toBe("signal: progress acknowledged");
    });

    it("works with an empty payload", async () => {
      const result = await tool.execute(
        { type: "blocked", payload: {} },
        ctx,
      );
      expect(result).toBe("signal: blocked acknowledged");
    });
  });

  describe("return type is a string", () => {
    for (const signalType of SIGNAL_TYPES) {
      it(`returns a string for type "${signalType}"`, async () => {
        const result = await tool.execute({ type: signalType }, ctx);
        expect(typeof result).toBe("string");
      });
    }
  });

  it("zod schema rejects invalid signal types", () => {
    const result = tool.args.type.safeParse("invalid_signal");
    expect(result.success).toBe(false);
  });

  it("zod schema accepts all valid signal types", () => {
    for (const signalType of SIGNAL_TYPES) {
      const result = tool.args.type.safeParse(signalType);
      expect(result.success).toBe(true);
    }
  });
});
