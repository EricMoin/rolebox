import { randomUUID } from "node:crypto";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const evidenceFiles = new Set(["benchmark.sqlite", "benchmark.sqlite-wal", "benchmark.sqlite-shm", "run.json", "plan.json"]);

export async function writeBenchmarkReport(runDirectory: string, outputPath: string, content: string): Promise<string> {
  const directory = await realpath(resolve(runDirectory));
  const requested = resolve(outputPath);
  const output = join(await realpath(dirname(requested)), basename(requested));
  const location = relative(directory, output).toLowerCase();
  if (evidenceFiles.has(location) || location === "snapshot" || location.startsWith(`snapshot${sep}`)) {
    throw new Error("Report output must not overwrite benchmark evidence");
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
