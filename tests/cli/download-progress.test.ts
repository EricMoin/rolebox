import { describe, it, expect } from "bun:test";
import {
  DownloadProgress,
  SPINNER_FRAMES,
  formatBytes,
  formatRate,
  type FailureInfo,
} from "../../src/cli/download-progress";

// ── Helpers ─────────────────────────────────────────────────

/** Collect writes into an array; clock is a mutable variable. */
function makeHarness(isTTY: boolean, env: Record<string, string | undefined> = {}) {
  const chunks: string[] = [];
  let t = 0;
  const progress = new DownloadProgress({
    write: (s: string) => chunks.push(s),
    now: () => t,
    isTTY,
    env,
  });
  return { chunks, progress, advance: (ms: number) => (t += ms), time: () => t };
}

function failure(over: Partial<FailureInfo> = {}): FailureInfo {
  return {
    asset: "acme/architect@2.0.0",
    reason: "network error downloading role \"architect\": boom",
    attempt: 1,
    maxAttempts: 3,
    ...over,
  };
}

// ── formatBytes / formatRate ─────────────────────────────────

describe("formatBytes", () => {
  it("formats bytes, KB, MB", () => {
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(1024)).toBe("1.0KB");
    expect(formatBytes(870400)).toBe("850KB");
    expect(formatBytes(1228800)).toBe("1.2MB");
  });
});

describe("formatRate", () => {
  it("formats a rate", () => {
    expect(formatRate(870400)).toBe("850KB/s");
    expect(formatRate(0)).toBe("0B/s");
  });
});

// ── Determinate rendering ────────────────────────────────────

describe("determinate rendering", () => {
  it("renders bar, percent, bytes, rate and eta on a single redrawn line", () => {
    const { chunks, progress, advance } = makeHarness(true);
    progress.phaseStart("downloading", "acme/architect@2.0.0");
    advance(1000);
    // 870400 bytes = 850KB; total chosen so 45% and a clean MB total.
    progress.update({ received: 870400, total: 1934222 });

    const redraw = chunks[chunks.length - 1];
    expect(redraw.startsWith("\r\x1b[K")).toBe(true);
    expect(redraw).toContain("[");
    expect(redraw).toContain("]");
    expect(redraw).toContain("45%");
    expect(redraw).toContain("850KB/");
    expect(redraw).toContain("/s");
    expect(redraw).toContain("eta ");
    // rate = 870400/1000*1000 = 870400 bytes/s → 850KB/s
    expect(redraw).toContain("850KB/s");
    // No trailing newline: it is a redraw, not a finished line.
    expect(redraw.endsWith("\n")).toBe(false);
  });

  it("closes the redrawn line before the next phase line", () => {
    const { chunks, progress, advance } = makeHarness(true);
    progress.phaseStart("downloading", "acme/architect@2.0.0");
    advance(500);
    progress.update({ received: 512, total: 1024 });
    progress.phaseComplete("downloading", "acme/architect@2.0.0");

    const last = chunks[chunks.length - 1];
    expect(last.endsWith("\n")).toBe(true);
    expect(last).toContain("✓");
  });
});

// ── Indeterminate rendering ──────────────────────────────────

describe("indeterminate rendering", () => {
  it("renders a spinner frame, byte counter and elapsed time", () => {
    const { chunks, progress, advance } = makeHarness(true);
    progress.phaseStart("downloading", "acme/architect@2.0.0");
    advance(2000);
    progress.update({ received: 524288, total: 0 }); // no Content-Length

    const redraw = chunks[chunks.length - 1];
    expect(redraw.startsWith("\r\x1b[K")).toBe(true);
    expect(redraw).toContain("512KB");
    expect(redraw).toContain("2s"); // formatDuration(2000)
    const hasFrame = SPINNER_FRAMES.some((f) => redraw.includes(f));
    expect(hasFrame).toBe(true);
  });

  it("advances the spinner frame across updates", () => {
    const { chunks, progress } = makeHarness(true);
    progress.phaseStart("downloading", "acme/architect@2.0.0");
    progress.update({ received: 10, total: 0 });
    progress.update({ received: 20, total: 0 });

    const first = chunks[chunks.length - 2];
    const second = chunks[chunks.length - 1];
    const frameOf = (c: string) =>
      SPINNER_FRAMES.findIndex((f) => c.includes(f));
    expect(frameOf(first)).not.toBe(-1);
    expect(frameOf(second)).not.toBe(-1);
    expect(frameOf(second)).toBe((frameOf(first) + 1) % SPINNER_FRAMES.length);
  });
});

// ── Degraded / non-TTY plain-line mode ───────────────────────

