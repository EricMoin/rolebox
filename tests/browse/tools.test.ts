/**
 * The tool record itself: its exact surface, the shared failure contract, and the
 * two tools that do not act on page content (`browse_status`, `browse_close`).
 *
 * Everything runs against the in-memory driver port; no test here launches a
 * browser or imports Playwright.
 */

import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BROWSE_TOOL_NAMES } from "../../src/browse/tools.ts";
import { BROWSE_TOOL_NAMES as INDEXED_TOOL_NAMES, createBrowseTools } from "../../src/browse/index.ts";
import { browseError, type DialogState } from "../../src/browse/types.ts";
import {
  createBrowseHarness,
  type BrowseHarness,
  type StructuredToolResult,
} from "./helpers/fake-driver.ts";

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
  const metadata = result.metadata ?? {};
  expect(result.output.startsWith("Error: ")).toBe(true);
  expect(metadata.error).toBe(true);
  expect(metadata.code).toBe(code);
  expect(metadata.driver).toBe("playwright");
  expect(typeof metadata.action).toBe("string");
  expect(typeof metadata.session).toBe("string");
}

describe("browse tool surface", () => {
  it("exposes exactly the 23 declared names", () => {
    const harness = makeHarness();
    expect(Object.keys(harness.tools).sort()).toEqual([...BROWSE_TOOL_NAMES].sort());
    expect(BROWSE_TOOL_NAMES.length).toBe(23);
  });

  it("keeps the barrel export naming the same tools", () => {
    expect([...INDEXED_TOOL_NAMES]).toEqual([...BROWSE_TOOL_NAMES]);
    const tools = createBrowseTools();
    expect(Object.keys(tools).sort()).toEqual([...BROWSE_TOOL_NAMES].sort());
    // Constructing the record must not import Playwright or launch anything.
    expect(Object.values(tools).every(tool => typeof tool.execute === "function")).toBe(true);
  });

  it("describes every tool and defines an argument schema for each", () => {
    const harness = makeHarness();
    for (const name of BROWSE_TOOL_NAMES) {
      const tool = harness.tools[name];
      expect(tool).toBeDefined();
      expect(tool.description.length).toBeGreaterThan(60);
      expect(typeof tool.args).toBe("object");
      expect(typeof tool.execute).toBe("function");
    }
  });
});

