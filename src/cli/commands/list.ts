import { defineCommand } from "citty";
import { loadLock } from "../config.ts";

/**
 * List installed roles from the lock file.
 */
export function list(json: boolean): void {
  const lock = loadLock();

  if (json) {
    console.log(JSON.stringify(lock.roles, null, 2));
    return;
  }

  if (lock.roles.length === 0) {
    console.log("No roles installed. Run `rolebox install <role>` to get started.");
    return;
  }

  console.log("Installed roles:");
  for (const entry of lock.roles) {
    const padded = entry.role.padEnd(22);
    console.log(`  ${padded} ${entry.version}  (${entry.registry})`);
  }
}

export default defineCommand({
  meta: {
    name: "list",
    description: "Show installed roles",
  },
  args: {
    json: {
      type: "boolean",
      description: "Output as JSON",
    },
  },
  run({ args }) {
    list(args.json ?? false);
  },
});
