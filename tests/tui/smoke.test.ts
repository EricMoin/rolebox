/// <reference types="bun-types" />

import { describe, it, expect } from "bun:test";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Smoke test for the TUI plugin module shape.
 *
 * Verifies that the plugin module exports a TuiPluginModule with the
 * expected contract (id, tui) and that logic.ts has no UI framework imports.
 */
describe("TUI plugin module", () => {
  const indexPath = resolve(import.meta.dir, "../../src/tui/index.tsx");

  it("has the correct TuiPluginModule export shape via source analysis", () => {
    const source = readFileSync(indexPath, "utf-8");

    // Must define a `tuiPluginModule` object with `id` and `tui`
    expect(source).toContain('id: "rolebox-tui"');
    expect(source).toContain("tui:");
    expect(source).toContain("export default tuiPluginModule");
  });

  it("default export is named tuiPluginModule", () => {
    const source = readFileSync(indexPath, "utf-8");
    const exportRe = /export\s+default\s+(\w+)/;
    const match = source.match(exportRe);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("tuiPluginModule");
  });

  it("tuiPluginModule has `id` and `tui` properties and NOT `server`", () => {
    const source = readFileSync(indexPath, "utf-8");
    // Check that the module object shape is correct
    expect(source).toContain("const tuiPluginModule");
    expect(source).toContain("id:");
    expect(source).toContain("tui:");
    // Server should NOT be in the TUI module
    expect(source).not.toContain("server:");
  });

  it("has no imports from @opentui/solid or solid-js in logic.ts", () => {
    // Logic.ts should be pure — check source for forbidden imports
    const logicSource = readFileSync(
      resolve(import.meta.dir, "../../src/tui/logic.ts"),
      "utf-8",
    );
    expect(logicSource).not.toContain("@opentui/solid");
    expect(logicSource).not.toContain("solid-js");
    // But it should export the expected functions
    expect(logicSource).toContain("export function computeHealth");
    expect(logicSource).toContain("export function getActiveTasks");
    expect(logicSource).toContain("export function computeFilteredActivity");
  });
});
