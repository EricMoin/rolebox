import { setTimeout as sleep } from "node:timers/promises";
import { installBrokenPipeGuard } from "../../../src/cli/stdio-guard.ts";

const mode = process.argv[2] ?? "stream";

installBrokenPipeGuard();

process.stdout.write("READY\n");

if (mode === "rejection") {
  await sleep(50);
  void Promise.reject(
    Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE" }),
  );
  await sleep(5_000);
  process.exit(0);
}

const deadline = Date.now() + 5_000;
while (Date.now() < deadline) {
  process.stdout.write("tick\n");
  await sleep(10);
}

process.exit(0);
