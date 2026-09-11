/// <reference types="bun-types" />

import { describe, it, expect } from "bun:test";
import { DshSessionAdapter } from "../../src/platform/adapters/dsh/session.ts";
import type {
  DshPromptInjector,
  DshSessionEventLike,
  DshSessionLike,
  DshSessionStoreLike,
} from "../../src/platform/adapters/dsh/session.ts";

// ── Fake dsh SessionStore / Session ─────────────────────────────────────────

interface FakeSessionInput {
  id: string;
  events?: DshSessionEventLike[];
  messages?: Array<{
    id: string;
    role: string;
    content: Array<{ type: string } & Record<string, unknown>>;
    source?: Record<string, unknown>;
  }>;
  header?: { cwd?: string; version?: number; parentSession?: string };
}

function makeSession(input: FakeSessionInput): DshSessionLike {
  const events = input.events ?? [];
  return {
    id: input.id,
    seq: events.length,
    events,
    header: input.header,
    deriveMessages() {
      return (input.messages ?? []).map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        source: m.source,
      }));
    },
    append(type: string, data: unknown) {
      const evt = { id: input.id, seq: events.length, type, time: Date.now(), data } as DshSessionEventLike;
      events.push(evt);
      return evt;
    },
  };
}

/**
 * @param onFork - Optional spy receiving each `fork` boundary, so a test can
 *   assert the resolved rc.6 seq (or `undefined`) without weakening the guard.
 */
function makeStore(
  sessions: DshSessionLike[],
  onFork?: (boundary: number | undefined) => void,
): DshSessionStoreLike {
  const map = new Map(sessions.map((s) => [s.id, s]));
  return {
    create(
      id?: string,
      options?: { meta?: { cwd?: string; parentSession?: string } },
    ) {
      const sessionId = id ?? `session-${map.size + 1}`;
      // Mirror rc.6 `create` (lib/index.js:1653-1663): the header is built
      // from `options.meta` ONLY, so a top-level `{directory}` passthrough
      // yields a session with no `cwd`.
      const meta = options?.meta;
      const header =
        meta === undefined
          ? undefined
          : {
              ...(meta.cwd === undefined ? {} : { cwd: meta.cwd }),
              ...(meta.parentSession === undefined
                ? {}
                : { parentSession: meta.parentSession }),
            };
      const session = makeSession({ id: sessionId, header });
      map.set(sessionId, session);
      return session;
    },
    get(id: string) {
      return map.get(id);
    },
    list() {
      return [...map.values()];
    },
    fork(source: DshSessionLike, boundary?: number) {
      // Mirror rc.6 `SessionStore._forkSeed` (lib/index.js:1858-1861): the
      // boundary must be `undefined` or a non-negative safe integer seq.
      if (
        boundary !== undefined &&
        (!Number.isSafeInteger(boundary) || boundary < 0)
      ) {
        throw new Error(
          `fork boundary for session "${source.id}" must be a non-negative safe integer, got ${String(boundary)}`,
        );
      }
      onFork?.(boundary);
      const forked = makeSession({ id: `${source.id}-fork` });
      map.set(forked.id, forked);
      return forked;
    },
  };
}

const SESSION_EVENTS = [
  {
    id: "s1",
    seq: 0,
    type: "user/message",
    time: 1000,
    // rc.6 `user/message` data IS the `UserMessage` — `content` is TOP-LEVEL
    // (`types.d.ts:262`; `dsh-llm message.d.ts:120-137`), not nested.
    data: {
      id: "m1",
      role: "user",
      content: [{ type: "text", text: "Build the widget" }],
      source: { kind: "user" },
    },
  },
  {
    id: "s1",
    seq: 1,
    type: "assistant/message",
    time: 2000,
    data: {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "On it" }],
      },
    },
  },
  {
    id: "s1",
    seq: 2,
    type: "tool/result",
    time: 2500,
    data: {
      turn: 1,
      step: 1,
      callId: "call-1",
      isError: false,
      message: {
        role: "user",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            isError: false,
            content: [
              {
                type: "text",
                text: '[{"file":"a.ts","before":"x","after":"y","additions":1,"deletions":1}]',
              },
            ],
          },
        ],
      },
    },
  },
  { id: "s1", seq: 3, type: "turn/end", time: 3000 },
];

