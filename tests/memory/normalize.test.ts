/**
 * CJK memory search normalization tests — the bigram index text, the tool
 * query rewrite and the prompt-focused extraction in `src/memory/normalize.ts`.
 *
 * Verifies:
 *   - `hasCjk` detects Han text and ignores Latin text
 *   - `memorySearchText` keeps the original title/content/tags verbatim and
 *     appends the deduped 2-character bigrams of every Han run
 *   - a single-character Han run indexes as itself
 *   - Latin-only text is indexed unchanged (no extra line, no bigrams)
 *   - `memorySearchQuery` passes non-Han queries through unchanged (explicit
 *     FTS syntax preserved), lowercases non-Han tokens, and puts Han bigrams
 *     ahead of Latin tokens in a mixed query
 *   - `memoryPromptQueryText` extracts the last labelled `Question:`/`Q:`/
 *     `Task:` line, a long prompt's final question paragraph, else the whole
 *     text
 *   - `memoryPromptTerms` turns the controlled E2E task into the entity terms
 *     (`cobalt`, `sentinel`, `蓝鲸`, `鲸哨`, `哨兵`) and drops function words
 *   - Han terms precede non-Han terms and survive a long Latin preamble/cap
 *   - `memoryPromptQuery` joins the terms with ` OR ` and quotes them
 *   - the tool's rewritten Han query and mixed query still match a store entry
 *
 * @module
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasCjk,
  memoryPromptQuery,
  memoryPromptQueryText,
  memoryPromptTerms,
  memorySearchQuery,
  memorySearchText,
} from "../../src/memory/normalize.ts";
import { MemoryStore } from "../../src/memory/store.ts";

/**
 * The controlled headless-E2E task that exposed the query starvation: a long
 * English instruction paragraph followed by the labelled question. The old
 * 24-term cap filled up with `this`, `is`, `a`, `controlled`, … so `cobalt`,
 * `sentinel` and the 蓝鲸 sentinel were never searched.
 */
const E2E_TASK = [
  "This is a controlled memory-recall check. Treat the following paragraphs as a fixed test harness: do not use outside knowledge, do not browse the web, do not ask clarifying questions, and do not write to memory. The workspace already contains every fact you need. Respond with a single short sentence, and name the memory entries you relied on so the operator can verify that retrieval found them.",
  'Question: what are the "cobalt sentinel" code and the "蓝鲸哨兵" number? Reply with both values on one line.',
].join("\n\n");

/** Preamble long enough (> 400 characters) to trigger paragraph extraction. */
const LONG_PREAMBLE = "Collect the deployment facts before answering. ".repeat(10);

describe("hasCjk", () => {
  it("detects Han characters, alone and inside mixed text", () => {
    expect(hasCjk("记忆")).toBe(true);
    expect(hasCjk("记忆机制")).toBe(true);
    expect(hasCjk("remember 记忆 now")).toBe(true);
  });

  it("returns false for Latin and punctuation-only text", () => {
    expect(hasCjk("remember the deployment")).toBe(false);
    expect(hasCjk("")).toBe(false);
    expect(hasCjk("!!! --- ???")).toBe(false);
  });
});

describe("memorySearchText", () => {
  it("keeps the original text and appends deduped bigrams of every Han run", () => {
    const title = "记忆机制";
    const content = "记忆机制需要保存关键点";
    const tags = ["上下文压缩"];
    const original = `${title}\n${content}\n${tags[0]}`;

    const indexed = memorySearchText({ title, content, tags });

    expect(indexed.startsWith(`${original}\n`)).toBe(true);
    const appended = indexed.slice(original.length + 1).split(" ");
    expect(appended).toEqual([
      "记忆",
      "忆机",
      "机制",
      "制需",
      "需要",
      "要保",
      "保存",
      "存关",
      "关键",
      "键点",
      "上下",
      "下文",
      "文压",
      "压缩",
    ]);
    // Dedupe: 记忆/忆机/机制 occur in both the title and the content.
    expect(appended.filter(term => term === "记忆")).toHaveLength(1);
  });

  it("indexes a single-character Han run as that character", () => {
    const indexed = memorySearchText({ title: "单字", content: "压", tags: [] });
    expect(indexed).toBe("单字\n压\n单字 压");
  });

  it("leaves Latin-only text unchanged", () => {
    const title = "Deployment checklist";
    const content = "Run the migration before restarting.";
    const tags = ["ops", "release"];

    expect(memorySearchText({ title, content, tags })).toBe(`${title}\n${content}\nops\nrelease`);
  });

  it("accepts an entry with no tags", () => {
    const indexed = memorySearchText({ title: "压缩策略", content: "上下文很重要" });
    expect(indexed.startsWith("压缩策略\n上下文很重要\n")).toBe(true);
    expect(indexed).toContain("压缩");
  });
});

