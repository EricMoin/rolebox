/**
 * Rolebox Tool-call row catalog tests.
 *
 * The rows themselves are React components (covered by the client-plugin test
 * through the slot registrations); what THIS file pins is the data the rows
 * render from, which is where a silent regression hurts:
 *
 *   - the language dictionaries carry the SAME key set (a key missing in `zh`
 *     would paint a raw `verb.declare.run` in the Chinese UI), and the two
 *     templates compose the title the user asked for ("正在声明图结构" /
 *     "Declaring graph");
 *   - every descriptor's verb and noun resolves in BOTH languages, so a typo in
 *     the table fails here instead of at render;
 *   - the salient-argument projection shows ids/counts/URLs and never echoes a
 *     payload that may be a secret (`computer_type` typed text);
 *   - the registration list covers every rolebox family and excludes the wire
 *     names the HOST owns, whose cards rolebox must not replace.
 *
 * @module
 */

import { describe, expect, it } from "vitest";
import {
  TOOL_DESCRIPTORS,
  ROLEBOX_TOOL_VIEW_NAMES,
  TOOL_VIEW_VOCABULARY,
} from "../../src/platform/adapters/dsh/web-ui/tool-view-descriptors.ts";
import {
  NOUN_COPY,
  TOOL_VIEW_NS,
  VERB_COPY,
  en,
  zh,
  type ToolViewDictionary,
} from "../../src/platform/adapters/dsh/web-ui/tool-view-locales.ts";

/** Bind one dictionary the way the host's `t` seat does (with `{name}` interpolation). */
function bind(dictionary: ToolViewDictionary) {
  return (key: string, params?: Record<string, unknown>): string => {
    const template = dictionary[key] ?? key;
    if (params === undefined) return template;
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match);
  };
}

/** Compose the running-row title exactly as the row component does. */
function runningTitle(toolName: string, dictionary: ToolViewDictionary): string {
  const descriptor = TOOL_DESCRIPTORS[toolName]!;
  const t = bind(dictionary);
  return t("title.run", {
    verb: t(`verb.${descriptor.verb}.run`),
    noun: t(`noun.${descriptor.noun}`),
  });
}

/** Compose the completed-row title exactly as the row component does. */
function doneTitle(toolName: string, dictionary: ToolViewDictionary): string {
  const descriptor = TOOL_DESCRIPTORS[toolName]!;
  const t = bind(dictionary);
  return t("title.done", {
    verb: t(`verb.${descriptor.verb}.done`),
    noun: t(`noun.${descriptor.noun}`),
  });
}

describe("rolebox tool-call rows — copy", () => {
  it("registers the en + zh dictionaries under one namespace", () => {
    expect(TOOL_VIEW_NS).toBe("rolebox.tools");
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });

  it("derives every verb and noun key in both languages", () => {
    for (const verb of Object.keys(VERB_COPY)) {
      for (const form of ["run", "done"] as const) {
        expect(en[`verb.${verb}.${form}`]).toBeTypeOf("string");
        expect(zh[`verb.${verb}.${form}`]).toBeTypeOf("string");
      }
    }
    for (const noun of Object.keys(NOUN_COPY)) {
      expect(en[`noun.${noun}`]).toBeTypeOf("string");
      expect(zh[`noun.${noun}`]).toBeTypeOf("string");
    }
  });

  it("composes the running and completed Chinese graph title", () => {
    expect(runningTitle("graph_declare", zh)).toBe("正在声明图结构");
    expect(doneTitle("graph_declare", zh)).toBe("已声明图结构");
    expect(runningTitle("team_send_event", zh)).toBe("正在发送团队事件");
    expect(runningTitle("browse_open", zh)).toBe("正在打开页面");
  });

  it("composes the English graph title", () => {
    expect(runningTitle("graph_declare", en)).toBe("Declaring graph");
    expect(doneTitle("graph_declare", en)).toBe("Declared graph");
    expect(runningTitle("computer_screenshot", en)).toBe("Capturing screen");
  });
});

