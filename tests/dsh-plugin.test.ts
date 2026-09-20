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
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { shortHash } from "../src/utils/state-paths.ts";
import { ActiveRoleStore } from "../src/platform/adapters/dsh/active-role-store.ts";
import { DshEventBridge, mapDshEventType } from "../src/platform/adapters/dsh/event-bridge.ts";
import { apply, name, inject, Config, buildAgentPromptInjector } from "../src/entries/dsh.ts";
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
import type {
  DshSkillProviderControl,
  DshSkillProviderLike,
} from "../src/platform/adapters/dsh/skill-provider.ts";

// ── Validating fake live-agent registry ────────────────────────────────────
//
// graph-notify delivery now sends a full rc.6 UserMessage (message.d.ts:120-133)
// with a plugin `notice` source (message.d.ts:98-101, 81-84) whose summary is
// bounded to 120 chars (message.js:15-19). The fakes below VALIDATE that shape
// instead of accepting anything, so a regression to a malformed message fails
// the test rather than silently passing.

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
  if (source.kind === "plugin" && source.form === "notice") {
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

  const tools = {
    registeredTools,
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

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "rolebox-dsh-plugin-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
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

    const disposer = await apply(ctx, { roleboxDir: tmpDir } as DshPluginConfig);
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
    const disposerWith = await apply(
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
    const disposerWithout = await apply(
      ctxNoAgents,
      { roleboxDir: tmpDir } as DshPluginConfig,
    );
    expect(disposerWithout.stats.graphNotifyWired).toBe(false);
    disposerWithout();
  });

  it("wires a parentResolver over ctx.agents so dispatch forwards a live parent", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);

    // A REAL invoking session id — the canonical `sessionID` resolved from the
    // exec's live agent/session (tool-factory.ts:518). The live parent is
    // resolved from THIS id, never the graph-scoped budget key or the callId.
    const INVOKING_SESSION = "plugin-invoking-session";

    // Live-agent registry double (the `ctx.agents` seam): records the session
    // ids the adapter resolves and returns a sentinel live Agent.
    const parent = { id: "live-parent", inject: () => undefined };
    const requested: string[] = [];
    const agents = {
      get(id: string) {
        requested.push(id);
        return parent;
      },
    };
    const { ctx, tools, started } = createFakeCtx({ agents });

    // The plugin captures process.cwd() for the graph stateDir; isolate it.
    const cwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const disposer = await apply(ctx, { roleboxDir: tmpDir } as DshPluginConfig);
      const byName = new Map(tools.registeredTools.map((t) => [t.name, t]));
      // Carry a live agent + session (the shape the real harness passes) so
      // `toCanonicalContext` resolves the canonical `sessionID` from the
      // session — NOT the `callId` fallback (tool-factory.ts:518).
      const exec = {
        signal: new AbortController().signal,
        callId: "plugin-call-1",
        deferContext: () => {},
        concludeTurn: () => {},
        agent: {
          id: INVOKING_SESSION,
          session: { id: INVOKING_SESSION, header: { cwd: process.cwd() } },
        },
      };

      // graph_create returns the dsh JSON-object envelope (the structured
      // run_code ergonomics this fix delivers); read graph_id directly.
      const created = (await byName
        .get("graph_create")!
        .execute({ name: "parent-graph" }, exec)) as { graph_id: string };
      await byName.get("graph_add_node")!.execute(
        { graph_id: created.graph_id, id: "N1", agent: "tester", prompt: "p" },
        exec,
      );
      await byName.get("graph_run")!.execute({ graph_id: created.graph_id }, exec);

      // The constructed DshDispatchAdapter resolved the live parent from
      // ctx.agents keyed by the REAL invoking session (not the graph-scoped
      // budget key) and forwarded the SAME live Agent reference — never
      // `undefined`.
      expect(started).toHaveLength(1);
      expect(started[0].request.parent).toBe(parent);
      expect(requested).toContain(INVOKING_SESSION);
      expect(requested).not.toContain(created.graph_id);

      disposer();
    } finally {
      process.chdir(cwd);
    }
  });

  it("registers every assembled tool when enabledNamespaces is absent", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const { ctx, tools } = createFakeCtx();

    const disposer = await apply(ctx, { roleboxDir: tmpDir } as DshPluginConfig);
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

    const disposer = await apply(ctx, {
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

  it("applies defaultRole promotion to the resolved roles", async () => {
    writeRoleYaml("alpha", SIMPLE_ROLE.replace("Test Role", "Alpha"));
    writeRoleYaml("beta", SIMPLE_ROLE.replace("Test Role", "Beta"));
    const { ctx } = createFakeCtx();

    const disposer = await apply(ctx, { roleboxDir: tmpDir, defaultRole: "beta" } as DshPluginConfig);
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

    const disposer = await apply(ctx, {
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

    const disposer = await apply(ctx, {
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

    const disposer = await apply(ctx, {
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

    const disposer = await apply(ctx, {
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

    const disposer = await apply(ctx, { roleboxDir: tmpDir } as DshPluginConfig);
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

    const disposer = await apply(ctx, { roleboxDir: tmpDir } as DshPluginConfig);

    // The seam registered the COMPOSED /rolebox prefix route exactly once:
    // the real host webserver rejects duplicate (kind, path) registrations
    // (`webserver: duplicate prefix route "/rolebox"`, lib/index.js:54-55),
    // so the role-switch surface and the monitor surface share one handler.
    expect(disposer.stats.webRouteRegistered).toBe(true);
    expect(disposer.stats.monitorRouteRegistered).toBe(true);
    expect(registered).toHaveLength(1);
    const route = registered[0];
    expect(route.kind).toBe("prefix");
    expect(route.path).toBe("/rolebox");
    expect(typeof route.handler).toBe("function");

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

    // The fiber disposer unmounts the route.
    disposer();
    expect(registered).toHaveLength(0);
  });

  it("registers the /rolebox prefix exactly once when the host rejects duplicate prefixes", async () => {
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

    const disposer = await apply(ctx, { roleboxDir: tmpDir } as DshPluginConfig);

    // Exactly ONE registration under /rolebox — no duplicate was attempted
    // and nothing was swallowed: BOTH route surfaces report registered, and
    // the single composed handler serves the role-switch AND monitor faces.
    expect(registered).toHaveLength(1);
    expect(registered[0].kind).toBe("prefix");
    expect(registered[0].path).toBe("/rolebox");
    expect(disposer.stats.webRouteRegistered).toBe(true);
    expect(disposer.stats.monitorRouteRegistered).toBe(true);

    const roles = await invoke(registered[0].handler, "GET", "/rolebox/roles");
    expect(roles.status).toBe(200);
    expect(Array.isArray(JSON.parse(roles.text))).toBe(true);
    const status = await invoke(registered[0].handler, "GET", "/rolebox/status");
    expect(status.status).toBe(200);
    const metrics = await invoke(registered[0].handler, "GET", "/rolebox/metrics");
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

      const disposer = await apply(ctx, { roleboxDir: tmpDir } as DshPluginConfig);
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
      // The resolved prompt carries the role's <available_skills> block after
      // its own text, so assert the prompt prefix.
      expect(
        sections[0].text({ agent: { id: "s1" }, sessionID: "s1" }),
      ).toStartWith("You are a reloaded role.");

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
      const disposer = await apply(ctx, {
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

    const disposer = await apply(ctx, { roleboxDir: tmpDir } as DshPluginConfig);
    expect(disposer.stats.webRouteRegistered).toBe(false);
    expect(disposer.stats.monitorRouteRegistered).toBe(false);

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

      const disposer = await apply(ctx, { roleboxDir: tmpDir } as DshPluginConfig);
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
      ).toBe("You are a test role.");

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
      const disposer = await apply(ctx, { roleboxDir: tmpDir } as DshPluginConfig);

      // Read side: the hydrated selection is live — the prompt section
      // resolves the active role seeded in the workspace sidecar.
      expect(
        sections[0].text({ agent: { id: "s1" }, sessionID: "s1" }),
      ).toBe("You are a test role.");

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
      const disposer = await apply(ctx, { roleboxDir: tmpDir } as DshPluginConfig);

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
    const baselineDisposer = await apply(withPrompt.ctx, {
      roleboxDir: tmpDir,
    } as DshPluginConfig);

    // No systemPrompt double (the default fake — headless profile): apply()
    // must not throw, must still resolve roles + register tools/agents...
    const { ctx, tools, providers } = createFakeCtx();
    const disposer = await apply(ctx, { roleboxDir: tmpDir } as DshPluginConfig);
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

// ── buildAgentPromptInjector — rc.6 delivery contract ──────────────────────
//
// The injector is the graph-notify delivery seam. These tests drive it
// directly and assert the rc.6 UserMessage shape (message.d.ts:120-133), the
// per-message unique id (the inbox dedupes on message.id), and the delivery
// preference steer → followup → inject (runtime-types.d.ts:115/123/132).

describe("buildAgentPromptInjector (rc.6 delivery contract)", () => {
  it("(a) injects a well-formed rc.6 UserMessage with a plugin notice source", async () => {
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
      source: { kind: string; plugin: string; form: string; summary: string };
    };
    expect(typeof message.id).toBe("string");
    expect(message.id.length).toBeGreaterThan(0);
    expect(message.role).toBe("user");
    expect(message.content).toEqual([
      { type: "text", text: "<system-reminder> node done" },
    ]);
    expect(message.source.kind).toBe("plugin");
    expect(message.source.plugin).toBe("rolebox");
    expect(message.source.form).toBe("notice");
    expect(message.source.summary.length).toBeGreaterThan(0);
    expect(message.source.summary.length).toBeLessThanOrEqual(120);
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
