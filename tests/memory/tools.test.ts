/// <reference types="bun-types" />
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MemoryStore } from "../../src/memory/store.ts";
import {
  createMemoryWriteTool,
  createMemoryRecallTool,
  createMemoryListTool,
  createMemoryUpdateTool,
} from "../../src/memory/tools.ts";
import type { ToolContext } from "@opencode-ai/plugin";

// ── Helpers ──────────────────────────────────────────────────────────────

function makeContext(
  dir: string,
  agent = "test-agent",
  sessionID = "test-session",
): ToolContext {
  return {
    sessionID,
    messageID: "msg-001",
    agent,
    directory: dir,
    worktree: dir,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

// Try to extract a memory ID from a tool return string like "Memory written. ID: abc123"
function extractId(result: string): string {
  const match = result.match(/ID:\s*(\S+)/);
  if (!match) throw new Error(`Could not extract ID from: ${result}`);
  return match[1];
}

// ── Suite ────────────────────────────────────────────────────────────────

describe("memory tools", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rolebox-memory-tools-test-"));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // already removed
    }
  });

  // ── memory_write ──────────────────────────────────────────────────────

  describe("createMemoryWriteTool", () => {
    it("T12.1: writes a memory with minimal fields and returns an ID", async () => {
      const tool = createMemoryWriteTool();
      const result = await tool.execute(
        { title: "Test Memory", content: "Hello world", scope: "role" },
        makeContext(tempDir),
      );

      expect(result).toContain("Memory written");
      expect(result).toContain("ID:");
      expect(extractId(result).length).toBeGreaterThan(0);
    });

    it("T12.2: writes with all fields and persists them correctly", async () => {
      const ctx = makeContext(tempDir);
      const tool = createMemoryWriteTool();

      const result = await tool.execute(
        {
          title: "Full Memory",
          content: "Detailed decision content",
          category: "decision",
          scope: "workspace",
          tags: ["auth", "api"],
          relevance: "high",
        },
        ctx,
      );

      const id = extractId(result);

      // Read back via MemoryStore directly
      const store = new MemoryStore(tempDir);
      try {
        const entry = store.read(id);
        expect(entry).not.toBeNull();
        expect(entry!.title).toBe("Full Memory");
        expect(entry!.content).toBe("Detailed decision content");
        expect(entry!.category).toBe("decision");
        expect(entry!.scope).toBe("workspace");
        expect(entry!.tags).toEqual(["auth", "api"]);
        expect(entry!.relevance).toBe("high");
        expect(entry!.session_id).toBe("test-session");
        // role_id should be "shared" because scope === "workspace"
        expect(entry!.role_id).toBe("shared");
      } finally {
        store.close();
      }
    });
  });

  // ── memory_recall ─────────────────────────────────────────────────────

  describe("createMemoryRecallTool", () => {
    it("T12.3: recalls memories matching the query", async () => {
      const ctx = makeContext(tempDir);
      const writeTool = createMemoryWriteTool();

      await writeTool.execute(
        { title: "Fox Memory", content: "The quick brown fox jumps over the lazy dog", scope: "role" },
        ctx,
      );
      await writeTool.execute(
        { title: "Cat Memory", content: "The cat sat on the mat quietly", scope: "role" },
        ctx,
      );

      const recallTool = createMemoryRecallTool();
      const result = await recallTool.execute({ query: "fox" }, ctx);

      expect(result).toContain("Fox Memory");
      expect(result).not.toContain("Cat Memory");
    });

    it("T12.4: returns 'No memories found' for a non-matching query", async () => {
      const ctx = makeContext(tempDir);
      const recallTool = createMemoryRecallTool();
      const result = await recallTool.execute({ query: "nonexistent" }, ctx);

      expect(result).toContain('No memories found matching');
      expect(result).toContain('nonexistent');
    });
  });

  // ── memory_list ───────────────────────────────────────────────────────

  describe("createMemoryListTool", () => {
    it("T12.5: lists all written entries", async () => {
      const ctx = makeContext(tempDir);
      const writeTool = createMemoryWriteTool();

      await writeTool.execute({ title: "Alpha", content: "First memory", scope: "role" }, ctx);
      await writeTool.execute({ title: "Beta", content: "Second memory", scope: "role" }, ctx);
      await writeTool.execute({ title: "Gamma", content: "Third memory", scope: "role" }, ctx);

      const listTool = createMemoryListTool();
      const result = await listTool.execute({}, ctx);

      expect(result).toContain("Alpha");
      expect(result).toContain("Beta");
      expect(result).toContain("Gamma");

      const lines = result.split("\n").filter((l) => l.trim().length > 0);
      expect(lines.length).toBe(3);
    });

    it("T12.6: returns 'No memories found.' when store is empty", async () => {
      const ctx = makeContext(tempDir);
      const listTool = createMemoryListTool();
      const result = await listTool.execute({}, ctx);

      expect(result).toBe("No memories found.");
    });
  });

  // ── memory_update ─────────────────────────────────────────────────────

  describe("createMemoryUpdateTool", () => {
    it("T12.7: partially updates a memory — only provided fields change", async () => {
      const ctx = makeContext(tempDir);
      const writeTool = createMemoryWriteTool();

      const writeResult = await writeTool.execute(
        {
          title: "Original Title",
          content: "Original content",
          category: "note",
          relevance: "medium",
          scope: "role",
        },
        ctx,
      );
      const id = extractId(writeResult);

      const updateTool = createMemoryUpdateTool();
      await updateTool.execute({ id, title: "Updated Title" }, ctx);

      // Verify via MemoryStore directly
      const store = new MemoryStore(tempDir);
      try {
        const entry = store.read(id);
        expect(entry).not.toBeNull();
        expect(entry!.title).toBe("Updated Title");
        expect(entry!.content).toBe("Original content");
        expect(entry!.category).toBe("note");
        expect(entry!.relevance).toBe("medium");
      } finally {
        store.close();
      }
    });

    it("T12.8: update with a non-existent ID returns an error message", async () => {
      const ctx = makeContext(tempDir);
      const writeTool = createMemoryWriteTool();

      // Write a real entry so the store is not empty
      await writeTool.execute(
        { title: "Real Entry", content: "Real content", scope: "role" },
        ctx,
      );

      // Try updating a different, nonexistent ID
      const updateTool = createMemoryUpdateTool();
      const result = await updateTool.execute(
        { id: "nonexistent-id-12345", title: "Ghost" },
        ctx,
      );

      expect(result).toContain("not found — nothing updated");
      expect(result).toContain("nonexistent-id-12345");
      expect(result).not.toContain("updated.");
    });

    it("T12.9: rejects an invalid category value", async () => {
      const ctx = makeContext(tempDir);
      const writeTool = createMemoryWriteTool();
      const writeResult = await writeTool.execute(
        { title: "Valid", content: "Must exist to reach the update path", category: "note", relevance: "medium", scope: "role" },
        ctx,
      );
      const id = extractId(writeResult);

      const updateTool = createMemoryUpdateTool();
      await expect(
        updateTool.execute({ id, category: "invalid-category" }, ctx),
      ).rejects.toThrow();
    });

    it("T12.10: rejects an invalid relevance value", async () => {
      const ctx = makeContext(tempDir);
      const writeTool = createMemoryWriteTool();
      const writeResult = await writeTool.execute(
        { title: "Valid", content: "Must exist to reach the update path", category: "note", relevance: "medium", scope: "role" },
        ctx,
      );
      const id = extractId(writeResult);

      const updateTool = createMemoryUpdateTool();
      await expect(
        updateTool.execute({ id, relevance: "urgent" }, ctx),
      ).rejects.toThrow();
    });
  });
});
