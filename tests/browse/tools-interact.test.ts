/**
 * Interaction tools against the in-memory driver: the ref lifecycle, target
 * ambiguity, dialog handling, uploads, cookies and the argument guarantees the
 * tool layer adds on top of the driver port.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browseError, type CookieRecord, type DialogState } from "../../src/browse/types.ts";
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
  expect(result.output.startsWith("Error: ")).toBe(true);
  expect(result.metadata?.error).toBe(true);
  expect(result.metadata?.code).toBe(code);
}

async function openAndSnapshot(harness: BrowseHarness): Promise<void> {
  await harness.call("browse_open");
  await harness.call("browse_snapshot");
}

describe("browse_click", () => {
  it("clicks a ref from the latest snapshot and reports the target", async () => {
    const harness = makeHarness();
    await openAndSnapshot(harness);
    const result = await harness.call("browse_click", { target: "e1" });

    expect(harness.page().clickTargets).toEqual([{ kind: "ref", ref: "e1" }]);
    expect(result.metadata?.target).toBe("ref=e1");
    expect(result.metadata?.ref).toBe("e1");
    expect(result.metadata?.button).toBe("left");
    expect(result.metadata?.click_count).toBe(1);
    expect(result.metadata?.modifiers).toEqual([]);
    expect(result.output).toContain("Clicked ref=e1 with a left click");
    expect(result.metadata?.url).toBe("https://example.com/app");
  });

  it("accepts the @eN ref form", async () => {
    const harness = makeHarness();
    await openAndSnapshot(harness);
    const result = await harness.call("browse_click", { target: "@e2" });
    expect(result.metadata?.ref).toBe("e2");
  });

  it("passes a text target through as a strict locator", async () => {
    const harness = makeHarness();
    await openAndSnapshot(harness);
    const result = await harness.call("browse_click", { target: "text=Save" });
    expect(harness.page().clickTargets).toEqual([{ kind: "text", text: "Save" }]);
    expect(result.metadata?.target).toBe("text=Save");
    expect(result.metadata?.ref).toBeNull();
  });

  it("supports a right double-click with modifiers", async () => {
    const harness = makeHarness();
    await openAndSnapshot(harness);
    const result = await harness.call("browse_click", {
      target: "e1",
      button: "right",
      click_count: 2,
      modifiers: ["Control", "Shift"],
    });
    expect(result.metadata?.button).toBe("right");
    expect(result.metadata?.click_count).toBe(2);
    expect(result.metadata?.modifiers).toEqual(["Control", "Shift"]);
    expect(result.output).toContain("right double-click holding Control+Shift");
  });

  it("passes a position, triple count, hold delay and repeat through", async () => {
    const harness = makeHarness();
    await openAndSnapshot(harness);
    const result = await harness.call("browse_click", {
      target: "e1",
      position: { x: 12, y: 34 },
      click_count: 3,
      delay_ms: 40,
      repeat: 3,
      interval_ms: 25,
    });
    expect(harness.page().clickOptions[0]).toMatchObject({
      clickCount: 3,
      position: { x: 12, y: 34 },
      delayMs: 40,
      repeat: 3,
      intervalMs: 25,
    });
    expect(result.metadata?.position).toEqual({ x: 12, y: 34 });
    expect(result.metadata?.delay_ms).toBe(40);
    expect(result.metadata?.repeat).toBe(3);
    expect(result.metadata?.interval_ms).toBe(25);
    expect(result.output).toContain("left triple-click at (12, 34)");
    expect(result.output).toContain("holding the button 40 ms");
    expect(result.output).toContain("repeated 3 times every 25 ms");
  });

  it("rejects an invalid button, click count, modifier, position or empty target", async () => {
    const harness = makeHarness();
    for (const args of [
      { target: "e1", button: "sideways" },
      { target: "e1", click_count: 4 },
      { target: "e1", modifiers: ["Hyper"] },
      { target: "e1", position: { x: -1, y: 0 } },
      { target: "e1", delay_ms: 5_001 },
      { target: "e1", interval_ms: 10 },
      { target: "" },
      { target: "unknownprefix=x" },
    ]) {
      const result = await harness.call("browse_click", args);
      expectFailure(result, args.target === "unknownprefix=x" ? "invalid_target" : "invalid_arguments");
    }
    expect(harness.factory.launchCount).toBe(0);
  });

  it("refuses a ref that is not in the current snapshot", async () => {
    const harness = makeHarness();
    await openAndSnapshot(harness);
    const result = await harness.call("browse_click", { target: "e99" });
    expectFailure(result, "stale_ref");
    expect(result.output).toContain("is stale");
    expect(result.output).toContain("browse_snapshot");
    expect(harness.page().clickTargets).toEqual([]);
  });

  it("turns a vanished ref into stale_ref and forgets it", async () => {
    const harness = makeHarness();
    await openAndSnapshot(harness);
    harness.page().clickError = browseError("element_not_found", "element is not attached to the DOM", "Retry.");
    const vanished = await harness.call("browse_click", { target: "e1" });
    expectFailure(vanished, "stale_ref");
    expect(vanished.output).toContain("browse_snapshot");

    harness.page().clickError = null;
    const remembered = await harness.call("browse_click", { target: "e1" });
    expectFailure(remembered, "stale_ref");
    expect(harness.page().clickTargets).toHaveLength(1);
  });

  it("surfaces an ambiguous strict-locator match with ref guidance", async () => {
    const harness = makeHarness();
    await openAndSnapshot(harness);
    harness.page().clickError = browseError(
      "ambiguous_target",
      "click matched more than one element (strict mode violation: resolved to 2 elements)",
      "Call browse_snapshot and use the element ref (for example e12) so exactly one element is targeted.",
    );
    const result = await harness.call("browse_click", { target: "text=Save" });
    expectFailure(result, "ambiguous_target");
    expect(result.output).toContain("matched more than one element");
    expect(result.output).toContain("browse_snapshot");
  });

  it("surfaces dialog_open so the model handles the dialog first", async () => {
    const harness = makeHarness();
    await openAndSnapshot(harness);
    harness.page().clickError = browseError(
      "dialog_open",
      "click opened a confirm dialog",
      "Handle it with browse_dialog accept=true or accept=false (dismiss); the page stays blocked until then.",
    );
    const result = await harness.call("browse_click", { target: "e1" });
    expectFailure(result, "dialog_open");
    expect(result.output).toContain("browse_dialog");
  });
});

describe("browse_type", () => {
  it("clears by default and never echoes the typed text", async () => {
    const harness = makeHarness();
    await openAndSnapshot(harness);
    const result = await harness.call("browse_type", { target: "e2", text: "hunter2-secret" });
    expect(harness.page().calls).toContain("fill");
    expect(result.metadata?.cleared).toBe(true);
    expect(result.metadata?.characters).toBe(14);
    expect(result.metadata?.submitted).toBe(false);
    expect(result.output).not.toContain("hunter2-secret");
    expect(result.output).toContain("Typed 14 character(s) into ref=e2");
  });

  it("appends with clear=false and submits with Enter", async () => {
    const harness = makeHarness();
    await openAndSnapshot(harness);
    const result = await harness.call("browse_type", {
      target: "e2",
      text: " more",
      clear: false,
      submit: true,
    });
    expect(harness.page().calls).toContain("type");
    expect(harness.page().calls).toContain("press");
    expect(result.metadata?.cleared).toBe(false);
    expect(result.metadata?.submitted).toBe(true);
    expect(result.output).toContain("Appended 5 character(s)");
    expect(result.output).toContain("pressed Enter");
  });

  it("rejects a non-string text argument", async () => {
    const harness = makeHarness();
    const result = await harness.call("browse_type", { target: "e1", text: 42 });
    expectFailure(result, "invalid_arguments");
    expect(harness.factory.launchCount).toBe(0);
  });
});

describe("browse_press", () => {
  it("presses a key on the focused element", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const result = await harness.call("browse_press", { key: "Enter" });
    expect(harness.page().calls).toContain("press");
    expect(result.metadata?.target).toBe("key=Enter");
    expect(result.output).toContain('Pressed "Enter"');
  });

  it("presses a key on a target", async () => {
    const harness = makeHarness();
    await openAndSnapshot(harness);
    const result = await harness.call("browse_press", { key: "Control+A", target: "e2" });
    expect(result.metadata?.target).toBe("ref=e2");
    expect(result.metadata?.key).toBe("Control+A");
    expect(result.output).toContain('Pressed "Control+A" on ref=e2');
  });

  it("rejects an empty key", async () => {
    const harness = makeHarness();
    const result = await harness.call("browse_press", { key: "  " });
    expectFailure(result, "invalid_arguments");
  });
});

describe("browse_select", () => {
  it("selects the requested option values", async () => {
    const harness = makeHarness();
    await openAndSnapshot(harness);
    const result = await harness.call("browse_select", { target: "e3", values: ["pro", "team"] });
    expect(result.metadata?.values).toEqual(["pro", "team"]);
    expect(result.output).toContain('Selected 2 option(s) on ref=e3: "pro", "team"');
  });

  it("rejects an empty values list", async () => {
    const harness = makeHarness();
    const result = await harness.call("browse_select", { target: "e3", values: [] });
    expectFailure(result, "invalid_arguments");
    expect(harness.factory.launchCount).toBe(0);
  });
});

describe("browse_hover", () => {
  it("hovers the target and reports it", async () => {
    const harness = makeHarness();
    await openAndSnapshot(harness);
    const result = await harness.call("browse_hover", { target: "e1" });
    expect(harness.page().calls).toContain("hover");
    expect(result.metadata?.target).toBe("ref=e1");
    expect(result.output).toContain("Hovered ref=e1");
    expect(result.metadata?.hold_ms).toBe(0);
  });

  it("passes a point, modifiers, force and hold time through", async () => {
    const harness = makeHarness();
    await openAndSnapshot(harness);
    const result = await harness.call("browse_hover", {
      target: "e1",
      position: { x: 7, y: 8 },
      modifiers: ["Shift"],
      force: true,
      hold_ms: 30,
    });
    expect(harness.page().hoverOptions[0]).toMatchObject({
      position: { x: 7, y: 8 },
      modifiers: ["Shift"],
      force: true,
      holdMs: 30,
    });
    expect(result.metadata?.position).toEqual({ x: 7, y: 8 });
    expect(result.metadata?.modifiers).toEqual(["Shift"]);
    expect(result.metadata?.hold_ms).toBe(30);
    expect(result.output).toContain("Hovered ref=e1 at (7, 8) and kept it there 30 ms");
  });
});

describe("browse_scroll", () => {
  it("wheels the page by the default delta", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const result = await harness.call("browse_scroll");
    expect(result.metadata?.delta_x).toBe(0);
    expect(result.metadata?.delta_y).toBe(600);
    expect(result.metadata?.target).toBeNull();
    expect(harness.page().calls).toContain("scroll");
  });

  it("accepts explicit deltas", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const result = await harness.call("browse_scroll", { delta_x: 10, delta_y: -400 });
    expect(result.metadata?.delta_x).toBe(10);
    expect(result.metadata?.delta_y).toBe(-400);
  });

  it("scrolls a target into view", async () => {
    const harness = makeHarness();
    await openAndSnapshot(harness);
    const result = await harness.call("browse_scroll", { target: "e1" });
    expect(result.metadata?.target).toBe("ref=e1");
    expect(result.output).toContain("Scrolled ref=e1 into view");
  });

  it("wheels over a chosen element with modifiers", async () => {
    const harness = makeHarness();
    await openAndSnapshot(harness);
    const result = await harness.call("browse_scroll", {
      at: "e1",
      at_position: { x: 5, y: 6 },
      delta_y: 120,
      modifiers: ["Control"],
    });
    expect(harness.page().scrollOptions[0]).toMatchObject({
      at: { kind: "ref", ref: "e1" },
      atPosition: { x: 5, y: 6 },
      deltaX: 0,
      deltaY: 120,
      modifiers: ["Control"],
    });
    expect(result.metadata?.at).toBe("ref=e1");
    expect(result.metadata?.modifiers).toEqual(["Control"]);
    expect(result.output).toContain("Wheeled over ref=e1 by dx=0, dy=120");
  });

  it("jumps the document to an edge", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const result = await harness.call("browse_scroll", { to: "bottom" });
    expect(harness.page().scrollOptions[0]).toMatchObject({ to: "bottom" });
    expect(result.metadata?.to).toBe("bottom");
    expect(result.output).toContain("Scrolled the document to the bottom");
  });

  it("rejects conflicting scroll modes and a zero wheel", async () => {
    const harness = makeHarness();
    for (const args of [
      { target: "e1", delta_y: 10 },
      { target: "e1", to: "top" },
      { to: "top", delta_y: 10 },
      { to: "top", at: "e1" },
      { at_position: { x: 1, y: 2 } },
      { delta_x: 0, delta_y: 0 },
    ]) {
      const result = await harness.call("browse_scroll", args);
      expectFailure(result, "invalid_arguments");
    }
    expect(harness.factory.launchCount).toBe(0);
  });
});

describe("browse_drag", () => {
  it("drags between two refs with positions and steps", async () => {
    const harness = makeHarness();
    await openAndSnapshot(harness);
    const result = await harness.call("browse_drag", {
      from: "e1",
      to: "e2",
      from_position: { x: 3, y: 4 },
      to_position: { x: 5, y: 6 },
      steps: 25,
    });
    expect(harness.page().dragCalls).toEqual([{
      source: { kind: "ref", ref: "e1" },
      target: { kind: "ref", ref: "e2" },
      options: {
        timeoutMs: 15_000,
        force: false,
        steps: 25,
        sourcePosition: { x: 3, y: 4 },
        targetPosition: { x: 5, y: 6 },
      },
    }]);
    expect(result.metadata?.source).toBe("ref=e1");
    expect(result.metadata?.target).toBe("ref=e2");
    expect(result.metadata?.from_position).toEqual({ x: 3, y: 4 });
    expect(result.metadata?.to_position).toEqual({ x: 5, y: 6 });
    expect(result.metadata?.steps).toBe(25);
    expect(result.output).toContain("Dragged ref=e1 at (3, 4) to ref=e2 at (5, 6) in 25 step(s)");
  });

  it("defaults to ten interpolated steps", async () => {
    const harness = makeHarness();
    await openAndSnapshot(harness);
    const result = await harness.call("browse_drag", { from: "e1", to: "e2" });
    expect(result.metadata?.steps).toBe(10);
    expect(harness.page().dragCalls[0]?.options?.steps).toBe(10);
  });

  it("turns a vanished drag endpoint into stale_ref and forgets the refs", async () => {
    const harness = makeHarness();
    await openAndSnapshot(harness);
    harness.page().dragError = browseError("element_not_found", "element is not attached to the DOM", "Retry.");
    const vanished = await harness.call("browse_drag", { from: "e1", to: "e2" });
    expectFailure(vanished, "stale_ref");
    expect(vanished.output).toContain("ref e1 and ref e2 are stale");
    expect(vanished.output).toContain("browse_snapshot");

    // Both endpoints were dropped, so the next action asks for a new snapshot.
    harness.page().dragError = null;
    expectFailure(await harness.call("browse_click", { target: "e1" }), "stale_ref");
  });

  it("rejects an out-of-range step count or a stale endpoint before the browser", async () => {
    const harness = makeHarness();
    await openAndSnapshot(harness);
    expectFailure(await harness.call("browse_drag", { from: "e1", to: "e2", steps: 0 }), "invalid_arguments");
    const stale = await harness.call("browse_drag", { from: "e1", to: "e99" });
    expectFailure(stale, "stale_ref");
    expect(harness.page().dragCalls).toEqual([]);
  });
});

describe("browse_upload", () => {
  it("uploads worktree-relative files and reports them", async () => {
    const harness = makeHarness();
    await openAndSnapshot(harness);
    writeFileSync(join(harness.worktree, "resume.txt"), "cv");
    const result = await harness.call("browse_upload", { target: "e2", paths: ["resume.txt"] });
    expect(harness.page().uploadedFiles).toEqual([join(harness.worktree, "resume.txt")]);
    expect(result.metadata?.count).toBe(1);
    expect(result.metadata?.files).toEqual(["resume.txt"]);
    expect(result.output).toContain("Uploaded 1 file(s) to ref=e2: resume.txt");
  });

  it("accepts an absolute path", async () => {
    const harness = makeHarness();
    await openAndSnapshot(harness);
    const absolute = join(harness.worktree, "notes.md");
    writeFileSync(absolute, "# notes");
    const result = await harness.call("browse_upload", { target: "e2", paths: [absolute] });
    expect(result.metadata?.paths).toEqual([absolute]);
  });

  it("refuses a missing file before the browser is touched", async () => {
    const harness = makeHarness();
    const result = await harness.call("browse_upload", { target: "e2", paths: ["missing.txt"] });
    expectFailure(result, "file_not_found");
    expect(result.output).toContain("missing.txt");
    expect(harness.factory.launchCount).toBe(0);
  });

  it("refuses a directory", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    mkdirSync(join(harness.worktree, "folder"));
    const result = await harness.call("browse_upload", { target: "e2", paths: ["folder"] });
    expectFailure(result, "file_not_found");
    expect(result.output).toContain("not a regular file");
  });

  it("rejects an empty path list", async () => {
    const harness = makeHarness();
    const result = await harness.call("browse_upload", { target: "e2", paths: [] });
    expectFailure(result, "invalid_arguments");
  });
});

describe("browse_dialog", () => {
  const prompt: DialogState = { type: "prompt", message: "Your name?", defaultValue: "", open: true };

  it("fails with dialog_missing when no dialog is open", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const result = await harness.call("browse_dialog", { action: "accept" });
    expectFailure(result, "dialog_missing");
    expect(result.output).toContain("no dialog is open");
  });

  it("accepts a prompt with prompt_text and reports the dialog it handled", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    harness.page().dialogState = prompt;
    const result = await harness.call("browse_dialog", { action: "accept", prompt_text: "Ada" });
    expect(harness.page().acceptedDialogs).toEqual(["Ada"]);
    expect(result.metadata?.handled).toBe("accept");
    expect(result.metadata?.dialog).toEqual(prompt);
    expect(result.output).toContain('Accepted prompt dialog "Your name?" and answered "Ada"');
  });

  it("dismisses the pending dialog", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    harness.page().dialogState = { type: "confirm", message: "Delete?", defaultValue: "", open: true };
    const result = await harness.call("browse_dialog", { action: "dismiss" });
    expect(harness.page().dismissCount).toBe(1);
    expect(result.output).toContain('Dismissed confirm dialog "Delete?"');
  });

  it("rejects prompt_text with dismiss before launching", async () => {
    const harness = makeHarness();
    const result = await harness.call("browse_dialog", { action: "dismiss", prompt_text: "no" });
    expectFailure(result, "invalid_arguments");
    expect(harness.factory.launchCount).toBe(0);
  });

  it("rejects an unknown action", async () => {
    const harness = makeHarness();
    const result = await harness.call("browse_dialog", { action: "ignore" });
    expectFailure(result, "invalid_arguments");
  });
});

describe("browse_cookies", () => {
  const cookies: CookieRecord[] = [
    {
      name: "session", value: "abc123", domain: "example.com", path: "/",
      expires: -1, httpOnly: true, secure: true, sameSite: "Lax",
    },
    {
      name: "theme", value: "dark", domain: "example.com", path: "/app",
      expires: 1_800_000_000, httpOnly: false, secure: false,
    },
  ];

  it("lists cookies sorted by domain and name", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    harness.page().cookiesValue = [...cookies].reverse();
    const result = await harness.call("browse_cookies", { action: "get" });
    expect(result.metadata?.count).toBe(2);
    expect(result.metadata?.names).toEqual(["session", "theme"]);
    expect(result.output).toContain("session=abc123; domain=example.com; path=/; expires=session; secure; http_only; same_site=Lax");
    expect(result.output).toContain("theme=dark; domain=example.com; path=/app; expires=");
    expect(result.output.indexOf("session=")).toBeLessThan(result.output.indexOf("theme="));
  });

  it("filters by cookie name", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    harness.page().cookiesValue = [...cookies];
    const result = await harness.call("browse_cookies", { action: "get", name: "theme" });
    expect(result.metadata?.count).toBe(1);
    expect(result.metadata?.names).toEqual(["theme"]);
  });

  it("explains an empty jar", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const result = await harness.call("browse_cookies", { action: "get" });
    expect(result.metadata?.count).toBe(0);
    expect(result.output).toContain("No cookies are set");
  });

  it("sets a cookie scoped by url", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const result = await harness.call("browse_cookies", {
      action: "set",
      name: "token",
      value: "xyz",
      url: "https://example.com/",
      http_only: true,
      secure: true,
      same_site: "Strict",
      expires: 1_900_000_000,
    });
    expect(harness.page().writtenCookies).toEqual([[
      {
        name: "token",
        value: "xyz",
        url: "https://example.com/",
        httpOnly: true,
        secure: true,
        sameSite: "Strict",
        expires: 1_900_000_000,
      },
    ]]);
    expect(result.metadata?.name).toBe("token");
    expect(result.metadata?.http_only).toBe(true);
    expect(result.metadata?.same_site).toBe("Strict");
    expect(result.output).toContain("Set cookie \"token\"");
  });

  it("sets a cookie scoped by domain and path", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    const result = await harness.call("browse_cookies", {
      action: "set",
      name: "theme",
      value: "dark",
      domain: "example.com",
      path: "/app",
    });
    expect(harness.page().writtenCookies[0][0].domain).toBe("example.com");
    expect(harness.page().writtenCookies[0][0].path).toBe("/app");
    expect(result.metadata?.domain).toBe("example.com");
    expect(result.metadata?.path).toBe("/app");
  });

  it("clears every cookie and reports how many there were", async () => {
    const harness = makeHarness();
    await harness.call("browse_open");
    harness.page().cookiesValue = [...cookies];
    const result = await harness.call("browse_cookies", { action: "clear" });
    expect(result.metadata?.count).toBe(2);
    expect(harness.page().cookiesValue).toEqual([]);
  });

  it("rejects an incomplete or contradictory cookie scope before launching", async () => {
    const harness = makeHarness();
    for (const args of [
      { action: "set", name: "a" },
      { action: "set", value: "b", url: "https://example.com/" },
      { action: "set", name: "a", value: "b" },
      { action: "set", name: "a", value: "b", domain: "example.com" },
      { action: "set", name: "a", value: "b", url: "https://example.com/", domain: "example.com", path: "/" },
      { action: "set", name: "a", value: "b", url: "ftp://example.com/" },
      { action: "get", name: "a", url: "https://example.com/" },
      { action: "clear", name: "a" },
    ]) {
      const result = await harness.call("browse_cookies", args);
      expectFailure(result, "invalid_arguments");
    }
    expect(harness.factory.launchCount).toBe(0);
  });
});
