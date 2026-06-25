#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkForUpdate } from "./cli/version-check.js";

const __dirname = join(fileURLToPath(import.meta.url), "..");
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")) as { version: string };
const version = pkg.version;

const commands = ["init", "install", "uninstall", "sync", "list", "search", "update", "registry", "status", "info"] as const;

function printHelp(): void {
  console.log(`rolebox v${version} — AI role manager for opencode

Usage: rolebox <command> [options]

Commands:
  init [name] [--yes] [--template <type>]  Scaffold a new role interactively
  install <role>[@version]    Install a role from a registry
  uninstall <role>            Remove an installed role
  sync <target>               Deploy roles to target tool (e.g. opencode)
  list                        Show installed roles
  search [query]              Search available roles in registries
  update [role]               Update installed roles to latest versions
  registry <sub>              Manage registries (add, remove, list)
  status [-u]                 Show overall health and opencode integration
  info <role> [--check]       Show detailed info for an installed role

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
      case "init": {
        const { init } = await import("./cli/commands/init.js");
        await init(args.slice(1));
        break;
      }
      case "install": {
        const { install } = await import("./cli/commands/install.js");
        await install(args.slice(1));
        break;
      }
      case "uninstall": {
        const { uninstall } = await import("./cli/commands/uninstall.js");
        await uninstall(args.slice(1));
        break;
      }
      case "sync": {
        // Alias to avoid shadowing Bun.sync global
        const { sync: syncCmd } = await import("./cli/commands/sync.js");
        await syncCmd(args.slice(1));
        break;
      }
      case "list": {
        const { list } = await import("./cli/commands/list.js");
        list(args.slice(1));
        break;
      }
      case "search": {
        const { search } = await import("./cli/commands/search.js");
        await search(args.slice(1));
        break;
      }
      case "update": {
        const { update } = await import("./cli/commands/update.js");
        await update(args.slice(1));
        break;
      }
      case "registry": {
        const { registry } = await import("./cli/commands/registry.js");
        await registry(args.slice(1));
        break;
      }
      case "status": {
        const { status } = await import("./cli/commands/status.js");
        await status(args.slice(1));
        break;
      }
      case "info": {
        const { info } = await import("./cli/commands/info.js");
        await info(args.slice(1));
        break;
      }
    }
    await checkForUpdate(version);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

main();
