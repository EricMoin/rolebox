
/**
 * The `browse_*` family wired end to end — tool record, session, driver port,
 * host assembly and the dsh policy seam.
 *
 * The unit suites beside this file pin one layer each (`tools*.test.ts` the tool
 * bodies over the fake driver, `session.test.ts` the ref/queue contract,
 * `snapshot.test.ts`/`target.test.ts` the pure helpers, `dsh-browse-*` the dsh
 * adapters). This file deliberately tests the SEAMS, because that is where the
 * upstream layers can disagree while every unit suite stays green:
 *
 * - the hub's 23 names, the host wire's 23 names and the assembled
 *   `buildCanonicalTools({ browseUse: true })` surface are one set, and the
 *   family is absent unless the host opts in;
 * - one canonical record drives a real open → snapshot → click → type → read →
 *   screenshot → close turn without a second browser and with the file the
 *   screenshot reports actually on disk;
 * - ref lifetime crosses tools: a snapshot in one call is consumed by a later
 *   click, and navigation from a DIFFERENT tool (`browse_history`, `browse_open`)
 *   is what makes it stale — including the driver-side vanished-element
 *   translation;
 * - the failure contract (`Error: <cause>; <next step>.`, `metadata.code`,
 *   `metadata.error`) holds for argument refusals, driver failures and an
 *   unavailable driver, and a refusal never launches a browser;
 * - the dsh guard installed by `installDshBrowseUsePolicy` refuses a role whose
 *   `tools:` map disables the family while allowing the base agent.
 */

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildCanonicalTools } from "../../src/platform/tool-assembly.ts";
import { opencodeCapabilities } from "../../src/platform/capabilities.ts";
import { createBrowseTools } from "../../src/browse/tools.ts";
import { BROWSE_TOOL_NAMES as HUB_TOOL_NAMES } from "../../src/browse/tools.ts";
import {
  BROWSE_TOOL_NAMES as WIRE_TOOL_NAMES,
  isBrowseToolName,
  isRegisteredBrowseToolName,
} from "../../src/loader/browse-grants.ts";
import {
  installDshBrowseUsePolicy,
  isBrowseUseRegistrationAllowed,
  type DshToolFamilyPolicyOptions,
  type DshToolGuardExecution,
  type DshToolGuardRegistry,
} from "../../src/platform/adapters/dsh/role-tool-policy.ts";
import { browseError } from "../../src/browse/types.ts";
import { hasPngSignature } from "../../src/computer/png.ts";
import type { ResolvedRole } from "../../src/types.ts";
import { FAKE_PNG_BYTES } from "./fixtures/fake-driver.ts";
import {
  HARNESS_SNAPSHOT,
  HARNESS_TITLE,
  HARNESS_URL,
  createBrowseHarness,
  metadataOf,
  type BrowseHarness,
  type BrowseHarnessOptions,
  type StructuredToolResult,
} from "./helpers/fake-driver.ts";

/** Every harness a test built, disposed after the test. */
const harnesses: BrowseHarness[] = [];

function harness(options: BrowseHarnessOptions = {}): BrowseHarness {
  const built = createBrowseHarness(options);
  harnesses.push(built);
  return built;
}

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.cleanup();
});

/** The metadata keys every browse result promises, success or failure. */
const ENVELOPE_KEYS = ["driver", "action", "session", "page", "url", "title"] as const;

function expectEnvelope(result: StructuredToolResult, action: string): Record<string, unknown> {
  const metadata = metadataOf(result);
  expect(metadata.driver).toBe("playwright");
  expect(metadata.action).toBe(action);
  for (const key of ENVELOPE_KEYS) expect(metadata[key], `${action}.${key}`).toBeDefined();
  return metadata;
}

/** Assert a result is a success (no `metadata.error`) and return its metadata. */
function expectOk(result: StructuredToolResult, action: string): Record<string, unknown> {
  const metadata = expectEnvelope(result, action);
  if (metadata.error === true) {
    throw new Error(`${action} failed unexpectedly: ${result.output}`);
  }
  return metadata;
}

