import { setTimeout as sleep } from "node:timers/promises";
import { findExecutable } from "../../scripts/node-process.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { BrowseSessionManager } from "../../src/browse/session.ts";
import { createBrowseTools } from "../../src/browse/tools.ts";
import type { CanonicalToolContext, ToolResult } from "../../src/platform/types.ts";
import { startFixtureSite, type FixtureSite } from "./fixtures/fixture-site.ts";
import { startStdioClient } from "./helpers/stdio-client.ts";

const live = process.env.ROLEBOX_BROWSE_LIVE === "1";
let site: FixtureSite;
beforeAll(async () => { if (live) site = await startFixtureSite(); });
afterAll(async () => { await site?.close(); });

function context(worktree: string, signal = new AbortController().signal): CanonicalToolContext {
  return { sessionID: "s", messageID: "m", agent: "base", directory: worktree, worktree, abort: signal, metadata() {}, async ask() {} };
}

function structured(result: ToolResult) {
  if (typeof result === "string") throw new Error("Expected a structured browse result.");
  return result;
}

describe.skipIf(!live)("browser lifecycle with real Chromium", () => {
  it("isolates sessions and enforces the eight-page limit", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "rolebox-browse-isolation-"));
    const manager = new BrowseSessionManager({ worktree });
    try {
      await manager.run("first", async page => {
        await page.goto(site.baseUrl);
        await page.setCookies([{ name: "session", value: "first", url: site.baseUrl }]);
      });
      await manager.run("second", async page => {
        await page.goto(site.baseUrl);
        expect(await page.cookies()).toHaveLength(0);
      });
      for (let index = 1; index < 8; index++) await manager.newPage("first", `page-${index}`);
      await expect(manager.newPage("first", "overflow")).rejects.toMatchObject({ code: "page_limit" });
      await manager.closePage("first", "page-1");
      await manager.newPage("first", "replacement");
      expect((await manager.pages("first")).length).toBe(8);
      await manager.close("first");
      expect((await manager.info("second")).pages).toHaveLength(1);
      expect(await manager.run("second", page => page.title())).toBe("Fixture home");
    } finally {
      await manager.dispose();
      rmSync(worktree, { recursive: true, force: true });
    }
  }, 120_000);

  it("never delivers a cancelled queued click to the real page", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "rolebox-browse-cancel-"));
    const manager = new BrowseSessionManager({ worktree });
    const released = Promise.withResolvers<void>();
    try {
      await manager.run("s", page => page.goto(site.baseUrl));
      const started = Promise.withResolvers<void>();
      const blocker = manager.run("s", async page => {
        started.resolve();
        await released.promise;
        return page.read("text");
      });
      await started.promise;
      const controller = new AbortController();
      const tools = createBrowseTools({ manager });
      const click = tools.browse_click.execute({ target: "css=#clicker" }, context(worktree, controller.signal));
      controller.abort();
      expect(structured(await click).metadata?.code).toBe("cancelled");
      released.resolve();
      await blocker;
      expect(await manager.run("s", page => page.evaluate<string>("document.getElementById('out').textContent"))).toBe("idle");
    } finally {
      released.resolve();
      await manager.dispose();
      rmSync(worktree, { recursive: true, force: true });
    }
  }, 120_000);

  it("closes the real page after tab listing refreshes the idle deadline", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "rolebox-browse-idle-"));
    const manager = new BrowseSessionManager({ worktree, idleTtlMs: 250 });
    try {
      const page = await manager.run("s", async page => {
        await page.goto(site.baseUrl);
        return page.driver;
      });
      await sleep(80);
      expect(await manager.pages("s")).toHaveLength(1);
      const deadline = Date.now() + 3_000;
      while (manager.sessionCount && Date.now() < deadline) await sleep(40);
      expect(manager.sessionCount).toBe(0);
      expect(page.isClosed()).toBe(true);
    } finally {
      await manager.dispose();
      rmSync(worktree, { recursive: true, force: true });
    }
  }, 120_000);

  it("preserves external pages and cookies after CDP closes on Node", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "rolebox-browse-cdp-"));
    const ownerScript = `
      import { chromium } from ${JSON.stringify(new URL("../../node_modules/playwright/index.mjs", import.meta.url).href)};
      import { readFile } from "node:fs/promises";
      const profile = ${JSON.stringify(join(worktree, "profile"))};
      const browser = await chromium.launchPersistentContext(profile, {
        headless: true, chromiumSandbox: true, args: ["--remote-debugging-port=0"], timeout: 10000,
      });
      await browser.pages()[0].goto(${JSON.stringify(`${site.baseUrl}/second`)});
      await browser.addCookies([{name:"external",value:"preserved",url:${JSON.stringify(site.baseUrl)}}]);
      const [port] = (await readFile(profile + "/DevToolsActivePort", "utf8")).split("\\n");
      const version = await (await fetch("http://127.0.0.1:" + port + "/json/version")).json();
      process.stderr.write("DevTools listening on " + version.webSocketDebuggerUrl + "\\n");
      process.stdin.resume();
      await new Promise(resolve => process.stdin.once("end", resolve));
      await browser.close();
    `;
    const node = findExecutable("node");
    if (!node) throw new Error("The CDP live suite requires Node.js.");
    const external = spawn(node, ["--input-type=module", "-e", ownerScript], { stdio: ["pipe", "ignore", "pipe"] });
    const endpoint = Promise.withResolvers<string>();
    const lines = createInterface({ input: external.stderr });
    lines.on("line", line => {
      const match = /^DevTools listening on (ws:\/\/.*)$/.exec(line);
      if (match) endpoint.resolve(match[1]);
    });
    const exited = new Promise<void>(resolve => external.once("exit", () => resolve()));
    external.on("error", error => endpoint.reject(error));
    const startupDeadline = setTimeout(() => endpoint.reject(new Error("External Chromium did not expose CDP.")), 10_000);
    const manager = new BrowseSessionManager({ worktree });
    const client = startStdioClient(worktree);
    try {
      if (client) {
        await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cdp-e2e", version: "1" } }).result;
        client.notify("notifications/initialized");
      }
      const wsEndpoint = await endpoint.promise;
      clearTimeout(startupDeadline);
      const httpEndpoint = new URL(wsEndpoint).origin.replace("ws:", "http:");
      const pages = async () => {
        const response = await fetch(`${httpEndpoint}/json/list`, { signal: AbortSignal.timeout(5_000) });
        return (await response.json() as Array<{ id: string; type: string; url: string }>).filter(target => target.type === "page");
      };
      const original = await pages();
      expect(original).toHaveLength(1);
      const tools = createBrowseTools({ manager });
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        if (!client) return structured(await tools[name].execute(args, context(worktree)));
        const result = await client.call(name, args);
        return {
          output: result.content.filter(block => block.type === "text").map(block => block.text).join("\n"),
          metadata: { error: result.isError === true },
        };
      };
      const opened = await call("browse_open", {
        url: site.baseUrl, cdp_url: wsEndpoint,
      });
      if (opened.metadata?.error) throw new Error(opened.output);
      expect((await call("browse_status")).output).toContain("attached over CDP");
      expect((await call("browse_cookies", { action: "get" })).output).toContain("external=preserved");
      expect(await pages()).toHaveLength(2);
      await call("browse_close");
      expect(await pages()).toEqual(original);
      await call("browse_open", { url: site.baseUrl, cdp_url: wsEndpoint });
      const cookies = await call("browse_cookies", { action: "get" });
      expect(cookies.output).toContain("external=preserved");
      await call("browse_close");
      expect(await pages()).toEqual(original);
    } finally {
      clearTimeout(startupDeadline);
      await manager.dispose();
      const exitCode = await client?.close();
      external.stdin.end();
      const deadline = setTimeout(() => external.kill("SIGKILL"), 3_000);
      await exited;
      clearTimeout(deadline);
      lines.close();
      rmSync(worktree, { recursive: true, force: true });
      if (client) expect(exitCode).toBe(0);
    }
  }, 120_000);
});
