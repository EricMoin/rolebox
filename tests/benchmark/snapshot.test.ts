import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeBenchmarkRole, snapshotBenchmarkRole } from "../../src/benchmark/snapshot.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(yaml = "name: Reviewer\nprompt: Review carefully.\n"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bench-snapshot-test-")); roots.push(root);
  const role = join(root, "reviewer"); await mkdir(role); await writeFile(join(role, "role.yaml"), yaml); return role;
}

describe("benchmark role snapshot", () => {
  it("freezes file contents and hashes assets as well as role.yaml", async () => {
    const role = await fixture();
    await writeFile(join(role, "guide.md"), "first");
    const snapshot = await snapshotBenchmarkRole(role);
    await writeFile(join(role, "guide.md"), "second");
    const destination = join(roots[0], "frozen");
    await materializeBenchmarkRole(snapshot, destination);
    expect(await readFile(join(destination, "reviewer", "guide.md"), "utf8")).toBe("first");
    expect((await snapshotBenchmarkRole(role)).digest).not.toBe(snapshot.digest);
  });
  it("rejects missing skills instead of silently degrading", async () => {
    const role = await fixture("name: Reviewer\nprompt: Review.\nskills: [missing]\n");
    await expect(snapshotBenchmarkRole(role)).rejects.toThrow("Missing local skill");
  });
  it("rejects dependencies outside the role", async () => {
    const role = await fixture("name: Reviewer\nprompt_file: ../outside.md\n");
    await expect(snapshotBenchmarkRole(role)).rejects.toThrow("inside their role");
  });
  it("rejects symlinks without reading their targets", async () => {
    const role = await fixture(); await symlink("/not-a-fixture", join(role, "linked"));
    await expect(snapshotBenchmarkRole(role)).rejects.toThrow("symlinks");
  });
  it("validates explicit reference paths and skill frontmatter references", async () => {
    const role = await fixture("name: Reviewer\nprompt: Review.\nreferences:\n  guide: guide.md\n");
    await writeFile(join(role, "guide.md"), "Reference.");
    expect((await snapshotBenchmarkRole(role)).files.has("guide.md")).toBe(true);
    await writeFile(join(role, "guide.md"), "---\nreferences:\n  outside: ../outside.md\n---\nBody.");
    await expect(snapshotBenchmarkRole(role)).rejects.toThrow("inside their role");
  });
  it("has a path-independent digest", async () => {
    expect((await snapshotBenchmarkRole(await fixture())).digest).toBe((await snapshotBenchmarkRole(await fixture())).digest);
  });
  it("freezes default functions and preserves executable assets", async () => {
    const role = await fixture();
    const script = join(role, "check.sh");
    await writeFile(script, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const snapshot = await snapshotBenchmarkRole(role);
    expect(snapshot.files.has("functions/plan.md")).toBe(true);
    const destination = join(roots[0], "frozen");
    await materializeBenchmarkRole(snapshot, destination);
    expect((await stat(join(destination, "reviewer", "check.sh"))).mode & 0o700).toBe(0o500);
    await chmod(script, 0o600);
    expect((await snapshotBenchmarkRole(role)).digest).not.toBe(snapshot.digest);
  });
  it("rejects prompt-file environment substitutions", async () => {
    const role = await fixture("name: Reviewer\nprompt_file: prompt.md\n");
    await writeFile(join(role, "prompt.md"), "Value: {env:BENCHMARK_KEY}");
    await expect(snapshotBenchmarkRole(role)).rejects.toThrow("environment substitutions");
  });
  it("does not expose malformed YAML contents in diagnostics", async () => {
    const role = await fixture("name: [private-value\n");
    try { await snapshotBenchmarkRole(role); throw new Error("Expected snapshot failure"); }
    catch (error) {
      expect(String(error)).toContain("not valid YAML");
      expect(String(error)).not.toContain("private-value");
    }
  });
  it("rejects non-map references instead of skipping them", async () => {
    const role = await fixture("name: Reviewer\nprompt: Review.\nreferences: [../../outside.md]\n");
    await expect(snapshotBenchmarkRole(role)).rejects.toThrow("mapping");
  });
  it("rejects oversized assets before materializing a role", async () => {
    const role = await fixture();
    await writeFile(join(role, "large.bin"), "");
    await truncate(join(role, "large.bin"), 17 * 1024 * 1024);
    await expect(snapshotBenchmarkRole(role)).rejects.toThrow("size limit");
  });
  it("rejects child identifiers the real role loader would skip", async () => {
    const role = await fixture("name: Reviewer\nprompt: Review.\nsubagents:\n  - name: bad--child\n    prompt: Work.\n");
    await expect(snapshotBenchmarkRole(role)).rejects.toThrow("reserved separator");
  });
});