// ── The surface the host registers ───────────────────────────────────────────

describe("browse tool surface — hub, host wire and assembly", () => {
  it("joins the hub names, the host wire and the assembled surface into one 23-name set", () => {
    const hub = createBrowseTools();
    expect(Object.keys(hub).sort()).toEqual([...HUB_TOOL_NAMES].sort());
    expect(HUB_TOOL_NAMES).toHaveLength(23);
    // The host's own copy of the registry (kept independent of the driver
    // stack) must name the same 23 tools, or a host would register a name the
    // tools module never builds — or grant one it does.
    expect([...WIRE_TOOL_NAMES]).toEqual([...HUB_TOOL_NAMES]);

    const assembled = buildCanonicalTools({
      resolvedRoles: [],
      directory: "/tmp/rolebox-browse-integration",
      capabilities: opencodeCapabilities(),
      browseUse: true,
    });
    const browseKeys = Object.keys(assembled).filter(isBrowseToolName).sort();
    expect(browseKeys).toEqual([...WIRE_TOOL_NAMES].sort());
    for (const name of browseKeys) {
      expect(isRegisteredBrowseToolName(name), name).toBe(true);
      const definition = assembled[name];
      expect(definition, name).toBeDefined();
      expect(typeof definition!.execute, name).toBe("function");
      expect(definition!.description.length, name).toBeGreaterThan(0);
    }
  });

  it("omits the family entirely when the host does not opt in", () => {
    for (const browseUse of [undefined, false] as const) {
      const tools = buildCanonicalTools({
        resolvedRoles: [],
        directory: "/tmp/rolebox-browse-integration",
        capabilities: opencodeCapabilities(),
        ...(browseUse === undefined ? {} : { browseUse }),
      });
      expect(Object.keys(tools).filter(isBrowseToolName), String(browseUse)).toEqual([]);
      // The assembly is still a real tool surface; only the family is absent.
      expect(tools.hashline_read).toBeDefined();
    }
  });
});

// ── One turn through the real record ─────────────────────────────────────────

