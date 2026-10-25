/**
 * The session manager against the in-memory driver port.
 *
 * These tests are browser-free by construction: no test imports Playwright or
 * launches a process. They pin the layer's own contracts — lazy launch, one
 * serialized queue per session, the named-page limit, ref replacement and
 * invalidation (including the `element_not_found` → `stale_ref` translation),
 * read-since-cursor buffers, dialog delegation, idle expiry, and dispose.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BROWSE_DOWNLOAD_SUBDIRECTORY,
  BrowseSessionManager,
  DEFAULT_MAX_PAGES,
  DEFAULT_PAGE_NAME,
  normalizePageName,
} from "../../src/browse/session.ts";
import { parseTarget } from "../../src/browse/target.ts";
import { BROWSE_BUFFER_LIMITS, BrowseError, BrowseEventBuffer, browseError, type BrowseErrorCode, type SnapshotRef } from "../../src/browse/types.ts";
import { FakeDriverFactory } from "./fixtures/fake-driver.ts";

const worktrees: string[] = [];

function makeWorktree(): string {
  const directory = mkdtempSync(join(tmpdir(), "rolebox-browse-session-"));
  worktrees.push(directory);
  return directory;
}

afterEach(() => {
  while (worktrees.length > 0) rmSync(worktrees.pop()!, { recursive: true, force: true });
});

async function expectBrowseError(promise: Promise<unknown>, code: BrowseErrorCode): Promise<BrowseError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BrowseError);
    const browse = error as BrowseError;
    expect(browse.code).toBe(code);
    return browse;
  }
  throw new Error(`expected a ${code} failure`);
}

const REFS: SnapshotRef[] = [
  { ref: "e1", role: "button", name: "Save" },
  { ref: "e2", role: "textbox", name: "Email" },
];

function configuredFactory(overrides: ConstructorParameters<typeof FakeDriverFactory>[0] = {}): FakeDriverFactory {
  return new FakeDriverFactory({
    configurePage(page) {
      page.snapshotText = '- button "Save" [ref=e1]\n- textbox "Email" [ref=e2]';
      page.snapshotRefs = [...REFS];
    },
    ...overrides,
  });
}

describe("BrowseSessionManager lifecycle", () => {
  it("launches lazily, creates the default page, and passes the download directory", async () => {
    const worktree = makeWorktree();
    const factory = configuredFactory();
    const manager = new BrowseSessionManager({ worktree, driverFactory: factory });

    expect(factory.launchCount).toBe(0);
    const info = await manager.ensure("session-one");

    expect(factory.launchCount).toBe(1);
    expect(info.session).toBe("session-one");
    expect(info.active).toBe(DEFAULT_PAGE_NAME);
    expect(info.pages.map(page => page.name)).toEqual([DEFAULT_PAGE_NAME]);
    expect(info.engine).toBe("chromium");
    expect(info.attached).toBe(false);
    expect(factory.launchOptions[0].engine).toBe("chromium");
    expect(factory.launchOptions[0].headless).toBe(true);
    expect(factory.launchOptions[0].downloadsDirectory).toBe(join(worktree, BROWSE_DOWNLOAD_SUBDIRECTORY));

    await manager.dispose();
    expect(factory.lastDriver!.closed).toBe(true);
  });

  it("reports an unavailable driver without launching", async () => {
    const factory = new FakeDriverFactory({ available: false, reason: "the playwright module is not resolvable" });
    const manager = new BrowseSessionManager({ worktree: makeWorktree(), driverFactory: factory });

    const error = await expectBrowseError(manager.run("s", page => page.goto("https://example.com")), "driver_unavailable");
    expect(error.message).toContain("not resolvable");
    expect(error.hint).toContain("playwright install");
    expect(factory.launchCount).toBe(0);
    await manager.dispose();
  });

  it("serializes operations for one session and allows different sessions in parallel", async () => {
    let started = 0;
    const factory = configuredFactory({
      configurePage(page) {
        page.delayMs = 15;
        page.snapshotRefs = [...REFS];
      },
    });
    const manager = new BrowseSessionManager({ worktree: makeWorktree(), driverFactory: factory });

    const track = async <T>(task: Promise<T>): Promise<T> => {
      started += 1;
      try {
        return await task;
      } finally {
        started -= 1;
      }
    };

    await track(manager.run("one", page => page.goto("https://example.com/1")));
    await Promise.all([
      track(manager.run("one", page => page.goto("https://example.com/2"))),
      track(manager.run("one", page => page.goto("https://example.com/3"))),
      track(manager.run("one", page => page.snapshot())),
    ]);

    expect(factory.drivers[0].pages[0].maxConcurrent).toBe(1);
    await manager.dispose();
  });

  it("closes every session on dispose and refuses further work", async () => {
    const factory = configuredFactory();
    const manager = new BrowseSessionManager({ worktree: makeWorktree(), driverFactory: factory });
    await manager.ensure("a");
    await manager.ensure("b");
    expect(manager.sessionCount).toBe(2);

    await manager.dispose();

    expect(manager.sessionCount).toBe(0);
    expect(factory.drivers.every(driver => driver.closed)).toBe(true);
    await expectBrowseError(manager.run("a", page => page.goto("https://example.com")), "protocol_error");
  });

  it("keeps a session registered when its queued close is cancelled", async () => {
    const factory = configuredFactory();
    const manager = new BrowseSessionManager({ worktree: makeWorktree(), driverFactory: factory });
    const started = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const blocker = manager.run("s", async () => {
      started.resolve();
      await released.promise;
    });
    await started.promise;
    try {
      const controller = new AbortController();
      const close = manager.close("s", controller.signal);
      controller.abort();
      const rejection = expectBrowseError(close, "cancelled");
      released.resolve();
      await blocker;
      await rejection;
      expect(manager.sessionCount).toBe(1);
      expect(factory.lastDriver!.closed).toBe(false);
      expect((await manager.info("s")).pages).toHaveLength(1);
    } finally {
      released.resolve();
      await manager.dispose();
    }
  });
});

describe("BrowseSessionManager refs", () => {
  it("replaces the ref map from a snapshot and resolves a known ref", async () => {
    const factory = configuredFactory();
    const manager = new BrowseSessionManager({ worktree: makeWorktree(), driverFactory: factory });

    await manager.run("s", async page => {
      const snapshot = await page.snapshot();
      expect(snapshot.refCount).toBe(2);
      expect([...page.refs.keys()]).toEqual(["e1", "e2"]);

      const result = await page.click(parseTarget("e1"));
      expect(result.target).toBe("ref=e1");
      expect(factory.lastPage!.clickTargets[0]).toEqual({ kind: "ref", ref: "e1" });
    });

    await manager.dispose();
  });

  it("refuses a ref that was never in a snapshot", async () => {
    const factory = configuredFactory();
    const manager = new BrowseSessionManager({ worktree: makeWorktree(), driverFactory: factory });

    await manager.run("s", async page => {
      const error = await expectBrowseError(page.click(parseTarget("e9")), "stale_ref");
      expect(error.message).toContain("e9");
      expect(error.hint).toContain("browse_snapshot");
    });

    expect(factory.lastPage!.clickTargets).toHaveLength(0);
    await manager.dispose();
  });

  it("drops refs on navigation", async () => {
    const factory = configuredFactory();
    const manager = new BrowseSessionManager({ worktree: makeWorktree(), driverFactory: factory });

    await manager.run("s", async page => {
      await page.snapshot();
      await page.goto("https://example.com/next");
      expect(page.refs.size).toBe(0);
      const error = await expectBrowseError(page.click(parseTarget("e1")), "stale_ref");
      expect(error.hint).toContain("browse_snapshot");
    });

    await manager.dispose();
  });

  it("replaces refs on the next snapshot so an old ref is stale", async () => {
    const factory = configuredFactory({
      configurePage(page) {
        page.snapshotRefs = [{ ref: "e1", role: "button", name: "First" }];
      },
    });
    const manager = new BrowseSessionManager({ worktree: makeWorktree(), driverFactory: factory });

    await manager.run("s", async page => {
      await page.snapshot();
      factory.lastPage!.snapshotRefs = [{ ref: "e2", role: "button", name: "Second" }];
      await page.snapshot();
      expect([...page.refs.keys()]).toEqual(["e2"]);
      await expectBrowseError(page.click(parseTarget("e1")), "stale_ref");
      await page.click(parseTarget("e2"));
    });

    await manager.dispose();
  });

  it("translates a vanished ref into stale_ref and forgets it", async () => {
    const factory = configuredFactory();
    const manager = new BrowseSessionManager({ worktree: makeWorktree(), driverFactory: factory });

    await manager.run("s", async page => {
      await page.snapshot();
      factory.lastPage!.clickError = browseError("element_not_found", "no element matches selector");
      const error = await expectBrowseError(page.click(parseTarget("e1")), "stale_ref");
      expect(error.message).toContain("Save");
      expect(error.hint).toContain("browse_snapshot");
      expect(page.refs.has("e1")).toBe(false);
    });

    await manager.dispose();
  });

  it("falls back to refs parsed from snapshot text when a driver returns none", async () => {
    const factory = new FakeDriverFactory({
      configurePage(page) {
        page.snapshotText = '- button "Parsed" [ref=e4]';
        page.snapshotRefs = [];
      },
    });
    const manager = new BrowseSessionManager({ worktree: makeWorktree(), driverFactory: factory });

    await manager.run("s", async page => {
      await page.snapshot();
      expect([...page.refs.keys()]).toEqual(["e4"]);
      await page.click(parseTarget("e4"));
    });

    await manager.dispose();
  });
});

describe("BrowseSessionManager pages", () => {
  it("creates, selects and closes named pages", async () => {
    const factory = configuredFactory();
    const manager = new BrowseSessionManager({ worktree: makeWorktree(), driverFactory: factory });

    const initial = await manager.ensure("s");
    expect(initial.active).toBe("main");

    const withTab = await manager.newPage("s", "checkout");
    expect(withTab.active).toBe("checkout");
    expect(withTab.pages.map(page => page.name)).toEqual(["main", "checkout"]);

    const selected = await manager.selectPage("s", "main");
    expect(selected.active).toBe("main");
    expect(selected.pages.find(page => page.name === "checkout")!.active).toBe(false);

    const duplicate = await expectBrowseError(manager.newPage("s", "checkout"), "protocol_error");
    expect(duplicate.message).toContain("already exists");

    const missing = await expectBrowseError(manager.selectPage("s", "nope"), "no_such_page");
    expect(missing.message).toContain("nope");

    const closed = await manager.closePage("s", "checkout");
    expect(closed.pages.map(page => page.name)).toEqual(["main"]);

    await manager.dispose();
  });

  it("enforces the eight-page limit", async () => {
    const factory = configuredFactory();
    const manager = new BrowseSessionManager({ worktree: makeWorktree(), driverFactory: factory });
    await manager.ensure("s");
    for (let index = 1; index < DEFAULT_MAX_PAGES; index += 1) {
      await manager.newPage("s", `tab-${index}`);
    }
    const error = await expectBrowseError(manager.newPage("s", "too-many"), "page_limit");
    expect(error.hint).toContain("browse_tab");
    await manager.dispose();
  });

  it("binds an operation to a named page and rejects an unknown one", async () => {
    const factory = configuredFactory();
    const manager = new BrowseSessionManager({ worktree: makeWorktree(), driverFactory: factory });

    await manager.newPage("s", "detail");
    await manager.run("s", async page => {
      expect(page.name).toBe("detail");
    });
    await expectBrowseError(
      manager.run("s", inner => inner.goto("https://example.com"), { page: "missing" }),
      "no_such_page",
    );

    await manager.dispose();
  });

  it("validates page names", () => {
    expect(normalizePageName("  checkout-2  ")).toBe("checkout-2");
    expect(() => normalizePageName("  ")).toThrow(BrowseError);
    expect(() => normalizePageName("has spaces")).toThrow(BrowseError);
    expect(() => normalizePageName("x".repeat(41))).toThrow(BrowseError);
  });
});

describe("BrowseSessionManager buffers and dialogs", () => {
  it("reads buffers since a cursor and clears them", async () => {
    const factory = configuredFactory();
    const manager = new BrowseSessionManager({ worktree: makeWorktree(), driverFactory: factory });

    await manager.run("s", async page => {
      await page.goto("https://example.com");
      const driverPage = factory.lastPage!;

      driverPage.pushConsole("one");
      const first = page.console();
      expect(first.entries.map(entry => entry.text)).toEqual(["one"]);
      expect(first.cursor).toBe(1);

      driverPage.pushConsole("two");
      expect(page.console().entries.map(entry => entry.text)).toEqual(["two"]);
      expect(page.console().entries).toEqual([]);
      expect(page.console(0).entries.map(entry => entry.text)).toEqual(["one", "two"]);

      driverPage.pushNetwork("https://example.com/app.js");
      expect(page.network().entries.map(entry => entry.url)).toEqual(["https://example.com/app.js"]);
      driverPage.pushDownload("report.csv");
      expect(page.downloads().entries.map(entry => entry.filename)).toEqual(["report.csv"]);
      expect(driverPage.buffers.downloads.read(0).entries[0].status).toBe("completed");

      page.clearBuffers("console");
      expect(page.console().entries).toEqual([]);
      expect(page.console(0).entries).toEqual([]);
      page.clearBuffers();
      expect(page.network().entries).toEqual([]);
      expect(page.downloads().entries).toEqual([]);
    });

    await manager.dispose();
  });

  it("caps its buffers at the documented sizes and keeps the cursor moving", () => {
    expect(BROWSE_BUFFER_LIMITS).toEqual({ console: 1000, network: 2000, downloads: 100 });

    const buffer = new BrowseEventBuffer<{ seq: number; text: string }>(2);
    buffer.push({ text: "a" });
    buffer.push({ text: "b" });
    buffer.push({ text: "c" });

    expect(buffer.size).toBe(2);
    expect(buffer.read(0).entries.map(entry => entry.text)).toEqual(["b", "c"]);
    expect(buffer.cursor).toBe(3);
    expect(buffer.read(2).entries.map(entry => entry.text)).toEqual(["c"]);
    expect(buffer.read(3).entries).toEqual([]);

    buffer.clear();
    expect(buffer.size).toBe(0);
    expect(buffer.read(0).entries).toEqual([]);
  });

  it("delegates dialogs and acceptance", async () => {
    const factory = configuredFactory();
    const manager = new BrowseSessionManager({ worktree: makeWorktree(), driverFactory: factory });

    await manager.run("s", async page => {
      expect(await page.dialog()).toBeNull();
      factory.lastPage!.dialogState = { type: "confirm", message: "Sure?", defaultValue: "", open: true };
      expect(await page.dialog()).toEqual({ type: "confirm", message: "Sure?", defaultValue: "", open: true });

      await page.acceptDialog("yes");
      expect(factory.lastPage!.acceptedDialogs).toEqual(["yes"]);

      factory.lastPage!.dialogState = { type: "alert", message: "Hi", defaultValue: "", open: true };
      await page.dismissDialog();
      expect(factory.lastPage!.dismissCount).toBe(1);
    });

    await manager.dispose();
  });
});

describe("BrowseSessionManager idle and attach mode", () => {
  for (const action of ["pages", "info", "select", "close"] as const) {
    it(`still expires after ${action} refreshes its activity time`, async () => {
      let clock = 0;
      const factory = configuredFactory();
      const manager = new BrowseSessionManager({
        worktree: makeWorktree(), driverFactory: factory, now: () => clock, idleTtlMs: 30,
      });
      try {
        await manager.ensure("s");
        if (action === "close") await manager.newPage("s", "extra");
        clock = 10;
        if (action === "pages") await manager.pages("s");
        if (action === "info") await manager.info("s");
        if (action === "select") await manager.selectPage("s", "main");
        if (action === "close") await manager.closePage("s", "extra");
        clock = 30;
        await new Promise(resolve => setTimeout(resolve, 80));
        expect(manager.sessionCount).toBe(1);
        clock = 100;
        await new Promise(resolve => setTimeout(resolve, 80));
        expect(manager.sessionCount).toBe(0);
        expect(factory.lastDriver!.closed).toBe(true);
      } finally {
        await manager.dispose();
      }
    });
  }

  it("closes a session after its idle TTL using the injected clock", async () => {
    let clock = 1_000;
    const factory = configuredFactory();
    const manager = new BrowseSessionManager({
      worktree: makeWorktree(),
      driverFactory: factory,
      now: () => clock,
      idleTtlMs: 100,
    });

    await manager.ensure("idle-session");
    expect(manager.sessionCount).toBe(1);

    clock += 50;
    expect(await manager.sweepIdle()).toEqual([]);
    expect(manager.sessionCount).toBe(1);

    clock += 100;
    expect(await manager.sweepIdle()).toEqual(["idle-session"]);
    expect(manager.sessionCount).toBe(0);
    expect(factory.lastDriver!.closed).toBe(true);

    await manager.dispose();
  });

  it("reports an attached browser and still closes its driver", async () => {
    const factory = configuredFactory({ owned: false });
    const manager = new BrowseSessionManager({ worktree: makeWorktree(), driverFactory: factory });

    const info = await manager.ensure("attach");
    expect(info.attached).toBe(true);

    await manager.dispose();
    expect(factory.lastDriver!.closeCount).toBe(1);
    expect(factory.lastDriver!.closed).toBe(true);
  });
});
