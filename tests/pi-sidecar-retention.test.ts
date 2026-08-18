/**
 * Pi sidecar retention + sidecar-backed reads — regression tests for the
 * pi-platform persistence gaps.
 *
 * Covers:
 *   1. pruneSidecars() keeps the most recent N transcripts by mtime, always
 *      retains the just-finished one, never touches notify-dedup.json, and
 *      removes system-prompt companions in lockstep with their transcript
 *      (plus orphaned companions).
 *   2. writeSystemPrompt()/getSystemPromptPath() persist the effective
 *      system prompt next to the transcript.
 *   3. PiSessionAdapter.messages()/get()/status() fall back to a retained
 *      `.rolebox/pi-sessions/{id}.jsonl` sidecar (raw pi JSON events) when
 *      no Pi-native session file exists — the sub-agent session_read path.
 *
 * The exit-handler retention behavior in process-session.ts is exercised
 * through pruneSidecars() directly: the exit handler invokes
 * `pruneSidecars(MAX_RETAINED_SIDECARS)` after a child exits and no longer
 * deletes the just-finished transcript, so "sidecar retained after child
 * exit" reduces to "prune keeps the newest sidecar".
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  utimesSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendEvent,
  writeSystemPrompt,
  getSystemPromptPath,
  pruneSidecars,
  MAX_RETAINED_SIDECARS,
} from "../src/platform/adapters/pi/sidecar-persister.ts";
import { PiSessionAdapter } from "../src/platform/adapters/pi/session.ts";

// ── Fixture setup — redirect cwd into a temp workspace ─────────────────────

let workspace: string;
let originalCwd: string;

beforeEach(() => {
  // Canonicalize: on macOS `os.tmpdir()` returns the /var symlink form while
  // process.cwd() resolves to /private/var — expectations must use the same
  // canonical form or path assertions never match (same pattern as
  // pi-skills.test.ts).
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "pi-sidecar-retention-")));
  originalCwd = process.cwd();
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(originalCwd);
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Write a transcript sidecar at the given mtime and return its path. */
function writeSidecar(id: string, mtimeMs: number, lines: unknown[] = []): string {
  const path = join(workspace, ".rolebox", "pi-sessions", `${id}.jsonl`);
  mkdirSync(join(workspace, ".rolebox", "pi-sessions"), { recursive: true });
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
  utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
  return path;
}

