// Regression tests for the progress wiring inside the real downloadRole:
//   (a) it emits the downloading / verifying / extracting phase markers via
//       the injected progress reporter;
//   (e) it actually streams the response body and reports byte counts
//       incrementally (multiple update observations), both determinate
//       (Content-Length present) and indeterminate (no Content-Length).
//
// Uses the DownloadRoleProcess DI seam for the tar spawn so extraction runs
// against the real tar binary while progress is observed through a recorder.
import { describe, it, expect, mock, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DownloadRoleProcess } from "../../src/cli/registry-client";
import type { DownloadProgress } from "../../src/cli/download-progress";
import { hasTar } from "../helpers/tar";

// The REAL downloadRole is loaded via a cache-busted dynamic import: bun keys
// mock.module by resolved module path (no un-mock API), so a limited mock
// registered by another test file could shadow the real registry-client for the
// rest of the single-process run and hand this file a stubbed downloadRole.
// Loading the real module fresh bypasses the mock registry entirely.
async function loadDownloadRole() {
  const real = await import(
    "../../src/cli/registry-client.ts?stream-real=" + Date.now() + "-" + Math.random()
  );
  return real.downloadRole as typeof import("../../src/cli/registry-client").downloadRole;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.XDG_DATA_HOME;
  delete process.env.XDG_CONFIG_HOME;
});

/** A progress spy recording byte updates and phase transitions. */
function makeRecorder() {
  const updates: Array<{ received: number; total: number }> = [];
  const phases: string[] = [];
  const progress = {
    phaseStart: (p: string) => { phases.push(`start:${p}`); },
    phaseComplete: (p: string) => { phases.push(`complete:${p}`); },
    phaseFail: () => { phases.push("fail"); },
    update: (s: { received: number; total: number }) => { updates.push({ ...s }); },
  } as unknown as DownloadProgress;
  return { progress, updates, phases };
}

/** Build a real tarball fixture and return its raw bytes plus the tmp dir. */
async function createArchiveBytes(roleId: string): Promise<{ bytes: Uint8Array; tmpDir: string }> {
  const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-stream-"));
  const fixtureDir = join(tmpDir, "fixture");
  // GitHub tarballs have a single top-level dir; --strip-components=1 yields
  // roles/{roleId}/role.yaml
  const topDir = join(fixtureDir, "owner-repo-commithash");
  const roleDir = join(topDir, "roles", roleId);
  mkdirSync(roleDir, { recursive: true });
  writeFileSync(join(roleDir, "role.yaml"), `name: ${roleId}\ndescription: Test\n`);

  const archivePath = join(tmpDir, "archive.tar.gz");
  const proc = Bun.spawn(["tar", "czf", archivePath, "-C", fixtureDir, "owner-repo-commithash"]);
  expect(await proc.exited).toBe(0);
  return { bytes: readFileSync(archivePath), tmpDir };
}

/** A ReadableStream that emits `bytes` in chunks of at most `chunkSize`. */
function chunkedBody(bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(ctrl) {
      if (offset >= bytes.length) { ctrl.close(); return; }
      const end = Math.min(offset + chunkSize, bytes.length);
      ctrl.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

/** chunk size that guarantees several stream chunks regardless of archive size */
function multiChunkSize(bytes: Uint8Array): number {
  return Math.max(1, Math.floor(bytes.byteLength / 4));
}

async function realTarDeps(): Promise<DownloadRoleProcess> {
  const { spawn: realSpawn, spawnSync: realSpawnSync } = await import("node:child_process");
  return { spawn: realSpawn as any, spawnSync: realSpawnSync as any };
}

describe("downloadRole progress streaming", () => {
  it.skipIf(!hasTar())("streams and reports byte counts incrementally with Content-Length", async () => {
    const { bytes, tmpDir } = await createArchiveBytes("code-reviewer");
    try {
      const headers = new Headers();
      headers.set("content-length", String(bytes.byteLength));
      const resp = new Response(chunkedBody(bytes, multiChunkSize(bytes)), { status: 200, headers });
      globalThis.fetch = mock(() => Promise.resolve(resp));

      const { progress, updates, phases } = makeRecorder();
      const downloadRole = await loadDownloadRole();
      const resultDir = await downloadRole(
        { name: "community", url: "https://github.com/example/myrepo" },
        "code-reviewer",
        "1.0.0",
        undefined,
        await realTarDeps(),
        { progress },
      );

      // Incremental reporting: more than one progress observation.
      expect(updates.length).toBeGreaterThan(1);
      const first = updates[0].received;
      expect(updates.some((u) => u.received > first)).toBe(true);
      // Final observation accounts for the whole body.
      expect(updates[updates.length - 1].received).toBe(bytes.byteLength);
      // Determinate: every observation carries the known total.
      for (const u of updates) expect(u.total).toBe(bytes.byteLength);

      // Phase markers emitted by the real downloadRole.
      expect(phases).toContain("start:downloading");
      expect(phases).toContain("complete:downloading");
      expect(phases).toContain("start:verifying");
      expect(phases).toContain("complete:verifying");
      expect(phases).toContain("start:extracting");
      expect(phases).toContain("complete:extracting");

      // Extraction actually succeeded.
      expect(existsSync(join(resultDir, "role.yaml"))).toBe(true);
      rmSync(resultDir, { recursive: true, force: true });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasTar())("reports indeterminately (total 0) when no Content-Length is present", async () => {
    const { bytes, tmpDir } = await createArchiveBytes("code-reviewer");
    try {
      // No content-length header on the response.
      const resp = new Response(chunkedBody(bytes, multiChunkSize(bytes)), { status: 200 });
      globalThis.fetch = mock(() => Promise.resolve(resp));

      const { progress, updates, phases } = makeRecorder();
      const downloadRole = await loadDownloadRole();
      const resultDir = await downloadRole(
        { name: "community", url: "https://github.com/example/myrepo" },
        "code-reviewer",
        "1.0.0",
        undefined,
        await realTarDeps(),
        { progress },
      );

      // Still incremental…
      expect(updates.length).toBeGreaterThan(1);
      expect(updates[updates.length - 1].received).toBe(bytes.byteLength);
      // …but indeterminate: total is 0 for every observation.
      for (const u of updates) expect(u.total).toBe(0);

      expect(phases).toContain("start:downloading");
      expect(phases).toContain("complete:downloading");

      rmSync(resultDir, { recursive: true, force: true });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
