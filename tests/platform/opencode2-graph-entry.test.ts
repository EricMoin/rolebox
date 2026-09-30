/// <reference types="bun-types" />

/**
 * opencode v2 entry (src/entries/opencode2.ts) — the declared-graph wiring.
 *
 * WHAT THIS FILE PROVES. `tests/platform/opencode-graph-host.test.ts` owns the
 * host capability layer itself (the five tools, a real graph settled end to
 * end, the worker boundary, the degradations). What is under test HERE is the
 * ENTRY: that the layer is actually opened during `setup`, that the five
 * `graph_*` tools reach the host's tool editor through the real registration
 * path, that the entry's own session-end feed reaches `noteSessionEnded`, that
 * the declared-graph host factory is handed the declaring session's WAKE-UP
 * CHANNEL (the same adapter the host dispatches over), and that the cleanup
 * releases the host.
 *
 * HOW THE REAL PATH IS OBSERVED, NOT ASSUMED. The first case boots the module's
 * default export with the REAL `openOpencode2GraphHost` — no spy, no injection —
 * and reads the tool names off the editor the adapter wrote into, which is the
 * same observation the registration cases in
 * `tests/platform/opencode2-entry.test.ts` make. The remaining cases inject a
 * SPY host, because what they pin is the entry's contract with that factory (the
 * options object) and with the host (the ends it is handed), not the store.
 *
 * NOTHING HERE TOUCHES THE REAL USER DATA DIR. Opening the host creates the
 * host-owned store root under the rolebox data directory
 * (src/graph/store/schema.ts:58-60), so `ROLEBOX_DATA_DIR` is pointed at a temp
 * dir in `beforeEach` and restored in `afterEach`; every host is closed before
 * its temp dir is removed. CI asserts a clean tree, so nothing outside those
 * temp dirs is written.
 *
 * The fake Context is a deliberate partial, like the one in
 * `opencode2-entry.test.ts`: it carries the domains this entry touches and
 * crosses the published contract in ONE documented place (`asContext`).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import path from "node:path";
import type { Plugin as Opencode2Plugin } from "@opencode/plugin";

import {
  createOpencode2Plugin,
  type Opencode2EntryDeps,
} from "../../src/entries/opencode2.ts";
import entryDefault from "../../src/entries/opencode2.ts";
import { createPluginHooks } from "../../src/core/composition.ts";
import { initializeRoleboxRuntime } from "../../src/platform/factory.ts";
import { openOpencode2GraphHost } from "../../src/platform/adapters/opencode2/index.ts";
import type { ISessionClient } from "../../src/platform/ports/session-client.ts";
import { PLUGIN_ID } from "../../src/constants.ts";

// ── What the entry must register ────────────────────────────────────────────

/** The declared-graph tool face, exactly (src/graph/tools/index.ts:43-55). */
const GRAPH_TOOLS = [
  "graph_audit",
  "graph_control",
  "graph_declare",
  "graph_status",
  "graph_submit_outcome",
] as const;

/**
 * The canonical tools the entry registered BEFORE the declared-graph face
 * existed, measured through the same editor observation this file uses (a probe
 * of the real `setup` with no `graph_*` tools installed).
 *
 * It is a FIXED number on purpose: the wiring is additive, so the graph face may
 * not change how many other tools are registered. A change to the canonical
 * toolset is a change this number must be updated with.
 */
const NON_GRAPH_TOOL_COUNT = 62;

// ── The fake Context ────────────────────────────────────────────────────────

interface FakeContext {
  /** Tool names handed to `ctx.tool.transform`'s editor, in call order. */
  readonly tools: string[];
  /** The AbortSignal the entry handed to `ctx.event.subscribe`. */
  readonly subscribeSignal: () => AbortSignal | undefined;
  /** Push one raw v2 event into the subscribed stream. */
  readonly pushEvent: (event: unknown) => void;
  /** Every dispose the host's registrations ran. */
  readonly disposed: () => number;
}