describe("invalid arguments and the shared failure contract", () => {
  it("answers invalid arguments with one Error result instead of throwing", async () => {
    const harness = makeHarness();
    const cases: Array<[string, unknown]> = [
      ["browse_click", {}],
      ["browse_click", { target: 42 }],
      ["browse_type", { target: "e1" }],
      ["browse_press", { key: "" }],
      ["browse_select", { target: "e1", values: [] }],
      ["browse_scroll", { delta_x: "sideways" }],
      ["browse_eval", {}],
      ["browse_snapshot", { max_chars: 0 }],
      ["browse_cookies", { action: "delete" }],
      ["browse_tabs", { action: "explode" }],
      ["browse_open", { viewport: { width: "wide" } }],
      ["browse_dialog", { action: "dismiss", prompt_text: "x" }],
      ["browse_screenshot", { format: "png", quality: 80 }],
    ];
    for (const [name, args] of cases) {
      const result = await harness.call(name, args);
      expectFailure(result, "invalid_arguments");
      expect(result.metadata?.action).toBe(name);
    }
    expect(harness.factory.launchCount).toBe(0);
  });

  it("never throws when the page layer itself fails", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    await harness.call("browse_snapshot");
    harness.page().clickError = browseError("protocol_error", "the page exploded", "Retry once.");
    const result = await harness.call("browse_click", { target: "e1" });
    expectFailure(result, "protocol_error");
    expect(result.output).toContain("the page exploded");
    expect(result.output).toBe("Error: the page exploded; retry once.");
  });

  it("reports a cancelled call when the host turn is already aborted", async () => {
    const harness = makeHarness();
    const controller = new AbortController();
    controller.abort();
    const result = await harness.call("browse_snapshot", {}, harness.context({ abort: controller.signal }));
    expectFailure(result, "cancelled");
    expect(harness.factory.launchCount).toBe(0);
  });

  it("does not execute a click cancelled while it is waiting in the session queue", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const started = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const blocker = harness.manager.run("session-tools", async () => {
      started.resolve();
      await released.promise;
    });
    await started.promise;
    try {
      const controller = new AbortController();
      const click = harness.call("browse_click", { target: "css=#submit" }, harness.context({ abort: controller.signal }));
      controller.abort();
      expectFailure(await click, "cancelled");
    } finally {
      released.resolve();
      await blocker;
    }
    await harness.manager.info("session-tools");
    expect(harness.page().clickTargets).toHaveLength(0);
  });

  it("cancels a call whose turn ends mid-flight and keeps the session usable", async () => {
    const harness = makeHarness({
      configurePage(page) {
        page.delayMs = 50;
      },
    });
    const controller = new AbortController();
    const pending = harness.call("browse_snapshot", {}, harness.context({ abort: controller.signal }));
    setTimeout(() => controller.abort(), 1);
    const result = await pending;
    expectFailure(result, "cancelled");
    // An action already sent to the driver may finish after cancellation.
    const after = await harness.call("browse_snapshot");
    expect(after.metadata?.ref_count).toBe(3);
  });

  it("does not submit a field if cancellation arrives while it is being filled", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const controller = new AbortController();
    const fill = harness.page().fill.bind(harness.page());
    harness.page().fill = async (...args) => {
      const result = await fill(...args);
      controller.abort();
      return result;
    };
    const result = await harness.call("browse_type", {
      target: "css=#field", text: "hello", submit: true,
    }, harness.context({ abort: controller.signal }));
    expectFailure(result, "cancelled");
    await harness.manager.info("session-tools");
    expect(harness.page().calls).toContain("fill");
    expect(harness.page().calls).not.toContain("press");
  });

  it("uses a stable default session key when the host has no session id", async () => {
    const harness = makeHarness();
    const result = await harness.call("browse_status", {}, harness.context({ sessionID: "   " }));
    expect(result.metadata?.session).toBe("default");
  });

  it("still works after a cancelled call", async () => {
    const harness = makeHarness();
    const controller = new AbortController();
    controller.abort();
    await harness.call("browse_snapshot", {}, harness.context({ abort: controller.signal }));
    const snapshot = await harness.call("browse_snapshot");
    expect(snapshot.metadata?.ref_count).toBe(3);
  });

  it("runs every one of the 23 tools successfully and names itself in metadata.action", async () => {
    const harness = makeHarness();
    writeFileSync(join(harness.worktree, "upload.txt"), "payload");
    const dialog: DialogState = { type: "alert", message: "Heads up", defaultValue: "", open: true };

    await harness.call("browse_open", { url: "https://example.com/app" });
    await harness.call("browse_snapshot");
    harness.page().dialogState = dialog;

    const steps: Array<[string, () => Promise<StructuredToolResult>]> = [
      ["browse_status", () => harness.call("browse_status")],
      ["browse_open", () => harness.call("browse_open")],
      ["browse_snapshot", () => harness.call("browse_snapshot")],
      ["browse_read", () => harness.call("browse_read")],
      ["browse_click", () => harness.call("browse_click", { target: "e1" })],
      ["browse_drag", () => harness.call("browse_drag", { from: "e1", to: "e2" })],
      ["browse_type", () => harness.call("browse_type", { target: "e2", text: "hello" })],
      ["browse_press", () => harness.call("browse_press", { key: "Enter" })],
      ["browse_select", () => harness.call("browse_select", { target: "e3", values: ["pro"] })],
      ["browse_hover", () => harness.call("browse_hover", { target: "e1" })],
      ["browse_scroll", () => harness.call("browse_scroll")],
      ["browse_wait", () => harness.call("browse_wait", { text: "hello" })],
      ["browse_eval", () => harness.call("browse_eval", { expression: "1 + 1" })],
      ["browse_screenshot", () => harness.call("browse_screenshot")],
      ["browse_upload", () => harness.call("browse_upload", { target: "e2", paths: ["upload.txt"] })],
      ["browse_downloads", () => harness.call("browse_downloads")],
      ["browse_dialog", () => harness.call("browse_dialog", { action: "accept" })],
      ["browse_tabs", () => harness.call("browse_tabs", { action: "list" })],
      ["browse_history", () => harness.call("browse_history", { action: "reload" })],
      ["browse_console", () => harness.call("browse_console")],
      ["browse_network", () => harness.call("browse_network")],
      ["browse_cookies", () => harness.call("browse_cookies", { action: "get" })],
      ["browse_close", () => harness.call("browse_close")],
    ];

    expect(steps.map(([name]) => name).sort()).toEqual([...BROWSE_TOOL_NAMES].sort());
    for (const [name, run] of steps) {
      const result = await run();
      expect(result.metadata?.error).toBeUndefined();
      expect(result.metadata?.action).toBe(name);
      expect(result.metadata?.driver).toBe("playwright");
      expect(typeof result.metadata?.session).toBe("string");
      expect(result.output.startsWith("Error: ")).toBe(false);
      for (const key of ["page", "url", "title"]) {
        expect(result.metadata !== undefined && key in result.metadata).toBe(true);
      }
    }
  });

  it("keeps the canonical metadata envelope on every success", async () => {
    const harness = makeHarness();
    await harness.call("browse_open", { page: "work" });
    const results = [
      await harness.call("browse_snapshot", { page: "work" }),
      await harness.call("browse_read", { page: "work" }),
    ];
    for (const result of results) {
      for (const key of ["driver", "action", "session", "page", "url", "title"]) {
        expect(result.metadata && key in result.metadata).toBe(true);
      }
      expect(result.metadata?.driver).toBe("playwright");
      expect(result.metadata?.session).toBe("session-tools");
      expect(result.metadata?.page).toBe("work");
    }
  });
});

