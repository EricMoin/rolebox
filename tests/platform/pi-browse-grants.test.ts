
/**
 * Pi tool interceptor — the browse family's per-call grant.
 *
 * The seam is the browse twin of `computerUse`: `browseUse` on
 * `ToolInterceptorHooks` runs the same role decision before the shared
 * `handleToolBefore` pipeline, returns the denial as a tool result (never a
 * throw) and injects it into `pendingCorrections` when hook state is wired.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { interceptToolBefore } from "../../src/platform/adapters/pi/tool-interceptor.ts";
import { registerToolSchema } from "../../src/hooks/tool-before.ts";
import { HookState } from "../../src/hooks/state.ts";
import { BROWSE_TOOL_WILDCARD } from "../../src/loader/browse-grants.ts";
import type { ResolvedRole } from "../../src/types.ts";
import type { CanonicalToolContext } from "../../src/platform/types.ts";

function makeRole(id: string, tools?: Record<string, boolean>): ResolvedRole {
  return {
    id,
    config: { name: id, description: "", prompt: "", ...(tools === undefined ? {} : { tools }) },
    prompt: "",
    skills: [],
    functions: [],
    references: [],
    subagents: [],
  };
}

function toolContext(sessionID = "sess-1"): CanonicalToolContext {
  return {
    sessionID,
    messageID: "msg-1",
    agent: "role-agent",
    directory: "/tmp/rolebox-workspace",
    worktree: "/tmp/rolebox-workspace",
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  };
}

function hooks(roleId: string | null, roles: ResolvedRole[], state?: HookState) {
  return {
    ...(state === undefined ? {} : { state }),
    browseUse: { enabled: true, activeRoleFor: () => roleId, roles: () => roles },
  };
}

// Registered so an ALLOWED call runs the real pipeline below the policy.
registerToolSchema("browse_status", { page: z.string().optional() });

describe("pi tool interceptor — browse grant", () => {
  it("denies browse_* for a role with a disabling rule and returns the reason", async () => {
    const outcome = await interceptToolBefore(
      "browse_open",
      "call-1",
      { url: "https://example.com" },
      toolContext("sess-deny"),
      hooks("tester", [makeRole("tester", { "browse_*": false })]),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error).toContain('"tester"');
    expect(outcome.error).toContain("browse_open");
  });

  it("injects the denial into pendingCorrections when hook state is wired", async () => {
    const state = new HookState();
    const outcome = await interceptToolBefore(
      "browse_click",
      "call-2",
      {},
      toolContext("sess-correct"),
      hooks("tester", [makeRole("tester", { "browse_*": false })], state),
    );
    expect(outcome.ok).toBe(false);
    expect(state.pendingCorrections.get("sess-correct")).toContain("browse_click");
  });

  it("allows a granted role through the unchanged pipeline", async () => {
    const outcome = await interceptToolBefore(
      "browse_status",
      "call-3",
      { page: "main" },
      toolContext("sess-allow"),
      hooks("operator", [makeRole("operator", { [BROWSE_TOOL_WILDCARD]: true })]),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.value).toEqual({ page: "main" });
  });

  it("allows both a base agent and a role without browse rules", async () => {
    for (const roleId of [null, "operator"]) {
      const outcome = await interceptToolBefore(
        "browse_status",
        "call-default",
        { page: "main" },
        toolContext(),
        hooks(roleId, [makeRole("operator")]),
      );
      expect(outcome.ok).toBe(true);
    }
  });

  it("enforces an exact denial before a family grant", async () => {
    const outcome = await interceptToolBefore(
      "browse_eval",
      "call-denied-eval",
      {},
      toolContext("sess-denied-eval"),
      hooks("operator", [makeRole("operator", { [BROWSE_TOOL_WILDCARD]: true, browse_eval: false })]),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error).toContain("browse_eval");
  });

  it("leaves every non-browse tool — and the computer family — on the existing pipeline", async () => {
    const passthrough = await interceptToolBefore(
      "hashline_read",
      "call-4",
      { filePath: "/tmp/x" },
      toolContext("sess-other"),
      hooks("tester", [makeRole("tester", { "browse_*": false })]),
    );
    expect(passthrough.ok).toBe(true);
    if (!passthrough.ok) throw new Error("unreachable");
    expect(passthrough.value).toEqual({ filePath: "/tmp/x" });

    // The two seams are independent: a browse denial never refuses a computer
    // call, even when the same role disables both families.
    const state = new HookState();
    const computerCall = await interceptToolBefore(
      "computer_screenshot",
      "call-5",
      {},
      toolContext("sess-computer"),
      {
        ...hooks("tester", [], state),
        computerUse: { enabled: false, activeRoleFor: () => "tester", roles: () => [] },
      },
    );
    expect(computerCall.ok).toBe(true);
  });

  it("is inert when the gate is off or the seam is absent", async () => {
    const gateOff = await interceptToolBefore(
      "browse_status",
      "call-6",
      { page: "main" },
      toolContext("sess-off"),
      { browseUse: { enabled: false, activeRoleFor: () => "tester", roles: () => [makeRole("tester")] } },
    );
    expect(gateOff.ok).toBe(true);

    const noSeam = await interceptToolBefore(
      "browse_status",
      "call-7",
      { page: "main" },
      toolContext("sess-none"),
      {},
    );
    expect(noSeam.ok).toBe(true);
  });
});