describe("browse_* one canonical turn over the driver port", () => {
  it("opens, snapshots, clicks, types, reads, screenshots and closes on one browser", async () => {
    const h = harness();
    const context = h.context();

    // open — the session launches exactly one browser for the whole turn.
    const opened = await h.call("browse_open", { url: HARNESS_URL }, context);
    const openMetadata = expectOk(opened, "browse_open");
    expect(openMetadata).toMatchObject({
      browser: "chromium",
      headless: true,
      attached: false,
      created: true,
      navigated: true,
      status: 200,
      page_count: 1,
      tabs: ["main"],
      page: "main",
      url: HARNESS_URL,
      title: HARNESS_TITLE,
    });
    expect(h.factory.launchCount).toBe(1);
    expect(h.factory.launchOptions[0]).toMatchObject({
      engine: "chromium",
      headless: true,
      viewport: { width: 1440, height: 900 },
    });

    // snapshot — the only producer of refs.
    const snapshot = await h.call("browse_snapshot", {}, context);
    const snapshotMetadata = expectOk(snapshot, "browse_snapshot");
    expect(snapshot.output).toBe(HARNESS_SNAPSHOT);
    expect(snapshotMetadata).toMatchObject({
      ref_count: 3,
      node_count: 3,
      truncated: false,
      selector: null,
      full: false,
    });

    // click — the ref written by the snapshot reaches the page driver as a ref.
    const clicked = await h.call("browse_click", { target: "e1" }, context);
    expectOk(clicked, "browse_click");
    expect(h.page().clickTargets).toEqual([{ kind: "ref", ref: "e1" }]);
    expect(clicked.output).toContain("Clicked ref=e1");

    // type — fills the field and never echoes the text back.
    const typed = await h.call("browse_type", { target: "e2", text: "ada@example.com" }, context);
    const typedMetadata = expectOk(typed, "browse_type");
    expect(typedMetadata).toMatchObject({ target: "ref=e2", characters: 15, cleared: true, submitted: false });
    expect(typed.output).not.toContain("ada@example.com");

    // read — the representation reaches the session page and comes back.
    const read = await h.call("browse_read", { format: "markdown" }, context);
    const readMetadata = expectOk(read, "browse_read");
    expect(read.output).toBe("read:markdown");
    expect(readMetadata).toMatchObject({ format: "markdown", truncated: false, selector: null });

    // screenshot — the attachment and the file on disk are the same bytes.
    const shot = await h.call("browse_screenshot", {}, context);
    const shotMetadata = expectOk(shot, "browse_screenshot");
    const path = String(shotMetadata.path);
    expect(dirname(path)).toBe(join(h.worktree, ".rolebox", "browse"));
    expect(path.endsWith(".png")).toBe(true);
    expect(existsSync(path)).toBe(true);
    const written = readFileSync(path);
    expect(hasPngSignature(new Uint8Array(written))).toBe(true);
    expect(shotMetadata).toMatchObject({ mime: "image/png", width: 800, height: 600 });
    const attachment = shot.attachments?.[0];
    expect(attachment?.mime).toBe("image/png");
    expect(attachment?.url.startsWith("data:image/png;base64,")).toBe(true);
    expect(Buffer.from(attachment!.url.split(",")[1]!, "base64")).toEqual(Buffer.from(FAKE_PNG_BYTES));

    // The session page and the driver were the same page throughout.
    const calls = h.page().calls;
    for (const expected of ["goto", "snapshot", "click", "fill", "read", "screenshot"]) {
      expect(calls, expected).toContain(expected);
    }

    // close — the whole session goes, and the next call would start fresh.
    const closed = await h.call("browse_close", {}, context);
    const closedMetadata = expectOk(closed, "browse_close");
    expect(closedMetadata).toMatchObject({ closed: "session", pages_closed: 1, remaining: 0, tabs: [] });
    expect(h.manager.sessionCount).toBe(0);
    expect(h.page().closed).toBe(true);
    expect(h.factory.drivers[0]!.closed).toBe(true);
  });

  it("refuses a stale ref after another tool navigated, and re-snapshotting restores it", async () => {
    const h = harness();
    const context = h.context();
    await h.call("browse_open", { url: HARNESS_URL }, context);
    await h.call("browse_snapshot", {}, context);

    // `browse_history` is what drops the map, and `browse_click` is what reports it.
    expectOk(await h.call("browse_history", { action: "reload" }, context), "browse_history");
    const stale = await h.call("browse_click", { target: "e1" }, context);
    const staleMetadata = expectEnvelope(stale, "browse_click");
    expect(staleMetadata.error).toBe(true);
    expect(staleMetadata.code).toBe("stale_ref");
    expect(staleMetadata.page).toBe("main");
    expect(staleMetadata.url).toBe(HARNESS_URL);
    expect(stale.output).toContain("ref e1 is stale");
    // The hint is folded into the sentence, so it reads in lower case.
    expect(stale.output.toLowerCase()).toContain("call browse_snapshot again");
    expect(h.page().clickTargets).toEqual([]);

    // A fresh snapshot re-arms the same ref, and the click reaches the driver.
    expectOk(await h.call("browse_snapshot", {}, context), "browse_snapshot");
    expectOk(await h.call("browse_click", { target: "e1" }, context), "browse_click");
    expect(h.page().clickTargets).toEqual([{ kind: "ref", ref: "e1" }]);

    // A navigation through `browse_open` drops them again, and the error names
    // the URL the page moved to rather than the URL the ref was taken on.
    const next = "https://example.com/next";
    expectOk(await h.call("browse_open", { url: next }, context), "browse_open");
    const staleAgain = await h.call("browse_click", { target: "e1" }, context);
    expect(metadataOf(staleAgain).code).toBe("stale_ref");
    expect(metadataOf(staleAgain).url).toBe(next);
  });

  it("translates a ref whose element vanished into stale_ref and forgets it", async () => {
    const h = harness();
    const context = h.context();
    await h.call("browse_open", { url: HARNESS_URL }, context);
    await h.call("browse_snapshot", {}, context);

    h.page().clickError = browseError(
      "element_not_found",
      "the element for ref e1 was not found",
      "Call browse_snapshot again.",
    );
    const vanished = await h.call("browse_click", { target: "e1" }, context);
    expect(metadataOf(vanished).code).toBe("stale_ref");
    expect(vanished.output).toContain('ref e1 (button "Save") is stale on page "main"');

    // The failed ref is dropped, so a second attempt reports the map, not the DOM.
    const again = await h.call("browse_click", { target: "e1" }, context);
    expect(metadataOf(again).code).toBe("stale_ref");
    expect(again.output).toContain("is not in the current snapshot");

    // Recovering is the documented loop: snapshot again, then act.
    h.page().clickError = null;
    expectOk(await h.call("browse_snapshot", {}, context), "browse_snapshot");
    expectOk(await h.call("browse_click", { target: "e1" }, context), "browse_click");
  });

  it("renders a non-browse driver failure as the one-sentence protocol_error result", async () => {
    const h = harness();
    const context = h.context();
    await h.call("browse_open", { url: HARNESS_URL }, context);
    await h.call("browse_snapshot", {}, context);

    h.page().clickError = new Error("boom");
    const failed = await h.call("browse_click", { target: "text=Save" }, context);
    const metadata = expectEnvelope(failed, "browse_click");
    expect(metadata.error).toBe(true);
    expect(metadata.code).toBe("protocol_error");
    expect(metadata.url).toBe(HARNESS_URL);
    expect(failed.output.startsWith("Error: ")).toBe(true);
    expect(failed.output.endsWith(".")).toBe(true);
    expect(failed.output).toContain("click failed (boom)");
    expect(failed.output).toContain("browse_status");
  });

  it("reports an unavailable driver from browse_status and refuses to launch for browse_open", async () => {
    const h = harness({
      available: false,
      reason: "the playwright module is not resolvable from rolebox",
    });
    const context = h.context();

    const status = await h.call("browse_status", {}, context);
    const statusMetadata = expectOk(status, "browse_status");
    expect(statusMetadata).toMatchObject({ available: false, page_count: 0, session_count: 0 });
    expect(statusMetadata.guidance).not.toBeNull();
    expect(status.output).toContain("Playwright: unavailable");
    expect(h.factory.launchCount).toBe(0);

    const open = await h.call("browse_open", { url: HARNESS_URL }, context);
    const openMetadata = expectEnvelope(open, "browse_open");
    expect(openMetadata.error).toBe(true);
    expect(openMetadata.code).toBe("driver_unavailable");
    expect(open.output).toContain("npm install playwright");
    expect(h.factory.launchCount).toBe(0);
  });
});

