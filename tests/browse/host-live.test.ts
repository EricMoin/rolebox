import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowseSessionManager } from "../../src/browse/session.ts";
import { createBrowseTools } from "../../src/browse/tools.ts";
import { hasPngSignature } from "../../src/computer/png.ts";
import { PiToolFactory } from "../../src/platform/adapters/pi/tool-factory.ts";
import { DshToolFactory, type DshToolDefinition, type DshToolRunContext } from "../../src/platform/adapters/dsh/tool-factory.ts";
import type { ResolvedRole } from "../../src/types.ts";
import type { ToolResult } from "../../src/platform/types.ts";
import { startFixtureSite, type FixtureSite } from "./fixtures/fixture-site.ts";

const live = process.env.ROLEBOX_BROWSE_LIVE === "1";
let site: FixtureSite;
beforeAll(async () => { if (live) site = await startFixtureSite(); });
afterAll(async () => { await site?.close(); });

interface PiResult { content: Array<{ type: string; text?: string; data?: string }>; details: Record<string, unknown> }
interface PiTool { execute(id: string, args: Record<string, unknown>, signal: AbortSignal, update: () => void, context: Record<string, unknown>): Promise<PiResult> }

describe.skipIf(!live)("host adapters with real Chromium", () => {
  it("keeps Pi session identity, image output, role restrictions and timeout recovery", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "rolebox-browse-pi-"));
    const manager = new BrowseSessionManager({ worktree });
    const blocked: ResolvedRole = { id: "blocked", config: { name: "Blocked", description: "Test role", prompt: "Test", tools: { "browse_*": false } }, prompt: "Test", skills: [], functions: [], references: [], subagents: [] };
    let roleId: string | null = null;
    const tools = new PiToolFactory({ browseUse: { enabled: true, activeRoleFor: () => roleId, roles: () => [blocked] } })
      .compileAll(createBrowseTools({ manager })) as unknown as Record<string, PiTool>;
    let sequence = 0;
    const call = (name: string, args: Record<string, unknown> = {}) => tools[name].execute(
      `call-${++sequence}`, args, new AbortController().signal, () => undefined,
      { cwd: worktree, sessionManager: { getSessionId: () => "pi-session" } },
    );
    try {
      expect((await call("browse_open", { url: site.baseUrl })).details.error).toBeUndefined();
      expect((await call("browse_snapshot")).details.page).toBe("main");
      const shot = await call("browse_screenshot");
      const image = shot.content.find(block => block.type === "image");
      expect(hasPngSignature(Buffer.from(image?.data ?? "", "base64"))).toBe(true);
      expect(manager.sessionCount).toBe(1);
      roleId = "blocked";
      const denied = await call("browse_click", { target: "css=#clicker" });
      expect(denied.content[0].text).toContain("Browse use denied");
      roleId = null;
      expect((await call("browse_eval", { expression: "document.getElementById('out').textContent" })).content[0].text).toBe("idle");
      expect((await call("browse_eval", { expression: "new Promise(() => {})", timeout_ms: 30 })).details.code).toBe("timeout");
      expect((await call("browse_open", { url: site.baseUrl })).details.error).toBeUndefined();
      expect((await call("browse_read")).content[0].text).toContain("Fixture home");
      await call("browse_close");
      expect(manager.sessionCount).toBe(0);
    } finally {
      await manager.dispose();
      rmSync(worktree, { recursive: true, force: true });
    }
  }, 120_000);

  it("keeps dsh session state, text rendering and timeout recovery across compiled tools", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "rolebox-browse-dsh-"));
    const manager = new BrowseSessionManager({ worktree });
    const tools = new DshToolFactory().compileAll(createBrowseTools({ manager })) as Record<string, DshToolDefinition>;
    const exec: DshToolRunContext = {
      signal: new AbortController().signal, callId: "call", agent: { id: "agent", session: { id: "dsh-session", header: { cwd: worktree } } },
      deferContext() {}, concludeTurn() {},
    };
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await tools[name].execute(args, { ...exec, callId: crypto.randomUUID() }) as ToolResult;
      if (typeof result === "string") throw new Error(result);
      return result;
    };
    try {
      expect((await call("browse_open", { url: site.baseUrl })).metadata?.error).toBeUndefined();
      await call("browse_type", { target: "css=#name", text: "DSH", submit: true });
      expect((await call("browse_eval", { expression: "document.getElementById('out').textContent" })).output).toBe("submitted:DSH");
      const shot = await call("browse_screenshot");
      expect(hasPngSignature(readFileSync(String(shot.metadata?.path)))).toBe(true);
      expect(tools.browse_screenshot.output.render({}, shot)[0]).toMatchObject({ type: "text" });
      expect(manager.sessionCount).toBe(1);
      expect((await call("browse_eval", { expression: "new Promise(() => {})", timeout_ms: 30 })).metadata?.code).toBe("timeout");
      expect((await call("browse_open", { url: site.baseUrl })).metadata?.error).toBeUndefined();
      expect((await call("browse_read")).output).toContain("Fixture home");
      await call("browse_close");
      expect(manager.sessionCount).toBe(0);
    } finally {
      await manager.dispose();
      rmSync(worktree, { recursive: true, force: true });
    }
  }, 120_000);
});
