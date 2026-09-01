// tests/windows-adversarial/file-io.test.ts
//
// Subtask 6 / 10 — Cluster E: file I/O, encoding, CRLF, locking.
//
// Adversarial probes that feed the real rolebox CLI (via the subtask-1
// runCli harness) CRLF line endings, UTF-8 BOM, GBK bytes and a live file
// lock, and assert that the CLI's loaders/commands either parse cleanly, fail
// with a clear actionable message, or produce a valid replacement — never
// silently corrupt data or leak a raw EPERM/EBUSY stack trace.
//
// Scenario matrix (each maps to an "it"):
//   1. config.yaml + rolebox.lock with CRLF + UTF-8 BOM  -> parse clean, no \r/\ufeff
//   2. migrate on a CRLF role.yaml                       -> output lines carry no trailing \r
//   3. CRLF SKILL.md frontmatter + reference search      -> frontmatter normalizes, ref line
//                                                           numbers stay correct (no \r residue)
//   4. moveDir under an open handle                      -> windows-latest-only
//   5. uninstall rmSync on a locked dir                  -> windows-latest-only
//   6. GBK bytes in a role description                   -> valid U+FFFD replacement, not silent
//                                                           corruption
//
// Scenarios 1-3 and 6 run identically on darwin; 4-5 are skipped on non-win32
// with an explicit reason (lock semantics only exist there).
//
// HARD RULE: this file never modifies production source under src/. Every
// violated invariant appends a defect to the evidence ledger via recordDefect()
// (cluster "file-io") before the assertion fails.

import { afterAll, describe, expect, it } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { recordDefect } from "./helpers/evidence";
import { runCli, seedVersionCache, type CliResult } from "./helpers/cli";
import { moveDir } from "../../src/cli/fs-utils.ts";
import { parseFrontmatter } from "../../src/resolver/frontmatter.ts";
import { createReferenceSearchTool } from "../../src/utils/reference-search.ts";
import type { ResolvedRole } from "../../src/types.core.ts";

const CLUSTER = "file-io";
const IS_WIN = process.platform === "win32";

// ── Fixture helpers (hermetic; all temp dirs tracked for cleanup) ───────────

const tempDirs: string[] = [];

function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `rolebox-wintest-${prefix}-`));
  tempDirs.push(d);
  return d;
}

/** CRLF line endings + a UTF-8 BOM at the start of the string. */
function crlfBom(text: string): string {
  return "\uFEFF" + text.split("\n").join("\r\n");
}

function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

function writeBytes(path: string, buf: Buffer | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf);
}

/** Minimal config + lock that parse cleanly, suitable for CRLF/BOM variants. */
const CONFIG_YAML = [
  "registries:",
  "  - name: oh-my-role",
  "    url: https://github.com/EricMoin/oh-my-role",
  "    default: true",
  "",
].join("\n");

const LOCK_YAML = [
  "version: 1",
  "roles:",
  "  - role: demo-role",
  "    registry: oh-my-role",
  "    version: 1.0.0",
  '    installedAt: "2026-01-01T00:00:00.000Z"',
  "    integrity: sha256-abc",
  "",
].join("\n");

/** Pre-seed the CLI version-check cache so no npm-registry call fires. */
function seedData(dataDir: string): void {
  try {
    seedVersionCache(dataDir);
  } catch {
    // best effort — a failure just means the CLI may attempt a network call
  }
}

