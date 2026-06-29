import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir as osTmpdir } from "node:os";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { createPluginHooks, managerMap, pendingCorrections, userMessagedSessions, autoActivatedSessions, roleAutoActivateMap, roleLockedMap } from "../src/plugin-hooks";
import { functionSessionState } from "../src/session-state";
import { functionRuntime } from "../src/function/runtime-state";
import { graphSessionState } from "../src/graph/state";
import type { ResolvedRole, ResolvedFunction } from "../src/types";
import { RoleMode } from "../src/constants";

// ── helpers ──────────────────────────────────────────────────────

function createMockClient(): OpencodeClient {
  return {
    session: {
      create: mock(() =>
        Promise.resolve({ data: { id: "test-session-1" }, error: undefined }),
      ),
      prompt: mock(() =>
        Promise.resolve({ data: { parts: [{ type: "text", text: "ok" }] }, error: undefined }),
      ),
      promptAsync: mock(() =>
        Promise.resolve({ data: undefined, error: undefined }),
      ),
      messages: mock(() =>
        Promise.resolve({ data: [], error: undefined }),
      ),
      status: mock(() =>
        Promise.resolve({ data: {}, error: undefined }),
      ),
      abort: mock(() =>
        Promise.resolve({ data: undefined, error: undefined }),
      ),
      get: mock(() =>
        Promise.resolve({ data: { id: "test-session-1" }, error: undefined }),
      ),
    },
  } as unknown as OpencodeClient;
}

function makePrimaryRole(overrides?: Partial<ResolvedRole>): ResolvedRole {
  return {
    id: "test-primary",
    config: {
      name: "Test Primary",
      description: "Primary test role",
      prompt: "You are a test primary.",
      mode: RoleMode.Primary,
      ...overrides?.config,
    },
    prompt: "You are a test primary.",
    skills: [],
    functions: [],
    references: [],
    subagents: [],
    ...overrides,
  };
}

function makeFn(overrides: Partial<ResolvedFunction> = {}): ResolvedFunction {
  return {
    name: "testFn",
    description: "test function",
    content: "# test\n",
    filePath: "/tmp/fake/testFn.md",
    source: "role-local",
    ...overrides,
  };
}

// ── cleanup between tests ────────────────────────────────────────

beforeEach(() => {
  managerMap.clear();
  pendingCorrections.clear();
  userMessagedSessions.clear();
  autoActivatedSessions.clear();
  roleAutoActivateMap.clear();
  roleLockedMap.clear();
  functionSessionState.clear("test-sid");
  functionSessionState.clear("test-sid-2");
  functionSessionState.clear("test-sid-auto");
  functionRuntime.clearSession("test-sid");
  functionRuntime.clearSession("test-sid-2");
  functionRuntime.clearSession("test-sid-auto");
  graphSessionState.clear("test-sid");
  graphSessionState.clear("test-sid-2");
  graphSessionState.clear("test-sid-auto");
});

afterEach(() => {
  mock.restore();
});

// ── 1. auto-activate on first message ────────────────────────────

