import { describe, expect, it } from "bun:test";
import { resolveTeamAgentOptions } from "../../src/team/agent-options.ts";

describe("resolveTeamAgentOptions", () => {
  it("uses a complete composed selection without the host fallback", () => {
    const resolved = resolveTeamAgentOptions({
      roleModel: "example-provider/designer-model",
      composed: { provider: "example-provider", model: "designer-model" },
      fallback: { provider: "host-provider", model: "host-model", reasoningEffort: "high" },
    });

    expect(resolved).toEqual({ agentOptions: { provider: "example-provider", model: "designer-model" }, usedFallback: false });
  });

  it("uses the host fallback when the role declares no model", () => {
    const resolved = resolveTeamAgentOptions({
      fallback: { provider: "host-provider", model: "host-model", reasoningEffort: "high", maxTokens: 8192 },
    });

    expect(resolved).toEqual({
      agentOptions: { provider: "host-provider", model: "host-model", reasoningEffort: "high", maxTokens: 8192 },
      usedFallback: true,
    });
  });

  it("keeps the full host selection when an unregistered route degraded to model-only", () => {
    const resolved = resolveTeamAgentOptions({
      roleModel: "unregistered-provider/designer-model",
      composed: { model: "designer-model" },
      fallback: { provider: "host-provider", model: "host-model" },
    });

    expect(resolved.usedFallback).toBe(true);
    expect(resolved.agentOptions).toEqual({ provider: "host-provider", model: "host-model" });
  });

  it("combines a model-only role with the fallback provider", () => {
    const resolved = resolveTeamAgentOptions({
      roleModel: "designer-model",
      composed: { model: "designer-model" },
      fallback: { provider: "host-provider", model: "host-model", reasoningEffort: "low" },
    });

    expect(resolved.usedFallback).toBe(true);
    expect(resolved.agentOptions).toEqual({ provider: "host-provider", model: "designer-model", reasoningEffort: "low" });
  });

  it("returns no options when neither a composed selection nor a fallback is usable", () => {
    expect(resolveTeamAgentOptions({ roleModel: "designer-model", composed: { model: "designer-model" } }))
      .toEqual({ agentOptions: undefined, usedFallback: false });
    expect(resolveTeamAgentOptions({ composed: {}, fallback: { provider: "host-provider" } }))
      .toEqual({ agentOptions: undefined, usedFallback: false });
  });

  it("prefers role-declared sampling limits over the fallback's and never mutates its inputs", () => {
    const composed = { model: "designer-model", maxTokens: 2048 };
    const fallback = { provider: "host-provider", model: "host-model", reasoningEffort: "high", maxTokens: 8192 };
    const resolved = resolveTeamAgentOptions({ roleModel: "designer-model", composed, fallback });

    expect(resolved.agentOptions).toEqual({ provider: "host-provider", model: "designer-model", reasoningEffort: "high", maxTokens: 2048 });
    expect(composed).toEqual({ model: "designer-model", maxTokens: 2048 });
    expect(fallback).toEqual({ provider: "host-provider", model: "host-model", reasoningEffort: "high", maxTokens: 8192 });
    expect(resolved.agentOptions).not.toBe(fallback);
  });
});
