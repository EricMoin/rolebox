import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { BenchmarkFileSnapshot, BenchmarkWorkspaceEvidence } from "./types.ts";

const MAX_FILES = 1_000;
const MAX_FILE_BYTES = 1_048_576;
const MAX_TOTAL_BYTES = 16_777_216;
const MAX_ENTRIES = 4_096;
const MAX_DEPTH = 64;
const MAX_PREVIEW_BYTES = 65_536;
const MAX_FILE_PREVIEW_BYTES = 16_384;
const decoder = new TextDecoder("utf-8", { fatal: true });

export function safeBenchmarkRelativePath(path: string): boolean {
  return typeof path === "string" && path.length > 0 && Buffer.byteLength(path) <= 4_096
    && !/[\\:\p{Cc}\p{Cf}\p{Cs}]/u.test(path)
    && path.split("/").every(part => part.length > 0 && part !== "." && part !== ".." && Buffer.byteLength(part) <= 255);
}

function hashBytes(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function snapshotDigest(files: BenchmarkFileSnapshot["files"]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    const content = Buffer.from(file.content, "base64");
    hash.update(JSON.stringify([file.path, content.length, file.executable])).update(content);
  }
  return hash.digest("hex");
}

function sorted(files: BenchmarkFileSnapshot["files"]): BenchmarkFileSnapshot["files"] {
  return [...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function validateSnapshot(snapshot: BenchmarkFileSnapshot): BenchmarkFileSnapshot["files"] {
  if (!snapshot || !Array.isArray(snapshot.files) || snapshot.files.length > MAX_FILES) {
    throw new Error("Benchmark workspace snapshot exceeds its file limit");
  }
  let bytes = 0;
  const names = new Set<string>();
  for (const file of snapshot.files) {
    if (!file || !safeBenchmarkRelativePath(file.path) || file.path.split("/").length > MAX_DEPTH
      || typeof file.executable !== "boolean" || typeof file.content !== "string"
      || file.content.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) {
      throw new Error("Benchmark workspace snapshot contains an invalid file");
    }
    const content = Buffer.from(file.content, "base64");
    if (content.toString("base64") !== file.content) throw new Error("Benchmark workspace snapshot contains invalid content encoding");
    bytes += content.length;
    if (content.length > MAX_FILE_BYTES || bytes > MAX_TOTAL_BYTES) throw new Error("Benchmark workspace snapshot exceeds its byte limit");
    if (names.has(file.path)) throw new Error("Benchmark workspace snapshot contains duplicate files");
    names.add(file.path);
  }
  for (const name of names) {
    const parts = name.split("/");
    for (let index = 1; index < parts.length; index++) {
      if (names.has(parts.slice(0, index).join("/"))) throw new Error("Benchmark workspace snapshot contains overlapping file paths");
    }
  }
  const files = sorted(snapshot.files);
  if (snapshotDigest(files) !== snapshot.digest) throw new Error("Benchmark workspace snapshot digest does not match its files");
  return files;
}

export async function snapshotBenchmarkFiles(directory: string, options: { omitRoleboxState?: boolean } = {}): Promise<BenchmarkFileSnapshot> {
  const root = resolve(directory);
  async function capture(): Promise<BenchmarkFileSnapshot> {
    const files: BenchmarkFileSnapshot["files"] = [];
    let entries = 0;
    let bytes = 0;
    async function collect(path: string, name: string, depth: number): Promise<void> {
      if (depth > MAX_DEPTH || ++entries > MAX_ENTRIES) throw new Error("Benchmark workspace exceeds its directory traversal limit");
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error("Benchmark workspace files must not contain symlinks");
      if (info.isDirectory()) {
        const children: string[] = [];
        const handle = await opendir(path);
        for await (const entry of handle) {
          if (!name && options.omitRoleboxState && entry.name.toLowerCase() === ".rolebox") continue;
          if (children.length + entries >= MAX_ENTRIES) throw new Error("Benchmark workspace exceeds its directory traversal limit");
          const child = name ? `${name}/${entry.name}` : entry.name;
          if (!safeBenchmarkRelativePath(child)) throw new Error("Benchmark workspace contains an unsafe relative path");
          children.push(entry.name);
        }
        for (const child of children.sort()) await collect(join(path, child), name ? `${name}/${child}` : child, depth + 1);
        return;
      }
      if (!name || !info.isFile()) throw new Error("Benchmark workspace only supports directories and regular files");
      if (files.length >= MAX_FILES || info.size > MAX_FILE_BYTES || bytes + info.size > MAX_TOTAL_BYTES) {
        throw new Error("Benchmark workspace exceeds its file or byte limit");
      }
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const current = await handle.stat();
        if (!current.isFile() || current.size > MAX_FILE_BYTES || bytes + current.size > MAX_TOTAL_BYTES) {
          throw new Error("Benchmark workspace exceeds its file or byte limit");
        }
        const content = Buffer.alloc(current.size + 1);
        let offset = 0;
        while (offset < content.length) {
          const read = await handle.read(content, offset, content.length - offset, offset);
          if (read.bytesRead === 0) break;
          offset += read.bytesRead;
        }
        if (offset !== current.size || (await handle.stat()).size !== current.size) {
          throw new Error("Benchmark workspace files changed while taking the snapshot");
        }
        bytes += offset;
        files.push({ path: name, content: content.subarray(0, offset).toString("base64"), executable: Boolean(current.mode & 0o111) });
      } finally {
        await handle.close();
      }
    }
    await collect(root, "", 0);
    const ordered = sorted(files);
    return { digest: snapshotDigest(ordered), files: ordered };
  }
  try {
    const first = await capture();
    const second = await capture();
    if (first.digest !== second.digest) throw new Error("Benchmark workspace files changed while taking the snapshot");
    return first;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Benchmark workspace")) throw error;
    throw new Error("Benchmark workspace could not be read");
  }
}

export async function materializeBenchmarkFiles(snapshot: BenchmarkFileSnapshot, directory: string): Promise<void> {
  const files = validateSnapshot(snapshot);
  const root = resolve(directory);
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(root)).length > 0) {
      throw new Error("Benchmark workspace destination must be an empty directory");
    }
    for (const file of files) {
      const path = join(root, file.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, Buffer.from(file.content, "base64"), { flag: "wx", mode: file.executable ? 0o700 : 0o600 });
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Benchmark workspace")) throw error;
    throw new Error("Benchmark workspace could not be materialized");
  }
}

