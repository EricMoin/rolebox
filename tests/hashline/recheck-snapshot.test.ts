import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyFileUnchanged } from "../../src/hashline/atomic-write.ts";
import { canonicalizeFileContent, computeFileVersion } from "../../src/hashline/hash.ts";

describe("pre-write verified snapshots", () => {
  let directory: string;
  let filePath: string;
  const raw = "alpha\nbeta\n";
  const version = computeFileVersion(raw);

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "hashline-recheck-snapshot-"));
    filePath = join(directory, "file.txt");
    await writeFile(filePath, raw);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("accepts the validated original text", async () => {
    expect(await verifyFileUnchanged(filePath, version, { raw, version })).toBeNull();
  });

  it("rejects a same-size external change even when mtime is restored", async () => {
    const before = await stat(filePath);
    await writeFile(filePath, "omega\nbeta\n");
    await utimes(filePath, before.atime, before.mtime);
    expect(await verifyFileUnchanged(filePath, version, { raw, version })).toContain("version mismatch");
    expect(await readFile(filePath, "utf8")).toBe("omega\nbeta\n");
  });

  it("does not use a snapshot validated for a different expected version", async () => {
    expect(await verifyFileUnchanged(filePath, "0".repeat(64), { raw, version })).toContain("version mismatch");
  });

  it("retains canonical-version acceptance when only BOM and EOL bytes change", async () => {
    const changed = "\uFEFFalpha\r\nbeta\r\n";
    await writeFile(filePath, changed);
    expect(computeFileVersion(canonicalizeFileContent(changed))).toBe(version);
    expect(await verifyFileUnchanged(filePath, version, { raw, version })).toBeNull();
  });

  it("still checks existence for files expected to be created or already present", async () => {
    expect(await verifyFileUnchanged(filePath, null, { raw, version })).toContain("now exists");
    await rm(filePath);
    expect(await verifyFileUnchanged(filePath, version, { raw, version })).toContain("was deleted");
    expect(await verifyFileUnchanged(filePath, null, { raw, version })).toBeNull();
  });
});
