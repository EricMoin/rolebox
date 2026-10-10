/**
 * The dsh worker command boundary is the HOST's session sandbox policy.
 *
 * These are structural doubles of the two host services — no
 * `@deepseek-ai/dsh-sandbox*` package is installed or imported — and they pin
 * the three decisions the adapter makes per command:
 *   (a) a confined mode resolves the session's policy and spawns the argv the
 *       confinement service RETURNED, reporting mode/enforcement/denials;
 *   (b) `danger-full-access` never calls `confine` and reports `unconfined`;
 *   (c) a missing or failing service REFUSES the command instead of spawning it
 *       unconfined.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDshGraphWorkerTools,
  executeDshWorkerCommand,
  type DshSandboxPolicyService,
  type DshSandboxService,
} from "../../../../src/platform/adapters/dsh/graph-worker.ts";
import { getSystem } from "../../../../src/platform/system/index.ts";

/**
 * The shell vector, as the per-OS fact it is: the adapter builds the argv it
 * confines with `getSystem().commandShell(command, process.env)`, so the fake
 * confinement service answers with the same vector and the `confinements`
 * comparison below keeps proving that the runner spawns exactly what the
 * service returned.
 */
const system = getSystem();

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "dsh-worker-boundary-"));
  roots.push(root);
  return root;
}

/** A command that leaves evidence when it actually runs. */
const marker = (name: string) => `echo ran > ${name}`;

