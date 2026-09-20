/// <reference types="bun-types" />

import { describe, it, expect } from "bun:test";
import {
  codexCapabilities,
  dshCapabilities,
  minimalCapabilities,
  opencodeCapabilities,
  piCapabilities,
} from "../../src/platform/capabilities.ts";
import {
  PLATFORM_REGISTRY,
  resolvePlatformCapabilities,
} from "../../src/platform/registry.ts";

// ── Declarations ────────────────────────────────────────────────────────────
// These lock the contract that replaced the old `defaultCapabilities()`:
// every host declares its own set, and no host inherits opencode's by omission.

describe("platform capability declarations", () => {
  it("each declaration self-identifies with its platform id", () => {
    expect(opencodeCapabilities().platformId).toBe("opencode");
    expect(piCapabilities().platformId).toBe("pi");
    expect(dshCapabilities().platformId).toBe("dsh");
    expect(codexCapabilities().platformId).toBe("codex");
  });

  it("opencode does not claim in-session role switching", () => {
    // The old doc comment said "all features are supported"; it never was true.
    expect(opencodeCapabilities().hasRoleSwitch).toBe(false);
    expect(piCapabilities().hasRoleSwitch).toBe(true);
    expect(dshCapabilities().hasRoleSwitch).toBe(true);
  });

  it("every registry descriptor carries a capability declaration", () => {
    for (const descriptor of PLATFORM_REGISTRY) {
      expect(typeof descriptor.capabilities).toBe("function");
      expect(descriptor.capabilities().platformId).toBe(descriptor.id);
    }
  });
});

// ── Resolution ──────────────────────────────────────────────────────────────

describe("resolvePlatformCapabilities", () => {
  it("answers a known platform with its own declared set", () => {
    expect(resolvePlatformCapabilities("opencode")).toEqual(opencodeCapabilities());
    expect(resolvePlatformCapabilities("pi")).toEqual(piCapabilities());
    expect(resolvePlatformCapabilities("dsh")).toEqual(dshCapabilities());
    expect(resolvePlatformCapabilities("codex")).toEqual(codexCapabilities());
  });

  it("answers every registered platform, not just the named ones", () => {
    for (const descriptor of PLATFORM_REGISTRY) {
      expect(resolvePlatformCapabilities(descriptor.id).platformId).toBe(descriptor.id);
    }
  });

  it("degrades an unknown platform to minimal instead of opencode", () => {
    const caps = resolvePlatformCapabilities("some-new-harness");
    expect(caps).toEqual(minimalCapabilities("some-new-harness"));
    expect(caps.platformId).toBe("some-new-harness");
    expect(caps.hasSessionCreate).toBe(false);
    expect(caps.hasBackgroundTasks).toBe(false);
    expect(caps).not.toEqual(opencodeCapabilities());
  });

  it("degrades an omitted platform id to minimal, never to opencode", () => {
    const caps = resolvePlatformCapabilities();
    expect(caps).toEqual(minimalCapabilities("unknown"));
    expect(caps.platformId).toBe("unknown");
    expect(caps).not.toEqual(opencodeCapabilities());
  });

  it("keeps opencode reachable by name", () => {
    // Fail-closed must not make the reference host unreachable.
    const caps = resolvePlatformCapabilities("opencode");
    expect(caps.hasBackgroundTasks).toBe(true);
    expect(caps.hasAgentFileSync).toBe(true);
  });
});
