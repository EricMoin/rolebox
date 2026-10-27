/**
 * DSH session-focus tests — the agent-curated `## Session focus` prompt block
 * (`src/platform/adapters/dsh/session-focus.ts`) exercised against a fake
 * `DshContextOptions`/session event log and a real {@link MemoryStore} in a
 * temporary workspace.
 *
 * Verifies:
 *   - no entry and no compaction renders the standing create recipe naming
 *     `memory_write`, the entry title, tags and workspace/role scope
 *   - the create recipe title carries the session UUID prefix, not the literal
 *     `session-` prefix (with a raw-prefix fallback when nothing else remains)
 *   - a compaction event without an entry renders the urgent recipe at the
 *     compaction time and never echoes the summary body
 *   - a fresh entry renders its content, its id and the `memory_update` call
 *     with no refresh instruction
 *   - a compaction newer than the entry asks for a refresh instead
 *   - content is truncated by code point at `maxChars` with the marker
 *   - a role-scoped entry is invisible to another role; a workspace entry is
 *     visible to any role
 *   - `memory.session_focus: false`, a missing/relative workspace and a graph
 *     worker render `''`
 *   - a store failure renders `''` and never throws
 *   - rendering has no write side effects (entry count unchanged)
 *   - without `memory_write`/`memory_update` there is no create/update
 *     instruction; an existing entry's content still renders
 *   - an empty entry is treated as one to fill (its id is named)
 *   - `DshSystemPromptAdapter` registers the provider as `rolebox:focus`
 *     (order 15, `interpolate: false`)
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDshSessionFocus } from "../../src/platform/adapters/dsh/session-focus.ts";
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

const SESSION = "abcdefgh-session";
const COMPACTED_AT = "2026-01-02T03:04:05.000Z";
const COMPACTED_MS = Date.parse(COMPACTED_AT);
const SUMMARY_BODY = "SECRET SUMMARY BODY that must never reach the block";

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

type SessionEvent = { type: string; data?: unknown; time?: number };

/** Fake dsh session with a header cwd and an event log. */
function session(id: string, directory: string | undefined, events: SessionEvent[] = []) {
  return {
    id,
    header: directory === undefined ? {} : { cwd: directory },
    events,
    inheritedEventCount: 0,
  };
}

/** dsh `compaction/summary` event; only its time is ever read. */
function compactionEvent(time: number = COMPACTED_MS): SessionEvent {
  return {
    type: "compaction/summary",
    time,
    data: { compactionId: "cmp-1", summary: [{ type: "text", text: SUMMARY_BODY }] },
  };
}