describe("memorySearchQuery (tool query)", () => {
  it("passes a non-Han query through unchanged, preserving FTS syntax", () => {
    expect(memorySearchQuery("alpha AND beta")).toBe("alpha AND beta");
    expect(memorySearchQuery('"exact phrase" OR foo*')).toBe('"exact phrase" OR foo*');
    expect(memorySearchQuery("")).toBe("");
  });

  it("rewrites a longer Han term into quoted bigrams joined with OR", () => {
    expect(memorySearchQuery("记忆机制")).toBe('"记忆" OR "忆机" OR "机制"');
  });

  it("rewrites a two-character Han term into one quoted term", () => {
    expect(memorySearchQuery("压缩")).toBe('"压缩"');
  });

  it("puts Han bigrams ahead of lowercased Latin tokens", () => {
    expect(memorySearchQuery("Hello 记忆")).toBe('"记忆" OR "hello"');
    expect(memorySearchQuery("cobalt 蓝鲸哨兵 memory")).toBe(
      '"蓝鲸" OR "鲸哨" OR "哨兵" OR "cobalt" OR "memory"',
    );
    expect(memorySearchQuery("记忆 压")).toBe('"记忆" OR "压"');
  });

  it("drops duplicate terms", () => {
    expect(memorySearchQuery("记忆记忆")).toBe('"记忆" OR "忆记"');
  });

  it("caps one query at 24 terms", () => {
    const run = "记忆机制需要保存关键点上下文压缩后也要能找到新的策略部署流程说明";
    const terms = memorySearchQuery(run).split(" OR ");
    expect(terms).toHaveLength(24);
    expect(terms[0]).toBe('"记忆"');
  });

  it("treats Han punctuation as a run boundary", () => {
    expect(memorySearchQuery("记忆，机制。")).toBe('"记忆" OR "机制"');
  });
});

describe("memoryPromptQueryText", () => {
  it("extracts the labelled Question line of the controlled E2E task", () => {
    const queryText = memoryPromptQueryText(E2E_TASK);

    expect(queryText.startsWith("Question:")).toBe(true);
    expect(queryText).toContain('"cobalt sentinel"');
    expect(queryText).toContain('"蓝鲸哨兵"');
    expect(queryText).not.toContain("This is a controlled");
  });

  it("takes the text from the LAST labelled line", () => {
    const text = "Task: prepare the workspace\nQuestion: which sentinel number?";
    expect(memoryPromptQueryText(text)).toBe("Question: which sentinel number?");
  });

  it("recognizes a Chinese task label", () => {
    const text = "先阅读下面的说明。\n问题：蓝鲸哨兵的编号是多少？";
    expect(memoryPromptQueryText(text)).toBe("问题：蓝鲸哨兵的编号是多少？");
  });

  it("uses the final question paragraph of a long unlabelled prompt", () => {
    const task = "Which rollout gate applies to the 蓝鲸哨兵 release?";
    const text = `${LONG_PREAMBLE}\n\n${task}`;

    expect(text.length).toBeGreaterThan(400);
    expect(memoryPromptQueryText(text)).toBe(task);
  });

  it("falls back to the whole prompt when the final paragraph is not a question", () => {
    const text = `${LONG_PREAMBLE}\n\nNo question here.`;
    expect(memoryPromptQueryText(text)).toBe(text.trim());
  });

  it("falls back to the whole short prompt", () => {
    expect(memoryPromptQueryText("deployment migration")).toBe("deployment migration");
    expect(memoryPromptQueryText("  deployment migration  ")).toBe("deployment migration");
    expect(memoryPromptQueryText("   ")).toBe("");
  });
});