describe("degraded non-TTY mode", () => {
  it("emits plain line-based output with no ANSI, no carriage return", () => {
    const { chunks, progress, advance } = makeHarness(false);
    progress.phaseStart("downloading", "acme/architect@2.0.0");
    advance(100);
    progress.update({ received: 870400, total: 1934222 }); // throttled: <2s
    advance(2100);
    progress.update({ received: 1740800, total: 1934222 }); // interval hit

    const joined = chunks.join("");
    expect(joined).not.toContain("\x1b");
    expect(joined).not.toContain("\r");
    expect(joined).toContain("→");
    expect(joined).toContain("850KB"); // first update ignored (throttled)
    expect(joined).toContain("1.7MB/");
  });

  it("logs at most every 2s and on milestones", () => {
    const { chunks, progress, advance } = makeHarness(false);
    progress.phaseStart("downloading", "acme/architect@2.0.0");
    progress.update({ received: 1024, total: 10000 }); // t=0 → logged (interval)
    advance(500);
    progress.update({ received: 2048, total: 10000 }); // <2s, no milestone → skipped
    const before = chunks.length;
    advance(500);
    progress.update({ received: 2500, total: 10000 }); // 25% milestone → logged
    expect(chunks.length).toBeGreaterThan(before);
  });
});

// ── ANSI suppression: NO_COLOR and TERM=dumb ─────────────────

describe("NO_COLOR / TERM=dumb ANSI suppression", () => {
  it("suppresses ANSI color on a TTY when NO_COLOR is set, but still redraws", () => {
    const { chunks, progress } = makeHarness(true, { NO_COLOR: "1" });
    progress.phaseStart("downloading", "acme/architect@2.0.0");
    progress.update({ received: 512, total: 1024 });
    const joined = chunks.join("");
    expect(joined).not.toContain("\x1b");
    // Interactive redraw still overwrites with a bare carriage return.
    expect(chunks[chunks.length - 1].startsWith("\r")).toBe(true);
    // Plain glyphs, not colored ones.
    expect(joined).toContain("→");
  });

  it("degrades to plain lines when TERM=dumb even on a TTY", () => {
    const { chunks, progress, advance } = makeHarness(true, { TERM: "dumb" });
    progress.phaseStart("downloading", "acme/architect@2.0.0");
    advance(2100);
    progress.update({ received: 1024, total: 2048 });
    const joined = chunks.join("");
    expect(joined).not.toContain("\x1b");
    expect(joined).not.toContain("\r");
    expect(joined).toContain("→");
  });
});

// ── Quiet mode ───────────────────────────────────────────────

describe("quiet mode", () => {
  it("suppresses non-error output but still reports failures", () => {
    const { chunks, progress } = makeHarness(true, {}, /* noProgress */);
    const quiet = new DownloadProgress({
      write: (s: string) => chunks.push(s),
      now: () => 0,
      isTTY: true,
      quiet: true,
    });

    quiet.phaseStart("downloading", "acme/architect@2.0.0");
    quiet.update({ received: 512, total: 1024 });
    quiet.phaseComplete("downloading", "acme/architect@2.0.0");
    expect(chunks.length).toBe(0);

    quiet.phaseFail("downloading", failure());
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join("")).toContain("boom");
  });
});

// ── Verbose mode ─────────────────────────────────────────────

describe("verbose mode", () => {
  it("adds per-phase detail lines", () => {
    const chunks: string[] = [];
    const progress = new DownloadProgress({
      write: (s: string) => chunks.push(s),
      now: () => 0,
      isTTY: true,
      verbose: true,
    });
    progress.phaseStart("resolving", "acme/architect@2.0.0");
    expect(chunks.join("")).toContain("resolving: begin");
  });
});

// ── Failure rendering with attempt counts ────────────────────

describe("failure rendering", () => {
  it("renders failed asset, reason, and a retrying attempt line", () => {
    const { chunks, progress } = makeHarness(true);
    progress.phaseFail("downloading", failure({ attempt: 1 }));

    const joined = chunks.join("");
    expect(joined).toContain("acme/architect@2.0.0");
    expect(joined).toContain("network error downloading role \"architect\": boom");
    expect(joined).toContain("✗");
    expect(joined).toContain("retrying");
    expect(joined).toContain("attempt 1/3");
  });

  it("renders the final attempt with attempt N/M on the error line", () => {
    const { chunks, progress } = makeHarness(true);
    progress.phaseFail("downloading", failure({ attempt: 3 }));

    const joined = chunks.join("");
    expect(joined).toContain("attempt 3/3");
    expect(joined).not.toContain("retrying");
  });
});
