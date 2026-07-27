/**
 * Integration-style tests for PiLightweightServiceStack.
 *
 * Verifies that:
 *   1. PiLightweightServiceStack creates a PiSessionAdapter internally
 *   2. init() compiles and registers all expected tools via pi.registerTool()
 *   3. Each tool in the required list is registered with the correct name
 */

import { describe, it, expect, mock } from "bun:test";
import { PiLightweightServiceStack } from "../src/platform/adapters/pi/service-stack.ts";
import type { ResolvedRole } from "../src/types.ts";

// ── Minimal mock role data ─────────────────────────────────────────────────

const emptyRole: ResolvedRole = {
  id: "test-role",
  config: {
    name: "Test Role",
    description: "A test role for Pi service stack tests",
    prompt: "You are a test role.",
  },
  prompt: "You are a test role.",
  skills: [],
  functions: [],
  references: [],
  subagents: [],
};

// ── Required tool names (from acceptance criteria) ─────────────────────────

const REQUIRED_TOOLS = [
  // Standalone tools
  "hashline_read",
  "hashline_edit",
  "memory_write",
  "memory_recall",
  "memory_list",
  "web_search",
  "web_read",
  "web_fetch",
  "signal",
  // Asset tools
  "asset_search",
  "asset_inspect",
  "reference_search",
  // Session tools
  "session_list",
  "session_read",
  "session_info",
  "session_diff",
  "session_fork",
];

const OPTIONAL_TOOLS = [
  "asset_validate",
  "session_search",
];

// dispatch_* tools are graph-superseded: no stubs are registered when no
// real dispatch tools are provided (bare-dispatch prevention).
const DISPATCH_TOOLS_WITHHELD = [
  "dispatch",
  "dispatch_output",
  "dispatch_cancel",
  "dispatch_metrics",
  "dispatch_status",
];

// ── Tests ──────────────────────────────────────────────────────────────────

describe("PiLightweightServiceStack", () => {
  it("compiles and registers all required tools via pi.registerTool()", async () => {
    const registeredNames: string[] = [];

    // Build a mock Pi API with a spy on registerTool
    const mockPi = {
      registerTool: (toolDef: any) => {
        registeredNames.push(toolDef.name);
      },
      on: () => {},
    };

    const stack = new PiLightweightServiceStack(
      mockPi,
      [emptyRole],
    );

    const count = await stack.init();

    // Verify the registered count matches the total expected tools
    expect(count).toBe(REQUIRED_TOOLS.length + OPTIONAL_TOOLS.length);

    // Verify every required tool is registered
    for (const toolName of REQUIRED_TOOLS) {
      expect(registeredNames).toContain(toolName);
    }

    // Verify every optional tool is registered
    for (const toolName of OPTIONAL_TOOLS) {
      expect(registeredNames).toContain(toolName);
    }

    // Verify dispatch_* tools are NOT registered (graph-only orchestration)
    for (const toolName of DISPATCH_TOOLS_WITHHELD) {
      expect(registeredNames).not.toContain(toolName);
    }

    // Verify no extra tools beyond our known set
    const allKnown = new Set([
      ...REQUIRED_TOOLS,
      ...OPTIONAL_TOOLS,
    ]);
    for (const name of registeredNames) {
      expect(allKnown.has(name)).toBe(true);
    }
  });

  it("handles missing pi.registerTool gracefully", async () => {
    // Pi API without registerTool
    const mockPi = {};
    const stack = new PiLightweightServiceStack(mockPi, [emptyRole]);

    // Should not throw — just logs a warning
    const count = await stack.init();
    expect(count).toBe(0);
  });
});
