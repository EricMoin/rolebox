/// <reference types="bun-types" />

/**
 * dsh-plugin tests — the cordis plugin entry point (`src/entries/dsh.ts`)
 * booted on a minimal fake cordis ctx against a temp rolebox directory.
 *
 * Verifies:
 *   - the plugin shape (name/inject/Config/apply) matches the verified cordis
 *     plugin conventions (`docs/dsh-plugin-contract.md` §2.2)
 *   - Config is a StandardSchemaV1 schema (contract §2.4 mechanism)
 *   - apply() resolves roles from a temp rolebox dir, registers >= 1 tool
 *     into the fake tools registry, syncs agents into the fake subagents
 *     catalog, and reports the discovered/resolved/skipped counts
 *   - the enabledNamespaces tool filter and the defaultRole promotion
 *   - the optional host webServer seam: the `/rolebox` role-switch AND
 *     monitor (`/status`, `/metrics`) surfaces register — composed into ONE
 *     `/rolebox` prefix route (the real host webserver rejects duplicate
 *     prefix registrations) — when `ctx.get('webServer')` returns a
 *     registrar, and are skipped when absent
 *   - the optional systemPrompt seam: the `rolebox:role` section and
 *     `rolebox:context` context entry register on the service double, and
 *     the section provider serves the ACTIVE role's prompt after a switch;
 *     headless profiles (no service) degrade with unchanged stats
 *   - the in-process reload seam: `POST /rolebox/reload` re-resolves roles in
 *     place, and the route, skill-provider, and system-prompt consumers observe
 *     the new role set; the configured defaultRole is re-applied to the
 *     reloaded set
 *   - the disposer cleans up registrations/listeners
 *   - the plugin source stays free of @opencode-ai / @deepseek-ai imports
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { load } from "js-yaml";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { removeTempTree } from "./graph/helpers/temp-dirs.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { graphStoreRoot } from "../src/graph/store/schema.ts";
import { queryGraphs } from "../src/graph/query/graph-query.ts";
import { getDataDir } from "../src/cli/paths.ts";
import { getRootLogger } from "../src/logger.ts";
import { realpathSync } from "node:fs";
import { shortHash } from "../src/utils/state-paths.ts";
import { ActiveRoleStore } from "../src/platform/adapters/dsh/active-role-store.ts";
import { DshEventBridge, mapDshEventType } from "../src/platform/adapters/dsh/event-bridge.ts";
import {
  apply,
  name,
  inject,
  Config,
  buildAgentPromptInjector,
  probeAttachments,
} from "../src/entries/dsh.ts";
import type { DshAttachmentService } from "../src/entries/dsh.ts";
import type {
  DshPluginContext,
  DshPluginDisposer,
  DshPluginStats,
  DshPluginConfig,
} from "../src/entries/dsh.ts";
import {
  DshToolFactory,
  DSH_TOOL_PRESENTATION,
} from "../src/platform/adapters/dsh/tool-factory.ts";
import type {
  DshToolDefinition,
  DshPresentResult,
  DshToolPresentation,
} from "../src/platform/adapters/dsh/tool-factory.ts";
import { buildCanonicalTools } from "../src/platform/tool-assembly.ts";
import { DSH_GRAPH_WORKER_TOOLS } from "../src/platform/adapters/dsh/graph-worker.ts";
import { COMPUTER_TOOL_NAMES } from "../src/loader/computer-grants.ts";
import { opencodeCapabilities } from "../src/platform/capabilities.ts";
import type {
  DshSpawnDelegate,
  DshSubagentProvider,
  DshSubagentStartRequest,
} from "../src/platform/adapters/dsh/agent-registrar.ts";
import type { DshSubagentDispatchRuntime } from "../src/platform/adapters/dsh/dispatch.ts";
import type { DshSessionStoreLike } from "../src/platform/adapters/dsh/session.ts";
import type {
  DshSystemPromptContextEntry,
  DshSystemPromptRegistry,
  DshSystemPromptSection,
} from "../src/platform/adapters/dsh/system-prompt.ts";
import type {
  DshWebRouteLike,
  DshWebServerRouteRegistrar,
} from "../src/platform/adapters/dsh/web-role-switch-route.ts";
import { ROLEBOX_LOGS_ROUTE_PREFIX } from "../src/platform/adapters/dsh/web-rolebox-logs-route.ts";
import type {
  DshSkillProviderControl,
  DshSkillProviderLike,
} from "../src/platform/adapters/dsh/skill-provider.ts";

// ── Validating fake live-agent registry ────────────────────────────────────
//
// graph-notify delivery sends a full dsh UserMessage (message.d.ts:120-133)
// whose source is the producer-owned `rolebox` `notice` kind. dsh's V4 session
// format refuses the released shared `plugin` wrapper with `format v4 message
// requires a producer-owned source kind` (encode and decode alike), so the
// fakes below VALIDATE that shape instead of accepting anything: the source
// kind must be producer-owned, and a `notice` summary must be a nonempty string
// of at most 120 chars (message.js:15-19). A regression to a malformed message
// fails the test rather than silently passing.

/** One recorded delivery call on a validating fake agent. */
interface FakeAgentCall {
  method: "steer" | "followup" | "inject";
  message: unknown;
}

/** Structural live-agent double exposing any subset of the rc.6 delivery members. */
interface FakeAgentLike {
  readonly id: string;
  steer?(message: unknown): unknown;
  followup?(message: unknown): unknown;
  inject?(message: unknown): unknown;
}

/** Structural agent-registry double (`ctx.agents`). */
interface FakeAgentRegistry {
  get(id: string): FakeAgentLike | undefined;
}

/** Reject anything that is not a well-formed rc.6 UserMessage. */
function assertValidUserMessage(message: unknown): void {
  if (typeof message !== "object" || message === null) {
    throw new Error("invalid UserMessage: not an object");
  }
  const m = message as Record<string, unknown>;
  if (typeof m.id !== "string" || m.id.length === 0) {
    throw new Error("invalid UserMessage: missing id");
  }
  if (m.role !== "user") {
    throw new Error("invalid UserMessage: role must be 'user'");
  }
  if (!Array.isArray(m.content)) {
    throw new Error("invalid UserMessage: missing content");
  }
  if (typeof m.source !== "object" || m.source === null) {
    throw new Error("invalid UserMessage: missing source");
  }
  const source = m.source as Record<string, unknown>;
  if (
    typeof source.kind !== "string" ||
    source.kind.length === 0 ||
    source.kind === "plugin"
  ) {
    throw new Error("invalid UserMessage: source kind must be producer-owned");
  }
  if (source.form === "notice") {
    if (typeof source.summary !== "string" || source.summary.length === 0) {
      throw new Error("invalid UserMessage: notice source missing summary");
    }
    if (source.summary.length > 120) {
      throw new Error("invalid UserMessage: notice summary exceeds 120 chars");
    }
  }
}

/**
 * Build a validating fake agent exposing exactly the requested delivery
 * members, recording each call as `{ method, message }` (recording before
 * validation so a malformed call is still inspectable).
 */
function makeValidatingAgent(
  id: string,
  members: { steer?: boolean; followup?: boolean; inject?: boolean } = {
    inject: true,
  },
): { agent: FakeAgentLike; calls: FakeAgentCall[] } {
  const calls: FakeAgentCall[] = [];
  const record = (method: FakeAgentCall["method"], message: unknown): void => {
    calls.push({ method, message });
    assertValidUserMessage(message);
  };
  const agent: FakeAgentLike = { id };
  if (members.steer) agent.steer = (m: unknown) => record("steer", m);
  if (members.followup) agent.followup = (m: unknown) => record("followup", m);
  if (members.inject) agent.inject = (m: unknown) => record("inject", m);
  return { agent, calls };
}

/** Registry double resolving every session id to the same fake agent. */
function makeRegistry(agent: FakeAgentLike | undefined): FakeAgentRegistry {
  return { get: () => agent };
}

// ── Fake cordis ctx double ─────────────────────────────────────────────────

/**
 * Minimal fake of the cordis Context + the three injected dsh services
 * (`tools`, `sessions`, `subagents`) and the optional systemPrompt registry.
 * Tracks tool registrations, subagent provider registrations, event
 * subscriptions, and system-prompt section/context registrations so tests can
 * assert that apply() wired everything.
 *
 * `tools.get` mirrors the host registry's public lookup, which the plugin
 * probes before registering a tool name: a name in `takenTools` (or already
 * registered on this double) resolves to a stand-in definition, every other
 * name to `undefined`. `noToolsLookup` omits the read entirely.
 *
 * The optional-service seam (`ctx.get`) resolves `"webServer"` to the
 * `webServer` option when supplied (a fake host-webserver registrar) and
 * `undefined` otherwise — mirroring the dsh host, where the web profile
 * registers the webserver service and headless profiles do not. The
 * `systemPrompt` option (default `false`) wires the factory's recording
 * system-prompt registry double onto `ctx.systemPrompt` (and
 * `ctx.get("systemPrompt")`) — mirroring the full profile, where the
 * `@deepseek-ai/dsh-system-prompt` service is mounted on the context; the
 * default leaves it absent so apply() exercises its graceful degrade.
 */
