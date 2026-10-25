/**
 * A browser-free harness for the `browse_*` tool family.
 *
 * The tools are exercised end to end against the real {@link BrowseSessionManager}
 * and the in-memory driver port from `tests/browse/fixtures/fake-driver.ts`, so a
 * test covers the tool layer, the session layer and the result layer together
 * without launching Playwright or touching a real page.
 *
 * The harness owns one temporary worktree per test (screenshots, downloads and
 * uploads resolve against it), a factory that records every launch, and a tool
 * record built with the injected manager. `call()` normalizes the canonical
 * `ToolResult` union down to its structured branch and fails loudly when a tool
 * answers with a bare string, because every browse result must be structured.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CanonicalToolContext,
  CanonicalToolDef,
  ToolAttachment,
  ToolResult,
} from "../../../src/platform/types.ts";
import { BrowseSessionManager } from "../../../src/browse/session.ts";
import type { DriverStatus } from "../../../src/browse/types.ts";
import type { SnapshotRef } from "../../../src/browse/types.ts";
import { createBrowseTools } from "../../../src/browse/tools.ts";
import { FakeDriverFactory, FakePageDriver } from "../fixtures/fake-driver.ts";

/** The structured branch of a tool result. */
export interface StructuredToolResult {
  title?: string;
  output: string;
  metadata?: Record<string, unknown>;
  attachments?: ToolAttachment[];
}

/** The page URL every harness page starts at. */
export const HARNESS_URL = "https://example.com/app";

/** The page title every harness page starts at. */
export const HARNESS_TITLE = "Example app";

/** The refs the default snapshot assigns. */
export const HARNESS_REFS: SnapshotRef[] = [
  { ref: "e1", role: "button", name: "Save" },
  { ref: "e2", role: "textbox", name: "Email" },
  { ref: "e3", role: "combobox", name: "Plan" },
];

/** The snapshot text that matches {@link HARNESS_REFS}. */
export const HARNESS_SNAPSHOT = [
  '- button "Save" [ref=e1]',
  '- textbox "Email" [ref=e2]',
  '- combobox "Plan" [ref=e3]',
].join("\n");

/** A factory that adds the driver-status fields the tools report. */
export class HarnessDriverFactory extends FakeDriverFactory {
  version: string | undefined;
  chromiumInstalled: boolean | undefined;

  constructor(options: ConstructorParameters<typeof FakeDriverFactory>[0] & {
    version?: string;
    chromiumInstalled?: boolean;
  } = {}) {
    super(options);
    this.version = options.version;
    this.chromiumInstalled = options.chromiumInstalled;
  }

  override status(): DriverStatus {
    const base = super.status();
    return {
      ...base,
      ...(this.version === undefined ? {} : { version: this.version }),
      ...(this.chromiumInstalled === undefined ? {} : { chromiumInstalled: this.chromiumInstalled }),
    };
  }
}

/** The options a harness accepts. */
export interface BrowseHarnessOptions {
  available?: boolean;
  reason?: string;
  version?: string;
  chromiumInstalled?: boolean;
  /** Adjust each fake page after creation (URL, title, snapshot, cookies, ...). */
  configurePage?: (page: FakePageDriver, index: number) => void;
}

/** One test's tool surface, manager, factory and worktree. */
export interface BrowseHarness {
  readonly worktree: string;
  readonly factory: HarnessDriverFactory;
  readonly manager: BrowseSessionManager;
  readonly tools: Record<string, CanonicalToolDef>;
  /** A canonical tool context bound to this worktree. */
  context(options?: { sessionID?: string; abort?: AbortSignal }): CanonicalToolContext;
  /** Invoke one tool and normalize its result. */
  call(name: string, args?: unknown, context?: CanonicalToolContext): Promise<StructuredToolResult>;
  /** The first browser's page, or the page at one index. */
  page(index?: number): FakePageDriver;
  /** Close the manager and delete the worktree. */
  cleanup(): Promise<void>;
}

/**
 * Build one harness.
 *
 * The default page is already navigated to {@link HARNESS_URL} with a snapshot
 * whose refs are {@link HARNESS_REFS}; a test that needs different content
 * overrides `configurePage`.
 */
export function createBrowseHarness(options: BrowseHarnessOptions = {}): BrowseHarness {
  const worktree = mkdtempSync(join(tmpdir(), "rolebox-browse-tools-"));
  const factory = new HarnessDriverFactory({
    ...(options.available === undefined ? {} : { available: options.available }),
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.chromiumInstalled === undefined ? {} : { chromiumInstalled: options.chromiumInstalled }),
    configurePage(page, index) {
      page.currentUrl = HARNESS_URL;
      page.titleText = HARNESS_TITLE;
      page.snapshotText = HARNESS_SNAPSHOT;
      page.snapshotRefs = HARNESS_REFS.map(ref => ({ ...ref }));
      options.configurePage?.(page, index);
    },
  });
  const manager = new BrowseSessionManager({ worktree, driverFactory: factory, idleTtlMs: 0 });
  const tools = createBrowseTools({ manager });

  const harness: BrowseHarness = {
    worktree,
    factory,
    manager,
    tools,
    context(contextOptions = {}) {
      const controller = new AbortController();
      return {
        sessionID: contextOptions.sessionID ?? "session-tools",
        messageID: "message-1",
        agent: "agent",
        directory: worktree,
        worktree,
        abort: contextOptions.abort ?? controller.signal,
        metadata: () => undefined,
        ask: async () => undefined,
      };
    },
    async call(name, args = {}, context) {
      const tool = tools[name];
      if (tool === undefined) throw new Error(`unknown browse tool ${name}`);
      const result: ToolResult = await tool.execute(args as never, context ?? harness.context());
      return asStructuredResult(result);
    },
    page(index = 0) {
      const driver = factory.drivers[0];
      if (driver === undefined) throw new Error("no browser has launched yet");
      const page = driver.pages[index];
      if (page === undefined) throw new Error(`the browser has no page at index ${index}`);
      return page;
    },
    async cleanup() {
      await manager.dispose();
      rmSync(worktree, { recursive: true, force: true });
    },
  };
  return harness;
}

/** Narrow a canonical tool result to its structured branch. */
export function asStructuredResult(result: ToolResult): StructuredToolResult {
  if (typeof result === "string") {
    throw new Error(`expected a structured tool result, received the string ${JSON.stringify(result)}`);
  }
  if (result.metadata === undefined) {
    throw new Error("expected result metadata; every browse tool reports it");
  }
  return result;
}

/** Read `metadata` with the fields every browse result promises. */
export function metadataOf(result: StructuredToolResult): Record<string, unknown> {
  const metadata = result.metadata;
  if (metadata === undefined) throw new Error("the result has no metadata");
  return metadata;
}
