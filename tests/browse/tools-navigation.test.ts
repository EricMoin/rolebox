/**
 * Session and navigation tools: open, tabs, history, wait and page routing.
 *
 * The fake driver records navigations and tab calls, so these tests pin the
 * layer's own decisions — create vs reuse, launch settings, active page, ref
 * invalidation after navigation, and the exactly-one-condition rule of
 * `browse_wait` — without a browser.
 */

import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  createBrowseHarness,
  HARNESS_TITLE,
  HARNESS_URL,
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
  expect(result.output.startsWith("Error: ")).toBe(true);
  expect(result.metadata?.error).toBe(true);
  expect(result.metadata?.code).toBe(code);
}

describe("browse_open", () => {
  it("creates the default page, navigates, and reports the result", async () => {
    const harness = makeHarness();
    const result = await harness.call("browse_open", { url: HARNESS_URL });

    expect(result.metadata?.created).toBe(true);
    expect(result.metadata?.navigated).toBe(true);
    expect(result.metadata?.status).toBe(200);
    expect(result.metadata?.browser).toBe("chromium");
    expect(result.metadata?.headless).toBe(true);
    expect(result.metadata?.page).toBe("main");
    expect(result.metadata?.url).toBe(HARNESS_URL);
    expect(result.metadata?.title).toBe(HARNESS_TITLE);
    expect(result.output).toContain('Created page "main" in chromium');
    expect(result.output).toContain("browse_snapshot");
    expect(result.metadata?.wait_until).toBe("domcontentloaded");
    expect(result.metadata?.timeout_ms).toBe(30_000);
    expect(harness.page().currentUrl).toBe(HARNESS_URL);
  });

  it("accepts an explicit wait_until and timeout", async () => {
    const harness = makeHarness();
    const result = await harness.call("browse_open", {
      url: HARNESS_URL,
      wait_until: "networkidle",
      timeout_ms: 5_000,
    });
    expect(result.metadata?.wait_until).toBe("networkidle");
    expect(result.metadata?.timeout_ms).toBe(5_000);
  });

  it("creates a named page and reuses it instead of opening a second tab", async () => {
    const harness = makeHarness();
    const first = await harness.call("browse_open", { page: "docs", url: HARNESS_URL });
    const second = await harness.call("browse_open", { page: "docs" });

    expect(first.metadata?.created).toBe(true);
    expect(second.metadata?.created).toBe(false);
    expect(second.metadata?.navigated).toBe(false);
    expect(second.metadata?.page_count).toBe(1);
    expect(second.output).toContain('Reused page "docs"');
    expect(harness.factory.lastDriver?.pages.length).toBe(1);
  });

  it("does not navigate when no url is given", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const callsBefore = [...harness.page().calls];
    const result = await harness.call("browse_open");
    expect(result.metadata?.navigated).toBe(false);
    expect(harness.page().calls).toEqual(callsBefore);
  });

  it("passes engine, headless and viewport to the launch", async () => {
    const harness = makeHarness();
    await harness.call("browse_open", {
      browser: "firefox",
      headless: false,
      viewport: { width: 800, height: 600 },
    });
    expect(harness.factory.launchOptions[0].engine).toBe("firefox");
    expect(harness.factory.launchOptions[0].headless).toBe(false);
    expect(harness.factory.launchOptions[0].viewport).toEqual({ width: 800, height: 600 });
    expect(harness.factory.launchOptions[0].downloadsDirectory).toBe(join(harness.worktree, ".rolebox", "browse", "downloads"));
  });

  it("defaults the viewport to 1440x900", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    expect(harness.factory.launchOptions[0].viewport).toEqual({ width: 1440, height: 900 });
  });

  it("rejects a bad URL before launching anything", async () => {
    const harness = makeHarness();
    const relative = await harness.call("browse_open", { url: "example.com" });
    expectFailure(relative, "invalid_arguments");
    expect(relative.output).toContain("is not absolute");
    expect(harness.factory.launchCount).toBe(0);

    const scheme = await harness.call("browse_open", { url: "javascript:alert(1)" });
    expectFailure(scheme, "invalid_arguments");
    expect(scheme.output).toContain("javascript:");
    expect(harness.factory.launchCount).toBe(0);
  });

  it("keeps sessions separate by session id", async () => {
    const harness = makeHarness();
    await harness.call("browse_open", { page: "one" }, harness.context({ sessionID: "session-a" }));
    const other = await harness.call("browse_status", {}, harness.context({ sessionID: "session-b" }));
    expect(other.metadata?.page_count).toBe(0);
    expect(harness.manager.sessionCount).toBe(1);
  });
});