function cleanupTempDirs(): void {
  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

afterAll(cleanupTempDirs);

/** Run the CLI, and when stdout is valid JSON return {r, json}; else {r, json:null}. */
async function runCliJson(
  args: string[],
  opts: Parameters<typeof runCli>[1],
): Promise<{ r: CliResult; json: any }> {
  const r = await runCli(args, opts);
  let json: any = null;
  try {
    if (r.stdout && r.stdout.trim().length > 0) {
      json = JSON.parse(r.stdout);
    }
  } catch {
    json = null;
  }
  return { r, json };
}

// ── Scenario 1: CRLF + BOM config.yaml & rolebox.lock parse clean ───────────

describe("file-io: CRLF/BOM config + lock parse cleanly", () => {
  it("loadConfig/loadLock via `rolebox status --json` and `list --json` leaves no \\r or \\ufeff residue", async () => {
    const dataDir = tmpDir("sc1");
    const configDir = tmpDir("sc1");
    writeText(join(configDir, "config.yaml"), crlfBom(CONFIG_YAML));
    writeText(join(configDir, "rolebox.lock"), crlfBom(LOCK_YAML));
    seedData(dataDir);

    // loadConfig probe via `status --json` (surfaces registries).
    const s = await runCliJson(["status", "--json"], { dataDir, configDir, keepTempDirs: true, timeout: 30_000 });
    // loadLock probe via `list --json` (surfaces installed roles).
    const l = await runCliJson(["list", "--json"], { dataDir, configDir, keepTempDirs: true, timeout: 30_000 });

    expect(s.r.exitCode).toBe(0);
    expect(l.r.exitCode).toBe(0);
    expect(s.json?.registries?.length).toBeGreaterThan(0);
    // `rolebox list --json` prints the roles ARRAY, not an object with .roles.
    const listRoles = Array.isArray(l.json) ? l.json : l.json?.roles;
    expect(listRoles?.length).toBeGreaterThan(0);

    const regName = String(s.json?.registries?.[0]?.name ?? "");
    const roleName = String(listRoles?.[0]?.role ?? "");
    const residueReg = /\r|\ufeff/.test(regName);
    const residueRole = /\r|\ufeff/.test(roleName);

    if (residueReg || residueRole) {
      recordDefect("crlf-bom-config-lock-residue", {
        scenario:
          "config.yaml + rolebox.lock written with CRLF line endings and a UTF-8 BOM, then parsed by `rolebox status --json` / `list --json`",
        command: s.r.command,
        expected:
          "parsed config registry name and lock role name contain no \\r or \\ufeff residue",
        actual: `registry='${JSON.stringify(regName)}' role='${JSON.stringify(roleName)}' residue_reg=${residueReg} residue_role=${residueRole}`,
        exit_code: s.r.exitCode,
        stdout_tail: s.r.stdoutTail,
        stderr_tail: s.r.stderrTail,
        file_line_refs: [
          "src/cli/config.ts:45",
          "src/cli/config.ts:67",
          "src/cli/schemas.ts:170",
          "src/cli/schemas.ts:175",
        ],
        cluster: CLUSTER,
      });
    }

    expect(
      residueReg || residueRole,
      `CRLF/BOM parsing left residue in config/lock values (registry='${JSON.stringify(regName)}' role='${JSON.stringify(roleName)}')`,
    ).toBe(false);
  });
});

// ── Scenario 2: migrate on a CRLF role.yaml leaves trailing \r lines ────────

describe("file-io: migrate preserves CRLF residue on split('\\n')", () => {
  it("migrate output lines contain no trailing \\r", async () => {
    const dataDir = tmpDir("sc2");
    const configDir = tmpDir("sc2");
    const roleDir = tmpDir("sc2");
    const rolePath = join(roleDir, "role.yaml");

    const roleYaml = [
      "name: Review Team Lead",
      "description: Coordinates code review workflow",
      "model: gpt-4",
      "prompt: |",
      "  You are a team lead coordinating a code review workflow.",
      "subagents:",
      "  - name: Coder",
      "    description: Implements code changes",
      "    prompt: You are a senior developer.",
      "collaboration:",
      "  topology: review-loop",
      "  agents: [coder, reviewer]",
      "  max_iterations: 3",
      "",
    ].join("\n");

    writeBytes(rolePath, Buffer.from(crlfBom(roleYaml), "utf-8"));
    seedData(dataDir);

    const r = await runCli(["migrate", rolePath], {
      dataDir,
      configDir,
      keepTempDirs: true,
      timeout: 30_000,
    });

    // migrate must mutate the file in place (migrated, not a no-op).
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Migrated:");

    const migrated = readFileSync(rolePath, "utf-8");
    const lines = migrated.split("\n");
    const trailingCrLines = lines.map((l, i) => (l.endsWith("\r") ? i : -1)).filter((i) => i !== -1);

    if (trailingCrLines.length > 0) {
      recordDefect("migrate-crlf-residue", {
        scenario:
          "role.yaml with CRLF line endings (+ UTF-8 BOM) migrated in place by `rolebox migrate`",
        command: r.command,
        expected: "migrated output, split on '\\n', has no line ending in '\\r'",
        actual: `${trailingCrLines.length}/${lines.length} output lines still end with '\\r' (first at line ${trailingCrLines[0]})`,
        exit_code: r.exitCode,
        stdout_tail: r.stdoutTail,
        stderr_tail: r.stderrTail,
        file_line_refs: [
          "src/cli/commands/migrate.ts:100",
          "src/cli/commands/migrate.ts:124",
        ],
        cluster: CLUSTER,
      });
    }

    expect(
      trailingCrLines.length,
      `migrate left ${trailingCrLines.length} line(s) with trailing \\r (first at line ${trailingCrLines[0]})`,
    ).toBe(0);
  });

  it("MIXED CRLF/LF: migrate output lines carry trailing \\r on CRLF lines (split-on-'\\n' residue)", async () => {
    const dataDir = tmpDir("sc2mix");
    const configDir = tmpDir("sc2mix");
    const roleDir = tmpDir("sc2mix");
    const rolePath = join(roleDir, "role.yaml");

    const roleYaml = [
      "name: Mixed",
      "description: desc",
      "model: claude",
      "collaboration:",
      "  topology: t",
      "  max_iterations: 3",
      "",
    ].join("\n");
    // Alternating endings: even lines CRLF, odd lines LF — the worst case for a
    // split-on-'\n' algorithm (every CRLF line keeps its trailing \r).
    const mixed = roleYaml
      .split("\n")
      .map((l, i) => (i % 2 === 0 ? l + "\r\n" : l + "\n"))
      .join("");

    writeBytes(rolePath, Buffer.from(mixed, "utf-8"));
    seedData(dataDir);

    const r = await runCli(["migrate", rolePath], {
      dataDir,
      configDir,
      keepTempDirs: true,
      timeout: 30_000,
    });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Migrated:");

    const migrated = readFileSync(rolePath, "utf-8");
    const lines = migrated.split("\n");
    const trailingCrLines = lines.map((l, i) => (l.endsWith("\r") ? i : -1)).filter((i) => i !== -1);

    if (trailingCrLines.length > 0) {
      recordDefect("migrate-mixed-crlf-residue", {
        scenario:
          "role.yaml with MIXED CRLF/LF line endings migrated in place by `rolebox migrate`",
        command: r.command,
        expected: "migrated output has no line ending in '\\r' regardless of mixed input endings",
        actual: `${trailingCrLines.length}/${lines.length} output lines still end with '\\r' (first at line ${trailingCrLines[0]})`,
        exit_code: r.exitCode,
        stdout_tail: r.stdoutTail,
        stderr_tail: r.stderrTail,
        file_line_refs: ["src/cli/commands/migrate.ts:100", "src/cli/commands/migrate.ts:124"],
        cluster: CLUSTER,
      });
    }

    expect(
      trailingCrLines.length,
      `migrate left ${trailingCrLines.length} line(s) with trailing \\r on a mixed-CRLF file (first at line ${trailingCrLines[0]})`,
    ).toBe(0);
  });
});

// ── Scenario 3: CRLF SKILL.md frontmatter + reference search line numbers ────

describe("file-io: CRLF role markdown (frontmatter + reference search)", () => {
  it("frontmatter normalizes CRLF; reference search line numbers stay correct", async () => {
    const roleDir = tmpDir("sc3");
    const skillPath = join(roleDir, "SKILL.md");
    const refPath = join(roleDir, "references", "core-theory.md");

    // CRLF + BOM SKILL.md with YAML frontmatter.
    const skill = [
      "---",
      "name: my-skill",
      "description: A test skill",
      "---",
      "# Body",
      "Some content here.",
      "",
    ].join("\n");
    writeBytes(skillPath, Buffer.from(crlfBom(skill), "utf-8"));
    seedData(roleDir);

    // (3a) frontmatter parse must normalize CRLF (frontmatter.ts:19-22).
    const fm = parseFrontmatter(readFileSync(skillPath, "utf-8"));
    const fmMeta = fm.metadata as { name?: string; description?: string };
    const fmOk = fmMeta.name === "my-skill" && fmMeta.description === "A test skill";
    const fmResidue = /\r|\ufeff/.test(fmMeta.name ?? "") || /\r|\ufeff/.test(fm.body);

    if (fmResidue) {
      recordDefect("frontmatter-crlf-residue", {
        scenario: "CRLF+BOM SKILL.md parsed by parseFrontmatter",
        command: "parseFrontmatter(SKILL.md)",
        expected: "metadata parsed, body contains no \\r or \\ufeff residue",
        actual: `name='${JSON.stringify(fmMeta.name)}' body_residue=${fmResidue}`,
        exit_code: 0,
        stdout_tail: "",
        stderr_tail: "",
        file_line_refs: ["src/resolver/frontmatter.ts:19", "src/resolver/frontmatter.ts:22"],
        cluster: CLUSTER,
      });
    }
    expect(fmResidue).toBe(false);
    expect(fmOk).toBe(true);

    // Reference markdown (CRLF + BOM), target on a known line.
    const refContent = ["# Core Theory", "", "This is the target line.", "More text follows.", ""].join("\n");
    writeBytes(refPath, Buffer.from(crlfBom(refContent), "utf-8"));

    const ref: unknown = {
      name: "references/core-theory",
      filePath: refPath,
      description: "desc",
      scope: "role",
      relativePath: "references/core-theory.md",
    };
    const role = {
      id: "probe-role",
      config: {},
      prompt: "probe",
      skills: [],
      functions: [],
      references: [ref],
      subagents: [],
    } as unknown as ResolvedRole;

    const tool = createReferenceSearchTool([role]) as unknown as {
      execute: (input: Record<string, unknown>) => Promise<unknown>;
    };
    const raw = await tool.execute({ query: "target", format: "json", context_lines: 2 });
    const outText = typeof raw === "string" ? raw : String((raw as { output?: string }).output ?? "");

    const matches = JSON.parse(outText) as Array<{
      lineNumber: number;
      matchedLine: string;
      contextBefore: string[];
      contextAfter: string[];
    }>;

    // (3b) line numbers must stay correct even for a CRLF file.
    const expectedLine = 3; // "This is the target line." is the 3rd physical line
    const lineOk = matches.length === 1 && matches[0]?.lineNumber === expectedLine;

    if (!lineOk) {
      recordDefect("reference-search-line-number-drift", {
        scenario: "reference_search over a CRLF (+ BOM) markdown reference document",
        command: "createReferenceSearchTool.execute({ query: 'target', format: 'json' })",
        expected: `search reports lineNumber ${expectedLine} for 'This is the target line.'`,
        actual: `lineNumber='${matches[0]?.lineNumber}' (${matches.length} match(es))`,
        exit_code: 0,
        stdout_tail: outText,
        stderr_tail: "",
        file_line_refs: ["src/utils/reference-search.ts:90", "src/utils/reference-search.ts:103"],
        cluster: CLUSTER,
      });
    }
    expect(lineOk).toBe(true);

    // (3c) matched content must NOT carry CRLF/BOM residue — frontmatter.ts
    // normalizes CRLF but reference-search.ts does not (an inconsistency).
    const residueLines =
      (matches[0]?.matchedLine ?? "").includes("\r") ||
      (matches[0]?.contextBefore ?? []).some((l) => /\r|\ufeff/.test(l)) ||
      (matches[0]?.contextAfter ?? []).some((l) => /\r/.test(l));

    if (residueLines) {
      recordDefect("reference-search-crlf-residue", {
        scenario: "reference_search matchedLine/context over a CRLF+BOM reference file",
        command: "createReferenceSearchTool.execute({ query: 'target', format: 'json' })",
        expected:
          "matched line and context lines contain no \\r or \\ufeff residue (frontmatter.ts normalizes CRLF; reference-search should too)",
        actual: `matchedLine='${JSON.stringify(matches[0]?.matchedLine)}' ctxBefore='${JSON.stringify(matches[0]?.contextBefore).slice(0, 200)}'`,
        exit_code: 0,
        stdout_tail: outText,
        stderr_tail: "",
        file_line_refs: ["src/utils/reference-search.ts:84", "src/utils/reference-search.ts:90"],
        cluster: CLUSTER,
      });
    }
    expect(residueLines).toBe(false);
  });

  it("MARKDOWN format: reference_search over a CRLF+BOM doc leaks \\r into matched context", async () => {
    const roleDir = tmpDir("mdref");
    const refPath = join(roleDir, "core-theory.md");

    const refContent = ["# Core Theory", "", "This is the target line.", "More text follows.", ""].join("\n");
    writeBytes(refPath, Buffer.from(crlfBom(refContent), "utf-8"));

    const ref: unknown = {
      name: "references/core-theory",
      filePath: refPath,
      description: "desc",
      scope: "role",
      relativePath: "references/core-theory.md",
    };
    const role = {
      id: "probe-role",
      config: {},
      prompt: "probe",
      skills: [],
      functions: [],
      references: [ref],
      subagents: [],
    } as unknown as ResolvedRole;

    const tool = createReferenceSearchTool([role]) as unknown as {
      execute: (input: Record<string, unknown>) => Promise<unknown>;
    };
    const raw = await tool.execute({ query: "target", format: "markdown", context_lines: 2 });
    const outText = typeof raw === "string" ? raw : String((raw as { output?: string }).output ?? "");

    // JSON-text residue is caught by the json scenario; this asserts the
    // markdown renderer ALSO carries \r characters out of a CRLF source doc.
    if (/\r/.test(outText)) {
      recordDefect("reference-search-markdown-crlf-residue", {
        scenario: "reference_search format:markdown over a CRLF+BOM reference document",
        command: "createReferenceSearchTool.execute({ query: 'target', format: 'markdown' })",
        expected: "markdown output contains no \\r residue (source CRLF normalized)",
        actual: `markdown output contains \\r; outTextPreview=${JSON.stringify(outText.slice(0, 160))}`,
        exit_code: 0,
        stdout_tail: outText,
        stderr_tail: "",
        file_line_refs: ["src/utils/reference-search.ts:84", "src/utils/reference-search.ts:90"],
        cluster: CLUSTER,
      });
    }
    expect(/\r/.test(outText)).toBe(false);
  });
});


describe("file-io: moveDir under a live handle (locking)", () => {
  // Lock semantics only exist on Windows — skip elsewhere with an explicit reason.
  it.skipIf(!IS_WIN)(
    "moveDir either succeeds or raises a clear path-naming error, never a raw EPERM/EBUSY stack",
    () => {
      const srcDir = tmpDir("sc4");
      const destDir = join(tmpDir("sc4"), "dest");
      mkdirSync(srcDir, { recursive: true });
      const heldFile = join(srcDir, "held.txt");
      writeText(heldFile, "locked");

      // Open a handle inside the source dir so a Windows rename/delete would
      // reject the directory as in-use (no FILE_SHARE_DELETE on the handle).
      let fd: number;
      try {
        fd = openSync(heldFile, "r");
      } catch {
        return; // could not establish the lock — skip rather than false-flag
      }

      let moveErr: unknown;
      try {
        moveDir(srcDir, destDir);
      } catch (err) {
        moveErr = err;
      } finally {
        try {
          closeSync(fd);
        } catch {
          // best effort
        }
      }

      if (moveErr === undefined) {
        return; // success — acceptable outcome
      }

      const code = (moveErr as NodeJS.ErrnoException)?.code ?? "";
      const msg = (moveErr as Error)?.message ?? String(moveErr);
      const isRawErrno = ["EPERM", "EBUSY", "EISDIR", "EACCES"].includes(code);
      const namesPath = msg.includes(srcDir) || /(move|rename|dir|directory)/i.test(msg);

      if (isRawErrno && !namesPath) {
        recordDefect("movedir-raw-filelock-error", {
          scenario: "moveDir(src, dest) with an open file handle inside src on Windows",
          command: "moveDir(srcDir, destDir)",
          expected: "either a successful move or a clear error naming the path",
          actual: `threw raw errno '${code}': ${msg}`,
          exit_code: null,
          stdout_tail: "",
          stderr_tail: msg,
          file_line_refs: ["src/cli/fs-utils.ts:47", "src/cli/fs-utils.ts:48"],
          cluster: CLUSTER,
        });
      }
      expect(
        isRawErrno && !namesPath,
        `moveDir surfaced a raw ${code} (${msg}) instead of a clear, path-naming error`,
      ).toBe(false);
    },
  );
});

// ── Scenario 5: uninstall rmSync on a locked dir (windows-latest-only) ──────

describe("file-io: uninstall rmSync on a locked dir (locking)", () => {
  it.skipIf(!IS_WIN)(
    "uninstall either succeeds or raises a clear path-naming error, never a raw EBUSY/EPERM stack",
    async () => {
      const dataDir = tmpDir("sc5");
      const configDir = tmpDir("sc5");
      const rolePath = join(dataDir, "roles", "testreg", "lockedrole@1.0.0");
      writeText(join(rolePath, "role.yaml"), "name: Locked Role\n");
      writeText(join(rolePath, "held.txt"), "held open so rmSync cannot remove the directory");

      writeText(
        join(configDir, "config.yaml"),
        "registries:\n  - name: testreg\n    url: https://example.com/test\n    default: true\n",
      );
      writeText(
        join(configDir, "rolebox.lock"),
        [
          "version: 1",
          "roles:",
          "  - role: lockedrole",
          "    registry: testreg",
          "    version: 1.0.0",
          '    installedAt: "2026-01-01T00:00:00.000Z"',
          "    integrity: sha256-abc",
          "",
        ].join("\n"),
      );
      seedData(dataDir);

      // Open a handle inside the dir being removed (no FILE_SHARE_DELETE).
      const heldFile = join(rolePath, "held.txt");
      let fd: number;
      try {
        fd = openSync(heldFile, "r");
      } catch {
        return; // could not lock — skip, don't false-flag
      }

      let r: CliResult | undefined;
      try {
        r = await runCli(["uninstall", "lockedrole"], {
          dataDir,
          configDir,
          keepTempDirs: true,
          timeout: 30_000,
        });
      } finally {
        try {
          closeSync(fd);
        } catch {
          // best effort
        }
      }

      if (r && r.exitCode === 0) {
        return; // success — acceptable outcome
      }

      // A raw errno stack trace in stderr = the defect (unwrapped, unactionable).
      const rawErrno = /(EBUSY|EPERM|EISDIR|EACCES)/.test(r?.stderr ?? "");
      const namesPath = /(lockedrole|rolebox|remove|uninstall|directory)/i.test(r?.stderr ?? "");

      if (rawErrno) {
        recordDefect("uninstall-raw-filelock-error", {
          scenario: "uninstall rmSync on a directory with an open file handle inside (Windows)",
          command: r?.command ?? "uninstall lockedrole",
          expected: "exit 0 or a clear, actionable error naming the locked path — not a raw errno stack",
          actual: `exit=${r?.exitCode}; stderr=${r?.stderrTail}`,
          exit_code: r?.exitCode ?? null,
          stdout_tail: r?.stdoutTail ?? "",
          stderr_tail: r?.stderrTail ?? "",
          file_line_refs: ["src/cli/commands/uninstall.ts:53"],
          cluster: CLUSTER,
        });
      }
      expect(
        rawErrno,
        `uninstall surfaced a raw errno stack (${r?.stderrTail}) instead of a clear path-naming error`,
      ).toBe(false);
      expect(namesPath).toBe(true);
    },
  );
});

// ── Scenario 6: GBK (non-UTF8) bytes in a role description ──────────────────

describe("file-io: GBK-encoded bytes in a role description", () => {
  it("loader yields a valid U+FFFD replacement (or clear error), not silent corruption", async () => {
    const dataDir = tmpDir("sc6");
    const configDir = tmpDir("sc6");
    const rolePath = join(dataDir, "roles", "testreg", "gbk-role@1.0.0");

    // role.yaml whose description contains raw GBK bytes (invalid UTF-8).
    // "你" (0xC4E3) + "好" (0xBAC3) = GBK; neither sequence is valid UTF-8, so
    // any correct UTF-8 reader MUST emit U+FFFD replacement chars.
    const gbkBytes = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);
    const raw = Buffer.concat([
      Buffer.from("name: GBK Role\n", "utf-8"),
      Buffer.from("description: ", "utf-8"),
      gbkBytes,
      Buffer.from(" world\n", "utf-8"),
      Buffer.from("model: gpt-4\n", "utf-8"),
      Buffer.from("prompt: test\n", "utf-8"),
    ]);
    writeBytes(join(rolePath, "role.yaml"), raw);

    writeText(
      join(configDir, "config.yaml"),
      "registries:\n  - name: testreg\n    url: https://example.com/test\n    default: true\n",
    );
    writeText(
      join(configDir, "rolebox.lock"),
      [
        "version: 1",
        "roles:",
        "  - role: gbk-role",
        "    registry: testreg",
        "    version: 1.0.0",
        '    installedAt: "2026-01-01T00:00:00.000Z"',
        "    integrity: sha256-abc",
        "",
      ].join("\n"),
    );
    seedData(dataDir);

    const r = await runCli(["info", "gbk-role", "--json"], {
      dataDir,
      configDir,
      keepTempDirs: true,
      timeout: 30_000,
    });

    // Clear encoding error is acceptable.
    if (r.exitCode !== 0) {
      const clearError = /(encod|utf-8|utf8|invalid|parse)/i.test(r.stderr || "");
      if (!clearError) {
        recordDefect("gbk-description-unclear-error", {
          scenario: "role.yaml description containing raw GBK bytes read via `rolebox info --json`",
          command: r.command,
          expected: "a clear encoding error naming the problem, not an opaque failure",
          actual: `exit=${r.exitCode}; stderr=${r.stderrTail}`,
          exit_code: r.exitCode,
          stdout_tail: r.stdoutTail,
          stderr_tail: r.stderrTail,
          file_line_refs: [],
          cluster: CLUSTER,
        });
      }
      expect(
        clearError,
        `rolebox info failed on GBK description with an opaque error: ${r.stderrTail}`,
      ).toBe(true);
      return;
    }

    // Success path: the decoded description MUST contain U+FFFD replacement
    // chars — the signal that invalid bytes were replaced, not silently
    // reinterpreted into plausible-looking garbage.
    const info = JSON.parse(r.stdout) as { description?: string };
    const desc = info.description ?? "";
    const validReplacement = desc.includes("\uFFFD");

    if (!validReplacement) {
      recordDefect("gbk-description-silent-corruption", {
        scenario: "role.yaml description containing raw GBK bytes read via `rolebox info --json`",
        command: r.command,
        expected:
          "U+FFFD replacement char in the parsed description (invalid bytes replaced), NOT silently corrupted",
        actual: `description='${JSON.stringify(desc)}' (no U+FFFD — bytes silently re-interpreted)`,
        exit_code: r.exitCode,
        stdout_tail: r.stdoutTail,
        stderr_tail: r.stderrTail,
        file_line_refs: ["src/cli/commands/info.ts:87"],
        cluster: CLUSTER,
      });
    }
    expect(
      validReplacement,
      `GBK description was silently corrupted instead of replaced: '${JSON.stringify(desc)}'`,
    ).toBe(true);
  });
});

// Reference to keep existsSync import meaningful for future windows probes.
void existsSync;
void rmSync;