function createFakeCtx(
  options: {
    webServer?: DshWebServerRouteRegistrar | null;
    systemPrompt?: boolean;
    /** Optional live-agent registry double (graph-notify injector seam). */
    agents?: FakeAgentRegistry;
    /** Optional dsh llm runtime double (`ctx.llm` provider-route probe seam). */
    llm?: { listProviders(): ReadonlyArray<{ id: string }> };
    /** Optional dsh skill-registry double (lazy skill-provider seam). */
    skills?: boolean;
    /**
     * Tool names the HOST already owns (the collision probe seam). Each name
     * is reported taken by `tools.get` under the given name (a `Set`, or a
     * predicate for a probe that changes state), so `apply()` must fall back
     * to `rb_<name>` or skip.
     */
    takenTools?: ReadonlySet<string> | ((name: string) => boolean);
    /**
     * Omit the `tools.get` read entirely — a double (or a host generation)
     * without the optional lookup, which must degrade to registering the
     * canonical names unchanged.
     */
    noToolsLookup?: boolean;
  } = {},
) {
  const registeredTools: DshToolDefinition[] = [];
  const providers = new Map<string, DshSubagentProvider>();
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  // Recording system-prompt registry double: `section()`/`context()` record
  // every registration (so tests can inspect the entries and invoke their
  // `text` providers) and return disposers that record their invocation —
  // mirroring the real `@deepseek-ai/dsh-system-prompt` service surface.
  const sections: DshSystemPromptSection[] = [];
  const contexts: DshSystemPromptContextEntry[] = [];
  const promptDisposed: Array<{ kind: "section" | "context"; name: string }> = [];
  const systemPrompt: DshSystemPromptRegistry = {
    section(entry: DshSystemPromptSection): () => void {
      sections.push(entry);
      return () => {
        promptDisposed.push({ kind: "section", name: entry.name });
      };
    },
    context(entry: DshSystemPromptContextEntry): () => void {
      contexts.push(entry);
      return () => {
        promptDisposed.push({ kind: "context", name: entry.name });
      };
    },
  };

  // Recording dsh skill-registry double (`ctx.skills`, the `dsh-skill`
  // registry row). `registerProvider(create)` invokes the factory once with
  // the rc.6 `{ signal, invalidate }` control, records the created provider,
  // and counts invalidations so the reload test can assert the live catalog
  // was refreshed.
  let skillInvalidations = 0;
  const skillRegistrations: Array<{
    provider: DshSkillProviderLike;
    control: DshSkillProviderControl;
  }> = [];
  const skills = {
    registerProvider(
      create: (control: DshSkillProviderControl) => DshSkillProviderLike,
    ): () => void {
      const control: DshSkillProviderControl = {
        signal: new AbortController().signal,
        invalidate: () => {
          skillInvalidations++;
        },
      };
      skillRegistrations.push({ provider: create(control), control });
      return () => {};
    },
  };

  const taken = (name: string): boolean => {
    const opt = options.takenTools;
    if (opt === undefined) return false;
    return typeof opt === "function" ? opt(name) : opt.has(name);
  };
  /** Stand-in definition for a taken name, mirroring the host's `get` shape. */
  const hostOwnedDefinition = (name: string): DshToolDefinition => ({
    name,
    description: `host-owned ${name}`,
    parameters: {},
    output: { schema: {}, render: () => [] },
    // The collision probe only reads the definition, never executes it.
    execute: async () => ({}),
  });
  // The collision probe: a name the host owns (statically declared taken, or
  // already in this registry) resolves to a definition, everything else to
  // undefined — the documented ToolRuntime.get contract (`scope?` omitted).
  const lookup = (name: string): unknown =>
    taken(name) || registeredTools.some((def) => def.name === name)
      ? hostOwnedDefinition(name)
      : undefined;
  const tools = {
    registeredTools,
    guard: () => () => {},
    ...(options.noToolsLookup ? {} : { get: lookup }),
    register(definition: DshToolDefinition): () => void {
      registeredTools.push(definition);
      return () => {
        const i = registeredTools.indexOf(definition);
        if (i >= 0) registeredTools.splice(i, 1);
      };
    },
  };

  const started: Array<{ name: string; request: DshSubagentStartRequest }> = [];
  const subagents: DshSubagentDispatchRuntime = {
    registerProvider(provider: DshSubagentProvider): () => void {
      providers.set(provider.name, provider);
      return () => {
        providers.delete(provider.name);
      };
    },
    getProvider: (providerName: string) => providers.get(providerName),
    list: () => [...providers.keys()],
    // Dispatch seam (DshDispatchAdapter surface): records every start and
    // returns a run that settles `completed` on a microtask, so the plugin
    // level dispatch test can assert the adapter forwarded a live parent Agent
    // without a real spawn provider.
    start: async (startName: string, request: DshSubagentStartRequest) => {
      started.push({ name: startName, request });
      return {
        id: `fake-run-${started.length}`,
        result: Promise.resolve({
          stopReason: "completed",
          output: [{ type: "text", text: "ok" }],
        }),
        dispose: async () => {},
      };
    },
  };

  const sessions: DshSessionStoreLike = {
    create: (id?: string) => ({
      id: id ?? "session-1",
      seq: 0,
      events: [],
      header: { cwd: process.cwd() },
      append: () => ({ type: "log/only", seq: 0 } as never),
      deriveMessages: () => [],
    }),
    get: () => undefined,
    list: () => [],
    fork: () => ({ id: "session-fork", seq: 0, events: [] } as never),
  };

  const ctx: DshPluginContext = {
    tools,
    sessions,
    subagents,
    // Optional-service seam (full profile): the system-prompt registry is
    // mounted directly on the context, mirroring the dsh host — and also
    // resolved by name for the probe's `ctx.get('systemPrompt')` fallback.
    ...(options.systemPrompt ? { systemPrompt } : {}),
    // Optional live-agent registry (full profile with the dsh-agent bundle
    // rows). graph-notify probes it to wire the session adapter's
    // prompt-injector; absent → graphNotify degrades (stats.graphNotifyWired
    // false) without failing boot.
    ...(options.agents ? { agents: options.agents } : {}),
    // Optional dsh llm runtime (provider-route safety probe). Mirrors a full
    // profile where the llm service is mounted; absent → the registrar emits a
    // split provider unchanged (pre-safety behavior).
    ...(options.llm ? { llm: options.llm } : {}),
    // Optional skill registry (full profile with the `dsh-skill` bundle row):
    // rolebox registers its lazy skill provider against it. Absent → the
    // plugin's graceful degrade.
    ...(options.skills ? { skills } : {}),
    get(name: string): unknown {
      // Optional-service seam: the host web server and (in full profiles) the
      // system-prompt registry, live-agent registry, llm runtime, and skill
      // registry are probed by the plugin; every other name resolves to
      // undefined (absent).
      if (name === "webServer") return options.webServer ?? undefined;
      if (name === "systemPrompt") {
        return options.systemPrompt ? systemPrompt : undefined;
      }
      if (name === "agents") return options.agents ?? undefined;
      if (name === "llm") return options.llm ?? undefined;
      if (name === "skills") return options.skills ? skills : undefined;
      return undefined;
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      const arr = listeners.get(event) ?? [];
      arr.push(listener);
      listeners.set(event, arr);
      return () => {
        const cur = listeners.get(event) ?? [];
        listeners.set(
          event,
          cur.filter((l) => l !== listener),
        );
      };
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };

  return {
    ctx,
    tools,
    providers,
    listeners,
    systemPrompt,
    sections,
    contexts,
    started,
    skillRegistrations,
    skillInvalidationCount: () => skillInvalidations,
  };
}

// ── Mock req/res for driving the registered /rolebox route handler ──────────
//
// The role switcher created inside apply() is not exposed, so the tests reach
// its activate() through the /rolebox REST surface (the registered route
// handler delegates to DshRoleSwitcher.activate). Minimal
// IncomingMessage/ServerResponse doubles are used — no node:http server is
// ever created — the same pattern as tests/platform/dsh-role-switch-route.

/** Minimal IncomingMessage double: url/method + data/end/error listeners. */
class MockReq {
  url: string;
  method: string;
  private listeners = new Map<string, Array<(chunk?: unknown) => void>>();

  constructor(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  on(event: string, cb: (chunk?: unknown) => void) {
    const arr = this.listeners.get(event) ?? [];
    arr.push(cb);
    this.listeners.set(event, arr);
    return this;
  }

  /** Emit a body chunk to registered `data` listeners. */
  push(chunk: string | Buffer): void {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    for (const cb of this.listeners.get("data") ?? []) cb(buf);
  }

  /** Emit `end` to registered listeners. */
  finish(): void {
    for (const cb of this.listeners.get("end") ?? []) cb();
  }
}

/** Minimal ServerResponse double: records status/headers/body. */
class MockRes {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = "";
  headersSent = false;

  writeHead(status: number, headers: Record<string, string>) {
    this.statusCode = status;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }

  end(text = "") {
    this.body = text;
    return this;
  }
}

/** Invoke a route handler with a mock req/res and await completion. */
async function invoke(
  handler: DshWebRouteLike["handler"],
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  const req = new MockReq(method, path);
  const res = new MockRes();
  const pending = handler(
    req as unknown as IncomingMessage,
    res as unknown as ServerResponse,
  );
  if (body !== undefined) req.push(body);
  req.finish();
  if (pending) await pending;
  return { status: res.statusCode, headers: res.headers, text: res.body };
}

// ── Fixtures ───────────────────────────────────────────────────────────────

let tmpDir: string;

/** Create `{tmpDir}/{roleId}/role.yaml` with the given yaml body. */
function writeRoleYaml(roleId: string, body: string): void {
  const roleDir = join(tmpDir, roleId);
  mkdirSync(roleDir, { recursive: true });
  writeFileSync(join(roleDir, "role.yaml"), body, "utf-8");
}

const SIMPLE_ROLE = [
  "name: Test Role",
  "description: A minimal role for the dsh plugin test",
  "prompt: You are a test role.",
].join("\n");

/** A role (plus its skill) that appears on disk only after boot. */
const RELOADED_ROLE = [
  "name: Reloaded Role",
  "description: A role added after boot",
  "prompt: You are a reloaded role.",
  "skills:",
  "  - reload-skill",
].join("\n");

/** A skill-less role that appears on disk only after boot (defaultRole case). */
const NEWCOMER_ROLE = [
  "name: Newcomer Role",
  "description: A role added after boot",
  "prompt: You are a newcomer role.",
].join("\n");

/** Write `{tmpDir}/{roleId}/skills/{skillName}/SKILL.md`. */
function writeRoleSkill(roleId: string, skillName: string): void {
  const skillDir = join(tmpDir, roleId, "skills", skillName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    [
      "---",
      `name: ${skillName}`,
      `description: The ${skillName} asset.`,
      "---",
      `# ${skillName}`,
      "",
    ].join("\n"),
    "utf-8",
  );
}

/** Extract the role ids from a `GET /rolebox/roles` response body. */
function roleIds(res: { text: string }): string[] {
  return (JSON.parse(res.text) as Array<{ id: string }>).map((role) => role.id);
}

/**
 * Disposers from this file's boots that the case has not released yet.
 *
 * `apply()` opens the declared-graph host under `ROLEBOX_DATA_DIR`
 * (`tmpDataDir`), and the host owns a store connection. A case that asserts
 * before calling its `disposer()`, or that boots a second plugin without
 * releasing the first, leaves that connection open inside the temp directory —
 * and the `afterEach` below cannot remove a directory holding a live handle
 * (Windows: `EBUSY: resource busy or locked, rm …`).
 */
const pendingDisposers = new Set<DshPluginDisposer>();

/**
 * `apply()` with an UNCONDITIONALLY RELEASABLE disposer: a second call is a
 * no-op, so the `afterEach` can release whatever a case left behind without
 * releasing anything twice. The caller sees the boot's own `stats` and reload
 * seam; the disposer it gets is the one that closes the boot.
 */
async function applyTracked(
  ctx: DshPluginContext,
  config: DshPluginConfig,
): Promise<DshPluginDisposer> {
  const released = { value: false };
  const boot = await apply(ctx, config);
  const tracked = Object.assign(
    (): void => {
      if (released.value) return;
      released.value = true;
      boot();
    },
    {
      stats: boot.stats,
      registerRoleSnapshotTools: boot.registerRoleSnapshotTools,
    },
  );
  pendingDisposers.add(tracked);
  return tracked;
}

let tmpDataDir: string;
let priorDataDir: string | undefined;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "rolebox-dsh-plugin-"));
  tmpDataDir = mkdtempSync(join(tmpdir(), "rolebox-dsh-data-"));
  priorDataDir = process.env.ROLEBOX_DATA_DIR;
  process.env.ROLEBOX_DATA_DIR = tmpDataDir;
});

afterEach(() => {
  let firstError: unknown;
  try {
    // Release every boot this case did not release itself, BEFORE the removal:
    // each boot's host owns a store connection inside `tmpDataDir`.
    for (const disposer of [...pendingDisposers]) {
      pendingDisposers.delete(disposer);
      try {
        disposer();
      } catch (error) {
        if (firstError === undefined) firstError = error;
      }
    }
  } finally {
    if (priorDataDir === undefined) delete process.env.ROLEBOX_DATA_DIR;
    else process.env.ROLEBOX_DATA_DIR = priorDataDir;
    for (const dir of [tmpDir, tmpDataDir]) {
      try {
        // Each tree is removed ONCE and the list is dropped with it, so a
        // removal that throws cannot leave the directory queued for the next
        // sweep (that is what turned one leaked handle into 27 failures).
        removeTempTree(dir);
      } catch (error) {
        if (firstError === undefined) firstError = error;
      }
    }
  }
  if (firstError !== undefined) throw firstError;
});

// ── Plugin shape ───────────────────────────────────────────────────────────

describe("dsh plugin shape", () => {
  it("exports the verified cordis plugin metadata (name/inject/Config/apply)", () => {
    expect(name).toBe("rolebox");
    // Contract §2.2 `inject` — the dsh services the adapters consume.
    expect(inject).toEqual(
      expect.arrayContaining(["tools", "sessions", "subagents"]),
    );
    // Contract §2.4 — Config is a StandardSchemaV1 schema.
    expect(typeof apply).toBe("function");
    expect((Config as unknown as { "~standard"?: unknown })["~standard"]).toBeDefined();
  });

  it("Config validates and defaults through the standard-schema interface", () => {
    const std = (Config as unknown as {
      "~standard": {
        validate(value: unknown): { value?: unknown; issues?: unknown[] };
      };
    })["~standard"];

    const ok = std.validate({ roleboxDir: "/tmp/rb", defaultRole: "admin" });
    expect("value" in ok).toBe(true);
    const value = ok.value as {
      roleboxDir?: string;
      skillsDir?: string;
      defaultRole?: string;
    };
    expect(value.roleboxDir).toBe("/tmp/rb");
    // Absent optional keys validate to undefined — no required fields.
    const empty = std.validate({});
    expect("value" in empty).toBe(true);

    const bad = std.validate({ roleboxDir: 42 });
    expect("issues" in bad).toBe(true);
    expect((bad.issues as unknown[]).length).toBeGreaterThan(0);
  });
});

// ── Packaging: the dsh-client-modules resolution seam ──────────────────────
//
// dsh-client-modules (node half) discovers dsh.client packages by resolving
// the loader entry's NAME and parsing the owning manifest for `dsh.client` +
// `exports["./client"]` (packages/client/modules/src/index.ts). Only a
// package-root specifier (bare name) or a path-like specifier is eligible
// (`exactPackageSpecifier`); a package SUBPATH such as `rolebox/dsh` is
// cached as a permanent negative verdict and the web client never reaches the
// boot graph. The shipped bundle patch therefore names the cordis host half
// with the package-relative `../dist/entries/dsh.js`, and the nearest owning
// manifest supplies the browser module id `rolebox`. The browser half
// additionally requires the bundle envelope id to equal that graph row id.

describe("dsh packaging — dsh-client-modules resolution seam", () => {
  const pkgRoot = resolve(import.meta.dir, "..");
  const pkg = JSON.parse(
    readFileSync(resolve(pkgRoot, "package.json"), "utf8"),
  ) as {
    dsh?: { client?: { platform?: string; inject?: string[] } };
    exports?: Record<string, unknown>;
  };

  it("declares the dsh.client web platform + inject roster", () => {
    expect(pkg.dsh?.client?.platform).toBe("web");
    expect(Array.isArray(pkg.dsh?.client?.inject)).toBe(true);
    expect(pkg.dsh?.client?.inject!.length).toBeGreaterThan(0);
  });

  it("exposes exports['./client'] pointing at the built bundle", () => {
    const client = pkg.exports?.["./client"] as
      | string
      | { default?: string }
      | undefined;
    const rel =
      typeof client === "string" ? client : client?.default;
    expect(typeof rel).toBe("string");
    expect(existsSync(resolve(pkgRoot, rel!))).toBe(true);
  });

  it("names the cordis host half with a package-relative loader specifier", () => {
    // Mirror dsh-client-modules' locatePkgJson: a bundle-patch row resolves
    // against the patch file's own directory, the specifier must be
    // path-like (a subpath such as `rolebox/dsh` is not scanned), and the
    // nearest owning manifest above the resolved host half supplies the
    // browser module id.
    const patchPath = resolve(pkgRoot, "dsh/cordis.patch.yml");
    const doc = load(readFileSync(patchPath, "utf8")) as Array<{
      insert?: Array<{ id?: string; name?: string }>;
    }>;
    const row = doc[0]?.insert?.[0];
    expect(row?.id).toBe("rolebox");
    expect(row?.name).toBe("../dist/entries/dsh.js");

    const hostPath = resolve(dirname(patchPath), row!.name!);
    expect(hostPath).toBe(resolve(pkgRoot, "dist/entries/dsh.js"));
    expect(existsSync(hostPath)).toBe(true);

    let dir = dirname(hostPath);
    let owningName: string | undefined;
    while (owningName === undefined) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        owningName = (JSON.parse(readFileSync(candidate, "utf8")) as { name?: string }).name;
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    expect(owningName).toBe("rolebox");
  });

  it("builds the client bundle envelope with the graph-row id 'rolebox'", () => {
    const bundle = readFileSync(resolve(pkgRoot, "dist/dsh-web-client.js"), "utf8");
    expect(bundle.startsWith("window.__ModuleLoader__.load({")).toBe(true);
    expect(bundle).toContain('id: "rolebox"');
  });
});

// ── apply() end-to-end on the fake ctx ─────────────────────────────────────

