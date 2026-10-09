import { describe, expect, it } from "bun:test";

import { buildAttemptDeliveryPrompt } from "../../src/graph/host/delivery.ts";
import type { DeliveredInputView } from "../../src/graph/host/input-view.ts";
import type { AcceptedData } from "../../src/graph/domain/model.ts";
import type { OutcomeDispatchRequest } from "../../src/graph/outcome/dispatch-effects.ts";

const REQUEST: OutcomeDispatchRequest = {
  graphId: "graph.example",
  planRevision: "rev-1",
  nodeId: "review",
  attemptId: "review#1",
  agent: "agent.review",
  prompt: "Verify the change.",
  credential: "attempt-credential",
};

function viewOf(...payloads: AcceptedData[]): DeliveredInputView {
  return {
    directory: "/delivery/review",
    manifestPath: "/delivery/review/inputs.json",
    entries: payloads.map((payload, index) => ({
      from: "work-" + index,
      outcome: "done",
      attemptId: "work-" + index + "#1",
      payload,
      artifacts: [],
    })),
  };
}

describe("buildAttemptDeliveryPrompt", () => {
  it("separates the assigned task from the preceding section", () => {
    const prompt = buildAttemptDeliveryPrompt(REQUEST);

    expect("Previous section." + prompt).toStartWith(
      "Previous section.\n\n## Assigned task\n\nVerify the change.",
    );
  });

  it("hands over a short reported summary and points to the complete accepted data", () => {
    const summary = "Changed service names.\n" + "Long implementation claim. ".repeat(30);
    const view = viewOf({
      kind: "value",
      value: {
        summary,
        commands: [{ cmd: "typecheck", exit: 2, result: "diagnostic" }],
        limitations: ["The check did not pass."],
        evidence_refs: ["large-detail-that-stays-in-the-manifest"],
      },
    });

    const prompt = buildAttemptDeliveryPrompt(REQUEST, view);

    expect(prompt).toStartWith("\n\n## Assigned task\n\nVerify the change.\n\n---\n");
    expect(prompt).toContain("## Accepted upstream results");
    expect(prompt).toContain('Full results manifest: "/delivery/review/inputs.json"');
    expect(prompt).toContain('Producer: "work-0"; outcome: "done"; attempt: "work-0#1"');
    expect(prompt).toContain("Producer summary (excerpt):");
    expect(prompt).toContain("Changed service names. Long implementation claim.");
    expect(prompt).toContain("The producer reported limitations and failed checks.");
    expect(prompt).toContain("Full accepted data: inputs[0].payload.value in the manifest.");
    expect(prompt).toContain("Retained artifact files: none.");
    expect(prompt).not.toContain("large-detail-that-stays-in-the-manifest");
    expect(prompt).not.toContain(summary);
  });

  it("keeps absent, null, empty object and empty string distinct", () => {
    const prompt = buildAttemptDeliveryPrompt(
      REQUEST,
      viewOf(
        { kind: "absent" },
        { kind: "value", value: null },
        { kind: "value", value: {} },
        { kind: "value", value: "" },
      ),
    );

    expect(prompt).toContain("Accepted data: absent (the producer supplied no data).");
    expect(prompt).toContain("Full accepted data: inputs[0].payload in the manifest.");
    expect(prompt).toContain("Accepted data: null");
    expect(prompt).toContain("Accepted data: {}");
    expect(prompt).toContain('Accepted data: ""');
    expect(prompt).toContain("Full accepted data: inputs[3].payload.value in the manifest.");
  });

  it("points to a large result without a summary instead of dumping its JSON", () => {
    const prompt = buildAttemptDeliveryPrompt(
      REQUEST,
      viewOf({ kind: "value", value: { details: "full-report-detail".repeat(30) } }),
    );

    expect(prompt).not.toContain("full-report-detail");
    expect(prompt).toContain("Full accepted data: inputs[0].payload.value in the manifest.");
  });

  it("renders delivered artifact paths without repeating their content identities", () => {
    const view = viewOf({ kind: "value", value: { report: "A" } });
    const entry = view.entries[0];
    if (entry === undefined) throw new Error("missing input fixture");
    const withArtifact: DeliveredInputView = {
      ...view,
      entries: [{
        ...entry,
        artifacts: [{
          ref: "results/report.txt",
          artifactId: "sha256:content-id",
          digest: "content-id",
          size: 12,
          file: "report.txt",
          path: "/delivery/review/report with spaces.txt",
        }],
      }],
    };

    const prompt = buildAttemptDeliveryPrompt(REQUEST, withArtifact);

    expect(prompt).toContain('"results/report.txt" → "/delivery/review/report with spaces.txt"');
    expect(prompt).not.toContain("sha256:content-id");
  });
});
