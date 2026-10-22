import { randomUUID } from "node:crypto";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const evidenceFiles = new Set(["benchmark.sqlite", "benchmark.sqlite-wal", "benchmark.sqlite-shm", "run.json", "plan.json"]);

export async function writeBenchmarkReport(runDirectories: string | readonly string[], outputPath: string, content: string, protectedDirectories: readonly string[] = []): Promise<string> {
  const requested = resolve(outputPath);
  const output = join(await realpath(dirname(requested)), basename(requested));
  for (const runDirectory of typeof runDirectories === "string" ? [runDirectories] : runDirectories) {
    const directory = await realpath(resolve(runDirectory));
    const location = relative(directory, output).toLowerCase();
    if (evidenceFiles.has(location) || ["snapshot", "fixtures", "artifacts"].some(name => location === name || location.startsWith(`${name}${sep}`))) {
      throw new Error("Report output must not overwrite benchmark evidence");
    }
  }
  for (const protectedDirectory of protectedDirectories) {
    let directory: string;
    try { directory = await realpath(resolve(protectedDirectory)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const location = relative(directory.toLowerCase(), output.toLowerCase());
    if (location === "" || (location !== ".." && !location.startsWith(`..${sep}`) && !isAbsolute(location))) {
      throw new Error("Report output must not overwrite the benchmark baseline catalog");
    }
  }
  try {
    if ((await lstat(output)).isSymbolicLink()) throw new Error("Report output must not be a symbolic link");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temporary = join(dirname(output), `.benchmark-report-${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(content);
    } finally {
      await file.close();
    }
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
  return output;
}
