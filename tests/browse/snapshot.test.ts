/**
 * Snapshot formatting helpers and payload validation.
 *
 * The walker itself needs a real page (the gated live suite covers it), but its
 * contract is small enough to pin here: how whitespace collapses, how the caps
 * clamp, what the truncation marker looks like, how refs are recovered from the
 * rendered text, and how the options cross into the page as plain JSON.
 */

import { describe, expect, it } from "vitest";
import {
  browseSnapshotWalker,
  clampSnapshotMaxChars,
  collapseSnapshotWhitespace,
  formatSnapshotRef,
  formatTruncationMarker,
  isSnapshotPayload,
  parseSnapshotRefs,
  serializeSnapshotOptions,
  snapshotResultFromPayload,
  type SnapshotPayload,
  truncateSnapshotLabel,
  SNAPSHOT_DEFAULT_MAX_CHARS,
  SNAPSHOT_MAX_CHARS,
  SNAPSHOT_NAME_MAX_CHARS,
} from "../../src/browse/snapshot.ts";

describe("clampSnapshotMaxChars", () => {
  it("defaults when no number is given", () => {
    expect(clampSnapshotMaxChars()).toBe(SNAPSHOT_DEFAULT_MAX_CHARS);
    expect(clampSnapshotMaxChars(null)).toBe(SNAPSHOT_DEFAULT_MAX_CHARS);
    expect(clampSnapshotMaxChars(Number.NaN)).toBe(SNAPSHOT_DEFAULT_MAX_CHARS);
  });

  it("clamps into [1, SNAPSHOT_MAX_CHARS] and truncates fractions", () => {
    expect(clampSnapshotMaxChars(0)).toBe(1);
    expect(clampSnapshotMaxChars(-20)).toBe(1);
    expect(clampSnapshotMaxChars(1234.9)).toBe(1234);
    expect(clampSnapshotMaxChars(SNAPSHOT_MAX_CHARS + 1)).toBe(SNAPSHOT_MAX_CHARS);
    expect(clampSnapshotMaxChars(Number.POSITIVE_INFINITY)).toBe(SNAPSHOT_DEFAULT_MAX_CHARS);
  });
});

describe("formatting helpers", () => {
  it("collapses whitespace runs and trims", () => {
    expect(collapseSnapshotWhitespace("  a\n\t b   c  ")).toBe("a b c");
    expect(collapseSnapshotWhitespace("\n\n")).toBe("");
  });

  it("clips a label to the name cap with one ellipsis", () => {
    expect(truncateSnapshotLabel("Save")).toBe("Save");
    const long = "x".repeat(SNAPSHOT_NAME_MAX_CHARS + 20);
    const clipped = truncateSnapshotLabel(long);
    expect(clipped).toHaveLength(SNAPSHOT_NAME_MAX_CHARS);
    expect(clipped.endsWith("…")).toBe(true);
    expect(truncateSnapshotLabel(long, 10)).toHaveLength(10);
  });

  it("renders the exact truncation marker", () => {
    expect(formatTruncationMarker(12)).toBe("[... truncated: 12 more nodes]");
    expect(formatTruncationMarker(-3)).toBe("[... truncated: 0 more nodes]");
  });

  it("serializes options as JSON-safe values with the cap applied", () => {
    expect(serializeSnapshotOptions()).toEqual({ selector: null, maxChars: SNAPSHOT_DEFAULT_MAX_CHARS, full: false });
    expect(serializeSnapshotOptions({ selector: "  ", maxChars: 500, full: true }))
      .toEqual({ selector: null, maxChars: 500, full: true });
    expect(serializeSnapshotOptions({ selector: "#main", maxChars: SNAPSHOT_MAX_CHARS * 4 }).maxChars)
      .toBe(SNAPSHOT_MAX_CHARS);
  });
});

describe("parseSnapshotRefs", () => {
  const snapshotText = [
    '- heading "Welcome" [level=1]',
    '- button "Save changes" [ref=e1]',
    '  - text "not a ref"',
    '- textbox "Email" [ref=e2] [placeholder="you@example.com"]',
    '- link "Docs" [href="/docs"]',
    '- button "Say \\"hi\\"" [ref=e3] [disabled]',
    '[... truncated: 4 more nodes]',
  ].join("\n");

  it("recovers only lines that carry a ref", () => {
    const refs = parseSnapshotRefs(snapshotText);
    expect(refs).toEqual([
      { ref: "e1", role: "button", name: "Save changes" },
      { ref: "e2", role: "textbox", name: "Email" },
      { ref: "e3", role: "button", name: 'Say "hi"' },
    ]);
  });

  it("keeps brackets and quotes inside a name intact", () => {
    const refs = parseSnapshotRefs('- button "Save [now]" [ref=e9]');
    expect(refs).toEqual([{ ref: "e9", role: "button", name: "Save [now]" }]);
  });

  it("ignores text leaves and non-snapshot lines", () => {
    expect(parseSnapshotRefs('text "hello"\nplain prose\n- option "A"')).toEqual([]);
  });

  it("formats a ref back for hints", () => {
    expect(formatSnapshotRef({ ref: "e1", role: "button", name: "Save" })).toBe('ref e1 (button "Save")');
  });
});

describe("snapshot payload", () => {
  const payload: SnapshotPayload = {
    text: '- button "Save" [ref=e1]',
    nodeCount: 1,
    refCount: 1,
    truncated: false,
    truncatedNodes: 0,
    refs: [{ ref: "e1", role: "button", name: "Save" }],
    matched: true,
  };

  it("recognizes a well-formed payload", () => {
    expect(isSnapshotPayload(payload)).toBe(true);
    expect(isSnapshotPayload(null)).toBe(false);
    expect(isSnapshotPayload({ ...payload, refCount: "1" })).toBe(false);
    expect(isSnapshotPayload({ ...payload, refs: undefined })).toBe(false);
  });

  it("drops the refs registry from the model-facing result", () => {
    expect(snapshotResultFromPayload(payload, "https://example.com", "Example")).toEqual({
      text: payload.text,
      nodeCount: 1,
      refCount: 1,
      truncated: false,
      url: "https://example.com",
      title: "Example",
    });
  });

  it("keeps the walker self-contained for page.evaluate", () => {
    const source = browseSnapshotWalker.toString();
    expect(source).toContain("data-rolebox-ref");
    expect(source).toContain("querySelector");
    // It must not close over host-side helpers, or the serialized copy would
    // reference identifiers that do not exist in the page.
    expect(source).not.toContain("serializeSnapshotOptions");
    expect(source).not.toContain("SNAPSHOT_DEFAULT_MAX_CHARS");
    expect(source).not.toContain("clampSnapshotMaxChars");
    expect(browseSnapshotWalker.name).toBe("browseSnapshotWalker");
  });
});
