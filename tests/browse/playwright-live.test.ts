/**
 * The gated live smoke test for the real Playwright driver.
 *
 * It is skipped unless `ROLEBOX_BROWSE_LIVE=1`, because the default suite must
 * never launch a browser or touch the OS. When enabled it drives the production
 * launch path end to end: headless Chromium opens a data: page, the snapshot walker
 * prints a heading/button/textbox/select with refs, a click by ref changes the
 * DOM, a fill by ref writes an input value, and a screenshot comes back as PNG
 * bytes. The browser is closed in a finally path.
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { playwrightDriverFactory } from "../../src/browse/playwright-driver.ts";
import { BrowseSessionManager } from "../../src/browse/session.ts";
import { createBrowseTools } from "../../src/browse/tools.ts";
import type { CanonicalToolContext } from "../../src/platform/types.ts";
import { BrowseError, type BrowseDriver, type SnapshotRef } from "../../src/browse/types.ts";
import { hasPngSignature } from "../../src/computer/png.ts";
import { liveDialogUrl, livePageUrl } from "./fixtures/live-page.ts";

const live = process.env.ROLEBOX_BROWSE_LIVE === "1";
const scratchDirectories: string[] = [];

afterAll(() => {
  while (scratchDirectories.length > 0) {
    rmSync(scratchDirectories.pop()!, { recursive: true, force: true });
  }
});

function refFor(refs: readonly SnapshotRef[], name: string): SnapshotRef {
  const ref = refs.find(candidate => candidate.name === name);
  if (ref === undefined) {
    throw new Error(`no snapshot ref named "${name}" in ${JSON.stringify(refs)}`);
  }
  return ref;
}

describe.skipIf(!live)("playwright live", () => {
  it("reports script exceptions and navigation interruptions through browse_eval", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "rolebox-browse-evaluation-errors-"));
    scratchDirectories.push(worktree);
    const manager = new BrowseSessionManager({ worktree });
    const tools = createBrowseTools({ manager });
    const context: CanonicalToolContext = {
      sessionID: "s", messageID: "m", agent: "base", directory: worktree, worktree,
      abort: new AbortController().signal, metadata: () => undefined,
      ask: async () => undefined,
    };
    try {
      await tools.browse_open.execute({ url: livePageUrl() }, context);
      for (const [expression, message, hint] of [
        ["document.querySelector('#missing').getBoundingClientRect()", "TypeError:", "browse_wait"],
        ["(() =>", "SyntaxError:", "syntax"],
        ["missingVariable", "ReferenceError:", "page globals"],
        ["Promise.reject(new Error('rejected'))", "Error: rejected", "expression"],
        ["(() => { throw new DOMException('blocked', 'SecurityError'); })()", "SecurityError: blocked", "expression"],
        ["(() => { throw new Error('Target page, context or browser has been closed'); })()", "Error: Target page", "expression"],
        ["(() => { throw new Error('Timeout 100ms exceeded'); })()", "Error: Timeout", "expression"],
      ]) {
        const result = await tools.browse_eval.execute({ expression }, context);
        if (typeof result === "string") throw new Error(result);
        expect(result.metadata?.error).toBe(true);
        expect(result.metadata?.code).toBe("script_error");
        expect(result.output).toContain(message);
        expect(result.metadata?.hint).toContain(hint);
        expect(result.metadata?.hint).not.toMatch(/browse_status|driver|retry/i);
      }
      const navigation = await tools.browse_eval.execute({
        expression: "new Promise(() => { setTimeout(() => { location.href = 'about:blank'; }, 0); })",
      }, context);
      if (typeof navigation === "string") throw new Error(navigation);
      expect(navigation.metadata?.code).toBe("execution_context_destroyed");
      expect(navigation.metadata?.hint).toContain("browse_snapshot");
      const recovered = await tools.browse_eval.execute({ expression: "1 + 1" }, context);
      if (typeof recovered === "string") throw new Error(recovered);
      expect(recovered.metadata?.error).toBeUndefined();
      expect(recovered.output).toBe("2");
    } finally {
      await manager.dispose();
    }
  }, 120_000);

  it("never reassigns an old snapshot ref to a different button or page", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "rolebox-browse-refs-"));
    scratchDirectories.push(worktree);
    const manager = new BrowseSessionManager({ worktree });
    try {
      const first = await manager.run("s", async page => {
        await page.goto(`data:text/html,${encodeURIComponent('<button>Save</button>')}`);
        return page.snapshot();
      });
      await manager.run("s", page => page.evaluate(`document.body.innerHTML = '<button onclick="window.deleted = true">Delete</button>'`));
      const second = await manager.run("s", page => page.snapshot());
      expect(second.refs[0].ref).not.toBe(first.refs[0].ref);
      await expect(manager.run("s", page => page.click({ kind: "ref", ref: first.refs[0].ref })))
        .rejects.toMatchObject({ code: "stale_ref" });
      expect(await manager.run("s", page => page.evaluate<boolean>("window.deleted === true"))).toBe(false);
      await manager.run("s", page => page.click({ kind: "ref", ref: second.refs[0].ref }));
      expect(await manager.run("s", page => page.evaluate<boolean>("window.deleted === true"))).toBe(true);
      await manager.closePage("s");
      const third = await manager.run("s", async page => {
        await page.goto(`data:text/html,${encodeURIComponent('<button>Save</button>')}`);
        return page.snapshot();
      });
      expect(third.refs[0].ref).not.toBe(first.refs[0].ref);
      expect(third.refs[0].ref).not.toBe(second.refs[0].ref);
    } finally {
      await manager.dispose();
    }
  }, 120_000);

  for (const interruption of ["timeout", "cancelled"] as const) {
    it(`recovers the session queue after evaluation is ${interruption}`, async () => {
      const worktree = mkdtempSync(join(tmpdir(), "rolebox-browse-evaluation-"));
      scratchDirectories.push(worktree);
      let driver: BrowseDriver | undefined;
      const manager = new BrowseSessionManager({ worktree, driverFactory: {
        status: () => playwrightDriverFactory.status(),
        launch: async options => driver = await playwrightDriverFactory.launch(options),
      } });
      const tools = createBrowseTools({ manager });
      const controller = new AbortController();
      const context: CanonicalToolContext = {
        sessionID: "s", messageID: "m", agent: "base", directory: worktree, worktree,
        abort: new AbortController().signal, metadata: () => undefined,
        ask: async () => undefined,
      };
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let abortTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await tools.browse_open.execute({}, context);
        const evaluation = tools.browse_eval.execute({
          expression: "new Promise(() => {})", timeout_ms: interruption === "timeout" ? 30 : 5_000,
        }, { ...context, abort: controller.signal });
        if (interruption === "cancelled") abortTimer = setTimeout(() => controller.abort(), 30);
        const recovery = (async () => {
          const result = await evaluation;
          expect(typeof result).toBe("object");
          if (typeof result === "string") throw new Error(result);
          expect(result.metadata?.code).toBe(interruption);
          const opened = await tools.browse_open.execute({ url: livePageUrl() }, context);
          if (typeof opened === "string") throw new Error(opened);
          expect(opened.metadata?.error).toBeUndefined();
          const snapshot = await tools.browse_snapshot.execute({}, context);
          if (typeof snapshot === "string") throw new Error(snapshot);
          expect(snapshot.output).toContain("Live page");
        })();
        await Promise.race([
          recovery,
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(() => reject(new Error("session queue did not recover")), 5_000);
          }),
        ]);
      } finally {
        clearTimeout(deadline);
        clearTimeout(abortTimer);
        await driver?.close();
        await manager.dispose();
      }
    }, 120_000);
  }

  it("snapshots refs, clicks, fills and screenshots a data: page", async () => {
    const downloads = mkdtempSync(join(tmpdir(), "rolebox-browse-live-"));
    scratchDirectories.push(downloads);
    let driver: BrowseDriver | undefined;
    try {
      driver = await playwrightDriverFactory.launch({
        headless: true,
        downloadsDirectory: downloads,
      });
      expect(driver.owned).toBe(true);
      expect(driver.engine).toBe("chromium");

      const page = await driver.newPage();
      await page.goto(livePageUrl());
      expect(await page.title()).toBe("Browse live");

      const snapshot = await page.snapshot({ full: true });
      expect(snapshot.refCount).toBeGreaterThanOrEqual(3);
      expect(snapshot.text).toContain('- heading "Live page" [level=1]');
      expect(snapshot.text).toContain('- button "Run" [ref=');
      expect(snapshot.text).toContain('- textbox "Name" [ref=');
      expect(snapshot.text).toContain('- combobox "Pick" [ref=');
      expect(snapshot.text).toContain('- generic "Editable text" [ref=');
      expect(snapshot.text).toContain('- link "Docs" [ref=');
      expect(snapshot.text).toContain('[href="/docs"]');
      // An iframe is named by its source and its document is not entered.
      expect(snapshot.text).toContain('- iframe "about:blank"');
      // Hidden subtrees must not leak into the snapshot.
      expect(snapshot.text).not.toContain("hidden-value");
      expect(snapshot.text).not.toContain("invisible text");
      expect(snapshot.text).not.toContain("hidden span");
      expect(snapshot.text).not.toContain("hidden button");

      const button = refFor(snapshot.refs, "Run");
      const input = refFor(snapshot.refs, "Name");
      expect(button.ref).toMatch(/^e\d+$/);
      expect(input.ref).toMatch(/^e\d+$/);

      const click = await page.click({ kind: "ref", ref: button.ref });
      expect(click.target).toBe(`ref=${button.ref}`);
      expect(await page.evaluate<string>("document.getElementById('out').textContent")).toBe("clicked");

      const fill = await page.fill({ kind: "ref", ref: input.ref }, "Ada Lovelace");
      expect(fill.value).toBe("Ada Lovelace");
      expect(await page.evaluate<string>("document.getElementById('name').value")).toBe("Ada Lovelace");

      const screenshot = await page.screenshot({ fullPage: true });
      expect(screenshot.mime).toBe("image/png");
      expect(hasPngSignature(screenshot.bytes)).toBe(true);
      expect(screenshot.bytes.byteLength).toBeGreaterThan(1_000);

      // Reads cover text, markdown, links, HTML and markdown tables.
      expect((await page.read("text")).content).toContain("Live page");
      expect((await page.read("markdown")).content).toContain("Live page");
      expect((await page.read("links")).content).toContain("Docs");
      expect((await page.read("html")).content).toContain("<h1>");
      expect((await page.read("table")).content).toBe("(no tables found)");

      // Cookies live on the browser context, not the page.
      await page.setCookies([{ name: "live", value: "1", url: "https://example.com" }]);
      expect((await page.cookies()).some(cookie => cookie.name === "live")).toBe(true);
      await page.clearCookies();
      expect((await page.cookies()).some(cookie => cookie.name === "live")).toBe(false);

      // A selector scopes the walk, and the cap truncates on a line boundary.
      const scoped = await page.snapshot({ selector: "#editor", full: true });
      expect(scoped.text).toContain('- generic "Editable text" [ref=');
      expect(scoped.refs).toHaveLength(1);
      const truncated = await page.snapshot({ maxChars: 60 });
      expect(truncated.truncated).toBe(true);
      expect(truncated.text).toContain("[... truncated:");

      expect(page.isClosed()).toBe(false);
    } finally {
      await driver?.close();
    }
  }, 120_000);

  it("reports dialog_open for the action that opens a dialog and handles it only through the dialog port", async () => {
    let driver: BrowseDriver | undefined;
    try {
      driver = await playwrightDriverFactory.launch({ headless: true });
      const page = await driver.newPage();
      await page.goto(liveDialogUrl());

      const snapshot = await page.snapshot();
      const confirm = refFor(snapshot.refs, "Confirm");
      let dialogError: BrowseError | undefined;
      try {
        await page.click({ kind: "ref", ref: confirm.ref });
      } catch (error) {
        dialogError = error as BrowseError;
      }
      expect(dialogError).toBeInstanceOf(BrowseError);
      expect(dialogError!.code).toBe("dialog_open");
      expect(dialogError!.hint).toContain("browse_dialog");
      expect(await page.dialog()).toMatchObject({ type: "confirm", message: "Proceed?", open: true });

      // The page stays blocked: another action refuses instead of hanging.
      try {
        await page.snapshot();
        throw new Error("expected the snapshot to be refused");
      } catch (error) {
        expect((error as BrowseError).code).toBe("dialog_open");
      }

      await page.dismissDialog();
      expect(await page.dialog()).toBeNull();
      const after = await page.snapshot();
      expect(after.text).toContain('- button "Confirm" [ref=');
    } finally {
      await driver?.close();
    }
  }, 120_000);
});
