import { chmodSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// tsc writes dist/cli/main.js with the process umask (0644), but package.json
// publishes that exact file as the `rolebox` bin. Without the execute bit, execve
// fails with EACCES and the linked command dies with "Permission denied"; dist/ is
// gitignored, so npm's bin-linking cannot restore the mode after a rebuild. It is
// restored here, directly after tsc and before anything else reads dist/.

// Project root = scripts/.. (this script lives in scripts/)
const projectRoot = import.meta.dir ? resolve(import.meta.dir, "..") : process.cwd();
const entry = resolve(projectRoot, "dist", "cli", "main.js");

if (!existsSync(entry)) {
  console.error("build:bin-executable — refused: dist/cli/main.js is missing; run `tsc` first");
  process.exit(1);
}

// Windows carries no executability bit, so the chmod is a no-op there.
if (process.platform !== "win32") {
  chmodSync(entry, 0o755);
}

console.log("build:bin-executable — dist/cli/main.js is executable");
process.exit(0);
