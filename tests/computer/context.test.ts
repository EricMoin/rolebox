import { describe, expect, it } from "vitest";
import { buildComputerContext } from "../../src/computer/context.ts";
import { COMPUTER_TOOL_NAMES } from "../../src/loader/computer-grants.ts";

describe("computer workflow context", () => {
  it("stays absent without an actual computer capability", () => {
    for (const tools of [[], ["web_search"], ["computer_*"], ["computer_unknown"]]) {
      expect(buildComputerContext({ tools })).toBe("");
    }
  });

  it("prefers dedicated tools and describes the observe, act, verify workflow", () => {
    const context = buildComputerContext({ tools: COMPUTER_TOOL_NAMES });
    expect(context).toContain("Prefer a suitable dedicated API, CLI, or application tool");
    expect(context).toContain("task requires observing or interacting with the desktop");
    expect(context).toContain("## Computer use workflow");
    expect(context).toContain("before choosing coordinates");
    expect(context).toContain("again after focusing or an action");
    expect(context).toContain("metadata.origin and metadata.pixel_scale_x / metadata.pixel_scale_y");
    expect(context).toContain("display layout/scale change requires a fresh screenshot");
    expect(context).toContain("Do not reuse stale coordinates");
    expect(context).toContain("small, deliberate actions");
    expect(context).toContain("pass the observed window_id on each input call");
    expect(context).toContain("same queued operation");
    expect(context).toContain("no target is remembered between calls");
    expect(context).toContain("Pointer coordinates remain absolute screen coordinates");
    expect(context).toContain("does not prove the requested application change occurred");
    expect(context).toContain("Do not change configuration, tool grants, or OS privacy settings to authorize yourself");
  });

  it("explains permission requests, separate grants, and user-action recovery", () => {
    const context = buildComputerContext({ tools: ["computer_permissions"] });
    expect(context).toContain("On a permission denial");
    expect(context).toContain("computer_permissions(request=true)");
    expect(context).toContain("reported next_action");
    expect(context).toContain("then wait");
    expect(context).toContain("recheck with computer_permissions without request");
    expect(context).toContain("do not loop permission requests");
    expect(context).toContain("metadata.granted and metadata.screen_capture are independent");
    expect(context).toContain("does not prove OS authorization");
    expect(context).not.toContain("computer_status");
  });

  it("does not prescribe permission requests or missing observations without those tools", () => {
    const context = buildComputerContext({ tools: ["computer_click"] });
    expect(context).not.toContain("computer_permissions");
    expect(context).not.toContain("computer_screenshot");
    expect(context).not.toContain("request=true");
    expect(context).toContain("another permitted observation capability");
    expect(context).toContain("Do not guess positions");
  });

  it("keeps observation-only grants free of input instructions", () => {
    const context = buildComputerContext({ tools: ["computer_windows", "computer_screenshot"] });
    expect(context).toContain("current window IDs");
    expect(context).toContain("computer_screenshot");
    expect(context).not.toContain("small, deliberate actions");
    expect(context).not.toContain("computer_focus");
    expect(context).not.toContain("computer_click");
  });

  it("mentions only authorized computer tools for every grant combination", () => {
    for (let mask = 1; mask < 1 << COMPUTER_TOOL_NAMES.length; mask++) {
      const tools = COMPUTER_TOOL_NAMES.filter((_, index) => mask & (1 << index));
      const context = buildComputerContext({ tools });
      const mentioned = new Set(context.match(/computer_[a-z]+/g));
      const available = new Set<string>(tools);
      for (const name of mentioned) expect(available.has(name)).toBe(true);
      for (const name of tools) expect(mentioned.has(name)).toBe(true);
    }
  });

  it("uses each host's actual discovery route", () => {
    const tools = ["computer_screenshot", "computer_permissions"];
    const native = buildComputerContext({ tools });
    expect(native).not.toContain("graph_worker_");
    const pi = buildComputerContext({ tools, presentation: "discover" });
    expect(pi).toContain('graph_worker_tools(action="describe"');
    expect(pi).toContain("native tool only after describe");
    expect(pi).not.toContain('action="call"');
    const dsh = buildComputerContext({ tools, presentation: "discover", discoverInvocation: "call" });
    expect(dsh).toContain('graph_worker_tools(action="call"');
    expect(dsh).toContain("not direct tool calls");
    const code = buildComputerContext({ tools, presentation: "code" });
    expect(code).toContain("graph_worker_code with await tools.call(name, args)");
    expect(code).toContain('graph_worker_tools(action="describe"');
  });
});