describe("dsh plugin apply()", () => {
  it("resolves roles from a temp rolebox dir, registers tools + agents, reports counts", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const { ctx, tools, providers, listeners } = createFakeCtx();

    const disposer = await applyTracked(ctx, { roleboxDir: tmpDir } as DshPluginConfig);
    const stats: DshPluginStats = disposer.stats;

    // Role discovery/resolution against the temp dir.
    expect(stats.discovered).toBeGreaterThanOrEqual(1);
    expect(stats.resolved).toBeGreaterThanOrEqual(1);
    expect(stats.skipped).toBe(0);
    expect(stats.resolvedRoles.length).toBeGreaterThanOrEqual(1);

    // >= 1 tool registered into the fake tools registry, each well-formed.
    expect(tools.registeredTools.length).toBeGreaterThanOrEqual(1);
    for (const tool of tools.registeredTools) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(typeof tool.parameters).toBe("object");
      expect(typeof tool.execute).toBe("function");
    }
    expect(stats.registeredTools).toBe(tools.registeredTools.length);

    // Agents synced into the fake subagents catalog (the role + its agents).
    expect(providers.size).toBeGreaterThanOrEqual(1);
    expect([...providers.keys()]).toContain("tester");
    expect(stats.registeredAgents).toBe(providers.size);

    // Hooks mounted: the dsh extension-point listeners are subscribed.
    expect(listeners.has("tools/pre-execute")).toBe(true);
    expect(listeners.has("tools/post-execute")).toBe(true);
    expect(listeners.has("tools/result")).toBe(true);
    expect(listeners.has("session/event")).toBe(true);

    disposer();
  });

  it("wires graph-notify injection when the live agents service is present, degrades otherwise", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);

    // Full profile: the ctx carries the live-agent registry (`ctx.agents`),
    // so the session adapter's prompt() gets the graph-notify injector seam.
    const { agent, calls } = makeValidatingAgent("session-1");
    const agents: FakeAgentRegistry = {
      get(id: string) {
        return id === "session-1" ? agent : undefined;
      },
    };
    const { ctx: ctxAgents } = createFakeCtx({ agents });
    const disposerWith = await applyTracked(
      ctxAgents,
      { roleboxDir: tmpDir } as DshPluginConfig,
    );
    expect(disposerWith.stats.graphNotifyWired).toBe(true);
    // apply() only wires the seam — no delivery happens during boot.
    expect(calls).toHaveLength(0);
    disposerWith();

    // Headless/minimal profile: no live-agent registry → graph-notify the
    // graph engine still assembles a graphNotify config, but prompt() is the
    // documented no-op (the F6 notifier logs the degraded reminder). The
    // injector is NOT wired, so the boot does not gate on it.
    const { ctx: ctxNoAgents } = createFakeCtx();
    const disposerWithout = await applyTracked(
      ctxNoAgents,
      { roleboxDir: tmpDir } as DshPluginConfig,
    );
    expect(disposerWithout.stats.graphNotifyWired).toBe(false);
    disposerWithout();
  });

  it("dispatches a declared graph's entry attempt through ctx.subagents.start with a live parent", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);

    // A REAL invoking session id — the canonical `sessionID` resolved from the
    // exec's live agent/session (tool-factory.ts:518). The live parent is
    // resolved from THIS id, never the graph-scoped budget key or the callId.
    const INVOKING_SESSION = "plugin-invoking-session";

    // Live-agent registry double (the `ctx.agents` seam): records the session
    // ids the delivery resolves and returns a sentinel live Agent.
    const graphNotices: unknown[] = [];
    const parent = { id: "live-parent", inject: () => undefined, steer: (message: unknown) => { graphNotices.push(message); } };
    const requested: string[] = [];
    const agents = {
      get(id: string) {
        requested.push(id);
        return parent;
      },
    };
    const { ctx, tools, started } = createFakeCtx({ agents });

    // The host launcher and session deliberately use different workspaces.
    const cwd = process.cwd();
    process.chdir(tmpDir);
    const workspace = join(tmpDir, "session-workspace");
    mkdirSync(workspace);
    const priorApprovalPolicy = process.env.ROLEBOX_GRAPH_APPROVAL_POLICY;
    process.env.ROLEBOX_GRAPH_APPROVAL_POLICY = JSON.stringify({
      id: "plugin-review", revision: "1", rules: [{
        graphId: "parent-graph", nodeId: "N1", approverSessions: ["reviewer-session", INVOKING_SESSION],
      }],
    });
    let disposer: DshPluginDisposer | undefined;
    try {
      disposer = await applyTracked(ctx, { roleboxDir: tmpDir } as DshPluginConfig);
      const byName = new Map(tools.registeredTools.map((t) => [t.name, t]));
      const exec = {
        signal: new AbortController().signal,
        callId: "plugin-call-1",
        deferContext: () => {},
        concludeTurn: () => {},
        agent: {
          id: INVOKING_SESSION,
          session: { id: INVOKING_SESSION, header: { cwd: workspace } },
        },
      };

      // Declare a graph whose entry node awaits a worker submission (no
      // completion policy needed): the declaration seam starts it, and the
      // host's delivery starts one dsh subagent run for the attempt.
      const declared = (await byName.get("graph_declare")!.execute(
        {
          declaration: {
            version: 3,
            name: "parent-graph",
            nodes: [
              {
                id: "N1",
                agent: "tester",
                prompt: "p",
                outcomes: [{ id: "done" }],
              },
            ],
            edges: [],
          },
        },
        exec,
      )) as { graph_id: string };

      // The first execution is kicked from the declaration seam and completes
      // its synchronous dispatch window before the tool returns; a short poll
      // only guards the async start bookkeeping.
      for (let i = 0; i < 50 && started.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }

      // The OUTCOME delivery resolved the live parent from ctx.agents keyed by
      // the REAL invoking session and forwarded the SAME live Agent reference.
      expect(declared.graph_id).toBe("parent-graph");
      expect(queryGraphs(graphStoreRoot(getDataDir(), realpathSync(workspace))).graphs.map(graph => graph.graphId)).toEqual(["parent-graph"]);
      expect(existsSync(graphStoreRoot(getDataDir(), tmpDir))).toBe(false);
      const secondWorkspace = join(tmpDir, "other-workspace");
      mkdirSync(secondWorkspace);
      const secondExec = { ...exec, agent: { id: "other-parent", session: { id: "other-parent", header: { cwd: secondWorkspace } } } };
      const second = await byName.get("graph_declare")!.execute({ declaration: {
        version: 3, name: "parent-graph", budget: { max_executions: 0 },
        nodes: [{ id: "different-node", agent: "tester", prompt: "Other workspace", outcomes: [{ id: "done" }] }], edges: [],
      } }, secondExec) as { graph_id: string };
      expect(second.graph_id).toBe("parent-graph");
      expect(queryGraphs(graphStoreRoot(getDataDir(), realpathSync(secondWorkspace))).graphs[0]?.nodes.map(node => node.nodeId)).toEqual(["different-node"]);
      expect(queryGraphs(graphStoreRoot(getDataDir(), realpathSync(workspace))).graphs[0]?.nodes.map(node => node.nodeId)).toEqual(["N1"]);
      expect(started.length).toBeGreaterThanOrEqual(1);
      expect(started[0].request.parent).toBe(parent);
      expect(requested).toContain(INVOKING_SESSION);

      const approvalArgs = {
        graph_id: "parent-graph", command: "approval-request", node_id: "N1",
        reason: "review", expires_at: Date.now() + 60000,
      };
      const control = byName.get("graph_control")!;
      const self = await control.execute({ ...approvalArgs, approver_session_id: INVOKING_SESSION }, exec) as { kind: string };
      expect(self.kind).toBe("refused");
      const raised = await control.execute({ ...approvalArgs, approver_session_id: "reviewer-session" }, exec) as { kind: string; approval?: { request: { authority: { policyId: string } } } };
      expect(raised.kind).toBe("applied");
      expect(raised.approval?.request.authority.policyId).toBe("plugin-review");
      const reviewer = { ...exec, agent: { id: "reviewer-session", session: { id: "reviewer-session", header: { cwd: workspace } } } };
      const approved = await control.execute({ graph_id: "parent-graph", command: "approve", node_id: "N1", reason: "reviewed" }, reviewer) as { kind: string };
      expect(approved.kind).toBe("applied");
      const cancelled = await control.execute({ graph_id: "parent-graph", command: "cancel", reason: "Finished fixture" }, exec) as { kind: string };
      expect(cancelled.kind).toBe("applied");
      for (let i = 0; i < 50 && !JSON.stringify(graphNotices).includes("Finished fixture"); i++) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(JSON.stringify(graphNotices)).toContain("[GRAPH BLOCKED]");
      expect(JSON.stringify(graphNotices)).toContain("Finished fixture");
      expect(JSON.stringify(graphNotices)).toContain("graph_status");
    } finally {
      disposer?.();
      if (priorApprovalPolicy === undefined) delete process.env.ROLEBOX_GRAPH_APPROVAL_POLICY;
      else process.env.ROLEBOX_GRAPH_APPROVAL_POLICY = priorApprovalPolicy;
      process.chdir(cwd);
    }
  });

  it("hands a node's declared tools to the dispatch delivery: per-request toolFilter + prompt (item 1)", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);

    const INVOKING_SESSION = "declared-tools-session";
    const parent = { id: "live-parent", inject: () => undefined };
    const fixture = createFakeCtx({ agents: { get: () => parent } });
    const runtime = fixture.ctx.subagents as DshSubagentDispatchRuntime;
    // The fake service DELEGATES to the registered rolebox provider, exactly as
    // the real dsh subagent service does, so the provider's own composition runs
    // INSIDE the graph worker's start scope and the worker prompt it reads
    // (`graphWorkerPrompt()`) is the delivered one. `onSpawn` then captures the
    // final request: the tool filter the delivery composed AND the prompt the
    // worker would actually receive.
    const requests: DshSubagentStartRequest[] = [];
    runtime.start = async (agent, request) =>
      fixture.providers.get(agent)!.start({ ...request, descriptor: {} });

    const cwd = process.cwd();
    process.chdir(tmpDir);
    const workspace = join(tmpDir, "declared-tools-workspace");
    mkdirSync(workspace);
    let disposer: DshPluginDisposer | undefined;
    try {
      // THE GATE IS ON, so the family is genuinely REGISTERED in this boot: a
      // declared `computer_*` grant must intersect with real tool names, which
      // is the half the r2 evidence never exercised.
      disposer = await applyTracked(fixture.ctx, {
        roleboxDir: tmpDir,
        computerUse: true,
        onSpawn: async (_definition, request) => {
          const id = "worker-" + requests.length;
          const worker = {
            id,
            session: { id, events: [] },
            ctx: { tools: { presentAs: () => () => {} } },
          };
          fixture.ctx.emit("agent/created", { agent: worker });
          requests.push(request);
          return {
            id,
            result: Promise.resolve({ stopReason: "completed", output: [] }),
            dispose: async () => {},
          };
        },
      } as DshPluginConfig);
      const byName = new Map(fixture.tools.registeredTools.map((t) => [t.name, t]));
      const exec = {
        signal: new AbortController().signal,
        callId: "declared-tools-call-1",
        deferContext: () => {},
        concludeTurn: () => {},
        agent: {
          id: INVOKING_SESSION,
          session: { id: INVOKING_SESSION, header: { cwd: workspace } },
        },
      };

      // ONE graph, TWO entry nodes: `shooter` declares the family wildcard,
      // `plain` declares nothing. A single start dispatches both, so ONE
      // delivery must widen the start request and the other must stay the
      // baseline — the per-attempt property a static option cannot express.
      const declared = (await byName.get("graph_declare")!.execute(
        {
          declaration: {
            version: 3,
            name: "declared-tools-graph",
            nodes: [
              {
                id: "shooter",
                agent: "tester",
                prompt: "shoot",
                tools: ["computer_*"],
                outcomes: [{ id: "done" }],
              },
              { id: "plain", agent: "tester", prompt: "plain", outcomes: [{ id: "done" }] },
            ],
            edges: [],
          },
        },
        exec,
      )) as { graph_id: string };
      expect(declared.graph_id).toBe("declared-tools-graph");

      for (let i = 0; i < 50 && requests.length < 2; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(requests).toHaveLength(2);

      const requestOf = (node: string): DshSubagentStartRequest =>
        requests.find((request) => (request.label ?? "").includes(node + "#"))!;
      const promptText = (request: DshSubagentStartRequest): string =>
        request.prompt.map((block) => block.text ?? "").join("\n\n");
      const shooter = requestOf("shooter");
      const plain = requestOf("plain");

      // (b) THE ALLOW-LIST: the node's declared entries INTERSECTED with the
      // tools the host actually registered, on top of the static baseline.
      expect(shooter.toolFilter?.allow).toEqual([
        ...DSH_GRAPH_WORKER_TOOLS,
        ...COMPUTER_TOOL_NAMES,
      ]);
      // …and the undeclared node keeps exactly the registered baseline.
      expect(plain.toolFilter?.allow).toEqual([...DSH_GRAPH_WORKER_TOOLS]);

      // (a) THE DELIVERED PROMPT states the SAME grant: the declared node is
      // told about its host tools, the undeclared node is told the baseline.
      expect(promptText(shooter)).toContain(
        "Your tools are graph_worker_exec, graph_submit_outcome and the host tools this node declares.",
      );
      expect(promptText(shooter)).toContain("this node declares the host tools computer_*");
      expect(promptText(shooter)).not.toContain("declares no extra host tools");
      // The composed worker prompt is the one the provider prepends, ahead of
      // the plan prompt and the attempt handoff.
      expect(promptText(shooter)).toContain("shoot");
      expect(promptText(plain)).toContain("declares no extra host tools");
      expect(promptText(plain)).toContain(
        "Your tools are graph_worker_exec and graph_submit_outcome.",
      );
    } finally {
      disposer?.();
      process.chdir(cwd);
    }
  });

  it("delivers only the graph target's role, functions and readable resources through the real registrar", async () => {
    writeRoleYaml("coordinator", [
      "name: Coordinator", "description: Coordinates", "prompt: Coordinator-only prompt",
      "model: parent-provider/model-name", "functions: [triage]", "disable_functions: [plan, execute, loop]",
    ].join("\n"));
    writeRoleYaml("coordinator/subagents/planner", [
      "name: Planner", "description: Plans", "prompt: Planner-only prompt",
      "model: worker-provider/model-name", "functions: [plan, unused]", "auto_activate: [plan]",
      "disable_functions: [execute, loop]", "skills: [research]", "tools:", "  graph_declare: false",
    ].join("\n"));
    writeRoleSkill("coordinator/subagents/planner", "research");
    const roleFiles: Record<string, string> = {
      "coordinator/functions/triage.md": "---\nname: triage\ndescription: Route work\n---\nParent routing function",
      "coordinator/subagents/planner/functions/plan.md": "---\nname: plan\ndescription: Plan work\n---\nChild planning function",
      "coordinator/subagents/planner/functions/unused.md": "---\nname: unused\ndescription: Other work\n---\nInactive worker instructions",
      "coordinator/references/schema.md": "The planning schema",
    };
    for (const [file, content] of Object.entries(roleFiles)) {
      const path = join(tmpDir, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    const cwd = process.cwd();
    process.chdir(tmpDir);
    let disposer: DshPluginDisposer | undefined;
    try {
      new ActiveRoleStore(process.cwd()).saveSync(new Map(["parent", "worker"].map(sessionId =>
        [sessionId, { sessionId, roleId: "coordinator", updatedAt: Date.now() }])));
      const parent = { id: "parent", inject: () => undefined };
      const fixture = createFakeCtx({ agents: { get: () => parent }, systemPrompt: true });
      const runtime = fixture.ctx.subagents as DshSubagentDispatchRuntime;
      runtime.start = async (agent, request) => fixture.providers.get(agent)!.start({ ...request, descriptor: {} });
      const requests: DshSubagentStartRequest[] = [];
      const workerSections: string[] = [];
      const workerContexts: string[] = [];
      disposer = await applyTracked(fixture.ctx, {
        roleboxDir: tmpDir,
        // The GATE stays OFF, spelled out: `computerUse` is a defaulted boolean
        // on the schema, so `DshPluginConfig` declares it required.
        computerUse: false,
        onSpawn: async (_definition, request) => {
          const worker = { id: "worker", session: { id: "worker", events: [] }, ctx: { tools: { presentAs: () => () => {} } } };
          fixture.ctx.emit("agent/created", { agent: worker });
          requests.push(request);
          workerSections.push(...fixture.sections.map(section => section.text({ agent: { id: "worker" } })));
          workerContexts.push(...fixture.contexts.map(context => context.text({ agent: { id: "worker" } })));
          return { id: "worker", result: Promise.resolve({ stopReason: "completed", output: [] }), dispose: async () => {} };
        },
      } as DshPluginConfig);
      const declare = fixture.tools.registeredTools.find(tool => tool.name === "graph_declare")!;
      await declare.execute({ declaration: {
        version: 3, name: "worker-prompt", nodes: [{ id: "plan", agent: "coordinator--planner",
          prompt: "Produce a strategy.", outcomes: [{ id: "strategy" }] }], edges: [],
      } }, { signal: new AbortController().signal, callId: "declare-worker-prompt", deferContext: () => {}, concludeTurn: () => {},
        agent: { id: "parent", session: { id: "parent", header: { cwd: tmpDir } } } });
      expect(requests).toHaveLength(1);
      const prompt = requests[0].prompt.map(block => block.text ?? "").join("\n\n");
      expect(prompt).toContain("Planner-only prompt");
      expect(prompt).toContain("## Active functions");
      expect(prompt).toContain("Child planning function");
      expect(prompt).toContain("Produce a strategy.");
      expect(prompt.match(/attempt handoff/g)).toHaveLength(1);
      expect(prompt).not.toContain("Coordinator-only prompt");
      expect(prompt).not.toContain("Parent routing function");
      expect(prompt).not.toContain("## Available functions");
      expect(prompt).not.toContain("Inactive worker instructions");
      expect(prompt).not.toContain("Use the Read tool");
      expect(prompt).not.toContain("Use the skill tool");
      expect(prompt).not.toContain("## Available sub-agents");
      expect(requests[0].agentOptions).toEqual({ provider: "worker-provider", model: "model-name" });
      // The block states the delivery directory once; each entry names its own
      // file below it, so base + name is the readable private copy.
      const referenceDirectory = prompt.match(/^Base directory: `([^`]+)`$/m)![1];
      expect(referenceDirectory.startsWith(tmpDataDir)).toBe(true);
      expect(prompt).toContain("- `schema` — ");
      expect(readFileSync(join(referenceDirectory, "schema.md"), "utf8")).toBe("The planning schema");
      expect(workerSections).toEqual([""]);
      expect(workerContexts).toEqual([""]);
      expect(fixture.sections[0].text({ agent: { id: "parent" } })).toContain("Coordinator-only prompt");
    } finally {
      disposer?.();
      process.chdir(cwd);
    }
  });

  it("registers every assembled tool when enabledNamespaces is absent", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const { ctx, tools } = createFakeCtx();

    const disposer = await applyTracked(ctx, { roleboxDir: tmpDir } as DshPluginConfig);
    const keys = tools.registeredTools.map((t) => t.name);

    // The intersection tool set spans multiple namespaces.
    expect(keys).toContain("hashline_read");
    expect(keys).toContain("web_search");
    expect(keys).toContain("asset_search");

    disposer();
  });

  it("enabledNamespaces filters registered tools by exact name or prefix", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const { ctx, tools } = createFakeCtx();

    const disposer = await applyTracked(ctx, {
      roleboxDir: tmpDir,
      enabledNamespaces: ["hashline", "web"],
    } as DshPluginConfig);
    const keys = tools.registeredTools.map((t) => t.name);

    expect(keys.length).toBeGreaterThanOrEqual(1);
    for (const key of keys) {
      expect(key.startsWith("hashline_") || key.startsWith("web_")).toBe(true);
    }
    expect(keys).not.toContain("asset_search");

    disposer();
  });

  it("enabledNamespaces composes '*' with a '!web' exclusion", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const { ctx, tools } = createFakeCtx();

    const disposer = await applyTracked(ctx, {
      roleboxDir: tmpDir,
      enabledNamespaces: ["*", "!web"],
    } as DshPluginConfig);
    const keys = tools.registeredTools.map((t) => t.name);

    // The documented mitigation for the global web_search / web_fetch
    // collision: keep everything, subtract the colliding namespace. Tools the
    // profile never enumerated — interactive_terminal included — stay
    // registered.
    expect(keys).toContain("hashline_read");
    expect(keys).toContain("asset_search");
    expect(keys).toContain("interactive_terminal");
    expect(keys).not.toContain("web_search");
    expect(keys).not.toContain("web_read");
    expect(keys).not.toContain("web_fetch");

    disposer();
  });

  it("a negatives-only enabledNamespaces list registers everything except the exclusions", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);

    // Baseline: the same boot with the filter absent — the full compiled set.
    const unfiltered = createFakeCtx();
    const unfilteredDisposer = await applyTracked(unfiltered.ctx, {
      roleboxDir: tmpDir,
    } as DshPluginConfig);
    const allKeys = unfiltered.tools.registeredTools.map((t) => t.name);

    const { ctx, tools } = createFakeCtx();
    const disposer = await applyTracked(ctx, {
      roleboxDir: tmpDir,
      enabledNamespaces: ["!web"],
    } as DshPluginConfig);
    const keys = tools.registeredTools.map((t) => t.name);

    // An exclusion can only SUBTRACT from a baseline, and with nothing else
    // declared that baseline is everything — so `["!web"]` must not register
    // zero tools.
    expect(keys).toContain("asset_search");
    expect(keys).toContain("hashline_read");
    expect(keys).not.toContain("web_search");
    expect([...keys].sort()).toEqual(
      allKeys.filter((key) => !key.startsWith("web_")).sort(),
    );

    disposer();
    unfilteredDisposer();
  });

  it("an exclusion may name a single tool while a positive entry narrows the baseline", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const { ctx, tools } = createFakeCtx();

    const disposer = await applyTracked(ctx, {
      roleboxDir: tmpDir,
      enabledNamespaces: ["hashline", "memory", "!hashline_edit"],
    } as DshPluginConfig);
    const keys = tools.registeredTools.map((t) => t.name);

    expect(keys).toContain("hashline_read");
    expect(keys).toContain("memory_write");
    expect(keys).not.toContain("hashline_edit");
    // The exclusions do not widen the declared allow-list.
    expect(keys).not.toContain("asset_search");

    disposer();
  });

  it("an exclusion beats the '*' allow, including the opt-out of a single tool", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const { ctx, tools } = createFakeCtx();

    const disposer = await applyTracked(ctx, {
      roleboxDir: tmpDir,
      enabledNamespaces: ["*", "!interactive_terminal"],
    } as DshPluginConfig);
    const keys = tools.registeredTools.map((t) => t.name);

    expect(keys).not.toContain("interactive_terminal");
    expect(keys).toContain("asset_search");
    expect(keys).toContain("hashline_read");

    disposer();
  });

  it("trims entries and ignores a bare '!' without throwing", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const { ctx, tools } = createFakeCtx();

    const disposer = await applyTracked(ctx, {
      roleboxDir: tmpDir,
      enabledNamespaces: [" hashline ", "!", "  "],
    } as DshPluginConfig);
    const keys = tools.registeredTools.map((t) => t.name);

    // The padded entry matches after trimming, the bare '!' and the blank
    // entry are ignored (and the declared positive entry still narrows).
    expect(keys).toContain("hashline_read");
    expect(keys).toContain("hashline_edit");
    expect(keys).not.toContain("memory_write");
    expect(keys).not.toContain("web_search");

    disposer();
  });

  it("the boot log reports the tool names the namespace filter dropped", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    // Capture on the root logger the entry's sub-logger inherits from.
    const logLines: string[] = [];
    getRootLogger().attachTransport((entry) => {
      try {
        logLines.push(JSON.stringify(entry));
      } catch {
        // A log object this test cannot serialize is not the boot report.
      }
    });

    const { ctx } = createFakeCtx();
    const disposer = await applyTracked(ctx, {
      roleboxDir: tmpDir,
      enabledNamespaces: ["hashline"],
    } as DshPluginConfig);

    const boot = logLines
      .filter((line) => line.includes("Plugin initialized"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(boot).toHaveLength(1);
    // tslog carries the message on "0" and the structured fields on "1":
    // { "0": "Plugin initialized", "1": { discovered, ..., filteredTools } }.
    const fields = boot[0]?.["1"] as Record<string, unknown> | undefined;
    const filteredTools = fields?.filteredTools;
    expect(Array.isArray(filteredTools)).toBe(true);
    const dropped = filteredTools as string[];
    // A narrowed profile is visible instead of silent: the dropped names are
    // reported, in a stable sorted order.
    expect(dropped).toContain("web_search");
    expect(dropped).toContain("interactive_terminal");
    expect(dropped).not.toContain("hashline_read");
    expect(dropped).not.toContain("hashline_edit");
    // BOTH registration paths report: the role-snapshot generation
    // (`asset_*` / `reference_search`) is registered through its own seam and
    // filtered there, so an allow-list that drops it must say so too.
    expect(dropped).toContain("asset_search");
    expect(dropped).toContain("asset_inspect");
    expect(dropped).toContain("asset_validate");
    expect(dropped).toContain("reference_search");
    expect(dropped).toEqual([...dropped].sort());
    // Every dropped key appears exactly once.
    expect(new Set(dropped).size).toBe(dropped.length);

    disposer();
  });

  it("the boot log's filteredTools is exactly what both registration paths dropped", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const logLines: string[] = [];
    getRootLogger().attachTransport((entry) => {
      try {
        logLines.push(JSON.stringify(entry));
      } catch {
        // A log object this test cannot serialize is not the boot report.
      }
    });

    // Baseline boot — no filter: the whole compiled face, both paths.
    const unfiltered = createFakeCtx();
    const unfilteredDisposer = await applyTracked(unfiltered.ctx, {
      roleboxDir: tmpDir,
    } as DshPluginConfig);
    const allKeys = unfiltered.tools.registeredTools.map((t) => t.name);

    // Filtered boot — the documented wildcard + exclusion shape, with one
    // exclusion per registration path: `!asset` subtracts the role-snapshot
    // generation's `asset_*` keys, `!web` the main loop's `web_*` keys. Both
    // paths must therefore report, and neither may report the other's silence.
    const filtered = createFakeCtx();
    const filteredDisposer = await applyTracked(filtered.ctx, {
      roleboxDir: tmpDir,
      enabledNamespaces: ["*", "!asset", "!web"],
    } as DshPluginConfig);
    const keptKeys = filtered.tools.registeredTools.map((t) => t.name);

    const boots = logLines
      .filter((line) => line.includes("Plugin initialized"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(boots).toHaveLength(2);
    const unfilteredFields = boots[0]?.["1"] as
      | Record<string, unknown>
      | undefined;
    const filteredFields = boots[1]?.["1"] as
      | Record<string, unknown>
      | undefined;

    // An unfiltered boot drops nothing, so the field cannot report noise.
    expect(unfilteredFields?.filteredTools).toEqual([]);

    expect(Array.isArray(filteredFields?.filteredTools)).toBe(true);
    const dropped = filteredFields?.filteredTools as string[];
    // The role-snapshot keys come from the second, reload-managed path...
    expect(dropped).toContain("asset_search");
    expect(dropped).toContain("asset_inspect");
    expect(dropped).toContain("asset_validate");
    // ...and the main-loop keys from the first: EACH path must be represented,
    // or the `!asset`-only shape would let one of them report nothing and still
    // satisfy the set-difference check below.
    expect(dropped).toContain("web_search");
    expect(dropped).toContain("web_read");
    expect(dropped).toContain("web_fetch");
    // The exclusions subtract only those namespaces, so a key outside both
    // survives from each path (`reference_search` from the snapshot
    // generation, `hashline_read` from the main loop).
    expect(dropped).not.toContain("reference_search");
    expect(keptKeys).toContain("reference_search");
    expect(dropped).not.toContain("hashline_read");
    expect(keptKeys).toContain("hashline_read");
    // WHAT THIS PROVES: `filteredTools` is EXACTLY the set difference between
    // the two boots' registered names, sorted and duplicate-free — the names
    // the filtered boot dropped and nothing else. Both registration paths
    // contribute (asserted above), so neither can silently stop reporting, and
    // no path can report a key it did not actually drop.
    expect(dropped).toEqual(
      allKeys.filter((key) => !keptKeys.includes(key)).sort(),
    );
    expect(new Set(dropped).size).toBe(dropped.length);

    filteredDisposer();
    unfilteredDisposer();
  });

  // ── Host tool-name collision fallback ────────────────────────────────────
  //
  // A host composition can already own a GLOBAL tool name rolebox also wants
  // (`@deepseek-ai/dsh-tool-web` owns `web_search` / `web_fetch`), and the dsh
  // registry rejects a duplicate name within one layer, which used to fail the
  // whole boot. These arms pin the fallback: probe the canonical name, register
  // `rb_<name>` when only that is free, skip with a warning when both are
  // taken — and register unchanged when there is nothing to probe.

  /** Root-logger transport capturing every entry as a parsed log object. */
  const captureLogEntries = (): Array<Record<string, unknown>> => {
    const entries: Array<Record<string, unknown>> = [];
    getRootLogger().attachTransport((entry) => {
      try {
        entries.push(JSON.parse(JSON.stringify(entry)) as Record<string, unknown>);
      } catch {
        // A log object this test cannot serialize is not a boot entry.
      }
    });
    return entries;
  };

  /** The collision warning for one canonical name, captured from the logger. */
  const collisionWarnings = (
    entries: Array<Record<string, unknown>>,
    name: string,
  ): Array<Record<string, unknown>> =>
    entries.filter((entry) => {
      try {
        return (
          JSON.stringify(entry).includes(name) &&
          String(entry["0"]).includes("Host already provides the tool")
        );
      } catch {
        return false;
      }
    });

  /** The boot log's `filteredTools` field from the single recorded boot. */
  const bootFilteredTools = (
    entries: Array<Record<string, unknown>>,
  ): string[] => {
    const boots = entries.filter((entry) =>
      String(entry["0"]).includes("Plugin initialized"),
    );
    expect(boots).toHaveLength(1);
    const fields = boots[0]?.["1"] as Record<string, unknown> | undefined;
    expect(Array.isArray(fields?.filteredTools)).toBe(true);
    return fields?.filteredTools as string[];
  };

  it("a free name registers under its canonical name with no rename and no warning", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const entries = captureLogEntries();
    const { ctx, tools } = createFakeCtx();

    const disposer = await applyTracked(ctx, { roleboxDir: tmpDir } as DshPluginConfig);
    const keys = tools.registeredTools.map((t) => t.name);

    expect(keys).toContain("web_search");
    expect(keys).toContain("asset_search");
    // The probe is live on this double (it answers for tool names), so an
    // accidental "taken" reading would have prefixed these.
    expect(keys).not.toContain("rb_web_search");
    expect(keys.some((key) => key.startsWith("rb_"))).toBe(false);
    expect(collisionWarnings(entries, "web_search")).toHaveLength(0);
    expect(bootFilteredTools(entries)).toEqual([]);

    disposer();
  });

  it("a taken canonical name registers as rb_<name> with ONE warning naming both", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const entries = captureLogEntries();
    const { ctx, tools } = createFakeCtx({
      takenTools: new Set(["web_search"]),
    });

    const disposer = await applyTracked(ctx, { roleboxDir: tmpDir } as DshPluginConfig);
    const keys = tools.registeredTools.map((t) => t.name);

    // The CANONICAL name is left to the host; rolebox registers the prefixed
    // variant, and only that namespace key is affected.
    expect(keys).toContain("rb_web_search");
    expect(keys).not.toContain("web_search");
    expect(keys).toContain("web_fetch");
    expect(keys).not.toContain("rb_web_fetch");
    // Exactly ONE warning, naming the canonical name, the registered name, and
    // the fact that the host already provides the canonical tool.
    const warnings = collisionWarnings(entries, "web_search");
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.["0"])).toContain('Host already provides the tool "web_search"');
    expect(String(warnings[0]?.["0"])).toContain('"rb_web_search"');

    disposer();
  });

  it("the prefixed copy keeps the canonical definition's execute and presentation members", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    // The canonical compile, from a boot with NOTHING taken: this is the
    // definition the rename must copy verbatim apart from `name`.
    const { ctx: canonicalCtx, tools: canonicalTools } = createFakeCtx();
    const canonicalDisposer = await applyTracked(canonicalCtx, {
      roleboxDir: tmpDir,
    } as DshPluginConfig);
    const canonical = canonicalTools.registeredTools.find(
      (t) => t.name === "web_search",
    );
    expect(canonical).toBeDefined();

    const { ctx, tools } = createFakeCtx({
      takenTools: new Set(["web_search"]),
    });
    const disposer = await applyTracked(ctx, { roleboxDir: tmpDir } as DshPluginConfig);
    const renamed = tools.registeredTools.find(
      (t) => t.name === "rb_web_search",
    );

    expect(renamed).toBeDefined();
    // Shallow copy, name only: every other member of the canonical definition
    // survives BY IDENTITY (the presentation callbacks and the output render
    // are the same function references — they are keyed by the canonical name
    // at COMPILE time, so the rename cannot change what the host invokes) or
    // by value (description, parameters).
    expect(typeof renamed?.execute).toBe("function");
    expect(renamed?.presentCall).toBe(canonical?.presentCall);
    expect(renamed?.isConcurrencySafe).toBe(canonical?.isConcurrencySafe);
    expect(renamed?.output.presentationMeta).toBe(
      canonical?.output.presentationMeta,
    );
    expect(typeof renamed?.output.render).toBe("function");
    expect(renamed?.description).toBe(canonical?.description);
    expect(renamed?.parameters).toEqual(canonical?.parameters);

    disposer();
  });

  it("with both the canonical and prefixed name taken the tool is skipped with a warning", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const entries = captureLogEntries();
    const { ctx, tools } = createFakeCtx({
      takenTools: new Set(["web_search", "rb_web_search"]),
    });

    const disposer = await applyTracked(ctx, { roleboxDir: tmpDir } as DshPluginConfig);
    const keys = tools.registeredTools.map((t) => t.name);

    // Skipped — not renamed twice, not registered over the host's name.
    expect(keys).not.toContain("web_search");
    expect(keys).not.toContain("rb_web_search");
    expect(keys).toContain("web_fetch");
    const warnings = collisionWarnings(entries, "web_search");
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.["0"])).toContain('"rb_web_search"');
    expect(String(warnings[0]?.["0"])).toContain("skipping the rolebox tool");
    // A collision skip is NOT a namespace-filter drop: `filteredTools` reports
    // the filter's decisions only, so a profile with no filter reports none.
    expect(bootFilteredTools(entries)).toEqual([]);

    disposer();
  });

  it("a probe that throws counts as free and never blocks the boot", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const { ctx, tools } = createFakeCtx({
      takenTools: (name: string) => {
        if (name === "web_search") throw new Error("scope read failed");
        return false;
      },
    });

    const disposer = await applyTracked(ctx, { roleboxDir: tmpDir } as DshPluginConfig);
    const keys = tools.registeredTools.map((t) => t.name);

    expect(keys).toContain("web_search");
    expect(keys).not.toContain("rb_web_search");

    disposer();
  });

  it("a double without tools.get registers the canonical name (graceful degradation)", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const { ctx, tools } = createFakeCtx({ noToolsLookup: true });

    const disposer = await applyTracked(ctx, { roleboxDir: tmpDir } as DshPluginConfig);
    const keys = tools.registeredTools.map((t) => t.name);

    expect(keys).toContain("web_search");
    expect(keys).toContain("asset_search");
    expect(keys.some((key) => key.startsWith("rb_"))).toBe(false);

    disposer();
  });

  it("the role-snapshot path honors the same collision helper", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const entries = captureLogEntries();
    const { ctx, tools } = createFakeCtx({
      takenTools: new Set(["asset_search"]),
    });

    const disposer = await applyTracked(ctx, { roleboxDir: tmpDir } as DshPluginConfig);
    const keys = tools.registeredTools.map((t) => t.name);

    // The reload-managed generation goes through the same helper: the taken
    // `asset_search` becomes `rb_asset_search`, its siblings are untouched.
    expect(keys).toContain("rb_asset_search");
    expect(keys).not.toContain("asset_search");
    expect(keys).toContain("asset_inspect");
    expect(keys).toContain("reference_search");
    expect(collisionWarnings(entries, "asset_search")).toHaveLength(1);

    disposer();
  });

  it("a graph-worker tool name is never renamed — it is skipped with a warning", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const entries = captureLogEntries();
    const { ctx, tools } = createFakeCtx({
      takenTools: new Set(["graph_worker_exec"]),
    });

    const disposer = await applyTracked(ctx, { roleboxDir: tmpDir } as DshPluginConfig);
    const keys = tools.registeredTools.map((t) => t.name);

    // The worker guard matches `execution.name` by literal and the dispatch
    // request filters on the same list, so a rename would silently break the
    // worker face — an occupied name is skipped instead.
    expect(keys).not.toContain("graph_worker_exec");
    expect(keys).not.toContain("rb_graph_worker_exec");
    expect(collisionWarnings(entries, "graph_worker_exec")).toHaveLength(1);

    disposer();
  });

  it("the namespace filter runs first: a denied colliding tool is never probed or renamed", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const entries = captureLogEntries();
    const probed: string[] = [];
    const { ctx, tools } = createFakeCtx({
      takenTools: (name: string) => {
        probed.push(name);
        return name === "web_search" || name === "rb_web_search";
      },
    });

    const disposer = await applyTracked(ctx, {
      roleboxDir: tmpDir,
      enabledNamespaces: ["*", "!web"],
    } as DshPluginConfig);
    const keys = tools.registeredTools.map((t) => t.name);

    // `!web` subtracts the namespace BEFORE the probe: neither the canonical
    // nor the prefixed name is registered, and neither was even looked up.
    expect(keys).not.toContain("web_search");
    expect(keys).not.toContain("rb_web_search");
    expect(probed).not.toContain("web_search");
    expect(probed).not.toContain("rb_web_search");
    expect(collisionWarnings(entries, "web_search")).toHaveLength(0);
    // The filter drop is still reported (the namespace filter's own field).
    expect(bootFilteredTools(entries)).toContain("web_search");

    disposer();
  });

  it("applies defaultRole promotion to the resolved roles", async () => {

    writeRoleYaml("alpha", SIMPLE_ROLE.replace("Test Role", "Alpha"));
    writeRoleYaml("beta", SIMPLE_ROLE.replace("Test Role", "Beta"));
    const { ctx } = createFakeCtx();

    const disposer = await applyTracked(ctx, { roleboxDir: tmpDir, defaultRole: "beta" } as DshPluginConfig);
    const roles = disposer.stats.resolvedRoles;

    const alpha = roles.find((r) => r.id === "alpha");
    const beta = roles.find((r) => r.id === "beta");
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();
    // defaultRole demotes the other primary(s) and promotes the target.
    expect(alpha!.config.mode).toBe("all");
    expect(beta!.config.mode).toBe("primary");

    disposer();
  });

  it("threads a host-supplied onSpawn delegate through to the registered providers", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const { ctx, providers } = createFakeCtx();

    const spawned: string[] = [];
    const onSpawn: DshSpawnDelegate = async (definition) => {
      spawned.push(definition.id);
      return {
        id: "host-run",
        result: Promise.resolve({ stopReason: "completed", output: [] }),
        dispose: async () => {},
      };
    };

    const disposer = await applyTracked(ctx, {
      roleboxDir: tmpDir,
      onSpawn,
    } as DshPluginConfig);

    // At least one rolebox provider is registered; its start() must delegate
    // to the host delegate instead of rejecting DshSpawnNotWiredError.
    const provider = [...providers.values()][0];
    expect(provider).toBeDefined();
    const run = await provider!.start({
      prompt: [{ type: "text", text: "hi" }],
      parent: {},
      signal: new AbortController().signal,
      descriptor: {},
    });
    expect(run.id).toBe("host-run");
    expect(spawned).toEqual([provider!.name]);

    disposer();
  });

  // ── provider-route safety path (ctx.llm probe wiring) ──────────────────────
  // The plugin probes the optional `ctx.llm` service and hands the registrar a
  // live route list; a split model whose provider has no registered adapter
  // degrades to a model-only override (base provider untouched) rather than
  // failing the spawn with NO_ADAPTER.

  const MODEL_ROLE = [
    "name: Model Role",
    "description: A role carrying a split provider/model reference",
    "prompt: You are a model role.",
    "model: openrouter/openai/gpt-4o-mini",
  ].join("\n");

  it("degrades an unregistered split provider to model-only via the ctx.llm route probe", async () => {
    writeRoleYaml("modeler", MODEL_ROLE);
    const { ctx, providers } = createFakeCtx({
      // dsh has no adapter registered for the role's 'openrouter' route.
      llm: { listProviders: () => [{ id: "openai" }] },
    });

    const captured: DshSubagentStartRequest[] = [];
    const onSpawn: DshSpawnDelegate = async (_definition, request) => {
      captured.push(request);
      return {
        id: "host-run",
        result: Promise.resolve({ stopReason: "completed", output: [] }),
        dispose: async () => {},
      };
    };

    const disposer = await applyTracked(ctx, {
      roleboxDir: tmpDir,
      onSpawn,
    } as DshPluginConfig);

    const provider = providers.get("modeler");
    expect(provider).toBeDefined();
    await provider!.start({
      prompt: [{ type: "text", text: "hi" }],
      parent: {},
      signal: new AbortController().signal,
      agentOptions: { provider: "openai" },
      descriptor: {},
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].agentOptions).toEqual({
      provider: "openai",
      model: "openai/gpt-4o-mini",
    });

    disposer();
  });

  it("emits provider + model when the ctx.llm route probe reports the split provider", async () => {
    writeRoleYaml("modeler", MODEL_ROLE);
    const { ctx, providers } = createFakeCtx({
      llm: { listProviders: () => [{ id: "openrouter" }] },
    });

    const captured: DshSubagentStartRequest[] = [];
    const onSpawn: DshSpawnDelegate = async (_definition, request) => {
      captured.push(request);
      return {
        id: "host-run",
        result: Promise.resolve({ stopReason: "completed", output: [] }),
        dispose: async () => {},
      };
    };

    const disposer = await applyTracked(ctx, {
      roleboxDir: tmpDir,
      onSpawn,
    } as DshPluginConfig);

    const provider = providers.get("modeler");
    expect(provider).toBeDefined();
    await provider!.start({
      prompt: [{ type: "text", text: "hi" }],
      parent: {},
      signal: new AbortController().signal,
      agentOptions: { provider: "openai" },
      descriptor: {},
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].agentOptions).toEqual({
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
    });

    disposer();
  });

  it("emits the split unchanged when ctx.llm is absent (pre-safety behavior)", async () => {
    writeRoleYaml("modeler", MODEL_ROLE);
    const { ctx, providers } = createFakeCtx(); // no llm service — headless profile

    const captured: DshSubagentStartRequest[] = [];
    const onSpawn: DshSpawnDelegate = async (_definition, request) => {
      captured.push(request);
      return {
        id: "host-run",
        result: Promise.resolve({ stopReason: "completed", output: [] }),
        dispose: async () => {},
      };
    };

    const disposer = await applyTracked(ctx, {
      roleboxDir: tmpDir,
      onSpawn,
    } as DshPluginConfig);

    const provider = providers.get("modeler");
    expect(provider).toBeDefined();
    await provider!.start({
      prompt: [{ type: "text", text: "hi" }],
      parent: {},
      signal: new AbortController().signal,
      agentOptions: { provider: "openai" },
      descriptor: {},
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].agentOptions).toEqual({
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
    });

    disposer();
  });

  it("disposer cleans up tool registrations and hook listeners", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const { ctx, tools, listeners } = createFakeCtx();

    const disposer = await applyTracked(ctx, { roleboxDir: tmpDir } as DshPluginConfig);
    expect(tools.registeredTools.length).toBeGreaterThanOrEqual(1);

    disposer();

    expect(tools.registeredTools).toHaveLength(0);
    expect(listeners.get("tools/pre-execute") ?? []).toHaveLength(0);
    expect(listeners.get("session/event") ?? []).toHaveLength(0);
  });

  it("registers /rolebox routes when ctx.get('webServer') returns a registrar", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const registered: DshWebRouteLike[] = [];
    const fakeWebServer: DshWebServerRouteRegistrar = {
      register(route: DshWebRouteLike): () => void {
        registered.push(route);
        return () => {
          const i = registered.indexOf(route);
          if (i >= 0) registered.splice(i, 1);
        };
      },
    };
    const { ctx } = createFakeCtx({ webServer: fakeWebServer });

    const disposer = await applyTracked(ctx, { roleboxDir: tmpDir } as DshPluginConfig);

    // The seam registered the COMPOSED /rolebox prefix route exactly once —
    // the real host webserver rejects duplicate (kind, path) registrations
    // (`webserver: duplicate prefix route "/rolebox"`, lib/index.js:54-55),
    // so the role-switch surface and the monitor surface share one handler —
    // PLUS the log view's own `/rolebox/logs` prefix route: a different
    // (kind, path) pair, so the duplicate check cannot fire and the host
    // resolves by LONGEST prefix.
    expect(disposer.stats.webRouteRegistered).toBe(true);
    expect(disposer.stats.monitorRouteRegistered).toBe(true);
    expect(disposer.stats.logsRouteRegistered).toBe(true);
    expect(registered).toHaveLength(2);
    const route = registered.find((candidate) => candidate.path === "/rolebox")!;
    expect(route.kind).toBe("prefix");
    expect(typeof route.handler).toBe("function");
    const logsRoute = registered.find(
      (candidate) => candidate.path === ROLEBOX_LOGS_ROUTE_PREFIX,
    )!;
    expect(logsRoute).toBeDefined();
    expect(logsRoute.kind).toBe("prefix");
    expect(typeof logsRoute.handler).toBe("function");

    // The single composed handler serves BOTH surfaces: the role-switch
    // surface (/roles — a bare JSON array) and the monitor surface
    // (/status — the composed runtime snapshot, /metrics — the dispatch
    // metrics snapshot).
    const roles = await invoke(route.handler, "GET", "/rolebox/roles");
    expect(roles.status).toBe(200);
    expect(Array.isArray(JSON.parse(roles.text))).toBe(true);

    const metrics = await invoke(route.handler, "GET", "/rolebox/metrics");
    expect(metrics.status).toBe(200);
    const metricsBody = JSON.parse(metrics.text) as {
      counters: Record<string, unknown>;
      gauges: Record<string, unknown>;
      histograms: Record<string, unknown>;
    };
    expect(typeof metricsBody.counters).toBe("object");
    expect(typeof metricsBody.gauges).toBe("object");
    expect(typeof metricsBody.histograms).toBe("object");

    const status = await invoke(route.handler, "GET", "/rolebox/status");
    expect(status.status).toBe(200);
    const statusBody = JSON.parse(status.text) as {
      ok: boolean;
      loops: { count: number; states: unknown[] };
      engineGraphs: unknown[];
      sessions: {
        count: number;
        mostRecentId: string | null;
        activeRoles: Record<string, string | null>;
      };
    };
    expect(statusBody.ok).toBe(true);
    expect(typeof statusBody.loops.count).toBe("number");
    expect(Array.isArray(statusBody.loops.states)).toBe(true);
    expect(Array.isArray(statusBody.engineGraphs)).toBe(true);
    expect(typeof statusBody.sessions.count).toBe("number");
    expect(statusBody.sessions.mostRecentId).toBeNull();
    expect(statusBody.sessions.activeRoles).toEqual({});

    // The fiber disposer unmounts BOTH registrations.
    disposer();
    expect(registered).toHaveLength(0);
  });

  it("registers the /rolebox/logs route whenever the web server service is present", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const registered: DshWebRouteLike[] = [];
    const fakeWebServer: DshWebServerRouteRegistrar = {
      register(route: DshWebRouteLike): () => void {
        registered.push(route);
        return () => {
          const i = registered.indexOf(route);
          if (i >= 0) registered.splice(i, 1);
        };
      },
    };
    const { ctx } = createFakeCtx({ webServer: fakeWebServer });

    const disposer = await applyTracked(ctx, { roleboxDir: tmpDir } as DshPluginConfig);

    // Proven against the REGISTRAR, not only the stats flag: `/rolebox/logs`
    // is IN the registration table, beside the composed `/rolebox` route — a
    // distinct (kind, path) pair, so the host's duplicate check cannot fire.
    expect(disposer.stats.logsRouteRegistered).toBe(true);
    expect(registered.some((route) => route.path === "/rolebox")).toBe(true);
    const logsRoute = registered.find(
      (route) => route.path === ROLEBOX_LOGS_ROUTE_PREFIX,
    );
    expect(logsRoute).toBeDefined();
    expect(logsRoute!.kind).toBe("prefix");
    expect(logsRoute!.path).toBe("/rolebox/logs");
    expect(typeof logsRoute!.handler).toBe("function");

    // …and the registered handler really serves the read-only view: one poll
    // answers 200 with exactly the five keys `readLogView` returns. A missing
    // log directory is an empty set rather than an error, so this drive READS
    // (and never writes) the log location the writer's chain resolves.
    const poll = await invoke(logsRoute!.handler, "GET", "/rolebox/logs");
    expect(poll.status).toBe(200);
    const body = JSON.parse(poll.text) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "cursor",
      "records",
      "skippedLines",
      "source",
      "truncated",
    ]);
    expect(Array.isArray(body.records)).toBe(true);

    // Read-only: a known path with another method is 405 before any handler
    // runs, so the mounted surface has no write.
    const write = await invoke(logsRoute!.handler, "POST", "/rolebox/logs");
    expect(write.status).toBe(405);

    // The fiber disposer unmounts this registration too.
    disposer();
    expect(registered).toHaveLength(0);
  });

  it("registers each /rolebox prefix exactly once when the host rejects duplicate prefixes", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    // Mirror the real @deepseek-ai/dsh-host-webserver register(): duplicate
    // (kind, path) pairs THROW (`webserver: duplicate prefix route
    // "/rolebox"`, lib/index.js:54-55) — a tolerant array double would never
    // surface the collision this test guards against.
    const registered: DshWebRouteLike[] = [];
    const seenPaths = new Set<string>();
    const fakeWebServer: DshWebServerRouteRegistrar = {
      register(route: DshWebRouteLike): () => void {
        if (seenPaths.has(route.path)) {
          throw new Error(
            `webserver: duplicate ${route.kind} route "${route.path}"`,
          );
        }
        seenPaths.add(route.path);
        registered.push(route);
        return () => {
          const i = registered.indexOf(route);
          if (i >= 0) registered.splice(i, 1);
        };
      },
    };
    const { ctx } = createFakeCtx({ webServer: fakeWebServer });

    const disposer = await applyTracked(ctx, { roleboxDir: tmpDir } as DshPluginConfig);

    // TWO registrations — `/rolebox` (composed) and `/rolebox/logs` — and no
    // duplicate: the strict double above throws on a repeated path, so
    // reaching this line proves each prefix was registered exactly once, and
    // every surface reports registered.
    expect(registered.map((candidate) => candidate.path).sort()).toEqual([
      "/rolebox",
      "/rolebox/logs",
    ]);
    expect(seenPaths.size).toBe(2);
    expect(disposer.stats.webRouteRegistered).toBe(true);
    expect(disposer.stats.monitorRouteRegistered).toBe(true);
    expect(disposer.stats.logsRouteRegistered).toBe(true);

    const composed = registered.find((candidate) => candidate.path === "/rolebox")!;
    const roles = await invoke(composed.handler, "GET", "/rolebox/roles");
    expect(roles.status).toBe(200);
    expect(Array.isArray(JSON.parse(roles.text))).toBe(true);
    const status = await invoke(composed.handler, "GET", "/rolebox/status");
    expect(status.status).toBe(200);
    const metrics = await invoke(composed.handler, "GET", "/rolebox/metrics");
    expect(metrics.status).toBe(200);

    disposer();
    expect(registered).toHaveLength(0);
  });

  it("POST /rolebox/reload refreshes the route, skill, and prompt consumers", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);

    // Host web server registrar — captures the composed /rolebox route so the
    // test drives the reload + role-switch surface exactly as the monitor
    // panel does.
    const registered: DshWebRouteLike[] = [];
    const fakeWebServer: DshWebServerRouteRegistrar = {
      register(route: DshWebRouteLike): () => void {
        registered.push(route);
        return () => {
          const i = registered.indexOf(route);
          if (i >= 0) registered.splice(i, 1);
        };
      },
    };

    // The switch persists through the workspace-rooted active-role store;
    // isolate process.cwd() so the sidecar lands in tmpDir.
    const cwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const { ctx, sections, skillRegistrations, skillInvalidationCount } =
        createFakeCtx({
          webServer: fakeWebServer,
          systemPrompt: true,
          skills: true,
        });

      const disposer = await applyTracked(ctx, { roleboxDir: tmpDir } as DshPluginConfig);
      const route = registered[0];
      expect(route).toBeDefined();

      // Boot state: one switchable role, the skill provider registered, and no
      // catalog invalidation yet.
      expect(
        roleIds(await invoke(route.handler, "GET", "/rolebox/roles")),
      ).toEqual(["tester"]);
      expect(skillRegistrations).toHaveLength(1);
      const provider = skillRegistrations[0].provider;
      expect((await provider.list({})).map((candidate) => candidate.name)).toEqual([]);
      expect(skillInvalidationCount()).toBe(0);

      // Activate the boot role so its skills become candidates (the provider
      // advertises the active ∪ default roles).
      const switched = await invoke(
        route.handler,
        "POST",
        "/rolebox/roles/switch",
        JSON.stringify({ role: "tester", session: "s1" }),
      );
      expect(switched.status).toBe(200);

      // NON-DESTRUCTIVE on-disk change: a new primary role + its skill.
      writeRoleYaml("reloader", RELOADED_ROLE);
      writeRoleSkill("reloader", "reload-skill");

      const invalidationsBefore = skillInvalidationCount();

      // The reload route succeeds and reports the re-discovered set.
      const reload = await invoke(route.handler, "POST", "/rolebox/reload");
      expect(reload.status).toBe(200);
      expect(JSON.parse(reload.text)).toEqual({
        ok: true,
        discovered: 2,
        resolved: 2,
        skipped: 0,
      });

      // The live skill catalog was invalidated exactly once for the reload.
      expect(skillInvalidationCount()).toBe(invalidationsBefore + 1);

      // Route consumer: the re-synced registrar advertises the new role.
      expect(
        roleIds(await invoke(route.handler, "GET", "/rolebox/roles")),
      ).toEqual(["reloader", "tester"]);

      // Prompt consumer: switching to the new role makes the rolebox:role
      // section serve its freshly resolved prompt (through the registrar the
      // reloader re-synced).
      const switchToNew = await invoke(
        route.handler,
        "POST",
        "/rolebox/roles/switch",
        JSON.stringify({ role: "reloader", session: "s1" }),
      );
      expect(switchToNew.status).toBe(200);
      // The resolved prompt carries the role's `## Available skills` section
      // after its own text, so assert the prompt prefix.
      expect(
        sections[0].text({ agent: { id: "s1" }, sessionID: "s1" }),
      ).toStartWith("## Role instructions\n\nYou are a reloaded role.");

      // Skill consumer: the provider re-reads the SAME captured roles array on
      // every list(), so the new role's skill is advertised after the reload.
      expect(
        (await provider.list({})).map((candidate) => candidate.name),
      ).toContain("reload-skill");

      disposer();
      expect(registered).toHaveLength(0);
    } finally {
      process.chdir(cwd);
    }
  });

  it("re-applies the configured defaultRole to the reloaded role set in place", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);

    const registered: DshWebRouteLike[] = [];
    const fakeWebServer: DshWebServerRouteRegistrar = {
      register(route: DshWebRouteLike): () => void {
        registered.push(route);
        return () => {
          const i = registered.indexOf(route);
          if (i >= 0) registered.splice(i, 1);
        };
      },
    };

    const cwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const { ctx } = createFakeCtx({ webServer: fakeWebServer });
      const disposer = await applyTracked(ctx, {
        roleboxDir: tmpDir,
        defaultRole: "tester",
      } as DshPluginConfig);

      // Boot promotion: the configured role is the designated primary.
      expect(disposer.stats.resolvedRoles.map((role) => role.id)).toEqual(["tester"]);
      expect(disposer.stats.resolvedRoles[0].config.mode).toBe("primary");

      // A new role arrives on disk; the reload must re-apply the promotion to
      // the re-resolved set (tester stays primary, the newcomer is demoted).
      writeRoleYaml("newcomer", NEWCOMER_ROLE);
      const reload = await invoke(registered[0].handler, "POST", "/rolebox/reload");
      expect(reload.status).toBe(200);

      // disposer.stats.resolvedRoles is the SAME container the reloader mutated
      // in place — a rebuilt array would leave this stale.
      const modes = Object.fromEntries(
        disposer.stats.resolvedRoles.map((role) => [role.id, role.config.mode]),
      );
      expect(modes).toEqual({ tester: "primary", newcomer: "all" });

      disposer();
    } finally {
      process.chdir(cwd);
    }
  });

  it("skips route registration when ctx.get('webServer') is absent", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const { ctx } = createFakeCtx(); // no webServer — headless profile

    const disposer = await applyTracked(ctx, { roleboxDir: tmpDir } as DshPluginConfig);
    expect(disposer.stats.webRouteRegistered).toBe(false);
    expect(disposer.stats.monitorRouteRegistered).toBe(false);
    expect(disposer.stats.logsRouteRegistered).toBe(false);

    disposer();
  });

  it("registers rolebox system-prompt contributions; the section provider serves the active role's prompt", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);

    // Host web server registrar — captures the registered /rolebox route so
    // the test can drive the switcher's REST surface (POST /roles/switch).
    const registeredRoutes: DshWebRouteLike[] = [];
    const fakeWebServer: DshWebServerRouteRegistrar = {
      register(route: DshWebRouteLike): () => void {
        registeredRoutes.push(route);
        return () => {
          const i = registeredRoutes.indexOf(route);
          if (i >= 0) registeredRoutes.splice(i, 1);
        };
      },
    };

    // The switch below persists through the workspace-rooted active-role
    // store; isolate process.cwd() so the sidecar lands in tmpDir
    // instead of the developer's project state.
    const cwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const { ctx, sections, contexts } = createFakeCtx({
        webServer: fakeWebServer,
        systemPrompt: true,
      });

      const disposer = await applyTracked(ctx, { roleboxDir: tmpDir } as DshPluginConfig);
      const stats = disposer.stats;

      // The prompt double recorded the two contributions at their documented
      // shape (section `rolebox:role` order 50, context `rolebox:context` order 0).
      expect(sections).toHaveLength(1);
      expect(sections[0].name).toBe("rolebox:role");
      expect(sections[0].order).toBe(50);
      expect(typeof sections[0].text).toBe("function");
      expect(contexts).toHaveLength(1);
      expect(contexts[0].name).toBe("rolebox:context");
      expect(contexts[0].order).toBe(0);
      expect(typeof contexts[0].text).toBe("function");

      // The prompt seam is additive — roles still resolve and tools still
      // register alongside the contributions.
      expect(stats.resolved).toBeGreaterThanOrEqual(1);
      expect(stats.registeredTools).toBeGreaterThanOrEqual(1);

      // Activate the role via the switcher: the /rolebox switch route delegates
      // to DshRoleSwitcher.activate(role, session) — the session rides in the
      // POST body (`{ role, session }`; the `?session=` query is only honored
      // by the GET/DELETE handlers).
      const sessionId = "session-1";
      const route = registeredRoutes[0];
      expect(route).toBeDefined();
      const switched = await invoke(
        route.handler,
        "POST",
        "/rolebox/roles/switch",
        JSON.stringify({ role: "tester", session: sessionId }),
      );
      expect(switched.status).toBe(200);

      // The registered section text provider now resolves the ACTIVE role's full
      // systemPrompt for the session. The adapter's resolution chain
      // (system-prompt.ts resolveActiveRolePrompt) reads the session id from the
      // context (sessionID/sessionId spellings) alongside agent.id — the exact
      // shape pinned by tests/platform/dsh-system-prompt.test.ts.
      expect(
        sections[0].text({ agent: { id: sessionId }, sessionID: sessionId }),
      ).toBe("## Role instructions\n\nYou are a test role.");

      disposer();
    } finally {
      process.chdir(cwd);
    }
  });

  it("roots the active-role store at process.cwd(), not dirs.configDir", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);

    // Capture the /rolebox route so the test can drive a switch through the
    // switcher's REST surface (POST /roles/switch).
    const registeredRoutes: DshWebRouteLike[] = [];
    const fakeWebServer: DshWebServerRouteRegistrar = {
      register(route: DshWebRouteLike): () => void {
        registeredRoutes.push(route);
        return () => {
          const i = registeredRoutes.indexOf(route);
          if (i >= 0) registeredRoutes.splice(i, 1);
        };
      },
    };

    // The plugin roots the sidecar at process.cwd() — isolate it in tmpDir.
    const cwd = process.cwd();
    process.chdir(tmpDir);
    try {
      // Pre-seed the workspace sidecar (the ActiveRoleStore envelope) for a
      // session, then boot: the plugin's store MUST hydrate the shared holder
      // from THIS file. If it were rooted at dirs.configDir (the dsh home) the
      // seed would be invisible and no role would be active.
      const sidecar = join(
        process.cwd(),
        ".rolebox",
        "state",
        `activerole-${shortHash(process.cwd())}.json`,
      );
      mkdirSync(dirname(sidecar), { recursive: true });
      writeFileSync(
        sidecar,
        JSON.stringify({
          version: 1,
          sessions: [{ sessionId: "s1", roleId: "tester", updatedAt: Date.now() }],
        }),
        "utf-8",
      );

      const { ctx, sections } = createFakeCtx({
        webServer: fakeWebServer,
        systemPrompt: true,
      });
      const disposer = await applyTracked(ctx, { roleboxDir: tmpDir } as DshPluginConfig);

      // Read side: the hydrated selection is live — the prompt section
      // resolves the active role seeded in the workspace sidecar.
      expect(
        sections[0].text({ agent: { id: "s1" }, sessionID: "s1" }),
      ).toBe("## Role instructions\n\nYou are a test role.");

      // Write side: a switch through the host route persists to the SAME
      // workspace sidecar. The holder's save is fire-and-forget, so poll
      // briefly for the async atomic write to land.
      const switched = await invoke(
        registeredRoutes[0].handler,
        "POST",
        "/rolebox/roles/switch",
        JSON.stringify({ role: "tester", session: "s2" }),
      );
      expect(switched.status).toBe(200);

      type Sidecar = {
        sessions?: Array<{ sessionId: string; roleId: string | null }>;
      };
      let persisted: Sidecar = {};
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) {
        try {
          persisted = JSON.parse(readFileSync(sidecar, "utf-8")) as Sidecar;
          if (persisted.sessions?.some((e) => e.sessionId === "s2")) break;
        } catch {
          // not written yet — keep polling
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(persisted.sessions?.find((e) => e.sessionId === "s2")?.roleId).toBe(
        "tester",
      );
      expect(persisted.sessions?.find((e) => e.sessionId === "s1")?.roleId).toBe(
        "tester",
      );

      disposer();
    } finally {
      process.chdir(cwd);
    }
  });

  it("the fiber disposer flushes the active-role sidecar synchronously and the file contains the entry", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);

    // The plugin roots the sidecar at process.cwd() — isolate it in tmpDir so
    // the spy observes the plugin's own store, not the developer's state.
    const cwd = process.cwd();
    process.chdir(tmpDir);
    // Spy on the prototype method the disposer must call. Bun's spyOn calls
    // through by default, so the real synchronous write still lands.
    const spy = spyOn(ActiveRoleStore.prototype, "saveSync");
    try {
      // Pre-seed the workspace sidecar; boot hydrates the holder from it.
      const sidecar = join(
        process.cwd(),
        ".rolebox",
        "state",
        `activerole-${shortHash(process.cwd())}.json`,
      );
      mkdirSync(dirname(sidecar), { recursive: true });
      writeFileSync(
        sidecar,
        JSON.stringify({
          version: 1,
          sessions: [{ sessionId: "s1", roleId: "tester", updatedAt: Date.now() }],
        }),
        "utf-8",
      );

      const { ctx } = createFakeCtx();
      const disposer = await applyTracked(ctx, { roleboxDir: tmpDir } as DshPluginConfig);

      // Hydration is a read — no synchronous write happened during boot.
      expect(spy).not.toHaveBeenCalled();

      // Delete the seed so the post-dispose file proves the sync write ran.
      rmSync(sidecar);

      disposer();

      // The fiber disposer called saveSync and the final write landed
      // synchronously — read the file immediately, no polling.
      expect(spy).toHaveBeenCalled();
      expect(existsSync(sidecar)).toBe(true);
      const persisted = JSON.parse(readFileSync(sidecar, "utf-8")) as {
        sessions?: Array<{ sessionId: string; roleId: string | null }>;
      };
      expect(persisted.sessions?.find((e) => e.sessionId === "s1")?.roleId).toBe(
        "tester",
      );
    } finally {
      spy.mockRestore();
      process.chdir(cwd);
    }
  });

  it("degrades gracefully without a systemPrompt service — roles/tools still resolve, stats unchanged", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);

    // Baseline boot WITH the prompt seam present — the stats it reports.
    const withPrompt = createFakeCtx({ systemPrompt: true });
    const baselineDisposer = await applyTracked(withPrompt.ctx, {
      roleboxDir: tmpDir,
    } as DshPluginConfig);

    // No systemPrompt double (the default fake — headless profile): apply()
    // must not throw, must still resolve roles + register tools/agents...
    const { ctx, tools, providers } = createFakeCtx();
    const disposer = await applyTracked(ctx, { roleboxDir: tmpDir } as DshPluginConfig);
    const stats = disposer.stats;

    expect(stats.discovered).toBeGreaterThanOrEqual(1);
    expect(stats.resolved).toBeGreaterThanOrEqual(1);
    expect(stats.skipped).toBe(0);
    expect(tools.registeredTools.length).toBeGreaterThanOrEqual(1);
    expect(providers.size).toBeGreaterThanOrEqual(1);
    expect(stats.webRouteRegistered).toBe(false);

    // ...and the reported stats are identical to the seam-present boot: the
    // absent service adds no degradation marker and perturbs nothing.
    expect(stats).toEqual(baselineDisposer.stats);

    disposer();
    baselineDisposer();
  });
});

