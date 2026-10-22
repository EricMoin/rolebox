import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BenchmarkWorkerRequest } from "../types.ts";
import { executeDshBenchmark } from "./dsh.ts";

const [requestPath, resultPath] = process.argv.slice(2);
if (!requestPath || !resultPath) process.exit(2);
const request = JSON.parse(await readFile(requestPath, "utf8")) as BenchmarkWorkerRequest;
if (request.protocolVersion !== 1) process.exit(2);
process.chdir(request.workspace);
const result = await executeDshBenchmark(request);
await mkdir(dirname(resultPath), { recursive: true });
const temporary = `${resultPath}.${process.pid}.tmp`;
await writeFile(temporary, `${JSON.stringify(result)}\n`, { mode: 0o600 });
await rename(temporary, resultPath);
process.exit(result.terminationConfirmed ? 0 : 1);