describe("memoryPromptTerms", () => {
  it("finds the E2E entities and drops the instruction/function words", () => {
    const terms = memoryPromptTerms(E2E_TASK);

    expect(terms).toContain("cobalt");
    expect(terms).toContain("sentinel");
    expect(terms).toContain("蓝鲸");
    expect(terms).toContain("鲸哨");
    expect(terms).toContain("哨兵");
    // The instruction preamble is gone and the question's function words are
    // filtered, so neither can spend the 24-term budget.
    for (const noise of ["this", "is", "a", "the", "what", "are"]) {
      expect(terms).not.toContain(noise);
    }
    // Han terms come before every Latin token.
    expect(terms.slice(0, 3)).toEqual(["蓝鲸", "鲸哨", "哨兵"]);
  });

  it("keeps Han bigrams ahead of a long Latin preamble", () => {
    const text = `${"context ".repeat(60)}cobalt 蓝鲸哨兵 sentinel`;
    const terms = memoryPromptTerms(text);

    expect(terms.slice(0, 3)).toEqual(["蓝鲸", "鲸哨", "哨兵"]);
    expect(terms).toContain("cobalt");
    expect(terms).toContain("sentinel");
  });

  it("caps the prompt term list at 24 with the Han terms surviving", () => {
    const hanRun = "蓝鲸哨兵编号甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥天地玄黄宇宙洪荒日月盈昃";
    const terms = memoryPromptTerms(`${"alpha beta gamma delta epsilon ".repeat(4)}${hanRun}`);

    expect(terms).toHaveLength(24);
    expect(terms[0]).toBe("蓝鲸");
    expect(terms).not.toContain("alpha");
  });

  it("keeps domain words, drops function words and one-character Latin tokens", () => {
    const terms = memoryPromptTerms("This is a controlled test of the memory code and its sentinel x");

    expect(terms).toEqual(["controlled", "test", "memory", "code", "sentinel"]);
  });

  it("keeps a one-character Han run as itself and dedupes", () => {
    expect(memoryPromptTerms("压 压 蓝鲸")).toEqual(["压", "蓝鲸"]);
  });
});

describe("memoryPromptQuery", () => {
  it("quotes the prompt terms and joins them with OR", () => {
    expect(memoryPromptQuery("cobalt sentinel")).toBe('"cobalt" OR "sentinel"');
    expect(memoryPromptQuery("this is the deployment migration")).toBe(
      '"deployment" OR "migration"',
    );
    expect(memoryPromptQuery(E2E_TASK)).toBe(
      '"蓝鲸" OR "鲸哨" OR "哨兵" OR "question" OR "cobalt" OR "sentinel" OR "code" OR "number" OR "reply" OR "both" OR "values" OR "one" OR "line"',
    );
  });

  it("returns '' when the prompt yields no term", () => {
    expect(memoryPromptQuery("   ")).toBe("");
    expect(memoryPromptQuery("this is a of the")).toBe("");
  });
});

describe("memorySearchQuery against a real store", () => {
  let root: string;

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("still matches a Han entry through the tool's rewritten query", async () => {
    root = mkdtempSync(join(tmpdir(), "rolebox-normalize-"));
    const store = await MemoryStore.create(root);
    try {
      const id = store.write({
        scope: "workspace",
        role_id: "shared",
        category: "fact",
        title: "蓝鲸哨兵",
        content: "蓝鲸哨兵的编号是 42-蓝鲸。",
        tags: ["哨兵"],
        relevance: "high",
        session_id: "seed-session",
        source_sessions: ["seed-session"],
      });

      expect(store.search({ query: "哨兵" }).map(entry => entry.id)).toEqual([id]);
      expect(store.search({ query: memorySearchQuery("蓝鲸哨兵") }).map(entry => entry.id)).toEqual([id]);
      expect(store.search({ query: memorySearchQuery("cobalt 蓝鲸哨兵") }).map(entry => entry.id)).toEqual([id]);
    } finally {
      store.close();
    }
  });
});
