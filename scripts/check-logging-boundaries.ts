// ── The logging boundary guard ──────────────────────────────────────────────
//
// ONE QUESTION, ASKED OF EVERY SOURCE FILE: does this file reach console bytes,
// or the retired logging package, WITHOUT going through the logging pipeline?
//
// THE RULES
//
//   1. NO tslog IMPORT — in `src/**` and in `tests/**`. Stage 2 moved every
//      module onto the platform kernel (src/log/**) and removed the package, so
//      an import of "tslog" (or "tslog/…") is a regression whether or not the
//      package happens to be installed. A COMMENT that mentions tslog is fine:
//      this guard reads the import specifiers, not the prose.
//
//   2. NO DIRECT console CALL IN `src/**` — with two standing exceptions and one
//      whitelisted file:
//        • `src/log/sinks/console.ts` — the platform's own console destination:
//          the ONE place a record becomes console bytes;
//        • `src/cli/**` — the CLI's user-visible output, which is a product
//          interface rather than a diagnostic log (the Stage 2 scope decision);
//        • {@link CONSOLE_WHITELIST} — a file that cannot use the pipeline, with
//          the reason recorded HERE and carried into this script's JSON data, so
//          a reviewer reads the justification next to the exemption.
//
//      `tests/**` is deliberately OUT of scope for this rule: a test that asserts
//      on captured output has to replace or call console itself (179 call sites),
//      which is test scaffolding, not a diagnostic channel. The tslog rule still
//      covers `tests/**`.
//
//      A console ASSIGNMENT (`console.warn = …`, the capture pattern) is not a
//      call and is not reported: this guard is about diagnostics WRITTEN to the
//      console, not about code that hijacks the console.
//
//   3. EXIT 1, WITH `file:line`, when any rule is violated. The machine-readable
//      report goes to stdout (JSON); the same violations are listed on stderr as
//      `path:line  [rule] detail` so the failure names its file:line without a
//      JSON reader.
//
// SCOPE OF THE SCAN. `src/**` and `tests/**`, `.ts` and `.tsx`, read from the
// repository root (or from `--root`, which the guard's own test uses to point it
// at a fixture tree). `scripts/**` is deliberately not scanned: this guard
// itself reports through console, because a build tool's output is not the
// platform pipeline.
//
// USAGE
//   bun run scripts/check-logging-boundaries.ts               # the workspace
//   bun run scripts/check-logging-boundaries.ts --root <dir>  # a fixture tree

import ts from "typescript";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The logging package Stage 2 retired: imported nowhere in src/ or tests/. */
export const RETIRED_LOGGING_PACKAGE = "tslog";

/**
 * The two standing console exceptions: the platform's own console sink and the
 * CLI's user-visible output. A pattern without `*` is an exact path; `**`
 * matches every descendant.
 */
export const CONSOLE_ALLOWED: readonly string[] = ["src/log/sinks/console.ts", "src/cli/**"];

/** One exemption from the console rule: the path, and WHY it is exempt. */
export interface ConsoleWhitelistEntry {
  /** Repository-relative path or glob (see {@link matchesPattern}). */
  readonly path: string;
  /** The justification, read by a reviewer and carried in the JSON report. */
  readonly reason: string;
}

/**
 * Files allowed to call console outside {@link CONSOLE_ALLOWED}. Every entry
 * needs a reason; the guard's own test fails an entry without one, and the
 * report publishes them so an exemption can never be silent.
 */
export const CONSOLE_WHITELIST: readonly ConsoleWhitelistEntry[] = [
  {
    path: "src/platform/adapters/dsh/web-ui/client.ts",
    reason:
      "Browser code: this file is the dsh web client bundle (scripts/build-dsh-web-client.ts, target 'browser'), and the platform kernel cannot load there — src/log/context.ts pulls node:async_hooks, which Bun's browser target stubs to an empty module, so `new AsyncLocalStorage` throws while the bundle is evaluated (measured: \"TypeError: undefined is not a constructor (evaluating 'new import_node_async_hooks.AsyncLocalStorage')\"). console.warn is the only channel a failed slot registration has in the browser; the guard must not pretend otherwise.",
  },
];

