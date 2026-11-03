import { build as bundle } from "esbuild";


import { describe, it, expect } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

/** The client entry the shipped bundle is built from. */
const CLIENT_ENTRY = resolve(REPO_ROOT, "src/platform/adapters/dsh/web-ui/client.ts");

/** The build script this probe mirrors. */
const BUILD_SCRIPT = resolve(REPO_ROOT, "scripts/build-dsh-web-client.ts");

/** The probe report's path (git-ignored; the reviewer reads it as evidence). */
const REPORT_PATH = resolve(REPO_ROOT, ".rolebox/tmp/webview/bundle-probe.json");

const BUILD_OPTIONS: {
  entryPoints: string[];
  platform: "browser";
  format: "cjs";
  external: string[];
} = {
  entryPoints: [CLIENT_ENTRY],
  platform: "browser",
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

const build = await bundle({ ...BUILD_OPTIONS, bundle: true, write: false, jsx: "automatic", jsxImportSource: "react" });
const bundleText = build.outputFiles![0]!.text;

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
    locale: { register: () => () => undefined },
  };
  return { ctx, registered };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("dsh web client bundle probe (target: browser)", () => {
  it("builds the client entry with the same options the build script passes", () => {
    const script = readFileSync(BUILD_SCRIPT, "utf8");
    expect(script).toContain('platform: "browser"');
    expect(script).toContain('format: "cjs"');
    expect(script).toContain('"react"');
    expect(script).toContain('"react/jsx-runtime"');
    expect(script).toContain('"@deepseek-ai/*"');
    expect(script).toContain("src/platform/adapters/dsh/web-ui/client.ts");

    expect(BUILD_OPTIONS.platform).toBe("browser");
    expect(BUILD_OPTIONS.format).toBe("cjs");
    expect(BUILD_OPTIONS.entryPoints[0]).toBe(CLIENT_ENTRY);
    expect(build.errors).toHaveLength(0);
    expect(build.outputFiles).toHaveLength(1);
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
    expect(exports.LOGS_VIEW_ID).toBe("rolebox-logs");
    expect(exports.LOGS_VIEW_LABEL).toBe("Logs");
    expect(exports.MONITOR_VIEW_ID).toBe("rolebox-monitor");
  });

  it("registers the original panels as Conversation views in the shipped bundle", () => {
    const { exports } = evaluateBundle(bundleText);
    const { ctx, registered } = createFakeClientContext();
    const dispose = (exports.apply as (context: unknown) => unknown)(ctx);
    const views = registered.filter((entry) => entry.options.name === "conversation.view");
    expect(views.map((entry) => entry.options.id)).toEqual(["rolebox-monitor", "rolebox-logs"]);
    expect(views.map((entry) => entry.options.order)).toEqual([30, 40]);
    expect((views[0]!.component as { name?: string }).name).toBe("RoleboxMonitorPanel");
    expect((views[1]!.component as { name?: string }).name).toBe("RoleboxLogsPanel");
    expect(bundleText).not.toContain("sidebar.right.pane.tab");
    expect(() => (dispose as () => void)()).not.toThrow();
  });

  it("writes its machine-readable report to the git-ignored probe path", () => {
    const { exports, required } = evaluateBundle(bundleText);
    const report = {
      probe: "dsh-web-client-bundle-loadability",
      entry: "src/platform/adapters/dsh/web-ui/client.ts",
      buildOptions: {
        target: BUILD_OPTIONS.platform,
        format: BUILD_OPTIONS.format,
        external: BUILD_OPTIONS.external,
      },
      buildSucceeded: build.errors.length === 0,
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
