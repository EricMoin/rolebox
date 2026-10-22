import { defineCommand } from "citty";
import { join, resolve } from "node:path";
import { BenchmarkBaselineStore, type BenchmarkBaseline } from "../../benchmark/baseline.ts";
import { summarizeBenchmarkRun } from "../../benchmark/report.ts";
import { readBenchmarkRun } from "../../benchmark/store.ts";
import { getDataDir } from "../paths.ts";

const nameArg = { type: "positional" as const, required: true, description: "Baseline name (letters, digits, underscores or hyphens)" };

export function benchmarkBaselineDirectory(): string {
  return join(getDataDir(), "benchmarks", "baselines");
}

function withStore<T>(action: (store: BenchmarkBaselineStore) => T): T {
  const store = new BenchmarkBaselineStore(benchmarkBaselineDirectory());
  try { return action(store); }
  finally { store.close(); }
}

export function readNamedBenchmarkBaseline(name: string): BenchmarkBaseline {
  return withStore(store => store.get(name));
}

function describe(baseline: BenchmarkBaseline): object {
  const { record, ...info } = baseline;
  return { ...info, summary: summarizeBenchmarkRun(record) };
}

export default defineCommand({
  meta: { name: "baseline", description: "Save immutable benchmark results under explicit baseline names" },
  subCommands: {
    set: defineCommand({
      meta: { name: "set", description: "Capture a complete run; preserve previous revisions when moving a name" },
      args: { name: nameArg, directory: { type: "positional", required: true, description: "Saved run directory" } },
      run({ args }) {
        const record = readBenchmarkRun(resolve(args.directory!));
        console.log(JSON.stringify(describe(withStore(store => store.set(args.name!, record))), null, 2));
      },
    }),
    show: defineCommand({
      meta: { name: "show", description: "Show the captured baseline and its result summary" },
      args: { name: nameArg },
      run({ args }) { console.log(JSON.stringify(describe(readNamedBenchmarkBaseline(args.name!)), null, 2)); },
    }),
    list: defineCommand({
      meta: { name: "list", description: "List the latest revision of each baseline" },
      run() { console.log(JSON.stringify(withStore(store => store.list()), null, 2)); },
    }),
    history: defineCommand({
      meta: { name: "history", description: "List saved revisions of a baseline" },
      args: { name: nameArg },
      run({ args }) { console.log(JSON.stringify(withStore(store => store.history(args.name!)), null, 2)); },
    }),
  },
});