// ── Computer-use gate: registration ────────────────────────────────────────
//
// The family is OFF unless a surface explicitly enabled it, and a wildcard
// `enabledNamespaces` must never be the thing that turns it on. These boots pin
// both halves of that: with the gate off the seven names are absent even under
// `["*"]`, with the gate on (host option OR config file) they register, and a
// host without the `ctx.tools.guard` seam gets nothing at all (fail closed).

describe("dsh computer-use gate — registration", () => {
  /**
   * Boot under an ISOLATED global config directory, so a developer's own
   * `~/.config/rolebox/config.yaml` can never decide one of these outcomes.
   * The callback may write `config.yaml` into the returned directory to opt in.
   */
  async function withIsolatedConfigDir<T>(
    run: (configDir: string) => Promise<T>,
  ): Promise<T> {
    const prior = process.env.ROLEBOX_CONFIG_DIR;
    const configDir = mkdtempSync(join(tmpdir(), "rolebox-computer-use-config-"));
    process.env.ROLEBOX_CONFIG_DIR = configDir;
    try {
      return await run(configDir);
    } finally {
      if (prior === undefined) delete process.env.ROLEBOX_CONFIG_DIR;
      else process.env.ROLEBOX_CONFIG_DIR = prior;
      removeTempTree(configDir);
    }
  }

  it('registers no computer_* tool with the gate off, even under enabledNamespaces ["*"]', async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const { ctx, tools } = createFakeCtx();

    const disposer = await withIsolatedConfigDir(() =>
      applyTracked(ctx, {
        roleboxDir: tmpDir,
        enabledNamespaces: ["*"],
      } as DshPluginConfig),
    );
    const keys = tools.registeredTools.map((t) => t.name);

    // The wildcard still registers the rest of the surface — it simply cannot
    // enable screen control, which only the resolved gate can.
    expect(keys).toContain("hashline_read");
    expect(keys.filter((key) => key.startsWith("computer_"))).toEqual([]);

    disposer();
  });

  it("registers the family when the host option enables the gate", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const { ctx, tools } = createFakeCtx();

    const disposer = await withIsolatedConfigDir(() =>
      applyTracked(ctx, {
        roleboxDir: tmpDir,
        enabledNamespaces: ["*"],
        computerUse: true,
      } as DshPluginConfig),
    );
    const keys = tools.registeredTools.map((t) => t.name);

    expect(keys.filter((key) => key.startsWith("computer_")).sort()).toEqual(
      [...COMPUTER_TOOL_NAMES].sort(),
    );

    disposer();
  });

  it("registers the family when the global config.yaml enables the gate", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const { ctx, tools } = createFakeCtx();

    const disposer = await withIsolatedConfigDir(async (configDir) => {
      writeFileSync(join(configDir, "config.yaml"), "computerUse: true\nregistries: []\n", "utf-8");
      return applyTracked(ctx, {
        roleboxDir: tmpDir,
        enabledNamespaces: ["*"],
      } as DshPluginConfig);
    });
    const keys = tools.registeredTools.map((t) => t.name);

    expect(keys).toEqual(expect.arrayContaining([...COMPUTER_TOOL_NAMES]));

    disposer();
  });

  it("FAILS CLOSED — a host without ctx.tools.guard registers nothing", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const { ctx, tools } = createFakeCtx();
    // A host generation (or double) with no guard seam: the per-role grant
    // cannot be enforced, so an ungoverned screen-control surface is not
    // registered at all.
    Reflect.deleteProperty(ctx.tools, "guard");

    const disposer = await withIsolatedConfigDir(() =>
      applyTracked(ctx, {
        roleboxDir: tmpDir,
        enabledNamespaces: ["*"],
        computerUse: true,
      } as DshPluginConfig),
    );
    const keys = tools.registeredTools.map((t) => t.name);

    expect(keys.filter((key) => key.startsWith("computer_"))).toEqual([]);
    expect(keys).toContain("hashline_read");

    disposer();
  });
});

