#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = join(fileURLToPath(import.meta.url), "..");
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")) as { version: string };
const version = pkg.version;

const commands = ["install", "uninstall", "sync", "list", "search", "update", "registry"] as const;

function printHelp(): void {
  console.log(`rolebox v${version} — AI role manager for opencode

Usage: rolebox <command> [options]

Commands:
  install <role>[@version]    Install a role from a registry
  uninstall <role>            Remove an installed role
  sync <target>               Deploy roles to target tool (e.g. opencode)
  list                        Show installed roles
  search [query]              Search available roles in registries
  update [role]               Update installed roles to latest versions
  registry <sub>              Manage registries (add, remove, list)

Examples:
  rolebox install software-architect
  rolebox install my-registry:custom-role@2.0.0
  rolebox sync opencode
  rolebox search react
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    return;
  }

  if (args[0] === "--version" || args[0] === "-v") {
    console.log(version);
    return;
  }

  const command = args[0];

  if (!commands.includes(command as (typeof commands)[number])) {
    console.error(`Unknown command '${command}'. Run 'rolebox --help' for available commands.`);
    process.exit(1);
  }

  try {
    switch (command) {
      case "install": {
        const { install } = await import("./cli/commands/install");
        await install(args.slice(1));
        break;
      }
      case "uninstall": {
        const { uninstall } = await import("./cli/commands/uninstall");
        await uninstall(args.slice(1));
        break;
      }
      case "sync": {
        // Alias to avoid shadowing Bun.sync global
        const { sync: syncCmd } = await import("./cli/commands/sync");
        await syncCmd(args.slice(1));
        break;
      }
      case "list": {
        const { list } = await import("./cli/commands/list");
        list(args.slice(1));
        break;
      }
      case "search": {
        const { search } = await import("./cli/commands/search");
        await search(args.slice(1));
        break;
      }
      case "update": {
        const { update } = await import("./cli/commands/update");
        await update(args.slice(1));
        break;
      }
      case "registry": {
        const { registry } = await import("./cli/commands/registry");
        await registry(args.slice(1));
        break;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

main();