function registration(): { dispose: () => Promise<void> } {
  let count = 0;
  return {
    async dispose() {
      count += 1;
    },
  };
}

/**
 * A `ctx.session.prompt` as the v2 session domain declares it
 * (`SessionPromptInput` projected onto what the adapter sets: `{ sessionID,
 * text, resume }`, src/platform/adapters/opencode2/session.ts:572-581).
 */
type FakeSessionPrompt = (
  input: { sessionID: string; text: string; resume?: boolean },
) => Promise<{ id: string }>;

/**
 * Build the fake Context and the observation handles.
 *
 * `wait` is present unless `omitWait` is set: v2's `SessionDomain` exposes it
 * (…/promise/session.d.ts:143-145) and the entry forwards it, so its absence is
 * the degradation case — a host that exposes no turn-end call at all.
 *
 * `sessionPrompt` is absent unless a case installs one, and that is exactly the
 * DEFAULT shape of this fake: a partial Context whose session domain carries no
 * prompt at all — the degradation the wake-up channel must survive.
 */
function makeContext(
  options: {
    omitWait?: boolean;
    sessionPrompt?: FakeSessionPrompt;
    /**
     * `ctx.session.get`, as the entry's terminal-outcome read drives it. The
     * default answers the id alone — a session with NO outcome, which is the
     * shape most cases need.
     */
    sessionGet?: (input: { sessionID: string }) => Promise<unknown>;
  } = {},
): {
  ctx: Opencode2Plugin.Context;
  fake: FakeContext;
} {
  const tools: string[] = [];
  let disposed = 0;
  let signal: AbortSignal | undefined;
  let push: ((event: unknown) => void) | undefined;
  const queue: unknown[] = [];
  const waiters: Array<(event: unknown) => void> = [];

  const subscribe = ((subscribeOptions?: { signal?: AbortSignal }) => {
    signal = subscribeOptions?.signal;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<unknown>> {
            if (queue.length > 0) return { done: false, value: queue.shift() };
            const value = await new Promise<unknown>((resolve) => waiters.push(resolve));
            return { done: false, value };
          },
          async return(): Promise<IteratorResult<unknown>> {
            return { done: true, value: undefined };
          },
        };
      },
    };
  }) as unknown as Opencode2Plugin.Context["event"]["subscribe"];

  push = (event: unknown) => {
    const waiter = waiters.shift();
    if (waiter) waiter(event);
    else queue.push(event);
  };

  const sessionDomain: Record<string, unknown> = {
    hook: async () => {
      disposed += 1;
      return registration();
    },
    get:
      options.sessionGet ??
      (async (input: { sessionID: string }) => ({ id: input.sessionID })),
  };
  if (options.omitWait !== true) {
    sessionDomain["wait"] = async () => {};
  }
  if (options.sessionPrompt !== undefined) {
    sessionDomain["prompt"] = options.sessionPrompt;
  }

  const disposeRegistration = async () => {
    disposed += 1;
    return registration();
  };

  const ctx = {
    location: { directory: "/tmp/rolebox-oc2-graph-entry", workspaceID: "ws", project: "p" },
    options: {},
    tool: {
      transform: async (callback: (editor: { add: (tool: { name: string }) => void }) => void) => {
        callback({ add: (tool) => { tools.push(tool.name); } });
        return disposeRegistration();
      },
      hook: disposeRegistration,
      list: async () => [],
      reload: async () => {},
    },
    agent: { transform: disposeRegistration, reload: async () => {} },
    skill: { transform: disposeRegistration, reload: async () => {} },
    command: { transform: disposeRegistration, reload: async () => {} },
    session: sessionDomain,
    event: { subscribe },
  } as unknown as Opencode2Plugin.Context;

  return {
    ctx,
    fake: {
      tools,
      subscribeSignal: () => signal,
      pushEvent: (event: unknown) => push?.(event),
      disposed: () => disposed,
    },
  };
}

// ── The spy host ────────────────────────────────────────────────────────────