describe("rolebox tool-call rows — descriptors", () => {
  it("resolves every descriptor's verb and noun in both languages", () => {
    for (const [toolName, descriptor] of Object.entries(TOOL_DESCRIPTORS)) {
      expect(VERB_COPY, `unknown verb for ${toolName}`).toHaveProperty(descriptor.verb);
      expect(NOUN_COPY, `unknown noun for ${toolName}`).toHaveProperty(descriptor.noun);
      expect(en[`verb.${descriptor.verb}.run`], `en verb for ${toolName}`).toBeTypeOf("string");
      expect(zh[`verb.${descriptor.verb}.run`], `zh verb for ${toolName}`).toBeTypeOf("string");
    }
  });

  it("keeps the registration list and the descriptor table identical", () => {
    expect(ROLEBOX_TOOL_VIEW_NAMES).toEqual(Object.keys(TOOL_DESCRIPTORS));
    // The table is the product surface: an accidental wipe must fail loudly.
    expect(ROLEBOX_TOOL_VIEW_NAMES.length).toBeGreaterThanOrEqual(70);
    expect(new Set(ROLEBOX_TOOL_VIEW_NAMES).size).toBe(ROLEBOX_TOOL_VIEW_NAMES.length);
  });

  it("covers every rolebox family", () => {
    const names = new Set(ROLEBOX_TOOL_VIEW_NAMES);
    for (const name of [
      "graph_declare", "graph_status", "graph_control", "graph_audit", "graph_submit_outcome",
      "memory_write", "memory_recall", "memory_read",
      "session_read", "session_diff", "session_fork",
      "team_create", "team_send_event", "team_status",
      "loop_start", "loop_output",
      "hashline_read", "hashline_edit",
      "asset_search", "asset_validate", "reference_search",
      "web_read", "signal", "interactive_terminal", "load_role_skill",
      "computer_screenshot", "computer_click", "browse_open", "browse_snapshot",
    ]) {
      expect(names, `${name} is missing from the row table`).toContain(name);
    }
  });

  it("leaves host-owned wire names to the host card", () => {
    for (const hostName of ["web_search", "web_fetch", "session_search", "read", "write", "bash"]) {
      expect(ROLEBOX_TOOL_VIEW_NAMES).not.toContain(hostName);
    }
  });
});

describe("rolebox tool-call rows — argument summaries", () => {
  const t = bind(zh);

  it("summarizes a graph declaration by id and size (JSON text or object)", () => {
    const asObject = {
      name: "build",
      nodes: [{ id: "a" }, { id: "b" }],
      edges: [{ from: "a", to: "b", outcome: "ok" }],
      loop_groups: [{ id: "l", nodes: ["a", "b"] }],
    };
    const descriptor = TOOL_DESCRIPTORS.graph_declare!;
    expect(descriptor.summarize!({ declaration: asObject }, t))
      .toBe("build · 2 个节点 · 1 条边 · 1 个循环组");
    expect(descriptor.summarize!({ declaration: JSON.stringify(asObject) }, t))
      .toBe("build · 2 个节点 · 1 条边 · 1 个循环组");
    // Malformed declaration text degrades to no extra line, never a throw.
    expect(descriptor.summarize!({ declaration: "{not json" }, t)).toBeUndefined();
  });

  it("summarizes ids, URLs and commands", () => {
    expect(TOOL_DESCRIPTORS.memory_write!.summarize!({ title: "Deploy notes" }, t)).toBe("Deploy notes");
    expect(TOOL_DESCRIPTORS.browse_open!.summarize!({ url: "http://127.0.0.1:3080/x" }, t))
      .toBe("http://127.0.0.1:3080/x");
    expect(TOOL_DESCRIPTORS.graph_control!.summarize!({ graph_id: "build", command: "cancel" }, t))
      .toBe("build · cancel");
    expect(TOOL_DESCRIPTORS.load_role_skill!.summarize!({ name: "typescript-graph-workflow" }, t))
      .toBe("typescript-graph-workflow");
  });

  it("never echoes payload text that may be a secret", () => {
    expect(TOOL_DESCRIPTORS.computer_type!.summarize).toBeUndefined();
    expect(TOOL_DESCRIPTORS.browse_type!.summarize!({ text: "hunter2", target: "input[name=password]" }, t))
      .toBe("input[name=password]");
  });

  it("clips a long command summary to one line", () => {
    const long = `echo ${"x".repeat(400)}`;
    const summary = TOOL_DESCRIPTORS.graph_worker_exec!.summarize!({ command: long }, t)!;
    expect(summary.length).toBeLessThanOrEqual(120);
    expect(summary.endsWith("…")).toBe(true);
  });
});
