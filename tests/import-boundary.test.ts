/// <reference types="bun-types" />

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SOURCE_PATH = resolve(import.meta.dir, "../src/platform/tool-assembly.ts");

function readSource(): string {
  return readFileSync(SOURCE_PATH, "utf-8");
}

/**
 * Extract import path specifiers from the source file.
 * Only matches `import ... from "..."` statements, ignoring comments.
 */
function extractImportSpecifiers(source: string): string[] {
  const importRe = /import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+["']([^"']+)["']/g;
  const specifiers: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(source)) !== null) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

describe("import boundary for src/tool-assembly.ts", () => {
  it("does not import from @opencode-ai/plugin", () => {
    const specifiers = extractImportSpecifiers(readSource());
    const forbidden = specifiers.filter((s) => s.includes("@opencode-ai/plugin"));
    expect(forbidden).toEqual([]);
  });

  it("does not import from @earendil-works/pi-coding-agent", () => {
    const specifiers = extractImportSpecifiers(readSource());
    const forbidden = specifiers.filter((s) => s.includes("@earendil-works/pi-coding-agent"));
    expect(forbidden).toEqual([]);
  });

  it("does not import from src/session/client.ts", () => {
    const specifiers = extractImportSpecifiers(readSource());
    const forbidden = specifiers.filter((s) => s.includes("session/client"));
    expect(forbidden).toEqual([]);
  });

  it("does not import from src/platform/adapters/opencode/session.ts", () => {
    const specifiers = extractImportSpecifiers(readSource());
    const forbidden = specifiers.filter((s) => s.includes("opencode/session"));
    expect(forbidden).toEqual([]);
  });
});