describe("browse_tabs", () => {
  it("lists tabs without launching a browser", async () => {
    const harness = makeHarness();
    const result = await harness.call("browse_tabs", { action: "list" });
    expect(result.metadata?.count).toBe(0);
    expect(result.output).toContain("No pages are open");
    expect(harness.factory.launchCount).toBe(0);
  });

  it("creates, lists, selects and closes named pages", async () => {
    const harness = makeHarness();
    await harness.call("browse_open", { page: "main" });

    const created = await harness.call("browse_tabs", { action: "new", page: "docs", url: HARNESS_URL });
    expect(created.metadata?.action_name).toBe("new");
    expect(created.metadata?.active).toBe("docs");
    expect(created.metadata?.tabs).toEqual(["main", "docs"]);
    expect(created.metadata?.navigated).toBe(true);
    expect(created.metadata?.status).toBe(200);

    const listed = await harness.call("browse_tabs", { action: "list" });
    expect(listed.metadata?.count).toBe(2);
    expect(listed.metadata?.active).toBe("docs");
    expect(listed.output).toContain("* docs (active)");
    expect(listed.output).toContain("- main");

    const selected = await harness.call("browse_tabs", { action: "select", page: "main" });
    expect(selected.metadata?.active).toBe("main");
    expect(selected.output).toContain('Active page is now "main"');

    const closed = await harness.call("browse_tabs", { action: "close", page: "docs" });
    expect(closed.metadata?.count).toBe(1);
    expect(closed.metadata?.tabs).toEqual(["main"]);
    expect(harness.factory.launchCount).toBe(1);
  });

  it("closes the active page when action=close names none", async () => {
    const harness = makeHarness();
    await harness.call("browse_open", { page: "main" });
    await harness.call("browse_tabs", { action: "new", page: "docs" });
    const result = await harness.call("browse_tabs", { action: "close" });
    expect(result.metadata?.count).toBe(1);
    expect(result.metadata?.active).toBe("main");
  });

  it("closes nothing in an empty session", async () => {
    const harness = makeHarness();
    const result = await harness.call("browse_tabs", { action: "close" });
    expect(result.metadata?.count).toBe(0);
    expect(result.metadata?.action_name).toBe("close");
    expect(result.output).toContain("nothing to close");
    expect(harness.factory.launchCount).toBe(0);
  });

  it("rejects arguments that do not belong to the action", async () => {
    const harness = makeHarness();
    const listWithPage = await harness.call("browse_tabs", { action: "list", page: "main" });
    expectFailure(listWithPage, "invalid_arguments");

    const newWithoutPage = await harness.call("browse_tabs", { action: "new" });
    expectFailure(newWithoutPage, "invalid_arguments");

    const selectWithoutPage = await harness.call("browse_tabs", { action: "select" });
    expectFailure(selectWithoutPage, "invalid_arguments");

    await harness.call("browse_open");
    const urlOnSelect = await harness.call("browse_tabs", { action: "select", page: "main", url: HARNESS_URL });
    expectFailure(urlOnSelect, "invalid_arguments");
    expect(harness.factory.launchCount).toBe(1);
  });

  it("fails with no_such_page when selecting a page that was never created", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const result = await harness.call("browse_tabs", { action: "select", page: "ghost" });
    expectFailure(result, "no_such_page");
    expect(result.output).toContain("browse_tabs action=new");
  });

  it("routes page arguments to the named page", async () => {
    const harness = makeHarness();
    await harness.call("browse_open", { page: "main" });
    await harness.call("browse_tabs", { action: "new", page: "docs" });
    await harness.call("browse_snapshot", { page: "main" });
    expect(harness.factory.lastDriver?.pages[0].calls).toContain("snapshot:page");
    expect(harness.factory.lastDriver?.pages[1].calls).not.toContain("snapshot:page");
    expect(harness.factory.lastDriver?.pages[0].calls.filter(call => call === "snapshot")).toHaveLength(1);
  });
});

