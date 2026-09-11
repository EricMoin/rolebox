import { bar, SYM_ARROW, SYM_OK, SYM_FAIL } from "./format.ts";
import { formatDuration } from "../utils/display-helpers.ts";

/**
 * Self-contained progress reporting for the role download/install pipeline.
 *
 * Wraps a fetch ReadableStream byte counter (the consumer passes per-chunk
 * `update({ received, total })`) and renders either an animated determinate
 * bar (when `total` is known) or an indeterminate spinner (when it is not).
 *
 * The output sink (`write`) and the clock (`now`) are injected so the module
 * can be unit-tested without a real TTY. Rendering degrades to plain,
 * throttled line-based logging when the destination is not interactive
 * (no TTY, CI, TERM=dumb) or `noProgress` is passed, and ANSI color is
 * suppressed whenever `NO_COLOR` is set.
 *
 * No new dependency — reuses `format.ts` bar/ANSI helpers and
 * `display-helpers.ts` `formatDuration`.
 *
 * @module
 */

// ── Public types ─────────────────────────────────────────────────────

/** Named phases of the download → install pipeline. */
export type Phase =
  | "resolving"
  | "downloading"
  | "verifying"
  | "extracting"
  | "installing"
  | "done";

/** Progress state consumed by {@link DownloadProgress.update}. */
export interface ProgressState {
  /** Bytes read so far. */
  received: number;
  /** Total bytes expected; 0 (or absent) means unknown → indeterminate. */
  total: number;
}

/** Failure payload for {@link DownloadProgress.phaseFail}. */
export interface FailureInfo {
  /** The asset that failed, e.g. `acme/architect@2.0.0`. */
  asset: string;
  /** Human-readable reason for the failure. */
  reason: string;
  /** Current retry attempt (1-based). */
  attempt: number;
  /** Total number of retry attempts. */
  maxAttempts: number;
}

export interface DownloadProgressOptions {
  /** Output sink. Defaults to `process.stdout.write`. */
  write?: (chunk: string) => void;
  /** Clock in ms. Defaults to `Date.now`. */
  now?: () => number;
  /** Whether stdout is a TTY. Defaults to `process.stdout.isTTY`. */
  isTTY?: boolean;
  /** Environment snapshot. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Force plain-line degraded mode even on a TTY. */
  noProgress?: boolean;
  /** Suppress all non-error output. */
  quiet?: boolean;
  /** Emit additional per-phase detail. */
  verbose?: boolean;
}

// ── Constants ────────────────────────────────────────────────────────

/** Spinner frames for indeterminate mode (audit-suggested `│/─\`). */
export const SPINNER_FRAMES = ["│", "/", "─", "\\"] as const;

const BAR_WIDTH = 10;
const PHASE_WIDTH = 12;
const DEGRADED_LOG_INTERVAL_MS = 2000;

// ── Pure formatting helpers (exported for tests) ─────────────────────

/** Format a byte count with binary units, e.g. `1.2MB`, `850KB`, `512B`. */
export function formatBytes(n: number): string {
  const value = Math.max(0, n);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = value;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  if (i === 0) return `${Math.round(v)}B`;
  const str = v >= 100 ? String(Math.round(v)) : v.toFixed(1);
  return `${str}${units[i]}`;
}

/** Format a transfer rate in bytes/second, e.g. `850KB/s`. */
export function formatRate(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return "0B/s";
  return `${formatBytes(bytesPerSec)}/s`;
}

// ── DownloadProgress ─────────────────────────────────────────────────

export class DownloadProgress {
  private readonly write: (chunk: string) => void;
  private readonly now: () => number;
  private readonly isTTY: boolean;
  private readonly env: Record<string, string | undefined>;
  private readonly noProgress: boolean;
  private readonly quiet: boolean;
  private readonly verbose: boolean;

  private readonly degraded: boolean;
  private readonly useColor: boolean;

