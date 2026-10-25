import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { Readable } from "node:stream";

type ProcessOptions = {
  cmd?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: "pipe" | "inherit" | "ignore";
  stdout?: "pipe" | "inherit" | "ignore";
  stderr?: "pipe" | "inherit" | "ignore";
  timeout?: number;
};

function command(input: readonly string[] | ProcessOptions, options: ProcessOptions) {
  const settings = Array.isArray(input) ? options : input as ProcessOptions;
  const argv = [...(Array.isArray(input) ? input : settings.cmd ?? [])];
  if (!argv.length) throw new Error("A process command is required");
  if (argv[0] === process.execPath || argv[0] === "node") {
    argv[0] = process.execPath;
    argv.splice(1, 0, "--import", import.meta.resolve("tsx"));
    const evaluation = argv.indexOf("-e");
    if (evaluation >= 0 && /\b(?:import|await)\b/.test(argv[evaluation + 1] ?? "") && !argv.includes("--input-type=module")) {
      argv.splice(1, 0, "--input-type=module");
    }
  }
  return { argv, settings };
}

export function spawnProcess(input: readonly string[] | ProcessOptions, options: ProcessOptions = {}) {
  const { argv, settings } = command(input, options);
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: settings.cwd, env: { ...(settings.env ?? process.env), TSX_DISABLE_CACHE: "1" }, timeout: settings.timeout,
    stdio: [settings.stdin ?? "ignore", settings.stdout ?? "pipe", settings.stderr ?? "pipe"],
  });
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 1)));
  });
  return {
    pid: child.pid!, stdin: child.stdin!,
    stdout: child.stdout ? Readable.toWeb(child.stdout) as ReadableStream<Uint8Array> : new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
    stderr: child.stderr ? Readable.toWeb(child.stderr) as ReadableStream<Uint8Array> : new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
    exited,
    get exitCode() { return child.exitCode; },
    get signalCode() { return child.signalCode; },
    kill: (signal: NodeJS.Signals = "SIGTERM") => child.kill(signal),
    ref: () => child.ref(), unref: () => child.unref(),
  };
}

export type NodeSubprocess = ReturnType<typeof spawnProcess>;

export function spawnProcessSync(input: readonly string[] | ProcessOptions, options: ProcessOptions = {}) {
  const { argv, settings } = command(input, options);
  const child = spawnSync(argv[0]!, argv.slice(1), {
    cwd: settings.cwd, env: { ...(settings.env ?? process.env), TSX_DISABLE_CACHE: "1" }, timeout: settings.timeout,
    stdio: [settings.stdin ?? "ignore", settings.stdout ?? "pipe", settings.stderr ?? "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (child.error) throw child.error;
  return { exitCode: child.status ?? 1, stdout: child.stdout ?? Buffer.alloc(0), stderr: child.stderr ?? Buffer.alloc(0), success: child.status === 0 };
}

export async function readableToText(stream: ReadableStream): Promise<string> {
  return new Response(stream).text();
}

export function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function findExecutable(name: string): string | null {
  if (name === "node") return process.execPath;
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    for (const extension of extensions) {
      const path = join(directory, name + extension);
      try { accessSync(path, constants.X_OK); return path; } catch { }
    }
  }
  return null;
}
