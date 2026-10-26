/**
 * DSH turn-recall tests — the `## Relevant memory` prompt block
 * (`src/platform/adapters/dsh/memory-recall.ts`) exercised against a fake
 * `DshContextOptions`/session event log and a real {@link MemoryStore} in a
 * temporary workspace.
 *
 * Verifies:
 *   - only the newest user-AUTHORED message drives retrieval: newer
 *     runtime-context, model-selection, compact-checkpoint and rolebox
 *     `user/message` events are skipped
 *   - a prompt with fewer than two search terms (or no text) renders `''`
 *     instead of falling back to an older prompt
 *   - a Chinese prompt retrieves the relevant entry and not an unrelated one
 *   - the controlled E2E task prompt (long instruction preamble + labelled
 *     question) retrieves both the English and the Chinese sentinel entries
 *     and never the preamble-matching decoy
 *   - session-focus entries are never duplicated into the block
 *   - `memory.recall: false`, a graph worker and a missing/relative workspace
 *     render `''`
 *   - role-scoped entries stay invisible to another role; workspace entries
 *     are visible to every role
 *   - the block names entry ids and content and carries the citation sentence,
 *     and it is bounded/truncated at `maxChars`
 *   - the read/search hint names only authorized AND registered real tools
 *   - the pre-step handoff's noted prompt renders the FIRST turn's message
 *     before the session log holds it, and is preferred over an older logged
 *     prompt
 *   - a render is cached per session/prompt-message/role, invalidated by the
 *     next user message or a re-note, and the log fallback is keyed by the
 *     message id
 *   - rendering has no write side effects and a store failure renders `''`
 *   - `DshSystemPromptAdapter` registers the provider as `rolebox:recall`
 *     (order 5, `interpolate: false`)
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDshMemoryRecall } from "../../src/platform/adapters/dsh/memory-recall.ts";
import type { DshContextAgent, DshContextOptions } from "../../src/platform/adapters/dsh/session-context.ts";
import { DshSystemPromptAdapter } from "../../src/platform/adapters/dsh/system-prompt.ts";
import type {
  DshSystemPromptContext,
  DshSystemPromptContextEntry,
} from "../../src/platform/adapters/dsh/system-prompt.ts";
import { DshAgentRegistrar } from "../../src/platform/adapters/dsh/agent-registrar.ts";
import { createActiveRoleRef } from "../../src/platform/adapters/dsh/role-switcher.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import type { MemoryEntry } from "../../src/memory/types.ts";
import type { ResolvedRole } from "../../src/types.ts";

const SESSION = "session-recall";
const CITATION =
  "When a retrieved memory changes what you do or say, name it (title or id) so the user can see what you remembered.";

/**
 * The controlled headless-E2E task that exposed the query starvation: a long
 * English instruction preamble followed by the labelled question.
 */
const E2E_TASK = [
  "This is a controlled memory-recall check. Treat the following paragraphs as a fixed test harness: do not use outside knowledge, do not browse the web, do not ask clarifying questions, and do not write to memory. The workspace already contains every fact you need. Respond with a single short sentence, and name the memory entries you relied on so the operator can verify that retrieval found them.",
  'Question: what are the "cobalt sentinel" code and the "蓝鲸哨兵" number? Reply with both values on one line.',
].join("\n\n");

/** Minimal resolved role with mutable memory/tools configuration. */
function role(id: string): ResolvedRole {
  return {
    id,
    config: { name: id, description: id, prompt: id },
    prompt: id,
    skills: [],
    functions: [],
    references: [],
    subagents: [],
  };
}

type SessionEvent = { type: string; data?: unknown; time?: number; seq?: number };

/** A model-visible user-role message from the named producer. */
function userMessage(text: string, seq: number, kind = "user"): SessionEvent {
  return {
    type: "user/message",
    time: seq,
    seq,
    data: {
      id: `message-${seq}`,
      role: "user",
      source: { kind },
      content: [{ type: "text", text }],
    },
  };
}

