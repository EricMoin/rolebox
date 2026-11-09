import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCodexDesktopLauncherConfig, prepareCodexDesktopLauncher, readPreparedCodexDesktopLauncher } from "../../../../../src/platform/adapters/codex/desktop/launcher.ts";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ls-")); roots.push(root);
  const config = parseCodexDesktopLauncherConfig({ codexPath: process.execPath, nodePath: process.execPath,
    desktopExecutable: process.execPath, socketPath: join(root, "s"), logPath: join(root, "events") });
  const entries = { launcherEntry: fileURLToPath(new URL("../../../../../src/platform/adapters/codex/desktop/launcher-process.ts", import.meta.url)),
    relayEntry: fileURLToPath(new URL("../../../../../src/platform/adapters/codex/desktop/relay-process.ts", import.meta.url)) };
  const output = join(root, "codex");
  prepareCodexDesktopLauncher(config, output, entries);
  return { root, config, entries, output, prepared: `${output}.json` };
}

describe.skipIf(process.platform === "win32")("desktop launcher private configuration", () => {
  it("rejects a group/world-readable prepared configuration", () => {
    const f = fixture(); chmodSync(f.prepared, 0o644);
    expect(() => readPreparedCodexDesktopLauncher(f.prepared)).toThrow("invalid_prepared_config");
  });
  it("rejects another user's prepared configuration", () => {
    const f = fixture(); const uid = process.getuid!();
    vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    expect(() => readPreparedCodexDesktopLauncher(f.prepared)).toThrow("invalid_prepared_config");
  });
  it("rejects a substituted kind and a symlink to a valid configuration", () => {
    const f = fixture(); const link = join(f.root, "linked"); symlinkSync(f.prepared, link);
    expect(() => readPreparedCodexDesktopLauncher(link)).toThrow("invalid_prepared_config");
    const value = JSON.parse(readFileSync(f.prepared, "utf8")); value.kind = "other";
    writeFileSync(f.prepared, JSON.stringify(value));
    expect(() => readPreparedCodexDesktopLauncher(f.prepared)).toThrow("invalid_prepared_config");
  });
  it("refuses an existing output directory with non-private permissions", () => {
    const f = fixture(); const directory = join(f.root, "public"); mkdirSync(directory, { mode: 0o755 });
    expect(() => prepareCodexDesktopLauncher(f.config, join(directory, "codex"), f.entries)).toThrow("output_directory_not_private");
  });
  it("normalizes missing runtime and entry errors", () => {
    const f = fixture(); const output = join(f.root, "new");
    expect(() => prepareCodexDesktopLauncher({ ...f.config, codexPath: join(f.root, "missing") }, output, f.entries)).toThrow("runtime_unavailable");
    expect(() => prepareCodexDesktopLauncher(f.config, output, { ...f.entries, relayEntry: join(f.root, "missing") })).toThrow("build_required");
  });
});