  private startMs: number;
  private downloadStartMs = -1;
  private lastReceived = 0;
  private lastLogMs = 0;
  private lastMilestone = 0;
  private spinnerIndex = 0;
  private progressActive = false;
  private progressPhase: Phase | null = null;
  private progressDetail = "";

  constructor(opts: DownloadProgressOptions = {}) {
    this.write = opts.write ?? ((chunk) => process.stdout.write(chunk));
    this.now = opts.now ?? Date.now;
    this.isTTY = opts.isTTY ?? process.stdout.isTTY ?? false;
    this.env = opts.env ?? (process.env as Record<string, string | undefined>);
    this.noProgress = opts.noProgress ?? false;
    this.quiet = opts.quiet ?? false;
    this.verbose = opts.verbose ?? false;

    const isCI = Boolean(this.env["CI"]);
    const term = this.env["TERM"];
    const noColor = Boolean(this.env["NO_COLOR"]);
    // Degraded = non-interactive: plain line-based logging, no bars/spinners,
    // no `\r`-overwriting, no ANSI. Covers !isTTY, CI, TERM=dumb, noProgress.
    this.degraded = !this.isTTY || isCI || term === "dumb" || this.noProgress;
    // Color is additionally suppressed by NO_COLOR even in interactive mode.
    this.useColor = !this.degraded && !noColor;
    this.startMs = this.now();
  }

  // ── Phase lifecycle ────────────────────────────────────────────────

  /** Emit the start line for a phase. */
  phaseStart(phase: Phase, detail = ""): void {
    if (this.quiet) return;
    this.endProgressLine();
    this.progressPhase = phase;
    this.progressDetail = detail;
    if (phase === "downloading") this.downloadStartMs = this.now();
    this.writeLine(this.phaseLine(phase, detail));
    this.verboseLine(`${phase}: begin${detail ? ` — ${detail}` : ""}`);
  }

  /** Emit the completion status line for a phase. */
  phaseComplete(phase: Phase, detail = ""): void {
    if (this.quiet) return;
    this.endProgressLine();
    this.progressPhase = null;
    this.progressDetail = "";
    const mark = this.useColor ? SYM_OK : "✓";
    let line = this.phaseLine(phase, detail);
    line += `  ${mark}`;
    if (this.verbose) {
      if (phase === "downloading") {
        line += `  (${formatBytes(this.lastReceived)} received)`;
      } else if (phase === "done") {
        line += `  (${formatDuration(this.now() - this.startMs)})`;
      }
    }
    this.writeLine(line);
  }

  /**
   * Emit failure rendering for a phase: the failed asset, the reason, and
   * (when retrying) the attempt N/M. Always shown, even in quiet mode.
   */
  phaseFail(phase: Phase, failure: FailureInfo): void {
    this.endProgressLine();
    this.progressPhase = null;
    this.progressDetail = "";
    const mark = this.useColor ? SYM_FAIL : "✗";
    const isFinal = failure.attempt >= failure.maxAttempts;
    const attemptInfo = isFinal
      ? `  attempt ${failure.attempt}/${failure.maxAttempts}`
      : "";
    this.writeLine(
      `  ${phase.padEnd(PHASE_WIDTH)}${this.arrow()} ${failure.asset}  ${mark} ${failure.reason}${attemptInfo}`,
    );
    if (!isFinal) {
      this.writeLine(
        `  ${"retrying".padEnd(PHASE_WIDTH)}${this.arrow()} ${failure.asset}  attempt ${failure.attempt}/${failure.maxAttempts}`,
      );
    }
    this.verboseLine(`${phase}: failed — ${failure.reason}`);
  }

