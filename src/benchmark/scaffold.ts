import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { BenchmarkCase } from "./types.ts";

export async function scaffoldBenchmark(path: string, template: "response" | "code-fix" = "response"): Promise<string> {
  if (template !== "response" && template !== "code-fix") throw new Error("Unknown benchmark template");
  const directory = resolve(path);
  const id = basename(directory);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id)) throw new Error("Benchmark directory needs a valid suite identifier");
  await mkdir(directory, { mode: 0o700 });
  await mkdir(join(directory, "role"), { mode: 0o700 });
  const role = template === "code-fix"
    ? "name: Code fix benchmark\ndescription: A role for measuring repairs to working files.\nprompt: Inspect the task and workspace files, then use the available filesystem tools to make the requested correction. Change the actual files in the workspace; a proposed patch or explanation alone does not complete the task. Keep the change focused and preserve the module's public interface.\n"
    : "name: Benchmark example\ndescription: A small role for verifying the evaluation workflow.\nprompt: Follow the user's output-format instructions exactly.\n";
  await writeFile(join(directory, "role", "role.yaml"), role, { flag: "wx" });
  await writeFile(join(directory, "suite.yaml"), `schemaVersion: 1\nid: ${id}\ntarget:\n  host: dsh\n  role: ./role\n  provider: example-provider\n  model: model-name\nhost:\n  plugins: []\n  env: []\ndataset: cases.jsonl\nrun:\n  repetitions: 1\n  concurrency: 1\n  timeoutMs: 120000\n`, { flag: "wx" });
  const cases: BenchmarkCase[] = template === "code-fix" ? [
    {
      id: "sum-empty",
      prompt: "Fix src/sum.mjs in the current workspace. Its named sum(values) export must return the sum of an array of finite numbers, return 0 for an empty array, handle negative and fractional numbers, and leave the input unchanged. Inspect and edit the actual source file using tools; do not only describe the fix.",
      workspace: { fixture: "./fixtures/sum", checks: "./checks/sum" },
      assertions: [
        { kind: "file_exists", path: "src/sum.mjs" },
        { kind: "command", argv: ["node", "{checks}/check.mjs", "{workspace}"], timeoutMs: 10_000, expectedExitCode: 0 },
      ],
    },
  ] : [
    { id: "literal", prompt: "Reply with exactly READY and no other text.", assertions: [{ kind: "equals", value: "READY" }] },
    { id: "arithmetic", prompt: "What is 2 + 3? Reply with only the digit.", assertions: [{ kind: "equals", value: "5" }] },
    { id: "format", prompt: "Write one sentence containing the word benchmark.", assertions: [{ kind: "contains", value: "benchmark" }] },
  ];
  if (template === "code-fix") {
    await mkdir(join(directory, "fixtures", "sum", "src"), { recursive: true, mode: 0o700 });
    await mkdir(join(directory, "checks", "sum"), { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "fixtures", "sum", "src", "sum.mjs"), "export function sum(values) {\n  return values.reduce((total, value) => total + value);\n}\n", { flag: "wx" });
    await writeFile(join(directory, "checks", "sum", "check.mjs"), `import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const workspace = process.argv[2];
assert.ok(workspace, "Pass the workspace directory as the first argument");
const { sum } = await import(pathToFileURL(resolve(workspace, "src/sum.mjs")).href);
assert.equal(sum([2, 3]), 5);
assert.equal(sum([]), 0);
assert.equal(sum([-4, 1]), -3);
assert.equal(sum([0.25, 0.5]), 0.75);
assert.equal(sum(Object.freeze([1, 2, 3])), 6);
console.log("All sum checks passed");
`, { flag: "wx" });
  }
  await writeFile(join(directory, "cases.jsonl"), `${cases.map(value => JSON.stringify(value)).join("\n")}\n`, { flag: "wx" });
  const instructions = template === "code-fix"
    ? "\nThe fixture contains a real empty-array bug in fixtures/sum/src/sum.mjs. Each trial edits a fresh frozen copy of this source. checks/sum/check.mjs stays outside the model workspace, and the runner evaluates it against the captured result after the model stops. Checks cover ordinary, empty, negative, fractional, and immutable inputs.\n\nTo verify the benchmark itself without a model, run node checks/sum/check.mjs fixtures/sum: the starter must fail on the empty input. On a temporary copy, add an initial 0 argument to reduce; the checks must then pass. Keep the original fixture defective for benchmark runs.\n\nThe command grader executes trusted local code, including code produced by the role, with your operating-system permissions. Checks outside the workspace are not a security boundary or a guarantee of hidden answers. Results retain file changes and command output; use fixtures without secrets.\n"
    : "";
  await writeFile(join(directory, "README.md"), `# ${id}\n\nConfigure target.provider/model and host.plugins in suite.yaml for your installed dsh runtime before running. host.moduleRoot can point to the directory containing that runtime's package.json. Use one compatible dsh package installation.\n\nPass credentials through host.env and plugin config values of the form { $env: API_KEY }; never put credentials in suite.yaml. Provider plugins are explicitly trusted executable code.\n\nRun rolebox bench validate ., rolebox bench doctor ., then rolebox bench run . (from this directory). Results print their directory; rolebox bench report <run-directory> creates an offline HTML report.\n${instructions}\nThis version uses independent processes and temporary workspaces. It is for trusted local roles, plugins, fixtures, and checks, and does not provide an OS security sandbox. Keep the role self-contained; global skills, symlinks and cross-role dependencies are not supported yet.\n`, { flag: "wx" });
  return directory;
}
