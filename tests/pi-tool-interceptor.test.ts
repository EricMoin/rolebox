/**
 * Pi tool-execution interceptor tests (subtask S9).
 *
 * Verifies `src/platform/adapters/pi/tool-interceptor.ts` + its wiring in
 * `PiToolFactory` / `PiLightweightServiceStack`:
 *
 *   1. A wrapped tool whose invocation carries an unknown parameter returns
 *      an error string containing the unknown key and the valid parameter
 *      list — the canonical def is never invoked, and nothing throws into Pi.
 *   2. A deprecated registered tool logs a warning on invocation.
 *      - direct path: `registerDeprecatedTool(...)` then invoke
 *      - stack path: `def.deprecated` in the canonical def is registered by
 *        `PiLightweightServiceStack.init()` (mirroring tool-service.ts)
 *   3. A custom hook's `before` phase (S6 CustomHookRegistry) receives the
 *      tool call `{ tool, args }` with the session id.
 *   4. Validation failures are injected into the session's
 *      pendingCorrections so the next system transform surfaces them.
 *   5. Valid invocations pass zod-normalized args through and return the
 *      canonical result in Pi's `{ content, details }` format.
 *
 * @module
 */

import { describe, it, expect, mock, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import type { ILogObj } from "tslog";
import type { HookDeps } from "../src/hooks/deps.ts";
import type { ResolvedRole } from "../src/types.ts";
import { getRootLogger } from "../src/logger.ts";

// ── Log capture: attach the root transport BEFORE any src module is
//    imported. tslog sub-loggers (e.g. "hook-tool-before", created at module
//    load) only inherit transports attached at their creation time, so the
//    src modules below are imported dynamically — after this attach. ──────

const logEntries: ILogObj[] = [];
getRootLogger().attachTransport((logObj) => {
  logEntries.push(logObj);
});

// ── Lazy src module refs (dynamic imports — see note above) ────────────────

const {
  PiToolFactory,
} = await import("../src/platform/adapters/pi/tool-factory.ts");
const {
  PiLightweightServiceStack,
} = await import("../src/platform/adapters/pi/service-stack.ts");
const { defineTool } = await import("../src/platform/ports/tool-factory.ts");
const { createHashlineReadTool } = await import("../src/hashline/hashline-read.ts");
const {
  registerToolSchema,
  registerDeprecatedTool,
} = await import("../src/hooks/tool-before.ts");
const { HookState } = await import("../src/hooks/state.ts");
const { CustomHookRegistry } = await import("../src/hooks/custom/registry.ts");

// ── Fixtures / helpers ──────────────────────────────────────────────────────

/** Minimal HookDeps — customHooks is the only surface the interceptor uses. */
function minimalDeps(overrides?: Partial<HookDeps>): HookDeps {
  return {
    session: {} as any,
    roleFunctionsMap: new Map(),
    roleGraphMap: new Map(),
    roleMap: new Map(),
    dir: "/tmp/test",
    dispatchManager: {} as any,
    loopManager: {} as any,
    customHooks: { runHooks: mock(() => Promise.resolve()) } as any,
    ...overrides,
  };
}

/** Compile a single named def with the factory, optionally with hook wiring. */
function compileTool(
  name: string,
  def: any,
  hooks?: { state?: InstanceType<typeof HookState>; deps?: HookDeps },
): any {
  const factory = new PiToolFactory(hooks);
  return factory.compileAll({ [name]: def })[name];
}

/** Invoke a Pi-compiled tool with the standard 5-arg execute signature. */
async function invoke(
  tool: any,
  params: Record<string, unknown>,
  sessionID = "sess-1",
): Promise<any> {
  return tool.execute(
    "call-1",
    params,
    new AbortController().signal,
    () => {},
    { sessionID },
  );
}

const emptyRole: ResolvedRole = {
  id: "test-role",
  config: {
    name: "Test Role",
    description: "A test role for Pi tool interceptor tests",
    prompt: "You are a test role.",
  },
  prompt: "You are a test role.",
  skills: [],
  functions: [],
  references: [],
  subagents: [],
};

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-tool-interceptor-"));
  tmpDirs.push(dir);
  return dir;
}

function warnEntries(): ILogObj[] {
  return logEntries.filter((e) =>
    String(e[0]).includes("Deprecated tool invoked"),
  );
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete (globalThis as Record<string, unknown>).__piToolBefore;
});

// ── (a) strict validation — unknown parameter returns an error string ───────

