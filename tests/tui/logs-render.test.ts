/// <reference types="bun-types" />

/**
 * The Logs PANE as it is actually painted.
 *
 * `renderLogs` is driven through @opentui/solid's headless test renderer — the
 * same harness `tests/tui/activity-live-status.test.ts` uses — so what the
 * assertions read is a captured frame and not a JSX tree: the level WORD, the
 * source path, the dropped count and the pause banner have to be visible to a
 * reader, and a frame is the only thing that can prove that.
 *
 * The line format itself is pinned against `formatLogLine`, the runtime's own
 * renderer: this pane may shorten a line for the 40-cell sidebar, but it may not
 * invent a second dialect for a record the console already knows how to write.
 *
 * The environment is closed per case (ROLEBOX_LOG* snapshotted, cleared and
 * restored) and the fixtures live under the OS temp directory.
 */

import { describe, it, expect, afterEach, beforeEach, beforeAll } from "bun:test";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/solid";
import type { TestRendererSetup } from "@opentui/core/testing";
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatLogLine } from "../../src/log/sinks/console.ts";
import type { LogRecord } from "../../src/log/types.ts";
import { SIDEBAR_WIDTH } from "../../src/tui/layout.ts";
import { type ThemeColors } from "../../src/tui/helpers.ts";
import type { LogsProps } from "../../src/tui/components/Logs.tsx";

// Same transform the TUI build applies (`scripts/build-tui.ts`). It has to be
// installed BEFORE the component module is loaded, so `./Logs.tsx` is imported
// dynamically below and this file imports only its TYPES at the top.
Bun.plugin(createSolidTransformPlugin({ moduleName: "@opentui/solid" }));

type LogsModule = typeof import("../../src/tui/components/Logs.tsx");

let logs: LogsModule;
let layoutTmp: string;

beforeAll(async () => {
  logs = await import("../../src/tui/components/Logs.tsx");
});

// ── Environment harness ─────────────────────────────────────────────────

let env: Record<string, string | undefined>;

