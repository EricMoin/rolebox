/// <reference types="bun-types" />

/**
 * Opencode2SessionAdapter — the ISessionClient adapter over the opencode v2
 * (@opencode/plugin 2.x) reduced plugin session domain.
 *
 * The fake host below implements the adapter's own `Opencode2SessionApi`
 * (src/platform/adapters/opencode2/session.ts), which a compile-time guard in
 * that module proves the REAL `Plugin.Context["session"]` satisfies — so these
 * cases exercise the real v2 call shapes, not a local invention. The v2 shapes
 * the fixtures reproduce are cited inline against the installed 2.0.18
 * declarations.
 *
 * No test touches the filesystem, so the working tree stays clean.
 */

import { describe, it, expect } from "bun:test";
import {
  Opencode2SessionAdapter,
} from "../../src/platform/adapters/opencode2/session.ts";
import type {
  Opencode2CreateInput,
  Opencode2HostMessage,
  Opencode2PromptInput,
  Opencode2SessionApi,
  Opencode2SessionInfo,
} from "../../src/platform/adapters/opencode2/session.ts";
import {
  SessionCreateRejectedError,
  isSessionCreateRejected,
} from "../../src/platform/types.ts";

// ── Fixtures ───────────────────────────────────────────────────────────────

const PROMPTED_AT = 1_700_000_002_000;

/** `Session.Info` (…/client/dist/promise/generated/types.d.ts:2788-2814). */
function sessionInfo(overrides: Partial<Opencode2SessionInfo> = {}): Opencode2SessionInfo {
  return {
    id: "ses_1",
    projectID: "proj_1",
    title: "Session one",
    time: { created: 1_700_000_000_000, updated: 1_700_000_001_000 },
    location: { directory: "/tmp/project" },
    ...overrides,
  };
}

/** A `SessionMessageInfo` union member: the user turn (…/types.d.ts:2504-2517). */
function userMessage(text: string, id = "msg_user"): Opencode2HostMessage {
  return { id, type: "user", text, time: { created: 1_700_000_001_000 } };
}

/** A `SessionMessageAssistant` (…/types.d.ts:3195-3221). */
function assistantMessage(
  content: NonNullable<Opencode2HostMessage["content"]>,
  time: { created: number; completed?: number } = { created: PROMPTED_AT, completed: PROMPTED_AT + 500 },
  id = "msg_assistant",
): Opencode2HostMessage {
  return { id, type: "assistant", agent: "rolebox--worker", model: { id: "model-1", providerID: "provider-1" }, content, time };
}

interface HostCalls {
  get: Array<{ sessionID: string }>;
  create: Array<Opencode2CreateInput | undefined>;
  prompt: Opencode2PromptInput[];
  switchAgent: Array<{ sessionID: string; agent: string }>;
  switchModel: Array<{ sessionID: string; model: { id: string; providerID: string } }>;
  wait: Array<{ sessionID: string }>;
  interrupt: Array<{ sessionID: string }>;
  context: Array<{ sessionID: string }>;
  /** Ordered "method" log, so ordering between switch* and prompt is testable. */
  order: string[];
}

function makeHost(overrides: Partial<Opencode2SessionApi> = {}): {
  host: Opencode2SessionApi;
  calls: HostCalls;
} {
  const calls: HostCalls = {
    get: [],
    create: [],
    prompt: [],
    switchAgent: [],
    switchModel: [],
    wait: [],
    interrupt: [],
    context: [],
    order: [],
  };
  const host: Opencode2SessionApi = {
    async get(input) {
      calls.get.push(input);
      return sessionInfo({ id: input.sessionID });
    },
    async create(input) {
      calls.create.push(input);
      return sessionInfo({
        id: "ses_created",
        ...(input?.location !== undefined ? { location: input.location } : {}),
      });
    },
    async prompt(input) {
      calls.prompt.push(input);
      calls.order.push("prompt");
      return { id: "msg_inbox_1", time: { created: PROMPTED_AT } };
    },
    async switchAgent(input) {
      calls.switchAgent.push(input);
      calls.order.push("switchAgent");
    },
    async switchModel(input) {
      calls.switchModel.push(input);
      calls.order.push("switchModel");
    },
    async wait(input) {
      calls.wait.push(input);
    },
    async interrupt(input) {
      calls.interrupt.push(input);
      return { interrupted: true };
    },
    async context(input) {
      calls.context.push(input);
      return [
        userMessage("hello"),
        assistantMessage([
          { type: "reasoning", text: "thinking" },
          { type: "text", text: "the answer" },
          {
            type: "tool",
            id: "call_1",
            name: "read",
            state: {
              status: "completed",
              input: { path: "a.ts" },
              content: [{ type: "text", text: "file body" }],
              metadata: { title: "Read a.ts" },
            },
            time: { created: PROMPTED_AT + 1, completed: PROMPTED_AT + 2 },
          },
        ]),
      ];
    },
    ...overrides,
  };
  return { host, calls };
}