/** Fake dsh session with a header cwd and an event log. */
function session(id: string, directory: string | undefined, events: SessionEvent[] = []) {
  return {
    id,
    header: directory === undefined ? {} : { cwd: directory },
    events,
    inheritedEventCount: 0,
  };
}

describe("DSH turn recall", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rolebox-dsh-memory-recall-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function fixture(options: { maxEntries?: number; maxChars?: number } = {}) {
    const first = role("role-a");
    const second = role("role-b");
    const roles = [first, second];
    const active = createActiveRoleRef();
    const registered = new Set(["memory_read", "memory_recall", "memory_list", "memory_write"]);
    const names = new Map<string, string>();
    const workers = new Set<string>();
    let sessionValue: ReturnType<typeof session> | undefined;
    const context: DshContextOptions = {
      roles: () => roles,
      activeRole: sessionId => active.get(sessionId),
      session: () => sessionValue,
      tools: (agent?: DshContextAgent) => {
        const id = agent?.session?.id ?? agent?.id ?? "";
        return workers.has(id) ? [] : [...registered];
      },
      names: () => names,
      worker: (agent?: DshContextAgent) => {
        const id = agent?.session?.id ?? agent?.id ?? "";
        return workers.has(id) ? { declaredTools: [] } : undefined;
      },
    };
    const recall = createDshMemoryRecall({ context, ...options });
    return {
      first,
      second,
      active,
      registered,
      names,
      workers,
      context,
      recall,
      setSession(value: ReturnType<typeof session> | undefined) {
        sessionValue = value;
      },
      render(ctx: DshSystemPromptContext = { sessionID: SESSION }) {
        return recall.render(ctx);
      },
    };
  }

  function entryCount(): number {
    const store = MemoryStore.open(root);
    try {
      return store.list().length;
    } finally {
      store.close();
    }
  }

  function readEntry(id: string): MemoryEntry | null {
    const store = MemoryStore.open(root);
    try {
      return store.read(id);
    } finally {
      store.close();
    }
  }

  function seed(overrides: {
    content?: string;
    scope?: "role" | "workspace";
    roleId?: string;
    title?: string;
    tags?: string[];
    category?: string;
    relevance?: string;
  } = {}): string {
    const scope = overrides.scope ?? "workspace";
    const store = MemoryStore.open(root);
    try {
      return store.write({
        scope,
        role_id: overrides.roleId ?? (scope === "workspace" ? "shared" : "role-a"),
        category: overrides.category ?? "fact",
        title: overrides.title ?? "Deployment checklist",
        content: overrides.content ?? "Run the migration before restarting.",
        tags: overrides.tags ?? [],
        relevance: overrides.relevance ?? "high",
        session_id: "seed-session",
        source_sessions: ["seed-session"],
      });
    } finally {
      store.close();
    }
  }

  it.each(["runtime-context", "model-selection", "compact-checkpoint", "rolebox"])(
    "reads past a newer synthetic %s user message",
    (kind) => {
      const f = fixture();
      f.active.set(SESSION, "role-a");
      seed({ title: "Deployment migration", content: "Run the migration before restarting." });
      seed({ title: "Compression rollback", content: "Roll back the compression change." });
      f.setSession(session(SESSION, root, [
        userMessage("deployment migration", 1),
        userMessage("compression rollback", 2, kind),
      ]));

      const rendered = f.render();

      expect(rendered).toContain("Run the migration before restarting.");
      expect(rendered).not.toContain("Roll back the compression change.");
    },
  );

  it("renders '' when the newest user-authored message is too short or empty", () => {
    const short = fixture();
    short.active.set(SESSION, "role-a");
    seed();
    short.setSession(session(SESSION, root, [
      userMessage("deployment migration", 1),
      userMessage("fix", 2),
    ]));
    expect(short.render()).toBe("");

    const empty = fixture();
    empty.active.set(SESSION, "role-a");
    seed();
    empty.setSession(session(SESSION, root, [
      userMessage("deployment migration", 1),
      userMessage("", 2),
    ]));
    expect(empty.render()).toBe("");
  });

  it("retrieves the relevant Chinese entry and not an unrelated one", () => {
    const f = fixture();
    f.active.set(SESSION, "role-a");
    const id = seed({ title: "记忆机制", content: "记忆机制需要保存关键点，上下文压缩后也要能找到。" });
    seed({ title: "Deployment checklist", content: "Run the migration before restarting." });
    f.setSession(session(SESSION, root, [userMessage("请记住记忆机制的关键点", 1)]));

    const rendered = f.render();

    expect(rendered).toContain("## Relevant memory");
    expect(rendered).toContain("记忆机制需要保存关键点，上下文压缩后也要能找到。");
    expect(rendered).toContain(id);
    expect(rendered).not.toContain("Deployment checklist");
    expect(rendered).not.toContain("Run the migration before restarting.");
  });

  it("retrieves both sentinels from the controlled E2E task prompt", () => {
    const f = fixture();
    f.active.set(SESSION, "role-a");
    const cobalt = seed({
      title: "Cobalt sentinel code",
      content: 'The "cobalt sentinel" code is COBALT-7731.',
    });
    const whale = seed({
      title: "蓝鲸哨兵",
      content: "蓝鲸哨兵的编号是 42-蓝鲸。",
    });
    // A decoy that only the instruction preamble words would match.
    const decoy = seed({
      title: "Controlled harness notes",
      content: "This controlled instruction paragraph is a fixed harness for the operator.",
    });
    f.setSession(session(SESSION, root, []));
    f.recall.notePrompt(SESSION, "message-e2e", E2E_TASK);

    const rendered = f.render();

    // The provider renders no static table: both entries can only come from
    // the query built for the E2E prompt.
    expect(rendered).toContain("## Relevant memory");
    expect(rendered).toContain("Cobalt sentinel code");
    expect(rendered).toContain(cobalt);
    expect(rendered).toContain("COBALT-7731");
    expect(rendered).toContain("蓝鲸哨兵");
    expect(rendered).toContain(whale);
    expect(rendered).toContain("42-蓝鲸");
    // The instruction preamble no longer drives retrieval.
    expect(rendered).not.toContain("Controlled harness notes");
    expect(rendered).not.toContain(decoy);
  });

  it("never duplicates session-focus entries", () => {
    const f = fixture();
    f.active.set(SESSION, "role-a");
    seed({ title: "Focus notes", content: "记忆机制 focus tag content", tags: ["session-focus"] });
    seed({ title: "Session focus — abcdefgh", content: "记忆机制 title prefix content" });
    seed({ title: "记忆机制", content: "记忆机制 durable content" });
    f.setSession(session(SESSION, root, [userMessage("记忆机制的关键点", 1)]));

    const rendered = f.render();

    expect(rendered).toContain("记忆机制 durable content");
    expect(rendered).not.toContain("focus tag content");
    expect(rendered).not.toContain("title prefix content");
  });

  it("renders '' when the role sets recall: false", () => {
    const f = fixture();
    f.first.config.memory = { recall: false };
    f.active.set(SESSION, "role-a");
    seed();
    f.setSession(session(SESSION, root, [userMessage("deployment migration", 1)]));

    expect(f.render()).toBe("");
  });

  it("renders '' for a graph worker even when memory matches", () => {
    const f = fixture();
    f.active.set(SESSION, "role-a");
    seed();
    f.setSession(session(SESSION, root, [userMessage("deployment migration", 1)]));
    f.workers.add(SESSION);

    expect(f.render()).toBe("");
  });

  it("renders '' without an absolute workspace", () => {
    const missing = fixture();
    missing.active.set(SESSION, "role-a");
    seed();
    missing.setSession(session(SESSION, undefined, [userMessage("deployment migration", 1)]));
    expect(missing.render()).toBe("");

    const relative = fixture();
    relative.active.set(SESSION, "role-a");
    relative.setSession(session(SESSION, "relative-workspace", [userMessage("deployment migration", 1)]));
    expect(relative.render()).toBe("");
  });

  it("keeps a role-scoped entry invisible to another role and shares workspace entries", () => {
    const f = fixture();
    f.active.set(SESSION, "role-a");
    const secret = seed({
      scope: "role",
      roleId: "role-a",
      title: "Role A secret",
      content: "记忆机制 ROLE-A PRIVATE content",
    });
    const shared = seed({
      scope: "workspace",
      title: "Shared recall",
      content: "记忆机制 SHARED content",
    });
    f.setSession(session(SESSION, root, [userMessage("记忆机制的内容", 1)]));

    const asRoleA = f.render();
    expect(asRoleA).toContain("ROLE-A PRIVATE content");
    expect(asRoleA).toContain("SHARED content");
    expect(asRoleA).toContain(secret);
    expect(asRoleA).toContain(shared);

    f.active.set(SESSION, "role-b");
    const asRoleB = f.render();
    expect(asRoleB).not.toContain("ROLE-A PRIVATE content");
    expect(asRoleB).not.toContain(secret);
    expect(asRoleB).toContain("SHARED content");
  });

  it("renders '' when nothing matches", () => {
    const f = fixture();
    f.active.set(SESSION, "role-a");
    seed();
    f.setSession(session(SESSION, root, [userMessage("unrelated quantum chromodynamics", 1)]));

    expect(f.render()).toBe("");
  });

  it("renders ids, content and the citation instruction", () => {
    const f = fixture();
    f.active.set(SESSION, "role-a");
    const id = seed({
      title: "Deployment migration",
      content: "Run the migration\nbefore restarting.",
      relevance: "high",
    });
    f.setSession(session(SESSION, root, [userMessage("deployment migration", 1)]));

    const rendered = f.render();

    expect(rendered).toContain("## Relevant memory");
    expect(rendered).toContain("Retrieved from workspace memory for this request.");
    expect(rendered).toContain(`- **Deployment migration** (\`${id}\`, workspace, high)`);
    // Whitespace is collapsed in the excerpt.
    expect(rendered).toContain("Run the migration before restarting.");
    expect(rendered).toContain("You can read a full entry with `memory_read` and search for more with `memory_recall`.");
    expect(rendered).toContain(CITATION);
  });

  it("bounds the block at maxChars and marks a truncated excerpt", () => {
    const f = fixture({ maxChars: 900 });
    f.active.set(SESSION, "role-a");
    const id = seed({
      title: "记忆机制",
      content: "记忆机制需要保存关键点。".repeat(200),
    });
    f.setSession(session(SESSION, root, [userMessage("记忆机制的关键点", 1)]));

    const rendered = f.render();

    expect(rendered.length).toBeLessThanOrEqual(900);
    expect(rendered).toContain(id);
    expect(rendered).toContain("…");
    expect(rendered).toContain(CITATION);
  });

  it("honors maxEntries", () => {
    const f = fixture({ maxEntries: 1 });
    f.active.set(SESSION, "role-a");
    seed({ title: "记忆机制 one", content: "记忆机制 first content" });
    seed({ title: "记忆机制 two", content: "记忆机制 second content" });
    f.setSession(session(SESSION, root, [userMessage("记忆机制的内容", 1)]));

    const rendered = f.render();

    expect(rendered.split("\n- **").length - 1).toBe(1);
  });

  it("names only the memory tools the session actually holds", () => {
    const noRead = fixture();
    noRead.active.set(SESSION, "role-a");
    noRead.registered.delete("memory_read");
    seed();
    noRead.setSession(session(SESSION, root, [userMessage("deployment migration", 1)]));
    const readless = noRead.render();
    expect(readless).toContain("You can search for more with `memory_recall`.");
    expect(readless).not.toContain("read a full entry");

    const denied = fixture();
    denied.first.config.tools = { memory_recall: false };
    denied.active.set(SESSION, "role-a");
    seed();
    denied.setSession(session(SESSION, root, [userMessage("deployment migration", 2)]));
    const recallDenied = denied.render();
    expect(recallDenied).toContain("You can read a full entry with `memory_read`.");
    expect(recallDenied).not.toContain("search for more");

    const noTools = fixture();
    noTools.active.set(SESSION, "role-a");
    noTools.registered.clear();
    seed();
    noTools.setSession(session(SESSION, root, [userMessage("deployment migration", 3)]));
    const bare = noTools.render();
    expect(bare).toContain("Retrieved from workspace memory for this request.");
    expect(bare).not.toContain("You can");

    const renamed = fixture();
    renamed.active.set(SESSION, "role-a");
    renamed.registered.delete("memory_read");
    renamed.registered.add("memory_read_alt");
    renamed.names.set("memory_read", "memory_read_alt");
    seed();
    renamed.setSession(session(SESSION, root, [userMessage("deployment migration", 4)]));
    expect(renamed.render()).toContain("read a full entry with `memory_read_alt`");
  });

  it("caches one render per user message and invalidates on the next one", () => {
    const f = fixture();
    f.active.set(SESSION, "role-a");
    seed({ title: "Deployment migration", content: "Run the migration before restarting." });
    f.setSession(session(SESSION, root, [userMessage("deployment migration", 1)]));

    const open = vi.spyOn(MemoryStore, "open");
    try {
      const first = f.render();
      expect(first).toContain("Run the migration before restarting.");
      expect(open).toHaveBeenCalledTimes(1);

      expect(f.render()).toBe(first);
      expect(open).toHaveBeenCalledTimes(1);

      f.setSession(session(SESSION, root, [
        userMessage("deployment migration", 1),
        userMessage("deployment migration", 2),
      ]));
      expect(f.render()).toContain("Run the migration before restarting.");
      expect(open).toHaveBeenCalledTimes(2);
    } finally {
      open.mockRestore();
    }
  });

  it("has no write side effects", () => {
    const f = fixture();
    f.active.set(SESSION, "role-a");
    const id = seed({ title: "记忆机制", content: "记忆机制 stable content" });
    expect(entryCount()).toBe(1);
    const before = readEntry(id);
    expect(before).not.toBeNull();
    f.setSession(session(SESSION, root, [userMessage("记忆机制的内容", 1)]));

    f.render();
    f.render();

    expect(entryCount()).toBe(1);
    const after = readEntry(id);
    expect(after?.updated_at).toBe(before?.updated_at);
    expect(after?.accessed_at).toBe(before?.accessed_at);
    expect(after?.access_count).toBe(before?.access_count);
  });

  it("renders '' and never throws when the store cannot be opened", () => {
    const f = fixture();
    f.active.set(SESSION, "role-a");
    seed();
    f.setSession(session(SESSION, root, [userMessage("deployment migration", 1)]));
    const open = vi.spyOn(MemoryStore, "open").mockImplementation(() => {
      throw new Error("store unavailable");
    });
    try {
      expect(() => f.render()).not.toThrow();
      expect(f.render()).toBe("");
    } finally {
      open.mockRestore();
    }
  });

  it("invalidates the cached block when queries are offered and adds scout-only entries", () => {
    const f = fixture();
    f.active.set(SESSION, "role-a");
    const deterministic = seed({
      title: "Deployment migration",
      content: "Run the migration before restarting.",
    });
    const scoutOnly = seed({
      title: "Rollout gate",
      content: "Check the rollout gate before the release.",
    });
    f.setSession(session(SESSION, root, [userMessage("deployment migration", 1)]));

    const open = vi.spyOn(MemoryStore, "open");
    try {
      const first = f.render();
      expect(first).toContain("Run the migration before restarting.");
      expect(first).toContain(deterministic);
      expect(first).not.toContain("Check the rollout gate before the release.");
      expect(open).toHaveBeenCalledTimes(1);

      f.recall.offerQueries(SESSION, "message-1", ["rollout gate"]);

      const second = f.render();
      expect(second).toContain("Run the migration before restarting.");
      expect(second).toContain("Check the rollout gate before the release.");
      expect(second).toContain(scoutOnly);
      expect(open).toHaveBeenCalledTimes(2);
    } finally {
      open.mockRestore();
    }
  });

  it("keeps the short-prompt skip even when queries are offered", () => {
    const f = fixture();
    f.active.set(SESSION, "role-a");
    seed({ title: "Deployment", content: "Deployment notes." });
    f.setSession(session(SESSION, root, [userMessage("fix", 1)]));

    f.recall.offerQueries(SESSION, "message-1", ["deployment"]);

    expect(f.render()).toBe("");
  });

  it("scopes offers to their exact user message", () => {
    const f = fixture();
    f.active.set(SESSION, "role-a");
    seed({ title: "Deployment migration", content: "Deterministic content." });
    seed({ title: "Rollout gate", content: "Scout-only content." });
    f.setSession(session(SESSION, root, [
      userMessage("deployment migration", 1),
      userMessage("deployment migration", 2),
    ]));

    f.recall.offerQueries(SESSION, "message-1", ["rollout gate"]);

    expect(f.render()).not.toContain("Scout-only content.");
  });

  it("merges deterministic and scout results round-robin by rank", () => {
    const f = fixture({ maxEntries: 2 });
    f.active.set(SESSION, "role-a");
    seed({ title: "Deployment migration one", content: "Deployment migration first note." });
    seed({ title: "Deployment migration two", content: "Deployment migration second note." });
    const scout = seed({ title: "Release rollout", content: "Release rollout checklist." });
    f.setSession(session(SESSION, root, [userMessage("deployment migration", 1)]));

    expect(f.render()).not.toContain("Release rollout checklist.");

    f.recall.offerQueries(SESSION, "message-1", ["release rollout"]);
    const rendered = f.render();

    expect(rendered).toContain(scout);
    expect(rendered.split("\n- **").length - 1).toBe(2);
    const deterministicHits = ["Deployment migration one", "Deployment migration two"]
      .filter(title => rendered.includes(title));
    expect(deterministicHits).toHaveLength(1);
  });

  it("de-duplicates an entry returned by the deterministic and the scout search", () => {
    const f = fixture();
    f.active.set(SESSION, "role-a");
    const shared = seed({
      title: "Deployment migration shared",
      content: "Shared deployment migration note.",
    });
    f.setSession(session(SESSION, root, [userMessage("deployment migration", 1)]));

    f.render();
    f.recall.offerQueries(SESSION, "message-1", ["deployment"]);
    const rendered = f.render();

    expect(rendered.split(shared).length - 1).toBe(1);
  });

  it("searches the deterministic query plus at most three offered queries", () => {
    const f = fixture();
    f.active.set(SESSION, "role-a");
    seed({ title: "Deployment migration", content: "Deterministic content." });
    f.setSession(session(SESSION, root, [userMessage("deployment migration", 1)]));
    f.render();

    const search = vi.spyOn(MemoryStore.prototype, "search");
    try {
      f.recall.offerQueries(SESSION, "message-1", ["alpha", "beta", "gamma", "delta", "epsilon"]);
      f.render();
      // One deterministic search plus the first three offered queries.
      expect(search).toHaveBeenCalledTimes(4);
    } finally {
      search.mockRestore();
    }
  });

  it("sanitizes offered queries before searching", () => {
    const f = fixture();
    f.active.set(SESSION, "role-a");
    seed({ title: "Deployment migration", content: "Deterministic content." });
    f.setSession(session(SESSION, root, [userMessage("deployment migration", 1)]));
    f.render();

    const search = vi.spyOn(MemoryStore.prototype, "search");
    try {
      f.recall.offerQueries(SESSION, "message-1", [
        "  Rollout   gate ",
        "rollout gate",
        "",
        "x".repeat(81),
      ]);
      f.render();
      // One deterministic search plus ONE accepted scout query.
      expect(search).toHaveBeenCalledTimes(2);
    } finally {
      search.mockRestore();
    }
  });

  it("renders the noted current message on the first turn, before the log holds it", () => {
    const f = fixture();
    f.active.set(SESSION, "role-a");
    seed({ title: "Deployment migration", content: "Run the migration before restarting." });
    // The agent loop claims the step's message out of the inbox BEFORE it
    // appends it, so the first turn's log has no user message at render time.
    f.setSession(session(SESSION, root, []));

    expect(f.render()).toBe("");

    f.recall.notePrompt(SESSION, "message-current", "deployment migration");

    const rendered = f.render();
    expect(rendered).toContain("## Relevant memory");
    expect(rendered).toContain("Run the migration before restarting.");
  });

  it("prefers the noted prompt over an older logged prompt", () => {
    const f = fixture();
    f.active.set(SESSION, "role-a");
    seed({ title: "Deployment migration", content: "Run the migration before restarting." });
    seed({ title: "Compression rollback", content: "Roll back the compression change." });
    f.setSession(session(SESSION, root, [userMessage("compression rollback", 1)]));

    f.recall.notePrompt(SESSION, "message-current", "deployment migration");

    const rendered = f.render();
    expect(rendered).toContain("Run the migration before restarting.");
    expect(rendered).not.toContain("Roll back the compression change.");
  });

  it("merges offered queries for the noted message id", () => {
    const f = fixture();
    f.active.set(SESSION, "role-a");
    const deterministic = seed({
      title: "Deployment migration",
      content: "Run the migration before restarting.",
    });
    const scoutOnly = seed({
      title: "Rollout gate",
      content: "Check the rollout gate before the release.",
    });
    f.setSession(session(SESSION, root, []));
    f.recall.notePrompt(SESSION, "message-current", "deployment migration");

    expect(f.render()).not.toContain("Check the rollout gate before the release.");

    f.recall.offerQueries(SESSION, "message-current", ["rollout gate"]);

    const rendered = f.render();
    expect(rendered).toContain(deterministic);
    expect(rendered).toContain(scoutOnly);
  });

  it("falls back to the session log with the message id as key", () => {
    const f = fixture();
    f.active.set(SESSION, "role-a");
    seed({ title: "Deployment migration", content: "Run the migration before restarting." });
    const scoutOnly = seed({
      title: "Rollout gate",
      content: "Check the rollout gate before the release.",
    });
    f.setSession(session(SESSION, root, [userMessage("deployment migration", 1)]));

    expect(f.render()).not.toContain("Check the rollout gate before the release.");

    // The logged event's stable message id is the prompt key the offer uses.
    f.recall.offerQueries(SESSION, "message-1", ["rollout gate"]);

    const rendered = f.render();
    expect(rendered).toContain("Run the migration before restarting.");
    expect(rendered).toContain(scoutOnly);
  });

  it("re-noting a session invalidates its cached render", () => {
    const f = fixture();
    f.active.set(SESSION, "role-a");
    seed({ title: "Deployment migration", content: "Run the migration before restarting." });
    seed({ title: "Compression rollback", content: "Roll back the compression change." });
    f.setSession(session(SESSION, root, []));
    f.recall.notePrompt(SESSION, "message-first", "deployment migration");

    const first = f.render();
    expect(first).toContain("Run the migration before restarting.");
    expect(first).not.toContain("Roll back the compression change.");

    f.recall.notePrompt(SESSION, "message-second", "compression rollback");

    const second = f.render();
    expect(second).toContain("Roll back the compression change.");
    expect(second).not.toContain("Run the migration before restarting.");
  });

  it("registers rolebox:recall through the prompt adapter", () => {
    const f = fixture();
    f.active.set(SESSION, "role-a");
    seed({ title: "Deployment migration", content: "Prompt-adapter recall content." });
    f.setSession(session(SESSION, root, [userMessage("deployment migration", 1)]));

    const contexts = new Map<string, DshSystemPromptContextEntry>();
    const adapter = new DshSystemPromptAdapter({
      registrar: new DshAgentRegistrar({
        subagents: { registerProvider: () => () => {}, getProvider: () => undefined, list: () => [] },
      }),
      activeRole: f.active,
      roleFunctionsMap: new Map(),
      directory: root,
      recallContext: context => f.recall.render(context),
    });
    adapter.register({
      section: () => () => {},
      context: entry => {
        contexts.set(entry.name, entry);
        return () => {
          contexts.delete(entry.name);
        };
      },
    });
    try {
      const provider = contexts.get("rolebox:recall");
      expect(provider).toBeDefined();
      expect(provider?.order).toBe(5);
      expect(provider?.interpolate).toBe(false);
      expect(provider?.text({ agent: { id: SESSION } })).toContain("Prompt-adapter recall content.");
    } finally {
      adapter.dispose();
    }
  });
});
