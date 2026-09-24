import { existsSync, writeFileSync } from "node:fs";
import { GraphStore } from "../../../src/graph/store/graph-store.ts";

const [directory, attemptId, barrier] = process.argv.slice(2);
if (!directory || !attemptId) throw new Error("missing fixture arguments");
const store = GraphStore.openFile(directory);
try {
  if (barrier) {
    writeFileSync(`${barrier}.${attemptId}`, "ready");
    const deadline = Date.now() + 5000;
    while (!existsSync(barrier)) {
      if (Date.now() > deadline) throw new Error("barrier timed out");
      await Bun.sleep(5);
    }
  }
  const result = store.budget.reserveDispatch({
    graphId: "bounded", runId: "run", nodeId: attemptId.split("#")[0]!,
    attemptId, effectId: `dispatch:${attemptId}`, limits: {}, maxExecutions: 1, at: 1,
  });
  console.log(JSON.stringify({ kind: result.kind, attempts: store.budget.reservationsOf("bounded").map((r) => r.attemptId) }));
} finally { store.close(); }
