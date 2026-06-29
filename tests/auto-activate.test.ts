import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverRoles, __setLoggerForTest } from "../src/role-loader";
import { functionSessionState } from "../src/session-state";

// ---------------------------------------------------------------------------
// Mock logger (same pattern as role-loader.test.ts)
// ---------------------------------------------------------------------------
const capturedLogs: unknown[][] = [];

__setLoggerForTest({
  warn: (...args: unknown[]) => { capturedLogs.push(args); },
  debug: () => {},
  error: (...args: unknown[]) => { capturedLogs.push(args); },
  info: (...args: unknown[]) => { capturedLogs.push(args); },
  silly: () => {},
  trace: () => {},
  fatal: () => {},
  getSubLogger: () => ({}),
  attachTransport: () => {},
} as any);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
let tmpDir: string;

async function writeRoleYaml(
  roleName: string,
  content: string,
): Promise<string> {
  const roleDir = join(tmpDir, roleName);
  mkdirSync(roleDir, { recursive: true });
  const yamlPath = join(roleDir, "role.yaml");
  await writeFile(yamlPath, content, "utf-8");
  return yamlPath;
}

// ---------------------------------------------------------------------------
// 1. role-loader: auto_activate / locked parsing
// ---------------------------------------------------------------------------
describe("role-loader auto_activate and locked parsing", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rolebox-test-"));
    capturedLogs.length = 0;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses auto_activate as string[] from role.yaml into RoleConfig", async () => {
    await writeRoleYaml(
      "auto-role",
      [
        "name: Auto Role",
        "description: Has auto_activate",
        "prompt: I auto-activate functions.",
        "auto_activate:",
        "  - triage",
        "  - plan",
      ].join("\n"),
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(1);
    const config = roles.get("auto-role")!;
    expect(config.auto_activate).toBeDefined();
    expect(config.auto_activate).toEqual(["triage", "plan"]);
    expect(capturedLogs.length).toBe(0);
  });

  it("parses locked: true from role.yaml into RoleConfig", async () => {
    await writeRoleYaml(
      "locked-role",
      [
        "name: Locked Role",
        "description: Has locked",
        "prompt: I am locked.",
        "locked: true",
      ].join("\n"),
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(1);
    const config = roles.get("locked-role")!;
    expect(config.locked).toBe(true);
    expect(capturedLogs.length).toBe(0);
  });

  it("parses locked: false from role.yaml into RoleConfig", async () => {
    await writeRoleYaml(
      "unlocked-role",
      [
        "name: Unlocked Role",
        'description: "Has locked: false"',
        "prompt: I am unlocked.",
        "locked: false",
      ].join("\n"),
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(1);
    const config = roles.get("unlocked-role")!;
    expect(config.locked).toBe(false);
    expect(capturedLogs.length).toBe(0);
  });

  it("parses both auto_activate and locked together", async () => {
    await writeRoleYaml(
      "combo-role",
      [
        "name: Combo Role",
        "description: Has both fields",
        "prompt: I have both.",
        "auto_activate:",
        "  - triage",
        "locked: true",
      ].join("\n"),
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(1);
    const config = roles.get("combo-role")!;
    expect(config.auto_activate).toEqual(["triage"]);
    expect(config.locked).toBe(true);
    expect(capturedLogs.length).toBe(0);
  });

  it("omits auto_activate when not specified in role.yaml", async () => {
    await writeRoleYaml(
      "plain-role",
      [
        "name: Plain Role",
        "description: No auto_activate",
        "prompt: I am plain.",
      ].join("\n"),
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(1);
    const config = roles.get("plain-role")!;
    expect(config.auto_activate).toBeUndefined();
    expect(config.locked).toBeUndefined();
    expect(capturedLogs.length).toBe(0);
  });

  it("does not parse non-boolean locked as boolean", async () => {
    await writeRoleYaml(
      "bad-locked-role",
      [
        "name: Bad Locked Role",
        "description: Has string locked",
        "prompt: I have a string locked.",
        "locked: not-a-boolean",
      ].join("\n"),
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(1);
    const config = roles.get("bad-locked-role")!;
    // locked is a string, not a boolean — should be omitted
    expect(config.locked).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. session-state: activateDefaults, locked protection, normal deactivation
// ---------------------------------------------------------------------------
describe("functionSessionState activateDefaults and locked protection", () => {
  afterEach(() => {
    functionSessionState.clear("t8-s1");
    functionSessionState.clear("t8-s2");
    functionSessionState.clear("t8-s3");
    functionSessionState.clear("t8-s4");
    functionSessionState.clear("t8-s5");
  });

  it("activateDefaults adds functions to active set", () => {
    functionSessionState.activateDefaults("t8-s1", ["triage"], ["triage"]);
    const active = functionSessionState.getActive("t8-s1");
    expect(active.has("triage")).toBe(true);
  });

  it("locked functions resist deactivation", () => {
    functionSessionState.activateDefaults("t8-s2", ["triage"], ["triage"]);
    functionSessionState.deactivate("t8-s2", "triage");
    const active = functionSessionState.getActive("t8-s2");
    expect(active.has("triage")).toBe(true);
  });

  it("non-locked functions can be deactivated normally", () => {
    functionSessionState.activateDefaults("t8-s3", ["synthesize"]);
    functionSessionState.deactivate("t8-s3", "synthesize");
    const active = functionSessionState.getActive("t8-s3");
    expect(active.has("synthesize")).toBe(false);
  });

  it("locked functions still show as active via isActive", () => {
    functionSessionState.activateDefaults("t8-s4", ["review"], ["review"]);
    functionSessionState.deactivate("t8-s4", "review");
    expect(functionSessionState.isActive("t8-s4", "review")).toBe(true);
  });

  it("clear removes both active functions and locked state", () => {
    functionSessionState.activateDefaults("t8-s5", ["plan", "review"], ["plan"]);
    functionSessionState.clear("t8-s5");

    // After clear, all functions should be gone
    const active = functionSessionState.getActive("t8-s5");
    expect(active.size).toBe(0);
    // Even locked functions should be cleared
    functionSessionState.activateDefaults("t8-s5", ["plan"], ["plan"]);
    // Re-activate and verify it works after clear
    expect(functionSessionState.getActive("t8-s5").has("plan")).toBe(true);
  });
});
