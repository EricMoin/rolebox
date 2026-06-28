import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactStore } from "../src/function/artifact-store";

describe("ArtifactStore", () => {
  it("write → read roundtrip", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifact-test-"));
    try {
      const store = new ArtifactStore(dir);
      store.write("session1", "plan", "hello");
      expect(store.read("session1", "plan")).toBe("hello");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("append extends content", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifact-test-"));
    try {
      const store = new ArtifactStore(dir);
      store.write("session1", "plan", "hello");
      store.append("session1", "plan", " world");
      const content = store.read("session1", "plan")!;
      expect(content).toContain("hello world");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exists returns false then true", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifact-test-"));
    try {
      const store = new ArtifactStore(dir);
      expect(store.exists("session1", "plan")).toBe(false);
      store.write("session1", "plan", "hello");
      expect(store.exists("session1", "plan")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("list returns written artifact names", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifact-test-"));
    try {
      const store = new ArtifactStore(dir);
      store.write("session1", "plan", "hello");
      store.write("session1", "notes", "world");
      const names = store.list("session1");
      expect(names).toContain("plan");
      expect(names).toContain("notes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("list for non-existent session returns empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifact-test-"));
    try {
      const store = new ArtifactStore(dir);
      expect(store.list("nosession")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