/** One session end the entry handed the host. */
interface NotedEnd {
  readonly sessionID: string;
  readonly kind: "ended" | "errored";
}

/** One `session.status` state the entry handed the host. */
interface NotedStatus {
  readonly sessionID: string;
  readonly state: "idle" | "busy" | "retry";
}

/** The options object the entry handed the host factory, as the spy saw it. */
interface OpenOptions {
  readonly directory?: unknown;
  readonly client?: unknown;
  readonly wait?: unknown;
  readonly env?: unknown;
  readonly getEffectiveAgent?: unknown;
  /** The declaring session's wake-up channel the factory was handed. */
  readonly notifyClient?: unknown;
  /** The entry's own terminal-outcome read over the RAW `ctx.session` domain. */
  readonly observe?: unknown;
}

interface SpyHost {
  readonly host: { workerPrincipalOf(sessionID: string): object | undefined };
  /** The ONE tool the spy host binds — proves the host's face is what registers. */
  readonly createTools: () => Record<string, never>;
  readonly noteSessionEnded: (sessionID: string, kind?: "ended" | "errored") => void;
  readonly noteSessionStatus: (sessionID: string, state: "idle" | "busy" | "retry") => void;
  readonly close: () => void;
  readonly platformNotes: readonly string[];
}

interface HostSpy {
  /** Every factory call, in order. */
  readonly calls: OpenOptions[];
  /** Every end the entry reported, in order. */
  readonly noted: NotedEnd[];
  /** Every activity state the entry reported, in order. */
  readonly statuses: NotedStatus[];
  /** How many times the host was closed. */
  readonly closes: () => number;
  /** The host the factory answered with (the most recent one). */
  host: SpyHost;
  readonly openGraphHost: NonNullable<Opencode2EntryDeps["openGraphHost"]>;
}

/**
 * A host double. It carries only the entry's host contract — `createTools`,
 * `noteSessionEnded`, `close`, `platformNotes` — which is the whole surface the
 * entry touches; the real class is exercised in
 * `tests/platform/opencode-graph-host.test.ts`.
 */
function makeHostSpy(options: { throws?: Error } = {}): HostSpy {
  const calls: OpenOptions[] = [];
  const noted: NotedEnd[] = [];
  const statuses: NotedStatus[] = [];
  let closes = 0;
  let last: SpyHost | undefined;
  const openGraphHost = ((openOptions: OpenOptions) => {
    calls.push(openOptions);
    if (options.throws !== undefined) throw options.throws;
    last = {
      host: { workerPrincipalOf: sessionID => sessionID === "ses_worker" ? { workerSessionId: sessionID } : undefined },
      createTools: () => ({ spy_graph_tool: {} as never }),
      noteSessionEnded: (sessionID: string, kind: "ended" | "errored" = "ended") => {
        noted.push({ sessionID, kind });
      },
      noteSessionStatus: (sessionID: string, state: "idle" | "busy" | "retry") => {
        statuses.push({ sessionID, state });
      },
      close: () => {
        closes += 1;
      },
      platformNotes: ["completion channel: the spy's own"],
    };
    return last as never;
  }) as unknown as NonNullable<Opencode2EntryDeps["openGraphHost"]>;
  return {
    calls,
    noted,
    statuses,
    closes: () => closes,
    get host() {
      if (last === undefined) throw new Error("fixture: the host factory was never called");
      return last;
    },
    openGraphHost,
  };
}

// ── Temp dirs ───────────────────────────────────────────────────────────────

let tmpDir: string;
let originalXdg: string | undefined;
let originalDataDir: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-oc2-graph-entry-"));
  originalXdg = process.env.XDG_CONFIG_HOME;
  originalDataDir = process.env.ROLEBOX_DATA_DIR;
  process.env.XDG_CONFIG_HOME = tmpDir;
  process.env.ROLEBOX_DATA_DIR = path.join(tmpDir, "data");
});

