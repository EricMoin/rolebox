import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveFunctions } from "../src/function-resolver";

let tmpRoots: string[] = [];

afterEach(() => {
  for (const dir of tmpRoots) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpRoots = [];
});

function tmpDir(): string {
  const dir = mkdtempSync("/tmp/rolebox-test-");
  tmpRoots.push(dir);
  return dir;
}

const LOREM = `## Overview

This function performs a kernel-level operation.

### Behavior

- Detects conditions
- Observes lifecycle events
- Produces outputs`;

describe("resolveFunctions kernel fields", () => {
  it("propagates gate, observe, priority, and continue_until from frontmatter", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();
    const builtinDir = tmpDir();

    const frontmatter = `---
name: kernel-fn
description: Kernel function
priority: 10
gate:
  all:
    - user_approval
    - artifact_exists(plan)
observe:
  - on: tool_after
    tool: Read
    inject: "Observing Read calls"
continue_until:
  all:
    - plan_approved
    - tests_pass
---

${LOREM}`;

    const targetDir = join(roleDir, "functions");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "kernel-fn.md"), frontmatter);

    const result = await resolveFunctions(
      ["kernel-fn"],
      roleDir,
      globalDir,
      builtinDir,
    );

    expect(result).toHaveLength(1);

    expect(result[0].gate).toEqual({
      all: ["user_approval", "artifact_exists(plan)"],
    });

    expect(result[0].observe).toHaveLength(1);
    expect(result[0].observe![0].on).toBe("tool_after");
    expect(result[0].observe![0].tool).toBe("Read");
    expect(result[0].observe![0].inject).toBe("Observing Read calls");

    expect(result[0].priority).toBe(10);

    expect(result[0].continue_until).toEqual({
      all: ["plan_approved", "tests_pass"],
    });
  });

  it("propagates all other kernel fields (phase, requires, produces, consumes, etc.)", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();
    const builtinDir = tmpDir();

    const frontmatter = `---
name: full-kernel
description: Full kernel fields
phase: analysis
requires:
  - plan.md
produces: report
consumes: input-data
state_schema_version: 2
continue_max: 5
handlers: on_start
requires_evidence:
  - evidence_file.json
transitions:
  - when: complete
    activate:
      - next-phase
---

${LOREM}`;

    const targetDir = join(roleDir, "functions");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "full-kernel.md"), frontmatter);

    const result = await resolveFunctions(
      ["full-kernel"],
      roleDir,
      globalDir,
      builtinDir,
    );

    expect(result).toHaveLength(1);
    expect(result[0].phase).toBe("analysis");
    expect(result[0].requires).toEqual(["plan.md"]);
    expect(result[0].produces).toBe("report");
    expect(result[0].consumes).toBe("input-data");
    expect(result[0].state_schema_version).toBe(2);
    expect(result[0].continue_max).toBe(5);
    expect(result[0].handlers).toBe("on_start");
    expect(result[0].requires_evidence).toEqual(["evidence_file.json"]);
    expect(result[0].transitions).toHaveLength(1);
    expect(result[0].transitions![0]).toEqual({
      when: "complete",
      activate: ["next-phase"],
    });
  });

  it("defaults kernel fields to undefined when frontmatter omits them", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();
    const builtinDir = tmpDir();

    const frontmatter = `---
name: minimal-fn
---

${LOREM}`;

    const targetDir = join(roleDir, "functions");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "minimal-fn.md"), frontmatter);

    const result = await resolveFunctions(
      ["minimal-fn"],
      roleDir,
      globalDir,
      builtinDir,
    );

    expect(result).toHaveLength(1);
    expect(result[0].gate).toBeUndefined();
    expect(result[0].observe).toBeUndefined();
    expect(result[0].priority).toBeUndefined();
    expect(result[0].continue_until).toBeUndefined();
    expect(result[0].phase).toBeUndefined();
    expect(result[0].requires).toBeUndefined();
    expect(result[0].produces).toBeUndefined();
    expect(result[0].consumes).toBeUndefined();
    expect(result[0].state_schema_version).toBeUndefined();
    expect(result[0].continue_max).toBeUndefined();
    expect(result[0].handlers).toBeUndefined();
    expect(result[0].requires_evidence).toBeUndefined();
    expect(result[0].transitions).toBeUndefined();
  });
});