describe("dsh worker command boundary", () => {
  it("confines a workspace-write session with the resolved policy and spawns the returned argv", async () => {
    const root = workspace();
    const session = { id: "session-1" };
    const resolutions: unknown[] = [];
    const confinements: Array<{ argv: readonly string[]; policy: unknown }> = [];
    const sandboxPolicy: DshSandboxPolicyService = {
      resolve: (request) => {
        resolutions.push(request);
        return { mode: "workspace-write", workspaceRoot: root, sessionId: "session-1" };
      },
    };
    const sandbox: DshSandboxService = {
      async confine(argv, policy) {
        confinements.push({ argv, policy });
        return { argv: system.commandShell("echo CONFINE-ARGV", process.env), enforcement: "partial",
          denialSignatures: ["sandbox: file-write*"] };
      },
    };
    const result = await executeDshWorkerCommand({ command: "echo ORIGINAL", workspace: root,
      sandbox, sandboxPolicy, session });
    expect(confinements).toEqual([{ argv: system.commandShell("echo ORIGINAL", process.env),
      policy: { mode: "workspace-write", workspaceRoot: root, sessionId: "session-1" } }]);
    expect(resolutions).toEqual([{ session }]);
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain("CONFINE-ARGV");
    expect(result.output).not.toContain("ORIGINAL");
    expect(result.mode).toBe("workspace-write");
    expect(result.enforcement).toBe("partial");
    expect(result.denialSignatures).toEqual(["sandbox: file-write*"]);
    expect(result.cwd).toBe(root);
  });

  it("confines a read-only session and reports the host's full enforcement", async () => {
    const root = workspace();
    const sandboxPolicy: DshSandboxPolicyService = {
      resolve: () => ({ mode: "read-only", workspaceRoot: root }),
    };
    const sandbox: DshSandboxService = {
      async confine() {
        return { argv: system.commandShell("echo READ-ONLY", process.env), enforcement: "full", denialSignatures: [] };
      },
    };
    const result = await executeDshWorkerCommand({ command: "echo ORIGINAL", workspace: root, sandbox, sandboxPolicy });
    expect(result.output).toContain("READ-ONLY");
    expect(result.mode).toBe("read-only");
    expect(result.enforcement).toBe("full");
    expect(result.denialSignatures).toEqual([]);
    expect(result.cwd).toBe(root);
  });

  it("runs a danger-full-access session without calling confine and reports unconfined", async () => {
    const root = workspace();
    let confined = 0;
    const sandbox: DshSandboxService = {
      async confine() {
        confined++;
        return { argv: system.commandShell("echo WRONG", process.env), enforcement: "full", denialSignatures: [] };
      },
    };
    const sandboxPolicy: DshSandboxPolicyService = {
      resolve: () => ({ mode: "danger-full-access", workspaceRoot: root }),
    };
    const result = await executeDshWorkerCommand({ command: "echo UNCONFINED", workspace: root, sandbox, sandboxPolicy });
    expect(confined).toBe(0);
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain("UNCONFINED");
    expect(result.mode).toBe("danger-full-access");
    expect(result.enforcement).toBe("unconfined");
    expect(result.denialSignatures).toEqual([]);
    expect(result.cwd).toBe(root);
  });

  it("refuses instead of spawning when a service is missing or fails", async () => {
    const root = workspace();
    const command = marker("ran.txt");
    const ran = () => existsSync(join(root, "ran.txt"));
    const sandboxPolicy: DshSandboxPolicyService = {
      resolve: () => ({ mode: "workspace-write", workspaceRoot: root }),
    };
    const sandbox: DshSandboxService = {
      async confine() {
        return { argv: system.commandShell("echo CONFINE-ARGV", process.env), enforcement: "full", denialSignatures: [] };
      },
    };
    // No policy resolver at all.
    await expect(executeDshWorkerCommand({ command, workspace: root, sandbox }))
      .rejects.toThrow("sandbox policy service");
    // A confined mode without the confinement service must never run unconfined.
    await expect(executeDshWorkerCommand({ command, workspace: root, sandboxPolicy }))
      .rejects.toThrow("confinement service");
    // A resolver that throws.
    await expect(executeDshWorkerCommand({ command, workspace: root, sandbox,
      sandboxPolicy: { resolve: () => { throw new Error("no session policy"); } } }))

      .rejects.toThrow("failed to resolve");
    // An unknown mode is not silently treated as unconfined.
    await expect(executeDshWorkerCommand({ command, workspace: root, sandbox,
      sandboxPolicy: { resolve: () => ({ mode: "open" as never, workspaceRoot: root }) } }))
      .rejects.toThrow("no recognized mode");
    // A confine call that rejects.
    await expect(executeDshWorkerCommand({ command, workspace: root, sandboxPolicy,
      sandbox: { confine: async () => { throw new Error("backend unavailable"); } } }))
      .rejects.toThrow("failed to confine");
    // A confine call that returns no usable argv.
    await expect(executeDshWorkerCommand({ command, workspace: root, sandboxPolicy,
      sandbox: { confine: async () => ({ argv: [], enforcement: "full", denialSignatures: [] }) } }))
      .rejects.toThrow("no usable spawn argv");
    // A malformed enforcement claim.
    await expect(executeDshWorkerCommand({ command, workspace: root, sandboxPolicy,
      sandbox: { confine: async () => ({ argv: system.commandShell("exit 0", process.env), enforcement: "maybe" as never, denialSignatures: [] }) } }))
      .rejects.toThrow("unknown enforcement level");
    expect(ran()).toBe(false);
  });

  it("carries the boundary into the graph_worker_exec tool result with every existing field", async () => {
    const root = workspace();
    const sandboxPolicy: DshSandboxPolicyService = {
      resolve: () => ({ mode: "danger-full-access", workspaceRoot: root }),
    };
    const tools = createDshGraphWorkerTools(() => ({
      host: { workerPrincipalOf: () => ({ graphId: "graph-1", attemptId: "attempt-1" }) } as never,
      workspace: root, storeRoot: join(root, "store"), sandboxPolicy,
    }));
    const result = await tools.graph_worker_exec!.execute({ command: "echo TOOL-RESULT" } as never,
      { sessionID: "worker-session", abort: new AbortController().signal } as never);
    const reported = JSON.parse(String(result)) as Record<string, unknown>;
    expect(reported.exitCode).toBe(0);
    expect(String(reported.output)).toContain("TOOL-RESULT");
    expect(reported.mode).toBe("danger-full-access");
    expect(reported.enforcement).toBe("unconfined");
    expect(reported.denialSignatures).toEqual([]);
    expect(reported.cwd).toBe(root);
  });
});
