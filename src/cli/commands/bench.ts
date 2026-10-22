import { defineCommand } from "citty";
import { join, resolve } from "node:path";
import { getDataDir } from "../paths.ts";
import { loadBenchmarkSuite } from "../../benchmark/spec.ts";
import { scaffoldBenchmark } from "../../benchmark/scaffold.ts";
import { snapshotBenchmarkRole } from "../../benchmark/snapshot.ts";
import { doctorDshRuntime } from "../../benchmark/hosts/dsh.ts";
import { runBenchmark } from "../../benchmark/runner.ts";
import { watchBenchmark } from "../../benchmark/watch.ts";
import { readBenchmarkRun } from "../../benchmark/store.ts";
import { renderBenchmarkHtml, summarizeBenchmarkRun } from "../../benchmark/report.ts";
import { writeBenchmarkReport } from "../../benchmark/report-output.ts";

const suiteArg = { type: "positional" as const, required: true, description: "Suite directory or suite.yaml" };

export default defineCommand({
  meta: { name: "bench", description: "Run trusted local role benchmarks on dsh" },
  subCommands: {
    init: defineCommand({
      meta: { name: "init", description: "Create a benchmark starter directory" },
      args: { directory: { ...suiteArg, description: "New benchmark directory" } },
      async run({ args }) { console.log(`Created benchmark: ${await scaffoldBenchmark(args.directory!)}`); },
    }),
    validate: defineCommand({
      meta: { name: "validate", description: "Check suite, cases and self-contained role assets without executing plugins" },
      args: { suite: suiteArg },
      async run({ args }) {
        const loaded = await loadBenchmarkSuite(args.suite!);
        const snapshot = await snapshotBenchmarkRole(loaded.roleDirectory);
        console.log(JSON.stringify({ valid: true, suite: loaded.suite.id, cases: loaded.cases.length, trials: loaded.cases.length * loaded.suite.run.repetitions, roleDigest: snapshot.digest }, null, 2));
      },
    }),
    doctor: defineCommand({
      meta: { name: "doctor", description: "Check installed dsh modules without starting a model request" },
      args: { suite: suiteArg },
      async run({ args }) {
        const loaded = await loadBenchmarkSuite(args.suite!);
        await snapshotBenchmarkRole(loaded.roleDirectory);
        const result = doctorDshRuntime(loaded.suite.host.moduleRoot);
        console.log(JSON.stringify({ ...result, pluginsConfigured: loaded.suite.host.plugins.length > 0, liveExecutionVerified: false }, null, 2));
        if (!result.available || loaded.suite.host.plugins.length === 0) process.exitCode = 2;
      },
    }),
    run: defineCommand({
      meta: { name: "run", description: "Execute the suite in fresh dsh worker processes" },
      args: { suite: suiteArg, output: { type: "string", description: "Parent directory for results" } },
      async run({ args }) {
        const loaded = await loadBenchmarkSuite(args.suite!);
        const host = doctorDshRuntime(loaded.suite.host.moduleRoot);
        if (!host.available) throw new Error(host.diagnostic ?? "dsh runtime is unavailable");
        if (loaded.suite.host.plugins.length === 0) throw new Error("Configure host.plugins with an LLM provider before running");
        const controller = new AbortController();
        const cancel = (): void => controller.abort();
        process.on("SIGINT", cancel);
        process.on("SIGTERM", cancel);
        try {
          const result = await runBenchmark(loaded, {
            outputDirectory: args.output ?? join(getDataDir(), "benchmarks"), signal: controller.signal,
            onTrial: trial => console.log(`${trial.caseId} #${trial.repetition + 1}: ${trial.result.status} / ${trial.grade.verdict}`),
          });
          console.log(JSON.stringify({ directory: result.directory, ...summarizeBenchmarkRun(result.record) }, null, 2));
          process.exitCode = controller.signal.aborted ? 130 : result.record.status !== "completed" ? 2 : result.record.trials.some(trial => trial.grade.verdict === "fail") ? 1 : 0;
        } finally {
          process.off("SIGINT", cancel);
          process.off("SIGTERM", cancel);
        }
      },
    }),
    watch: defineCommand({
      meta: { name: "watch", description: "Re-run the benchmark when role assets or suite inputs change" },
      args: { suite: suiteArg, output: { type: "string", description: "Parent directory for results" } },
      async run({ args }) {
        const controller = new AbortController();
        const cancel = (): void => controller.abort();
        process.on("SIGINT", cancel);
        process.on("SIGTERM", cancel);
        console.log("Watching benchmark inputs; press Ctrl+C to stop.");
        try {
          await watchBenchmark(args.suite!, {
            outputDirectory: args.output ?? join(getDataDir(), "benchmarks"), signal: controller.signal,
            onTrial: trial => console.log(`${trial.caseId} #${trial.repetition + 1}: ${trial.result.status} / ${trial.grade.verdict}`),
            onRun: result => console.log(JSON.stringify({ directory: result.directory, current: result.current, ...summarizeBenchmarkRun(result.record) }, null, 2)),
            onDiagnostic: message => console.error(message),
          });
          if (controller.signal.aborted) process.exitCode = 130;
        } finally {
          process.off("SIGINT", cancel);
          process.off("SIGTERM", cancel);
        }
      },
    }),
    report: defineCommand({
      meta: { name: "report", description: "Read a saved run and render an offline report" },
      args: { directory: { ...suiteArg, description: "Saved run directory" }, format: { type: "enum", options: ["html", "json"], default: "html" }, output: { type: "string", description: "Report destination" } },
      async run({ args }) {
        const directory = resolve(args.directory!);
        const record = readBenchmarkRun(directory);
        const body = args.format === "json" ? JSON.stringify({ run: record, summary: summarizeBenchmarkRun(record) }, null, 2) : renderBenchmarkHtml(record);
        const output = args.output ? resolve(args.output) : join(directory, args.format === "json" ? "report.json" : "report.html");
        console.log(`Report: ${await writeBenchmarkReport(directory, output, body)}`);
      },
    }),
  },
});
