import { describe, expect, it } from "bun:test";
import { filterNodes } from "../../src/graph/query/render.ts";
import type { GraphNodeView } from "../../src/graph/query/graph-query.ts";

const nodes: GraphNodeView[] = [
  { nodeId: "plan", agent: "planner", prompt: "Plan the release", status: "dispatched", dispatchedAt: 100,
    attemptId: "plan#1", outcomeId: undefined, settledAt: undefined, inputs: undefined, inputRefusals: undefined, arrivals: undefined },
  { nodeId: "review", agent: "reviewer", prompt: "Review the diff", status: "settled", dispatchedAt: 200,
    attemptId: "review#2", outcomeId: "done", settledAt: 300, inputs: undefined, inputRefusals: undefined, arrivals: undefined },
  { nodeId: "ship", agent: "planner", prompt: "Publish", status: "pending", dispatchedAt: undefined,
    attemptId: undefined, outcomeId: undefined, settledAt: undefined, inputs: undefined, inputRefusals: undefined, arrivals: undefined },
];
const ids = (value: GraphNodeView[]) => value.map((node) => node.nodeId);

describe("native graph node queries", () => {
  it("searches node, agent and prompt case-insensitively without changing the input", () => {
    expect(ids(filterNodes(nodes, { query: "RELEASE" }))).toEqual(["plan"]);
    expect(ids(filterNodes(nodes, { query: "planner" }))).toEqual(["plan", "ship"]);
    expect(ids(filterNodes(nodes, { query: "missing" }))).toEqual([]);
    expect(nodes).toHaveLength(3);
  });
  it("combines identity, status and agent filters", () => {
    expect(ids(filterNodes(nodes, { agent: "planner", status: "pending" }))).toEqual(["ship"]);
    expect(ids(filterNodes(nodes, { node_id: "review", status: "dispatched" }))).toEqual([]);
    expect(filterNodes(nodes, {})).toEqual(nodes);
  });
  it("uses actual dispatch and settlement dates, excluding unknown timestamps", () => {
    expect(ids(filterNodes(nodes, { from_date: new Date(200).toISOString() }))).toEqual(["review"]);
    expect(ids(filterNodes(nodes, { to_date: new Date(300).toISOString() }))).toEqual(["review"]);
    expect(ids(filterNodes(nodes, { from_date: new Date(301).toISOString(), to_date: new Date(400).toISOString() }))).toEqual([]);
    expect(() => filterNodes(nodes, { from_date: "bad" })).toThrow("Invalid date");
    expect(() => filterNodes(nodes, { to_date: "bad" })).toThrow("Invalid date");
  });
});