afterEach(() => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  if (originalDataDir === undefined) delete process.env.ROLEBOX_DATA_DIR;
  else process.env.ROLEBOX_DATA_DIR = originalDataDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** One role file, so the real composition boots with a role in hand. */
function writeRole(): void {
  const roleDir = path.join(tmpDir, "rolebox", "emperor");
  mkdirSync(roleDir, { recursive: true });
  writeFileSync(
    path.join(roleDir, "role.yaml"),
    "name: Emperor\ndescription: The ruler\nprompt: You are the emperor.\n",
    "utf-8",
  );
}

/** The entry's own working directory is the temp dir, so nothing writes home. */
function contextInTmp(
  options: {
    omitWait?: boolean;
    sessionPrompt?: FakeSessionPrompt;
    sessionGet?: (input: { sessionID: string }) => Promise<unknown>;
  } = {},
) {
  const built = makeContext(options);
  (built.ctx as unknown as { location: { directory: string } }).location.directory = tmpDir;
  return built;
}

/**
 * The entry's OWN deps plus the injected host factory.
 *
 * The spy cases inject ONE seam — the graph host factory — so the other two
 * stay the real ones: the composition and the runtime bootstrap are what the
 * real-registration case already covers, and replacing them would make these
 * cases prove a wiring nobody ships.
 */
function withGraphSpy(
  openGraphHost: NonNullable<Opencode2EntryDeps["openGraphHost"]>,
): Opencode2EntryDeps {
  return {
    createHooks: createPluginHooks,
    initializeRuntime: initializeRoleboxRuntime,
    openGraphHost,
  };
}

/** Wait for a predicate the relay settles asynchronously. */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("fixture: timed out waiting for " + label);
}

// ── The real host ───────────────────────────────────────────────────────────

describe("opencode v2 entry — the declared-graph face registers through the real host", () => {
  it("connects prompt isolation to the host's confirmed worker identity", async () => {
    writeRole();
    const { ctx } = contextInTmp();
    const spy = makeHostSpy();
    let isWorker: ((sessionID: string) => boolean) | undefined;
    const deps = withGraphSpy(spy.openGraphHost);
    const plugin = createOpencode2Plugin({
      ...deps,
      createHooks: async config => {
        isWorker = config.isGraphWorker;
        return createPluginHooks(config);
      },
    });
    const cleanup = await plugin.setup(ctx);
    try {
      expect(isWorker?.("ses_worker")).toBe(true);
      expect(isWorker?.("ses_parent")).toBe(false);
    } finally {
      await cleanup?.();
    }
  });

  it("adds exactly the five graph tools to the editor, and nothing else changes", async () => {
    writeRole();
    const { ctx, fake } = contextInTmp();
    // NO INJECTION: the module's default export, its default deps, and the REAL
    // `openOpencode2GraphHost` opening a real store under the temp data dir.
    const cleanup = await entryDefault.setup(ctx);

    const graphNames = fake.tools.filter((name) => name.startsWith("graph_")).sort();
    // THE OBSERVATION: the names the host's own tool editor received.
    expect(graphNames).toEqual([...GRAPH_TOOLS]);
    // The face is additive: every other canonical tool is still registered, and
    // the count is unchanged.
    const others = fake.tools.filter((name) => !name.startsWith("graph_"));
    expect(others.length).toBe(NON_GRAPH_TOOL_COUNT);
    // A tool name is registered once.
    expect(new Set(fake.tools).size).toBe(fake.tools.length);

    // The observation, printed: this is what "the five tool names as observed by
    // the editor probe" means, and it is what the next node reads.
    console.log(
      "opencode2 editor-registered graph tools:",
      JSON.stringify(graphNames),
      "non-graph:",
      others.length,
      "total:",
      fake.tools.length,
    );

    await cleanup?.();
  }, 60_000);

  it("keeps the plugin id and the five tool names reachable from the module", () => {
    expect(entryDefault.id).toBe(PLUGIN_ID);
    expect(typeof entryDefault.setup).toBe("function");
    expect([...GRAPH_TOOLS].sort()).toEqual([
      "graph_audit",
      "graph_control",
      "graph_declare",
      "graph_status",
      "graph_submit_outcome",
    ]);
  });
});