/** A host that fails loudly if any method is called — for the degradations. */
function makeUnreachableHost(): Opencode2SessionApi {
  const fail = (name: string): never => {
    throw new Error("host." + name + " must not be called");
  };
  return {
    async get() {
      return fail("get");
    },
    async create() {
      return fail("create");
    },
    async prompt() {
      return fail("prompt");
    },
    async switchAgent() {
      return fail("switchAgent");
    },
    async switchModel() {
      return fail("switchModel");
    },
    async wait() {
      return fail("wait");
    },
    async interrupt() {
      return fail("interrupt");
    },
    async context() {
      return fail("context");
    },
  };
}

/** v2's thrown ClientError (…/promise/generated/client-error.d.ts:1-6). */
class FakeClientError extends Error {
  readonly reason: string;
  readonly detail: string | null;

  constructor(reason: string, options?: { cause?: unknown; detail?: string }) {
    super(reason, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ClientError";
    this.reason = reason;
    this.detail = options?.detail ?? null;
  }
}

async function thrownBy(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (err) {
    return err;
  }
}

// ── get ────────────────────────────────────────────────────────────────────

describe("Opencode2SessionAdapter.get", () => {
  it("maps v2 Session.Info onto the canonical SessionInfo", async () => {
    const { host } = makeHost({
      async get() {
        return sessionInfo({ parentID: "ses_parent" });
      },
    });
    const adapter = new Opencode2SessionAdapter(host);

    const info = await adapter.get("ses_1");

    expect(info).toEqual({
      id: "ses_1",
      projectID: "proj_1",
      directory: "/tmp/project",
      parentID: "ses_parent",
      title: "Session one",
      version: "2",
      time: { created: 1_700_000_000_000, updated: 1_700_000_001_000 },
    });
  });

  it("passes the id through as sessionID and omits parentID when v2 has none", async () => {
    const { host, calls } = makeHost();
    const adapter = new Opencode2SessionAdapter(host);

    const info = await adapter.get("ses_42");

    expect(calls.get).toEqual([{ sessionID: "ses_42" }]);
    expect(info).not.toBeNull();
    expect(info?.parentID).toBeUndefined();
    expect(info?.version).toBe("2");
  });

  it("returns null — never throws — when the host read fails", async () => {
    const { host } = makeHost({
      async get() {
        throw new FakeClientError("UnexpectedStatus", { cause: { status: 404 }, detail: "404" });
      },
    });
    const adapter = new Opencode2SessionAdapter(host);

    expect(await adapter.get("ses_missing")).toBeNull();
  });
});

// ── messages ───────────────────────────────────────────────────────────────

describe("Opencode2SessionAdapter.messages", () => {
  it("maps a v2 context() window onto canonical messages and parts", async () => {
    const { host, calls } = makeHost();
    const adapter = new Opencode2SessionAdapter(host);

    const messages = await adapter.messages("ses_1");

    expect(calls.context).toEqual([{ sessionID: "ses_1" }]);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      info: {
        id: "msg_user",
        sessionID: "ses_1",
        role: "user",
        time: { created: 1_700_000_001_000 },
      },
      parts: [
        {
          id: "msg_user:text",
          sessionID: "ses_1",
          messageID: "msg_user",
          type: "text",
          text: "hello",
        },
      ],
    });
    expect(messages[1]?.info).toEqual({
      id: "msg_assistant",
      sessionID: "ses_1",
      role: "assistant",
      time: { created: PROMPTED_AT, completed: PROMPTED_AT + 500 },
      agent: "rolebox--worker",
      model: { providerID: "provider-1", modelID: "model-1" },
    });
    expect(messages[1]?.parts).toEqual([
      { id: "msg_assistant:part:0", sessionID: "ses_1", messageID: "msg_assistant", type: "reasoning", text: "thinking" },
      { id: "msg_assistant:part:1", sessionID: "ses_1", messageID: "msg_assistant", type: "text", text: "the answer" },
      {
        id: "msg_assistant:part:2",
        sessionID: "ses_1",
        messageID: "msg_assistant",
        type: "tool",
        callID: "call_1",
        tool: "read",
        state: {
          status: "completed",
          input: { path: "a.ts" },
          output: "file body",
          title: "Read a.ts",
          metadata: { title: "Read a.ts" },
          time: { start: PROMPTED_AT + 1, end: PROMPTED_AT + 2 },
        },
      },
    ]);
  });

