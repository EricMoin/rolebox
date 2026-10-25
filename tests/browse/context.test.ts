/**
 * The injected browser workflow block: inclusion, wording and presentation.
 */

import { describe, expect, it } from "vitest";
import { buildBrowseContext } from "../../src/browse/context.ts";
import { BROWSE_TOOL_NAMES } from "../../src/browse/tools.ts";

const ALL_TOOLS = [...BROWSE_TOOL_NAMES];

describe("buildBrowseContext inclusion", () => {
  it("returns an empty string when no browse tool is registered", () => {
    expect(buildBrowseContext({ tools: [] })).toBe("");
    expect(buildBrowseContext({ tools: ["web_fetch", "computer_click", "memory_write"] })).toBe("");
  });

  it("returns an empty string for a prefix-only or partial name", () => {
    expect(buildBrowseContext({ tools: ["browse_", "browse"] })).toBe("");
  });

  it("renders the workflow block when any browse tool is registered", () => {
    const block = buildBrowseContext({ tools: ["browse_status"] });
    expect(block).toContain("## Browser use workflow");
    expect(block).toContain("browse_status");
    expect(block).not.toContain("Call browse_close");
  });
});

describe("browse workflow instructions", () => {
  const block = buildBrowseContext({ tools: ALL_TOOLS });

  it("prefers browse actions over screen control for web pages", () => {
    expect(block).toContain("Prefer the browse tools over computer-use screen control");
  });

  it("teaches the open-then-snapshot workflow and the ref lifecycle", () => {
    expect(block).toContain("Start with browse_open");
    expect(block).toContain("browse_snapshot");
    expect(block).toContain("Act only on refs from the latest browse_snapshot");
    expect(block).toContain("stale");
    expect(block).toContain("re-snapshot");
  });

  it("points at read and screenshot for content and layout", () => {
    expect(block).toContain("browse_read");
    expect(block).toContain("browse_screenshot");
  });

  it("points at console and network for failures", () => {
    expect(block).toContain("browse_console");
    expect(block).toContain("browse_network");
  });

  it("handles dialogs, tabs, status and closing", () => {
    expect(block).toContain("browse_dialog");
    expect(block).toContain("Tabs are named pages");
    expect(block).toContain("optional local dependency");
    expect(block).toContain("browse_status");
    expect(block).toContain("Call browse_close");
  });

  it("says the local browser reaches localhost and that results must be observed", () => {
    expect(block).toContain("localhost");
    expect(block).toContain("Report only what a tool result showed");
  });

  it("omits guidance for tools that are not registered", () => {
    const partial = buildBrowseContext({ tools: ["browse_snapshot", "browse_click"] });
    expect(partial).toContain("browse_snapshot");
    expect(partial).not.toContain("browse_status");
    expect(partial).not.toContain("browse_console");
    expect(partial).not.toContain("browse_close");
  });
});

describe("presentation wording", () => {
  it("uses direct native tool calls by default", () => {
    const block = buildBrowseContext({ tools: ALL_TOOLS });
    expect(block).not.toContain("graph_worker_tools");
    expect(block).not.toContain("graph_worker_code");
  });

  it("describes describe-then-native for discover mode", () => {
    const block = buildBrowseContext({ tools: ALL_TOOLS, presentation: "discover" });
    expect(block).toContain('graph_worker_tools(action="describe", name=...)');
    expect(block).toContain("Then call its native tool only after describe has exposed the schema");
    expect(block).not.toContain('graph_worker_tools(action="call"');
  });

  it("describes describe-then-call for discover mode with call invocation", () => {
    const block = buildBrowseContext({
      tools: ALL_TOOLS,
      presentation: "discover",
      discoverInvocation: "call",
    });
    expect(block).toContain('graph_worker_tools(action="call", name=..., arguments=...)');
    expect(block).toContain("these names are not direct tool calls");
  });

  it("describes the code bridge for code mode", () => {
    const block = buildBrowseContext({ tools: ALL_TOOLS, presentation: "code" });
    expect(block).toContain("await tools.call(name, args)");
    expect(block).toContain("graph_worker_code");
    expect(block).toContain("These names are not direct tool calls");
  });
});
