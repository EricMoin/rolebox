import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { graphWorkerSandbox } from "./graph-worker.ts";

export async function executeGraphWorkerCommand(options: {
  command: string;
  workspace: string;
  dataDirectory: string;
  inputPaths: readonly string[];
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ exitCode: number | null; output: string }> {
  const scratch = mkdtempSync(join(tmpdir(), "graph-worker-command-"));
  try {
    const wrapped = graphWorkerSandbox({ executable: "/bin/sh", args: ["-c", options.command],
      workspace: options.workspace, dataDirectory: options.dataDirectory,
      workspaceReadsOnly: true, scratchDirectory: scratch, inputPaths: options.inputPaths });
    return await new Promise((resolve, reject) => {
      const child = spawn(wrapped.executable, wrapped.args, { cwd: options.workspace, detached: true,
        env: { PATH: process.env.PATH, LANG: "C.UTF-8", TMPDIR: scratch }, stdio: ["ignore", "pipe", "pipe"] });
      const buffers: Buffer[] = [];
      let bytes = 0;
      let terminated = false;
      const stop = () => {
        terminated = true;
        if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
      };
      const onData = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { stop(); return; }
        buffers.push(chunk);
      };
      child.stdout.on("data", onData); child.stderr.on("data", onData);
      const timer = setTimeout(stop, options.timeoutMs ?? 60_000);
      options.signal?.addEventListener("abort", stop, { once: true });
      if (options.signal?.aborted) stop();
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", stop); };
      child.on("error", error => { cleanup(); reject(error); });
      child.on("close", code => {
        cleanup();
        resolve({ exitCode: code, output: Buffer.concat(buffers).toString("utf8") + (terminated ? "\nCommand stopped by cancellation, timeout or output limit." : "") });
      });
    });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
