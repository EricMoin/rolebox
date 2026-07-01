import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { createSummarizerFn } from "../../src/loop/summarizer";

// ── helpers ──────────────────────────────────────────────────────

function createMockClient(overrides?: {
  sessionCreate?: (...args: unknown[]) => unknown;
  sessionPrompt?: (...args: unknown[]) => unknown;
  sessionDelete?: (...args: unknown[]) => unknown;
}): OpencodeClient {
  return {
    session: {
      create: mock(
        overrides?.sessionCreate ??
          (() =>
            Promise.resolve({
              data: { id: "mock-summarizer-session" },
              error: undefined,
            })),
      ),
      prompt: mock(
        overrides?.sessionPrompt ??
          (() =>
            Promise.resolve({
              data: {
                parts: [
                  { type: "text" as const, text: "Work completed: all tasks done." },
                ],
              },
              error: undefined,
            })),
      ),
      delete: mock(
        overrides?.sessionDelete ??
          (() => Promise.resolve({ data: true, error: undefined })),
      ),
    },
  } as unknown as OpencodeClient;
}

const AGENT = "test-agent";
const CONVERSATION = "Round 1: I analyzed the codebase.\nRound 2: I fixed the bug.";

// ── tests ────────────────────────────────────────────────────────

describe("createSummarizerFn", () => {
  let deleteCalled: boolean;

  function makeDeleteTracker() {
    deleteCalled = false;
    return () => {
      deleteCalled = true;
      return Promise.resolve({ data: true, error: undefined });
    };
  }

  beforeEach(() => {
    mock.restore();
  });

  it("returns ok:true with summary on success", async () => {
    const expectedSummary = "Round 1: analyzed codebase. Round 2: fixed bug.";
    const client = createMockClient({
      sessionPrompt: () =>
        Promise.resolve({
          data: {
            parts: [{ type: "text" as const, text: expectedSummary }],
          },
          error: undefined,
        }),
      sessionDelete: makeDeleteTracker(),
    });

    const summarize = createSummarizerFn(client);
    const result = await summarize(AGENT, CONVERSATION);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toBe(expectedSummary);
    }

    expect(deleteCalled).toBe(true);
  });

  it("returns ok:true with summary on success using injected timeout", async () => {
    const expectedSummary = "Done.";
    const client = createMockClient({
      sessionPrompt: () =>
        Promise.resolve({
          data: { parts: [{ type: "text" as const, text: expectedSummary }] },
          error: undefined,
        }),
    });

    const summarize = createSummarizerFn(client, { timeoutMs: 5_000 });
    const result = await summarize(AGENT, CONVERSATION);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toBe(expectedSummary);
    }
  });

  it("returns ok:false on timeout", async () => {
    const client = createMockClient({
      sessionPrompt: () => new Promise(() => {}),
      sessionDelete: makeDeleteTracker(),
    });

    const summarize = createSummarizerFn(client, { timeoutMs: 50 });
    const result = await summarize(AGENT, CONVERSATION);

    expect(result.ok).toBe(false);

    expect(deleteCalled).toBe(true);
  });

  it("returns ok:false when prompt returns error", async () => {
    const client = createMockClient({
      sessionPrompt: () =>
        Promise.resolve({
          data: undefined,
          error: { message: "something went wrong" },
        }),
      sessionDelete: makeDeleteTracker(),
    });

    const summarize = createSummarizerFn(client);
    const result = await summarize(AGENT, CONVERSATION);

    expect(result.ok).toBe(false);

    expect(deleteCalled).toBe(true);
  });

  it("returns ok:false when session.create returns error", async () => {
    const client = createMockClient({
      sessionCreate: () =>
        Promise.resolve({
          data: undefined,
          error: { message: "create failed" },
        }),
      sessionDelete: makeDeleteTracker(),
    });

    const summarize = createSummarizerFn(client);
    const result = await summarize(AGENT, CONVERSATION);

    expect(result.ok).toBe(false);
  });

  it("returns ok:false when prompt returns empty text", async () => {
    const client = createMockClient({
      sessionPrompt: () =>
        Promise.resolve({
          data: { parts: [{ type: "text" as const, text: "" }] },
          error: undefined,
        }),
      sessionDelete: makeDeleteTracker(),
    });

    const summarize = createSummarizerFn(client);
    const result = await summarize(AGENT, CONVERSATION);

    expect(result.ok).toBe(false);
    expect(deleteCalled).toBe(true);
  });

  it("returns ok:false when prompt parts have no text", async () => {
    const client = createMockClient({
      sessionPrompt: () =>
        Promise.resolve({
          data: { parts: [{ type: "file" as const }] },
          error: undefined,
        }),
      sessionDelete: makeDeleteTracker(),
    });

    const summarize = createSummarizerFn(client);
    const result = await summarize(AGENT, CONVERSATION);

    expect(result.ok).toBe(false);
    expect(deleteCalled).toBe(true);
  });

  it("returns ok:false when prompt throws an exception", async () => {
    const client = createMockClient({
      sessionPrompt: () => {
        throw new Error("network failure");
      },
      sessionDelete: makeDeleteTracker(),
    });

    const summarize = createSummarizerFn(client);
    const result = await summarize(AGENT, CONVERSATION);

    expect(result.ok).toBe(false);
    expect(deleteCalled).toBe(true);
  });

  it("caps conversation to SUMMARY_INPUT_CHAR_CAP, keeping the tail", async () => {
    const uniquePrefix = "HEAD_UNIQUE_MARKER_";
    const longBody = uniquePrefix + "B".repeat(12_000);
    let capturedText = "";

    const client = createMockClient({
      sessionPrompt: (opts: unknown) => {
        const body = (opts as { body?: { parts?: Array<{ text?: string }> } })
          ?.body;
        if (body?.parts?.[0]?.text) {
          capturedText = body.parts[0].text;
        }
        return Promise.resolve({
          data: {
            parts: [{ type: "text" as const, text: "summary" }],
          },
          error: undefined,
        });
      },
    });

    const summarize = createSummarizerFn(client);
    await summarize(AGENT, longBody);

    expect(capturedText.length).toBeLessThanOrEqual(8000);
    expect(capturedText).not.toContain(longBody.slice(0, 100));
  });

  it("returns ok:false when session.create returns no sessionId", async () => {
    const noIdClient = createMockClient({
      sessionCreate: () =>
        Promise.resolve({
          data: { id: undefined },
          error: undefined,
        }),
      sessionDelete: makeDeleteTracker(),
    });

    const summarize = createSummarizerFn(noIdClient);
    const result = await summarize(AGENT, CONVERSATION);
    expect(result.ok).toBe(false);
    expect(deleteCalled).toBe(false);
  });
});