/** Which rule a violation broke. */
export type BoundaryRule = "tslog-import" | "console-call";

/** One broken rule, at one place. */
export interface BoundaryViolation {
  /** Repository-relative path, always with `/` separators. */
  readonly file: string;
  /** 1-based line of the offending import or call. */
  readonly line: number;
  readonly rule: BoundaryRule;
  readonly detail: string;
}

/** The guard's machine-readable answer; printed as JSON by the CLI. */
export interface BoundaryReport {
  readonly root: string;
  readonly scanned: {
    readonly sourceFiles: number;
    readonly testFiles: number;
  };
  readonly rules: {
    readonly tslogImports: string;
    readonly consoleCalls: string;
  };
  readonly consoleAllowed: readonly string[];
  readonly consoleWhitelist: readonly ConsoleWhitelistEntry[];
  readonly violations: readonly BoundaryViolation[];
}

/** The repository root this script lives in (`scripts/..`). */
export function repositoryRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/** Turn a `*`/`**` pattern into an anchored regular expression. */
function patternToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        out += ".*";
        index += 1;
      } else {
        out += "[^/]*";
      }
      continue;
    }
    out += character.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(out + "$");
}

/** True when a repository-relative path matches an exact path or a glob. */
export function matchesPattern(path: string, pattern: string): boolean {
  if (!pattern.includes("*")) return path === pattern;
  return patternToRegExp(pattern).test(path);
}

/** Every `.ts`/`.tsx` file under `directory`, or `[]` when it does not exist. */
function collectTypeScriptFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** A parsed file, with its text and the compiler's own source object. */
interface ParsedFile {
  readonly path: string;
  readonly source: ts.SourceFile;
}

/** Parse one file for the AST walks below. Parse errors are not this guard's job. */
function parseFile(path: string): ParsedFile {
  return {
    path,
    source: ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true),
  };
}

/** The 1-based line of a node in its file. */
function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

/** A repository-relative path with `/` separators, whatever the platform uses. */
function relativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

/** Every module specifier a file imports, exports from, requires or imports as a type. */
function visitModuleSpecifiers(
  file: ParsedFile,
  onSpecifier: (node: ts.Node, text: string | undefined) => void,
): void {
  const check = (specifier: ts.Node | undefined): void => {
    if (!specifier) return;
    onSpecifier(specifier, ts.isStringLiteralLike(specifier) ? specifier.text : undefined);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) check(node.moduleSpecifier);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) check(node.argument.literal);
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      check(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file.source);
}

/** The global objects a `console` can hang off, spelled as an identifier. */
const CONSOLE_HOSTS: readonly string[] = ["globalThis", "window", "self", "global"];

/** True when an expression names a console HOST (`globalThis`, `window`, …). */
function isConsoleHost(expression: ts.Expression): boolean {
  return ts.isIdentifier(expression) && CONSOLE_HOSTS.includes(expression.text);
}

/**
 * The `console` (or `globalThis.console`, `window["console"]`, …) an expression
 * names, if any. A bare identifier `console` counts; so does one property or
 * element access off a known host, which is how a module that shadows nothing
 * still reaches the same object.
 */
function isConsoleReference(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return expression.text === "console";
  if (ts.isPropertyAccessExpression(expression) || ts.isPropertyAccessChain(expression)) {
    return expression.name.text === "console" && isConsoleHost(expression.expression);
  }
  if (ts.isElementAccessExpression(expression) || ts.isElementAccessChain(expression)) {
    const argument = expression.argumentExpression;
    if (!argument || !ts.isStringLiteralLike(argument) || argument.text !== "console") return false;
    return isConsoleHost(expression.expression);
  }
  return false;
}

