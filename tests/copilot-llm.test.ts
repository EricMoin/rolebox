import { describe, it, expect, mock } from "bun:test";
import type { ISessionClient } from "../src/platform/ports/session-client.ts";
import { requestVerdict } from "../src/copilot/llm.ts";

// ── Fixtures ────────────────────────────────────────────────────────────

const SID = "origin-sess-1";
const ROLE = "verdict-role";
const DIRECTORY = "/tmp/test";
const PROMPT = "decide what to do";

const RESOLVED = new Map<string, { parentFullId: string }>([
  [ROLE, { parentFullId: "root-role" }],
  ["other-role", { parentFullId: "root-role" }],
]);

interface FakeClientOverrides {
  create?: (opts: {
    directory: string;
    agent?: string;
    parentID?: string;
  }) => Promise<{ id: string } | null>;
  promptSync?: (id: string, opts: unknown) => Promise<unknown>;
  abort?: (id: string) => Promise<boolean>;
}

function makeClient(overrides: FakeClientOverrides = {}) {
  const client = {
    create: mock(
      overrides.create ??
        (() => Promise.resolve({ id: "child-sess-1" })),
    ),
    promptSync: mock(
      overrides.promptSync ??
        (() =>
          Promise.resolve({
            parts: [{ type: "text", text: '{"advance":true,"replyText":"go"}' }],
          })),
    ),
    prompt: mock(() => Promise.resolve({ id: "async-prompt" })),
    abort: mock(overrides.abort ?? (() => Promise.resolve(true))),
  } as unknown as ISessionClient;
  return client;
}

function deps(client: ISessionClient) {
  return { client, resolvedSubagents: RESOLVED, directory: DIRECTORY };
}

function opts(overrides: Partial<{ sid: string; roleId: string; prompt: string; timeoutMs: number }> = {}) {
  return {
    sid: SID,
    roleId: ROLE,
    prompt: PROMPT,
    timeoutMs: 1000,
    ...overrides,
  };
}

// ── requestVerdict ──────────────────────────────────────────────────────

