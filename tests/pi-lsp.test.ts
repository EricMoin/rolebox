/**
 * Pi service stack — LSP tool registration via the extraTools channel
 * (Subtask S10).
 *
 * Verifies the src/pi-extension.ts LSP wiring end-to-end through
 * PiLightweightServiceStack:
 *   1. init() registers the full lsp_* surface (createAllLspTools) via the
 *      extraTools channel — the representative names (lsp_diagnostics,
 *      lsp_hover, lsp_find_references, lsp_rename, lsp_servers) are present
 *      and the lsp_* count is >= 25 (createAllLspTools currently emits 32).
 *   2. Smoke execute of lsp_servers returns a render mentioning no configured
 *      servers — nothing is running, at most auto-detected "Not Started"
 *      hints (or the no-detection banner on machines without LSP binaries).
 *   3. Shutdown — docManager.closeAll(clientManager) followed by
 *      clientManager.shutdownAll(), the exact sequence the pi-extension
 *      shutdown handler runs — disposes without throwing.
 *
 * The two managers are constructed directly (LspClientManager(process.cwd())
 * / LspDocumentManager), exactly as src/pi-extension.ts does; LspService is
 * deliberately not involved (it requires a PluginCore Pi cannot run).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PiLightweightServiceStack } from "../src/platform/adapters/pi/service-stack.ts";
import {
  createAllLspTools,
  LspClientManager,
  LspDocumentManager,
} from "../src/lsp/index.ts";
import type { ResolvedRole } from "../src/types.ts";
import type { CanonicalToolContext } from "../src/platform/types.ts";

// ── Expected LSP tool surface ──────────────────────────────────────────────

/** Representative lsp_* tools asserted by name (acceptance criteria). */
const REPRESENTATIVE_LSP_TOOLS = [
  "lsp_diagnostics",
  "lsp_hover",
  "lsp_find_references",
  "lsp_rename",
  "lsp_servers",
];

/** Minimum lsp_* tool count the channel must carry (acceptance: >= 25). */
const LSP_TOOL_COUNT_MIN = 25;

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeRole(): ResolvedRole {
  return {
    id: "test-role",
    config: {
      name: "Test Role",
      description: "A test role for Pi LSP tool tests",
      prompt: "You are a test role.",
    },
    prompt: "You are a test role.",
    skills: [],
    functions: [],
    references: [],
    subagents: [],
  };
}

/** Mock CanonicalToolContext (lsp_servers ignores it, but tools require it). */
function makeContext(dir: string): CanonicalToolContext {
  return {
    sessionID: "sess-lsp",
    messageID: "msg-lsp",
    agent: "test-agent",
    directory: dir,
    worktree: dir,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

// ── Suite ───────────────────────────────────────────────────────────────────

describe("Pi LSP tools via the extraTools channel (S10)", () => {
  let tempDir: string;
  let clientManager: LspClientManager;
  let docManager: LspDocumentManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pi-lsp-test-"));
    // Constructed exactly as src/pi-extension.ts does (S10): the two
    // platform-agnostic managers directly — no LspService involved.
    clientManager = new LspClientManager(process.cwd());
    docManager = new LspDocumentManager();
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // already removed
    }
  });

  it("init() registers the lsp_* tool surface (representative names, 25+ tools)", async () => {
    const registeredNames: string[] = [];
    const mockPi = {
      registerTool: (toolDef: any) => {
        registeredNames.push(toolDef.name);
      },
      on: () => {},
    };

    const stack = new PiLightweightServiceStack(
      mockPi,
      [makeRole()],
      undefined, // sessionDir
      undefined, // dispatchTools (disabled — graph-only orchestration)
      undefined, // loopTools (disabled — graph_add_loop replaces loop_*)
      undefined, // taskTools
      // extraTools — the full createAllLspTools surface, as pi-extension.ts
      // forwards through the extraTools channel.
      createAllLspTools(clientManager, docManager),
    );

    const count = await stack.init();

    // Representative lsp_* tools all registered through pi.registerTool.
    for (const name of REPRESENTATIVE_LSP_TOOLS) {
      expect(registeredNames).toContain(name);
    }

    // Full lsp_* surface: 25+ tools (createAllLspTools currently emits 32).
    const lspNames = registeredNames.filter((n) => n.startsWith("lsp_"));
    expect(lspNames.length).toBeGreaterThanOrEqual(LSP_TOOL_COUNT_MIN);

    // Total registered surface is at least 25.
    expect(count).toBeGreaterThanOrEqual(LSP_TOOL_COUNT_MIN);
  });

  it("smoke: lsp_servers executes and renders no configured servers", async () => {
    const lspTools = createAllLspTools(clientManager, docManager);
    const result = await lspTools.lsp_servers.execute({}, makeContext(tempDir));
    // lsp_servers always renders a plain string; normalize the ToolResult
    // union so the assertions below stay type-safe.
    const render = typeof result === "string" ? result : result.output;

    // The render mentions no configured servers: either the no-detection
    // banner ("No language servers detected or running.") or a
    // "Detected (Not Started)" listing — never a running-server section.
    expect(render).not.toContain("### Running");
    expect(render.toLowerCase()).toContain("language servers");
  });

  it("shutdown disposes the LSP managers without throwing (closeAll + shutdownAll)", async () => {
    // Mirror the pi-extension shutdown handler's LSP disposal sequence
    // (closeAll then shutdownAll); both are no-ops on a fresh manager and
    // must never throw.
    expect(() => docManager.closeAll(clientManager)).not.toThrow();
    await expect(clientManager.shutdownAll()).resolves.toBeUndefined();

    // Idempotent — a second disposal pass stays clean.
    expect(() => docManager.closeAll(clientManager)).not.toThrow();
    await expect(clientManager.shutdownAll()).resolves.toBeUndefined();
  });
});
