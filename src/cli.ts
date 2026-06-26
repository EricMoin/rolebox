#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineCommand, runMain } from "citty";
import { checkForUpdate } from "./cli/version-check.ts";

const __dirname = join(fileURLToPath(import.meta.url), "..");
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")) as { version: string };
const version = pkg.version;

const main = defineCommand({
  meta: {
    name: "rolebox",
    version,
    description: "AI role manager for opencode",
  },
  subCommands: {
    init: () => import("./cli/commands/init.ts").then((m) => m.default),
    install: () => import("./cli/commands/install.ts").then((m) => m.default),
    uninstall: () => import("./cli/commands/uninstall.ts").then((m) => m.default),
    sync: () => import("./cli/commands/sync.ts").then((m) => m.default),
    list: () => import("./cli/commands/list.ts").then((m) => m.default),
    search: () => import("./cli/commands/search.ts").then((m) => m.default),
    update: () => import("./cli/commands/update.ts").then((m) => m.default),
    registry: () => import("./cli/commands/registry.ts").then((m) => m.default),
    status: () => import("./cli/commands/status.ts").then((m) => m.default),
    info: () => import("./cli/commands/info.ts").then((m) => m.default),
  },
  cleanup() {
    return checkForUpdate(version);
  },
});

runMain(main);
