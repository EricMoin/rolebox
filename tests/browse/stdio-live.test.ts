import { serve } from "../helpers/http-server.ts";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSE_TOOL_NAMES } from "../../src/loader/browse-grants.ts";
import { parseSnapshotRefs } from "../../src/browse/snapshot.ts";
import { hasPngSignature } from "../../src/computer/png.ts";
import type { McpToolCallResult } from "../../src/platform/adapters/codex/tool-factory.ts";
import { FIXTURE_DOWNLOAD_BODY, startFixtureSite, type FixtureSite } from "./fixtures/fixture-site.ts";
import { startStdioClient } from "./helpers/stdio-client.ts";

const live = process.env.ROLEBOX_BROWSE_LIVE === "1";
let site: FixtureSite;
beforeAll(async () => { if (live) site = await startFixtureSite(); });
afterAll(async () => { await site?.close(); });

function text(result: McpToolCallResult): string {
  return result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
}

async function withClient(run: (client: ReturnType<typeof startStdioClient>, worktree: string) => Promise<void>, enabled = true) {
  const worktree = mkdtempSync(join(tmpdir(), "rolebox-browse-stdio-"));
  const client = startStdioClient(worktree, enabled);
  try {
    const initialized = await client.request<{ instructions?: string }>("initialize", {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "browse-e2e", version: "1.0.0" },
    }).result;
    expect(initialized.instructions?.includes("Browser use workflow") ?? false).toBe(enabled);
    client.notify("notifications/initialized");
    await run(client, worktree);
  } finally {
    const code = await client.close();
    rmSync(worktree, { recursive: true, force: true });
    expect(code).toBe(0);
  }
}

