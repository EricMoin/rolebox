/// <reference types="bun-types" />

/**
 * UNIT AND END-TO-END TESTS for `scripts/check-logging-boundaries.ts`
 * (the guard that keeps `src/**`/`tests/**` on the platform logging pipeline).
 *
 * What is pinned here:
 *
 * 1. THE LIVE TREE PASSES. The same scan the CI-style command runs finds no
 *    tslog import and no console call outside the sink, `src/cli/**` and the
 *    whitelist.
 * 2. EVERY EXEMPTION IS EXPLICIT AND ALIVE. Each whitelist entry states a
 *    reason, names a path that exists in this tree, and is published in the
 *    guard's JSON data — an exemption cannot be silent, and it cannot rot.
 * 3. THE RULES FIRE, with the right `file:line`. Fixture trees (temporary
 *    directories, never the workspace) pin the tslog rule in both scopes, the
 *    console rule in every spelling a call can take, and the fact that a
 *    console ASSIGNMENT (the capture pattern) is not a call.
 * 4. THE COMMAND CONTRACT. `bun run scripts/check-logging-boundaries.ts` exits 1
 *    and names `file:line` on a violating tree, and exits 0 on this one.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  CONSOLE_ALLOWED,
  CONSOLE_WHITELIST,
  consoleAllowedFor,
  runLoggingBoundaryCheck,
  violationLine,
  type BoundaryReport,
} from "../scripts/check-logging-boundaries.ts";

/** The repository root: the guard's default subject. */
const ROOT = resolve(import.meta.dir, "..");
/** The guard's own entry point, spawned as the CLI by the command tests. */
const SCRIPT = join(ROOT, "scripts/check-logging-boundaries.ts");

/** Fixture trees created by a test; removed after it. */
const fixtures: string[] = [];

/** Write `files` into a fresh temporary directory and return its path. */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "rolebox-logging-boundary-"));
  fixtures.push(root);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

