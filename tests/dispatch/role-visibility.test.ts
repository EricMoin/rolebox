import { describe, expect, it } from "vitest";
import { createDispatchTool } from "../../src/dispatch/tools.ts";
import type { DispatchManager } from "../../src/dispatch/core/manager.ts";
import { makeToolContext } from "../asset/helpers.ts";

const lineage = new Map([
  ["engineer--worker", { parentFullId: "engineer" }],
  ["engineer--worker--nested", { parentFullId: "engineer--worker" }],
  ["designer--private", { parentFullId: "designer" }],
]);
const invalid = { subagent: "missing", prompt: "Work", run_in_background: true };

describe("dispatch role visibility", () => {
  it("lists only direct children when a target is unknown", async () => {
    const tool = createDispatchTool({} as DispatchManager, lineage);
    const result = await tool.execute(invalid, makeToolContext({ agent: "engineer" }));
    expect(result).toContain("engineer--worker");
    expect(result).not.toContain("engineer--worker--nested");
    expect(result).not.toContain("designer--private");
  });

  it("uses the platform's effective agent and does not reveal children to unknown callers", async () => {
    const fallback = createDispatchTool({} as DispatchManager, lineage, undefined, () => "engineer--worker");
    const result = await fallback.execute(invalid, makeToolContext({ agent: "" }));
    expect(result).toContain("engineer--worker--nested");
    expect(result).not.toContain("designer--private");
    const tool = createDispatchTool({} as DispatchManager, lineage);
    expect(await tool.execute(invalid, makeToolContext({ agent: "external-agent" }))).toContain("(none)");
  });
});
