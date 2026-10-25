/**
 * Observation tools against the in-memory driver: snapshot/ref bookkeeping,
 * reads, evaluation serialization, screenshot attachments and the cursor-based
 * console, network and download buffers.
 */

import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createBrowseHarness,
  HARNESS_SNAPSHOT,
  HARNESS_URL,
  type BrowseHarness,
  type StructuredToolResult,
} from "./helpers/fake-driver.ts";
import { FAKE_PNG_BYTES, type FakePageDriver } from "./fixtures/fake-driver.ts";

/** A minimal JPEG byte sequence, enough to prove the mime path is wired. */
const FAKE_JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

const harnesses: BrowseHarness[] = [];

function makeHarness(options: Parameters<typeof createBrowseHarness>[0] = {}): BrowseHarness {
  const harness = createBrowseHarness(options);
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.cleanup();
});

function expectFailure(result: StructuredToolResult, code: string): void {
  expect(result.output.startsWith("Error: ")).toBe(true);
  expect(result.metadata?.error).toBe(true);
  expect(result.metadata?.code).toBe(code);
}

describe("browse_snapshot", () => {
  it("returns the tree and reports the refs it wrote", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const result = await harness.call("browse_snapshot");
    expect(result.output).toBe(HARNESS_SNAPSHOT);
    expect(result.metadata?.ref_count).toBe(3);
    expect(result.metadata?.node_count).toBe(3);
    expect(result.metadata?.truncated).toBe(false);
    expect(result.metadata?.chars).toBe(HARNESS_SNAPSHOT.length);
    expect(result.metadata?.selector).toBeNull();
  });

  it("passes the scope selector and full flag through to the driver", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const result = await harness.call("browse_snapshot", { selector: "#main", full: true });
    expect(harness.page().calls).toContain("snapshot:#main");
    expect(result.metadata?.full).toBe(true);
  });

  it("explains an empty page instead of returning an empty string", async () => {
    const harness = makeHarness({
      configurePage(page) {
        page.snapshotText = "";
        page.snapshotRefs = [];
      },
    });
    await harness.call("browse_open");
    const result = await harness.call("browse_snapshot");
    expect(result.output).toContain("printed no accessible content");
    expect(result.metadata?.ref_count).toBe(0);
  });

  it("rejects an out-of-range character cap before touching the page", async () => {
    const harness = makeHarness();
    const result = await harness.call("browse_snapshot", { max_chars: 0 });
    expectFailure(result, "invalid_arguments");
    expect(harness.factory.launchCount).toBe(0);
  });
});

describe("browse_read", () => {
  it("reads markdown by default", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const result = await harness.call("browse_read");
    expect(harness.page().readFormats).toEqual(["markdown"]);
    expect(result.metadata?.format).toBe("markdown");
    expect(result.output).toBe("read:markdown");
    expect(result.metadata?.truncated).toBe(false);
  });

  it("reads the requested representation with a selector and cap", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const result = await harness.call("browse_read", { format: "links", selector: "#nav", max_chars: 500 });
    expect(harness.page().readFormats).toEqual(["links"]);
    expect(result.metadata?.format).toBe("links");
    expect(result.metadata?.selector).toBe("#nav");
    expect(result.output).toBe("read:links");
  });

  it("rejects an unknown format", async () => {
    const harness = makeHarness();
    const result = await harness.call("browse_read", { format: "pdf" });
    expectFailure(result, "invalid_arguments");
  });
});

describe("browse_eval", () => {
  it("returns a string result verbatim", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    harness.page().evaluateResult = "hello world";
    const result = await harness.call("browse_eval", { expression: "document.title" });
    expect(result.output).toBe("hello world");
    expect(result.metadata?.result_type).toBe("string");
    expect(harness.page().evaluatedExpressions).toEqual(["document.title"]);
  });

  it("serializes an object result as indented JSON", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    harness.page().evaluateResult = { ok: true, items: [1, 2] };
    const result = await harness.call("browse_eval", { expression: "({ ok: true, items: [1, 2] })" });
    expect(result.metadata?.result_type).toBe("object");
    expect(result.output).toBe(JSON.stringify({ ok: true, items: [1, 2] }, null, 2));
  });

  it("reports an array and a null result by type", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    harness.page().evaluateResult = [1, 2, 3];
    const array = await harness.call("browse_eval", { expression: "[1,2,3]" });
    expect(array.metadata?.result_type).toBe("array");
    harness.page().evaluateResult = null;
    const none = await harness.call("browse_eval", { expression: "null" });
    expect(none.metadata?.result_type).toBe("null");
    expect(none.output).toBe("null");
  });

  it("caps the serialized result and says so", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    harness.page().evaluateResult = "x".repeat(100);
    const result = await harness.call("browse_eval", { expression: "'x'.repeat(100)", max_chars: 10 });
    expect(result.metadata?.truncated).toBe(true);
    expect(result.output.startsWith("x".repeat(10))).toBe(true);
    expect(result.output).toContain("[... truncated: 90 more characters]");
  });

  it("rejects an out-of-range cap", async () => {
    const harness = makeHarness();
    const result = await harness.call("browse_eval", { expression: "1", max_chars: 0 });
    expectFailure(result, "invalid_arguments");
  });
});