describe("browse_history", () => {
  it("goes back, forward and reloads, clearing refs each time", async () => {
    const harness = makeHarness();
    await harness.call("browse_open", { url: HARNESS_URL });
    await harness.call("browse_snapshot");

    const reloaded = await harness.call("browse_history", { action: "reload" });
    expect(reloaded.metadata?.history_action).toBe("reload");
    expect(reloaded.metadata?.refs_reset).toBe(true);
    expect(reloaded.output).toContain("Reloaded");
    expect(harness.page().calls).toContain("reload");

    const stale = await harness.call("browse_click", { target: "e1" });
    expectFailure(stale, "stale_ref");
    expect(stale.output).toContain("browse_snapshot");

    const back = await harness.call("browse_history", { action: "back" });
    expect(back.metadata?.history_action).toBe("back");
    const forward = await harness.call("browse_history", { action: "forward" });
    expect(forward.metadata?.history_action).toBe("forward");
    expect(harness.page().calls).toEqual(expect.arrayContaining(["back", "forward"]));
  });

  it("rejects an unknown action", async () => {
    const harness = makeHarness();
    const result = await harness.call("browse_history", { action: "jump" });
    expectFailure(result, "invalid_arguments");
    expect(harness.factory.launchCount).toBe(0);
  });

  it("uses the navigation timeout by default and accepts an override", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const defaulted = await harness.call("browse_history", { action: "reload" });
    expect(defaulted.metadata?.timeout_ms).toBe(30_000);
    const overridden = await harness.call("browse_history", { action: "reload", timeout_ms: 5_000 });
    expect(overridden.metadata?.timeout_ms).toBe(5_000);
  });
});

describe("browse_wait", () => {
  it("waits for text", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const result = await harness.call("browse_wait", { text: "Welcome" });
    expect(result.metadata?.waited_for).toBe("text");
    expect(result.metadata?.value).toBe("Welcome");
    expect(result.metadata?.timeout_ms).toBe(5_000);
    expect(result.output).toContain('text "Welcome" appeared');
    expect(harness.page().calls).toContain("wait");
  });

  it("waits for a selector and for a URL", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const selector = await harness.call("browse_wait", { selector: "#app", timeout_ms: 1_000 });
    expect(selector.metadata?.waited_for).toBe("selector");
    expect(selector.metadata?.timeout_ms).toBe(1_000);
    expect(selector.output).toContain("#app appeared");

    const url = await harness.call("browse_wait", { url: "/dashboard" });
    expect(url.metadata?.waited_for).toBe("url");
    expect(url.output).toContain("the page URL contains");
  });

  it("waits for a lifecycle state first when state is given", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const result = await harness.call("browse_wait", { text: "Ready", state: "networkidle" });
    expect(result.metadata?.state).toBe("networkidle");
    expect(harness.page().calls).toContain("waitForLoadState");
  });

  it("requires exactly one of text, selector and url", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const none = await harness.call("browse_wait", {});
    expectFailure(none, "invalid_arguments");
    expect(none.output).toContain("none was given");

    const two = await harness.call("browse_wait", { text: "a", selector: "#b" });
    expectFailure(two, "invalid_arguments");
    expect(two.output).toContain("2 were given");

    const three = await harness.call("browse_wait", { text: "a", selector: "#b", url: "/c" });
    expectFailure(three, "invalid_arguments");
  });
});