// ── Argument refusals at the record boundary ─────────────────────────────────

describe("browse_* argument refusals across the schema and tool layers", () => {
  /** One refusal per layer that can reject an argument, all before a launch. */
  const refusals: Array<{ label: string; tool: string; args: unknown; code: string }> = [
    { label: "schema enum on click modifiers", tool: "browse_click", args: { target: "e1", modifiers: ["Hyper"] }, code: "invalid_arguments" },
    { label: "schema type on browse_type submit", tool: "browse_type", args: { target: "e1", text: "x", submit: "yes" }, code: "invalid_arguments" },
    { label: "empty select values", tool: "browse_select", args: { target: "e1", values: [] }, code: "invalid_arguments" },
    { label: "target XOR delta scrolling", tool: "browse_scroll", args: { target: "e1", delta_y: 10 }, code: "invalid_arguments" },
    { label: "prompt_text with dismiss", tool: "browse_dialog", args: { action: "dismiss", prompt_text: "x" }, code: "invalid_arguments" },
    { label: "contradictory cookie scope", tool: "browse_cookies", args: { action: "set", name: "a", value: "b", url: "https://example.com/", domain: "example.com", path: "/" }, code: "invalid_arguments" },
    { label: "screenshot path escaping the worktree", tool: "browse_screenshot", args: { path: "../escape.png" }, code: "invalid_arguments" },
    { label: "navigation scheme a browser must not load", tool: "browse_open", args: { url: "javascript:alert(1)" }, code: "invalid_arguments" },
    { label: "url on browse_tabs action=list", tool: "browse_tabs", args: { action: "list", url: "https://example.com/" }, code: "invalid_arguments" },
    { label: "browse_wait with no condition", tool: "browse_wait", args: {}, code: "invalid_arguments" },
    { label: "unknown target prefix", tool: "browse_click", args: { target: "href=x" }, code: "invalid_target" },
  ];

  it("answers each refusal with a structured Error result and never launches a browser", async () => {
    for (const refusal of refusals) {
      const h = harness();
      const result = await h.call(refusal.tool, refusal.args);
      const metadata = metadataOf(result);
      expect(metadata.error, refusal.label).toBe(true);
      expect(metadata.code, refusal.label).toBe(refusal.code);
      expect(metadata.action, refusal.label).toBe(refusal.tool);
      expect(metadata.driver, refusal.label).toBe("playwright");
      expect(metadata.session, refusal.label).toBe("session-tools");
      expect(result.output.startsWith("Error: "), refusal.label).toBe(true);
      expect(result.output.endsWith("."), refusal.label).toBe(true);
      // The refusal happened before the session could start a browser.
      expect(h.factory.launchCount, refusal.label).toBe(0);
      expect(h.manager.sessionCount, refusal.label).toBe(0);
    }
  });
});

