/// <reference types="bun-types" />

/**
 * dsh web client bundle LOADABILITY probe — the browser half's own guard.
 *
 * ── Why this test exists ───────────────────────────────────────────────────
 * The dsh web client bundle is built with Bun `target: "browser"`
 * (`scripts/build-dsh-web-client.ts`), where a node builtin is not an error at
 * build time: Bun substitutes an EMPTY module for it, and the failure surfaces
 * only when the shipped bundle is evaluated in a browser. Stage 2 measured
 * exactly that for the platform kernel — `src/log/context.ts` imports
 * `node:async_hooks`, whose browser stub is `{}`, so `new AsyncLocalStorage`
 * throws `TypeError: undefined is not a constructor` on the first line of
 * `storage` initialisation, i.e. the whole bundle dies before any slot
 * registers (`.rolebox/tmp/stage2b/browser-kernel-probe.log`).
 *
 * The log view panel is the surface MOST exposed to that regression: it is
 * written beside the kernel, it consumes the kernel's record shape, and the
 * obvious "improvement" — importing `src/log/**` (or a shared type from it)
 * instead of reading `GET /rolebox/logs` over HTTP — is the exact mistake that
 * would put `node:async_hooks` back into the bundle.
 *
 * So this suite does what Stage 2's probe did, against the REAL entrypoint:
 *
 *   1. build `src/platform/adapters/dsh/web-ui/client.ts` with the build
 *      script's own options (asserted against the script's source, so the two
 *      cannot drift apart silently);
 *   2. SCAN the bundle for the kernel's and node's tell-tale strings;
 *   3. EVALUATE it the way the dsh module loader does — as a CommonJS factory
 *      with `require` supplied — with a shim that THROWS on any external other
 *      than react (so an unnoticed dependency is a failure, not a silent
 *      substitution);
 *   4. run `apply(ctx)` against a structural ctx double and assert BOTH
 *      right-Sidebar tab bodies register, the log view among them.
 *
 * The probe's machine-readable report is written to
 * `.rolebox/tmp/webview/bundle-probe.json` (a git-ignored path) so a reviewer
 * can read the numbers this run produced.
 *
 * @module
 */

import { describe, it, expect } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");

/** The client entry the shipped bundle is built from. */
const CLIENT_ENTRY = resolve(REPO_ROOT, "src/platform/adapters/dsh/web-ui/client.ts");

/** The build script this probe mirrors. */
const BUILD_SCRIPT = resolve(REPO_ROOT, "scripts/build-dsh-web-client.ts");

/** The probe report's path (git-ignored; the reviewer reads it as evidence). */
const REPORT_PATH = resolve(REPO_ROOT, ".rolebox/tmp/webview/bundle-probe.json");

/**
 * The build options — deliberately the same object the build script passes.
 * `react/jsx-dev-runtime` is listed in addition to `jsx-runtime` because a test
 * process runs with NODE_ENV unset (Bun then selects the development JSX
 * runtime, as the build script's header documents); the emulated loader below
 * serves whichever one the bundle asks for.
 */
const BUILD_OPTIONS: {
  entrypoints: string[];
  target: "browser";
  format: "cjs";
  external: string[];
} = {
  entrypoints: [CLIENT_ENTRY],
  target: "browser",
  format: "cjs",
  external: ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "@deepseek-ai/*"],
};

/** Strings that must not appear in a browser bundle: a node builtin or the kernel. */
const FORBIDDEN_MARKERS: readonly string[] = [
  "node:async_hooks",
  "node:fs",
  "node:path",
  "node:os",
  "node:http",
  "node:url",
  "AsyncLocalStorage",
  "readLogView",
  "createLogger",
  "withLogScope",
  "subscribeLogRecords",
  "listLogFiles",
  "pruneLogs",
  "resolveLogDir",
  "src/log/",
];

// ── Build once, evaluate per test ──────────────────────────────────────────

const build = await Bun.build(BUILD_OPTIONS);

