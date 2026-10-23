import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createContextAssembleTool } from "../../../src/dispatch/query/context-assemble.ts";
import { MemoryStore } from "../../../src/memory/store.ts";
import type { DispatchManager } from "../../../src/dispatch/core/manager.ts";
import type { ISessionClient } from "../../../src/platform/ports/session-client.ts";
import type { CanonicalToolContext } from "../../../src/platform/types.ts";

describe("context_assemble memory visibility", () => {
  let root: string;
  let directory: string;
  let otherDirectory: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rolebox-context-memory-"));
    directory = join(root, "current");
    otherDirectory = join(root, "other");
    for (const [workspace, prefix] of [[directory, "Current"], [otherDirectory, "Other"]]) {
      const store = MemoryStore.open(workspace);
      try {
        for (const roleId of ["role-a", "role-b", "shared"]) {
          store.write({
            scope: roleId === "shared" ? "workspace" : "role", role_id: roleId,
            title: `${prefix} ${roleId} cache`, content: `${prefix} ${roleId} evidence`,
            category: "decision", tags: [], relevance: "medium", session_id: "source", source_sessions: ["source"],
          });
        }
      } finally { store.close(); }
    }
  });

  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function context(agent?: string, workspace = directory): CanonicalToolContext {
    return { agent, directory: workspace, worktree: workspace, sessionID: "session", messageID: "message",
      abort: new AbortController().signal, metadata: () => {} };
  }

  function tool() {
    return createContextAssembleTool({
      dispatchManager: {} as DispatchManager, sessionClient: {} as ISessionClient,
      resolvedRoles: [], directory: otherDirectory,
    });
  }

  it("searches the current workspace and shares only workspace plus current-role entries", async () => {
    const assemble = tool();
    const result = await assemble.execute(z.object(assemble.args).parse({ topic: "cache", sources: ["memory"] }), context("role-a"));
    expect(result).toContain("Current role-a evidence");
    expect(result).toContain("Current shared evidence");
    expect(result).not.toContain("Current role-b evidence");
    expect(result).not.toContain("Other");
  });

  it("limits an unidentified caller to workspace memories", async () => {
    const assemble = tool();
    const result = await assemble.execute(z.object(assemble.args).parse({ topic: "cache", sources: ["memory"] }), context());
    expect(result).toContain("Current shared evidence");
    expect(result).not.toContain("role-a evidence");
    expect(result).not.toContain("role-b evidence");
    expect(result).not.toContain("Other");
  });

  it("never falls back to the configured or process workspace when the call has no absolute workspace", async () => {
    const assemble = tool();
    const open = spyOn(MemoryStore, "create");
    try {
      for (const workspace of ["", "relative-workspace"]) {
        const result = await assemble.execute(z.object(assemble.args).parse({ topic: "cache", sources: ["memory"] }), context("role-a", workspace));
        expect(result).not.toContain("evidence");
      }
      expect(open).not.toHaveBeenCalled();
    } finally { open.mockRestore(); }
  });
});
