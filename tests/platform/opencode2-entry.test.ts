/// <reference types="bun-types" />

/**
 * The opencode v2 plugin entry (src/entries/opencode2.ts).
 *
 * Two contracts are proven here:
 *
 *  1. THE LOAD CONTRACT — opencode 2.x resolves `<package>/server` and requires
 *     a default export shaped `{ id, setup }` where `setup` returns a Cleanup
 *     (node_modules/@opencode/plugin/dist/promise/plugin.d.ts:54-59). The module
 *     is imported for real and its default export is checked against that shape.
 *
 *  2. THE WIRING — `setup(ctx)` must project rolebox's v1 handler map onto the
 *     v2 domains: tools through `ctx.tool.transform`, tool/session hooks through
 *     `ctx.tool.hook` / `ctx.session.hook`, roles/skills/the loop-stop command
 *     through their transforms, and the event stream through
 *     `ctx.event.subscribe`. The returned Cleanup must dispose every one of them.
 *
 * The service graph is injected (`Opencode2EntryDeps`) rather than booted: the
 * real composition spawns eleven services, LSP clients and process-level
 * handlers, which is what tests/index.test.ts already covers for v1. What is
 * under test here is the ADAPTER between the two handler vocabularies, so the
 * fake hands `setup` exactly the handler map the real composition returns.
 *
 * The fake Context is a deliberate partial: it carries only the domains the
 * entry touches, then crosses the published contract in ONE documented place
 * (`asContext`). Every field's type is derived from the real `Plugin.Context`
 * it stands in for, so a 2.0.18 shape change breaks the compile instead of the
 * test.
 *
 * Nothing here writes to the repository: the entry's working directory is a
 * temp dir and `XDG_CONFIG_HOME` is redirected to it.
 */

import { getEventListeners } from "node:events";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import path from "node:path";
import type { Plugin as Opencode2Plugin } from "@opencode/plugin";
import {
  createOpencode2Plugin,
  type Opencode2EntryDeps,
} from "../../src/entries/opencode2.ts";
import entryDefault from "../../src/entries/opencode2.ts";
import { FunctionSource, PLUGIN_ID, SkillScope } from "../../src/constants.ts";
import { hookState, HookState } from "../../src/hooks/state.ts";
import { functionSessionState } from "../../src/function/session-state.ts";
import { functionRuntime } from "../../src/function/runtime-state.ts";
import { handleChatMessage } from "../../src/hooks/chat-message.ts";
import type { HookDeps } from "../../src/hooks/deps.ts";
import type { ResolvedFunction, ResolvedRole } from "../../src/types.ts";

// ── Domain shapes, derived from the real Context ────────────────────────────

/** `{ dispose }` (…/promise/registration.d.ts:1-3). */
type Registration = { dispose: () => Promise<void> };
type Cleanup = Opencode2Plugin.Cleanup;
type ToolEditor = Parameters<Parameters<Opencode2Plugin.Context["tool"]["transform"]>[0]>[0];
type AgentEditor = Parameters<Parameters<Opencode2Plugin.Context["agent"]["transform"]>[0]>[0];
type SkillEditor = Parameters<Parameters<Opencode2Plugin.Context["skill"]["transform"]>[0]>[0];
type CommandEditor = Parameters<Parameters<Opencode2Plugin.Context["command"]["transform"]>[0]>[0];
/**
 * The v2 hook events, as the adapter under test sees them.
 *
 * A v2 hook callback is generic over its own event names
 * (…/promise/registration.d.ts:13), so `Parameters<ctx.tool.hook>[1]` cannot
 * extract one event type — the entry declares its own structural views and the
 * fakes reproduce the SAME shapes, so both sides are fixed to the published
 * declarations:
 *   - tool `execute.before` / `execute.after`
 *     (…/promise/tool.d.ts:24-43 — ids + mutable `input`, `after` pinned to
 *     `status: "completed" | "error"`),
 *   - `session.prompt` → `SessionPrompt` (…/promise/session.d.ts:13-19),
 *   - `session.context` → `SessionContext` (…/promise/session.d.ts:29-35),
 *   - `session.compaction` → `SessionCompaction` (…/promise/session.d.ts:40-45).
 */
interface ToolBeforeEvent {
  tool: string;
  sessionID: string;
  agent: string;
  messageID: string;
  id: string;
  input: unknown;
}

type ToolAfterEvent = Omit<ToolBeforeEvent, "id"> & { id: string } & (
  | { status: "completed"; result: unknown }
  | { status: "error"; error: unknown }
);

/**
 * The object the 1.x host hands `handleToolAfter`
 * (node_modules/@opencode-ai/plugin/dist/index.d.ts:249-258): `{ title, output,
 * metadata }`. The fake handler is typed as THIS shape, so the assertions below
 * pin the field names a 1.x consumer reads — not the v2 event's `status`.
 */
interface V1ToolAfterOutput {
  title: string;
  output: string;
  metadata: Record<string, unknown>;
}

interface SessionContextEvent {
  sessionID: string;
  agent: string;
  /**
   * v2 `SystemPart` (node_modules/@opencode/ai/dist/schema/messages.d.ts:7-13):
   * `{ type: "text", text, cache?, metadata? }`. The extra fields are the ones
   * the mapping must not drop for parts the hook does not touch.
   */
  system: Array<{
    type: "text";
    text: string;
    cache?: unknown;
    metadata?: Record<string, unknown>;
  }>;
}

type PromptEvent = {
  sessionID: string;
  messageID: string;
  prompt: { text: string };
  delivery: string;
};

type CompactionEvent = SessionContextEvent & {
  result?: { summary: string; metadata?: Record<string, unknown> };
};
type ContextEvent = SessionContextEvent;

/** `Opencode2Plugin.Context["tool"]["hook"]` restricted to the two names the entry uses. */
type ToolHookName = "execute.before" | "execute.after";
type SessionHookName = "prompt" | "context" | "compaction";

/** `Plugin.Cleanup` is `void | (() => Promise<void> | void)`. */
async function runSetup(setup: Opencode2Plugin.Plugin["setup"], ctx: Opencode2Plugin.Context) {
  const cleanup = await setup(ctx);
  expect(typeof cleanup).toBe("function");
  return cleanup as () => Promise<void>;
}

// ── Fake Context ────────────────────────────────────────────────────────────

