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

function main(): void {
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

  console.error(`'${command}' command is not yet implemented.`);
  process.exit(1);
}

main();
