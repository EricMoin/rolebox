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
    timestamp?: number;
  }>;
  header?: { cwd?: string; formatVersion?: number };
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
        timestamp: m.timestamp,
      }));
    },
    append(type: string, data: unknown) {
      const evt = { id: input.id, seq: events.length, type, data } as DshSessionEventLike;
      events.push(evt);
      return evt;
    },
  };
}

function makeStore(sessions: DshSessionLike[]): DshSessionStoreLike {
  const map = new Map(sessions.map((s) => [s.id, s]));
  return {
    create(id?: string) {
      const sessionId = id ?? `session-${map.size + 1}`;
      const session = makeSession({ id: sessionId });
      map.set(sessionId, session);
      return session;
    },
    get(id: string) {
      return map.get(id);
    },
    list() {
      return [...map.values()];
    },
    fork(source: DshSessionLike) {
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
    timestamp: 1000,
    data: {
      message: {
        role: "user",
        content: [{ type: "text", text: "Build the widget" }],
      },
    },
  },
  {
    id: "s1",
    seq: 1,
    type: "assistant/message",
    timestamp: 2000,
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
    timestamp: 2500,
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
  { id: "s1", seq: 3, type: "turn/end", timestamp: 3000 },
];

const SESSION_MESSAGES = [
  {
    id: "m1",
    role: "user",
    timestamp: 1000,
    content: [
      { type: "text", text: "Build the widget" },
      { type: "tool-call", id: "call-1", name: "bash", arguments: { command: "ls" } },
    ],
  },
  {
    id: "m2",
    role: "assistant",
    timestamp: 2000,
    content: [
      {
        type: "tool-result",
        toolCallId: "call-1",
        name: "bash",
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
    header: { cwd: "/repo", formatVersion: 1 },
  });
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

  it("list(directory) filters by session header.cwd", async () => {
    const store = makeStore([
      makeBaseSession(),
      makeSession({ id: "s2", header: { cwd: "/other" } }),
    ]);
    const adapter = new DshSessionAdapter(store);

    const infos = await adapter.list("/repo");
    expect(infos.map((i) => i.id)).toEqual(["s1"]);

    const all = await adapter.list();
    expect(all.map((i) => i.id)).toEqual(["s2", "s1"]); // newest first (both created=now → s2 later)
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
      state: { status: string; output: string };
    };
    expect(resultPart.type).toBe("tool");
    expect(resultPart.state.status).toBe("completed");
    expect(resultPart.state.output).toContain("a.ts");
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
          data: { items: [{ content: "Fix bug", status: "pending", priority: "high", id: "t1" }] },
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

  it("diff() parses file diffs from tool-result output", async () => {
    const adapter = new DshSessionAdapter(makeStore([makeBaseSession()]));

    const diffs = await adapter.diff("s1");
    expect(diffs).toHaveLength(1);
    expect(diffs[0].file).toBe("a.ts");
    expect(diffs[0].additions).toBe(1);
    expect(diffs[0].deletions).toBe(1);
  });

  it("status() derives idle/busy from the event log", async () => {
    const idleSession = makeBaseSession();
    const busySession = makeSession({
      id: "busy",
      events: [
        { id: "busy", seq: 0, type: "turn/start" },
        { id: "busy", seq: 1, type: "assistant/chunk" },
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

  it("create() creates a session via the store", async () => {
    const store = makeStore([]);
    const adapter = new DshSessionAdapter(store);

    const info = await adapter.create({ directory: "/repo" });
    expect(info?.id).toBe("session-1");
    expect(info?.directory).toBe("/repo");
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
