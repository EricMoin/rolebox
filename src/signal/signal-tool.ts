import { defineTool } from "../platform/ports/tool-factory.ts";
import { z } from "zod";

export function createSignalTool() {
  return defineTool({
    description:
      "Emit an out-of-band control signal. Use this to indicate state transitions " +
      "(completion, approval requests, handoffs, etc.) without embedding signals in text content. " +
      "The 'type' determines what state transition occurs; 'payload' carries optional structured data " +
      "for the signal consumer.",
    args: {
      type: z.enum([
        "answer",
        "need_approval",
        "blocked",
        "need_clarification",
        "handoff",
        "progress",
        "revise_needed",
        "escalate",
      ]),
      payload: z.record(z.string(), z.unknown()).optional(),
    },
    async execute(input) {
      return `signal: ${input.type} acknowledged`;
    },
  });
}
