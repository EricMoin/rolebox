/** Worker allow-lists intersect the inherited catalog, explicit node restriction and registered host tools. */

import { describe, expect, it } from "vitest";

import { resolveDshWorkerToolAllowList } from "../../src/platform/adapters/dsh/outcome-dispatch.ts";
import { DSH_GRAPH_WORKER_TOOLS } from "../../src/platform/adapters/dsh/graph-worker.ts";
import { COMPUTER_TOOL_NAMES } from "../../src/loader/computer-grants.ts";

const BASELINE = DSH_GRAPH_WORKER_TOOLS;

/** A registry double: only the names in `names` resolve. */
function registry(names: readonly string[]): (name: string) => boolean {
  const known = new Set(names);
  return (name: string) => known.has(name);
}

describe("the per-request worker allow-list", () => {
  it("cannot expand inherited permissions with an explicit name or prefix", () => {
    expect(resolveDshWorkerToolAllowList({ baseline: BASELINE, declared: ["computer_*", "web_search"],
      inherited: ["computer_screenshot"], candidates: ["computer_screenshot", "computer_click", "web_search", "dispatch"],
      isRegistered: registry([...BASELINE, "computer_screenshot", "computer_click", "web_search", "dispatch"]),
    })).toEqual([...BASELINE, "computer_screenshot"]);
  });

  it("inherits registered task candidates for an absent restriction", () => {
    const allow = resolveDshWorkerToolAllowList({
      baseline: BASELINE,
      candidates: ["computer_screenshot"],
      isRegistered: registry(["computer_screenshot", "graph_submit_outcome"]),
    });
    expect(allow).toEqual(["graph_submit_outcome", "computer_screenshot"]);
  });

  it("adds a declared prefix's REGISTERED names, in candidate order", () => {
    const allow = resolveDshWorkerToolAllowList({
      baseline: BASELINE,
      declared: ["computer_*"],
      // `computer_move` is declared by the wildcard but NOT registered.
      candidates: ["computer_screenshot", "computer_move", "computer_click"],
      isRegistered: registry([
        ...BASELINE,
        "computer_screenshot",
        "computer_click",
      ]),
    });
    expect(allow).toEqual([...BASELINE, "computer_screenshot", "computer_click"]);
  });

  it("does not use legacy node names to expand the parent catalog", () => {
    const allow = resolveDshWorkerToolAllowList({
      baseline: BASELINE,
      declared: ["browser_open"],
      // The composed candidate set does not carry the host's own tool.
      candidates: ["computer_screenshot"],
      isRegistered: registry([...BASELINE, "browser_open"]),
    });
    expect(allow).toEqual([...BASELINE]);
  });

  it("inherits registered tools regardless of legacy node names", () => {
    const allow = resolveDshWorkerToolAllowList({
      baseline: BASELINE,
      declared: ["browser_open"],
      candidates: ["browser_open", "computer_screenshot"],
      isRegistered: registry([...BASELINE, "computer_screenshot"]),
    });
    expect(allow).toEqual([...BASELINE, "computer_screenshot"]);
  });

  it("cannot re-open the graph face, whatever the node declares", () => {
    const graphFace = [
      "graph_declare",
      "graph_status",
      "graph_control",
      "graph_audit",
      "graph_submit_outcome",
    ];
    const allow = resolveDshWorkerToolAllowList({
      baseline: BASELINE,
      declared: ["graph_*", "graph_status"],
      candidates: graphFace,
      isRegistered: registry([...graphFace, ...COMPUTER_TOOL_NAMES]),
    });
    // The baseline is kept (that is the worker's own delivery channel); every
    // OTHER graph name stays out even though it is registered and matched by
    // the declared entry.
    expect(allow).toEqual([...BASELINE]);
  });

  it("treats a predicate that throws as 'not registered'", () => {
    const allow = resolveDshWorkerToolAllowList({
      baseline: BASELINE,
      declared: ["computer_*"],
      candidates: ["computer_screenshot"],
      isRegistered: () => {
        throw new Error("the registry read failed");
      },
    });
    expect(allow).toEqual([]);
  });

  it("de-duplicates and freezes the answer", () => {
    const allow = resolveDshWorkerToolAllowList({
      baseline: BASELINE,
      declared: ["graph_submit_outcome", "computer_*"],
      candidates: [...BASELINE, "computer_screenshot"],
      isRegistered: registry([...BASELINE, "computer_screenshot"]),
    });
    expect(allow).toEqual([...BASELINE, "computer_screenshot"]);
    expect(Object.isFrozen(allow)).toBe(true);
  });
});
