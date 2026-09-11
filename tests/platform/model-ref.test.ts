/// <reference types="bun-types" />

/**
 * model-ref tests — the shared, platform-neutral `splitModel` helper extracted
 * from the Pi role switcher (src/platform/adapters/pi/role-switcher.ts).
 *
 * Verifies first-slash semantics: the provider is the segment before the first
 * slash and the model id is everything after it, so multi-segment ids survive
 * intact. Malformed / non-provider-prefixed inputs return null.
 *
 * @module
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { splitModel } from "../../src/platform/model-ref.ts";

describe("splitModel", () => {
  it("splits a single-segment provider/model pair", () => {
    expect(splitModel("anthropic/claude-opus-4.8")).toEqual({
      provider: "anthropic",
      id: "claude-opus-4.8",
    });
  });

  it("uses first-slash semantics so multi-segment model ids stay intact", () => {
    expect(splitModel("openrouter-anthropic/anthropic/claude-opus-4.8")).toEqual({
      provider: "openrouter-anthropic",
      id: "anthropic/claude-opus-4.8",
    });
  });

  it("returns null for a bare model name with no slash", () => {
    expect(splitModel("gpt-4")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(splitModel("")).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(splitModel(undefined)).toBeNull();
  });

  it('returns null for the "default" sentinel', () => {
    expect(splitModel("default")).toBeNull();
  });

  it("returns null for a leading-slash (empty provider) input", () => {
    expect(splitModel("/claude-opus-4.8")).toBeNull();
  });

  it("returns null for a trailing-slash (empty model id) input", () => {
    expect(splitModel("anthropic/")).toBeNull();
  });
});

describe("pi role-switcher uses the shared helper", () => {
  const switcherSource = readFileSync(
    resolve(import.meta.dir, "../../src/platform/adapters/pi/role-switcher.ts"),
    "utf-8",
  );

  it("imports splitModel from the shared platform module", () => {
    expect(switcherSource).toContain('from "../../model-ref.ts"');
  });

  it("no longer declares a local splitModel function", () => {
    expect(switcherSource).not.toMatch(/function\s+splitModel\s*\(/);
  });
});
