/// <reference types="bun-types" />

/**
 * dsh native presentation for the computer-use tool family.
 *
 * `DSH_TOOL_PRESENTATION` (src/platform/adapters/dsh/tool-factory.ts) declares
 * the optional dsh presentation surface. The seven `computer_*` tools are
 * merged into the canonical tool set only when the host opts in
 * (`buildCanonicalTools(..., { computerUse: true })`), so this pins:
 *
 * - `computer_screenshot` renders a generic card titled with the window or
 *   path it will capture;
 * - `computer_windows` / `computer_permissions` — read-only probes that mutate
 *   no rolebox-owned state — may join a parallel group;
 * - the four INPUT tools (`computer_click`, `computer_move`, `computer_type`,
 *   `computer_key`) never declare `isConcurrencySafe`, because overlapping
 *   calls would interleave real user-visible pointer/keyboard input.
 *
 * No GUI is touched: only the pure projectors and the compiled definitions are
 * exercised, never `execute`.
 *
 * @module
 */

import { describe, it, expect } from "bun:test";
import {
  DSH_TOOL_PRESENTATION,
  DshToolFactory,
} from "../../src/platform/adapters/dsh/tool-factory.ts";
import type { DshToolDefinition } from "../../src/platform/adapters/dsh/tool-factory.ts";
import { buildCanonicalTools } from "../../src/platform/tool-assembly.ts";
import { opencodeCapabilities } from "../../src/platform/capabilities.ts";
import { createComputerTools } from "../../src/computer/tools.ts";

const COMPUTER_TOOL_NAMES = [
  "computer_screenshot",
  "computer_windows",
  "computer_click",
  "computer_move",
  "computer_type",
  "computer_key",
  "computer_permissions",
] as const;

/** The four tools that synthesize shared pointer/keyboard input. */
const INPUT_TOOL_NAMES = [
  "computer_click",
  "computer_move",
  "computer_type",
  "computer_key",
] as const;

function compiledComputerTools(): Record<string, DshToolDefinition> {
  const factory = new DshToolFactory();
  return factory.compileAll(
    buildCanonicalTools({
      resolvedRoles: [],
      directory: process.cwd(),
      capabilities: opencodeCapabilities(),
      computerUse: true,
    }),
  ) as Record<string, DshToolDefinition>;
}

describe("dsh computer_* native presentation", () => {
  it("declares an entry for every canonical computer tool name", () => {
    // Drift guard: the real tool record (src/computer/tools.ts) supplies the
    // names; every one of them must have a declared presentation decision.
    expect(Object.keys(createComputerTools()).sort()).toEqual([...COMPUTER_TOOL_NAMES].sort());
    for (const name of COMPUTER_TOOL_NAMES) {
      expect(DSH_TOOL_PRESENTATION[name], name).toBeDefined();
    }
  });

  it("titles the screenshot card with the path, the window id, or the screen", () => {
    const present = DSH_TOOL_PRESENTATION["computer_screenshot"]!.presentCall!;

    expect(present({ path: "/tmp/shot.png" })).toEqual({
      card: "generic",
      title: "Screenshot /tmp/shot.png",
      locations: [{ path: "/tmp/shot.png" }],
    });
    expect(present({ window_id: 7 })).toEqual({
      card: "generic",
      title: "Screenshot window 7",
    });
    expect(present({})?.title).toBe("Screenshot the screen");
    // Pure and replay-safe: dsh may call a presenter twice (live + replay).
    expect(present({ window_id: 7 })).toEqual(present({ window_id: 7 }));
  });

  it("declares isConcurrencySafe for the read-only probes only", () => {
    for (const name of ["computer_windows", "computer_permissions"] as const) {
      expect(DSH_TOOL_PRESENTATION[name]!.isConcurrencySafe?.({}), name).toBe(true);
    }
    for (const name of INPUT_TOOL_NAMES) {
      expect(DSH_TOOL_PRESENTATION[name]!.isConcurrencySafe, name).toBeUndefined();
    }
    expect(DSH_TOOL_PRESENTATION["computer_screenshot"]!.isConcurrencySafe).toBeUndefined();
  });

  it("compiles that surface onto the real definitions — nothing more, nothing less", () => {
    const compiled = compiledComputerTools();

    for (const name of COMPUTER_TOOL_NAMES) {
      const def = compiled[name];
      expect(def, `${name} was not compiled`).toBeDefined();
      const entry = DSH_TOOL_PRESENTATION[name]!;
      expect(def!.presentCall === undefined, `${name}.presentCall`).toBe(
        entry.presentCall === undefined,
      );
      expect(def!.isConcurrencySafe === undefined, `${name}.isConcurrencySafe`).toBe(
        entry.isConcurrencySafe === undefined,
      );
      // No timeout budget and no result projection are declared for this family.
      expect(def!.timeoutMs, `${name}.timeoutMs`).toBeUndefined();
      expect(def!.presentResult, `${name}.presentResult`).toBeUndefined();
      expect(def!.output.presentationMeta, `${name}.presentationMeta`).toBeUndefined();
    }

    expect(typeof compiled["computer_screenshot"]!.presentCall).toBe("function");
    expect(typeof compiled["computer_windows"]!.isConcurrencySafe).toBe("function");
    expect(typeof compiled["computer_permissions"]!.isConcurrencySafe).toBe("function");
    for (const name of INPUT_TOOL_NAMES) {
      expect(compiled[name]!.isConcurrencySafe, `${name}.isConcurrencySafe`).toBeUndefined();
    }
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
    for (const name of COMPUTER_TOOL_NAMES) {
      expect(compiled[name], name).toBeUndefined();
    }
  });
});
