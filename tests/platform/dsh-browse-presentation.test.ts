
/**
 * dsh native presentation for the browse tool family.
 *
 * `DSH_TOOL_PRESENTATION` (src/platform/adapters/dsh/tool-factory.ts) declares
 * the optional dsh presentation surface. The `browse_*` tools are merged into
 * the canonical tool set only when the host's browse gate resolved on, so this
 * pins:
 *
 * - every one of the 23 real tool names has a declared decision (drift guard);
 * - `browse_open` renders the URL it will load and `browse_screenshot` the file
 *   or element it will capture;
 * - ONLY the read-only `browse_status` probe may join a parallel group — every
 *   other member shares one browser session, one page and one ref map.
 *
 * No browser is launched: only the pure projectors and the compiled definitions
 * are exercised, never `execute`.
 */

import { describe, it, expect } from "vitest";
import {
  DSH_TOOL_PRESENTATION,
  DshToolFactory,
} from "../../src/platform/adapters/dsh/tool-factory.ts";
import type { DshToolDefinition } from "../../src/platform/adapters/dsh/tool-factory.ts";
import { buildCanonicalTools } from "../../src/platform/tool-assembly.ts";
import { opencodeCapabilities } from "../../src/platform/capabilities.ts";
import { createBrowseTools } from "../../src/browse/tools.ts";
import { BROWSE_TOOL_NAMES } from "../../src/loader/browse-grants.ts";

/** Concurrency-safe members: the status probe alone. */
const CONCURRENT_TOOL_NAMES = ["browse_status"] as const;

function compiledBrowseTools(): Record<string, DshToolDefinition> {
  const factory = new DshToolFactory();
  return factory.compileAll(
    buildCanonicalTools({
      resolvedRoles: [],
      directory: process.cwd(),
      capabilities: opencodeCapabilities(),
      browseUse: true,
    }),
  ) as Record<string, DshToolDefinition>;
}

describe("dsh browse_* native presentation", () => {
  it("declares an entry for every canonical browse tool name", () => {
    // Drift guard: the real tool record (src/browse/tools.ts) supplies the
    // names; every one of them must have a declared presentation decision.
    expect(Object.keys(createBrowseTools()).sort()).toEqual([...BROWSE_TOOL_NAMES].sort());
    expect(BROWSE_TOOL_NAMES).toHaveLength(23);
    for (const name of BROWSE_TOOL_NAMES) {
      expect(DSH_TOOL_PRESENTATION[name], name).toBeDefined();
    }
  });

  it("titles browse_open with the URL, else the page it opens", () => {
    const present = DSH_TOOL_PRESENTATION["browse_open"]!.presentCall!;
    expect(present({ url: "https://example.com/docs" })).toEqual({
      card: "generic",
      title: "https://example.com/docs",
      kind: "fetch",
      rawInput: "https://example.com/docs",
    });
    expect(present({ url: "https://example.com/docs", page: "docs" })?.title).toBe("https://example.com/docs");
    expect(present({ page: "docs" })).toEqual({ card: "generic", title: "Open page docs", kind: "fetch" });
    expect(present({})?.title).toBe("Open the browser");
    // Pure and replay-safe: dsh may call a presenter twice (live + replay).
    expect(present({ url: "https://example.com" })).toEqual(present({ url: "https://example.com" }));
  });

  it("titles browse_screenshot with the path, the element or the page", () => {
    const present = DSH_TOOL_PRESENTATION["browse_screenshot"]!.presentCall!;
    expect(present({ path: ".rolebox/browse/shot.png" })).toEqual({
      card: "generic",
      title: "Screenshot .rolebox/browse/shot.png",
      locations: [{ path: ".rolebox/browse/shot.png" }],
    });
    expect(present({ selector: "#hero" })?.title).toBe("Screenshot #hero");
    expect(present({ page: "checkout" })?.title).toBe("Screenshot page checkout");
    expect(present({})?.title).toBe("Screenshot the page");
    expect(present({ path: ".rolebox/browse/a.png" })).toEqual(present({ path: ".rolebox/browse/a.png" }));
  });

  it("declares isConcurrencySafe for the read-only status probe only", () => {
    for (const name of CONCURRENT_TOOL_NAMES) {
      expect(DSH_TOOL_PRESENTATION[name]!.isConcurrencySafe?.({}), name).toBe(true);
    }
    for (const name of BROWSE_TOOL_NAMES) {
      if ((CONCURRENT_TOOL_NAMES as readonly string[]).includes(name)) continue;
      expect(DSH_TOOL_PRESENTATION[name]!.isConcurrencySafe, name).toBeUndefined();
    }
    // `browse_status` takes no arguments; the classifier must not read them.
    expect(DSH_TOOL_PRESENTATION["browse_status"]!.isConcurrencySafe?.(null)).toBe(true);
  });

  it("compiles that surface onto the real definitions — nothing more, nothing less", () => {
    const compiled = compiledBrowseTools();
    for (const name of BROWSE_TOOL_NAMES) {
      const def = compiled[name];
      expect(def, `${name} was not compiled`).toBeDefined();
      const entry = DSH_TOOL_PRESENTATION[name]!;
      expect(def!.presentCall === undefined, `${name}.presentCall`).toBe(entry.presentCall === undefined);
      expect(def!.isConcurrencySafe === undefined, `${name}.isConcurrencySafe`).toBe(entry.isConcurrencySafe === undefined);
      // No timeout budget and no result projection are declared for this family.
      expect(def!.timeoutMs, `${name}.timeoutMs`).toBeUndefined();
      expect(def!.presentResult, `${name}.presentResult`).toBeUndefined();
      expect(def!.output.presentationMeta, `${name}.presentationMeta`).toBeUndefined();
    }
    expect(typeof compiled["browse_open"]!.presentCall).toBe("function");
    expect(typeof compiled["browse_screenshot"]!.presentCall).toBe("function");
    expect(typeof compiled["browse_status"]!.isConcurrencySafe).toBe("function");
    expect(compiled["browse_status"]!.isConcurrencySafe?.({})).toBe(true);
    expect(compiled["browse_click"]!.isConcurrencySafe).toBeUndefined();
    expect(compiled["browse_snapshot"]!.isConcurrencySafe).toBeUndefined();
    expect(compiled["browse_read"]!.isConcurrencySafe).toBeUndefined();
  });

  it("does not add the family when the host did not opt in", () => {
    const factory = new DshToolFactory();
    const compiled = factory.compileAll(
      buildCanonicalTools({
        resolvedRoles: [],
        directory: process.cwd(),
        capabilities: opencodeCapabilities(),
      }),
    ) as Record<string, DshToolDefinition>;
    expect(Object.keys(compiled)).toContain("web_fetch");
    for (const name of BROWSE_TOOL_NAMES) expect(compiled[name], name).toBeUndefined();
  });
});
