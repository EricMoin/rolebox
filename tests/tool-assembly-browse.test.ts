
/**
 * `buildCanonicalTools({ browseUse })` — the browse family's assembly seam.
 *
 * The family is additive: it is merged only when the host's resolved gate says
 * so, it shares no namespace with any other tool, and the higher-precedence
 * layers (`extraTools`, `loopToolsOverride`) still win over it. A host that
 * owns a disposer can pass its own session manager, and the assembled tools
 * then bind to it instead of the per-worktree default.
 */

import { describe, it, expect } from "vitest";
import { buildCanonicalTools, type BuildToolsOptions } from "../src/platform/tool-assembly.ts";
import { opencodeCapabilities } from "../src/platform/capabilities.ts";
import { defineTool } from "../src/platform/ports/tool-factory.ts";
import type { BrowseSessionManager, BrowseSessionInfo } from "../src/browse/session.ts";
import { BROWSE_TOOL_NAMES } from "../src/loader/browse-grants.ts";
import { z } from "zod";
import type { CanonicalToolContext } from "../src/platform/types.ts";

function baseOptions(): BuildToolsOptions {
  return {
    resolvedRoles: [],
    directory: "/tmp/rolebox-browse-assembly",
    capabilities: opencodeCapabilities(),
  };
}

function browseKeys(tools: Record<string, unknown>): string[] {
  return Object.keys(tools).filter(name => name.startsWith("browse_")).sort();
}

function toolContext(): CanonicalToolContext {
  return {
    sessionID: "sess-browse",
    messageID: "msg-browse",
    agent: "",
    directory: "/tmp/rolebox-browse-assembly",
    worktree: "/tmp/rolebox-browse-assembly",
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  };
}

function dummy(name: string) {
  return defineTool({
    description: `Dummy ${name}`,
    args: { text: z.string().optional() },
    async execute() {
      return `dummy ${name}`;
    },
  });
}

describe("buildCanonicalTools — browse family", () => {
  it("registers nothing unless the resolved gate is on", () => {
    for (const browseUse of [undefined, false]) {
      const tools = buildCanonicalTools({ ...baseOptions(), ...(browseUse === undefined ? {} : { browseUse }) });
      expect(browseKeys(tools)).toEqual([]);
      // The rest of the assembled surface is untouched.
      expect(tools.hashline_read).toBeDefined();
      expect(tools.web_fetch).toBeDefined();
    }
  });

  it("registers exactly the 22 declared names when the gate is on", () => {
    const tools = buildCanonicalTools({ ...baseOptions(), browseUse: true });
    expect(browseKeys(tools)).toEqual([...BROWSE_TOOL_NAMES].sort());
    for (const name of BROWSE_TOOL_NAMES) {
      expect(tools[name], name).toBeDefined();
      expect(typeof tools[name]!.execute).toBe("function");
    }
  });

  it("is additive beside the computer family", () => {
    const tools = buildCanonicalTools({ ...baseOptions(), computerUse: true, browseUse: true });
    expect(browseKeys(tools)).toEqual([...BROWSE_TOOL_NAMES].sort());
    expect(Object.keys(tools).filter(name => name.startsWith("computer_")).length).toBeGreaterThan(0);
    // No browse name can shadow a computer name (disjoint namespaces).
    for (const name of BROWSE_TOOL_NAMES) expect(name.startsWith("computer_")).toBe(false);
  });

  it("stays below extraTools and loopToolsOverride in precedence", () => {
    const extraOpen = dummy("browse_open");
    const loopOpen = dummy("browse_open");
    const withExtra = buildCanonicalTools({
      ...baseOptions(),
      browseUse: true,
      extraTools: { browse_open: extraOpen },
    });
    expect(withExtra.browse_open).toBe(extraOpen);
    // A name the override does not mention stays the assembled family member.
    expect(withExtra.browse_snapshot).toBeDefined();
    expect(withExtra.browse_snapshot).not.toBe(extraOpen);

    const withLoop = buildCanonicalTools({
      ...baseOptions(),
      browseUse: true,
      extraTools: { browse_open: extraOpen },
      loopToolsOverride: { browse_open: loopOpen },
    });
    expect(withLoop.browse_open).toBe(loopOpen);
  });

  it("binds the family to a host-supplied manager instead of the per-worktree default", async () => {
    // Only the two members browse_status reads are implemented; this double
    // exists to prove WHICH manager the assembled tool reached, not to browse.
    const calls: string[] = [];
    const info: BrowseSessionInfo = {
      session: "sess-browse",
      engine: null,
      attached: false,
      pages: [],
      active: null,
    };
    const manager = {
      status() {
        calls.push("status");
        return { available: false, reason: "the injected manager answered" };
      },
      async info(session: string) {
        calls.push(`info:${session}`);
        return info;
      },
    } as unknown as BrowseSessionManager;

    const tools = buildCanonicalTools({ ...baseOptions(), browseUse: true, browseManager: manager });
    const result = await tools.browse_status!.execute({}, toolContext());
    const text = typeof result === "string" ? result : String((result as { output?: unknown }).output ?? "");
    expect(calls).toEqual(["status", "info:sess-browse"]);
    expect(text).toContain("the injected manager answered");
  });
});