describe("browse_screenshot", () => {
  it.skipIf(process.platform === "win32")("keeps worktree permissions and tightens an overwritten screenshot", async () => {
    const harness = makeHarness();
    chmodSync(harness.worktree, 0o755);
    const path = join(harness.worktree, "capture.png");
    writeFileSync(path, "replace me", { mode: 0o644 });
    const result = await harness.call("browse_screenshot", { path: "capture.png" });
    expect(result.metadata?.error).toBeUndefined();
    expect(statSync(harness.worktree).mode & 0o777).toBe(0o755);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path)).toEqual(Buffer.from(FAKE_PNG_BYTES));
  });

  it.skipIf(process.platform === "win32")("refuses directory and file symlinks escaping the worktree", async () => {
    const harness = makeHarness();
    const outside = makeHarness();
    const target = join(outside.worktree, "target.txt");
    writeFileSync(target, "keep");
    symlinkSync(outside.worktree, join(harness.worktree, "linked-dir"), "dir");
    symlinkSync(target, join(harness.worktree, "linked-file.png"));
    for (const path of ["linked-dir/capture.png", "linked-file.png"]) {
      expectFailure(await harness.call("browse_screenshot", { path }), "invalid_arguments");
    }
    expect(readFileSync(target, "utf8")).toBe("keep");
    expect(existsSync(join(outside.worktree, "capture.png"))).toBe(false);
    expect(harness.factory.launchCount).toBe(0);
  });

  it.skipIf(process.platform === "win32")("rechecks screenshot paths after capture and guards the default directory", async () => {
    const harness = makeHarness();
    const outside = makeHarness();
    await harness.call("browse_open");
    const screenshot = harness.page().screenshot.bind(harness.page());
    harness.page().screenshot = async options => {
      symlinkSync(outside.worktree, join(harness.worktree, "swapped"), "dir");
      return screenshot(options);
    };
    expectFailure(await harness.call("browse_screenshot", { path: "swapped/capture.png" }), "invalid_arguments");
    expect(existsSync(join(outside.worktree, "capture.png"))).toBe(false);
    symlinkSync(outside.worktree, join(harness.worktree, ".rolebox"), "dir");
    harness.page().screenshot = screenshot;
    expectFailure(await harness.call("browse_screenshot"), "invalid_arguments");
    expect(existsSync(join(outside.worktree, "browse"))).toBe(false);
  });

  it("writes a PNG under .rolebox/browse and returns an image attachment", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const result = await harness.call("browse_screenshot");

    const metadata = result.metadata ?? {};
    const path = String(metadata.path);
    expect(path.startsWith(join(harness.worktree, ".rolebox", "browse"))).toBe(true);
    expect(path.endsWith(".png")).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(metadata.mime).toBe("image/png");
    expect(metadata.width).toBe(800);
    expect(metadata.height).toBe(600);
    expect(result.output).not.toContain("base64");

    const attachment = result.attachments?.[0];
    expect(attachment?.type).toBe("file");
    expect(attachment?.mime).toBe("image/png");
    expect(attachment?.url.startsWith("data:image/png;base64,")).toBe(true);
    const bytes = Buffer.from(attachment!.url.split(",")[1], "base64");
    expect([...bytes]).toEqual([...FAKE_PNG_BYTES]);
  });

  it("writes to a worktree-relative path and creates its directory", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const result = await harness.call("browse_screenshot", { path: "artifacts/home.png", full_page: true });
    const path = String(result.metadata?.path);
    expect(path).toBe(join(harness.worktree, "artifacts", "home.png"));
    expect(existsSync(path)).toBe(true);
    expect(result.metadata?.full_page).toBe(true);
    expect(readFileSync(path).byteLength).toBe(FAKE_PNG_BYTES.byteLength);
  });

  it("captures a JPEG with quality when asked", async () => {
    const harness = makeHarness({
      configurePage(page) {
        page.screenshotResult = { bytes: FAKE_JPEG_BYTES, mime: "image/jpeg" };
      },
    });
    await harness.call("browse_open");
    const result = await harness.call("browse_screenshot", { path: "shots/page.jpg", format: "jpeg", quality: 80 });
    expect(String(result.metadata?.path)).toBe(join(harness.worktree, "shots", "page.jpg"));
    expect(result.metadata?.mime).toBe("image/jpeg");
    expect(result.attachments?.[0]?.mime).toBe("image/jpeg");
    expect(result.attachments?.[0]?.url.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("passes a selector through and records it", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const result = await harness.call("browse_screenshot", { selector: "#hero" });
    expect(result.metadata?.selector).toBe("#hero");
  });

  it("rejects quality without a JPEG format before launching", async () => {
    const harness = makeHarness();
    const result = await harness.call("browse_screenshot", { quality: 80 });
    expectFailure(result, "invalid_arguments");
    expect(result.output).toContain("quality requires format=jpeg");
    expect(harness.factory.launchCount).toBe(0);
  });

  it("rejects paths that are absolute, escaping, or missing the format extension", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    for (const path of [join(harness.worktree, "out.png"), "../escape.png", "shots/page.png/../nope", "shots/page"]) {
      const result = await harness.call("browse_screenshot", { path });
      expectFailure(result, "invalid_arguments");
    }
  });
});