describe("auto-activate on first message", () => {
  it("auto-activated function appears in session state after chat.message with no |name| syntax", async () => {
    const tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-aa-"));
    try {
      const client = createMockClient();
      const roleFunctionsMap = new Map<string, ResolvedFunction[]>();

      const triageFn = makeFn({ name: "triage", description: "triages messages" });
      roleFunctionsMap.set("test-primary", [triageFn]);

      const primary = makePrimaryRole({
        config: {
          name: "Test Primary",
          description: "Primary test role",
          prompt: "You are a test primary.",
          mode: RoleMode.Primary,
          auto_activate: ["triage"],
        } as any,
        auto_activate: ["triage"],
      });

      const hooks = await createPluginHooks(
        [primary],
        client,
        roleFunctionsMap,
        new Map(),
        tmpDir,
      );

      const output = {
        parts: [{ type: "text", text: "hello world" }],
      };
      await hooks["chat.message"](
        { agent: "test-primary", sessionID: "test-sid-auto" },
        output,
      );

      const active = functionSessionState.getActive("test-sid-auto");
      expect(active.has("triage")).toBe(true);
      expect(active.size).toBe(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("auto-activate happens only once per session (second message does not re-activate)", async () => {
    const tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-aa2-"));
    try {
      const client = createMockClient();
      const roleFunctionsMap = new Map<string, ResolvedFunction[]>();

      const triageFn = makeFn({ name: "triage", description: "triages messages" });
      const planFn = makeFn({ name: "plan", description: "planning function" });
      roleFunctionsMap.set("test-primary", [triageFn, planFn]);

      const primary = makePrimaryRole({
        config: {
          name: "Test Primary",
          description: "Primary test role",
          prompt: "You are a test primary.",
          mode: RoleMode.Primary,
          auto_activate: ["triage"],
        } as any,
        auto_activate: ["triage"],
      });

      const hooks = await createPluginHooks(
        [primary],
        client,
        roleFunctionsMap,
        new Map(),
        tmpDir,
      );

      // First message
      await hooks["chat.message"](
        { agent: "test-primary", sessionID: "test-sid-auto" },
        { parts: [{ type: "text", text: "first message" }] },
      );
      expect(functionSessionState.getActive("test-sid-auto").has("triage")).toBe(true);

      // Second message — auto_activate guard prevents re-auto-activation,
      // but |plan| at start of message activates it
      await hooks["chat.message"](
        { agent: "test-primary", sessionID: "test-sid-auto" },
        { parts: [{ type: "text", text: "|plan| do something" }] },
      );
      const active2 = functionSessionState.getActive("test-sid-auto");
      expect(active2.has("triage")).toBe(true);
      expect(active2.has("plan")).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("no auto-activation when role has no auto_activate config", async () => {
    const tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-aa3-"));
    try {
      const client = createMockClient();
      const roleFunctionsMap = new Map<string, ResolvedFunction[]>();

      const triageFn = makeFn({ name: "triage", description: "triages messages" });
      roleFunctionsMap.set("test-primary", [triageFn]);

      const primary = makePrimaryRole();

      const hooks = await createPluginHooks(
        [primary],
        client,
        roleFunctionsMap,
        new Map(),
        tmpDir,
      );

      await hooks["chat.message"](
        { agent: "test-primary", sessionID: "test-sid-auto" },
        { parts: [{ type: "text", text: "hello" }] },
      );

      const active = functionSessionState.getActive("test-sid-auto");
      expect(active.has("triage")).toBe(false);
      expect(active.size).toBe(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── 2. on:message inject dispatch ───────────────────────────────

describe("on:message inject dispatch", () => {
  it("message observe injects flow to pendingCorrections after auto-activation", async () => {
    const tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-msg-"));
    try {
      const client = createMockClient();
      const roleFunctionsMap = new Map<string, ResolvedFunction[]>();

      const classifierFn = makeFn({
        name: "classifier",
        description: "classifies messages",
        observe: [{ on: "message", inject: "classify: DIRECT|chancellor" }],
      });
      roleFunctionsMap.set("test-primary", [classifierFn]);

      const primary = makePrimaryRole({
        config: {
          name: "Test Primary",
          description: "Primary test role",
          prompt: "You are a test primary.",
          mode: RoleMode.Primary,
          auto_activate: ["classifier"],
        } as any,
        auto_activate: ["classifier"],
      });

      const hooks = await createPluginHooks(
        [primary],
        client,
        roleFunctionsMap,
        new Map(),
        tmpDir,
      );

      await hooks["chat.message"](
        { agent: "test-primary", sessionID: "test-sid" },
        { parts: [{ type: "text", text: "hello world" }] },
      );

      const correction = pendingCorrections.get("test-sid");
      expect(correction).toBeDefined();
      expect(correction).toContain("classify: DIRECT|chancellor");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("message observe inject does NOT fire for [auto-continue messages", async () => {
    const tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-ac-"));
    try {
      const client = createMockClient();
      const roleFunctionsMap = new Map<string, ResolvedFunction[]>();

      const classifierFn = makeFn({
        name: "classifier",
        description: "classifies messages",
        observe: [{ on: "message", inject: "SHOULD_NOT_APPEAR" }],
      });
      roleFunctionsMap.set("test-primary", [classifierFn]);

      const primary = makePrimaryRole({
        config: {
          name: "Test Primary",
          description: "Primary test role",
          prompt: "You are a test primary.",
          mode: RoleMode.Primary,
          auto_activate: ["classifier"],
        } as any,
        auto_activate: ["classifier"],
      });

      const hooks = await createPluginHooks(
        [primary],
        client,
        roleFunctionsMap,
        new Map(),
        tmpDir,
      );

      await hooks["chat.message"](
        { agent: "test-primary", sessionID: "test-sid" },
        { parts: [{ type: "text", text: "[auto-continue] keep working" }] },
      );

      const correction = pendingCorrections.get("test-sid");
      // On:message inject skipped for auto-continue — correction should be undefined or not contain the inject
      expect(correction ?? "").not.toContain("SHOULD_NOT_APPEAR");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("message observe collects injects from multiple active functions", async () => {
    const tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-multi-"));
    try {
      const client = createMockClient();
      const roleFunctionsMap = new Map<string, ResolvedFunction[]>();

      const fn1 = makeFn({
        name: "fn1",
        observe: [{ on: "message", inject: "inject-1" }],
      });
      const fn2 = makeFn({
        name: "fn2",
        observe: [{ on: "message", inject: "inject-2" }],
      });
      roleFunctionsMap.set("test-primary", [fn1, fn2]);

      const primary = makePrimaryRole({
        config: {
          name: "Test Primary",
          description: "Primary test role",
          prompt: "You are a test primary.",
          mode: RoleMode.Primary,
          auto_activate: ["fn1", "fn2"],
        } as any,
        auto_activate: ["fn1", "fn2"],
      });

      const hooks = await createPluginHooks(
        [primary],
        client,
        roleFunctionsMap,
        new Map(),
        tmpDir,
      );

      await hooks["chat.message"](
        { agent: "test-primary", sessionID: "test-sid" },
        { parts: [{ type: "text", text: "hello multi" }] },
      );

      const correction = pendingCorrections.get("test-sid") ?? "";
      expect(correction).toContain("inject-1");
      expect(correction).toContain("inject-2");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── 3. on:activate inject dispatch ──────────────────────────────

describe("on:activate inject dispatch", () => {
  it("activate observe injects flow to pendingCorrections on auto-activation", async () => {
    const tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-act-"));
    try {
      const client = createMockClient();
      const roleFunctionsMap = new Map<string, ResolvedFunction[]>();

      const greeterFn = makeFn({
        name: "greeter",
        description: "greets on activate",
        observe: [{ on: "activate", inject: "welcome to the session" }],
      });
      roleFunctionsMap.set("test-primary", [greeterFn]);

      const primary = makePrimaryRole({
        config: {
          name: "Test Primary",
          description: "Primary test role",
          prompt: "You are a test primary.",
          mode: RoleMode.Primary,
          auto_activate: ["greeter"],
        } as any,
        auto_activate: ["greeter"],
      });

      const hooks = await createPluginHooks(
        [primary],
        client,
        roleFunctionsMap,
        new Map(),
        tmpDir,
      );

      await hooks["chat.message"](
        { agent: "test-primary", sessionID: "test-sid" },
        { parts: [{ type: "text", text: "hello" }] },
      );

      const correction = pendingCorrections.get("test-sid");
      expect(correction).toBeDefined();
      expect(correction).toContain("welcome to the session");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("activate + message injects both appear in pendingCorrections", async () => {
    const tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-both-"));
    try {
      const client = createMockClient();
      const roleFunctionsMap = new Map<string, ResolvedFunction[]>();

      const fn = makeFn({
        name: "both",
        description: "has both activate and message observes",
        observe: [
          { on: "activate", inject: "activated:both" },
          { on: "message", inject: "messaged:both" },
        ],
      });
      roleFunctionsMap.set("test-primary", [fn]);

      const primary = makePrimaryRole({
        config: {
          name: "Test Primary",
          description: "Primary test role",
          prompt: "You are a test primary.",
          mode: RoleMode.Primary,
          auto_activate: ["both"],
        } as any,
        auto_activate: ["both"],
      });

      const hooks = await createPluginHooks(
        [primary],
        client,
        roleFunctionsMap,
        new Map(),
        tmpDir,
      );

      await hooks["chat.message"](
        { agent: "test-primary", sessionID: "test-sid" },
        { parts: [{ type: "text", text: "hello" }] },
      );

      const correction = pendingCorrections.get("test-sid") ?? "";
      expect(correction).toContain("activated:both");
      expect(correction).toContain("messaged:both");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── 4. locked protection ────────────────────────────────────────

describe("locked protection", () => {
  it("locked auto-activated function resists deactivation", async () => {
    const tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-lock-"));
    try {
      const client = createMockClient();
      const roleFunctionsMap = new Map<string, ResolvedFunction[]>();

      const triageFn = makeFn({ name: "triage", description: "triages everything" });
      roleFunctionsMap.set("test-primary", [triageFn]);

      const primary = makePrimaryRole({
        config: {
          name: "Test Primary",
          description: "Primary test role",
          prompt: "You are a test primary.",
          mode: RoleMode.Primary,
          auto_activate: ["triage"],
          locked: true,
        } as any,
        auto_activate: ["triage"],
        locked: true,
      });

      const hooks = await createPluginHooks(
        [primary],
        client,
        roleFunctionsMap,
        new Map(),
        tmpDir,
      );

      await hooks["chat.message"](
        { agent: "test-primary", sessionID: "test-sid" },
        { parts: [{ type: "text", text: "hello" }] },
      );

      expect(functionSessionState.isActive("test-sid", "triage")).toBe(true);

      // Attempt deactivation — should be blocked by locked guard
      functionSessionState.deactivate("test-sid", "triage");
      expect(functionSessionState.isActive("test-sid", "triage")).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("non-locked function can be deactivated normally", async () => {
    const tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-nolock-"));
    try {
      const client = createMockClient();
      const roleFunctionsMap = new Map<string, ResolvedFunction[]>();

      const planFn = makeFn({ name: "plan", description: "planning function" });
      roleFunctionsMap.set("test-primary", [planFn]);

      const primary = makePrimaryRole({
        config: {
          name: "Test Primary",
          description: "Primary test role",
          prompt: "You are a test primary.",
          mode: RoleMode.Primary,
          auto_activate: ["plan"],
        } as any,
        auto_activate: ["plan"],
      });

      const hooks = await createPluginHooks(
        [primary],
        client,
        roleFunctionsMap,
        new Map(),
        tmpDir,
      );

      await hooks["chat.message"](
        { agent: "test-primary", sessionID: "test-sid" },
        { parts: [{ type: "text", text: "hello" }] },
      );

      expect(functionSessionState.isActive("test-sid", "plan")).toBe(true);

      functionSessionState.deactivate("test-sid", "plan");
      expect(functionSessionState.isActive("test-sid", "plan")).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