/** Run the guard as the command does, against `root` (or the workspace). */
function runCli(root?: string): { exitCode: number; stdout: string; stderr: string } {
  const cmd = root === undefined ? [process.execPath, SCRIPT] : [process.execPath, SCRIPT, "--root", root];
  const result = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" });
  return { exitCode: result.exitCode ?? -1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("the live tree", () => {
  it("imports no tslog and calls console only where the guard allows it", () => {
    expect(runLoggingBoundaryCheck(ROOT).violations).toEqual([]);
  });

  it("scans both scopes, so an empty result cannot mean an empty scan", () => {
    const report = runLoggingBoundaryCheck(ROOT);
    expect(report.scanned.sourceFiles).toBeGreaterThan(100);
    expect(report.scanned.testFiles).toBeGreaterThan(100);
    expect(report.root).toBe(ROOT);
  });
});

describe("the console exemptions", () => {
  it("keeps the console sink and the CLI's user output as the standing exceptions", () => {
    expect(CONSOLE_ALLOWED).toContain("src/log/sinks/console.ts");
    expect(CONSOLE_ALLOWED).toContain("src/cli/**");
  });

  it("states a reason for every whitelist entry and names a path that exists", () => {
    expect(CONSOLE_WHITELIST.length).toBeGreaterThan(0);
    for (const entry of CONSOLE_WHITELIST) {
      expect(entry.path.startsWith("/")).toBe(false);
      expect(entry.path.length).toBeGreaterThan(0);
      // A reason, not a placeholder: the entry has to say WHY, for a reviewer.
      expect(entry.reason.trim().length).toBeGreaterThan(40);
      expect(existsSync(join(ROOT, entry.path))).toBe(true);
    }
  });

  it("allows exactly the sink, the CLI subtree and the whitelisted paths", () => {
    expect(consoleAllowedFor("src/log/sinks/console.ts")).toBe(true);
    expect(consoleAllowedFor("src/cli/commands/list.ts")).toBe(true);
    for (const entry of CONSOLE_WHITELIST) expect(consoleAllowedFor(entry.path)).toBe(true);
    expect(consoleAllowedFor("src/cli.ts")).toBe(false);
    expect(consoleAllowedFor("src/log/index.ts")).toBe(false);
    expect(consoleAllowedFor("src/tui/events.ts")).toBe(false);
  });

  it("publishes the whitelist, reasons included, in the report's data", () => {
    const report = runLoggingBoundaryCheck(ROOT);
    expect(report.consoleWhitelist).toEqual(CONSOLE_WHITELIST);
    expect(report.consoleAllowed).toEqual(CONSOLE_ALLOWED);
    expect(report.rules.tslogImports.length).toBeGreaterThan(0);
    expect(report.rules.consoleCalls.length).toBeGreaterThan(0);
  });
});

describe("the tslog rule", () => {
  it("reports the import with its file and line", () => {
    const root = fixture({ "src/legacy.ts": 'import { Logger } from "tslog";\n\nexport type L = Logger;\n' });
    expect(runLoggingBoundaryCheck(root).violations.map(violationLine)).toEqual([
      'src/legacy.ts:1  [tslog-import] imports the retired logging package "tslog"; the platform pipeline lives in src/log',
    ]);
  });

  it("covers a subpath import, a require and an import type, in src and in tests", () => {
    const root = fixture({
      "src/a.ts": 'import "tslog/transports";\n',
      "src/b.ts": 'const { Logger } = require("tslog");\n',
      "src/c.ts": 'export type Meta = import("tslog").IMeta;\n',
      "tests/d.test.ts": 'import { Logger } from "tslog";\n',
    });
    const lines = runLoggingBoundaryCheck(root).violations.map((violation) => `${violation.file}:${violation.line}`);
    expect(lines).toEqual(["src/a.ts:1", "src/b.ts:1", "src/c.ts:1", "tests/d.test.ts:1"]);
    expect(runLoggingBoundaryCheck(root).violations.every((violation) => violation.rule === "tslog-import")).toBe(true);
  });

  it("leaves a comment that mentions tslog alone", () => {
    const root = fixture({ "src/comment.ts": "// tslog used to live here; the kernel replaced it.\nexport const x = 1;\n" });
    expect(runLoggingBoundaryCheck(root).violations).toEqual([]);
  });
});

describe("the console rule", () => {
  it("reports every spelling of a console call, with its line", () => {
    const root = fixture({
      "src/thing.ts": [
        'console.log("a");',
        'globalThis.console.warn("b");',
        'console["error"]("c");',
        'console?.debug("d");',
        'window.console.info("e");',
      ].join("\n"),
    });
    const violations = runLoggingBoundaryCheck(root).violations;
    expect(violations.map((violation) => violation.line)).toEqual([1, 2, 3, 4, 5]);
    expect(violations.every((violation) => violation.rule === "console-call")).toBe(true);
    expect(violations[0]?.detail).toContain("src/log");
  });

  it("does not report a console assignment — the capture pattern is not a call", () => {
    const root = fixture({ "src/capture.ts": "console.warn = () => {};\nconsole.error = console.warn;\n" });
    expect(runLoggingBoundaryCheck(root).violations).toEqual([]);
  });

  it("leaves the console sink, the CLI and the whitelisted browser file alone", () => {
    const whitelisted = CONSOLE_WHITELIST[0]!.path;
    const root = fixture({
      "src/log/sinks/console.ts": 'console.warn("the sink writes here");\n',
      "src/cli/commands/list.ts": 'console.log("user output");\n',
      [whitelisted]: 'console.warn("browser only");\n',
    });
    expect(runLoggingBoundaryCheck(root).violations).toEqual([]);
  });

  it("does not apply the console rule to tests, which capture and print deliberately", () => {
    const root = fixture({ "tests/thing.test.ts": 'console.log("test scaffolding");\n' });
    expect(runLoggingBoundaryCheck(root).violations).toEqual([]);
  });
});

describe("the command contract", () => {
  it("exits 1 and names file:line on a violating tree", () => {
    const root = fixture({ "src/thing.ts": 'const x = 1;\nconsole.warn("nope");\n' });
    const { exitCode, stdout, stderr } = runCli(root);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("src/thing.ts:2");
    expect(stderr).toContain("[console-call]");
    const report = JSON.parse(stdout) as BoundaryReport;
    expect(report.violations.length).toBe(1);
    // The JSON report and the stderr line name the SAME place.
    expect(violationLine(report.violations[0]!)).toContain("src/thing.ts:2");
    expect(stderr).toContain(violationLine(report.violations[0]!));
  });

  it("exits 0, with no violation and the whitelist in its data, on this tree", () => {
    const { exitCode, stdout, stderr } = runCli();
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const report = JSON.parse(stdout) as BoundaryReport;
    expect(report.violations).toEqual([]);
    expect(report.consoleWhitelist).toEqual(CONSOLE_WHITELIST);
  });
});