  it("applies the port's limit client-side as a tail window", async () => {
    const { host } = makeHost({
      async context() {
        return [userMessage("one", "m1"), userMessage("two", "m2"), userMessage("three", "m3")];
      },
    });
    const adapter = new Opencode2SessionAdapter(host);

    const limited = await adapter.messages("ses_1", { limit: 2 });
    expect(limited.map((message) => message.info.id)).toEqual(["m2", "m3"]);

    const unlimited = await adapter.messages("ses_1");
    expect(unlimited.map((message) => message.info.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("returns [] — never throws — when the host read fails", async () => {
    const { host } = makeHost({
      async context() {
        throw new FakeClientError("Transport", { cause: new TypeError("fetch failed") });
      },
    });
    const adapter = new Opencode2SessionAdapter(host);

    expect(await adapter.messages("ses_1")).toEqual([]);
  });
});

// ── documented degradations ────────────────────────────────────────────────

describe("Opencode2SessionAdapter degradations", () => {
  it("returns the empty value for every method v2's plugin domain omits", async () => {
    const adapter = new Opencode2SessionAdapter(makeUnreachableHost());

    expect(await adapter.list()).toEqual([]);
    expect(await adapter.list("/tmp/project")).toEqual([]);
    expect(await adapter.children("ses_1")).toEqual([]);
    expect(await adapter.todo("ses_1")).toEqual([]);
    expect(await adapter.diff("ses_1", { messageID: "msg_1" })).toEqual([]);
    expect(await adapter.fork("ses_1", { messageID: "msg_1" })).toBeNull();
    expect(await adapter.status("ses_1")).toBeNull();
    expect(await adapter.compact("ses_1")).toBe(false);
  });
});

// ── prompt ─────────────────────────────────────────────────────────────────

describe("Opencode2SessionAdapter.prompt", () => {
  it("sends one text body and returns the v2 inbox message id", async () => {
    const { host, calls } = makeHost();
    const adapter = new Opencode2SessionAdapter(host);

    const result = await adapter.prompt("ses_1", { parts: [{ type: "text", text: "hi there" }] });

    expect(result).toEqual({ id: "msg_inbox_1" });
    expect(calls.prompt).toEqual([{ sessionID: "ses_1", text: "hi there" }]);
    expect(calls.switchAgent).toEqual([]);
    expect(calls.switchModel).toEqual([]);
  });

  it("joins multiple canonical parts into the single v2 text body", async () => {
    const { host, calls } = makeHost();
    const adapter = new Opencode2SessionAdapter(host);

    await adapter.prompt("ses_1", {
      parts: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    });

    expect(calls.prompt[0]?.text).toBe("first\n\nsecond");
  });

  it("selects the agent/model on the SESSION before prompting (v2 has no per-prompt field)", async () => {
    const { host, calls } = makeHost();
    const adapter = new Opencode2SessionAdapter(host);

    await adapter.prompt("ses_1", {
      parts: [{ type: "text", text: "go" }],
      agent: "rolebox--worker",
      model: { providerID: "provider-1", modelID: "model-2" },
    });

    expect(calls.switchAgent).toEqual([{ sessionID: "ses_1", agent: "rolebox--worker" }]);
    expect(calls.switchModel).toEqual([
      { sessionID: "ses_1", model: { id: "model-2", providerID: "provider-1" } },
    ]);
    expect(calls.order).toEqual(["switchAgent", "switchModel", "prompt"]);
    expect(calls.prompt).toEqual([{ sessionID: "ses_1", text: "go" }]);
  });

  it("maps noReply onto v2's resume flag and leaves resume unset otherwise", async () => {
    const silent = makeHost();
    await new Opencode2SessionAdapter(silent.host).prompt("ses_1", {
      parts: [{ type: "text", text: "note" }],
      noReply: true,
    });
    expect(silent.calls.prompt).toEqual([{ sessionID: "ses_1", text: "note", resume: false }]);

    const replying = makeHost();
    await new Opencode2SessionAdapter(replying.host).prompt("ses_1", {
      parts: [{ type: "text", text: "note" }],
      noReply: false,
    });
    expect(replying.calls.prompt).toEqual([{ sessionID: "ses_1", text: "note", resume: true }]);

    const unspecified = makeHost();
    await new Opencode2SessionAdapter(unspecified.host).prompt("ses_1", {
      parts: [{ type: "text", text: "note" }],
    });
    expect(unspecified.calls.prompt[0]).toEqual({ sessionID: "ses_1", text: "note" });
    expect("resume" in (unspecified.calls.prompt[0] ?? {})).toBe(false);
  });

  it("returns the session id sentinel when the host reports an empty inbox id", async () => {
    const { host } = makeHost({
      async prompt() {
        return { id: "" };
      },
    });
    const adapter = new Opencode2SessionAdapter(host);

    expect(await adapter.prompt("ses_1", { parts: [{ type: "text", text: "go" }] })).toEqual({
      id: "ses_1",
    });
  });

  it("returns null — never throws — when the host prompt fails", async () => {
    const { host } = makeHost({
      async prompt() {
        throw new FakeClientError("UnexpectedStatus", { cause: { status: 409 }, detail: "409" });
      },
    });
    const adapter = new Opencode2SessionAdapter(host);

    expect(await adapter.prompt("ses_1", { parts: [{ type: "text", text: "go" }] })).toBeNull();
  });
});

// ── promptSync ─────────────────────────────────────────────────────────────

describe("Opencode2SessionAdapter.promptSync", () => {
  it("prompts, waits for the session to stop, then reads the reply back", async () => {
    const { host, calls } = makeHost();
    const adapter = new Opencode2SessionAdapter(host);

    const result = await adapter.promptSync("ses_1", { parts: [{ type: "text", text: "question" }] });

    expect(calls.prompt).toEqual([{ sessionID: "ses_1", text: "question" }]);
    expect(calls.wait).toEqual([{ sessionID: "ses_1" }]);
    expect(calls.context).toEqual([{ sessionID: "ses_1" }]);
    expect(result).toEqual({
      parts: [
        { type: "reasoning", text: "thinking" },
        { type: "text", text: "the answer" },
        { type: "tool" },
      ],
    });
  });

  it("picks the assistant reply created at or after the prompt", async () => {
    const older = assistantMessage([{ type: "text", text: "an older answer" }], { created: 1 }, "msg_old");
    const fresh = assistantMessage([{ type: "text", text: "the fresh answer" }], { created: PROMPTED_AT }, "msg_new");
    const { host } = makeHost({
      async context() {
        return [older, userMessage("question"), fresh];
      },
    });
    const adapter = new Opencode2SessionAdapter(host);

    expect(await adapter.promptSync("ses_1", { parts: [{ type: "text", text: "q" }] })).toEqual({
      parts: [{ type: "text", text: "the fresh answer" }],
    });
  });

  it("forwards the caller's abort signal to every v2 call", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const controller = new AbortController();
    const { host } = makeHost({
      async prompt(_input, options) {
        signals.push(options?.signal);
        return { id: "msg_inbox_1", time: { created: PROMPTED_AT } };
      },
      async wait(_input, options) {
        signals.push(options?.signal);
      },
      async context(_input, options) {
        signals.push(options?.signal);
        return [];
      },
    });
    const adapter = new Opencode2SessionAdapter(host);

    await adapter.promptSync("ses_1", { parts: [{ type: "text", text: "q" }], signal: controller.signal });

    expect(signals).toEqual([controller.signal, controller.signal, controller.signal]);
  });

  it("returns null when the session produced no assistant message", async () => {
    const { host } = makeHost({
      async context() {
        return [userMessage("question")];
      },
    });
    const adapter = new Opencode2SessionAdapter(host);

    expect(await adapter.promptSync("ses_1", { parts: [{ type: "text", text: "q" }] })).toBeNull();
  });

  it("returns null — never throws — when the synchronous read path fails", async () => {
    const { host } = makeHost({
      async wait() {
        throw new FakeClientError("Transport", { cause: new TypeError("socket closed") });
      },
    });
    const adapter = new Opencode2SessionAdapter(host);

    expect(await adapter.promptSync("ses_1", { parts: [{ type: "text", text: "q" }] })).toBeNull();
  });
});

// ── create ─────────────────────────────────────────────────────────────────

describe("Opencode2SessionAdapter.create", () => {
  it("creates in the requested location and maps the returned Session.Info", async () => {
    const { host, calls } = makeHost();
    const adapter = new Opencode2SessionAdapter(host);

    const info = await adapter.create({ directory: "/tmp/other", agent: "rolebox--worker" });

    expect(calls.create).toEqual([
      { location: { directory: "/tmp/other" }, agent: "rolebox--worker" },
    ]);
    expect(info?.id).toBe("ses_created");
    expect(info?.directory).toBe("/tmp/other");
  });

  it("does not forward parentID — v2's SessionCreateInput has no such field", async () => {
    const { host, calls } = makeHost();
    const adapter = new Opencode2SessionAdapter(host);

    await adapter.create({ directory: "/tmp/other", parentID: "ses_parent" });

    const sent = calls.create[0];
    expect(sent).toEqual({ location: { directory: "/tmp/other" } });
    expect(sent !== undefined && "parentID" in sent).toBe(false);
  });

  it("raises SessionCreateRejectedError for an undeclared HTTP status", async () => {
    const { host } = makeHost({
      async create() {
        throw new FakeClientError("UnexpectedStatus", { cause: { status: 400 }, detail: "400" });
      },
    });
    const adapter = new Opencode2SessionAdapter(host);

    const err = await thrownBy(() => adapter.create({ directory: "/tmp/other" }));

    expect(err).toBeInstanceOf(SessionCreateRejectedError);
    expect(isSessionCreateRejected(err)).toBe(true);
    expect((err as SessionCreateRejectedError).message).toBe("400 (HTTP 400)");
    expect((err as SessionCreateRejectedError).code).toBe("UnexpectedStatus");
  });

  it("raises SessionCreateRejectedError for a declared protocol error body", async () => {
    const declared = Object.assign(new Error("directory does not exist"), { _tag: "InvalidRequestError" });
    const { host } = makeHost({
      async create() {
        throw declared;
      },
    });
    const adapter = new Opencode2SessionAdapter(host);

    const err = await thrownBy(() => adapter.create({ directory: "/tmp/missing" }));

    expect(err).toBeInstanceOf(SessionCreateRejectedError);
    expect((err as SessionCreateRejectedError).message).toBe("directory does not exist");
    expect((err as SessionCreateRejectedError).code).toBe("InvalidRequestError");
  });

  it("re-throws a transport failure verbatim so the caller can retry it", async () => {
    const transport = new FakeClientError("Transport", { cause: new TypeError("fetch failed") });
    const { host } = makeHost({
      async create() {
        throw transport;
      },
    });
    const adapter = new Opencode2SessionAdapter(host);

    const err = await thrownBy(() => adapter.create({ directory: "/tmp/other" }));

    expect(err).toBe(transport);
    expect(isSessionCreateRejected(err)).toBe(false);
  });

  it("treats an unrecognized failure as transient rather than a rejection", async () => {
    const boom = new Error("something else entirely");
    const { host } = makeHost({
      async create() {
        throw boom;
      },
    });
    const adapter = new Opencode2SessionAdapter(host);

    const err = await thrownBy(() => adapter.create({ directory: "/tmp/other" }));

    expect(err).toBe(boom);
    expect(isSessionCreateRejected(err)).toBe(false);
  });
});

// ── abort ──────────────────────────────────────────────────────────────────

describe("Opencode2SessionAdapter.abort", () => {
  it("propagates the host's interrupted answer", async () => {
    const { host, calls } = makeHost();
    const adapter = new Opencode2SessionAdapter(host);

    expect(await adapter.abort("ses_1")).toBe(true);
    expect(calls.interrupt).toEqual([{ sessionID: "ses_1" }]);

    const idle = makeHost({ async interrupt() { return { interrupted: false }; } });
    expect(await new Opencode2SessionAdapter(idle.host).abort("ses_1")).toBe(false);
  });

  it("returns false — never throws — when the interrupt call fails", async () => {
    const { host } = makeHost({
      async interrupt() {
        throw new FakeClientError("Transport", { cause: new TypeError("fetch failed") });
      },
    });
    const adapter = new Opencode2SessionAdapter(host);

    expect(await adapter.abort("ses_1")).toBe(false);
  });
});