const SESSION_MESSAGES = [
  {
    id: "m1",
    role: "user",
    content: [
      { type: "text", text: "Build the widget" },
      // rc.6 `ToolCallBlock.arguments` is a RAW JSON STRING (types.d.ts:59-66).
      { type: "tool-call", id: "call-1", name: "bash", arguments: '{"command":"ls"}' },
    ],
  },
  {
    id: "m2",
    role: "assistant",
    content: [
      {
        // rc.6 `ToolResultBlock` has no `name` (types.d.ts:68-74).
        type: "tool-result",
        toolCallId: "call-1",
        isError: false,
        content: [
          { type: "text", text: '[{"file":"a.ts","before":"x","after":"y","additions":1,"deletions":1}]' },
        ],
      },
    ],
  },
];

function makeBaseSession(): DshSessionLike {
  return makeSession({
    id: "s1",
    events: SESSION_EVENTS as DshSessionEventLike[],
    messages: SESSION_MESSAGES as never[],
    header: { cwd: "/repo", version: 1 },
  });
}

/**
 * REAL rc.6 message-event shapes (`dsh-session/lib/types/types.d.ts:262,278,306`):
 * `user/message` data IS the `UserMessage` (`id` top-level); `assistant/message`
 * and `tool/result` nest the message under `data.message`.
 */
const RC6_MESSAGE_EVENTS: DshSessionEventLike[] = [
  {
    id: "s1",
    seq: 0,
    type: "user/message",
    time: 1000,
    data: {
      id: "m1",
      role: "user",
      content: [{ type: "text", text: "Build the widget" }],
      source: { kind: "user" },
    },
  },
  {
    id: "s1",
    seq: 1,
    type: "assistant/message",
    time: 2000,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: "m2",
        role: "assistant",
        content: [{ type: "text", text: "On it" }],
        source: { kind: "model" },
      },
    },
  },
  {
    id: "s1",
    seq: 2,
    type: "tool/result",
    time: 2500,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: "m3",
        role: "user",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            isError: false,
            content: [{ type: "text", text: "ok" }],
          },
        ],
        source: { kind: "tool" },
      },
    },
  },
];

function makeRc6Session(): DshSessionLike {
  return makeSession({ id: "s1", events: RC6_MESSAGE_EVENTS });
}

