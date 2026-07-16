#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineCommand, runMain } from "citty";
import { checkForUpdate } from "./version-check.ts";

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
    init: () => import("./commands/init.ts").then((m) => m.default),
    install: () => import("./commands/install.ts").then((m) => m.default),
    uninstall: () => import("./commands/uninstall.ts").then((m) => m.default),
    sync: () => import("./commands/sync.ts").then((m) => m.default),
    list: () => import("./commands/list.ts").then((m) => m.default),
    search: () => import("./commands/search.ts").then((m) => m.default),
    update: () => import("./commands/update.ts").then((m) => m.default),
    registry: () => import("./commands/registry.ts").then((m) => m.default),
    status: () => import("./commands/status.ts").then((m) => m.default),
    info: () => import("./commands/info.ts").then((m) => m.default),
    config: () => import("./commands/config.ts").then((m) => m.default),
    monitor: () => import("./commands/monitor.ts").then((m) => m.default),
    memory: () => import("./commands/memory.ts").then((m) => m.default),
    checkpoint: () => import("./commands/checkpoint.ts").then((m) => m.default),
  },
  cleanup() {
    return checkForUpdate(version);
  },
});

runMain(main);