interface FakeContext {
  /** Every transform/hook call in registration order. */
  calls: string[];
  /** Tool names handed to `ctx.tool.transform`'s editor. */
  tools: string[];
  /** Skill ids handed to `ctx.skill.transform`'s editor. */
  skills: string[];
  /** Command names handed to `ctx.command.transform`'s editor. */
  commands: string[];
  /** Agent ids passed to the agent editor's `update`. */
  agents: string[];
  /**
   * The session's acting agent as `ctx.session.get` answers it
   * (SessionInfo.agent, …/promise/session.d.ts:143-145 +
   * …/generated/types.d.ts:2788-2814). `undefined` models a host that knows no
   * agent for the session.
   */
  sessionAgent?: string;
  /** Every sessionID passed to `ctx.session.get`. */
  sessionGetCalls: string[];
  toolBefore?: (event: ToolBeforeEvent) => Promise<void> | void;
  toolAfter?: (event: ToolAfterEvent) => Promise<void> | void;
  prompt?: (event: PromptEvent) => Promise<void> | void;
  context?: (event: ContextEvent) => Promise<void> | void;
  compaction?: (event: CompactionEvent) => Promise<void> | void;
  /** How many times a registration was disposed. */
  disposed: number;
  /** Pushes one event to the subscriber, then blocks until aborted. */
  pushEvent(event: unknown): void;
  /**
   * The AbortSignal the entry handed to `ctx.event.subscribe` — set only when
   * the host declares the `options` parameter the entry checks for.
   */
  subscribeSignal?: AbortSignal;
}

function registration(onDispose: () => void): Registration {
  return {
    async dispose() {
      onDispose();
    },
  };
}

/**
 * Build the fake Context. The hooks and transforms are typed against the real
 * `Plugin.Context` members they stand in for; the assembled object crosses into
 * `Plugin.Context` exactly once, at the `as unknown as` below, because the fake
 * only carries the domains this entry touches.
 */
function makeContext(options: { failToolTransform?: boolean; failEventSubscribe?: boolean } = {}): {
  ctx: Opencode2Plugin.Context;
  fake: FakeContext;
} {
  const fake: FakeContext = {
    calls: [],
    tools: [],
    skills: [],
    commands: [],
    agents: [],
    sessionGetCalls: [],
    disposed: 0,
    pushEvent: () => {},
  };
  let push: ((event: unknown) => void) | undefined;
  const queue: unknown[] = [];
  const waiters: Array<(event: unknown) => void> = [];

  const toolTransform: Opencode2Plugin.Context["tool"]["transform"] = async (callback) => {
    fake.calls.push("tool.transform");
    if (options.failToolTransform) throw new Error("tool.transform rejected by the host");
    const editor = {
      add(tool: { name: string }) {
        fake.tools.push(tool.name);
      },
    } as unknown as ToolEditor;
    callback(editor);
    return registration(() => { fake.disposed += 1; });
  };

  const toolHook = (async (name: ToolHookName, callback: (event: ToolBeforeEvent) => void) => {
    fake.calls.push(`tool.hook:${name}`);
    if (name === "execute.before") {
      fake.toolBefore = callback as unknown as FakeContext["toolBefore"];
    } else {
      fake.toolAfter = callback as unknown as FakeContext["toolAfter"];
    }
    return registration(() => { fake.disposed += 1; });
  }) as Opencode2Plugin.Context["tool"]["hook"];

  const sessionHook = (async (name: SessionHookName, callback: never) => {
    fake.calls.push(`session.hook:${name}`);
    if (name === "prompt") fake.prompt = callback as unknown as FakeContext["prompt"];
    if (name === "context") fake.context = callback as unknown as FakeContext["context"];
    if (name === "compaction") fake.compaction = callback as unknown as FakeContext["compaction"];
    return registration(() => { fake.disposed += 1; });
  }) as unknown as Opencode2Plugin.Context["session"]["hook"];

  const agentTransform: Opencode2Plugin.Context["agent"]["transform"] = async (callback) => {
    fake.calls.push("agent.transform");
    const editor = {
      update(id: string, update: (agent: never) => void) {
        fake.agents.push(id);
        update({} as never);
      },
    } as unknown as AgentEditor;
    callback(editor);
    return registration(() => { fake.disposed += 1; });
  };

  const skillTransform: Opencode2Plugin.Context["skill"]["transform"] = async (callback) => {
    fake.calls.push("skill.transform");
    const editor = {
      add(skill: { id: string }) {
        fake.skills.push(skill.id);
      },
    } as unknown as SkillEditor;
    callback(editor);
    return registration(() => { fake.disposed += 1; });
  };

  const commandTransform: Opencode2Plugin.Context["command"]["transform"] = async (callback) => {
    fake.calls.push("command.transform");
    const editor = {
      add(definition: { name: string }) {
        fake.commands.push(definition.name);
      },
    } as unknown as CommandEditor;
    callback(editor);
    return registration(() => { fake.disposed += 1; });
  };

  const subscribe = ((
    // 1-arity ON PURPOSE: the entry passes its AbortSignal only when
    // `subscribe.length > 0` (src/entries/opencode2.ts:676-678), so the fake
    // has to declare the parameter to see the signal the relay registers on.
    subscribeOptions?: { signal?: AbortSignal },
  ) => {
    fake.calls.push("event.subscribe");
    if (options.failEventSubscribe) throw new Error("event.subscribe rejected by the host");
    fake.subscribeSignal = subscribeOptions?.signal;
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
  fake.pushEvent = (event: unknown) => push?.(event);

  const ctx = {
    location: { directory: "/tmp/rolebox-opencode2-entry", workspaceID: "ws", project: "p" },
    options: {},
    tool: { transform: toolTransform, hook: toolHook, list: async () => [], reload: async () => {} },
    agent: { transform: agentTransform, reload: async () => {} },
    skill: { transform: skillTransform, reload: async () => {} },
    command: { transform: commandTransform, reload: async () => {} },
    session: {
      hook: sessionHook,
      // `SessionDomain` exposes `get` (…/promise/session.d.ts:143-145); the
      // entry reads SessionInfo.agent from it to resolve who is prompting.
      get: async (input: { sessionID: string }) => {
        fake.sessionGetCalls.push(input.sessionID);
        return { id: input.sessionID, agent: fake.sessionAgent };
      },
    },
    event: { subscribe },
  } as unknown as Opencode2Plugin.Context;

  return { ctx, fake };
}

// ── Injected deps ───────────────────────────────────────────────────────────

/**
 * One role with one ROLE-LOCAL skill. The scope matters: only
 * `SkillScope.Rolebox` entries are rolebox's to register
 * (src/platform/adapters/opencode2/skills.ts:161-163), and the body is read
 * through the real `loadSkillContent`, so the skill file below is written to
 * disk (inside the temp dir) instead of stubbing the reader.
 */
function makeRole(skillFilePath: string): ResolvedRole {
  return {
    id: "emperor",
    config: { name: "Emperor", description: "The ruler", prompt: "You are the emperor." },
    prompt: "You are the emperor.",
    skills: [
      {
        name: "emperor",
        description: "The ruler's skill",
        scope: SkillScope.Rolebox,
        filePath: skillFilePath,
        references: [],
      },
    ],
    functions: [],
    references: [],
    subagents: [],
  };
}

/**
 * How much the fake v1 compaction handler contributes. `handleCompacting`
 * pushes its runtime-state block into `output.context` only when rolebox has
 * state to preserve (src/hooks/compaction.ts:102); an empty list models a
 * session with nothing to carry.
 */
interface HandlerOptions {
  compactingContext?: string[];
}

/** The v1 handler map as `createPluginHooks` returns it (composition.ts:176-190). */
function makeHandlers(
  calls: string[],
  afterOutputs: V1ToolAfterOutput[],
  options: HandlerOptions = {},
) {
  return {
    tool: {
      rolebox_ping: {
        description: "Ping",
        args: { value: { type: "string" } },
        execute: async () => "pong",
      },
    },
    event: async (input: { event: { type: string; properties?: Record<string, unknown> } }) => {
      calls.push(`event:${input.event.type}`);
    },
    "chat.message": async (
      input: { agent?: string; sessionID: string },
      output: { parts: Array<{ type: string; text?: string }> },
    ) => {
      // The agent is recorded on purpose: `input.agent` is what scopes the v1
      // handler's work, so a case can pin what the entry forwarded.
      calls.push(`chat.message:${input.sessionID}:${input.agent}`);
      const part = output.parts[0];
      if (part?.text === "expand me") part.text = "expanded";
    },
    "tool.execute.before": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: unknown },
    ) => {
      calls.push(`tool.execute.before:${input.tool}:${input.callID}`);
      output.args = { rewritten: true };
    },
    "tool.execute.after": async (
      input: { sessionID?: string; tool?: string; args?: unknown },
      output: V1ToolAfterOutput,
    ) => {
      calls.push(`tool.execute.after:${input.tool}`);
      afterOutputs.push(output);
    },
    "experimental.chat.system.transform": async (
      input: { sessionID?: string; agent?: string },
      output: { system: string[] },
    ) => {
      calls.push(`system.transform:${input.sessionID}:${input.agent}`);
      const rewritable = output.system.indexOf("rewrite me");
      if (rewritable >= 0) output.system[rewritable] = "rewritten by rolebox";
      output.system.push("rolebox block");
    },
    "experimental.session.compacting": async (
      _input: { sessionID: string },
      output: { context: string[] },
    ) => {
      calls.push("compacting");
      const blocks = options.compactingContext ?? ["## Rolebox Runtime State"];
      for (const block of blocks) output.context.push(block);
    },
    dispose: async () => {
      calls.push("handlers.dispose");
    },
  };
}

