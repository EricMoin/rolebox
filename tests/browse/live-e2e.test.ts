import { setTimeout as sleep } from "node:timers/promises";


import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowseTools } from "../../src/browse/tools.ts";
import { BrowseSessionManager } from "../../src/browse/session.ts";
import { parseSnapshotRefs } from "../../src/browse/snapshot.ts";
import { hasPngSignature } from "../../src/computer/png.ts";
import type { CanonicalToolContext, CanonicalToolDef, ToolResult } from "../../src/platform/types.ts";
import type { BrowseEngine, SnapshotRef } from "../../src/browse/types.ts";
import {
  FIXTURE_SECOND_PATH,
  startFixtureSite,
  type FixtureSite,
} from "./fixtures/fixture-site.ts";

const live = process.env.ROLEBOX_BROWSE_LIVE === "1";
const requestedEngine = process.env.ROLEBOX_BROWSE_ENGINE ?? "chromium";
if (!["chromium", "firefox", "webkit"].includes(requestedEngine)) throw new Error("Unsupported ROLEBOX_BROWSE_ENGINE.");
const engine = requestedEngine as BrowseEngine;

let site: FixtureSite;
const scratchDirectories: string[] = [];

beforeAll(async () => {
  site = await startFixtureSite();
});

afterAll(async () => {
  await site?.close();
  while (scratchDirectories.length > 0) {
    rmSync(scratchDirectories.pop()!, { recursive: true, force: true });
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** One live tool surface: a real manager, the real Playwright driver and a context. */
interface LiveTurn {
  readonly worktree: string;
  readonly manager: BrowseSessionManager;
  call(name: string, args?: unknown): Promise<ToolResult>;
}

/** A download entry as `browse_downloads` reports it. */
interface RecordedDownload {
  filename: string;
  status: string;
  path?: string;
  bytes?: number;
}

/**
 * Run one test against a fresh manager and worktree, and always dispose the
 * browser afterwards — including when an assertion throws.
 */
async function withBrowse(run: (turn: LiveTurn) => Promise<void>): Promise<void> {
  const worktree = mkdtempSync(join(tmpdir(), "rolebox-browse-live-e2e-"));
  scratchDirectories.push(worktree);
  const manager = new BrowseSessionManager({ worktree, idleTtlMs: 0, engine });
  const tools: Record<string, CanonicalToolDef> = createBrowseTools({ manager });
  const controller = new AbortController();
  const context: CanonicalToolContext = {
    sessionID: "live-e2e",
    messageID: "live-e2e-message",
    agent: "agent",
    directory: worktree,
    worktree,
    abort: controller.signal,
    metadata() {},
    async ask() {},
  };
  try {
    await run({
      worktree,
      manager,
      async call(name, args = {}) {
        const tool = tools[name];
        if (tool === undefined) throw new Error(`unknown browse tool ${name}`);
        return tool.execute((name === "browse_open" ? { browser: engine, ...(args as Record<string, unknown>) } : args) as never, context);
      },
    });
  } finally {
    await manager.dispose();
  }
}

/** The structured branch of a tool result. */
function structured(result: ToolResult, label: string): {
  output: string;
  metadata: Record<string, unknown>;
  attachments: NonNullable<Extract<ToolResult, { output: string }>["attachments"]>;
} {
  if (typeof result === "string") throw new Error(`${label} returned a bare string: ${JSON.stringify(result)}`);
  return {
    output: result.output,
    metadata: (result.metadata ?? {}) as Record<string, unknown>,
    attachments: result.attachments ?? [],
  };
}

/** Assert a call succeeded and return its output and metadata. */
function ok(result: ToolResult, label: string): ReturnType<typeof structured> {
  const parsed = structured(result, label);
  if (parsed.metadata.error === true) throw new Error(`${label} failed: ${parsed.output}`);
  return parsed;
}

/** Assert a call failed with one specific code and return its sentence. */
function refused(result: ToolResult, code: string, label: string): string {
  const parsed = structured(result, label);
  expect(parsed.metadata.error, label).toBe(true);
  expect(parsed.metadata.code, `${label} code`).toBe(code);
  return parsed.output;
}

/** The ref the latest snapshot printed for one role/name pair. */
function refOf(text: string, role: string, name: string): string {
  const ref: SnapshotRef | undefined = parseSnapshotRefs(text)
    .find(entry => entry.role === role && entry.name === name);
  if (ref === undefined) {
    throw new Error(`the snapshot has no ${role} "${name}":\n${text}`);
  }
  return ref.ref;
}

/** Read one plain string back out of the page. */
async function pageText(turn: LiveTurn, expression: string): Promise<string> {
  return ok(await turn.call("browse_eval", { expression }), `browse_eval ${expression}`).output;
}

/** Open the fixture home page in the session's default page. */
async function openHome(turn: LiveTurn): Promise<string> {
  const opened = ok(await turn.call("browse_open", { url: `${site.baseUrl}/` }), "browse_open");
  expect(opened.metadata.title).toBe("Fixture home");
  return ok(await turn.call("browse_snapshot", {}), "browse_snapshot").output;
}

// ── The suite ────────────────────────────────────────────────────────────────

describe.skipIf(!live)("browse_* live end to end", () => {
  it("reports availability, opens the fixture and closes the session", async () => {
    await withBrowse(async turn => {
      const before = ok(await turn.call("browse_status"), "browse_status before");
      expect(before.metadata.available).toBe(true);
      expect(typeof before.metadata.version).toBe("string");
      expect(before.metadata.page_count).toBe(0);
      expect(before.metadata.session_count).toBe(0);

      const opened = ok(await turn.call("browse_open", { url: `${site.baseUrl}/` }), "browse_open");
      expect(opened.metadata.url).toBe(`${site.baseUrl}/`);
      expect(opened.metadata.title).toBe("Fixture home");
      expect(opened.metadata.browser).toBe(engine);
      expect(opened.metadata.navigated).toBe(true);
      expect(opened.metadata.status).toBe(200);
      expect(opened.metadata.tabs).toEqual(["main"]);

      const snapshot = ok(await turn.call("browse_snapshot", {}), "browse_snapshot");
      expect(snapshot.output).toContain('- heading "Fixture home"');
      // Refs are assigned to actionable elements only, which is what makes them
      // safe to hand back to browse_click/type/select/press.
      const refs = parseSnapshotRefs(snapshot.output);
      expect(Number(snapshot.metadata.ref_count)).toBe(refs.length);
      const expected: Array<[string, string]> = [
        ["textbox", "Name"],
        ["combobox", "Plan"],
        ["button", "Apply"],
        ["button", "Click me"],
        ["button", "Confirm"],
        ["link", "Second page"],
        ["link", "Download"],
      ];
      for (const [role, name] of expected) {
        expect(refs.some(entry => entry.role === role && entry.name === name), `${role} "${name}"`).toBe(true);
      }

      const running = ok(await turn.call("browse_status"), "browse_status open");
      expect(running.metadata.page_count).toBe(1);
      expect(running.metadata.tabs).toEqual(["main"]);
      expect(running.metadata.engine).toBe(engine);

      const closed = ok(await turn.call("browse_close"), "browse_close");
      expect(closed.metadata.closed).toBe("session");
      expect(closed.metadata.remaining).toBe(0);
      const afterClose = ok(await turn.call("browse_status"), "browse_status after close");
      expect(afterClose.metadata.page_count).toBe(0);
      expect(turn.manager.sessionCount).toBe(0);
    });
  }, 90_000);

  it("clicks, types, submits, selects and presses against the live DOM", async () => {
    await withBrowse(async turn => {
      const snapshot = await openHome(turn);
      const clicker = refOf(snapshot, "button", "Click me");
      const name = refOf(snapshot, "textbox", "Name");
      const plan = refOf(snapshot, "combobox", "Plan");

      const clicked = ok(await turn.call("browse_click", { target: clicker }), "browse_click");
      expect(clicked.metadata.target).toBe(`ref=${clicker}`);
      expect(await pageText(turn, "document.getElementById('out').textContent")).toBe("clicked");

      const typed = ok(await turn.call("browse_type", { target: name, text: "Ada" }), "browse_type");
      expect(typed.metadata.characters).toBe(3);
      expect(typed.output).not.toContain("Ada");
      expect(await pageText(turn, "document.getElementById('name').value")).toBe("Ada");

      const selected = ok(await turn.call("browse_select", { target: plan, values: ["pro"] }), "browse_select");
      expect(selected.metadata.values).toEqual(["pro"]);
      expect(await pageText(turn, "document.getElementById('plan').value")).toBe("pro");

      // A key pressed on the input: Enter submits the surrounding form.
      const pressed = ok(await turn.call("browse_press", { key: "Enter", target: name }), "browse_press");
      expect(pressed.metadata.key).toBe("Enter");
      expect(await pageText(turn, "document.getElementById('out').textContent")).toBe("submitted:Ada");

      // submit:true folds the same Enter into browse_type.
      const submitted = ok(
        await turn.call("browse_type", { target: name, text: "Grace", submit: true }),
        "browse_type submit",
      );
      expect(submitted.metadata.submitted).toBe(true);
      expect(await pageText(turn, "document.getElementById('out').textContent")).toBe("submitted:Grace");
      expect(await pageText(turn, "document.getElementById('name').value")).toBe("Grace");

      const markdown = ok(await turn.call("browse_read", { format: "markdown" }), "browse_read markdown");
      expect(markdown.output).toContain("Fixture home");
      expect(markdown.output).toContain("Second page");
      expect(markdown.metadata.format).toBe("markdown");
      const text = ok(await turn.call("browse_read", { format: "text" }), "browse_read text");
      expect(text.output).toContain("A local page for the browse live suite.");
      const links = ok(await turn.call("browse_read", { format: "links" }), "browse_read links");
      expect(links.output).toContain("Second page");

      const hovered = ok(await turn.call("browse_hover", { target: clicker }), "browse_hover");
      expect(hovered.metadata.target).toBe(`ref=${clicker}`);

      const wheeled = ok(await turn.call("browse_scroll", {}), "browse_scroll");
      expect(wheeled.metadata).toMatchObject({ target: null, delta_x: 0, delta_y: 600 });
      const scrolledTo = ok(await turn.call("browse_scroll", { target: "css=#intro" }), "browse_scroll element");
      expect(scrolledTo.metadata.target).toBe("css=#intro");
    });
  }, 90_000);

  it("drives click points, repeats, triple clicks, drags, hover and wheel placement", async () => {
    await withBrowse(async turn => {
      await openHome(turn);
      const gesture = async () => JSON.parse(await pageText(turn, "JSON.stringify(window.gesture)"));
      const reset = async () => {
        await pageText(turn, "Object.assign(window.gesture, { clicks: 0, detail: [], dblclicks: 0, contextmenus: 0, down: null, up: null, downAt: 0, upAt: 0, clickPoint: null }); 'reset'");
      };

      // A point inside the element, a held button and three separate clicks.
      ok(await turn.call("browse_click", {
        target: "css=#pad",
        position: { x: 40, y: 50 },
        delay_ms: 60,
        repeat: 3,
        interval_ms: 10,
      }), "browse_click repeated");
      let state = await gesture();
      expect(state.clicks).toBe(3);
      expect(state.detail).toEqual([1, 1, 1]);
      // Engine subpixel hit-testing can round the point by a pixel.
      expect(state.clickPoint[0]).toBe(40);
      expect(state.clickPoint[1]).toBeGreaterThanOrEqual(48);
      expect(state.clickPoint[1]).toBeLessThanOrEqual(51);
      expect(state.upAt - state.downAt).toBeGreaterThanOrEqual(45);

      // One native triple-click sequence, not three calls.
      await reset();
      ok(await turn.call("browse_click", {
        target: "css=#pad",
        position: { x: 10, y: 20 },
        click_count: 3,
      }), "browse_click triple");
      state = await gesture();
      expect(state.clicks).toBe(3);
      expect(state.detail).toEqual([1, 2, 3]);
      expect(state.dblclicks).toBe(1);
      expect(state.clickPoint[0]).toBe(10);
      expect(state.clickPoint[1]).toBeGreaterThanOrEqual(18);
      expect(state.clickPoint[1]).toBeLessThanOrEqual(21);

      // Right-click reaches the page's contextmenu handler.
      await reset();
      ok(await turn.call("browse_click", { target: "css=#gesture", button: "right" }), "browse_click right");
      expect((await gesture()).contextmenus).toBe(1);

      // Drag between two points of the same element.
      await reset();
      ok(await turn.call("browse_drag", {
        from: "css=#pad",
        to: "css=#pad",
        from_position: { x: 20, y: 20 },
        to_position: { x: 200, y: 80 },
        steps: 10,
      }), "browse_drag");
      state = await gesture();
      for (const [actual, expected] of [[state.down, [20, 20]], [state.up, [200, 80]]] as const) {
        expect(actual[0]).toBeGreaterThanOrEqual(expected[0] - 2);
        expect(actual[0]).toBeLessThanOrEqual(expected[0] + 2);
        expect(actual[1]).toBeGreaterThanOrEqual(expected[1] - 2);
        expect(actual[1]).toBeLessThanOrEqual(expected[1] + 2);
      }

      // Native HTML5 drag-and-drop uses dragstart/dragover/drop, not only pointer moves.
      await pageText(turn, "Object.assign(window.gesture, { dropped: null }); 'reset'");
      ok(await turn.call("browse_drag", { from: "css=#drag-source", to: "css=#drop-zone" }), "browse_drag html5");
      expect(await pageText(turn, "String(window.gesture.dropped)")).toBe("dragged");

      // Hover reveals a menu that only CSS :hover shows.
      ok(await turn.call("browse_hover", { target: "css=#hover-zone", hold_ms: 30 }), "browse_hover");
      expect(await pageText(turn, "getComputedStyle(document.getElementById('hover-menu')).display")).toBe("inline-block");

      // Wheel over an inner scroller instead of wherever the pointer was left.
      ok(await turn.call("browse_hover", { target: "css=#scroller" }), "browse_hover scroller");
      const pageBefore = Number(await pageText(turn, "window.scrollY"));
      ok(await turn.call("browse_scroll", {
        at: "css=#scroller",
        at_position: { x: 10, y: 10 },
        delta_y: 300,
      }), "browse_scroll at");
      // The compositor applies a wheel asynchronously; read the result after it settles.
      await sleep(150);
      expect(Number(await pageText(turn, "document.getElementById('scroller').scrollTop"))).toBeGreaterThan(0);
      expect(Number(await pageText(turn, "window.scrollY"))).toBe(pageBefore);

      // Modifiers reach the wheel event, e.g. Control for browser zoom.
      await pageText(turn, "window.__lastWheel = null; window.addEventListener('wheel', function (event) { window.__lastWheel = { ctrl: event.ctrlKey, dy: event.deltaY }; }); 'ok'");
      ok(await turn.call("browse_scroll", {
        at: "css=#scroller",
        at_position: { x: 10, y: 10 },
        delta_y: 60,
        modifiers: ["Control"],
      }), "browse_scroll modifiers");
      await sleep(100);
      expect(JSON.parse(await pageText(turn, "JSON.stringify(window.__lastWheel)"))).toMatchObject({ ctrl: true, dy: 60 });

      // Edge jumps use the document, not the pointer position.
      ok(await turn.call("browse_scroll", { to: "bottom" }), "browse_scroll bottom");
      expect(Number(await pageText(turn, "window.scrollY"))).toBeGreaterThan(1_000);
      ok(await turn.call("browse_scroll", { to: "top" }), "browse_scroll top");
      expect(Number(await pageText(turn, "window.scrollY"))).toBe(0);
    });
  }, 90_000);

  it("captures a PNG attachment whose reported path is a real file", async () => {
    await withBrowse(async turn => {
      await openHome(turn);
      const shot = ok(await turn.call("browse_screenshot", {}), "browse_screenshot");
      const path = String(shot.metadata.path);
      expect(path.startsWith(join(turn.worktree, ".rolebox", "browse"))).toBe(true);
      expect(existsSync(path)).toBe(true);
      const bytes = new Uint8Array(readFileSync(path));
      expect(hasPngSignature(bytes)).toBe(true);
      expect(bytes.byteLength).toBeGreaterThan(1_000);
      expect(shot.metadata.mime).toBe("image/png");
      expect(Number(shot.metadata.width)).toBeGreaterThan(0);
      expect(Number(shot.metadata.height)).toBeGreaterThan(0);

      const attachment = shot.attachments[0];
      expect(attachment?.mime).toBe("image/png");
      expect(attachment?.url.startsWith("data:image/png;base64,")).toBe(true);

      // A worktree-relative path is honoured, and its directory is created.
      const region = ok(
        await turn.call("browse_screenshot", { selector: "#intro", path: "captures/intro.png" }),
        "browse_screenshot selector",
      );
      const regionPath = String(region.metadata.path);
      expect(regionPath).toBe(join(turn.worktree, "captures", "intro.png"));
      expect(existsSync(regionPath)).toBe(true);
      expect(region.metadata.selector).toBe("#intro");
    });
  }, 90_000);

  it("records console, network and download activity from the fixture", async () => {
    await withBrowse(async turn => {
      await openHome(turn);

      const waitedText = ok(
        await turn.call("browse_wait", { text: "missing:404", timeout_ms: 15_000 }),
        "browse_wait text",
      );
      expect(waitedText.metadata.waited_for).toBe("text");
      ok(await turn.call("browse_wait", { text: "closed:failed", timeout_ms: 15_000 }), "browse_wait closed");

      const consoleRead = ok(await turn.call("browse_console", { limit: 100 }), "browse_console");
      expect(consoleRead.output).toContain("fixture-log");
      expect(consoleRead.output).toContain("fixture-error");
      const levels = consoleRead.metadata.levels as Record<string, number>;
      expect(Number(levels.log ?? 0)).toBeGreaterThanOrEqual(1);
      expect(Number(levels.error ?? 0)).toBeGreaterThanOrEqual(1);

      const network = ok(await turn.call("browse_network", {}), "browse_network");
      expect(network.output).toContain("/missing");
      expect(network.output).toContain("404");
      expect(network.output).toContain("/closed");
      expect(Number(network.metadata.failed)).toBeGreaterThanOrEqual(2);
      expect(Number(network.metadata.count)).toBeGreaterThanOrEqual(1);

      // A reload repopulates the buffers, and failed_only narrows the next read.
      ok(await turn.call("browse_history", { action: "reload" }), "browse_history reload");
      ok(await turn.call("browse_wait", { text: "closed:failed", timeout_ms: 15_000 }), "browse_wait again");
      const failures = ok(await turn.call("browse_network", { failed_only: true }), "browse_network failed_only");
      expect(failures.metadata.failed_only).toBe(true);
      expect(Number(failures.metadata.count)).toBeGreaterThanOrEqual(2);
      expect(failures.output).toContain("/missing");
      expect(failures.output).toContain("/closed");

      // The download link saves a file under .rolebox/browse/downloads.
      const snapshot = ok(await turn.call("browse_snapshot", {}), "browse_snapshot");
      const download = refOf(snapshot.output, "link", "Download");
      ok(await turn.call("browse_click", { target: download }), "browse_click download");

      let recorded: RecordedDownload[] = [];
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (attempt > 0) await sleep(100);
        const read = ok(await turn.call("browse_downloads", {}), "browse_downloads");
        recorded = (read.metadata.downloads ?? []) as RecordedDownload[];
        if (recorded.length > 0) break;
      }
      expect(recorded).toHaveLength(1);
      const saved = recorded[0]!;
      expect(saved.status).toBe("completed");
      expect(saved.filename).toContain("fixture");
      const savedPath = String(saved.path);
      expect(savedPath).toContain(join(".rolebox", "browse", "downloads"));
      expect(existsSync(savedPath)).toBe(true);
      expect(readFileSync(savedPath, "utf-8")).toBe("rolebox fixture download\n");
    });
  }, 120_000);

  it("navigates with history and manages the second page as a tab", async () => {
    await withBrowse(async turn => {
      const snapshot = await openHome(turn);
      const second = refOf(snapshot, "link", "Second page");
      ok(await turn.call("browse_click", { target: second }), "browse_click second");

      const waitedUrl = ok(
        await turn.call("browse_wait", { url: FIXTURE_SECOND_PATH, timeout_ms: 15_000 }),
        "browse_wait url",
      );
      expect(waitedUrl.metadata.waited_for).toBe("url");

      const secondSnapshot = ok(await turn.call("browse_snapshot", {}), "browse_snapshot second");
      expect(secondSnapshot.output).toContain('- heading "Second page"');
      expect(secondSnapshot.metadata.title).toBe("Second page");
      expect(secondSnapshot.metadata.url).toBe(`${site.baseUrl}${FIXTURE_SECOND_PATH}`);

      const back = ok(await turn.call("browse_history", { action: "back" }), "browse_history back");
      expect(back.metadata.url).toBe(`${site.baseUrl}/`);
      expect(back.metadata.refs_reset).toBe(true);
      const forward = ok(await turn.call("browse_history", { action: "forward" }), "browse_history forward");
      expect(forward.metadata.url).toBe(`${site.baseUrl}${FIXTURE_SECOND_PATH}`);
      const reload = ok(await turn.call("browse_history", { action: "reload" }), "browse_history reload");
      expect(reload.metadata.status).toBe(200);

      const listed = ok(await turn.call("browse_tabs", { action: "list" }), "browse_tabs list");
      expect(listed.metadata.count).toBe(1);
      expect(listed.metadata.active).toBe("main");

      const created = ok(
        await turn.call("browse_tabs", { action: "new", page: "second", url: `${site.baseUrl}${FIXTURE_SECOND_PATH}` }),
        "browse_tabs new",
      );
      expect(created.metadata.tabs).toEqual(["main", "second"]);
      expect(created.metadata.active).toBe("second");
      expect(created.metadata.navigated).toBe(true);

      const selected = ok(await turn.call("browse_tabs", { action: "select", page: "main" }), "browse_tabs select");
      expect(selected.metadata.active).toBe("main");
      const secondPage = ok(await turn.call("browse_snapshot", { page: "second" }), "browse_snapshot second tab");
      expect(secondPage.output).toContain('- heading "Second page"');

      const closed = ok(await turn.call("browse_tabs", { action: "close", page: "second" }), "browse_tabs close");
      expect(closed.metadata.count).toBe(1);
      expect(closed.metadata.tabs).toEqual(["main"]);
    });
  }, 90_000);

  it("round-trips cookies and handles a blocking dialog", async () => {
    await withBrowse(async turn => {
      const snapshot = await openHome(turn);

      const empty = ok(await turn.call("browse_cookies", { action: "get" }), "browse_cookies get");
      expect(empty.metadata.count).toBe(0);
      const set = ok(
        await turn.call("browse_cookies", { action: "set", name: "live", value: "1", url: `${site.baseUrl}/` }),
        "browse_cookies set",
      );
      expect(set.metadata).toMatchObject({ action_name: "set", name: "live" });
      const readBack = ok(await turn.call("browse_cookies", { action: "get", name: "live" }), "browse_cookies get named");
      expect(readBack.metadata.names).toEqual(["live"]);
      expect(readBack.output).toContain("live=1");
      const cleared = ok(await turn.call("browse_cookies", { action: "clear" }), "browse_cookies clear");
      expect(cleared.metadata.count).toBe(1);
      const after = ok(await turn.call("browse_cookies", { action: "get" }), "browse_cookies get after clear");
      expect(after.metadata.count).toBe(0);

      const confirm = refOf(snapshot, "button", "Confirm");
      refused(await turn.call("browse_click", { target: confirm }), "dialog_open", "browse_click confirm");
      const pending = ok(await turn.call("browse_status"), "browse_status dialog");
      expect(pending.metadata.dialog).toMatchObject({ type: "confirm", message: "Proceed?", open: true });
      const accepted = ok(await turn.call("browse_dialog", { action: "accept" }), "browse_dialog accept");
      expect(accepted.metadata.handled).toBe("accept");
      expect(accepted.metadata.dialog).toMatchObject({ type: "confirm" });

      refused(await turn.call("browse_click", { target: confirm }), "dialog_open", "browse_click confirm again");
      const dismissed = ok(await turn.call("browse_dialog", { action: "dismiss" }), "browse_dialog dismiss");
      expect(dismissed.metadata.handled).toBe("dismiss");
      const settled = ok(await turn.call("browse_status"), "browse_status settled");
      expect(settled.metadata.dialog).toBeNull();
      refused(await turn.call("browse_dialog", { action: "accept" }), "dialog_missing", "browse_dialog missing");

      // The page is usable again after each dialog.
      expect(await pageText(turn, "document.title")).toBe("Fixture home");
    });
  }, 90_000);

  it("uploads a file and evaluates a JSON value in the page", async () => {
    await withBrowse(async turn => {
      const snapshot = await openHome(turn);
      writeFileSync(join(turn.worktree, "note.txt"), "hello upload\n");

      const uploadRef = refOf(snapshot, "button", "Attachment");
      const uploaded = ok(
        await turn.call("browse_upload", { target: uploadRef, paths: ["note.txt"] }),
        "browse_upload",
      );
      expect(uploaded.metadata.count).toBe(1);
      expect(uploaded.metadata.files).toEqual(["note.txt"]);
      expect(await pageText(turn, "document.getElementById('upload').files[0].name")).toBe("note.txt");

      const evaluated = ok(
        await turn.call("browse_eval", { expression: "({answer: 42, list: [1, 2]})" }),
        "browse_eval json",
      );
      expect(evaluated.metadata.result_type).toBe("object");
      expect(JSON.parse(evaluated.output)).toEqual({ answer: 42, list: [1, 2] });

      const title = ok(await turn.call("browse_eval", { expression: "document.title" }), "browse_eval string");
      expect(title.metadata.result_type).toBe("string");
      expect(title.output).toBe("Fixture home");
    });
  }, 90_000);
});