describe("DSH session focus", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rolebox-dsh-session-focus-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function fixture(options: { maxChars?: number } = {}) {
    const first = role("role-a");
    const second = role("role-b");
    const roles = [first, second];
    const active = createActiveRoleRef();
    const registered = new Set(["memory_write", "memory_update", "memory_read"]);
    const names = new Map<string, string>();
    const workers = new Set<string>();
    const workerTools: string[] = [];
    let sessionValue: ReturnType<typeof session> | undefined;
    const context: DshContextOptions = {
      roles: () => roles,
      activeRole: sessionId => active.get(sessionId),
      session: () => sessionValue,
      tools: (agent?: DshContextAgent) => {
        const id = agent?.session?.id ?? agent?.id ?? "";
        return workers.has(id) ? [...workerTools] : [...registered];
      },
      names: () => names,
      worker: (agent?: DshContextAgent) => {
        const id = agent?.session?.id ?? agent?.id ?? "";
        return workers.has(id) ? { agent: "role-a", inheritedTools: workerTools } : undefined;
      },
    };
    const focus = createDshSessionFocus({ context, maxChars: options.maxChars });
    return {
      first,
      second,
      active,
      registered,
      names,
      workers,
      workerTools,
      context,
      focus,
      setSession(value: ReturnType<typeof session> | undefined) {
        sessionValue = value;
      },
      render(ctx: DshSystemPromptContext = { sessionID: SESSION }) {
        return focus.render(ctx);
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

  function seedFocus(overrides: {
    content?: string;
    scope?: "role" | "workspace";
    roleId?: string;
    sessionId?: string;
    title?: string;
    tags?: string[];
    category?: string;
    relevance?: string;
  } = {}): string {
    const scope = overrides.scope ?? "role";
    const store = MemoryStore.open(root);
    try {
      return store.write({
        scope,
        role_id: overrides.roleId ?? (scope === "workspace" ? "shared" : "role-a"),
        category: overrides.category ?? "note",
        title: overrides.title ?? `Session focus — ${SESSION.slice(0, 8)}`,
        content: overrides.content ?? "Goal: ship session focus.",
        tags: overrides.tags ?? ["session-focus"],
        relevance: overrides.relevance ?? "high",
        session_id: overrides.sessionId === undefined ? SESSION : overrides.sessionId,
        source_sessions: [SESSION],
      });
    } finally {
      store.close();
    }
  }

  it("renders the standing create recipe with the write tool and role scope", () => {
    const f = fixture();
    f.active.set(SESSION, "role-a");
    f.setSession(session(SESSION, root));

    const rendered = f.render();

    expect(rendered).toContain("## Session focus");
    expect(rendered).toContain("memory_write");
    expect(rendered).toContain('scope "role"');
    expect(rendered).toContain(`Session focus — ${SESSION.slice(0, 8)}`);
    expect(rendered).toContain('tags ["session-focus"]');
    expect(rendered).toContain('category "note"');
    expect(rendered).toContain('relevance "high"');
    expect(rendered).toContain("When this task has a goal");
    expect(rendered).not.toContain("Earlier history was compacted");
    expect(entryCount()).toBe(0);
  });

  it("uses the UUID prefix, not the session- prefix, in the create recipe title", () => {
    const dshSession = "session-4b8851fa-2c7d-4e11-9a3f-8b6c5d4e3f21";
    const f = fixture();
    f.active.set(dshSession, "role-a");
    f.setSession(session(dshSession, root));

    const rendered = f.render({ sessionID: dshSession });

    expect(rendered).toContain("Session focus — 4b8851fa");
    expect(rendered).not.toContain("Session focus — session-");
  });

  it("falls back to the raw prefix when stripping the session- prefix leaves nothing", () => {
    const f = fixture();
    f.active.set("session-", "role-a");
    f.setSession(session("session-", root));

    expect(f.render({ sessionID: "session-" })).toContain("Session focus — session-");
  });

  it("asks for workspace scope when no role is active", () => {
    const f = fixture();
    f.setSession(session(SESSION, root));

    const rendered = f.render();

    expect(rendered).toContain('scope "workspace"');
    expect(rendered).not.toContain('scope "role"');
  });

  it("renders the urgent create recipe after a compaction without reading the summary", () => {
    const f = fixture();
    f.active.set(SESSION, "role-a");
    f.setSession(session(SESSION, root, [compactionEvent()]));

    const rendered = f.render();

    expect(rendered).toContain("## Session focus");
    expect(rendered).toContain(`Earlier history was compacted at ${COMPACTED_AT}`);
    expect(rendered).toContain("before continuing");
    expect(rendered).toContain("memory_write");
    expect(rendered).not.toContain(SUMMARY_BODY);
  });

  it("renders a fresh entry with its content, id and update instruction", () => {
    const f = fixture();
    f.active.set(SESSION, "role-a");
    f.setSession(session(SESSION, root));
    const id = seedFocus({ content: "Goal: ship focus. Decision: never store the summary." });

    const rendered = f.render();

    expect(rendered).toContain("## Session focus");
    expect(rendered).toContain("Goal: ship focus. Decision: never store the summary.");
    expect(rendered).toContain(`memory_update(id=${id})`);
    expect(rendered).not.toContain("refresh this entry");
    expect(rendered).not.toContain("Earlier history was compacted");
    expect(entryCount()).toBe(1);
  });

  it("asks for a refresh when the compaction is newer than the entry", () => {
    const f = fixture();
    f.active.set(SESSION, "role-a");
    const id = seedFocus({ content: "Goal: older focus." });
    const compactedAt = Date.now() + 60_000;
    f.setSession(session(SESSION, root, [compactionEvent(compactedAt)]));

    const rendered = f.render();

    expect(rendered).toContain(`Earlier history was compacted at ${new Date(compactedAt).toISOString()}`);
    expect(rendered).toContain(`refresh this entry with memory_update(id=${id})`);
    expect(rendered).toContain("keep what is still true");
    expect(rendered).toContain("never paste the summary or transcript");
    expect(rendered).toContain("Goal: older focus.");
    expect(rendered).not.toContain(SUMMARY_BODY);
  });

  it("truncates content by code point at maxChars with a marker", () => {
    const f = fixture({ maxChars: 12 });
    f.active.set(SESSION, "role-a");
    f.setSession(session(SESSION, root));
    seedFocus({ content: "0123456789ABCDEFGHIJ" });

    const rendered = f.render();

    expect(rendered).toContain("0123456789AB");
    expect(rendered).not.toContain("CDEFGHIJ");
    expect(rendered).toContain("… (truncated)");
  });

  it("does not leak a role-scoped entry into another role", () => {
    const f = fixture();
    f.active.set(SESSION, "role-a");
    f.setSession(session(SESSION, root));
    seedFocus({ roleId: "role-a", content: "ROLE-A SECRET FOCUS" });

    f.active.set(SESSION, "role-b");
    const rendered = f.render();

    expect(rendered).not.toContain("ROLE-A SECRET FOCUS");
    // Role B sees the create recipe for its own (missing) entry instead.
    expect(rendered).toContain("## Session focus");
    expect(rendered).toContain("memory_write");
  });

  it("shows a workspace-scoped entry to any role", () => {
    const f = fixture();
    f.active.set(SESSION, "role-a");
    f.setSession(session(SESSION, root));
    const id = seedFocus({ scope: "workspace", roleId: "shared", content: "SHARED FOCUS CONTENT" });

    f.active.set(SESSION, "role-b");
    const rendered = f.render();

    expect(rendered).toContain("SHARED FOCUS CONTENT");
    expect(rendered).toContain(`memory_update(id=${id})`);
  });

  it("renders '' when the role sets session_focus: false", () => {
    const f = fixture();
    f.first.config.memory = { session_focus: false };
    f.active.set(SESSION, "role-a");
    f.setSession(session(SESSION, root));
    seedFocus();

    expect(f.render()).toBe("");
  });

  it("renders '' without an absolute workspace", () => {
    const missing = fixture();
    missing.active.set(SESSION, "role-a");
    missing.setSession(session(SESSION, undefined));
    expect(missing.render()).toBe("");

    const relative = fixture();
    relative.active.set(SESSION, "role-a");
    relative.setSession(session(SESSION, "relative-workspace"));
    expect(relative.render()).toBe("");
  });

  it("renders '' for a graph worker without memory authorization", () => {
    const f = fixture();
    f.active.set(SESSION, "role-a");
    f.setSession(session(SESSION, root));
    f.workers.add(SESSION);

    expect(f.render()).toBe("");
    seedFocus();
    expect(f.render()).toBe("");
  });

  it("uses session focus for an authorized graph worker", () => {
    const f = fixture();
    f.setSession(session(SESSION, root));
    f.workers.add(SESSION);
    f.workerTools.push("memory_write", "memory_update", "memory_read");
    expect(f.render()).toContain("## Session focus");
    seedFocus();
    expect(f.render()).toContain("## Session focus");
    f.workerTools.length = 0;
    expect(f.render()).toBe("");
  });

  it("renders '' and never throws when the store cannot be opened", () => {
    const f = fixture();
    f.active.set(SESSION, "role-a");
    f.setSession(session(SESSION, root));
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

  it("has no write side effects across repeated renders", () => {
    const f = fixture();
    f.active.set(SESSION, "role-a");
    f.setSession(session(SESSION, root));
    const id = seedFocus({ content: "Stable focus." });
    expect(entryCount()).toBe(1);
    const before = readEntry(id);
    expect(before).not.toBeNull();

    f.render();
    f.render();
    f.render();

    expect(entryCount()).toBe(1);
    const after = readEntry(id);
    expect(after?.updated_at).toBe(before?.updated_at);
    expect(after?.access_count).toBe(before?.access_count);

    const empty = fixture();
    empty.active.set(SESSION, "role-a");
    empty.setSession(session(SESSION, root));
    for (let i = 0; i < 3; i++) empty.render();
    expect(entryCount()).toBe(1);
  });

  it("omits create/update instructions without write/update tools", () => {
    const noWrite = fixture();
    noWrite.first.config.tools = { memory_write: false, memory_update: false };
    noWrite.registered.delete("memory_write");
    noWrite.registered.delete("memory_update");
    noWrite.active.set(SESSION, "role-a");
    noWrite.setSession(session(SESSION, root));

    expect(noWrite.render()).toBe("");

    seedFocus({ content: "Visible focus without write tools." });
    const rendered = noWrite.render();
    expect(rendered).toContain("Visible focus without write tools.");
    expect(rendered).not.toContain("memory_write");
    expect(rendered).not.toContain("memory_update");

    const deniedUpdate = fixture();
    deniedUpdate.first.config.tools = { memory_update: false };
    deniedUpdate.registered.delete("memory_update");
    deniedUpdate.active.set(SESSION, "role-a");
    deniedUpdate.setSession(session(SESSION, root));
    const deniedRendered = deniedUpdate.render();
    expect(deniedRendered).toContain("Visible focus without write tools.");
    expect(deniedRendered).not.toContain("memory_update(id=");
  });

  it("treats a blank entry as one to fill and names its id", () => {
    const f = fixture();
    f.active.set(SESSION, "role-a");
    f.setSession(session(SESSION, root));
    const id = seedFocus({ content: "" });

    const rendered = f.render();

    expect(rendered).toContain("## Session focus");
    expect(rendered).toContain(id);
    expect(rendered).toContain("is empty");
    expect(rendered).toContain(`memory_update(id=${id})`);
    expect(entryCount()).toBe(1);
  });

  it("registers rolebox:focus through the prompt adapter", () => {
    const f = fixture();
    f.active.set(SESSION, "role-a");
    f.setSession(session(SESSION, root));
    seedFocus({ content: "Prompt-adapter focus content." });

    const contexts = new Map<string, DshSystemPromptContextEntry>();
    const adapter = new DshSystemPromptAdapter({
      registrar: new DshAgentRegistrar({
        subagents: { registerProvider: () => () => {}, getProvider: () => undefined, list: () => [] },
      }),
      activeRole: f.active,
      roleFunctionsMap: new Map(),
      directory: root,
      focusContext: context => f.focus.render(context),
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
      const provider = contexts.get("rolebox:focus");
      expect(provider).toBeDefined();
      expect(provider?.order).toBe(15);
      expect(provider?.interpolate).toBe(false);
      expect(provider?.text({ agent: { id: SESSION } })).toContain("Prompt-adapter focus content.");
    } finally {
      adapter.dispose();
    }
  });
});