/** The `console.x(…)` method a call names, or `undefined` when it is not one. */
function consoleMethodOf(node: ts.CallExpression): string | undefined {
  const callee = node.expression;
  if (ts.isPropertyAccessExpression(callee) || ts.isPropertyAccessChain(callee)) {
    return isConsoleReference(callee.expression) ? callee.name.text : undefined;
  }
  if (ts.isElementAccessExpression(callee) || ts.isElementAccessChain(callee)) {
    if (!isConsoleReference(callee.expression)) return undefined;
    const argument = callee.argumentExpression;
    return argument && ts.isStringLiteralLike(argument) ? argument.text : "?";
  }
  return undefined;
}

/** The console calls a file makes, as `file:line` violations. */
function consoleViolations(file: ParsedFile, reportFile: string): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isCallChain(node)) {
      const method = consoleMethodOf(node);
      if (method !== undefined) {
        violations.push({
          file: reportFile,
          line: lineOf(file.source, node),
          rule: "console-call",
          detail: `console.${method}(…) writes a diagnostic outside the logging pipeline; use src/log (createLogger/logEvent) instead`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file.source);
  return violations;
}

/** The tslog imports a file makes, as `file:line` violations. */
function tslogViolations(file: ParsedFile, reportFile: string): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  visitModuleSpecifiers(file, (node, text) => {
    if (text === RETIRED_LOGGING_PACKAGE || text?.startsWith(RETIRED_LOGGING_PACKAGE + "/")) {
      violations.push({
        file: reportFile,
        line: lineOf(file.source, node),
        rule: "tslog-import",
        detail: `imports the retired logging package "${text}"; the platform pipeline lives in src/log`,
      });
    }
  });
  return violations;
}

/** True when a repository-relative source path may call console. */
export function consoleAllowedFor(path: string, whitelist: readonly ConsoleWhitelistEntry[] = CONSOLE_WHITELIST): boolean {
  return (
    CONSOLE_ALLOWED.some((pattern) => matchesPattern(path, pattern)) ||
    whitelist.some((entry) => matchesPattern(path, entry.path))
  );
}

/**
 * Run both rules over `root`'s `src/**` and `tests/**`. Pure: it reads the tree
 * and returns the report, so the guard's test can point it at a fixture.
 */
export function runLoggingBoundaryCheck(root: string = repositoryRoot()): BoundaryReport {
  const sourceFiles = collectTypeScriptFiles(join(root, "src")).map(parseFile);
  const testFiles = collectTypeScriptFiles(join(root, "tests")).map(parseFile);
  const violations: BoundaryViolation[] = [];

  for (const file of sourceFiles) {
    const reportFile = relativePath(root, file.path);
    violations.push(...tslogViolations(file, reportFile));
    if (!consoleAllowedFor(reportFile)) violations.push(...consoleViolations(file, reportFile));
  }
  for (const file of testFiles) {
    violations.push(...tslogViolations(file, relativePath(root, file.path)));
  }
  violations.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);

  return {
    root,
    scanned: { sourceFiles: sourceFiles.length, testFiles: testFiles.length },
    rules: {
      tslogImports: `no import of "${RETIRED_LOGGING_PACKAGE}" in src/** or tests/**`,
      consoleCalls: "no console call in src/** outside the console sink, src/cli/** and the whitelist",
    },
    consoleAllowed: CONSOLE_ALLOWED,
    consoleWhitelist: CONSOLE_WHITELIST,
    violations,
  };
}

/** The human-readable `path:line  [rule] detail` line for one violation. */
export function violationLine(violation: BoundaryViolation): string {
  return `${violation.file}:${violation.line}  [${violation.rule}] ${violation.detail}`;
}

/** `--root <dir>`; anything else is ignored so the default stays the workspace. */
function rootFromArgs(args: readonly string[]): string | undefined {
  const index = args.indexOf("--root");
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : resolve(value);
}

if (import.meta.main) {
  const report = runLoggingBoundaryCheck(rootFromArgs(process.argv.slice(2)));
  console.log(JSON.stringify(report, null, 2));
  for (const violation of report.violations) console.error(violationLine(violation));
  if (report.violations.length > 0) {
    console.error(
      `logging boundary guard: ${report.violations.length} violation(s) in ${report.scanned.sourceFiles} src file(s) and ${report.scanned.testFiles} test file(s)`,
    );
    process.exitCode = 1;
  }
}
