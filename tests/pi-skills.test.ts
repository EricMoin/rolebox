/**
 * Pi extension — skill path registration (S1 wiring) tests.
 *
 * Verifies the wiring added to src/pi-extension.ts after
 * initializeRoleboxRuntime():
 *   - every resolved skill of every resolved role — role-local AND global
 *     scope — is registered via `registrar.registerSkillPath(agentId,
 *     dirname(skill.filePath))`, keyed by the owning role id;
 *   - subagent skills are registered recursively under their own agent id;
 *   - duplicates collapse (the registrar's skillPaths map is keyed by
 *     agent id, so the same directory never appears twice);
 *   - the existing `resources_discover` handler (a mock pi.on callback)
 *     returns `{ skillPaths }` containing those directories.
 *
 * The test runs the REAL extension entry point (default export of
 * src/pi-extension.ts) against a hermetic fixture:
 *   - `process.chdir()` → a temp workspace containing `rolebox/` with
 *     role.yaml fixtures that reference role-local and global skills;
 *   - `XDG_CONFIG_HOME` → a temp dir so configDir / globalSkillsDir
 *     resolve inside the fixture (never the real ~/.config/opencode);
 *   - `ROLEBOX_ENGINE_RECOVERY=off` skips the graph-recovery sweep
 *     (orthogonal to skill wiring; documented opt-out).
 *
 * The extension's resources_discover handler returns
 * `{ skillPaths: registrar.getSkillPaths() }`, so the handler's output is
 * the observable projection of the registrar's skill-path map.
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import initExtension from "../src/pi-extension.ts";

// ── Fixture role definitions ────────────────────────────────────────────────
//
// Layout written into the temp workspace:
//
//   {workspace}/rolebox/engineer/role.yaml        skills: [code-review] (×2 on purpose)
//   {workspace}/rolebox/engineer/skills/code-review/SKILL.md   ← role-local skill
//   {workspace}/rolebox/doctor/role.yaml          opencode_skills: [shared-tools]
//                                                 subagents: [assistant w/ assistant-kit]
//   {workspace}/xdg/opencode/skills/shared-tools/SKILL.md      ← global skill
//   {workspace}/xdg/opencode/skills/assistant-kit/SKILL.md     ← subagent global skill

const ENGINEER_ROLE_YAML = `\
name: Engineer
description: Test role with a role-local skill
prompt: |
  You are a test engineer.
skills:
  - code-review
  - code-review
`;

const DOCTOR_ROLE_YAML = `\
name: Doctor
description: Test role with a global skill and a subagent
prompt: |
  You are a test doctor.
opencode_skills:
  - shared-tools
subagents:
  - name: Assistant
    description: A test subagent
    prompt: |
      You are a test assistant.
    opencode_skills:
      - assistant-kit
`;

function writeSkillMarkdown(filePath: string, description: string): void {
  writeFileSync(
    filePath,
    `---\ndescription: ${description}\n---\n${description} instructions.\n`,
    "utf-8",
  );
}

// ── Mock Pi ExtensionAPI ────────────────────────────────────────────────────

interface MockPi {
  pi: any;
  /** pi.on handlers keyed by event name. */
  handlers: Map<string, (...args: any[]) => any>;
  /** Tool names passed to pi.registerTool. */
  registeredTools: string[];
}

function createMockPi(sessionDir: string): MockPi {
  const handlers = new Map<string, (...args: any[]) => any>();
  const registeredTools: string[] = [];
  const pi: any = {
    on: (event: string, handler: (...args: any[]) => any) => {
      handlers.set(event, handler);
    },
    registerTool: (toolDef: { name: string }) => {
      registeredTools.push(toolDef.name);
    },
    registerCommand: () => {},
    registerShortcut: () => {},
    appendEntry: () => {},
    setModel: async () => true,
    ctx: { sessionDir },
  };
  return { pi, handlers, registeredTools };
}

// ── Hermetic environment + full extension run ──────────────────────────────

let workspace: string;
let originalCwd: string;
let originalXdg: string | undefined;
let originalEngineRecovery: string | undefined;
let mockPi: MockPi;

/** Invoke the captured resources_discover handler and return its skillPaths. */
async function discoverSkillPaths(): Promise<string[]> {
  const handler = mockPi.handlers.get("resources_discover");
  expect(handler).toBeFunction();
  const result = await handler!({}, {});
  expect(result).toHaveProperty("skillPaths");
  return result.skillPaths as string[];
}