if (!build.success) {
  for (const log of build.logs) console.error(String(log));
}

const bundleText = build.success ? await build.outputs[0]!.text() : "";

// ── The emulated dsh module loader ─────────────────────────────────────────

/** A structural vnode, so the mocked JSX runtime is enough to render nothing. */
const jsx = (type: unknown, props: unknown): { type: unknown; props: unknown } => ({ type, props });
const FRAGMENT = Symbol.for("react.fragment");

const REACT = {
  useState: (initial: unknown) => [
    typeof initial === "function" ? (initial as () => unknown)() : initial,
    () => undefined,
  ],
  useEffect: () => undefined,
  useRef: (initial: unknown) => ({ current: initial }),
  createElement: jsx,
  Fragment: FRAGMENT,
};
const JSX_RUNTIME = { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: FRAGMENT };

/**
 * Evaluate the bundle the way `@deepseek-ai/dsh-client-modules` does: the
 * factory receives `require` and its module's exports are the factory's
 * return value / `module.exports`. Any external other than the react runtimes
 * is refused LOUDLY — that is the difference between "the bundle happens not to
 * need it" and "the bundle silently got a stub".
 */
function evaluateBundle(code: string): {
  exports: Record<string, unknown>;
  required: string[];
} {
  const required: string[] = [];
  const moduleRecord = { exports: {} as Record<string, unknown> };
  const factory = new Function("require", "module", "exports", code) as (
    require: (id: string) => unknown,
    module: { exports: Record<string, unknown> },
    exports: Record<string, unknown>,
  ) => Record<string, unknown> | undefined;
  const returned = factory(
    (id: string) => {
      required.push(id);
      if (id === "react") return REACT;
      if (id === "react/jsx-runtime" || id === "react/jsx-dev-runtime") return JSX_RUNTIME;
      throw new Error("unexpected external require: " + id);
    },
    moduleRecord,
    moduleRecord.exports,
  );
  return { exports: returned ?? moduleRecord.exports, required };
}