beforeEach(() => {
  env = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("ROLEBOX_LOG")) {
      env[key] = process.env[key];
      delete process.env[key];
    }
  }
  layoutTmp = join(tmpdir(), `rolebox-tui-logs-render-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  process.env.ROLEBOX_LOG_DIR = layoutTmp;
});

afterEach(async () => {
  if (setup) {
    (setup.renderer as unknown as { destroy?: () => void }).destroy?.();
    setup = undefined;
  }
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("ROLEBOX_LOG")) delete process.env[key];
  }
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (value !== undefined) process.env[key] = value;
  }
  rmSync(layoutTmp, { recursive: true, force: true });
});

// ── Fixtures ────────────────────────────────────────────────────────────

/**
 * The palette, as the theme context hands it over: real `RGBA` instances.
 *
 * A plain `{r,g,b}` object is NOT interchangeable here — `@opentui`'s color
 * parser passes a non-string through untouched and then reads a packed buffer
 * off it, and the renderer dies in native code ("Unable to convert … Cell to a
 * pointer") when the object is not an RGBA. Real instances, therefore — and
 * built from 0..1 floats, because `RGBA.fromValues` clamps each channel into
 * that range before packing it (`toU8`), so the 0-255 integers this fixture
 * first used would all have collapsed to 255.
 */
const c: ThemeColors = {
  info:      RGBA.fromValues(80 / 255, 160 / 255, 255 / 255, 1),
  success:   RGBA.fromValues(80 / 255, 200 / 255, 120 / 255, 1),
  warning:   RGBA.fromValues(255 / 255, 200 / 255, 80 / 255, 1),
  error:     RGBA.fromValues(255 / 255, 80 / 255, 80 / 255, 1),
  secondary: RGBA.fromValues(180 / 255, 180 / 255, 200 / 255, 1),
  textMuted: RGBA.fromValues(140 / 255, 140 / 255, 160 / 255, 1),
  text:      RGBA.fromValues(220 / 255, 220 / 255, 230 / 255, 1),
  primary:   RGBA.fromValues(255 / 255, 120 / 255, 200 / 255, 1),
};

function rec(time: number, level: LogRecord["level"], channel: string, message: string, extra: Partial<LogRecord> = {}): LogRecord {
  return { time, level, channel, message, fields: {}, scope: {}, process: { pid: 4242, role: "host" }, ...extra };
}

function props(overrides: Partial<LogsProps> = {}): LogsProps {
  return {
    c,
    wide: true,
    open: true,
    paused: false,
    minLevel: "info",
    channels: [],
    availableChannels: ["alpha", "beta"],
    source: "/tmp/rolebox-logs",
    records: [],
    skippedLines: 0,
    shown: 0,
    total: 0,
    dropped: 0,
    earlierDropped: 0,
    pending: false,
    error: null,
    filterText: "",
    ...overrides,
  };
}

let setup: TestRendererSetup | undefined;

/**
 * Paint one pane and answer its frame.
 *
 * `flat` collapses the frame's lines into one space-separated string, which is
 * how a sentence the terminal WRAPPED is asserted as the sentence it is: the
 * pane is 40 cells wide, so the PAUSED banner reaches the reader on two lines
 * and `toContain` on the raw frame would fail on a correct render.
 */
async function paint(overrides: Partial<LogsProps> = {}): Promise<{ frame: string; flat: string }> {
  setup = await testRender(() => logs.renderLogs(props(overrides)) as never, { width: SIDEBAR_WIDTH, height: 24 });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  const flat = frame.split("\n").map((line) => line.trim()).filter((line) => line.length > 0).join(" ");
  return { frame, flat };
}

// ── Pure line helpers ───────────────────────────────────────────────────

describe("the line format", () => {
  it("is exactly the runtime's own formatLogLine when the line fits", () => {
    const record = rec(1_000, "warn", "graph:host", "sweep blocked", {
      code: "sweep.store-blocked",
      scope: { graphId: "g1", attemptId: "a2" },
      fields: { reason: "busy" },
    });
    expect(logs.renderLogRecordLine(record, 200)).toBe(formatLogLine(record));
    expect(logs.renderLogRecordLine(record, 200)).toContain("[warn] graph:host sweep.store-blocked");
    expect(logs.renderLogRecordLine(record, 200)).toContain("graph=g1 attempt=a2");
    expect(logs.renderLogRecordLine(record, 200)).toContain("reason=\"busy\"");
    expect(logs.renderLogRecordLine(record, 200)).toContain("— sweep blocked");
  });

  it("keeps the level, the channel and the message when a narrow pane forces a choice", () => {
    const record = rec(1_000, "error", "graph:host", "tool result rejected", {
      code: "tool.rejected",
      scope: { graphId: "g1" },
    });

    const line = logs.renderLogRecordLine(record, 36);

    expect(line.length).toBeLessThanOrEqual(36);
    expect(line.startsWith("[error] graph:host")).toBe(true);
    // "…" is the middle cut: both ends of the message survive.
    expect(line).toContain("tool re");
    expect(line).toContain("jected");
  });

  it("drops whole k=v segments rather than cutting a value in half", () => {
    const record = rec(1_000, "warn", "graph:host", "sweep store blocked", {
      code: "sweep.store-blocked",
      scope: { graphId: "graph-log-tuiview", attemptId: "tui-view#1" },
      fields: { reason: "writer busy" },
    });

    const line = logs.renderLogRecordLine(record, 36);

    // The measured defect this rule exists for: a mid-cut once rendered
    // `reason="writer` on one row and `busy"` on the next, which reads as a
    // record whose value is a fragment. No value may be split by the CUT (the
    // continuation rows only ever wrap an already-composed line).
    expect(line.length).toBeLessThanOrEqual(36);
    expect(line).not.toContain('reason="writer ');
    expect(line.startsWith("[warn] graph:host")).toBe(true);
    expect(line).toContain("sweep st");
    expect(line).toContain("locked");
    // The head gave way instead: the code/scope/field segments are dropped
    // whole and marked, and no `k=value` reaches the row as a fragment.
    expect(line).not.toContain("sweep.store-blocked");
    expect(line).not.toContain("attempt=");
    expect(line).not.toContain("reason=");
    expect(line).toContain("\u2026");
  });

  it("cuts the message in the middle only when no head shortening can save it", () => {
    const record = rec(1_000, "info", "dispatch", `head ${"y".repeat(120)} tail-marker`);

    const line = logs.renderLogRecordLine(record, 36);

    expect(line.length).toBeLessThanOrEqual(36);
    expect(line.startsWith("[info] dispatch")).toBe(true);
    expect(line).toContain("\u2026");
    // The middle cut keeps the head of the message and its END, which is where
    // a marker like `tail-marker` sits — the tail is what a right-truncation
    // would have thrown away.
    expect(line).toContain("l-marker");
  });

  it("keeps one row per record even for a message that cannot be shortened", () => {
    const record = rec(1_000, "info", "alpha", "z".repeat(200));

    const line = logs.renderLogRecordLine(record, 36);

    // A single unbreakable token has no spaces to break at, and the composed
    // row is still bounded by the budget: one record is one row.
    expect(line.length).toBeLessThanOrEqual(36);
    expect(line.startsWith("[info] alpha \u2014 ")).toBe(true);
    expect(line).toContain("\u2026");
    expect(line.endsWith("z")).toBe(true);
  });

  it("splits a line at its message, and treats a line with no message as all head", () => {
    const record = rec(1_000, "info", "alpha", "the message");
    expect(logs.splitLogLine(record)).toEqual({ head: "[info] alpha", message: "the message" });
    // A record with no message has no separator to split at: the whole line is
    // the head, and `formatLogLine` already omitted the trailing em dash.
    expect(logs.splitLogLine(rec(1_000, "info", "alpha", ""))).toEqual({ head: "[info] alpha", message: "" });
  });

  it("marks every level with a visible glyph and a palette colour", () => {
    expect(logs.levelGlyph("debug")).toBe("\u00b7");
    expect(logs.levelGlyph("info")).toBe("\u00b7");
    expect(logs.levelGlyph("warn")).toBe("!");
    expect(logs.levelGlyph("error")).toBe("x");
    expect(logs.levelGlyph("fatal")).toBe("!");
    // The colour is the theme's own RGBA value, handed to `fg` untouched.
    expect(logs.levelColor("fatal", c)).toBe(c.error);
    expect(logs.levelColor("error", c)).toBe(c.error);
    expect(logs.levelColor("warn", c)).toBe(c.warning);
    expect(logs.levelColor("info", c)).toBe(c.info);
    expect(logs.levelColor("debug", c)).toBe(c.textMuted);
    expect(c.error.r).toBeCloseTo(1, 5);
    expect(c.error.g).toBeCloseTo(80 / 255, 5);
  });

  it("reserves the ellipsis cell, so a dropped-segment head cannot overflow by one", () => {
    const record = rec(1_000, "warn", "graph:host", "", {
      code: "sweep.store-blocked",
      scope: { graphId: "graph-log-tuiview", attemptId: "tui-view#1" },
      fields: { reason: "writer busy" },
    });

    // The measured defect: `fitHead` appended `…` without reserving its cell, so
    // a composed row was `budget + 1` (37 at the production budget 36) and the
    // pane wrapped ONE record onto TWO rows.
    for (let width = 8; width <= 40; width += 1) {
      expect(logs.renderLogRecordLine(record, width).length).toBeLessThanOrEqual(width);
    }
  });

  it("stays inside the budget when a whole-segment drop lands exactly on it", () => {
    // The head's first two segments fill the production budget exactly, so the
    // ellipsis has no cell of its own: one more segment gives way instead of
    // the pane wrapping the record onto a second row.
    const record = rec(1_000, "info", "c".repeat(29), "", { code: "edge.exact-budget" });

    for (let width = 8; width <= 40; width += 1) {
      const line = logs.renderLogRecordLine(record, width);
      expect(line.length).toBeLessThanOrEqual(width);
      expect(line.startsWith("[info]")).toBe(true);
    }
  });

  it("never composes a row wider than its budget, for any record and any width", () => {
    const records = [
      rec(1_000, "info", "alpha", ""),
      rec(1_000, "warn", "graph:host", "", { code: "sweep.store-blocked", scope: { graphId: "g1", attemptId: "a2" }, fields: { reason: "writer busy" } }),
      rec(1_000, "error", "graph:tool", "tool result rejected", { code: "tool.rejected", scope: { graphId: "g1" }, fields: { exit: 1 } }),
      rec(1_000, "info", "dispatch", `head ${"y".repeat(120)} tail-marker`),
      rec(1_000, "fatal", "graph:index", "z".repeat(200)),
      rec(1_000, "debug", "web", "one k=v field", { fields: { a: 1, b: true, c: ["x", "y"] } }),
    ];

    const over: string[] = [];
    for (let width = 8; width <= 40; width += 1) {
      for (const record of records) {
        const line = logs.renderLogRecordLine(record, width);
        if (line.length > width) over.push(`w=${width} len=${line.length} ${JSON.stringify(line)}`);
      }
    }
    expect(over).toEqual([]);
  });

  it("spends the row on the message before it spends it on one more field", () => {
    const record = rec(1_000, "error", "graph:host", "settle threw", {
      code: "settle.threw",
      scope: { graphId: "graph-log-tuiview" },
      fields: { reason: "writer busy" },
    });

    const line = logs.renderLogRecordLine(record, 36);

    expect(line.length).toBeLessThanOrEqual(36);
    expect(line.startsWith("[error] graph:host")).toBe(true);
    // The shape this rule replaces: `[error] graph:host settle.threw… — …`, a
    // row that names the event and hides what happened. One more `k=v` is not
    // worth a message cut to a bare ellipsis.
    expect(line).not.toContain("\u2014 \u2026");
    expect(line).toContain("settle threw");
  });

  it("spells the filter, the channel set and the counters", () => {
    expect(logs.levelFilterSegment("warn")).toBe(">=(warn)");
    expect(logs.channelSegment([], 2)).toBe("all");
    expect(logs.channelSegment(["alpha"], 2)).toBe("alpha +1");
    expect(logs.channelSegment(["alpha"], 1)).toBe("alpha");
    expect(logs.counterSegment(0, 0)).toBe("");
    expect(logs.counterSegment(2, 0)).toBe("2 skipped");
    expect(logs.counterSegment(0, 3)).toBe("3 dropped");
    expect(logs.counterSegment(2, 3)).toBe("2 skipped \u00b7 3 dropped");
  });
});

// ── The painted pane ────────────────────────────────────────────────────

describe("renderLogs — the painted pane", () => {
  it("shows one line per record with its level word and its channel", async () => {
    const { flat } = await paint({
      records: [
        rec(1_000, "info", "alpha", "first thing"),
        rec(2_000, "warn", "beta", "second thing"),
      ],
      shown: 2,
      total: 2,
    });

    expect(flat).toContain("[info] alpha — first thing");
    expect(flat).toContain("[warn] beta — second thing");
    expect(flat).toContain("! [warn]");   // the level glyph AND the level word
    expect(flat).toContain("Logs");
    expect(flat).toContain("level info");
    expect(flat).toContain("chan all");
  });

  it("paints the source the reader actually used", async () => {
    const { flat } = await paint({ source: "/tmp/rolebox-logs" });
    expect(flat).toContain("src /tmp/rolebox-logs");
  });

  it("paints the skipped and dropped counters", async () => {
    const { flat } = await paint({
      records: [rec(1_000, "info", "alpha", "only one")],
      shown: 1,
      total: 400,
      dropped: 12,
      earlierDropped: 5,
      skippedLines: 3,
      pending: true,
    });

    expect(flat).toContain("1/400 records");
    expect(flat).toContain("12 dropped (5 earlier)");
    expect(flat).toContain("3 skipped");
    expect(flat).toContain("more waiting");
  });

  it("announces a pause in words a monochrome terminal can read", async () => {
    const { flat } = await paint({ paused: true, records: [rec(1_000, "info", "alpha", "held")] });
    expect(flat).toContain(logs.LOGS_PAUSED_BANNER);
    expect(flat).toContain("held");
    expect(flat).toContain("(held)");
  });

  it("says 'no records yet' for an empty healthy view", async () => {
    const { flat } = await paint();
    expect(flat).toContain(logs.LOGS_EMPTY_TEXT);
    expect(flat).not.toContain(logs.LOGS_EMPTY_FILTERED_TEXT);
  });

  it("says the FILTER is what hides the records when a text filter is active", async () => {
    const { flat } = await paint({ filterText: "nothing-matches" });
    expect(flat).toContain(logs.LOGS_EMPTY_FILTERED_TEXT);
  });

  it("names a read failure and still shows the last good records", async () => {
    const { flat } = await paint({
      error: "permission denied",
      records: [rec(1_000, "info", "alpha", "last good")],
      shown: 1,
      total: 1,
    });

    expect(flat).toContain(logs.LOGS_ERROR_LABEL + ": permission denied");
    expect(flat).toContain("last good");
  });

  it("keeps a collapsed pane readable: a status line, not a blank box", async () => {
    const { flat } = await paint({ open: false, records: [rec(1_000, "info", "alpha", "not painted")] });
    expect(flat).toContain("Logs");
    expect(flat).toContain(logs.LOGS_HIDDEN_TEXT);
    expect(flat).toContain("ctrl+l");
    expect(flat).not.toContain("not painted");
  });

  it("names the key the keymap layer actually registers, in every sentence that names one", async () => {
    const mod = await import("../../src/tui/index.tsx");
    // The table is `key → command`; the copy names the COMMAND, so the lookup
    // inverts it.
    const registered = new Map(mod.LOGS_KEY_BINDINGS.map(([key, command]) => [command, key] as const));
    const pauseKey = registered.get("rolebox.logs.pause") ?? "";
    const toggleKey = registered.get("rolebox.logs.toggle") ?? "";
    const looserKey = registered.get("rolebox.logs.level-looser") ?? "";

    // The instruction and the binding are ONE fact. A pane that says `Space`
    // above a `ctrl+p` binding sends the reader to a key that does nothing.
    expect(pauseKey).toBe("ctrl+p");
    expect(toggleKey).toBe("ctrl+l");
    expect(logs.LOGS_PAUSED_BANNER).toContain(pauseKey);
    expect(logs.LOGS_HIDDEN_TEXT).toContain(toggleKey);
    expect(logs.LOGS_EMPTY_FILTERED_TEXT).toContain(looserKey);

    const { flat } = await paint({ paused: true });
    expect(flat).toContain(logs.LOGS_PAUSED_BANNER);
  });

  it("keeps the tail of a deep source path, which is the part that distinguishes it", async () => {
    const { flat } = await paint({ source: "/Users/somebody/very/deep/workspace/path/.rolebox/logs" });
    expect(flat).toContain(".rolebox/logs");
    expect(flat).toContain("src ");
  });

  it("reports the channel filter with the count of what it hides", async () => {
    const { flat } = await paint({ channels: ["alpha"], availableChannels: ["alpha", "beta"] });
    expect(flat).toContain("chan alpha +1");
  });

  it("truncates an over-long record to the pane width, on one row", async () => {
    const { frame, flat } = await paint({
      records: [rec(1_000, "error", "graph:host", `prefix ${"z".repeat(160)} tail-marker`)],
      shown: 1,
      total: 1,
    });

    expect(flat).toContain("[error] graph:host");
    // The recorded line is longer than the 40-cell pane, so the message is cut
    // in the middle: the row fits the pane and needs no continuation, and the
    // surviving tail is the END of the message — the part right-truncation
    // would have discarded.
    const recordRow = frame.split("\n").find((line) => line.includes("[error] graph:host")) ?? "";
    expect(recordRow.length).toBeLessThanOrEqual(SIDEBAR_WIDTH);
    expect(recordRow).toContain("\u2026");
    expect(recordRow.endsWith("marker")).toBe(true);
  });
});

// ── The keymap layer the plugin registers ───────────────────────────────

describe("registerLogsKeymap", () => {
  it("claims only the documented keys, and every one of them twice: key + command", async () => {
    const mod = await import("../../src/tui/index.tsx");

    expect(mod.LOGS_KEY_BINDINGS.map(([key]) => key)).toEqual([
      "ctrl+l", "ctrl+p", "ctrl+up", "ctrl+down", "ctrl+n", "ctrl+g",
    ]);
    // Every claimed key is ctrl-modified: the bare keys a reader expects the
    // HOST to own (`?`, `r`, `m`, `f`, the arrows) are left untouched.
    for (const [key] of mod.LOGS_KEY_BINDINGS) expect(key.startsWith("ctrl+")).toBe(true);
    // Each binding names a command the plugin also registers — a binding whose
    // command has no handler is a dead key.
    for (const [, command] of mod.LOGS_KEY_BINDINGS) {
      expect(mod.LOGS_COMMANDS).toContain(command);
    }
    expect(new Set(mod.LOGS_COMMANDS).size).toBe(mod.LOGS_COMMANDS.length);
  });

  it("registers one disposable layer and disposes it on demand", async () => {
    const mod = await import("../../src/tui/index.tsx");
    let disposed = 0;
    const seen: Array<{ bindings?: unknown[]; commands?: unknown[] }> = [];
    const keymap = {
      registerLayer(layer: { bindings?: unknown[]; commands?: unknown[] }) {
        seen.push(layer);
        return () => { disposed += 1; };
      },
    };

    const dispose = mod.registerLogsKeymap(keymap as never);

    expect(seen).toHaveLength(1);
    // The layer carries EXACTLY the Logs keys and their commands: no bare host
    // key is claimed by this plugin, which registered no layer before.
    expect(seen[0]?.bindings).toHaveLength(mod.LOGS_KEY_BINDINGS.length);
    expect(seen[0]?.commands).toHaveLength(mod.LOGS_COMMANDS.length);
    dispose();
    expect(disposed).toBe(1);
  });

  it("refreshes the panel when Follow runs", async () => {
    const mod = await import("../../src/tui/index.tsx");
    let refreshed = 0;
    let layer: { commands?: Array<{ name: string; run: () => void }> } | undefined;
    const keymap = { registerLayer: (l: typeof layer) => { layer = l; return () => {}; } };

    mod.registerLogsKeymap(keymap as never, () => { refreshed += 1; });
    const follow = layer?.commands?.find((command) => command.name === "rolebox.logs.follow");

    expect(follow).toBeDefined();
    follow?.run();
    expect(refreshed).toBe(1);
  });
});
