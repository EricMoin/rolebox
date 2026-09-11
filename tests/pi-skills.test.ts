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
 *   - `PI_CODING_AGENT_DIR` → a temp dir so configDir / globalSkillsDir
 *     resolve inside the fixture (never the real ~/.pi/agent);
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
//   {workspace}/pi-agent/skills/shared-tools/SKILL.md      ← global skill
//   {workspace}/pi-agent/skills/assistant-kit/SKILL.md     ← subagent global skill

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
let originalPiDir: string | undefined;
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
  originalPiDir = process.env.PI_CODING_AGENT_DIR;
  originalEngineRecovery = process.env.ROLEBOX_ENGINE_RECOVERY;

  // Canonicalize the workspace up front: on macOS, `os.tmpdir()` returns
  // the `/var/...` symlink form while `process.cwd()` resolves symlinks to
  // `/private/var/...`. The resolver derives role-local skill paths from
  // `process.cwd()`, so all expectation paths must use the same canonical
  // form or the assertions never match.
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "rolebox-pi-skills-")));
  const roleboxDir = join(workspace, "rolebox");
  const piAgentDir = join(workspace, "pi-agent");
  const globalSkillsDir = join(piAgentDir, "skills");

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
  // extension never touches the real ~/.pi/agent or the repo.
  process.env.PI_CODING_AGENT_DIR = piAgentDir;
  process.env.ROLEBOX_ENGINE_RECOVERY = "off";
  process.chdir(workspace);

  mockPi = createMockPi(join(workspace, "sessions"));

  // Run the real extension entry point (full init: bootstrap, registrar,
  // adapters, dispatch manager, loop coordinator, service stack, wiring).
  await initExtension(mockPi.pi);
});

afterAll(() => {
  // Restore process state and remove the fixture.
  if (originalPiDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalPiDir;
  }
  if (originalEngineRecovery === undefined) {
    delete process.env.ROLEBOX_ENGINE_RECOVERY;
  } else {
    process.env.ROLEBOX_ENGINE_RECOVERY = originalEngineRecovery;
  }
  process.chdir(originalCwd);
  // Windows-only hardening: rmSync on a freshly-written tree transiently
  // fails with EBUSY/EPERM (Defender/AV scanning a just-closed file, or the
  // OS still releasing a directory handle). POSIX tolerates this because
  // open/locked files can still be unlinked there; Windows cannot. The
  // extension init writes engine state, dispatch/loop stores and the
  // graph-events log under the workspace, so this cleanup is the hotspot.
  //
  // IMPORTANT: bun's node:fs rmSync does NOT honor `maxRetries`/`retryDelay`
  // (verified against bun's source — src/runtime/node/node_fs.rs parses the
  // options into `RmDir` but never consumes them; `rm` calls
  // `zig_delete_tree` directly, whose only internal retry is an
  // ENOTEMPTY/EEXIST re-iteration, and empirically bun 1.3.14 fails in
  // ~0-2ms regardless of the options). The retry therefore must be
  // hand-rolled and runtime-agnostic.
  const rmWithRetry = (target: string, attempts = 8, delayMs = 250): void => {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        rmSync(target, { recursive: true, force: true });
        return;
      } catch (err) {
        lastErr = err;
        // Synchronous sleep without runtime-specific APIs: Atomics.wait
        // blocks this thread for delayMs with a timeout — no setTimeout,
        // no busy-spin, works on bun and node alike.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
      }
    }
    if (process.platform === "win32") {
      // Transient AV/handle locks on an ephemeral CI runner are harmless to
      // leak; a failed cleanup must not fail the suite on Windows.
      console.warn(`[pi-skills] cleanup of ${target} deferred (still locked):`, lastErr);
      return;
    }
    throw lastErr;
  };
  rmWithRetry(workspace);
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
      join(workspace, "pi-agent", "skills", "shared-tools"),
    );
  });

  it("registers subagent skill paths under the subagent's own agent id", async () => {
    const skillPaths = await discoverSkillPaths();
    expect(skillPaths).toContain(
      join(workspace, "pi-agent", "skills", "assistant-kit"),
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
