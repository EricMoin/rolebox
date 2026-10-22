import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export async function scaffoldBenchmark(path: string): Promise<string> {
  const directory = resolve(path);
  const id = basename(directory);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id)) throw new Error("Benchmark directory needs a valid suite identifier");
  await mkdir(directory, { mode: 0o700 });
  await mkdir(join(directory, "role"), { mode: 0o700 });
  await writeFile(join(directory, "role", "role.yaml"), "name: Benchmark example\ndescription: A small role for verifying the evaluation workflow.\nprompt: Follow the user's output-format instructions exactly.\n", { flag: "wx" });
  await writeFile(join(directory, "suite.yaml"), `schemaVersion: 1\nid: ${id}\ntarget:\n  host: dsh\n  role: ./role\n  provider: example-provider\n  model: model-name\nhost:\n  plugins: []\n  env: []\ndataset: cases.jsonl\nrun:\n  repetitions: 1\n  concurrency: 1\n  timeoutMs: 120000\n`, { flag: "wx" });
  const cases = [
    { id: "literal", prompt: "Reply with exactly READY and no other text.", assertions: [{ kind: "equals", value: "READY" }] },
    { id: "arithmetic", prompt: "What is 2 + 3? Reply with only the digit.", assertions: [{ kind: "equals", value: "5" }] },
    { id: "format", prompt: "Write one sentence containing the word benchmark.", assertions: [{ kind: "contains", value: "benchmark" }] },
  ];
  await writeFile(join(directory, "cases.jsonl"), `${cases.map(value => JSON.stringify(value)).join("\n")}\n`, { flag: "wx" });
  await writeFile(join(directory, "README.md"), `# ${id}\n\nConfigure target.provider/model and host.plugins in suite.yaml for your installed dsh runtime before running. host.moduleRoot can point to the directory containing that runtime's package.json. Use one compatible dsh package installation.\n\nPass credentials through host.env and plugin config values of the form { $env: API_KEY }; never put credentials in suite.yaml. Provider plugins are explicitly trusted executable code.\n\nRun rolebox bench validate ., rolebox bench doctor ., then rolebox bench run . (from this directory). Results print their directory; rolebox bench report <run-directory> creates an offline HTML report.\n\nThis first version uses independent processes and temporary workspaces. It is for trusted local roles and plugins, and does not provide an OS security sandbox. Keep the role self-contained; global skills, symlinks and cross-role dependencies are not supported yet.\n`, { flag: "wx" });
  return directory;
}