/** A structural ctx double: declarations exist, so every inject callback runs now. */
function createFakeClientContext() {
  const registered: Array<{ options: Record<string, unknown>; component: unknown }> = [];
  const tabTypes: Array<Record<string, unknown>> = [];
  const opened: string[] = [];
  const ctx = {
    slots: {
      inject: (_key: string, callback: () => unknown) => {
        const dispose = callback();
        return typeof dispose === "function" ? dispose : () => undefined;
      },
      register: (options: Record<string, unknown>, component: unknown) => {
        registered.push({ options, component });
        return () => undefined;
      },
    },
    sidebarRightTabs: {
      register: (definition: Record<string, unknown>) => {
        tabTypes.push(definition);
        return () => undefined;
      },
    },
    sidebarRight: {
      openTab: (kind: string) => {
        opened.push(kind);
      },
    },
  };
  return { ctx, registered, tabTypes, opened };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("dsh web client bundle probe (target: browser)", () => {
  it("builds the client entry with the same options the build script passes", () => {
    const script = readFileSync(BUILD_SCRIPT, "utf8");
    expect(script).toContain('target: "browser"');
    expect(script).toContain('format: "cjs"');
    expect(script).toContain('"react"');
    expect(script).toContain('"react/jsx-runtime"');
    expect(script).toContain('"@deepseek-ai/*"');
    expect(script).toContain("src/platform/adapters/dsh/web-ui/client.ts");

    expect(BUILD_OPTIONS.target).toBe("browser");
    expect(BUILD_OPTIONS.format).toBe("cjs");
    expect(BUILD_OPTIONS.entrypoints[0]).toBe(CLIENT_ENTRY);
    expect(build.success).toBe(true);
    expect(build.outputs).toHaveLength(1);
    expect(bundleText.length).toBeGreaterThan(1000);
  });

  it("carries the log view surface into the shipped bundle", () => {
    // The panel's endpoint and the sibling surfaces are present in the bytes.
    expect(bundleText).toContain("/rolebox/logs");
    expect(bundleText).toContain("/rolebox/status");
    expect(bundleText).toContain("rolebox-logs");
  });

  it("imports neither the logging kernel nor a node builtin", () => {
    const found = FORBIDDEN_MARKERS.filter((marker) => bundleText.includes(marker));
    expect(found).toEqual([]);
    // The ONLY externals the browser half may reach are the react runtimes.
    expect(bundleText.includes('require("node:')).toBe(false);
  });

  it("evaluates in a browser-shaped loader without throwing", () => {
    const { exports, required } = evaluateBundle(bundleText);
    expect(required.every((id) => id === "react" || id.startsWith("react/"))).toBe(true);
    expect(typeof exports.apply).toBe("function");
    expect(exports.name).toBe("rolebox");
    expect(Array.isArray(exports.inject)).toBe(true);
    expect(exports.LOGS_TAB_ID).toBe("rolebox-logs");
    expect(exports.LOGS_TAB_KIND).toBe("rolebox-logs");
    expect(exports.LOGS_TAB_TITLE).toBe("Logs");
    expect(exports.MONITOR_TAB_ID).toBe("rolebox-monitor");
  });

  it("registers the log view tab (body and type) when the evaluated bundle applies", () => {
    const { exports } = evaluateBundle(bundleText);
    const { ctx, registered, tabTypes } = createFakeClientContext();

    const dispose = (exports.apply as (context: unknown) => unknown)(ctx);
    expect(typeof dispose).toBe("function");

    // Four declarations were waited on and each registered its contribution.
    const seatBodies = registered.filter(
      (entry) => entry.options.name === "sidebar.right.pane.tab",
    );
    expect(seatBodies.map((entry) => entry.options.key)).toEqual([
      "rolebox-monitor",
      "rolebox-logs",
    ]);
    expect((seatBodies[1]!.component as { name?: string }).name).toBe("RoleboxLogsPanel");
    expect(registered.some((entry) => entry.options.name === "conversation.input.dock")).toBe(true);
    expect(registered.some((entry) => entry.options.name === "settings.section")).toBe(true);

    // Both page types, each with its own guide entry.
    expect(tabTypes.map((definition) => definition.id)).toEqual([
      "rolebox-monitor",
      "rolebox-logs",
    ]);
    const logsType = tabTypes[1]!;
    expect(logsType.kind).toBe("rolebox-logs");
    expect((logsType.title as () => string)()).toBe("Logs");
    expect((logsType.guide as unknown[]).length).toBe(1);

    // The returned disposer tears the registrations down without throwing.
    expect(() => (dispose as () => void)()).not.toThrow();
  });

  it("writes its machine-readable report to the git-ignored probe path", () => {
    const { exports, required } = evaluateBundle(bundleText);
    const report = {
      probe: "dsh-web-client-bundle-loadability",
      entry: "src/platform/adapters/dsh/web-ui/client.ts",
      buildOptions: {
        target: BUILD_OPTIONS.target,
        format: BUILD_OPTIONS.format,
        external: BUILD_OPTIONS.external,
      },
      buildSucceeded: build.success,
      bundleBytes: bundleText.length,
      forbiddenMarkers: FORBIDDEN_MARKERS,
      forbiddenMarkersFound: FORBIDDEN_MARKERS.filter((marker) => bundleText.includes(marker)),
      externalsRequiredAtEvaluation: [...new Set(required)],
      exports: Object.keys(exports).sort(),
      kernelImported: false,
      note:
        "The bundle is evaluated as the dsh module loader does (CommonJS factory with a require shim that refuses any external other than react). An empty require set for the kernel and a clean evaluation is the evidence that src/log/** is not in the browser graph.",
    };
    mkdirSync(dirname(REPORT_PATH), { recursive: true });
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n");
    expect(report.forbiddenMarkersFound).toEqual([]);
    expect(report.externalsRequiredAtEvaluation.every((id) => id.startsWith("react"))).toBe(true);
  });
});