/** List .jsonl transcript files in the sidecar dir (excludes notify-dedup). */
function transcriptNames(): string[] {
  const dir = join(workspace, ".rolebox", "pi-sessions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".jsonl") && n !== "notify-dedup.json")
    .sort();
}

/** List .systemprompt.txt companion files in the sidecar dir. */
function promptNames(): string[] {
  const dir = join(workspace, ".rolebox", "pi-sessions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".systemprompt.txt"))
    .sort();
}

// ── pruneSidecars() — retention policy ─────────────────────────────────────

describe("pruneSidecars (retention policy)", () => {
  it("keeps the most recent N transcripts by mtime and prunes older ones", () => {
    writeSidecar("oldest", 1_000);
    writeSidecar("middle", 2_000);
    writeSidecar("newest", 3_000);

    const pruned = pruneSidecars(2);

    expect(pruned).toBe(1);
    expect(transcriptNames()).toEqual(["middle.jsonl", "newest.jsonl"]);
  });

  it("always retains the just-finished (newest) sidecar even at keep=1", () => {
    writeSidecar("old", 1_000);
    writeSidecar("just-finished", Date.now());

    const pruned = pruneSidecars(1);

    expect(pruned).toBe(1);
    expect(transcriptNames()).toEqual(["just-finished.jsonl"]);
  });

  it("never touches notify-dedup.json", () => {
    const dedupPath = join(workspace, ".rolebox", "pi-sessions", "notify-dedup.json");
    mkdirSync(join(workspace, ".rolebox", "pi-sessions"), { recursive: true });
    writeFileSync(dedupPath, JSON.stringify(["a", "b"]), "utf-8");
    writeSidecar("only", Date.now());

    const pruned = pruneSidecars(0);

    expect(pruned).toBe(1); // the transcript is pruned...
    expect(existsSync(dedupPath)).toBe(true); // ...but notify-dedup survives
    expect(readFileSync(dedupPath, "utf-8")).toBe(JSON.stringify(["a", "b"]));
  });

  it("removes system-prompt companions in lockstep with their transcript", () => {
    writeSidecar("oldest", 1_000);
    writeSidecar("newest", 3_000);
    // Companion of the OLDEST transcript.
    mkdirSync(join(workspace, ".rolebox", "pi-sessions"), { recursive: true });
    writeFileSync(
      join(workspace, ".rolebox", "pi-sessions", "oldest.systemprompt.txt"),
      "old prompt",
      "utf-8",
    );

    const pruned = pruneSidecars(1);

    expect(pruned).toBe(2); // oldest transcript + its companion
    expect(transcriptNames()).toEqual(["newest.jsonl"]);
    expect(promptNames()).toEqual([]);
  });

  it("removes orphaned system-prompt companions with no matching transcript", () => {
    writeSidecar("kept", 3_000);
    mkdirSync(join(workspace, ".rolebox", "pi-sessions"), { recursive: true });
    writeFileSync(
      join(workspace, ".rolebox", "pi-sessions", "orphan.systemprompt.txt"),
      "orphan prompt",
      "utf-8",
    );

    const pruned = pruneSidecars(1);

    expect(pruned).toBe(1); // only the orphaned companion
    expect(transcriptNames()).toEqual(["kept.jsonl"]);
    expect(promptNames()).toEqual([]);
  });

  it("retains the just-written sidecar when called right after exit (append-then-prune)", async () => {
    // Mirrors the exit-handler sequence: events were appended during the
    // run, then pruneSidecars() runs on exit — the just-finished transcript
    // must survive.
    writeSidecar("old", 1_000);
    await appendEvent("just-finished", { type: "message_start", messageID: "m1" });
    await appendEvent("just-finished", { type: "message_end", messageID: "m1" });

    const pruned = pruneSidecars(1);

    expect(pruned).toBe(1);
    expect(transcriptNames()).toEqual(["just-finished.jsonl"]);
    expect(existsSync(join(workspace, ".rolebox", "pi-sessions", "just-finished.jsonl"))).toBe(true);
  });

  it("defaults to MAX_RETAINED_SIDECARS", () => {
    expect(MAX_RETAINED_SIDECARS).toBeGreaterThan(0);
    const kept = MAX_RETAINED_SIDECARS + 5;
    for (let i = 0; i < kept; i++) {
      writeSidecar(`s${String(i).padStart(2, "0")}`, 1_000 + i);
    }

    const pruned = pruneSidecars();

    expect(pruned).toBe(5);
    expect(transcriptNames()).toHaveLength(MAX_RETAINED_SIDECARS);
  });
});

// ── writeSystemPrompt / getSystemPromptPath ─────────────────────────────────

describe("system prompt persistence", () => {
  it("writes the effective system prompt next to the transcript", async () => {
    const id = "sysprompt-1";
    await writeSystemPrompt(id, "You are an engineer.");

    const expected = join(workspace, ".rolebox", "pi-sessions", `${id}.systemprompt.txt`);
    expect(getSystemPromptPath(id)).toBe(expected);
    expect(existsSync(expected)).toBe(true);
    expect(readFileSync(expected, "utf-8")).toBe("You are an engineer.");
  });

  it("survives alongside the retained transcript after pruning", async () => {
    writeSidecar("old", 1_000);
    writeSidecar("kept", 3_000);
    await writeSystemPrompt("kept", "prompt for kept");

    pruneSidecars(1);

    expect(existsSync(join(workspace, ".rolebox", "pi-sessions", "kept.systemprompt.txt"))).toBe(true);
  });
});

// ── PiSessionAdapter sidecar fallback (session_read path) ───────────────────

describe("PiSessionAdapter sidecar fallback", () => {
  it("messages() reads a retained sidecar when no Pi-native session file exists", async () => {
    const id = "sidecar-session-1";
    const events = [
      { type: "message_start", messageID: "m1", sessionID: id, message: { role: "user", timestamp: 1000 } },
      { type: "message_end", messageID: "m1", sessionID: id, message: { role: "user", content: "Hello there" } },
      { type: "message_start", messageID: "m2", sessionID: id, message: { role: "assistant", timestamp: 2000 } },
      { type: "message_end", messageID: "m2", sessionID: id, message: { role: "assistant", content: "Hi back" } },
    ];
    writeSidecar(id, Date.now(), events);

    // Point the adapter at a non-existent Pi-native session dir — the only
    // readable source is the retained rolebox sidecar.
    const adapter = new PiSessionAdapter(join(workspace, "no-pi-sessions"));
    const messages = await adapter.messages(id);

    expect(messages).toHaveLength(2);
    expect(messages[0].info.role).toBe("user");
    expect(messages[0].parts[0]).toMatchObject({ type: "text", text: "Hello there" });
    expect(messages[1].info.role).toBe("assistant");
    expect(messages[1].parts[0]).toMatchObject({ type: "text", text: "Hi back" });
  });

  it("messages() returns [] for an unknown session (no native file, no sidecar)", async () => {
    const adapter = new PiSessionAdapter(join(workspace, "no-pi-sessions"));
    const messages = await adapter.messages("does-not-exist");
    expect(messages).toEqual([]);
  });

  it("replays streaming text_delta updates into the final text", async () => {
    const id = "sidecar-stream-1";
    const events = [
      { type: "message_start", messageID: "m1", sessionID: id, message: { role: "assistant", timestamp: 1000 } },
      { type: "message_update", messageID: "m1", sessionID: id, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" } },
      { type: "message_update", messageID: "m1", sessionID: id, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" } },
    ];
    writeSidecar(id, Date.now(), events);

    const adapter = new PiSessionAdapter(join(workspace, "no-pi-sessions"));
    const messages = await adapter.messages(id);

    expect(messages).toHaveLength(1);
    expect(messages[0].parts[0]).toMatchObject({ type: "text", text: "Hello" });
  });

  it("replays tool_execution_start/end into a completed tool part", async () => {
    const id = "sidecar-tool-1";
    const events = [
      { type: "message_start", messageID: "m1", sessionID: id, message: { role: "assistant", timestamp: 1000 } },
      { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "echo hi" } },
      { type: "tool_execution_end", toolCallId: "call-1", result: "hi", isError: false },
      { type: "message_end", messageID: "m1", sessionID: id, message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo hi" } }] } },
    ];
    writeSidecar(id, Date.now(), events);

    const adapter = new PiSessionAdapter(join(workspace, "no-pi-sessions"));
    const messages = await adapter.messages(id);

    expect(messages).toHaveLength(1);
    const toolPart = messages[0].parts.find((p) => p.type === "tool") as
      | (PartLike & { state?: { status?: string; output?: string } })
      | undefined;
    expect(toolPart).toBeDefined();
    expect(toolPart!.tool).toBe("bash");
    expect(toolPart!.state?.status).toBe("completed");
    expect(toolPart!.state?.output).toBe("hi");
  });

  it("get() returns SessionInfo from a retained sidecar", async () => {
    const id = "sidecar-get-1";
    const events = [
      { type: "message_start", messageID: "m1", sessionID: id, message: { role: "user", timestamp: 1000 } },
      { type: "message_end", messageID: "m1", sessionID: id, message: { role: "user", content: "My title prompt" } },
    ];
    writeSidecar(id, Date.now(), events);

    const adapter = new PiSessionAdapter(join(workspace, "no-pi-sessions"));
    const session = await adapter.get(id);

    expect(session).not.toBeNull();
    expect(session!.id).toBe(id);
    expect(session!.title).toContain("My title prompt");
  });

  it("status() derives idle from a completed sidecar session", async () => {
    const id = "sidecar-status-1";
    const events = [
      { type: "message_start", messageID: "m1", sessionID: id, message: { role: "assistant", timestamp: 1000 } },
      { type: "message_end", messageID: "m1", sessionID: id, message: { role: "assistant", content: "done" } },
    ];
    writeSidecar(id, Date.now(), events);

    const adapter = new PiSessionAdapter(join(workspace, "no-pi-sessions"));
    const status = await adapter.status(id);

    expect(status).toEqual({ type: "idle" });
  });
});

// ── Loose structural type for the tool-part assertions above ────────────────

interface PartLike {
  id?: string;
  type?: string;
  tool?: string;
  state?: Record<string, unknown>;
}