describe("browse_downloads", () => {
  it("lists downloads with their saved path and keeps them by default", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    harness.page().pushDownload("report.csv");

    const first = await harness.call("browse_downloads");
    expect(first.metadata?.count).toBe(1);
    const downloads = first.metadata?.downloads as Array<{ filename: string; path?: string }>;
    expect(downloads[0].filename).toBe("report.csv");
    expect(first.output).toContain("report.csv");
    expect(first.output).toContain("/tmp/report.csv");
    expect(harness.page().buffers.downloads.size).toBe(1);
  });

  it("returns only new downloads since the last read and can clear the buffer", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    harness.page().pushDownload("first.csv");
    await harness.call("browse_downloads");

    const empty = await harness.call("browse_downloads");
    expect(empty.metadata?.count).toBe(0);
    expect(empty.output).toContain("No new downloads");

    harness.page().pushDownload("second.csv");
    const cleared = await harness.call("browse_downloads", { clear: true });
    expect(cleared.metadata?.count).toBe(1);
    expect(cleared.metadata?.cleared).toBe(true);
    expect(harness.page().buffers.downloads.size).toBe(0);
  });

  it("names the download directory in the empty result", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const result = await harness.call("browse_downloads");
    expect(result.output).toContain(join(harness.worktree, ".rolebox", "browse", "downloads"));
  });
});