beforeAll(async () => {
  originalCwd = process.cwd();
  originalXdg = process.env.XDG_CONFIG_HOME;
  originalEngineRecovery = process.env.ROLEBOX_ENGINE_RECOVERY;

  // Canonicalize the workspace up front: on macOS, `os.tmpdir()` returns
  // the `/var/...` symlink form while `process.cwd()` resolves symlinks to
  // `/private/var/...`. The resolver derives role-local skill paths from
  // `process.cwd()`, so all expectation paths must use the same canonical
  // form or the assertions never match.
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "rolebox-pi-skills-")));
  const roleboxDir = join(workspace, "rolebox");
  const xdgConfigHome = join(workspace, "xdg");
  const globalSkillsDir = join(xdgConfigHome, "opencode", "skills");

  // ── rolebox/engineer — role-local skill ──────────────────────────────
  const engineerDir = join(roleboxDir, "engineer");
  mkdirSync(join(engineerDir, "skills", "code-review"), { recursive: true });
  writeFileSync(join(engineerDir, "role.yaml"), ENGINEER_ROLE_YAML, "utf-8");
  writeSkillMarkdown(
    join(engineerDir, "skills", "code-review", "SKILL.md"),
    "Local code review skill",
  );

  // ── rolebox/doctor — global skill + subagent global skill ────────────
  const doctorDir = join(roleboxDir, "doctor");
  mkdirSync(doctorDir, { recursive: true });
  writeFileSync(join(doctorDir, "role.yaml"), DOCTOR_ROLE_YAML, "utf-8");

  // ── global skills directory ──────────────────────────────────────────
  for (const skill of ["shared-tools", "assistant-kit"]) {
    mkdirSync(join(globalSkillsDir, skill), { recursive: true });
    writeSkillMarkdown(
      join(globalSkillsDir, skill, "SKILL.md"),
      `Global skill ${skill}`,
    );
  }

  // Redirect platform paths + working directory into the fixture so the
  // extension never touches the real ~/.config/opencode or the repo.
  process.env.XDG_CONFIG_HOME = xdgConfigHome;
  process.env.ROLEBOX_ENGINE_RECOVERY = "off";
  process.chdir(workspace);

  mockPi = createMockPi(join(workspace, "sessions"));

  // Run the real extension entry point (full init: bootstrap, registrar,
  // adapters, dispatch manager, loop coordinator, service stack, wiring).
  await initExtension(mockPi.pi);
});

afterAll(() => {
  // Restore process state and remove the fixture.
  if (originalXdg === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdg;
  }
  if (originalEngineRecovery === undefined) {
    delete process.env.ROLEBOX_ENGINE_RECOVERY;
  } else {
    process.env.ROLEBOX_ENGINE_RECOVERY = originalEngineRecovery;
  }
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

// ── Assertions ──────────────────────────────────────────────────────────────

describe("pi-extension skill path registration", () => {
  it("registers the resources_discover handler on pi.on", () => {
    expect(mockPi.handlers.has("resources_discover")).toBe(true);
  });

  it("resources_discover returns the role-local SKILL.md directory", async () => {
    const skillPaths = await discoverSkillPaths();
    expect(skillPaths).toContain(
      join(workspace, "rolebox", "engineer", "skills", "code-review"),
    );
  });

  it("resources_discover returns global-scope skill directories", async () => {
    const skillPaths = await discoverSkillPaths();
    expect(skillPaths).toContain(
      join(workspace, "xdg", "opencode", "skills", "shared-tools"),
    );
  });

  it("registers subagent skill paths under the subagent's own agent id", async () => {
    const skillPaths = await discoverSkillPaths();
    expect(skillPaths).toContain(
      join(workspace, "xdg", "opencode", "skills", "assistant-kit"),
    );
  });

  it("de-duplicates — each skill directory appears exactly once", async () => {
    const skillPaths = await discoverSkillPaths();
    const codeReviewDir = join(
      workspace,
      "rolebox",
      "engineer",
      "skills",
      "code-review",
    );
    // engineer lists `code-review` twice in role.yaml; the registrar's
    // agent-id-keyed map collapses it to a single path.
    expect(skillPaths.filter((p) => p === codeReviewDir)).toHaveLength(1);
    // No duplicate entries across all agents either.
    expect(new Set(skillPaths).size).toBe(skillPaths.length);
  });
});