function makeDeps(role: ResolvedRole, options: HandlerOptions = {}): {
  deps: Opencode2EntryDeps;
  calls: string[];
  /** Every object the entry handed `tool.execute.after`, in call order. */
  afterOutputs: V1ToolAfterOutput[];
} {
  const calls: string[] = [];
  const afterOutputs: V1ToolAfterOutput[] = [];
  const handlers = makeHandlers(calls, afterOutputs, options);
  const deps: Opencode2EntryDeps = {
    createHooks: (async () => {
      calls.push("createHooks");
      return handlers;
    }) as unknown as Opencode2EntryDeps["createHooks"],
    initializeRuntime: (async () => {
      calls.push("initializeRuntime");
      return { resolvedRoles: [role], discovered: 1, resolved: 1, skipped: 0 };
    }) as unknown as Opencode2EntryDeps["initializeRuntime"],
  };
  return { deps, calls, afterOutputs };
}

// ── Temp dir ────────────────────────────────────────────────────────────────

let tmpDir: string;
let originalXdg: string | undefined;
let originalDataDir: string | undefined;
let role: ResolvedRole;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-oc2-entry-"));
  originalXdg = process.env.XDG_CONFIG_HOME;
  originalDataDir = process.env.ROLEBOX_DATA_DIR;
  process.env.XDG_CONFIG_HOME = tmpDir;
  // DATA-DIR REDIRECT. The entry opens the declared-graph host during `setup`
  // (src/entries/opencode2.ts), and opening it CREATES the host-owned store root
  // `<getDataDir()>/host/<workspaceHash>` and initialises the store file eagerly
  // (src/graph/store/schema.ts:58-60, src/graph/host/execution-index.ts:284-290,
  // src/graph/store/graph-store.ts:559-571). `getDataDir()` resolves
  // ROLEBOX_DATA_DIR first (src/cli/paths.ts:61-86), so with only XDG_CONFIG_HOME
  // redirected every boot in this file would write into the developer's real data
  // directory. The previous value is SAVED and restored, never clobbered.
  process.env.ROLEBOX_DATA_DIR = path.join(tmpDir, "data");

  const skillDir = path.join(tmpDir, "roles", "emperor", "skills", "emperor");
  mkdirSync(skillDir, { recursive: true });
  const skillFile = path.join(skillDir, "SKILL.md");
  writeFileSync(skillFile, "---\nname: emperor\n---\n\n# Emperor skill\n", "utf-8");
  role = makeRole(skillFile);
});