// ── Attachment seam probe ──────────────────────────────────────────────────
//
// The image-attachment service is an OPTIONAL host service (the harness mounts
// it only in a profile that has a durable attachment store), so the entry
// probes for it structurally — never through a host import — and hands it to
// the tool factory. An absent service must degrade to "no attachments", not
// fail the boot.

describe("dsh attachment seam probe", () => {
  const service: DshAttachmentService = {
    async saveImage() {
      return { attachmentId: "a1", mediaType: "image/png", bytes: 3, width: 1, height: 1 };
    },
  };

  /** Only the two fields probeAttachments reads; the rest of ctx is unused. */
  const ctxWith = (fields: Record<string, unknown>): DshPluginContext =>
    ({ get: () => undefined, ...fields }) as unknown as DshPluginContext;

  it("resolves a mounted service from the ctx property", () => {
    expect(probeAttachments(ctxWith({ attachments: service }))).toBe(service);
  });

  it("falls back to the named-service resolver for both spellings", () => {
    const named = (id: string): DshPluginContext =>
      ({ get: (name: string) => (name === id ? service : undefined) }) as unknown as DshPluginContext;
    expect(probeAttachments(named("attachments"))).toBe(service);
    expect(probeAttachments(named("attachment"))).toBe(service);
  });

  it("answers absent for a missing or non-conforming service (never a throw)", () => {
    expect(probeAttachments(ctxWith({}))).toBeUndefined();
    expect(probeAttachments(ctxWith({ attachments: {} }))).toBeUndefined();
    expect(probeAttachments(ctxWith({ attachments: { saveImage: "nope" } }))).toBeUndefined();
    const throwing = {
      get() {
        throw new Error("cannot get property without inject");
      },
    } as unknown as DshPluginContext;
    expect(probeAttachments(throwing)).toBeUndefined();
  });
});

