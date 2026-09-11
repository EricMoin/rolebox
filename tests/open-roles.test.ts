/**
 * Tests for the open-role registry collector (src/resolver/open-roles.ts).
 *
 * Covers:
 *   1. Only roles with `open: true` are collected, keyed by roleId.
 *   2. `exports` entries resolve to full `roleId--slug` subagent ids.
 *   3. Unknown export names warn (without throwing) and are skipped.
 *   4. Open roles without `exports` yield an empty export list.
 *   5. Nested subagents resolve to their full hierarchical ids.
 */

import { describe, it, expect } from "bun:test";
import { collectOpenRoles, __setLoggerForTest } from "../src/resolver/open-roles";
import type { RoleConfig, ResolvedRole, ResolvedSubAgent } from "../src/types";

const capturedWarns: unknown[][] = [];

// Inject a mock logger — tslog "hidden" mode doesn't use console.warn,
// so we replace the module-level logger via the test hook.
__setLoggerForTest({
  warn: (...args: unknown[]) => { capturedWarns.push(args); },
  debug: () => {},
  error: () => {},
  info: () => {},
  silly: () => {},
  trace: () => {},
  fatal: () => {},
  getSubLogger: () => ({}),
  attachTransport: () => {},
} as any);

function makeSubagent(
  name: string,
  id: string,
  subagents: ResolvedSubAgent[] = [],
): ResolvedSubAgent {
  return {
    id,
    config: {
      name,
      description: `${name} description`,
      prompt: `You are ${name}.`,
      subagents: subagents.map((s) => s.config),
    },
    prompt: `You are ${name}.`,
    skills: [],
    functions: [],
    references: [],
    subagents,
    parentId: id.split("--").slice(0, -1).join("--"),
    inheritedFrom: {},
  };
}

function makeRole(
  id: string,
  opts: {
    name?: string;
    description?: string;
    open?: boolean;
    exports?: string[];
    subagents?: ResolvedSubAgent[];
  } = {},
): ResolvedRole {
  const config: RoleConfig = {
    name: opts.name ?? `Role ${id}`,
    description: opts.description ?? `Description of ${id}`,
    prompt: `You are ${id}.`,
    subagents: opts.subagents?.map((s) => s.config) ?? [],
  };
  if (opts.open !== undefined) config.open = opts.open;
  if (opts.exports !== undefined) config.exports = opts.exports;
  return {
    id,
    config,
    prompt: config.prompt,
    skills: [],
    functions: [],
    references: [],
    subagents: opts.subagents ?? [],
  };
}

describe("collectOpenRoles", () => {
  it("returns only roles with open: true, keyed by roleId", () => {
    const roles = [
      makeRole("open-role", {
        name: "Open Role",
        description: "Exposes a subagent",
        open: true,
        exports: ["helper"],
        subagents: [makeSubagent("helper", "open-role--helper")],
      }),
      makeRole("closed-role", { exports: ["helper"] }), // open absent
      makeRole("explicit-closed", { open: false }),
    ];

    const registry = collectOpenRoles(roles);

    expect(registry.size).toBe(1);
    const entry = registry.get("open-role")!;
    expect(entry.roleId).toBe("open-role");
    expect(entry.name).toBe("Open Role");
    expect(entry.description).toBe("Exposes a subagent");
    expect(registry.has("closed-role")).toBe(false);
    expect(registry.has("explicit-closed")).toBe(false);
  });

  it("maps exports entries to full roleId--slug subagent ids", () => {
    const roles = [
      makeRole("producer", {
        open: true,
        exports: ["helper", "Graph Worker"],
        subagents: [
          makeSubagent("helper", "producer--helper"),
          makeSubagent("Graph Worker", "producer--graph-worker"),
          makeSubagent("private", "producer--private"),
        ],
      }),
    ];

    const registry = collectOpenRoles(roles);

    // Slug-form ("helper") and name-form ("Graph Worker") both resolve;
    // the un-exported subagent is excluded.
    expect(registry.get("producer")!.exports).toEqual([
      "producer--helper",
      "producer--graph-worker",
    ]);
  });

  it("warns (without throwing) on unknown export names", () => {
    capturedWarns.length = 0;
    const roles = [
      makeRole("producer", {
        open: true,
        exports: ["helper", "missing-agent"],
        subagents: [makeSubagent("helper", "producer--helper")],
      }),
    ];

    let registry: Map<string, { exports: string[] }> | undefined;
    expect(() => {
      registry = collectOpenRoles(roles);
    }).not.toThrow();

    // Known export still resolves; unknown one is skipped.
    expect(registry!.get("producer")!.exports).toEqual(["producer--helper"]);
    const warnMessages = capturedWarns.flatMap((args) => args.map(String));
    expect(warnMessages.some((m) => m.includes("missing-agent"))).toBe(true);
    expect(
      warnMessages.some((m) => m.includes("producer")),
    ).toBe(true);
  });

  it("includes open roles without exports as empty export lists", () => {
    const registry = collectOpenRoles([makeRole("solo", { open: true })]);

    expect(registry.get("solo")).toEqual({
      roleId: "solo",
      name: "Role solo",
      description: "Description of solo",
      exports: [],
    });
  });

  it("resolves exports against nested subagents using their full ids", () => {
    const roles = [
      makeRole("emperor", {
        open: true,
        exports: ["chancellor", "drafter"],
        subagents: [
          makeSubagent("chancellor", "emperor--chancellor", [
            makeSubagent("drafter", "emperor--chancellor--drafter"),
          ]),
        ],
      }),
    ];

    const registry = collectOpenRoles(roles);

    expect(registry.get("emperor")!.exports).toEqual([
      "emperor--chancellor",
      "emperor--chancellor--drafter",
    ]);
  });
});