describe.skipIf(!live)("built Node MCP browser end to end", () => {
  it("drives all 23 tools through stdin/stdout and transports screenshots as images", async () => {
    await withClient(async (client, worktree) => {
      const list = await client.request<{ tools: Array<{ name: string }> }>("tools/list").result;
      expect(list.tools.filter(tool => tool.name.startsWith("browse_")).map(tool => tool.name).sort()).toEqual([...BROWSE_TOOL_NAMES].sort());
      expect(list.tools.some(tool => tool.name.startsWith("computer_"))).toBe(false);
      const used = new Set<string>();
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        used.add(name);
        const result = await client.call(name, args);
        expect(result.isError, name).not.toBe(true);
        expect(text(result).startsWith("Error:"), name).toBe(false);
        return result;
      };
      expect(text(await call("browse_status"))).toContain("no pages");
      await call("browse_open", { url: site.baseUrl });
      const snapshot = text(await call("browse_snapshot"));
      const ref = (name: string) => {
        const match = parseSnapshotRefs(snapshot).find(entry => entry.name === name);
        if (!match) throw new Error(`No snapshot ref for ${name}.`);
        return match.ref;
      };
      await call("browse_click", { target: ref("Click me") });
      expect(text(await call("browse_eval", { expression: "document.getElementById('out').textContent" }))).toBe("clicked");
      await call("browse_drag", { from: "css=#name", to: "css=#apply" });
      await call("browse_type", { target: ref("Name"), text: "Sample", submit: true });
      expect(text(await call("browse_eval", { expression: "document.getElementById('out').textContent" }))).toBe("submitted:Sample");
      await call("browse_press", { target: ref("Name"), key: "Enter" });
      await call("browse_select", { target: ref("Plan"), values: ["pro"] });
      await call("browse_hover", { target: ref("Click me") });
      await call("browse_scroll", { to: "bottom" });
      await call("browse_wait", { text: "missing:404" });
      for (const format of ["markdown", "text", "html", "links", "table"]) await call("browse_read", { format });
      const shot = await call("browse_screenshot", { path: "captures/page.png" });
      const image = shot.content.find(block => block.type === "image");
      expect(image?.type).toBe("image");
      if (!image || image.type !== "image") throw new Error("MCP screenshot omitted its image block.");
      expect(hasPngSignature(Buffer.from(image.data, "base64"))).toBe(true);
      expect(readFileSync(join(worktree, "captures/page.png"))).toEqual(Buffer.from(image.data, "base64"));
      writeFileSync(join(worktree, "upload.txt"), "upload fixture");
      await call("browse_upload", { target: "css=#upload", paths: ["upload.txt"] });
      expect(text(await call("browse_eval", { expression: "document.getElementById('upload').files[0].name" }))).toBe("upload.txt");
      await call("browse_cookies", { action: "set", name: "fixture", value: "value", url: site.baseUrl });
      expect(text(await call("browse_cookies", { action: "get" }))).toContain("fixture=value");
      await call("browse_cookies", { action: "clear" });
      expect(text(await call("browse_console"))).toContain("fixture-error");
      expect(text(await call("browse_network", { failed_only: true }))).toContain("404");
      await client.call("browse_click", { target: ref("Confirm") });
      expect(text(await call("browse_status"))).toContain("Pending confirm dialog");
      await call("browse_dialog", { action: "dismiss" });
      await call("browse_click", { target: "css=#download" });
      let downloads = "";
      for (let attempt = 0; attempt < 40; attempt++) {
        downloads = text(await call("browse_downloads"));
        if (downloads.includes("completed")) break;
        await sleep(50);
      }
      expect(downloads).toContain("completed");
      const directory = join(worktree, ".rolebox/browse/downloads");
      const files = readdirSync(directory);
      expect(files).toHaveLength(1);
      expect(readFileSync(join(directory, files[0]), "utf8")).toBe(FIXTURE_DOWNLOAD_BODY);
      await call("browse_tabs", { action: "new", page: "extra", url: `${site.baseUrl}/second` });
      await call("browse_tabs", { action: "select", page: "main" });
      await call("browse_open", { url: `${site.baseUrl}/second` });
      await call("browse_history", { action: "back" });
      expect(text(await call("browse_read", { format: "text" }))).toContain("Fixture home");
      await call("browse_history", { action: "forward" });
      await call("browse_history", { action: "reload" });
      await call("browse_tabs", { action: "close", page: "extra" });
      await call("browse_close");
      expect(text(await call("browse_status"))).toContain("no pages");
      expect([...used].sort()).toEqual([...BROWSE_TOOL_NAMES].sort());
    });
  }, 120_000);

  it("preserves stale-ref and evaluation-timeout failures on the MCP wire", async () => {
    await withClient(async client => {
      await client.call("browse_open", { url: site.baseUrl });
      const old = parseSnapshotRefs(text(await client.call("browse_snapshot")))[0].ref;
      await client.call("browse_snapshot");
      const stale = await client.call("browse_click", { target: old });
      expect(text(stale)).toContain("stale");
      expect(stale.isError).toBe(true);
      const timedOut = await client.call("browse_eval", { expression: "new Promise(() => {})", timeout_ms: 30 });
      expect(text(timedOut)).toContain("exceeded");
      expect(timedOut.isError).toBe(true);
      await client.call("browse_open", { url: site.baseUrl });
      expect(text(await client.call("browse_read"))).toContain("Fixture home");
    });
  }, 120_000);

  it("cancels an in-flight evaluation through a notification and recovers", async () => {
    const started = Promise.withResolvers<void>();
    const gate = await serve(() => {
      started.resolve();
      return new Response("ok", { headers: { "access-control-allow-origin": "*" } });
    });
    try {
      await withClient(async client => {
        await client.call("browse_open", { url: site.baseUrl });
        const evaluation = client.request<McpToolCallResult>("tools/call", { name: "browse_eval", arguments: {
          expression: `(() => { fetch(${JSON.stringify(`http://127.0.0.1:${gate.port}/started`)}); return new Promise(() => {}); })()`,
        } });
        await started.promise;
        client.notify("notifications/cancelled", { requestId: evaluation.id });
        const cancelled = await evaluation.result;
        expect(text(cancelled)).toContain("cancelled");
        expect(cancelled.isError).toBe(true);
        await client.call("browse_open", { url: site.baseUrl });
        expect(text(await client.call("browse_read"))).toContain("Fixture home");
      });
    } finally { await gate.stop(true); }
  }, 120_000);

  it.skipIf(process.platform === "win32")("refuses screenshot symlinks through the built host", async () => {
    await withClient(async (client, worktree) => {
      const outside = mkdtempSync(join(tmpdir(), "rolebox-browse-outside-"));
      try {
        const target = join(outside, "keep.txt");
        writeFileSync(target, "keep");
        symlinkSync(target, join(worktree, "capture.png"));
        symlinkSync(outside, join(worktree, "linked"), "dir");
        for (const path of ["capture.png", "linked/capture.png"]) {
          const result = await client.call("browse_screenshot", { path });
          expect(text(result)).toContain("symbolic link");
          expect(result.isError).toBe(true);
        }
        expect(readFileSync(target, "utf8")).toBe("keep");
        expect(existsSync(join(outside, "capture.png"))).toBe(false);
      } finally { rmSync(outside, { recursive: true, force: true }); }
    });
  }, 120_000);

  it("honors a project opt-out despite a global opt-in", async () => {
    await withClient(async client => {
      const list = await client.request<{ tools: Array<{ name: string }> }>("tools/list").result;
      expect(list.tools.some(tool => tool.name.startsWith("browse_"))).toBe(false);
      expect((await client.call("browse_open", { url: site.baseUrl })).isError).toBe(true);
    }, false);
  }, 120_000);
});