// ── Native dsh tool-presentation surface ───────────────────────────────────
//
// The dsh client renders a tool natively only when the compiled definition
// exposes `presentCall` / `presentResult` / `output.presentationMeta`
// (dsh packages/core/tools/src/index.ts:210, :271, :279). rolebox populates
// them for the tools it has truthful display data for; every other tool keeps
// dsh's generic fallback. Each projection is PURE — dsh may call it during live
// streaming AND on session-log replay — so calling one twice must deep-equal.

describe("dsh native tool-presentation surface", () => {
  function compiledRoleboxTools(): Record<string, DshToolDefinition> {
    const factory = new DshToolFactory();
    return factory.compileAll(
      buildCanonicalTools({
        resolvedRoles: [],
        directory: process.cwd(),
        capabilities: opencodeCapabilities(),
      }),
    ) as Record<string, DshToolDefinition>;
  }

  /**
   * The rolebox tools whose canonical ToolResult already carries display
   * metadata (`title`/`metadata`) — they MUST render natively with the full
   * projection surface (`presentCall` + `presentResult` + `presentationMeta`).
   */
  const DISPLAY_METADATA_TOOLS = ["web_fetch", "interactive_terminal"] as const;

  it("exposes presentCall/presentResult/presentationMeta for tools carrying display metadata", () => {
    const compiled = compiledRoleboxTools();
    for (const name of DISPLAY_METADATA_TOOLS) {
      const def = compiled[name];
      expect(def, `tool ${name} was not compiled`).toBeDefined();
      expect(typeof def.presentCall, `${name}.presentCall`).toBe("function");
      expect(typeof def.presentResult, `${name}.presentResult`).toBe("function");
      expect(
        typeof def.output.presentationMeta,
        `${name}.output.presentationMeta`,
      ).toBe("function");
    }
  });

  it("emits exactly the declared optional members — no placeholder where rolebox has no data", () => {
    const compiled = compiledRoleboxTools();
    for (const [name, def] of Object.entries(compiled)) {
      const entry: DshToolPresentation | undefined = DSH_TOOL_PRESENTATION[name];
      expect(def.presentCall === undefined, `${name}.presentCall`).toBe(
        entry?.presentCall === undefined,
      );
      expect(def.presentResult === undefined, `${name}.presentResult`).toBe(
        entry?.presentResult === undefined,
      );
      expect(def.output.presentationMeta === undefined, `${name}.presentationMeta`).toBe(
        entry?.presentationMeta === undefined,
      );
      expect(def.isConcurrencySafe === undefined, `${name}.isConcurrencySafe`).toBe(
        entry?.isConcurrencySafe === undefined,
      );
      // `timeoutMs` is never emitted: rolebox has no truthful fixed budget.
      expect(def.timeoutMs, `${name}.timeoutMs`).toBeUndefined();
    }
    // The bundled/real tool set actually contains the display-metadata tools.
    expect(Object.keys(compiled)).toContain("web_fetch");
    expect(Object.keys(compiled)).toContain("interactive_terminal");
  });

  it("keeps every compiled projection pure and replay-safe (call each twice, deep-compare)", () => {
    const compiled = compiledRoleboxTools();

    // A representative args fixture per projection shape.
    const argFixtures: Record<string, unknown> = {
      hashline_read: { filePath: "src/x.ts", offset: 3, limit: 5 },
      web_search: { query: "dsh tools", max_results: 5 },
      web_read: { url: "https://example.com", engine: "default" },
      web_fetch: { url: "https://example.com", timeout: 30 },
      interactive_terminal: { action: "open", command: "bash", args: [] },
      asset_search: { query: "router" },
      reference_search: { query: "routing" },
    };
    const resultFixture: DshPresentResult = {
      content: [{ type: "text", text: "ok" }],
      isError: false,
      meta: { title: "done" },
    };
    const valueFixture = {
      title: "Fetched",
      output: "body",
      metadata: { author: "Jane" },
    };

    // Exercise the COMPILED definition's members (not just the registry) — the
    // exact surface the dsh client calls on live streaming and replay.
    let projectionsChecked = 0;
    for (const [name, def] of Object.entries(compiled)) {
      const args = argFixtures[name] ?? {};

      if (def.presentCall) {
        expect(def.presentCall(args), `${name}.presentCall`).toEqual(
          def.presentCall(args),
        );
        projectionsChecked++;
      }
      if (def.output.presentationMeta) {
        expect(
          def.output.presentationMeta(args, valueFixture),
          `${name}.presentationMeta`,
        ).toEqual(def.output.presentationMeta(args, valueFixture));
        projectionsChecked++;
      }
      if (def.presentResult) {
        expect(def.presentResult(args, resultFixture), `${name}.presentResult`).toEqual(
          def.presentResult(args, resultFixture),
        );
        projectionsChecked++;
      }
      if (def.isConcurrencySafe) {
        expect(def.isConcurrencySafe(args), `${name}.isConcurrencySafe`).toBe(
          def.isConcurrencySafe(args),
        );
        projectionsChecked++;
      }
    }
    // Guard against a vacuous pass (e.g. the surface disappearing wholesale).
    expect(projectionsChecked).toBeGreaterThanOrEqual(8);
  });

  it("projects the canonical result's display metadata through presentationMeta -> presentResult", () => {
    const compiled = compiledRoleboxTools();
    const def = compiled.web_fetch;
    const args = { url: "https://example.com" };
    const value = {
      title: "https://example.com (text/html)",
      output: "body",
      metadata: { author: "Jane" },
    };

    const meta = def.output.presentationMeta!(args, value);
    expect(meta).toEqual({
      title: "https://example.com (text/html)",
      metadata: { author: "Jane" },
    });

    const view = def.presentResult!(args, {
      content: [{ type: "text", text: "body" }],
      isError: false,
      meta,
    });
    expect(view).toEqual({
      card: "generic",
      title: "https://example.com (text/html)",
    });
  });

  it("declines honestly (undefined) when a projection has no truthful input", () => {
    const compiled = compiledRoleboxTools();

    // A non-URL fetch arg yields no pending card rather than a placeholder.
    expect(compiled.web_fetch.presentCall!({})).toBeUndefined();
    // A plain-string result carries no display metadata.
    expect(
      compiled.web_fetch.output.presentationMeta!({ url: "u" }, "plain text"),
    ).toBeUndefined();
    // Absent durable meta declines to dsh's generic fallback.
    expect(
      compiled.web_fetch.presentResult!(
        { url: "u" },
        { content: [], isError: false },
      ),
    ).toBeUndefined();
  });
});