describe("browse_console", () => {
  function pushConsole(page: FakePageDriver, level: string, text: string): void {
    page.buffers.console.push({ kind: "console", level, text, url: HARNESS_URL, timestamp: 0 });
  }

  it("returns buffered messages, counts their levels and clears by default", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const page = harness.page();
    pushConsole(page, "log", "ready");
    pushConsole(page, "error", "boom");

    const result = await harness.call("browse_console");
    expect(result.metadata?.count).toBe(2);
    expect(result.metadata?.levels).toEqual({ log: 1, error: 1 });
    expect(result.metadata?.cleared).toBe(true);
    expect(result.output).toContain("#1 log: ready");
    expect(result.output).toContain("#2 error: boom");
    expect(page.buffers.console.size).toBe(0);

    const empty = await harness.call("browse_console");
    expect(empty.metadata?.count).toBe(0);
    expect(empty.output).toContain("No console messages");
  });

  it("filters by level and caps the most recent entries", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const page = harness.page();
    pushConsole(page, "log", "one");
    pushConsole(page, "error", "two");
    pushConsole(page, "error", "three");

    const errors = await harness.call("browse_console", { level: "error", clear: false });
    expect(errors.metadata?.count).toBe(2);
    expect(errors.metadata?.matched).toBe(2);
    expect(errors.output).not.toContain("one");

    pushConsole(page, "log", "four");
    pushConsole(page, "log", "five");
    const limited = await harness.call("browse_console", { level: "log", limit: 1 });
    expect(limited.metadata?.count).toBe(1);
    expect(limited.output).toBe(`#5 log: five (${HARNESS_URL})`);
  });

  it("keeps entries when clear is false but still advances the cursor", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const page = harness.page();
    pushConsole(page, "warning", "careful");
    const first = await harness.call("browse_console", { clear: false });
    expect(first.metadata?.count).toBe(1);
    expect(page.buffers.console.size).toBe(1);
    const second = await harness.call("browse_console", { clear: false });
    expect(second.metadata?.count).toBe(0);
  });

  it("reports page errors and dialogs by kind", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const page = harness.page();
    page.buffers.console.push({ kind: "pageerror", level: "error", text: "Uncaught TypeError", url: "", timestamp: 0 });
    page.buffers.console.push({ kind: "dialog", level: "alert", text: "Are you sure?", url: "", timestamp: 0 });

    const pageErrors = await harness.call("browse_console", { level: "pageerror", clear: false });
    expect(pageErrors.metadata?.count).toBe(1);
    expect(pageErrors.output).toContain("pageerror/error: Uncaught TypeError");

    // The cursor advanced past both entries, so a second filtered read needs a
    // fresh dialog entry; this is the documented "since the last read" rule.
    page.buffers.console.push({ kind: "dialog", level: "alert", text: "Are you sure?", url: "", timestamp: 0 });
    const dialogs = await harness.call("browse_console", { level: "dialog" });
    expect(dialogs.metadata?.count).toBe(1);
    expect(dialogs.output).toContain("dialog/alert: Are you sure?");
  });
});

describe("browse_network", () => {
  function seedNetwork(page: FakePageDriver): void {
    page.buffers.network.push({
      event: "response", method: "GET", url: "https://example.com/api/users", resourceType: "fetch",
      status: 200, ok: true, timestamp: 0,
    });
    page.buffers.network.push({
      event: "response", method: "POST", url: "https://example.com/api/orders", resourceType: "fetch",
      status: 500, ok: false, timestamp: 0,
    });
    page.buffers.network.push({
      event: "failed", method: "GET", url: "https://example.com/missing.js", resourceType: "script",
      error: "net::ERR_ABORTED", timestamp: 0,
    });
  }

  it("lists fresh records, counts methods and failures, and clears by default", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const page = harness.page();
    seedNetwork(page);
    const result = await harness.call("browse_network");
    expect(result.metadata?.count).toBe(3);
    expect(result.metadata?.failed).toBe(2);
    expect(result.metadata?.methods).toEqual({ GET: 2, POST: 1 });
    expect(result.output).toContain("#1 GET 200 https://example.com/api/users [fetch]");
    expect(result.output).toContain("#2 POST 500 https://example.com/api/orders [fetch]");
    expect(result.output).toContain("#3 GET FAILED https://example.com/missing.js [script] (net::ERR_ABORTED)");
    expect(page.buffers.network.size).toBe(0);
  });

  it("applies the URL/resource filter, method, status and failed_only", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const page = harness.page();

    seedNetwork(page);
    expect((await harness.call("browse_network", { filter: "api" })).metadata?.count).toBe(2);

    seedNetwork(page);
    expect((await harness.call("browse_network", { filter: "script" })).metadata?.count).toBe(1);

    seedNetwork(page);
    expect((await harness.call("browse_network", { method: "post" })).metadata?.count).toBe(1);

    seedNetwork(page);
    expect((await harness.call("browse_network", { status: 500 })).metadata?.count).toBe(1);

    seedNetwork(page);
    expect((await harness.call("browse_network", { failed_only: true })).metadata?.count).toBe(2);
  });

  it("caps the most recent entries", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const page = harness.page();
    seedNetwork(page);
    const result = await harness.call("browse_network", { limit: 1 });
    expect(result.metadata?.count).toBe(1);
    expect(result.metadata?.matched).toBe(3);
    expect(result.output).toContain("#3 GET FAILED");
  });

  it("keeps records across reads only until the cursor moves", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const page = harness.page();
    seedNetwork(page);
    expect((await harness.call("browse_network", { clear: false })).metadata?.count).toBe(3);
    expect(page.buffers.network.size).toBe(3);
    expect((await harness.call("browse_network")).metadata?.count).toBe(0);
  });

  it("answers an empty read without inventing records", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const result = await harness.call("browse_network");
    expect(result.metadata?.count).toBe(0);
    expect(result.output).toContain("No network records matched");
  });
});