afterEach(() => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  if (originalDataDir === undefined) delete process.env.ROLEBOX_DATA_DIR;
  else process.env.ROLEBOX_DATA_DIR = originalDataDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeContextInTmp(options: { failToolTransform?: boolean; failEventSubscribe?: boolean } = {}) {
  const built = makeContext(options);
  (built.ctx as unknown as { location: { directory: string } }).location.directory = tmpDir;
  return built;
}

// ── Load contract ───────────────────────────────────────────────────────────

describe("opencode v2 entry — load contract", () => {
  it("default export satisfies { id, setup }", () => {
    expect(typeof entryDefault.id).toBe("string");
    expect(entryDefault.id).toBe(PLUGIN_ID);
    expect(typeof entryDefault.setup).toBe("function");
  });

  it("loads through bun as a module and keeps the shape", async () => {
    const loaded = (await import("../../src/entries/opencode2.ts")) as {
      default: { id: string; setup: (ctx: Opencode2Plugin.Context) => Promise<Cleanup> };
    };
    expect(typeof loaded.default.id).toBe("string");
    expect(typeof loaded.default.setup).toBe("function");
    expect(loaded.default.id).toBe(entryDefault.id);
  });

  it("createOpencode2Plugin returns a definition, not a promise", () => {
    const plugin = createOpencode2Plugin(makeDeps(role).deps);
    expect(plugin.id).toBe(PLUGIN_ID);
    expect(typeof plugin.setup).toBe("function");
  });
});

// ── Runtime import graph ────────────────────────────────────────────────────

/**
 * Walk the entry's RUNTIME import graph (relative specifiers only — bare
 * packages are the host's business) and collect the `@opencode/*` specifiers
 * that survive type erasure. `Bun.Transpiler.scanImports` reports what the
 * runtime actually loads: a type-only import is not emitted as an
 * `import-statement` (verified against src/entries/opencode.ts, whose
 * `@opencode-ai/plugin` import is type-only and therefore absent from its own
 * scan). `.js` specifiers are probed against their `.ts` source.
 */
function runtimeHostImports(entry: string): { scanned: number; specifiers: Set<string> } {
  const scan = new Bun.Transpiler({ loader: "ts" });
  const seen = new Set<string>();
  const queue = [entry];
  const specifiers = new Set<string>();

  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    let code: string;
    try {
      code = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    for (const record of scan.scanImports(code) as Array<{ path: string; kind: string }>) {
      if (record.path.startsWith("@opencode")) {
        specifiers.add(`${record.path} (${record.kind})`);
      }
      if (!record.path.startsWith(".")) continue;
      const resolved = path.resolve(path.dirname(file), record.path);
      const candidates = [resolved, resolved.replace(/\.js$/, ".ts")];
      for (const candidate of candidates) {
        try {
          readFileSync(candidate, "utf-8");
          queue.push(candidate);
          break;
        } catch {
          /* try the next candidate */
        }
      }
    }
  }
  return { scanned: seen.size, specifiers };
}

describe("opencode v2 entry — runtime import graph", () => {
  it("never imports @opencode-ai/plugin at runtime", () => {
    const { scanned, specifiers } = runtimeHostImports(
      path.resolve(import.meta.dir, "../../src/entries/opencode2.ts"),
    );

    expect(scanned).toBeGreaterThan(100);
    // The only host package the graph loads is the v2 plugin API itself.
    expect([...specifiers]).toEqual(["@opencode/plugin (import-statement)"]);
    // And no reachable file even mentions the v1 package as a value import.
    expect([...specifiers].join(" ")).not.toContain("@opencode-ai/plugin");
  });
});

// ── Registration wiring ─────────────────────────────────────────────────────

describe("opencode v2 entry — setup wiring", () => {
  it("registers tools, agents, skills, the command, the hooks and the event stream", async () => {
    const { deps, calls } = makeDeps(role);
    const { ctx, fake } = makeContextInTmp();
    const plugin = createOpencode2Plugin(deps);

    const cleanup = await runSetup(plugin.setup, ctx);

    expect(calls).toContain("initializeRuntime");
    expect(calls).toContain("createHooks");
    expect(fake.tools).toEqual(["rolebox_ping"]);
    expect(fake.agents).toContain("emperor");
    expect(fake.skills).toContain("emperor");
    expect(fake.commands).toEqual(["stop-loop"]);
    expect(fake.calls).toEqual([
      "tool.transform",
      "tool.hook:execute.before",
      "tool.hook:execute.after",
      "session.hook:prompt",
      "session.hook:context",
      "session.hook:compaction",
      "agent.transform",
      "skill.transform",
      "command.transform",
      "event.subscribe",
    ]);

    await cleanup();
    // 9 registrations (the event subscription is not a Registration).
    expect(fake.disposed).toBe(9);
    expect(calls).toContain("handlers.dispose");
  });

  it("recreates the v1 tool.execute.before view and writes mutations back", async () => {
    const { deps, calls } = makeDeps(role);
    const { ctx, fake } = makeContextInTmp();
    const plugin = createOpencode2Plugin(deps);
    const cleanup = await runSetup(plugin.setup, ctx);

    const event = {
      tool: "rolebox_ping",
      sessionID: "ses_1",
      agent: "emperor",
      messageID: "msg_1",
      id: "call_1",
      input: { value: "original" },
    } as unknown as ToolBeforeEvent;
    await fake.toolBefore?.(event);

    expect(calls).toContain("tool.execute.before:rolebox_ping:call_1");
    expect(event.input).toEqual({ rewritten: true });

    await cleanup();
  });

  it("rebuilds the v1 { title, output, metadata } object from the v2 execute.after union", async () => {
    const { deps, calls, afterOutputs } = makeDeps(role);
    const { ctx, fake } = makeContextInTmp();
    const plugin = createOpencode2Plugin(deps);
    const cleanup = await runSetup(plugin.setup, ctx);

    const base = {
      tool: "rolebox_ping",
      sessionID: "ses_1",
      agent: "emperor",
      messageID: "msg_1",
      id: "call_1",
      input: {},
    };
    await fake.toolAfter?.({
      ...base,
      status: "completed",
      result: {
        content: [
          { type: "text", text: "pong" },
          { type: "file", uri: "file:///tmp/evidence.png", mime: "image/png" },
        ],
        metadata: { title: "Ping result", tokens: 3 },
      },
    } as unknown as ToolAfterEvent);
    await fake.toolAfter?.({
      ...base,
      status: "error",
      error: { message: "boom", metadata: { code: "E_BOOM" } },
    } as unknown as ToolAfterEvent);

    expect(calls.filter((c) => c === "tool.execute.after:rolebox_ping")).toHaveLength(2);
    expect(afterOutputs).toHaveLength(2);

    // The 1.x shape: exactly these field names, with the tool text in `output`.
    const completed = afterOutputs[0] as unknown as Record<string, unknown>;
    expect(Object.keys(completed).sort()).toEqual(["metadata", "output", "title"]);
    expect(typeof completed.title).toBe("string");
    expect(typeof completed.output).toBe("string");
    expect(typeof completed.metadata).toBe("object");
    expect(completed.output).toBe("pong");
    expect(completed.title).toBe("Ping result");
    expect(completed.metadata).toEqual({ title: "Ping result", tokens: 3 });

    const failed = afterOutputs[1] as unknown as Record<string, unknown>;
    expect(Object.keys(failed).sort()).toEqual(["metadata", "output", "title"]);
    expect(failed.title).toBe("");
    expect(failed.output).toBe("boom");
    expect(failed.metadata).toEqual({ code: "E_BOOM" });

    await cleanup();
  });

  it("reads a completed result's text from a string content and from the declared output", async () => {
    const { deps, afterOutputs } = makeDeps(role);
    const { ctx, fake } = makeContextInTmp();
    const plugin = createOpencode2Plugin(deps);
    const cleanup = await runSetup(plugin.setup, ctx);

    const base = {
      tool: "rolebox_ping",
      sessionID: "ses_1",
      agent: "emperor",
      messageID: "msg_1",
      id: "call_1",
      input: {},
    };
    await fake.toolAfter?.({
      ...base,
      status: "completed",
      result: { content: "plain string content" },
    } as unknown as ToolAfterEvent);
    await fake.toolAfter?.({
      ...base,
      status: "completed",
      result: { output: "raw value" },
    } as unknown as ToolAfterEvent);

    expect(afterOutputs[0]?.output).toBe("plain string content");
    expect(afterOutputs[1]?.output).toBe("raw value");
    // No title and no metadata on the result -> the v1 defaults.
    expect(afterOutputs[1]?.title).toBe("");
    expect(afterOutputs[1]?.metadata).toEqual({});

    await cleanup();
  });

  it("maps the v2 prompt event onto chat.message and writes the text back", async () => {
    const { deps, calls } = makeDeps(role);
    const { ctx, fake } = makeContextInTmp();
    const plugin = createOpencode2Plugin(deps);
    const cleanup = await runSetup(plugin.setup, ctx);

    const event = {
      sessionID: "ses_1",
      messageID: "msg_1",
      prompt: { text: "expand me" },
      delivery: "steer",
    } as unknown as PromptEvent;
    await fake.prompt?.(event);

    // No agent is recorded and the host has none: the v1 input is the
    // pre-repair shape, and the turn still runs.
    expect(calls).toContain("chat.message:ses_1:undefined");
    expect((event as PromptEvent).prompt.text).toBe("expanded");

    await cleanup();
  });

  it("resolves the session's acting agent and forwards it into the v1 chat.message input", async () => {
    const { deps, calls } = makeDeps(role);
    const { ctx, fake } = makeContextInTmp();
    // The host knows the session's agent even though `SessionPrompt` does not
    // carry it: SessionInfo.agent (…/generated/types.d.ts:2788-2814).
    fake.sessionAgent = "emperor";
    const sessionID = "ses_resolved_agent";
    hookState.sessionAgentRegistry.delete(sessionID);
    const plugin = createOpencode2Plugin(deps);
    const cleanup = await runSetup(plugin.setup, ctx);

    const event = {
      sessionID,
      messageID: "msg_1",
      prompt: { text: "expand me" },
      delivery: "steer",
    } as unknown as PromptEvent;
    await fake.prompt?.(event);

    // The lookup happened for THIS turn, through the published session domain,
    // and the resolved agent reached the handler that scopes the turn.
    expect(fake.sessionGetCalls).toContain(sessionID);
    expect(calls).toContain(`chat.message:${sessionID}:emperor`);

    await cleanup();
  });

  it("falls back to the recorded mapping when the host has no agent, and re-reads it every turn", async () => {
    const { deps, calls } = makeDeps(role);
    const { ctx, fake } = makeContextInTmp();
    const plugin = createOpencode2Plugin(deps);
    const cleanup = await runSetup(plugin.setup, ctx);

    // (a) The host is asked first and, here, reports no agent for the session
    //     (`fake.sessionAgent` is undefined), so the mapping an earlier turn
    //     recorded (by the v1 writer, or by the context hook from
    //     `SessionContext.agent`) is the fallback — and that fallback is not
    //     cached either: the next turn sees the updated value.
    const recorded = "ses_recorded_agent";
    hookState.sessionAgentRegistry.set(recorded, "jinyiwei");
    await fake.prompt?.({
      sessionID: recorded,
      messageID: "msg_1",
      prompt: { text: "expand me" },
      delivery: "steer",
    } as unknown as PromptEvent);
    expect(calls).toContain(`chat.message:${recorded}:jinyiwei`);
    // The host WAS consulted — it simply had nothing to answer.
    expect(fake.sessionGetCalls).toContain(recorded);

    hookState.sessionAgentRegistry.set(recorded, "emperor");
    await fake.prompt?.({
      sessionID: recorded,
      messageID: "msg_2",
      prompt: { text: "expand me" },
      delivery: "steer",
    } as unknown as PromptEvent);
    expect(calls).toContain(`chat.message:${recorded}:emperor`);
    hookState.sessionAgentRegistry.delete(recorded);

    // (b) A session the host knows no agent for degrades to the pre-repair
    //     input shape instead of failing the turn.
    const unknown = "ses_unknown_agent";
    hookState.sessionAgentRegistry.delete(unknown);
    await fake.prompt?.({
      sessionID: unknown,
      messageID: "msg_3",
      prompt: { text: "expand me" },
      delivery: "steer",
    } as unknown as PromptEvent);
    expect(calls).toContain(`chat.message:${unknown}:undefined`);
    expect(fake.sessionGetCalls).toContain(unknown);

    await cleanup();
  });

  it("observes a host-side switchAgent between turns even while a mapping is recorded", async () => {
    const { deps, calls } = makeDeps(role);
    const { ctx, fake } = makeContextInTmp();
    const plugin = createOpencode2Plugin(deps);
    const cleanup = await runSetup(plugin.setup, ctx);
    const sessionID = "ses_host_switch_agent";

    // Turn 1: nothing recorded yet, and the host answers agentA.
    hookState.sessionAgentRegistry.delete(sessionID);
    fake.sessionAgent = "agentA";
    await fake.prompt?.({
      sessionID,
      messageID: "msg_1",
      prompt: { text: "expand me" },
      delivery: "steer",
    } as unknown as PromptEvent);
    expect(calls).toContain(`chat.message:${sessionID}:agentA`);

    // Between turns the host switches the session's agent, so
    // `ctx.session.get` now answers agentB. The recorded map is NOT touched —
    // it still says agentA — so only a host-authoritative lookup observes the
    // switch on this turn instead of one turn later.
    hookState.sessionAgentRegistry.set(sessionID, "agentA");
    fake.sessionAgent = "agentB";
    await fake.prompt?.({
      sessionID,
      messageID: "msg_2",
      prompt: { text: "expand me" },
      delivery: "steer",
    } as unknown as PromptEvent);
    expect(fake.sessionGetCalls).toContain(sessionID);
    expect(calls).toContain(`chat.message:${sessionID}:agentB`);

    await cleanup();
    hookState.sessionAgentRegistry.delete(sessionID);
  });

  it("keeps the recorded mapping when the host exposes no get or rejects the call", async () => {
    const { deps, calls } = makeDeps(role);
    const { ctx, fake } = makeContextInTmp();
    const plugin = createOpencode2Plugin(deps);
    const cleanup = await runSetup(plugin.setup, ctx);
    const domain = ctx.session as unknown as { get?: unknown };
    const hostGet = domain.get;
    const sessionID = "ses_host_get_unavailable";
    hookState.sessionAgentRegistry.set(sessionID, "emperor");

    // (a) A host whose session domain has no `get` at all, and (b) one whose
    //     `get` rejects: both degrade to the recorded mapping instead of
    //     failing the turn. `fake.sessionGetCalls` stays empty in (a) because
    //     the call is never attempted.
    delete domain.get;
    await fake.prompt?.({
      sessionID,
      messageID: "msg_1",
      prompt: { text: "expand me" },
      delivery: "steer",
    } as unknown as PromptEvent);
    expect(calls).toContain(`chat.message:${sessionID}:emperor`);
    expect(fake.sessionGetCalls).not.toContain(sessionID);

    domain.get = async () => {
      throw new Error("session.get rejected by the host");
    };
    await fake.prompt?.({
      sessionID,
      messageID: "msg_2",
      prompt: { text: "expand me" },
      delivery: "steer",
    } as unknown as PromptEvent);
    expect(calls).toContain(`chat.message:${sessionID}:emperor`);

    domain.get = hostGet;
    await cleanup();
    hookState.sessionAgentRegistry.delete(sessionID);
  });

  it("drives the real v1 chat.message handler into role-scoped activation with the resolved agent", async () => {
    // The end-to-end shape of the same claim: this handler IS
    // src/hooks/chat-message.ts, so what a resolved agent buys is observable in
    // session state rather than in an argument list.
    const sessionID = "ses_real_chat_message";
    const agentId = "opencode2-resolved-role";
    const alpha: ResolvedFunction = {
      name: "alpha",
      description: "in the role's set",
      content: "alpha",
      filePath: "/tmp/alpha.md",
      source: FunctionSource.RoleLocal,
    };
    const beta: ResolvedFunction = {
      name: "beta",
      description: "not in the role's set",
      content: "beta",
      filePath: "/tmp/beta.md",
      source: FunctionSource.RoleLocal,
    };
    const hookDeps: HookDeps = {
      session: { messages: async () => [] } as unknown as HookDeps["session"],
      roleFunctionsMap: new Map([[agentId, [alpha]]]),
      roleMap: new Map(),
      dir: "/tmp",
      dispatchManager: {} as unknown as HookDeps["dispatchManager"],
      loopManager: {} as unknown as HookDeps["loopManager"],
      customHooks: { runHooks: async () => {} } as unknown as HookDeps["customHooks"],
      builtInHooks: { runHooks: async () => {} } as unknown as HookDeps["builtInHooks"],
    };
    // A state of this case's own: `handleChatMessage` is handed it explicitly.
    const state = new HookState();
    state.roleAutoActivateMap.set(agentId, ["alpha"]);

    const { deps, calls } = makeDeps(role);
    const realDeps = {
      ...deps,
      createHooks: (async () => ({
        tool: {},
        event: async () => {},
        "chat.message": async (
          input: { agent?: string; sessionID: string },
          output: { parts: Array<{ type: string; text?: string }> },
        ) => {
          calls.push(`chat.message:${input.sessionID}:${input.agent}`);
          await handleChatMessage(input, output, state, hookDeps);
        },
        dispose: async () => {},
      })) as unknown as Opencode2EntryDeps["createHooks"],
    };
    const { ctx, fake } = makeContextInTmp();
    fake.sessionAgent = agentId;
    hookState.sessionAgentRegistry.delete(sessionID);
    functionSessionState.clear(sessionID);
    functionRuntime.clearSession(sessionID);
    state.autoActivatedSessions.delete(sessionID);
    const plugin = createOpencode2Plugin(realDeps);
    const cleanup = await runSetup(plugin.setup, ctx);

    await fake.prompt?.({
      sessionID,
      messageID: "msg_1",
      prompt: { text: "hello |alpha|" },
      delivery: "steer",
    } as unknown as PromptEvent);

    // Auto-activation fired for the role the SESSION named: with no agent the
    // gate at src/hooks/chat-message.ts:106-113 never opens.
    expect(functionSessionState.isActive(sessionID, "alpha")).toBe(true);
    // And the parsed `|fn|` was validated against THAT role's set, so the
    // function the role does not own stayed inactive. Without an agent the
    // handler takes the unscoped branch (src/hooks/chat-message.ts:146) and
    // activates both.
    expect(functionSessionState.isActive(sessionID, "beta")).toBe(false);

    functionSessionState.clear(sessionID);
    functionRuntime.clearSession(sessionID);
    hookState.sessionAgentRegistry.delete(sessionID);

    await cleanup();
  });

  it("records the session→agent mapping from the context hook as a second source", async () => {
    const { deps } = makeDeps(role);
    const { ctx, fake } = makeContextInTmp();
    const plugin = createOpencode2Plugin(deps);
    const cleanup = await runSetup(plugin.setup, ctx);

    // A session id of its own: the registry is process-wide hook state.
    const sessionID = "ses_agent_mapping";
    hookState.sessionAgentRegistry.delete(sessionID);
    const event = {
      sessionID,
      agent: "emperor",
      model: { id: "m", providerID: "p" },
      system: [{ type: "text", text: "base prompt" }],
      messages: [],
      options: {},
      tools: {},
    } as unknown as ContextEvent;
    await fake.context?.(event);

    // This write is what keeps every tool.execute.after hook context and
    // copilot's role resolution scoped on v2 (src/hooks/tool-after.ts:41,
    // src/copilot/pipeline.ts:98). It is NOT what scopes the turn itself: the
    // prompt hook resolves the agent on its own (see the prompt cases above),
    // so a turn does not have to wait for a context hook to have run.
    expect(hookState.sessionAgentRegistry.get(sessionID)).toBe("emperor");
    hookState.sessionAgentRegistry.delete(sessionID);

    await cleanup();
  });

  it("maps SystemPart[] to the v1 string[] and back", async () => {
    const { deps, calls } = makeDeps(role);
    const { ctx, fake } = makeContextInTmp();
    const plugin = createOpencode2Plugin(deps);
    const cleanup = await runSetup(plugin.setup, ctx);

    const event = {
      sessionID: "ses_1",
      agent: "emperor",
      model: { id: "m", providerID: "p" },
      system: [{ type: "text", text: "base prompt" }],
      messages: [],
      options: {},
      tools: {},
    } as unknown as ContextEvent;
    await fake.context?.(event);

    expect(calls).toContain("system.transform:ses_1:emperor");
    expect((event as ContextEvent).system).toEqual([
      { type: "text", text: "base prompt" },
      { type: "text", text: "rolebox block" },
    ]);

    await cleanup();
  });

  it("keeps untouched SystemPart objects (cache hints) and rebuilds only rewritten parts", async () => {
    const { deps, calls } = makeDeps(role);
    const { ctx, fake } = makeContextInTmp();
    const plugin = createOpencode2Plugin(deps);
    const cleanup = await runSetup(plugin.setup, ctx);

    const untouched = {
      type: "text" as const,
      text: "base prompt",
      cache: { type: "ephemeral" },
      metadata: { source: "host" },
    };
    const rewritten = {
      type: "text" as const,
      text: "rewrite me",
      cache: { type: "ephemeral" },
    };
    const event = {
      sessionID: "ses_1",
      agent: "emperor",
      model: { id: "m", providerID: "p" },
      system: [untouched, rewritten],
      messages: [],
      options: {},
      tools: {},
    } as unknown as ContextEvent;
    await fake.context?.(event);

    expect(calls).toContain("system.transform:ses_1:emperor");
    expect(event.system).toHaveLength(3);

    // The handler never touched part 0: it is the SAME object, cache hint and
    // metadata included — not a fresh `{ type: "text", text }`.
    expect(event.system[0]).toBe(untouched);
    expect(event.system[0]?.cache).toEqual({ type: "ephemeral" });
    expect(event.system[0]?.metadata).toEqual({ source: "host" });

    // Part 1 WAS rewritten: the `string[]` view cannot carry cache/metadata, so
    // the rewritten part is plain text (the documented loss).
    expect(event.system[1]).toEqual({ type: "text", text: "rewritten by rolebox" });
    expect(event.system[1]).not.toBe(rewritten);
    expect(event.system[1]?.cache).toBeUndefined();

    // Part 2 was appended by the handler: plain text as well.
    expect(event.system[2]).toEqual({ type: "text", text: "rolebox block" });

    await cleanup();
  });

  it("carries compaction context on the request and never fabricates a result", async () => {
    const { deps, calls } = makeDeps(role);
    const { ctx, fake } = makeContextInTmp();
    const plugin = createOpencode2Plugin(deps);
    const cleanup = await runSetup(plugin.setup, ctx);

    const event = {
      sessionID: "ses_1",
      agent: "emperor",
      model: { id: "m", providerID: "p" },
      system: [{ type: "text", text: "base prompt" }],
      messages: [],
      options: {},
      tools: {},
    } as unknown as CompactionEvent;
    await fake.compaction?.(event);

    expect(calls).toContain("compacting");
    // `result` is not a metadata side channel: setting it means "use this
    // compaction and skip the model request" and `summary` is required
    // (…/promise/session.d.ts:36-41, where :37 is `summary: string`), so a
    // synthesized `{ summary: "" }` would REPLACE the session's summary.
    // Nothing else set one, so nothing is set.
    expect((event as CompactionEvent).result).toBeUndefined();
    // The block travels on the compaction REQUEST instead — the mutable
    // `system` array every session hook receives — so the summary is still
    // produced by the model and still carries the block.
    expect((event as CompactionEvent).system).toEqual([
      { type: "text", text: "base prompt" },
      { type: "text", text: "## Rolebox Runtime State" },
    ]);

    await cleanup();
  });

  it("preserves a pre-existing compaction result verbatim and only adds metadata", async () => {
    const { deps } = makeDeps(role);
    const { ctx, fake } = makeContextInTmp();
    const plugin = createOpencode2Plugin(deps);
    const cleanup = await runSetup(plugin.setup, ctx);

    // Another plugin already decided this compaction: its summary is the
    // session's summary, and rolebox may not touch it — nor re-append a block
    // to a request that will not be made.
    const event = {
      sessionID: "ses_1",
      agent: "emperor",
      model: { id: "m", providerID: "p" },
      system: [{ type: "text", text: "base prompt" }],
      messages: [],
      options: {},
      tools: {},
      result: { summary: "a summary another plugin produced", metadata: { keep: true } },
    } as unknown as CompactionEvent;
    await fake.compaction?.(event);

    expect((event as CompactionEvent).result?.summary).toBe("a summary another plugin produced");
    expect((event as CompactionEvent).result?.metadata).toEqual({
      keep: true,
      "rolebox.context": ["## Rolebox Runtime State"],
    });
    // The request was not extended: the model request is skipped when a result
    // is set, so the only carrier left is the metadata it already had.
    expect((event as CompactionEvent).system).toEqual([{ type: "text", text: "base prompt" }]);

    await cleanup();
  });

  it("leaves the compaction event untouched when the v1 hook contributes no block", async () => {
    const { deps } = makeDeps(role, { compactingContext: [] });
    const { ctx, fake } = makeContextInTmp();
    const plugin = createOpencode2Plugin(deps);
    const cleanup = await runSetup(plugin.setup, ctx);

    const event = {
      sessionID: "ses_1",
      agent: "emperor",
      model: { id: "m", providerID: "p" },
      system: [{ type: "text", text: "base prompt" }],
      messages: [],
      options: {},
      tools: {},
    } as unknown as CompactionEvent;
    await fake.compaction?.(event);

    expect((event as CompactionEvent).result).toBeUndefined();
    expect((event as CompactionEvent).system).toEqual([{ type: "text", text: "base prompt" }]);

    await cleanup();
  });

  it("relays the v2 event stream through the v1 event handler", async () => {
    const { deps, calls } = makeDeps(role);
    const { ctx, fake } = makeContextInTmp();
    const plugin = createOpencode2Plugin(deps);
    const cleanup = await runSetup(plugin.setup, ctx);

    fake.pushEvent({ type: "session.status", data: { sessionID: "ses_1", status: "busy" } });
    for (let i = 0; i < 50 && !calls.some((c) => c.startsWith("event:")); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(calls).toContain("event:session.status");
    expect(fake.calls).toContain("event.subscribe");

    await cleanup();
  });

  it("holds ONE abort listener on the relay signal however many events it relays", async () => {
    const { deps, calls } = makeDeps(role);
    const { ctx, fake } = makeContextInTmp();
    const plugin = createOpencode2Plugin(deps);
    const cleanup = await runSetup(plugin.setup, ctx);

    const signal = fake.subscribeSignal;
    if (signal === undefined) throw new Error("the entry never passed its AbortSignal to subscribe");
    // The relay is armed and waiting on the host iterator: exactly the one
    // listener its lifetime needs, none of them per event.
    expect(getEventListeners(signal, "abort").length).toBeLessThanOrEqual(1);

    // More events than a Node-backed EventTarget tolerates listeners for
    // (MaxListenersExceededWarning fires above 10). A per-event registration
    // leaves every one of these behind, because `iterator.next()` wins the race.
    const relayed = 15;
    for (let i = 0; i < relayed; i += 1) {
      fake.pushEvent({ type: "session.status", data: { sessionID: "ses_1", status: `busy-${i}` } });
    }
    for (let i = 0; i < 400 && calls.filter((c) => c.startsWith("event:")).length < relayed; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(calls.filter((c) => c.startsWith("event:")).length).toBe(relayed);
    // Still ONE while the NEXT race is outstanding — this is the leak: a
    // per-iteration listener list is `relayed + 1` here.
    expect(getEventListeners(signal, "abort").length).toBeLessThanOrEqual(1);

    await cleanup();
    // `{ once: true }` removes it on the abort, so the relay releases the last
    // one instead of holding a listener and a pending resolver for the
    // plugin's whole lifetime.
    expect(getEventListeners(signal, "abort").length).toBe(0);
  });

  it("contains a failing registration instead of taking the host down", async () => {
    const { deps, calls } = makeDeps(role);
    const { ctx, fake } = makeContextInTmp({ failToolTransform: true, failEventSubscribe: true });
    const plugin = createOpencode2Plugin(deps);

    // Neither the tool transform nor event.subscribe may reject setup.
    const cleanup = await runSetup(plugin.setup, ctx);

    // The tool transform rejected: no tools, but every other surface registered.
    expect(fake.tools).toEqual([]);
    expect(fake.agents).toContain("emperor");
    expect(fake.skills).toContain("emperor");
    expect(fake.commands).toEqual(["stop-loop"]);
    expect(fake.calls).toContain("session.hook:prompt");
    // The subscription threw: setup still resolved and the rest is registered.
    expect(fake.calls).toContain("event.subscribe");
    expect(fake.calls).toContain("session.hook:compaction");
    // 8 registrations survived + nothing to dispose for the failed one.
    await cleanup();
    expect(fake.disposed).toBe(8);
    expect(calls).toContain("handlers.dispose");
  });

  it("contains a failing event subscription instead of taking the host down", async () => {
    const { deps, calls } = makeDeps(role);
    const { ctx, fake } = makeContextInTmp({ failEventSubscribe: true });
    const plugin = createOpencode2Plugin(deps);

    // setup must resolve — a host whose subscribe throws still gets every other
    // surface, exactly as the documented failure policy promises.
    const cleanup = await runSetup(plugin.setup, ctx);

    expect(fake.tools).toEqual(["rolebox_ping"]);
    expect(fake.agents).toContain("emperor");
    expect(fake.skills).toContain("emperor");
    expect(fake.commands).toEqual(["stop-loop"]);
    expect(fake.calls).toContain("tool.hook:execute.before");
    expect(fake.calls).toContain("tool.hook:execute.after");
    expect(fake.calls).toContain("session.hook:prompt");
    expect(fake.calls).toContain("session.hook:context");
    expect(fake.calls).toContain("session.hook:compaction");

    // And the returned cleanup resolves, disposing every registration.
    await cleanup();
    expect(fake.disposed).toBe(9);
    expect(calls).toContain("handlers.dispose");
  });
});

// ── Real service graph ──────────────────────────────────────────────────────

/**
 * The cases above inject the handler map, so they cover the ADAPTER. This one
 * runs the module's own default export against the REAL composition — role
 * bootstrap from a temp `rolebox/` tree, `createPluginHooks`, and every
 * registration adapter — with the fake host Context. It is the only case that
 * proves `setup` works end to end without a v1 handler map handed to it.
 */
describe("opencode v2 entry — real service graph", () => {
  it("boots the composition and registers the resolved role", async () => {
    const roleDir = path.join(tmpDir, "rolebox", "emperor");
    mkdirSync(roleDir, { recursive: true });
    writeFileSync(
      path.join(roleDir, "role.yaml"),
      "name: Emperor\ndescription: The ruler\nprompt: You are the emperor.\n",
      "utf-8",
    );

    const { ctx, fake } = makeContextInTmp();
    const cleanup = await runSetup(entryDefault.setup, ctx);

    expect(fake.agents).toContain("emperor");
    expect(fake.commands).toEqual(["stop-loop"]);
    expect(fake.calls).toContain("event.subscribe");
    // The canonical tool surface is registered, not an empty map.
    expect(fake.tools.length).toBeGreaterThan(1);

    await cleanup();
  }, 60_000);
});

// ── Flush wiring ────────────────────────────────────────────────────────────

/**
 * `flushRoleboxState` reads process-level hook state, so whether a loop
 * manager is registered depends on what ran before this case (the real-graph
 * case above registers one through the composition). The assertion is
 * therefore only that the flush path completes for whatever state exists —
 * the same "never throws, never loses the map" contract the composition's own
 * `flushAllSync` has (src/core/composition.ts:135-146).
 */
describe("opencode v2 entry — cleanup", () => {
  it("flushes rolebox state without throwing", async () => {
    const { deps } = makeDeps(role);
    const { ctx } = makeContextInTmp();
    const plugin = createOpencode2Plugin(deps);
    const cleanup = await runSetup(plugin.setup, ctx);

    const managersBefore = hookState.loopManagerMap.size;
    await cleanup();
    expect(hookState.loopManagerMap.size).toBeLessThanOrEqual(managersBefore);
  });
});
