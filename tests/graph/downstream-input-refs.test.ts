/// <reference types="bun-types" />

/**
 * Downstream inputs are FIXED at compile time (§3.5).
 *
 * A consumer names an upstream node and an outcome; it never reads "the latest
 * result of some type". Everything the compiler cannot pin — an undeclared node,
 * an outcome that node does not declare, the node itself, a repeat, or a node
 * that no declared edge path can reach — is refused where the plan is built,
 * rather than resolved into something arbitrary at dispatch time.
 *
 * @module
 */

import { describe, it, expect } from "bun:test";
import { compileGraph } from "../../src/graph/compiler/compile.ts";

type Inputs = Array<{ from: string; outcome: string }> | undefined;

function chain(inputs: Inputs, opts: { extraNode?: boolean } = {}) {
  return {
    version: 3,
    name: "p42.inputs",
    nodes: [
      {
        id: "work",
        agent: "agent.work",
        prompt: "Produce.",
        outcomes: [{ id: "done" }],
        completion: { mode: "explicit" },
      },
      ...(opts.extraNode === true
        ? [
            {
              id: "other",
              agent: "agent.other",
              prompt: "Unrelated.",
              outcomes: [{ id: "spare" }],
              completion: { mode: "explicit" },
            },
          ]
        : []),
      {
        id: "review",
        agent: "agent.review",
        prompt: "Consume.",
        outcomes: [{ id: "ok" }],
        completion: { mode: "explicit" },
        ...(inputs === undefined ? {} : { inputs }),
      },
    ],
    edges: [{ from: "work", to: "review", outcome: "done" }],
  };
}

function codesOf(declaration: unknown): string[] {
  const result = compileGraph(declaration);
  expect(result.ok).toBe(false);
  if (result.ok) return [];
  return result.errors.map((entry) => entry.code);
}

describe("downstream inputs are compiled into fixed references", () => {
  it("pins an upstream node and outcome into the plan", () => {
    const result = compileGraph(chain([{ from: "work", outcome: "done" }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("executable");
    const review = result.plan.nodes.find((node) => node.id === "review");
    expect(review?.inputs).toEqual([{ from: "work", outcome: "done" }]);
    // The producer declares no inputs of its own.
    const work = result.plan.nodes.find((node) => node.id === "work");
    expect(work?.inputs).toBeUndefined();
  });

  it("refuses a node the graph does not declare", () => {
    expect(codesOf(chain([{ from: "ghost", outcome: "done" }]))).toContain(
      "unknown-input-node",
    );
  });

  it("refuses an outcome the producer does not declare", () => {
    expect(codesOf(chain([{ from: "work", outcome: "nope" }]))).toContain(
      "unknown-input-outcome",
    );
  });

  it("refuses a node consuming its own accepted result", () => {
    expect(codesOf(chain([{ from: "review", outcome: "ok" }]))).toContain(
      "self-referential-input",
    );
  });

  it("refuses a repeat of the same reference", () => {
    expect(
      codesOf(
        chain([
          { from: "work", outcome: "done" },
          { from: "work", outcome: "done" },
        ]),
      ),
    ).toContain("duplicate-input");
  });

  it("refuses a producer no declared edge path can reach", () => {
    // `other` exists and declares `spare`, but nothing leads from it to
    // `review` — an input is an UPSTREAM result, not an arbitrary one.
    expect(
      codesOf(chain([{ from: "other", outcome: "spare" }], { extraNode: true })),
    ).toContain("input-not-upstream");
  });
});
