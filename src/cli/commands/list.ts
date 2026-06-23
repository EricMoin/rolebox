import { loadLock } from "../config";

/**
 * List installed roles from the lock file.
 *
 * Parses args for --json flag.
 * If no roles installed, prints helpful message.
 * Otherwise displays a formatted table.
 */
export function list(args: string[]): void {
  const lock = loadLock();

  // Check for --json flag first (should always output JSON, even if empty)
  if (args.includes("--json")) {
    console.log(JSON.stringify(lock.roles, null, 2));
    return;
  }

  if (lock.roles.length === 0) {
    console.log("No roles installed. Run `rolebox install <role>` to get started.");
    return;
  }

  console.log("Installed roles:");
  for (const entry of lock.roles) {
    // Pad role name to 22 chars for alignment
    const padded = entry.role.padEnd(22);
    console.log(`  ${padded} ${entry.version}  (${entry.registry})`);
  }
}