describe("Pi tool interceptor — strict parameter validation", () => {
  it("returns an error containing the unknown key and the valid parameter list instead of throwing", async () => {
    const def = createHashlineReadTool();
    registerToolSchema("hashline_read", def.args);

    const tool = compileTool("hashline_read", def);
    const result = await invoke(tool, {
      filePath: "/tmp/x.ts",
      bogus: true,
    });

    // Must RESOLVE (never throw into Pi) with an error text result.
    expect(result.content[0].type).toBe("text");
    const text = result.content[0].text as string;
    expect(text).toContain("'bogus'");
    expect(text).toContain("Valid parameters for 'hashline_read'");
    expect(text).toContain("filePath");
    expect(text).toContain("offset");
    expect(text).toContain("limit");
  });

  it("does not invoke the canonical def when validation fails", async () => {
    const execute = mock(async () => "ran");
    const def = defineTool({
      description: "spy tool",
      args: { filePath: z.string() },
      execute: execute as any,
    });
    registerToolSchema("spy_tool", def.args);

    const tool = compileTool("spy_tool", def);
    await invoke(tool, { filePath: "/tmp/x.ts", junk: 1 });

    expect(execute).not.toHaveBeenCalled();
  });

  it("injects the validation error into pendingCorrections for the session", async () => {
    const def = createHashlineReadTool();
    registerToolSchema("hashline_read", def.args);

    const state = new HookState();
    const tool = compileTool("hashline_read", def, { state, deps: minimalDeps() });
    await invoke(tool, { filePath: "/tmp/x.ts", bogus: true }, "sess-correct");

    const correction = state.pendingCorrections.get("sess-correct");
    expect(correction).toBeDefined();
    expect(correction!).toContain("'bogus'");
    expect(correction!).toContain("Valid parameters for 'hashline_read'");
  });

  it("passes zod-normalized args to the canonical def on a valid call", async () => {
    const def = createHashlineReadTool();
    registerToolSchema("hashline_read", def.args);

    const tmpDir = makeTmpDir();
    const filePath = join(tmpDir, "sample.txt");
    writeFileSync(filePath, "hello\nworld\n", "utf-8");

    const tool = compileTool("hashline_read", def);
    const result = await invoke(tool, { filePath });

    expect(result.content[0].text).toContain("version:");
    expect(result.content[0].text).toContain("totalLines: 2");
  });
});

// ── (b) deprecated-tool warnings ─────────────────────────────────────────────

describe("Pi tool interceptor — deprecated tool warnings", () => {
  it("logs a warning when a deprecated registered tool is invoked", async () => {
    logEntries.length = 0;
    registerDeprecatedTool("legacy_read", "use hashline_read instead");

    const def = defineTool({
      description: "legacy read tool",
      args: { path: z.string() },
      execute: async () => "ok",
    });
    const tool = compileTool("legacy_read", def);
    await invoke(tool, { path: "/tmp/x" });

    const warns = warnEntries();
    expect(warns.length).toBeGreaterThan(0);
    expect(String(warns[0][0])).toContain("legacy_read");
  });

  it("registers deprecation from def.deprecated via PiLightweightServiceStack.init and warns on invocation", async () => {
    logEntries.length = 0;
    const registered: any[] = [];
    const mockPi = {
      registerTool: (toolDef: any) => {
        registered.push(toolDef);
      },
      on: () => {},
    };

    const legacyDef = defineTool({
      description: "legacy stack tool",
      args: { path: z.string() },
      execute: async () => "ok",
    });
    // CanonicalToolDef carries `deprecated`; defineTool's input type does
    // not, so it is assigned after construction.
    legacyDef.deprecated = { since: "1.0", message: "use hashline_read instead" };

    const stack = new PiLightweightServiceStack(
      mockPi,
      [emptyRole],
      undefined,
      undefined,
      undefined,
      undefined,
      { legacy_stack_tool: legacyDef },
    );
    await stack.init();

    const tool = registered.find((t) => t.name === "legacy_stack_tool");
    expect(tool).toBeDefined();

    await invoke(tool, { path: "/tmp/x" });

    const warns = warnEntries();
    expect(warns.length).toBeGreaterThan(0);
    expect(String(warns[0][0])).toContain("legacy_stack_tool");
  });
});

// ── (c) custom-hook before phase from the S6 CustomHookRegistry ─────────────

describe("Pi tool interceptor — custom hook before phase", () => {
  it("passes the tool call to a custom hook's before phase", async () => {
    const tmpDir = makeTmpDir();
    writeFileSync(
      join(tmpDir, "before-hook.ts"),
      [
        `export const onToolBefore = (ctx: any, input: any): void => {`,
        `  const g = globalThis as any;`,
        `  g.__piToolBefore ??= [];`,
        `  g.__piToolBefore.push({ tool: input.tool, args: input.args, sessionID: ctx.sessionID });`,
        `};`,
      ].join("\n"),
    );

    const customHooks = new CustomHookRegistry();
    await customHooks.register(
      {
        name: "before-hook",
        events: ["tool.execute.before"],
        phase: "before",
        module: "./before-hook.ts",
      },
      tmpDir,
    );

    const def = createHashlineReadTool();
    registerToolSchema("hashline_read", def.args);

    const state = new HookState();
    const deps = minimalDeps({ customHooks });
    const tool = compileTool("hashline_read", def, { state, deps });

    (globalThis as Record<string, unknown>).__piToolBefore = [];
    const result = await invoke(tool, { filePath: "/tmp/x.ts" }, "sess-hook");

    const fired = (globalThis as Record<string, unknown>).__piToolBefore as
      | Array<{ tool: string; args: unknown; sessionID: string }>
      | undefined;
    expect(fired).toBeDefined();
    expect(fired!).toHaveLength(1);
    expect(fired![0]).toEqual({
      tool: "hashline_read",
      args: { filePath: "/tmp/x.ts" },
      sessionID: "sess-hook",
    });
    // The hook ran in the before phase — the canonical def still executed.
    expect(result.content[0].text).toContain("File not found");
  });

  it("does not run custom hooks when no hook wiring is provided", async () => {
    const customHooks = new CustomHookRegistry();
    const runHooks = mock(() => Promise.resolve());
    const deps = minimalDeps({ customHooks: { runHooks } as any });

    const def = createHashlineReadTool();
    registerToolSchema("hashline_read", def.args);

    // No state — handleToolBefore skips the hook phases.
    const tool = compileTool("hashline_read", def, { deps });
    await invoke(tool, { filePath: "/tmp/x.ts", bogus: true });

    expect(runHooks).not.toHaveBeenCalled();
  });
});