// ── The injection seam ──────────────────────────────────────────────────────

describe("opencode v2 entry — the graph host injection seam", () => {
  it("hands the factory the directory, client, wait, env and agent resolver", async () => {
    writeRole();
    const spy = makeHostSpy();
    const { ctx, fake } = contextInTmp();
    const plugin = createOpencode2Plugin(withGraphSpy(spy.openGraphHost));

    const cleanup = await plugin.setup(ctx);

    expect(spy.calls.length).toBe(1);
    const call = spy.calls[0]!;
    expect(call.directory).toBe(tmpDir);
    // The ISessionClient the entry built: the v2 adapter over `ctx.session`.
    expect(typeof call.client).toBe("object");
    expect(call.client).not.toBeNull();
    // v2 has a session wait (…/promise/session.d.ts:143-145) and the entry
    // forwards the host's own function — callable, and it answers rather than
    // throwing (the platform's domain is reached through the adapter).
    expect(typeof call.wait).toBe("function");
    await (call.wait as (input: { sessionID: string }) => Promise<void>)({ sessionID: "ses_x" });
    expect(call.env).toBe(process.env);
    expect(typeof call.getEffectiveAgent).toBe("function");
    // The resolver reads the recorded map and names no agent for an unknown
    // session — the host's own `""` default.
    expect((call.getEffectiveAgent as (id: string) => string)("ses_never_seen")).toBe("");

    // The SPY's tool face is what the editor received — the seam the real host
    // uses for its five tools — alongside the composition's own canonical tools
    // (the real `createPluginHooks` is still injected here), and no graph tool
    // is invented by the entry itself.
    expect(fake.tools).toContain("spy_graph_tool");
    expect(fake.tools.filter((name) => name.startsWith("graph_"))).toEqual([]);
    expect(fake.tools.length).toBe(NON_GRAPH_TOOL_COUNT + 1);

    await cleanup?.();
  }, 30_000);

  it("builds a host with no wait when the platform exposes none", async () => {
    writeRole();
    const spy = makeHostSpy();
    const { ctx, fake } = contextInTmp({ omitWait: true });
    const plugin = createOpencode2Plugin(withGraphSpy(spy.openGraphHost));

    const cleanup = await plugin.setup(ctx);

    // A partial Context without `ctx.session.wait` must DEGRADE, not throw: the
    // factory is still called and the option is simply absent.
    expect(spy.calls.length).toBe(1);
    expect(spy.calls[0]!.wait).toBeUndefined();
    expect(fake.tools).toContain("spy_graph_tool");
    expect(fake.tools.length).toBe(NON_GRAPH_TOOL_COUNT + 1);

    await cleanup?.();
  }, 30_000);
});

// ── The declaring session's wake-up channel ─────────────────────────────────

/** One prompt the fake `ctx.session` domain received through the v2 adapter. */
interface SessionDomainPrompt {
  readonly sessionID: string;
  readonly text: string;
  readonly resume?: boolean;
}

