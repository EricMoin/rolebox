import { describe, it, expect } from "bun:test";
import { parseLoopParams } from "../../src/loop/params";
import type { FunctionCall } from "../../src/function-parser";

function callFromPositional(
  iterations?: string,
  mode?: string,
): FunctionCall {
  const args: Record<string, string> = {};
  if (iterations !== undefined) args._0 = iterations;
  if (mode !== undefined) args._1 = mode;
  return { name: "loop", args };
}

function callFromKeyValue(
  iterations?: string,
  mode?: string,
): FunctionCall {
  const args: Record<string, string> = {};
  if (iterations !== undefined) args.iterations = iterations;
  if (mode !== undefined) args.mode = mode;
  return { name: "loop", args };
}

function callFromArgs(args: Record<string, string>): FunctionCall {
  return { name: "loop", args };
}

describe("parseLoopParams", () => {
  // ── Defaults ──
  it("returns defaults when no args provided", () => {
    const result = parseLoopParams({ name: "loop", args: {} });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.iterations).toBe(5);
      expect(result.mode).toBe("inherit");
      expect(result.clamped).toBeUndefined();
      expect(result.warning).toBeUndefined();
    }
  });

  // ── Positional args ──
  it("parses positional: |loop:3,fresh| → iterations=3, mode=fresh", () => {
    const result = parseLoopParams(callFromPositional("3", "fresh"));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.iterations).toBe(3);
      expect(result.mode).toBe("fresh");
      expect(result.clamped).toBeUndefined();
    }
  });

  it("parses positional with only iterations", () => {
    const result = parseLoopParams(callFromPositional("10"));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.iterations).toBe(10);
      expect(result.mode).toBe("inherit");
    }
  });

  it("parses positional with only mode", () => {
    const result = parseLoopParams(callFromPositional(undefined, "fresh"));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.iterations).toBe(5); // default
      expect(result.mode).toBe("fresh");
    }
  });

  // ── Key-value args ──
  it("parses key-value: |loop iterations=3 mode=fresh|", () => {
    const result = parseLoopParams(callFromKeyValue("3", "fresh"));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.iterations).toBe(3);
      expect(result.mode).toBe("fresh");
    }
  });

  it("parses key-value: iterations=7 only", () => {
    const result = parseLoopParams(callFromArgs({ iterations: "7" }));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.iterations).toBe(7);
      expect(result.mode).toBe("inherit");
    }
  });

  it("key-value iterations takes precedence over positional", () => {
    const result = parseLoopParams(
      callFromArgs({ _0: "10", iterations: "7" }),
    );
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.iterations).toBe(7);
    }
  });

  // ── iterations=0 rejected ──
  it("rejects iterations=0", () => {
    const result = parseLoopParams(callFromKeyValue("0"));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("iterations must be >= 1");
    }
  });

  // ── iterations=-1 rejected ──
  it("rejects iterations=-1", () => {
    const result = parseLoopParams(callFromKeyValue("-1"));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("iterations must be >= 1");
    }
  });

  it("rejects iterations=-5 (positional)", () => {
    const result = parseLoopParams(callFromPositional("-5"));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("iterations must be >= 1");
    }
  });

  // ── iterations=99 clamped to 50 ──
  it("clamps iterations=99 to 50 with clamped=true", () => {
    const result = parseLoopParams(callFromKeyValue("99"));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.iterations).toBe(50);
      expect(result.clamped).toBe(true);
    }
  });

  it("clamps iterations=200 to 50 (positional)", () => {
    const result = parseLoopParams(callFromPositional("200"));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.iterations).toBe(50);
      expect(result.clamped).toBe(true);
    }
  });

  // ── mode=fresh ──
  it("mode=fresh", () => {
    const result = parseLoopParams(callFromKeyValue(undefined, "fresh"));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.mode).toBe("fresh");
    }
  });

  // ── mode=no-inherit → fresh ──
  it("mode=no-inherit → fresh", () => {
    const result = parseLoopParams(callFromKeyValue(undefined, "no-inherit"));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.mode).toBe("fresh");
    }
  });

  // ── mode=off → fresh ──
  it("mode=off → fresh", () => {
    const result = parseLoopParams(callFromKeyValue(undefined, "off"));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.mode).toBe("fresh");
    }
  });

  // ── mode=false → fresh ──
  it("mode=false → fresh", () => {
    const result = parseLoopParams(callFromKeyValue(undefined, "false"));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.mode).toBe("fresh");
    }
  });

  // ── mode=true → inherit ──
  it("mode=true → inherit", () => {
    const result = parseLoopParams(callFromKeyValue(undefined, "true"));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.mode).toBe("inherit");
    }
  });

  // ── mode=on → inherit ──
  it("mode=on → inherit", () => {
    const result = parseLoopParams(callFromKeyValue(undefined, "on"));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.mode).toBe("inherit");
    }
  });

  // ── unknown mode → inherit + warning ──
  it("unknown mode (e.g. mode=xyz) → inherit + warning", () => {
    const result = parseLoopParams(callFromKeyValue(undefined, "xyz"));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.mode).toBe("inherit");
      expect(result.warning).toMatch(/unknown.*mode/i);
    }
  });

  it("unknown mode with iterations still works", () => {
    const result = parseLoopParams(callFromKeyValue("4", "blah"));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.iterations).toBe(4);
      expect(result.mode).toBe("inherit");
      expect(result.warning).toBeDefined();
    }
  });

  // ── Non-numeric iterations → default ──
  it("non-numeric iterations string uses default", () => {
    const result = parseLoopParams(callFromKeyValue("abc"));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.iterations).toBe(5); // DEFAULT_ITERATIONS
    }
  });

  // ── Positional with just mode (no iterations) ──
  it("positional: |loop:,fresh| → default iterations, mode=fresh", () => {
    const result = parseLoopParams(callFromPositional("", "fresh"));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.iterations).toBe(5);
      expect(result.mode).toBe("fresh");
    }
  });
});