describe("browse_status", () => {
  it("reports the driver and an empty session without launching a browser", async () => {
    const harness = makeHarness({ version: "1.55.0", chromiumInstalled: true });
    const result = await harness.call("browse_status");

    expect(harness.factory.launchCount).toBe(0);
    expect(result.output).toContain("Playwright: available 1.55.0");
    expect(result.output).toContain("Chromium is installed");
    expect(result.output).toContain("no pages and no browser running");
    expect(result.output).toContain("No dialog is open");
    expect(result.metadata?.available).toBe(true);
    expect(result.metadata?.version).toBe("1.55.0");
    expect(result.metadata?.chromium_installed).toBe(true);
    expect(result.metadata?.session_count).toBe(0);
    expect(result.metadata?.page_count).toBe(0);
    expect(result.metadata?.dialog).toBeNull();
  });

  it("reports an unavailable driver with its install guidance", async () => {
    const harness = makeHarness({
      available: false,
      reason: "the playwright module is not resolvable from rolebox",
    });
    const result = await harness.call("browse_status");
    expect(result.output).toContain("Playwright: unavailable");
    expect(result.output).toContain("the playwright module is not resolvable");
    expect(result.output).toContain("Install:");
    expect(result.metadata?.available).toBe(false);
    expect(result.metadata?.guidance).toContain("playwright");
  });

  it("reports the active page, its tabs and a pending dialog without launching again", async () => {
    const harness = makeHarness();
    await harness.call("browse_open", { url: "https://example.com/app" });
    await harness.call("browse_tabs", { action: "new", page: "docs" });
    const dialog: DialogState = { type: "alert", message: "Disk full", defaultValue: "", open: true };
    harness.page(1).dialogState = dialog;

    const result = await harness.call("browse_status");
    expect(harness.factory.launchCount).toBe(1);
    expect(result.metadata?.page_count).toBe(2);
    expect(result.metadata?.active).toBe("docs");
    expect(result.metadata?.tabs).toEqual(["main", "docs"]);
    expect(result.metadata?.engine).toBe("chromium");
    expect(result.metadata?.dialog).toEqual(dialog);
    expect(result.output).toContain("Pending alert dialog");
    expect(result.output).toContain("Disk full");
  });
});

describe("browse_close", () => {
  it("closes one named page and keeps the browser and the other pages", async () => {
    const harness = makeHarness();
    await harness.call("browse_open", { page: "main" });
    await harness.call("browse_tabs", { action: "new", page: "docs" });

    const result = await harness.call("browse_close", { page: "docs" });
    expect(result.metadata?.closed).toBe("page");
    expect(result.metadata?.closed_page).toBe("docs");
    expect(result.metadata?.remaining).toBe(1);
    expect(result.metadata?.tabs).toEqual(["main"]);
    expect(result.metadata?.active).toBe("main");
    expect(result.output).toContain('Closed page "docs"');
    expect(harness.factory.launchCount).toBe(1);
  });

  it("closes the whole session when no page is given and the next call starts fresh", async () => {
    const harness = makeHarness();
    await harness.call("browse_open", { page: "main" });
    await harness.call("browse_tabs", { action: "new", page: "docs" });

    const closed = await harness.call("browse_close");
    expect(closed.metadata?.closed).toBe("session");
    expect(closed.metadata?.pages_closed).toBe(2);
    expect(closed.output).toContain("every page and its snapshot refs are gone");
    expect(harness.manager.sessionCount).toBe(0);

    const reopened = await harness.call("browse_open");
    expect(reopened.metadata?.created).toBe(true);
    expect(harness.factory.launchCount).toBe(2);
  });

  it("closes the session even when all is combined with a page name", async () => {
    const harness = makeHarness();
    await harness.call("browse_open", { page: "main" });
    const result = await harness.call("browse_close", { page: "main", all: true });
    expect(result.metadata?.closed).toBe("session");
    expect(harness.manager.sessionCount).toBe(0);
  });

  it("closes nothing when no session exists", async () => {
    const harness = makeHarness();
    const result = await harness.call("browse_close");
    expect(result.metadata?.pages_closed).toBe(0);
    expect(result.output).toContain("nothing to close");
    expect(harness.factory.launchCount).toBe(0);
  });

  it("fails with no_such_page when a named page is closed on an empty session", async () => {
    const harness = makeHarness();
    const result = await harness.call("browse_close", { page: "missing" });
    expectFailure(result, "no_such_page");
    expect(harness.factory.launchCount).toBe(0);
  });

  it("fails with no_such_page for a page name that is not open", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const result = await harness.call("browse_close", { page: "missing" });
    expectFailure(result, "no_such_page");
  });
});
