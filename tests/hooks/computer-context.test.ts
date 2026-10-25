import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSystemTransform } from "../../src/hooks/system-transform.ts";
import { HookState } from "../../src/hooks/state.ts";
import type { HookDeps } from "../../src/hooks/deps.ts";
import type { ResolvedRole } from "../../src/types.ts";

let directory: string;
let role: ResolvedRole;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "rolebox-hook-computer-"));
  role = {
    id: "parent", config: { name: "Parent", description: "", prompt: "Parent", memory: { inject: false } },
    prompt: "Parent", skills: [], references: [], functions: [],
    subagents: [{
      id: "parent--child", parentId: "parent", inheritedFrom: {},
      config: { name: "Child", description: "", prompt: "Child", memory: { inject: false } },
      prompt: "Child", skills: [], references: [], functions: [], subagents: [],
    }],
  };
});

afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

async function transform(options: { tools?: string[]; agent?: string | null; worker?: boolean } = {}): Promise<string> {
  const deps: HookDeps = {
    session: {} as never, roleFunctionsMap: new Map(), roleMap: new Map([[role.id, role]]),
    dir: directory, dispatchManager: {} as never, loopManager: {} as never,
    customHooks: { runHooks: async () => {} } as never, isGraphWorker: () => options.worker ?? false,
    ...(options.tools === undefined ? {} : { availableTools: (sid: string) => { expect(sid).toBe("computer-context"); return options.tools!; } }),
  };
  const output = { system: [] as string[] };
  await handleSystemTransform({ sessionID: "computer-context", agent: options.agent === null ? undefined : options.agent ?? "parent--child" }, output, new HookState(), deps);
  return output.system.filter(block => block.startsWith("## Computer use workflow")).join("\n\n");
}

describe("ordinary computer context", () => {
  it("does not advertise tools when the host has not reported registration", async () => {
    role.subagents[0].config.tools = { "computer_*": true };
    expect(await transform()).toBe("");
    expect(await transform({ tools: [] })).toBe("");
    expect(await transform({ tools: ["web_search"] })).toBe("");
  });

  it("intersects nested role policy with the tools the host actually registered", async () => {
    role.subagents[0].config.tools = { "computer_*": true, computer_click: false };
    const context = await transform({ tools: ["computer_screenshot", "computer_click", "computer_permissions"] });
    expect(context).toContain("computer_screenshot");
    expect(context).toContain("computer_permissions(request=true)");
    expect(context).not.toContain("computer_click");
    expect(context).not.toContain("computer_status");
    expect(context).not.toContain("computer_windows");
  });

  it("guides base agents only for the exact tools registered by the host", async () => {
    for (const agent of [null, ""]) {
      const context = await transform({ agent, tools: ["computer_screenshot", "computer_permissions", "web_search"] });
      expect(context).toContain("## Computer use workflow");
      expect(context).toContain("computer_screenshot");
      expect(context).toContain("computer_permissions(request=true)");
      expect(context).not.toContain("computer_click");
      expect(context).not.toContain("computer_status");
      expect(await transform({ agent })).toBe("");
      expect(await transform({ agent, tools: [] })).toBe("");
    }
  });

  it("omits denied tools and refreshes after role policy changes", async () => {
    role.subagents[0].config.tools = { "computer_*": false };
    expect(await transform({ tools: ["computer_screenshot"] })).toBe("");
    role.subagents[0].config.tools.computer_screenshot = true;
    expect(await transform({ tools: ["computer_screenshot"] })).toContain("computer_screenshot");
  });

  it("keeps unknown roles and graph workers outside the ordinary injection path", async () => {
    expect(await transform({ tools: ["computer_screenshot"], agent: "unknown" })).toBe("");
    expect(await transform({ tools: ["computer_screenshot"], worker: true })).toBe("");
  });
});
