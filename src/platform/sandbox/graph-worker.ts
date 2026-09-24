import { realpathSync, existsSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";

function canonical(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  return parent === absolute ? absolute : join(canonical(parent), basename(absolute));
}

/** Seatbelt applies to the worker and every subprocess, including its shell tools. */
export function graphWorkerSandbox(options: {
  executable: string;
  args: readonly string[];
  workspace: string;
  dataDirectory: string;
  sessionFile?: string;
  routeFile?: string;
  workspaceReadsOnly?: boolean;
  scratchDirectory?: string;
  agentDirectory?: string;
  inputPaths?: readonly string[];
}): { executable: string; args: string[] } {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) {
    throw new Error("Graph workers require an installed OS sandbox; this platform has no configured adapter");
  }
  const quoted = (path: string) => JSON.stringify(canonical(path));
  const privatePaths = [options.dataDirectory, join(options.workspace, ".rolebox"), join(options.workspace, ".dsh")];
  if (options.agentDirectory) privatePaths.push(join(options.agentDirectory, "sessions"));
  const readExceptions = [...(options.inputPaths ?? []).map(path => `(require-not (subpath ${quoted(path)}))`), ...(options.routeFile ? [`(require-not (literal ${quoted(options.routeFile)}))`] : [])].join(" ");
  const ownSession = options.sessionFile ? `(require-not (literal ${quoted(options.sessionFile)}))` : "";
  const filters = privatePaths.map(path => `(require-all (subpath ${quoted(path)}) ${ownSession})`).join(" ");
  const protectedConfig = [join(options.workspace, ".pi"), ...(options.agentDirectory ? [options.agentDirectory] : [])];
  const profile = [
    "(version 1)", "(allow default)",
    `(deny file-write* ${filters})`,
    `(deny file-read-data ${privatePaths.map(path => `(require-all (subpath ${quoted(path)}) ${ownSession} ${readExceptions})`).join(" ")})`,
    `(deny file-write* ${protectedConfig.map(path => `(require-all (subpath ${quoted(path)}) (require-not (subpath ${quoted(join(path, "auth.json.lock"))})))`).join(" ")})`,
    "(deny process-info*)", "(allow process-info* (target self))",
  ];
  if (options.workspaceReadsOnly) {
    const roots = [options.workspace, "/bin", "/sbin", "/usr", "/System", "/Library", "/opt", "/dev", "/private/etc", "/private/var/db", dirname(process.execPath), ...(options.scratchDirectory ? [options.scratchDirectory] : []), ...(options.inputPaths ?? [])];
    const writable = [options.workspace, "/dev", ...(options.scratchDirectory ? [options.scratchDirectory] : [])];
    profile.push(`(deny file-write* (require-all ${writable.map(path => `(require-not (subpath ${quoted(path)}))`).join(" ")}))`);
    profile.push(`(deny file-read-data (require-all ${roots.map(path => `(require-not (subpath ${quoted(path)}))`).join(" ")}))`);
  }
  profile.push("(allow file-read-data (vnode-type DIRECTORY))");
  return { executable: "/usr/bin/sandbox-exec", args: ["-p", profile.join("\n"), options.executable, ...options.args] };
}