describe("DshSessionAdapter", () => {
  it("list() maps sessions into SessionInfo with title and directory", async () => {
    const store = makeStore([makeBaseSession()]);
    const adapter = new DshSessionAdapter(store);

    const infos = await adapter.list();
    expect(infos).toHaveLength(1);
    expect(infos[0].id).toBe("s1");
    expect(infos[0].title).toBe("Build the widget");
    expect(infos[0].directory).toBe("/repo");
    expect(infos[0].projectID).toBe("/repo");
    expect(infos[0].version).toBe("1");
    expect(infos[0].time.created).toBe(1000);
    expect(infos[0].time.updated).toBe(3000);
  });

  // ──  regression: title reads the rc.6 top-level user/message content ──

  it("title derives from a real rc.6 user/message event (top-level content)", async () => {
    const longText = "x".repeat(100);
    const session = makeSession({
      id: "title",
      events: [
        // A preceding assistant event must not be picked up — only
        // `user/message` carries the title source.
        {
          id: "title",
          seq: 0,
          type: "assistant/message",
          time: 500,
          data: {
            turn: 1,
            step: 1,
            message: {
              id: "a1",
              role: "assistant",
              content: [{ type: "text", text: "ignore me" }],
            },
          },
        },
        // rc.6 `user/message` data IS the UserMessage — content is TOP-LEVEL.
        {
          id: "title",
          seq: 1,
          type: "user/message",
          time: 1000,
          data: {
            id: "u1",
            role: "user",
            content: [{ type: "text", text: `first\nline\n${longText}` }],
            source: { kind: "user" },
          },
        },
      ] as DshSessionEventLike[],
    });
    const adapter = new DshSessionAdapter(makeStore([session]));

    const info = await adapter.get("title");
    // Heuristic preserved exactly: newlines -> spaces, trimmed, sliced to 80.
    expect(info?.title).toBe(`first line ${"x".repeat(69)}`);
    expect(info?.title).toHaveLength(80);
  });

  it("title falls back to session.id for the obsolete nested {message:{content}} shape", async () => {
    const session = makeSession({
      id: "legacy",
      events: [
        {
          id: "legacy",
          seq: 0,
          type: "user/message",
          time: 1000,
          // Previous wrong shape: content nested under `message`. Must no
          // longer produce a title.
          data: {
            message: {
              role: "user",
              content: [{ type: "text", text: "Legacy title" }],
            },
          },
        },
      ] as DshSessionEventLike[],
    });
    const adapter = new DshSessionAdapter(makeStore([session]));

    const info = await adapter.get("legacy");
    expect(info?.title).toBe("legacy");
  });

  it("time.created/updated are the min/max event time, not Date.now()", async () => {
    const session = makeSession({
      id: "s1",
      events: [
        { id: "s1", seq: 0, type: "turn/start", time: 5000 },
        { id: "s1", seq: 1, type: "turn/end", time: 1000 },
        { id: "s1", seq: 2, type: "assistant/chunk", time: 3000 },
      ] as DshSessionEventLike[],
    });
    const adapter = new DshSessionAdapter(makeStore([session]));

    const info = await adapter.get("s1");
    expect(info?.time.created).toBe(1000);
    expect(info?.time.updated).toBe(5000);
  });

  it("version reflects header.version, defaulting to 1.0 when absent", async () => {
    const adapter = new DshSessionAdapter(
      makeStore([
        makeSession({ id: "v3", header: { cwd: "/repo", version: 3 } }),
        makeSession({ id: "vNone", header: { cwd: "/repo" } }),
      ]),
    );

    expect((await adapter.get("v3"))?.version).toBe("3");
    expect((await adapter.get("vNone"))?.version).toBe("1.0");
  });

  it("messages() stamps info.time.created from the owning event time", async () => {
    const session = makeSession({
      id: "s1",
      events: RC6_MESSAGE_EVENTS,
      messages: [
        { id: "m1", role: "user", content: [{ type: "text", text: "Build the widget" }] },
        { id: "m3", role: "user", content: [{ type: "text", text: "ok" }] },
      ] as never[],
    });
    const adapter = new DshSessionAdapter(makeStore([session]));

    const messages = await adapter.messages("s1");
    expect(messages[0].info.time.created).toBe(1000); // m1 <- user/message event
    expect(messages[1].info.time.created).toBe(2500); // m3 <- tool/result event
  });

  it("messages() uses 0 (not Date.now()) for a message id absent from the log", async () => {
    const session = makeSession({
      id: "s1",
      messages: [
        { id: "orphan", role: "user", content: [{ type: "text", text: "hi" }] },
      ] as never[],
    });
    const adapter = new DshSessionAdapter(makeStore([session]));

    const messages = await adapter.messages("s1");
    expect(messages[0].info.time.created).toBe(0);
  });

  it("list(directory) filters by session header.cwd", async () => {
    const store = makeStore([
      makeBaseSession(),
      makeSession({ id: "s2", header: { cwd: "/other" } }),
    ]);
    const adapter = new DshSessionAdapter(store);

    const infos = await adapter.list("/repo");
    expect(infos.map((i) => i.id)).toEqual(["s1"]);

    const all = await adapter.list();
    expect(all.map((i) => i.id)).toEqual(["s2", "s1"]); // newest first (s2 empty log → now > s1's 1000)
  });

  it("get() returns a session or null", async () => {
    const store = makeStore([makeBaseSession()]);
    const adapter = new DshSessionAdapter(store);

    const info = await adapter.get("s1");
    expect(info?.id).toBe("s1");
    expect(await adapter.get("missing")).toBeNull();
  });

  it("messages() maps deriveMessages() content blocks into parts", async () => {
    const store = makeStore([makeBaseSession()]);
    const adapter = new DshSessionAdapter(store);

    const messages = await adapter.messages("s1");
    expect(messages).toHaveLength(2);

    // user message: text part + tool-call part
    expect(messages[0].info.role).toBe("user");
    expect(messages[0].info.sessionID).toBe("s1");
    expect(messages[0].parts).toHaveLength(2);
    const textPart = messages[0].parts[0] as { type: string; text: string };
    expect(textPart.type).toBe("text");
    expect(textPart.text).toBe("Build the widget");
    const toolPart = messages[0].parts[1] as {
      type: string;
      tool: string;
      callID: string;
      state: { status: string; input: Record<string, unknown> };
    };
    expect(toolPart.type).toBe("tool");
    expect(toolPart.tool).toBe("bash");
    expect(toolPart.callID).toBe("call-1");
    expect(toolPart.state.status).toBe("running");

    // assistant message: tool-result part → completed tool part with output
    expect(messages[1].info.role).toBe("assistant");
    const resultPart = messages[1].parts[0] as {
      type: string;
      tool: string;
      state: { status: string; output: string };
    };
    expect(resultPart.type).toBe("tool");
    // rc.6 tool-result has no `name`; the label is paired via toolCallId.
    expect(resultPart.tool).toBe("bash");
    expect(resultPart.state.status).toBe("completed");
    expect(resultPart.state.output).toContain("a.ts");
  });

  // ── : tool-call arguments are a raw JSON string (types.d.ts:59-66) ──

  it("tool-call input parses a raw JSON string argument into an object", async () => {
    const session = makeSession({
      id: "args",
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: [
            { type: "tool-call", id: "c1", name: "bash", arguments: '{"a":1}' },
          ],
        },
      ] as never[],
    });
    const adapter = new DshSessionAdapter(makeStore([session]));

    const messages = await adapter.messages("args");
    const part = messages[0].parts[0] as {
      type: string;
      state: { input: Record<string, unknown> };
    };
    expect(part.state.input).toEqual({ a: 1 });
  });

  it("malformed tool-call argument JSON degrades to {} without throwing", async () => {
    const session = makeSession({
      id: "badargs",
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: [
            { type: "tool-call", id: "c1", name: "bash", arguments: "{not json" },
          ],
        },
      ] as never[],
    });
    const adapter = new DshSessionAdapter(makeStore([session]));

    const messages = await adapter.messages("badargs");
    const part = messages[0].parts[0] as {
      type: string;
      state: { input: Record<string, unknown> };
    };
    expect(part.state.input).toEqual({});
  });

  it("tool-call argument JSON that parses to a non-object degrades to {}", async () => {
    const session = makeSession({
      id: "nonobj",
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: [
            { type: "tool-call", id: "c1", name: "bash", arguments: "[1,2]" },
            { type: "tool-call", id: "c2", name: "bash", arguments: '"scalar"' },
          ],
        },
      ] as never[],
    });
    const adapter = new DshSessionAdapter(makeStore([session]));

    const messages = await adapter.messages("nonobj");
    const parts = messages[0].parts as Array<{
      state: { input: Record<string, unknown> };
    }>;
    expect(parts[0].state.input).toEqual({});
    expect(parts[1].state.input).toEqual({});
  });

  // ── : tool-result label resolves via toolCallId pairing ──────────────

  it("tool-result gets the tool name of the tool-call it pairs with", async () => {
    const session = makeSession({
      id: "paired",
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: [
            { type: "tool-call", id: "call-9", name: "read_file", arguments: "{}" },
          ],
        },
        {
          id: "m2",
          role: "user",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-9",
              isError: false,
              content: [{ type: "text", text: "ok" }],
            },
          ],
        },
      ] as never[],
    });
    const adapter = new DshSessionAdapter(makeStore([session]));

    const messages = await adapter.messages("paired");
    const part = messages[1].parts[0] as { tool: string };
    expect(part.tool).toBe("read_file");
  });

  it("an unpaired tool-result stays labeled 'unknown'", async () => {
    const session = makeSession({
      id: "unpaired",
      messages: [
        {
          id: "m1",
          role: "user",
          content: [
            {
              type: "tool-result",
              toolCallId: "orphan-call",
              isError: false,
              content: [{ type: "text", text: "ok" }],
            },
          ],
        },
      ] as never[],
    });
    const adapter = new DshSessionAdapter(makeStore([session]));

    const messages = await adapter.messages("unpaired");
    const part = messages[0].parts[0] as { tool: string };
    expect(part.tool).toBe("unknown");
  });

  it("messages() honors the limit option", async () => {
    const store = makeStore([makeBaseSession()]);
    const adapter = new DshSessionAdapter(store);

    const messages = await adapter.messages("s1", { limit: 1 });
    expect(messages).toHaveLength(1);
    expect(messages[0].info.id).toBe("m1");
  });

  it("todo() extracts todo/write events from the event log", async () => {
    const session = makeSession({
      id: "s1",
      events: [
        {
          id: "s1",
          seq: 0,
          type: "todo/write",
          time: 1000,
          data: { todos: [{ content: "Fix bug", status: "pending", priority: "high", id: "t1" }] },
        },
      ] as DshSessionEventLike[],
    });
    const adapter = new DshSessionAdapter(makeStore([session]));

    const todos = await adapter.todo("s1");
    expect(todos).toHaveLength(1);
    expect(todos[0].content).toBe("Fix bug");
    expect(todos[0].status).toBe("pending");
    expect(todos[0].id).toBe("t1");
  });

  it("todo() reads the rc.6 {todos:[...]} shape and ignores a bare array", async () => {
    const shaped = makeSession({
      id: "shaped",
      events: [
        {
          id: "shaped",
          seq: 0,
          type: "todo/write",
          time: 1000,
          data: { todos: [{ content: "A", status: "in_progress" }, { content: "B", status: "completed" }] },
        },
      ] as DshSessionEventLike[],
    });
    const bareArray = makeSession({
      id: "bare",
      events: [
        {
          id: "bare",
          seq: 0,
          type: "todo/write",
          time: 1000,
          data: [{ content: "C", status: "pending" }],
        },
      ] as DshSessionEventLike[],
    });
    const adapter = new DshSessionAdapter(makeStore([shaped, bareArray]));

    const shapedTodos = await adapter.todo("shaped");
    expect(shapedTodos).toHaveLength(2);
    expect(shapedTodos.map((t) => t.content)).toEqual(["A", "B"]);
    expect(shapedTodos.map((t) => t.status)).toEqual(["in_progress", "completed"]);

    expect(await adapter.todo("bare")).toEqual([]);
  });

  it("diff() parses file diffs from tool-result output", async () => {
    const adapter = new DshSessionAdapter(makeStore([makeBaseSession()]));

    const diffs = await adapter.diff("s1");
    expect(diffs).toHaveLength(1);
    expect(diffs[0].file).toBe("a.ts");
    expect(diffs[0].additions).toBe(1);
    expect(diffs[0].deletions).toBe(1);
  });

  it("diff() still reads the nested tool/result message shape (rc.6 data.message)", async () => {
    // guard: unlike user/message, rc.6 `tool/result` data genuinely IS
    // `{turn,step,message:ToolResultMessage,...}` (types.d.ts:296-306), so
    // `data.message.content` is correct there and must NOT be "fixed".
    const session = makeSession({
      id: "d1",
      events: [
        {
          id: "d1",
          seq: 0,
          type: "tool/result",
          time: 1000,
          data: {
            turn: 1,
            step: 1,
            message: {
              id: "tr1",
              role: "user",
              content: [
                {
                  type: "tool-result",
                  toolCallId: "call-1",
                  isError: false,
                  content: [
                    {
                      type: "text",
                      text: '[{"file":"nested.ts","before":"a","after":"b","additions":2,"deletions":3}]',
                    },
                  ],
                },
              ],
            },
          },
        },
      ] as DshSessionEventLike[],
    });
    const adapter = new DshSessionAdapter(makeStore([session]));

    const diffs = await adapter.diff("d1");
    expect(diffs).toHaveLength(1);
    expect(diffs[0].file).toBe("nested.ts");
    expect(diffs[0].additions).toBe(2);
    expect(diffs[0].deletions).toBe(3);
  });

  it("status() derives idle/busy from the event log", async () => {
    const idleSession = makeBaseSession();
    const busySession = makeSession({
      id: "busy",
      events: [
        { id: "busy", seq: 0, type: "turn/start", time: 1000 },
        { id: "busy", seq: 1, type: "assistant/chunk", time: 2000 },
      ] as DshSessionEventLike[],
    });
    const adapter = new DshSessionAdapter(makeStore([idleSession, busySession]));

    expect(await adapter.status("s1")).toEqual({ type: "idle" });
    expect(await adapter.status("busy")).toEqual({ type: "busy" });
    expect(await adapter.status("missing")).toBeNull();
  });

  it("fork() returns a fork mapped with parentID", async () => {
    const store = makeStore([makeBaseSession()]);
    const adapter = new DshSessionAdapter(store);

    const fork = await adapter.fork("s1");
    expect(fork?.id).toBe("s1-fork");
    expect(fork?.parentID).toBe("s1");

    expect(await adapter.fork("missing")).toBeNull();
  });

  it("fork() resolves a messageID to the matching rc.6 event seq", async () => {
    const boundaries: Array<number | undefined> = [];
    const store = makeStore([makeRc6Session()], (b) => boundaries.push(b));
    const adapter = new DshSessionAdapter(store);

    // user/message -> data.id
    expect((await adapter.fork("s1", { messageID: "m1" }))?.id).toBe("s1-fork");
    expect(boundaries).toEqual([0]);

    // assistant/message -> data.message.id
    boundaries.length = 0;
    expect(await adapter.fork("s1", { messageID: "m2" })).not.toBeNull();
    expect(boundaries).toEqual([1]);

    // tool/result -> data.message.id
    boundaries.length = 0;
    expect(await adapter.fork("s1", { messageID: "m3" })).not.toBeNull();
    expect(boundaries).toEqual([2]);
  });

  it("fork() returns null for an unresolvable messageID and never calls fork", async () => {
    const boundaries: Array<number | undefined> = [];
    const store = makeStore([makeRc6Session()], (b) => boundaries.push(b));
    const adapter = new DshSessionAdapter(store);

    expect(await adapter.fork("s1", { messageID: "does-not-exist" })).toBeNull();
    // The strengthened fake store also throws on a non-integer boundary, so an
    // empty spy proves `store.fork` was never reached with the raw messageID.
    expect(boundaries).toEqual([]);
  });

  it("fork() passes an undefined boundary when no messageID is supplied", async () => {
    const boundaries: Array<number | undefined> = [];
    const store = makeStore([makeBaseSession()], (b) => boundaries.push(b));
    const adapter = new DshSessionAdapter(store);

    expect(await adapter.fork("s1")).not.toBeNull();
    expect(boundaries).toEqual([undefined]);
  });

  it("create() creates a session via the store", async () => {
    const store = makeStore([]);
    const adapter = new DshSessionAdapter(store);

    const info = await adapter.create({ directory: "/repo" });
    expect(info?.id).toBe("session-1");
    expect(info?.directory).toBe("/repo");
    // the directory must land in the persisted header, not be dropped.
    expect(store.get("session-1")?.header?.cwd).toBe("/repo");
  });

  // ── : rc.6 `create` reads `meta.cwd`, not a top-level `directory` ──────
  //
  // The fake store above mirrors rc.6 and builds its header from `options.meta`
  // ONLY, so the pre-fix `{directory}` passthrough would leave `header.cwd`
  // undefined and make `list(directory)` silently return nothing.

  it("create() forwards directory as meta.cwd so list(directory) finds it", async () => {
    const store = makeStore([]);
    const adapter = new DshSessionAdapter(store);

    const info = await adapter.create({ directory: "/repo" });
    expect(info?.directory).toBe("/repo");
    expect(store.get("session-1")?.header?.cwd).toBe("/repo");

    const found = await adapter.list("/repo");
    expect(found.map((i) => i.id)).toEqual(["session-1"]);
  });

  // ── : parentID must persist as meta.parentSession (durable lineage) ────

  it("create() forwards parentID as meta.parentSession", async () => {
    const store = makeStore([]);
    const adapter = new DshSessionAdapter(store);

    const info = await adapter.create({ directory: "/repo", parentID: "parent-1" });
    expect(info?.parentID).toBe("parent-1");
    expect(store.get("session-1")?.header?.parentSession).toBe("parent-1");
    expect(store.get("session-1")?.header?.cwd).toBe("/repo");
  });

  it("unsupported operations degrade gracefully", async () => {
    const adapter = new DshSessionAdapter(makeStore([makeBaseSession()]));

    expect(await adapter.prompt("s1", { parts: [{ type: "text", text: "hi" }] })).toBeNull();
    expect(await adapter.promptSync("s1", { parts: [{ type: "text", text: "hi" }] })).toBeNull();
    expect(await adapter.abort("s1")).toBe(false);
    expect(await adapter.compact("s1")).toBe(false);
    expect(await adapter.children("s1")).toEqual([]);
  });

  // ── graph-notify prompt-injector seam (DSH graphNotify assembly) ──────────
  //
  // The dsh SessionStore has no `prompt`; graph-notify reminders reach the
  // orchestrator through the optional live-agent injector wired by the plugin
  // (`ctx.agents` → `Agent.inject`). These tests verify the adapter's
  // `prompt()` uses that seam and keeps its documented no-op otherwise.

  it("prompt() routes the reminder text through the injector with agent + noReply", async () => {
    const calls: Array<{
      id: string;
      text: string;
      agent?: string;
      noReply?: boolean;
    }> = [];
    const injector: DshPromptInjector = {
      async inject(id: string, text: string, options?: { agent?: string; noReply?: boolean }) {
        calls.push({
          id,
          text,
          agent: options?.agent,
          noReply: options?.noReply,
        });
        return { id };
      },
    };
    const adapter = new DshSessionAdapter(makeStore([makeBaseSession()]), {
      promptInjector: injector,
    });

    const result = await adapter.prompt("s1", {
      parts: [{ type: "text", text: "<system-reminder> node done" }],
      noReply: true,
      agent: "emperor--jinyiwei",
    });

    expect(result).toEqual({ id: "s1" });
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe("s1");
    expect(calls[0].text).toBe("<system-reminder> node done");
    expect(calls[0].agent).toBe("emperor--jinyiwei");
    expect(calls[0].noReply).toBe(true);
  });

  it("prompt() joins multi-part text before injecting", async () => {
    let seenText = "";
    const injector: DshPromptInjector = {
      async inject(_id: string, text: string) {
        seenText = text;
        return { id: "x" };
      },
    };
    const adapter = new DshSessionAdapter(makeStore([makeBaseSession()]), {
      promptInjector: injector,
    });

    await adapter.prompt("s1", {
      parts: [
        { type: "text", text: "part-one" },
        { type: "text", text: "part-two" },
      ],
    });
    expect(seenText).toBe("part-onepart-two");
  });

  it("prompt() degrades to null when the injector finds no result or rejects", async () => {
    const nullInjector: DshPromptInjector = {
      async inject() {
        return null;
      },
    };
    const throwingInjector: DshPromptInjector = {
      async inject() {
        throw new Error("no live agent");
      },
    };

    const adapter1 = new DshSessionAdapter(makeStore([makeBaseSession()]), {
      promptInjector: nullInjector,
    });
    const adapter2 = new DshSessionAdapter(makeStore([makeBaseSession()]), {
      promptInjector: throwingInjector,
    });
    const adapter3 = new DshSessionAdapter(makeStore([makeBaseSession()]), {
      promptInjector: nullInjector,
    });

    expect(
      await adapter1.prompt("s1", { parts: [{ type: "text", text: "hi" }] }),
    ).toBeNull();
    expect(
      await adapter2.prompt("s1", { parts: [{ type: "text", text: "hi" }] }),
    ).toBeNull();
    // Empty text → not injected → null.
    expect(
      await adapter3.prompt("s1", { parts: [{ type: "text", text: "" }] }),
    ).toBeNull();
  });
});