describe("requestVerdict", () => {
  it("parses a plain JSON verdict and returns { advance, replyText }", async () => {
    const client = makeClient({
      promptSync: () =>
        Promise.resolve({
          parts: [{ type: "text", text: '{"advance":true,"replyText":"keep going"}' }],
        }),
    });

    const verdict = await requestVerdict(deps(client), opts());

    expect(verdict).toEqual({ advance: true, replyText: "keep going" });
    // The origin session must never be prompted — only the child.
    expect(client.promptSync).toHaveBeenCalledTimes(1);
    expect((client.promptSync as ReturnType<typeof mock>).mock.calls[0][0]).toBe(
      "child-sess-1",
    );
    expect((client.promptSync as ReturnType<typeof mock>).mock.calls[0][0]).not.toBe(SID);
  });

  it("parses a JSON verdict wrapped in a fenced block", async () => {
    const client = makeClient({
      promptSync: () =>
        Promise.resolve({
          parts: [
            {
              type: "text",
              text: '```json\n{"advance":false,"replyText":"stop here"}\n```',
            },
          ],
        }),
    });

    const verdict = await requestVerdict(deps(client), opts());

    expect(verdict).toEqual({ advance: false, replyText: "stop here" });
  });

  it("parses a JSON verdict surrounded by prose", async () => {
    const client = makeClient({
      promptSync: () =>
        Promise.resolve({
          parts: [
            {
              type: "text",
              text: 'My decision: {"advance":true,"replyText":"proceed"} — that is all.',
            },
          ],
        }),
    });

    const verdict = await requestVerdict(deps(client), opts());

    expect(verdict).toEqual({ advance: true, replyText: "proceed" });
  });

  it("returns advance=false verdict (hand control back) as a valid result", async () => {
    const client = makeClient({
      promptSync: () =>
        Promise.resolve({
          parts: [{ type: "text", text: '{"advance":false,"replyText":""}' }],
        }),
    });

    const verdict = await requestVerdict(deps(client), opts());

    expect(verdict).toEqual({ advance: false, replyText: "" });
  });

  it("returns null on malformed (non-JSON) output", async () => {
    const client = makeClient({
      promptSync: () =>
        Promise.resolve({
          parts: [{ type: "text", text: "I think we should continue" }],
        }),
    });

    expect(await requestVerdict(deps(client), opts())).toBeNull();
  });

  it("returns null when the JSON object is missing entirely", async () => {
    const client = makeClient({
      promptSync: () =>
        Promise.resolve({
          parts: [{ type: "text", text: "no braces here at all" }],
        }),
    });

    expect(await requestVerdict(deps(client), opts())).toBeNull();
  });

  it("returns null on type-invalid JSON (advance not boolean)", async () => {
    const client = makeClient({
      promptSync: () =>
        Promise.resolve({
          parts: [{ type: "text", text: '{"advance":"yes","replyText":"go"}' }],
        }),
    });

    expect(await requestVerdict(deps(client), opts())).toBeNull();
  });

  it("returns null on type-invalid JSON (replyText not string)", async () => {
    const client = makeClient({
      promptSync: () =>
        Promise.resolve({
          parts: [{ type: "text", text: '{"advance":true,"replyText":42}' }],
        }),
    });

    expect(await requestVerdict(deps(client), opts())).toBeNull();
  });

  it("returns null on truncated/invalid JSON", async () => {
    const client = makeClient({
      promptSync: () =>
        Promise.resolve({
          parts: [{ type: "text", text: '{"advance":true,"replyText":"oops' }],
        }),
    });

    expect(await requestVerdict(deps(client), opts())).toBeNull();
  });

  it("returns null on an empty / non-text response", async () => {
    const client = makeClient({
      promptSync: () => Promise.resolve({ parts: [] }),
    });

    expect(await requestVerdict(deps(client), opts())).toBeNull();
  });

  it("returns null on a null promptSync response (platform failure)", async () => {
    const client = makeClient({
      promptSync: () => Promise.resolve(null),
    });

    expect(await requestVerdict(deps(client), opts())).toBeNull();
  });

  it("returns null on timeout (signal aborts the in-flight prompt)", async () => {
    const client = makeClient({
      // Never settles — the timeout must abort it via the AbortSignal.
      promptSync: () => new Promise(() => {}),
    });

    const verdict = await requestVerdict(deps(client), opts({ timeoutMs: 40 }));

    expect(verdict).toBeNull();
    // Cleanup: the child session is aborted best-effort.
    expect(client.abort).toHaveBeenCalledWith("child-sess-1");
  });

  it("returns null on launch failure (create returns null)", async () => {
    const client = makeClient({
      create: () => Promise.resolve(null),
    });

    expect(await requestVerdict(deps(client), opts())).toBeNull();
    expect(client.promptSync).not.toHaveBeenCalled();
    expect(client.abort).not.toHaveBeenCalled();
  });

  it("returns null on launch failure (create throws)", async () => {
    const client = makeClient({
      create: () => Promise.reject(new Error("session create failed")),
    });

    expect(await requestVerdict(deps(client), opts())).toBeNull();
    expect(client.promptSync).not.toHaveBeenCalled();
  });

  it("returns null on unknown role and never touches the client", async () => {
    const client = makeClient();

    const verdict = await requestVerdict(
      deps(client),
      opts({ roleId: "no-such-role" }),
    );

    expect(verdict).toBeNull();
    expect(client.create).not.toHaveBeenCalled();
    expect(client.promptSync).not.toHaveBeenCalled();
    expect(client.abort).not.toHaveBeenCalled();
  });

  it("creates the child session with directory, agent, and parentID=sid", async () => {
    const client = makeClient();

    await requestVerdict(deps(client), opts());

    expect(client.create).toHaveBeenCalledWith({
      directory: DIRECTORY,
      agent: ROLE,
      parentID: SID,
    });
  });

  it("passes the prompt as a single text part to promptSync", async () => {
    const client = makeClient();

    await requestVerdict(deps(client), opts());

    const call = (client.promptSync as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe("child-sess-1");
    expect(call[1]).toMatchObject({
      parts: [{ type: "text", text: PROMPT }],
    });
    // A signal must be attached so the timeout can abort the request.
    expect(call[1].signal).toBeInstanceOf(AbortSignal);
  });

  it("uses the LAST text part of the response for parsing", async () => {
    const client = makeClient({
      promptSync: () =>
        Promise.resolve({
          parts: [
            { type: "text", text: '{"advance":false,"replyText":"first"}' },
            { type: "text", text: '{"advance":true,"replyText":"last"}' },
          ],
        }),
    });

    const verdict = await requestVerdict(deps(client), opts());

    expect(verdict).toEqual({ advance: true, replyText: "last" });
  });

  it("never calls the async prompt() on the origin session", async () => {
    const raw = {
      create: mock(() => Promise.resolve({ id: "child-sess-1" })),
      promptSync: mock(() =>
        Promise.resolve({
          parts: [{ type: "text", text: '{"advance":true,"replyText":"go"}' }],
        }),
      ),
      prompt: mock(() => Promise.resolve({ id: "async-prompt" })),
      abort: mock(() => Promise.resolve(true)),
    };
    const client = raw as unknown as ISessionClient;

    await requestVerdict(deps(client), opts());

    expect(raw.prompt).not.toHaveBeenCalled();
  });
});