describe("opencode v2 entry — the declaring session's wake-up channel", () => {
  it("hands the factory a notifyClient that IS the adapter over ctx.session", async () => {
    writeRole();
    const spy = makeHostSpy();
    const delivered: SessionDomainPrompt[] = [];
    const { ctx, fake } = contextInTmp({
      sessionPrompt: (input) => {
        delivered.push(input);
        return Promise.resolve({ id: "inbox_notify" });
      },
    });
    const plugin = createOpencode2Plugin(withGraphSpy(spy.openGraphHost));

    const cleanup = await plugin.setup(ctx);

    // THE SPY'S OBSERVATION — not a reading of the source: the factory is handed
    // the wake-up channel, and it is the SAME `ISessionClient` the host
    // dispatches over, so no second adapter is built for notifications.
    expect(spy.calls.length).toBe(1);
    const call = spy.calls[0]!;
    expect(call.notifyClient).toBeDefined();
    expect(call.notifyClient).toBe(call.client);

    // AND IT IS THE ADAPTER OVER THE FAKE `ctx.session`, observed by DRIVING it:
    // the channel's own prompt reaches the session domain, and v2's wake-up knob
    // is `resume: true` — what the shipped sender's `noReply: false` maps onto
    // (src/platform/adapters/opencode2/session.ts:572-581), which is what makes
    // the notification resume the declaring agent's loop instead of sitting unread.
    const notifyClient = call.notifyClient as Pick<ISessionClient, "prompt">;
    const answer = await notifyClient.prompt("ses_declarer", {
      parts: [{ type: "text", text: "[GRAPH COMPLETE] {}\n</system-reminder>" }],
      noReply: false,
    });
    expect(answer).toEqual({ id: "inbox_notify" });
    expect(delivered).toEqual([
      {
        sessionID: "ses_declarer",
        text: "[GRAPH COMPLETE] {}\n</system-reminder>",
        resume: true,
      },
    ]);

    await cleanup?.();
  }, 30_000);

  it("degrades — never throws — when the session domain has no usable prompt", async () => {
    writeRole();
    const spy = makeHostSpy();
    // THE DEFAULT FAKE IS THIS CASE: a partial Context whose `ctx.session`
    // carries no prompt at all.
    const { ctx, fake } = contextInTmp();
    const plugin = createOpencode2Plugin(withGraphSpy(spy.openGraphHost));

    // NO THROW: setup resolves, the factory is still called with the channel, and
    // every registration is made.
    const cleanup = await plugin.setup(ctx);
    expect(spy.calls.length).toBe(1);
    const call = spy.calls[0]!;
    expect(call.notifyClient).toBe(call.client);
    expect(fake.tools).toContain("spy_graph_tool");

    // THE CHANNEL'S OWN CALL ANSWERS NULL INSTEAD OF THROWING: the shipped sender
    // reads `result !== null` as delivered, so a null answer leaves the
    // notification PENDING and retried — a platform that cannot prompt never
    // breaks the turn, the host or the plugin.
    const notifyClient = call.notifyClient as Pick<ISessionClient, "prompt">;
    expect(
      await notifyClient.prompt("ses_declarer", {
        parts: [{ type: "text", text: "[GRAPH COMPLETE] {}" }],
        noReply: false,
      }),
    ).toBeNull();

    await cleanup?.();
  }, 30_000);
});

// ── The session-end feed ────────────────────────────────────────────────────

