import { z } from "zod";
import { defineTool } from "../../platform/ports/tool-factory.ts";
import { GRAPH_WAIT_TIMEOUT_MS, type GraphWait } from "../application/graph-wait.ts";

export function createGraphWaitTool(waiter: GraphWait) {
  return defineTool({
    description:
      "Wait for a graph declared by this session to complete, stop, or need attention. " +
      "Call after graph_declare instead of repeatedly polling graph_status. Returns the selected " +
      "run's status and committed graph snapshot, including accepted output by default. " +
      "Pins the current run when run_id is omitted. timeout_ms defaults to 540000 (maximum 540000); " +
      "on timeout call graph_wait again with the returned run_id. Cancelling this call only stops " +
      "waiting; use graph_control to cancel graph execution. Does not start work or wake an ended chat turn.",
    args: {
      graph_id: z.string().min(1).describe("Graph declared by the invoking session."),
      run_id: z.string().min(1).optional().describe("Run to wait for; defaults to the current run at invocation."),
      timeout_ms: z.number().int().min(1).max(GRAPH_WAIT_TIMEOUT_MS).optional().describe("Wait duration in milliseconds; default and maximum 540000."),
      include_output: z.boolean().optional().describe("Include accepted outcome data in the returned snapshot; default true."),
    },
    async execute(args, context) {
      return JSON.stringify(await waiter.wait(args, context.sessionID, context.abort), null, 2);
    },
  });
}