export function describeBenchmarkWorkspace(before: BenchmarkFileSnapshot, after: BenchmarkFileSnapshot, artifactDirectory: string): BenchmarkWorkspaceEvidence {
  const initial = new Map(validateSnapshot(before).map(file => [file.path, file]));
  const result = new Map(validateSnapshot(after).map(file => [file.path, file]));
  let previewBytes = 0;
  const changes: BenchmarkWorkspaceEvidence["changes"] = [];
  for (const path of [...new Set([...initial.keys(), ...result.keys()])].sort()) {
    const previous = initial.get(path);
    const current = result.get(path);
    if (previous && current && previous.content === current.content && previous.executable === current.executable) continue;
    let omitted = false;
    function describe(file: typeof previous): { digest: string | null; text: string | null } {
      if (!file) return { digest: null, text: null };
      const bytes = Buffer.from(file.content, "base64");
      const digest = hashBytes(bytes);
      let text: string;
      try { text = decoder.decode(bytes); } catch { omitted = true; return { digest, text: null }; }
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)
        || bytes.length > MAX_FILE_PREVIEW_BYTES || previewBytes + bytes.length > MAX_PREVIEW_BYTES) {
        omitted = true;
        return { digest, text: null };
      }
      previewBytes += bytes.length;
      return { digest, text };
    }
    const oldContent = describe(previous);
    const newContent = describe(current);
    changes.push({
      path, kind: !previous ? "added" : !current ? "deleted" : "modified",
      beforeDigest: oldContent.digest, afterDigest: newContent.digest,
      beforeText: oldContent.text, afterText: newContent.text,
      beforeExecutable: previous?.executable ?? null, afterExecutable: current?.executable ?? null,
      contentOmitted: omitted,
    });
  }
  return { fixtureDigest: before.digest, resultDigest: after.digest, artifactDirectory, changes };
}