// ── The dsh policy seam ──────────────────────────────────────────────────────

function role(id: string, tools?: Record<string, boolean>): ResolvedRole {
  return {
    id,
    config: { name: id, description: id, prompt: id, ...(tools === undefined ? {} : { tools }) },
    prompt: id,
    skills: [],
    functions: [],
    references: [],
    subagents: [],
  };
}

/** A recording `ctx.tools` double — the guard registry the dsh host exposes. */
function guardRegistry(options: { disposer?: boolean } = {}) {
  const guards: Array<(execution: DshToolGuardExecution) => string | undefined> = [];
  let disposals = 0;
  const registry: DshToolGuardRegistry = {
    guard(guard) {
      guards.push(guard);
      if (options.disposer === false) return undefined;
      return () => {
        disposals += 1;
        const index = guards.indexOf(guard);
        if (index >= 0) guards.splice(index, 1);
      };
    },
  };
  return {
    registry,
    /** Run every installed guard; the first refusal wins, as the host's does. */
    evaluate(execution: DshToolGuardExecution): string | undefined {
      for (const guard of guards) {
        const refusal = guard(execution);
        if (refusal !== undefined) return refusal;
      }
      return undefined;
    },
    installed: () => guards.length,
    disposals: () => disposals,
  };
}

/** The execution shape the dsh guard receives for one session. */
function executionFor(name: string, sessionId: string): DshToolGuardExecution {
  return { name, agent: { id: "agent", session: { id: sessionId } } };
}

