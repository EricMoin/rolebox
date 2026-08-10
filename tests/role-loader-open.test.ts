import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverRoles, validateRoleId, __setLoggerForTest } from "../src/loader/role-loader";

const capturedLogs: unknown[][] = [];

// Inject a mock logger — tslog "hidden" mode doesn't use console.warn,
// so we replace the module-level logger via the test hook.
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

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "rolebox-test-"));
  capturedLogs.length = 0;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function writeRoleYaml(roleName: string, content: string): Promise<string> {
  const roleDir = join(tmpDir, roleName);
  mkdirSync(roleDir, { recursive: true });
  const yamlPath = join(roleDir, "role.yaml");
  await writeFile(yamlPath, content, "utf-8");
  return yamlPath;
}

describe("open-role producer declaration", () => {
  it("parses open: true and exports: [x] into config", async () => {
    await writeRoleYaml(
      "open-role",
      [
        "name: Open Role",
        "description: Exposes a subagent",
        "prompt: You are the open role.",
        "open: true",
        "exports:",
        "  - helper",
      ].join("\n"),
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(1);
    const config = roles.get("open-role")!;
    expect(config.open).toBe(true);
    expect(config.exports).toEqual(["helper"]);
    expect(capturedLogs.length).toBe(0);
  });

  it("parses open: false explicitly as false", async () => {
    await writeRoleYaml(
      "closed-role",
      [
        "name: Closed Role",
        "description: Declares closed explicitly",
        "prompt: You are the closed role.",
        "open: false",
        "exports:",
        "  - helper",
      ].join("\n"),
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(1);
    const config = roles.get("closed-role")!;
    expect(config.open).toBe(false);
    expect(config.exports).toEqual(["helper"]);
  });

  it("leaves open and exports undefined when fields are absent", async () => {
    await writeRoleYaml(
      "private-role",
      [
        "name: Private Role",
        "description: No open declaration",
        "prompt: You are the private role.",
      ].join("\n"),
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(1);
    const config = roles.get("private-role")!;
    expect(config.open).toBeUndefined();
    expect(config.exports).toBeUndefined();
    expect("open" in config).toBe(false);
    expect("exports" in config).toBe(false);
    expect(capturedLogs.length).toBe(0);
  });

  it("drops non-boolean open and non-array exports without breaking the load", async () => {
    await writeRoleYaml(
      "sloppy-role",
      [
        "name: Sloppy Role",
        "description: Badly typed open fields",
        "prompt: You are the sloppy role.",
        'open: "yes"',
        "exports: helper",
      ].join("\n"),
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(1);
    const config = roles.get("sloppy-role")!;
    expect(config.open).toBeUndefined();
    expect(config.exports).toBeUndefined();
  });
});

describe("open-role consumer declaration", () => {
  it("parses open_roles: [producer] into config", async () => {
    await writeRoleYaml(
      "consumer-role",
      [
        "name: Consumer Role",
        "description: Consumes an open role",
        "prompt: You are the consumer role.",
        "open_roles:",
        "  - producer",
        "  - other-producer",
      ].join("\n"),
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(1);
    const config = roles.get("consumer-role")!;
    expect(config.open_roles).toEqual(["producer", "other-producer"]);
    expect(capturedLogs.length).toBe(0);
  });

  it("leaves open_roles undefined when absent", async () => {
    await writeRoleYaml(
      "consumer-no-decl",
      [
        "name: Consumer No Decl",
        "description: No open_roles field",
        "prompt: You are the consumer.",
      ].join("\n"),
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(1);
    const config = roles.get("consumer-no-decl")!;
    expect(config.open_roles).toBeUndefined();
    expect("open_roles" in config).toBe(false);
    expect(capturedLogs.length).toBe(0);
  });

  it("drops a non-array open_roles without breaking the load", async () => {
    await writeRoleYaml(
      "consumer-sloppy",
      [
        "name: Consumer Sloppy",
        "description: Badly typed open_roles",
        "prompt: You are the consumer.",
        "open_roles: producer",
      ].join("\n"),
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(1);
    const config = roles.get("consumer-sloppy")!;
    expect(config.open_roles).toBeUndefined();
    expect("open_roles" in config).toBe(false);
    expect(capturedLogs.length).toBe(0);
  });
});

describe("validateRoleId (open-role id namespace)", () => {
  it("rejects ids containing the subagent separator so an open role id can never collide with a subagent full id", () => {
    expect(validateRoleId("a--b")).toBe(false);
    expect(validateRoleId("foo--bar")).toBe(false);
  });

  it("accepts plain ids without the separator", () => {
    expect(validateRoleId("architect")).toBe(true);
    expect(validateRoleId("open-role")).toBe(true);
  });

  it("rejects empty ids", () => {
    expect(validateRoleId("")).toBe(false);
  });
});

describe("discoverRoles skips ids containing the subagent separator", () => {
  it("skips a foo--bar role directory with a log message while loading a valid sibling", async () => {
    await writeRoleYaml(
      "valid-role",
      [
        "name: Valid Role",
        "description: Loads fine",
        "prompt: You are the valid role.",
      ].join("\n"),
    );
    await writeRoleYaml(
      "foo--bar",
      [
        "name: Foo Bar",
        "description: Id collides with the subagent id namespace",
        "prompt: You are foo bar.",
      ].join("\n"),
    );

    const roles = await discoverRoles(tmpDir);

    // The valid sibling loads; the "--" directory is skipped entirely.
    expect(roles.size).toBe(1);
    expect(roles.has("valid-role")).toBe(true);
    expect(roles.has("foo--bar")).toBe(false);

    // The skip is logged so operators can rename the directory.
    const messages = capturedLogs.flatMap((args) => args.map(String));
    expect(
      messages.some((m) => m.includes("foo--bar") && m.includes("must not contain")),
    ).toBe(true);
  });
});