  /**
   * Consume a byte-count progress sample. In interactive determinate mode
   * this redraws a single line in place; in indeterminate mode it advances
   * the spinner. In degraded mode it throttles to plain periodic lines.
   */
  update(state: ProgressState): void {
    if (this.quiet) return;
    const received = Math.max(0, state.received);
    const total = state.total > 0 ? state.total : 0;
    if (this.downloadStartMs < 0) this.downloadStartMs = this.now();
    const elapsed = this.now() - this.downloadStartMs;
    this.lastReceived = received;

    if (this.degraded) {
      this.updateDegraded(received, total, elapsed);
      return;
    }
    this.renderInteractive(received, total, elapsed);
  }

  // ── Rendering ──────────────────────────────────────────────────────

  private phaseLine(phase: string, detail: string): string {
    return `  ${phase.padEnd(PHASE_WIDTH)}${this.arrow()} ${detail}`;
  }

  private renderInteractive(received: number, total: number, elapsed: number): void {
    this.progressActive = true;
    const spinner = SPINNER_FRAMES[this.spinnerIndex % SPINNER_FRAMES.length];
    this.spinnerIndex++;

    let body: string;
    if (total > 0) {
      const pct = Math.min(100, Math.floor((received / total) * 100));
      const barStr = bar(received, total, BAR_WIDTH);
      const rate = this.averageRate(received, elapsed);
      const remaining = Math.max(0, total - received);
      const eta = rate > 0 ? Math.max(1, Math.round(remaining / rate)) : 0;
      const etaStr = eta > 0 ? `  eta ${eta}s` : "";
      body =
        `[${barStr}] ${pct}%  ${formatBytes(received)}/${formatBytes(total)}` +
        `  ${formatRate(rate)}${etaStr}`;
    } else {
      body = `${spinner} ${formatBytes(received)}  (${formatDuration(elapsed)})`;
    }

    const prefix = this.progressPhase
      ? `  ${this.progressPhase.padEnd(PHASE_WIDTH)}${this.arrow()} ${this.progressDetail}  `
      : "  ";
    // `\x1b[K` (clear-to-EOL) is only emitted with color so NO_COLOR output
    // carries no ANSI escapes at all; `\r` alone still overwrites the line.
    const lead = this.useColor ? "\r\x1b[K" : "\r";
    this.write(`${lead}${prefix}${body}`);
  }

  private updateDegraded(received: number, total: number, elapsed: number): void {
    const nowMs = this.now();
    const atInterval = nowMs - this.lastLogMs >= DEGRADED_LOG_INTERVAL_MS;
    const milestone = this.crossedMilestone(received, total);
    if (!atInterval && !milestone) return;
    this.lastLogMs = nowMs;
    const size =
      total > 0
        ? `${formatBytes(received)}/${formatBytes(total)}`
        : formatBytes(received);
    const phase = this.progressPhase ?? "downloading";
    const prefix = `  ${phase.padEnd(PHASE_WIDTH)}${this.arrow()} ${this.progressDetail}  `;
    this.writeLine(`${prefix}${size}  (${formatDuration(elapsed)})`);
  }

  private crossedMilestone(received: number, total: number): boolean {
    if (total <= 0) return false;
    const pct = (received / total) * 100;
    const next = Math.floor(pct / 25) * 25; // 0, 25, 50, 75, 100
    if (next >= 25 && next > this.lastMilestone) {
      this.lastMilestone = next;
      return true;
    }
    return false;
  }

  private averageRate(received: number, elapsed: number): number {
    if (elapsed <= 0) return 0;
    return (received / elapsed) * 1000;
  }

  private arrow(): string {
    return this.useColor ? SYM_ARROW : "→";
  }

  private writeLine(s: string): void {
    this.write(`${s}\n`);
  }

  private verboseLine(msg: string): void {
    if (!this.verbose || this.quiet) return;
    this.writeLine(`  · ${msg}`);
  }

  /** Terminate an in-flight `\r`-redrawn progress line with a newline. */
  private endProgressLine(): void {
    if (this.progressActive) {
      this.write("\n");
      this.progressActive = false;
    }
  }
}