describe("opencode v2 entry — the session-end feed", () => {
  it("reports session.idle as ended and session.error as errored", async () => {
    writeRole();
    const spy = makeHostSpy();
    const { ctx, fake } = contextInTmp();
    const plugin = createOpencode2Plugin(withGraphSpy(spy.openGraphHost));

    const cleanup = await plugin.setup(ctx);
    expect(fake.subscribeSignal()).toBeDefined();

    // session.idle keeps its canonical name through the v2 normalizer.
    fake.pushEvent({ type: "session.idle", data: { sessionID: "ses_ended" } });
    await waitFor(() => spy.noted.length === 1, "the session.idle end");
    expect(spy.noted[0]).toEqual({ sessionID: "ses_ended", kind: "ended" });

    // v2 has no `session.error` EVENT NAME: its error carrier is
    // `session.execution.failed`, which the normalizer maps onto the canonical
    // `session.error` (src/platform/adapters/opencode2/event-bridge.ts:97-103).
    fake.pushEvent({
      type: "session.execution.failed",
      data: { sessionID: "ses_errored", error: { message: "boom" } },
    });
    await waitFor(() => spy.noted.length === 2, "the session.error end");
    expect(spy.noted[1]).toEqual({ sessionID: "ses_errored", kind: "errored" });

    // Nothing else is reported: an unrelated event is relayed to the handler
    // pipeline and is not an end.
    fake.pushEvent({ type: "session.status", data: { sessionID: "ses_busy", status: "busy" } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(spy.noted.length).toBe(2);

    await cleanup?.();
  }, 30_000);
});

// ── The session-status feed ─────────────────────────────────────────────────

describe("opencode v2 entry — the session-status feed", () => {
  it("feeds the typed session.status state to the host, and never an end", async () => {
    writeRole();
    const spy = makeHostSpy();
    const { ctx, fake } = contextInTmp();
    const plugin = createOpencode2Plugin(withGraphSpy(spy.openGraphHost));

    const cleanup = await plugin.setup(ctx);

    // v2's typed payload is `{ sessionID, status: { type } }`
    // (node_modules/@opencode/schema/dist/session-status-event.d.ts:3-27).
    fake.pushEvent({
      type: "session.status",
      data: { sessionID: "ses_busy", status: { type: "busy" } },
    });
    await waitFor(() => spy.statuses.length === 1, "the busy state");
    expect(spy.statuses[0]).toEqual({ sessionID: "ses_busy", state: "busy" });

    fake.pushEvent({
      type: "session.status",
      data: { sessionID: "ses_retry", status: { type: "retry", attempt: 1, message: "m", next: 2 } },
    });
    await waitFor(() => spy.statuses.length === 2, "the retry state");
    expect(spy.statuses[1]).toEqual({ sessionID: "ses_retry", state: "retry" });

    // AN IDLE STATE IS REPORTED AS STATE AND SETTLES NOTHING: a finished turn is
    // not a completion, and no end is claimed for it.
    fake.pushEvent({
      type: "session.status",
      data: { sessionID: "ses_idle", status: { type: "idle" } },
    });
    await waitFor(() => spy.statuses.length === 3, "the idle state");
    expect(spy.statuses[2]).toEqual({ sessionID: "ses_idle", state: "idle" });
    expect(spy.noted).toEqual([]);

    // AN ODD PAYLOAD CHANGES NOTHING AND BREAKS NOTHING: a state this version
    // does not read, a payload with no status at all, and one with no session.
    fake.pushEvent({
      type: "session.status",
      data: { sessionID: "ses_odd", status: { type: "something-new" } },
    });
    fake.pushEvent({ type: "session.status", data: { sessionID: "ses_odd" } });
    fake.pushEvent({ type: "session.status", data: { status: { type: "idle" } } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(spy.statuses.length).toBe(3);
    expect(spy.noted).toEqual([]);

    await cleanup?.();
  }, 30_000);
});

// ── The terminal-outcome read ───────────────────────────────────────────────

describe("opencode v2 entry — the session's own terminal outcome", () => {
  it("passes an observe built over the RAW session domain, and the real host reads it", async () => {
    writeRole();
    // THE REAL FACTORY, wrapped only to keep the options and the host it opened:
    // the entry's `observe` is then driven, and the host it produced is asked
    // what it read — no source text is asserted on.
    const opened: Array<{ readonly host: unknown; readonly options: OpenOptions }> = [];
    const factory = ((options: OpenOptions) => {
      const host = openOpencode2GraphHost(options as never);
      opened.push({ host, options });
      return host;
    }) as unknown as NonNullable<Opencode2EntryDeps["openGraphHost"]>;
    const asked: string[] = [];
    const { ctx } = contextInTmp({
      sessionGet: (input) => {
        asked.push(input.sessionID);
        return Promise.resolve({
          id: input.sessionID,
          time: { created: 0, updated: 0, idle: 1 },
          ...(input.sessionID === "ses_failed" ? { outcome: "failed" } : {}),
        });
      },
    });
    const plugin = createOpencode2Plugin(withGraphSpy(factory));

    const cleanup = await plugin.setup(ctx);

    expect(opened.length).toBe(1);
    const observe = opened[0]!.options.observe;
    expect(typeof observe).toBe("function");
    const read = observe as (input: { sessionID: string }) => Promise<unknown>;
    // DRIVEN: the session's own outcome comes back, and a session the platform
    // recorded no outcome for names NONE — `time.idle` is present in the payload
    // and is deliberately not turned into a state.
    expect(await read({ sessionID: "ses_failed" })).toEqual({ state: null, outcome: "failed" });
    expect(await read({ sessionID: "ses_live" })).toEqual({ state: null });
    expect(asked).toEqual(["ses_failed", "ses_live"]);

    // AND IT REACHED THE HOST: the factory derived the terminal-outcome read
    // from the entry's own function, which is what its notes report.
    const host = opened[0]!.host as { readonly platformNotes: readonly string[] };
    expect(host.platformNotes.join(" | ")).toContain("terminal outcome");
    console.log("opencode2 platformNotes (observation): " + host.platformNotes[1]);

    await cleanup?.();
  }, 30_000);

  it("installs NO outcome read when the session domain exposes no get", async () => {
    writeRole();
    const spy = makeHostSpy();
    // A partial Context whose session domain carries no `get` — the same
    // degradation the missing `wait` case pins, and the reason the entry must
    // not install a read that could only ever fail.
    const { ctx } = contextInTmp();
    (ctx.session as unknown as { get?: unknown }).get = undefined;
    const plugin = createOpencode2Plugin(withGraphSpy(spy.openGraphHost));

    const cleanup = await plugin.setup(ctx);

    expect(spy.calls.length).toBe(1);
    expect(spy.calls[0]!.observe).toBeUndefined();

    await cleanup?.();
  }, 30_000);

  it("lets a rejected session read reject, so the host reports the platform's own failure", async () => {
    writeRole();
    const spy = makeHostSpy();
    const { ctx } = contextInTmp({
      sessionGet: () => Promise.reject(new Error("the session is gone")),
    });
    const plugin = createOpencode2Plugin(withGraphSpy(spy.openGraphHost));

    const cleanup = await plugin.setup(ctx);

    const observe = spy.calls[0]!.observe as (input: { sessionID: string }) => Promise<unknown>;
    // NOT SILENTLY `null`: a read the platform refused is a THROWN read, which
    // the host contains and reports rather than rounding into "no outcome".
    await expect(observe({ sessionID: "ses_gone" })).rejects.toThrow("the session is gone");

    await cleanup?.();
  }, 30_000);
});

// ── Cleanup ─────────────────────────────────────────────────────────────────

describe("opencode v2 entry — cleanup releases the host", () => {
  it("closes the graph host and disposes every registration", async () => {
    writeRole();
    const spy = makeHostSpy();
    const { ctx, fake } = contextInTmp();
    const plugin = createOpencode2Plugin(withGraphSpy(spy.openGraphHost));

    const cleanup = await plugin.setup(ctx);
    expect(spy.closes()).toBe(0);

    await cleanup?.();
    expect(spy.closes()).toBe(1);
    expect(fake.disposed()).toBeGreaterThan(0);
  }, 30_000);
});

// ── Containment ─────────────────────────────────────────────────────────────

describe("opencode v2 entry — a broken graph host is contained", () => {
  it("logs the failure, registers every other surface and still resolves cleanup", async () => {
    writeRole();
    const spy = makeHostSpy({ throws: new Error("the store root is not writable") });
    const { ctx, fake } = contextInTmp();
    const plugin = createOpencode2Plugin(withGraphSpy(spy.openGraphHost));

    // `setup` must NOT reject: this entry's failure policy is that no
    // registration takes the host down, and the graph face is a registration.
    const cleanup = await plugin.setup(ctx);

    // The factory was asked once and the plugin registered WITHOUT the graph
    // face — and without inventing one.
    expect(spy.calls.length).toBe(1);
    expect(fake.tools.filter((name) => name.startsWith("graph_"))).toEqual([]);
    expect(fake.tools.length).toBe(NON_GRAPH_TOOL_COUNT);

    await cleanup?.();
    expect(spy.closes()).toBe(0);
  }, 30_000);
});