// ── buildAgentPromptInjector — dsh delivery contract ───────────────────────
//
// The injector is the graph-notify delivery seam. These tests drive it
// directly and assert the dsh UserMessage shape (message.d.ts:120-133) with its
// producer-owned `rolebox` `notice` source (dsh V4 refuses the released shared
// `plugin` wrapper at encode and at decode), the per-message unique id (the
// inbox dedupes on message.id), and the delivery preference
// steer → followup → inject (runtime-types.d.ts:115/123/132).

describe("buildAgentPromptInjector (rc.6 delivery contract)", () => {
  it("(a) injects a well-formed UserMessage with a producer-owned rolebox notice source", async () => {
    const { agent, calls } = makeValidatingAgent("session-1");
    const injector = buildAgentPromptInjector(makeRegistry(agent));
    expect(injector).toBeDefined();

    const result = await injector!.inject(
      "session-1",
      "<system-reminder> node done",
    );

    expect(result).not.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("inject");

    const message = calls[0].message as {
      id: string;
      role: string;
      content: Array<{ type: string; text: string }>;
      source: { kind: string; form: string; summary: string };
    };
    expect(typeof message.id).toBe("string");
    expect(message.id.length).toBeGreaterThan(0);
    expect(message.role).toBe("user");
    expect(message.content).toEqual([
      { type: "text", text: "<system-reminder> node done" },
    ]);
    expect(message.source.kind).toBe("rolebox");
    expect(message.source.form).toBe("notice");
    expect(message.source.summary.length).toBeGreaterThan(0);
    expect(message.source.summary.length).toBeLessThanOrEqual(120);
    // dsh V4 refuses the released shared `plugin` wrapper at encode and at
    // decode, so the delivered source must not carry one.
    expect(Object.hasOwn(message.source, "plugin")).toBe(false);
  });

  it("(a2) bounds a notice summary to 120 chars (first line, ellipsized)", async () => {
    const { agent, calls } = makeValidatingAgent("session-1");
    const injector = buildAgentPromptInjector(makeRegistry(agent))!;

    const result = await injector.inject(
      "session-1",
      `${"R".repeat(200)}\nsecond line`,
    );

    expect(result).not.toBeNull();
    const source = (calls[0].message as { source: { summary: string } }).source;
    expect(source.summary.length).toBe(120);
    expect(source.summary.endsWith("…")).toBe(true);
    expect(source.summary.startsWith("R".repeat(119))).toBe(true);
  });

  it("(b) uses a distinct message id per inject and returns that id", async () => {
    const { agent, calls } = makeValidatingAgent("session-1");
    const injector = buildAgentPromptInjector(makeRegistry(agent))!;

    const first = await injector.inject("session-1", "reminder one");
    const second = await injector.inject("session-1", "reminder two");

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.id).not.toBe(second!.id);
    expect(calls).toHaveLength(2);
    expect((calls[0].message as { id: string }).id).toBe(first!.id);
    expect((calls[1].message as { id: string }).id).toBe(second!.id);
  });

  it("(c) prefers a waking member (steer) over inject", async () => {
    const { agent, calls } = makeValidatingAgent("session-1", {
      steer: true,
      inject: true,
    });
    const injector = buildAgentPromptInjector(makeRegistry(agent))!;

    const result = await injector.inject("session-1", "hello");

    expect(result).not.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("steer");
  });

  it("(c2) prefers followup over inject when steer is absent", async () => {
    const { agent, calls } = makeValidatingAgent("session-1", {
      followup: true,
      inject: true,
    });
    const injector = buildAgentPromptInjector(makeRegistry(agent))!;

    await injector.inject("session-1", "hello");

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("followup");
  });

  it("(d) degrades to inject when no waking member is exposed", async () => {
    const { agent, calls } = makeValidatingAgent("session-1", { inject: true });
    const injector = buildAgentPromptInjector(makeRegistry(agent))!;

    const result = await injector.inject("session-1", "hello");

    expect(result).not.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("inject");
  });

  it("(e) resolves null when the agent exposes no delivery member", async () => {
    const { agent, calls } = makeValidatingAgent("session-1", {});
    const injector = buildAgentPromptInjector(makeRegistry(agent))!;

    expect(await injector.inject("session-1", "hello")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("(e2) resolves null when the registry is absent or the session has no agent", async () => {
    expect(buildAgentPromptInjector(undefined)).toBeUndefined();
    const missing = buildAgentPromptInjector({ get: () => undefined })!;
    expect(await missing.inject("session-1", "hello")).toBeNull();
  });

  it("(e3) resolves null when delivery throws or rejects", async () => {
    const throwing = buildAgentPromptInjector(
      makeRegistry({
        id: "session-1",
        inject() {
          throw new Error("inbox rejected");
        },
      }),
    )!;
    expect(await throwing.inject("session-1", "hello")).toBeNull();

    const rejecting = buildAgentPromptInjector(
      makeRegistry({
        id: "session-1",
        async steer() {
          throw new Error("driver disposed");
        },
      }),
    )!;
    expect(await rejecting.inject("session-1", "hello")).toBeNull();
  });

  it("(f) honors noReply:true by using the non-waking inject member even when steer is available", async () => {
    const { agent, calls } = makeValidatingAgent("session-1", {
      steer: true,
      followup: true,
      inject: true,
    });
    const injector = buildAgentPromptInjector(makeRegistry(agent))!;

    const result = await injector.inject("session-1", "silent", { noReply: true });

    expect(result).not.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("inject");
  });

  it("(f2) noReply:true degrades to null when only waking members exist (never wakes silently)", async () => {
    const { agent, calls } = makeValidatingAgent("session-1", {
      steer: true,
      followup: true,
    });
    const injector = buildAgentPromptInjector(makeRegistry(agent))!;

    expect(await injector.inject("session-1", "silent", { noReply: true })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("(g) honors noReply:false by preferring a waking member (steer)", async () => {
    const { agent, calls } = makeValidatingAgent("session-1", {
      steer: true,
      inject: true,
    });
    const injector = buildAgentPromptInjector(makeRegistry(agent))!;

    await injector.inject("session-1", "wake", { noReply: false });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("steer");
  });

  it("(g2) noReply:false falls back to followup when steer is absent", async () => {
    const { agent, calls } = makeValidatingAgent("session-1", {
      followup: true,
      inject: true,
    });
    const injector = buildAgentPromptInjector(makeRegistry(agent))!;

    await injector.inject("session-1", "wake", { noReply: false });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("followup");
  });

  it("(g3) noReply:false degrades to null when no waking member exists (never silently no-wakes)", async () => {
    const { agent, calls } = makeValidatingAgent("session-1", { inject: true });
    const injector = buildAgentPromptInjector(makeRegistry(agent))!;

    expect(await injector.inject("session-1", "wake", { noReply: false })).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

// ── event-bridge: previously-dropped dsh session-log vocabulary ────────────
//
// Subtask 6 of the dsh 0.1.5-rc.1 compatibility plan. dsh's session log grew
// event types rolebox previously resolved to "unknown" (and therefore
// dropped); each is mapped onto a canonical kind that already exists in the
// bridge (`CanonicalEventType`, src/platform/types.ts) — no new vocabulary is
// introduced. One assertion per new mapping.

describe("dsh event-bridge — session-log vocabulary", () => {
  it("maps the previously-dropped session-log events to existing canonical kinds", () => {
    // Lifecycle state transitions → session.status
    expect(mapDshEventType("approval/asked")).toBe("session.status");
    expect(mapDshEventType("approval/decided")).toBe("session.status");
    expect(mapDshEventType("compaction/start")).toBe("session.status");
    expect(mapDshEventType("compaction/end")).toBe("session.status");

    // Paired hook invocation lifecycle → part.created / part.updated
    expect(mapDshEventType("hook/invoked")).toBe("part.created");
    expect(mapDshEventType("hook/result")).toBe("part.updated");

    // Nested PTC sub-dispatch lifecycle → part.created / part.updated
    expect(mapDshEventType("tool/ptc-dispatch-start")).toBe("part.created");
    expect(mapDshEventType("tool/ptc-dispatch")).toBe("part.updated");

    // Log-only state / snapshot / mode / catalog records → session.updated
    expect(mapDshEventType("permission/preset")).toBe("session.updated");
    expect(mapDshEventType("compaction/summary")).toBe("session.updated");
    expect(mapDshEventType("plan/mode")).toBe("session.updated");
    expect(mapDshEventType("subagent/catalog")).toBe("session.updated");
    expect(mapDshEventType("subagent/descriptor")).toBe("session.updated");

    // `skills/change` service event → catalog-invalidation notification
    expect(mapDshEventType("skills/change")).toBe("session.updated");
  });

  it("subscribes to the skills/change catalog-invalidation service event", () => {
    const { ctx, listeners } = createFakeCtx();
    const bridge = new DshEventBridge(ctx);
    expect(listeners.has("skills/change")).toBe(true);
    bridge.dispose();
    expect(listeners.get("skills/change") ?? []).toHaveLength(0);
  });
});

// ── Bundle patch files parse as YAML ───────────────────────────────────────

describe("dsh bundle patch files", () => {
  const BUNDLE_PATCH = resolve(import.meta.dir, "../dsh/cordis.patch.yml");
  const EXAMPLE_PATCH = resolve(import.meta.dir, "../examples/dsh/cordis.patch.yml");

  it("the shipped bundle patch (dsh/cordis.patch.yml) parses as a YAML entry list", () => {
    const doc = load(readFileSync(BUNDLE_PATCH, "utf-8"));
    expect(Array.isArray(doc)).toBe(true);
    const entries = doc as unknown[];
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const first = entries[0] as { insert?: Array<{ id?: string; name?: string }> };
    expect(first.insert?.[0]?.id).toBe("rolebox");
    expect(first.insert?.[0]?.name).toBe("../dist/entries/dsh.js");
  });

  it("the configured example (examples/dsh/cordis.patch.yml) parses as a YAML entry list", () => {
    const doc = load(readFileSync(EXAMPLE_PATCH, "utf-8"));
    expect(Array.isArray(doc)).toBe(true);
    const entries = doc as unknown[];
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const insert = (entries[0] as { insert?: Array<{ id?: string; name?: string; config?: unknown }> })
      .insert?.[0];
    expect(insert?.id).toBe("rolebox");
    expect(insert?.name).toBe("./node_modules/rolebox/dist/entries/dsh.js");
    // Every Config option from the README table is representable.
    const config = insert?.config as Record<string, unknown> | undefined;
    expect(typeof config?.roleboxDir).toBe("string");
    expect(typeof config?.skillsDir).toBe("string");
    expect(typeof config?.defaultRole).toBe("string");
    expect(Array.isArray(config?.enabledNamespaces)).toBe(true);
  });
});

// ── Import hygiene ─────────────────────────────────────────────────────────

describe("dsh-plugin import hygiene", () => {
  const FILE = resolve(import.meta.dir, "../src/entries/dsh.ts");

  function extractImportSpecifiers(source: string): string[] {
    const importRe =
      /import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+["']([^"']+)["']/g;
    const specifiers: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = importRe.exec(source)) !== null) {
      specifiers.push(match[1]);
    }
    return specifiers;
  }

  it("contains no @opencode-ai or @deepseek-ai imports", () => {
    const specifiers = extractImportSpecifiers(readFileSync(FILE, "utf-8"));
    const forbidden = specifiers.filter(
      (s) => s.includes("@opencode-ai/") || s.includes("@deepseek-ai/"),
    );
    expect(forbidden, `${FILE} imports platform SDK packages`).toEqual([]);
  });
});