describe("dsh browse policy over the resolved roles", () => {
  it("refuses browse_* for a role that disables them while allowing the base agent", () => {
    const denying = role("no-browse", { "browse_*": false });
    const partial = role("partial-browse", { "browse_*": true, browse_screenshot: false });
    const guards = guardRegistry();
    const roles: ResolvedRole[] = [denying, partial];
    const activeRooms: Record<string, string | null> = {
      "s-base": null,
      "s-denying": "no-browse",
      "s-partial": "partial-browse",
    };
    const options: DshToolFamilyPolicyOptions = {
      tools: guards.registry,
      enabled: true,
      activeRoleOf: (sessionId: string) => activeRooms[sessionId] ?? null,
      roles: () => roles,
    };
    const policy = installDshBrowseUsePolicy(options);
    expect(policy.gateEnabled).toBe(true);
    expect(policy.guardInstalled).toBe(true);
    expect(policy.allowRegistration).toBe(true);
    expect(policy.reason).toContain("browse_*");

    // The base agent has no role config, so the family is allowed.
    expect(guards.evaluate(executionFor("browse_open", "s-base"))).toBeUndefined();
    expect(guards.evaluate(executionFor("browse_close", "s-base"))).toBeUndefined();

    // A role that sets browse_*: false is refused, by name and with the fix.
    const refusal = guards.evaluate(executionFor("browse_open", "s-denying"));
    expect(refusal).toBeDefined();
    expect(refusal).toContain('Browse use denied for role "no-browse"');
    expect(refusal).toContain('"browse_open"');
    expect(refusal).toContain("role.yaml");

    // The guard owns its own namespace only: another family is untouched.
    expect(guards.evaluate(executionFor("computer_screenshot", "s-denying"))).toBeUndefined();
    expect(guards.evaluate(executionFor("hashline_read", "s-denying"))).toBeUndefined();

    // An exact rule beats the wildcard: one tool denied, the rest allowed.
    expect(guards.evaluate(executionFor("browse_open", "s-partial"))).toBeUndefined();
    expect(guards.evaluate(executionFor("browse_screenshot", "s-partial"))).toContain('disables "browse_screenshot"');

    // Registering is admitted only while the installed policy allows it.
    for (const name of HUB_TOOL_NAMES) {
      expect(isBrowseUseRegistrationAllowed(name, policy.allowRegistration), name).toBe(true);
    }
    policy.dispose();
    expect(guards.disposals()).toBe(1);
    expect(guards.installed()).toBe(0);
  });

  it("denies a role that is not in the resolved set instead of assuming it is unrestricted", () => {
    const guards = guardRegistry();
    const policy = installDshBrowseUsePolicy({
      tools: guards.registry,
      enabled: true,
      activeRoleOf: () => "ghost",
      roles: () => [],
    });
    expect(policy.allowRegistration).toBe(true);
    const refusal = guards.evaluate(executionFor("browse_snapshot", "s-ghost"));
    expect(refusal).toContain('Browse use denied for role "ghost"');
    expect(refusal).toContain("not in the resolved role set");
  });

  it("fails closed — no gate and no guard registry both refuse registration", () => {
    const gateOff = installDshBrowseUsePolicy({
      tools: guardRegistry().registry,
      enabled: false,
      activeRoleOf: () => null,
      roles: () => [],
    });
    expect(gateOff).toMatchObject({ gateEnabled: false, guardInstalled: false, allowRegistration: false });
    for (const name of HUB_TOOL_NAMES) {
      expect(isBrowseUseRegistrationAllowed(name, gateOff.allowRegistration), name).toBe(false);
    }

    const noGuard = installDshBrowseUsePolicy({
      tools: {},
      enabled: true,
      activeRoleOf: () => null,
      roles: () => [],
    });
    expect(noGuard).toMatchObject({ gateEnabled: true, guardInstalled: false, allowRegistration: false });
    expect(noGuard.reason).toContain("ctx.tools.guard");

    const noDisposer = installDshBrowseUsePolicy({
      tools: guardRegistry({ disposer: false }).registry,
      enabled: true,
      activeRoleOf: () => null,
      roles: () => [],
    });
    expect(noDisposer.allowRegistration).toBe(false);
    expect(noDisposer.reason).toContain("returned no disposer");
  });
});
