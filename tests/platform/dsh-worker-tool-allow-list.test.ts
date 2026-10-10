/**
 * The dsh worker allow-list — the start request's `toolFilter.allow` for ONE
 * attempt (item 1b).
 *
 * THE CLAIM THIS FILE PROVES. The list is the baseline PLUS the executing
 * node's declared entries INTERSECTED with the tools the host actually
 * registered, so a declared name nobody registered can never be named to
 * `tools.restrict()` (which THROWS on an unknown name and would abort the
 * start), and no input can produce a name the node did not declare. Every
 * uncertainty answers the narrower side: an absent declaration, an empty
 * candidate set and a throwing predicate all leave the baseline alone.
 *
 * STRENGTH: pure-function level. The resolver is the shipped one; the "host"
 * here is a set membership test, and the delivery that calls it is covered
 * end-to-end in `tests/dsh-plugin.test.ts` (which drives the real entry, the
 * real graph start and the fake subagent runtime).
 */

import { describe, expect, it } from "bun:test";

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
  it("answers exactly the REGISTERED baseline for an absent declaration", () => {
    const allow = resolveDshWorkerToolAllowList({
      baseline: BASELINE,
      candidates: ["computer_screenshot"],
      isRegistered: registry(["computer_screenshot", "graph_submit_outcome"]),
    });
    // graph_worker_exec is not registered here, so it is NOT named: a name the
    // host does not resolve would make restrict() throw and abort the start.
    expect(allow).toEqual(["graph_submit_outcome"]);
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

  it("probes an exact declared name by name, so a host-owned tool is grantable", () => {
    const allow = resolveDshWorkerToolAllowList({
      baseline: BASELINE,
      declared: ["browser_open"],
      // The composed candidate set does not carry the host's own tool.
      candidates: ["computer_screenshot"],
      isRegistered: registry([...BASELINE, "browser_open"]),
    });
    expect(allow).toEqual([...BASELINE, "browser_open"]);
  });

  it("never names an unregistered declared entry, and never names an undeclared one", () => {
    const allow = resolveDshWorkerToolAllowList({
      baseline: BASELINE,
      declared: ["browser_open"],
      candidates: ["browser_open", "computer_screenshot"],
      isRegistered: registry([...BASELINE, "computer_screenshot"]),
    });
    // `browser_open` was declared but is not registered; `computer_screenshot`
    // is registered but not declared. Neither appears.
    expect(allow).toEqual([...BASELINE]);
  });

  it("cannot re-open the graph face, whatever the node declares", () => {
    const graphFace = [
      "graph_declare",
      "graph_status",
      "graph_control",
      "graph_audit",
      "graph_submit_outcome",
      "graph_worker_exec",
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
