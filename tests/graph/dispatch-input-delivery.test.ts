/// <reference types="bun-types" />

/**
 * The dispatch path materializes a worker's inputs, or does not launch (D7).
 *
 * WHAT THIS FILE PINS, and why it is not the materializer's own unit test: the
 * DECISION to launch lives in \`HostOutcomeDispatch.create\`, the one path every
 * window takes (a first dispatch, a successor, a retry, a recovery). A view that
 * the materializer can build but the dispatch path never hands over is not
 * delivery, and a view that fails to build must NOT become a started execution —
 * so these cases drive the real adapter over a real content store and a real
 * execution index and assert on what the delivery seam actually received.
 *
 * STRENGTH: adapter + real store, one process. No platform and no worker run
 * here, so this is adapter-level evidence and not host evidence.
 *
 * @module
 */

import { describe, it, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HostOutcomeDispatch,
  type HostDispatchDelivery,
} from "../../src/graph/host/dispatch-host.ts";
import { HostExecutionIndex } from "../../src/graph/host/execution-index.ts";
import {
  inputConsumerDirectory,
  InputViewRefusalError,
  INPUT_VIEW_MANIFEST_FILE,
  type DeliveredInputView,
} from "../../src/graph/host/input-view.ts";
import {
  dispatchEffectKeyOf,
  type OutcomeDispatchRequest,
} from "../../src/graph/outcome/dispatch-effects.ts";
import type { ResolvedInput } from "../../src/graph/outcome/inputs.ts";
import {
  artifactIdOf,
  artifactObjectPath,
  digestOf,
  putArtifact,
} from "../../src/graph/store/artifacts.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const GRAPH = "p42.dispatch-input-delivery";
const REF = "evidence/report.json";
const A = Buffer.from('{"report":"A"}', "utf-8");
const B = Buffer.from('{"report":"B"}', "utf-8");

interface Roots {
  readonly root: string;
  readonly contentStoreRoot: string;
  readonly deliveryRoot: string;
}

async function withRoots<T>(fn: (roots: Roots) => T | Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "p42-dispatch-inputs-"));
  try {
    const contentStoreRoot = join(root, "host-store");
    mkdirSync(contentStoreRoot, { recursive: true });
    return await fn({
      root,
      contentStoreRoot,
      deliveryRoot: join(contentStoreRoot, "input-deliveries"),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** What one delivery seam recorded, per call. */
interface RecordedDelivery {
  readonly request: OutcomeDispatchRequest;
  readonly inputView: DeliveredInputView | undefined;
}

/** One adapter over one content store, with everything it was handed recorded. */
function openAdapter(options: {
  readonly contentStoreRoot: string;
  readonly deliveryRoot: string | undefined;
  readonly indexRoot: string;
  readonly recorded: RecordedDelivery[];
  readonly onDeliver?: () => void;
}): HostOutcomeDispatch {
  const deliver: HostDispatchDelivery = (request, _effect, _invocation, inputView) => {
    options.recorded.push({ request, inputView });
    options.onDeliver?.();
  };
  return new HostOutcomeDispatch({
    executions: HostExecutionIndex.open({ root: options.indexRoot }),
    deliver,
    ...(options.deliveryRoot === undefined
      ? {}
      : {
          inputDelivery: {
            contentStoreRoot: options.contentStoreRoot,
            deliveryRoot: options.deliveryRoot,
          },
        }),
  });
}

/** One dispatch request whose node DECLARES the given inputs. */
function requestOf(inputs: readonly ResolvedInput[]): OutcomeDispatchRequest {
  return {
    graphId: GRAPH,
    planRevision: "rev-1",
    nodeId: "review",
    attemptId: "review#2",
    agent: "agent.review",
    prompt: "Review the work.",
    credential: "credential-review-2",
    inputs,
  };
}

/** One resolved input carrying a payload and the given retained revisions. */
function inputOf(
  artifacts: readonly { readonly ref: string; readonly artifactId: string; readonly digest: string; readonly size: number }[],
  payload: ResolvedInput["payload"] = { kind: "value", value: { report: "A" } },
): ResolvedInput {
  return { from: "work", outcome: "done", attemptId: "work#1", payload, artifacts };
}

// ── The delivered view ──────────────────────────────────────────────────────

describe("HostOutcomeDispatch — the delivery seam receives a real input view", () => {
  it("hands over the retained revision as a readable file, once", async () => {
    await withRoots((roots) => {
      const deposit = putArtifact(roots.contentStoreRoot, A);
      if (deposit.kind !== "deposited") throw new Error("fixture: " + deposit.reason);
      const recorded: RecordedDelivery[] = [];
      const adapter = openAdapter({
        contentStoreRoot: roots.contentStoreRoot,
        deliveryRoot: roots.deliveryRoot,
        indexRoot: join(roots.root, "index"),
        recorded,
      });
      const request = requestOf([
        inputOf([{ ref: REF, artifactId: deposit.artifactId, digest: deposit.digest, size: deposit.size }]),
      ]);

      adapter.create(request, dispatchEffectKeyOf(GRAPH, "review#2"));

      expect(recorded).toHaveLength(1);
      const view = recorded[0]?.inputView;
      expect(view).toBeDefined();
      if (view === undefined) return;
      // THE WORKER'S VIEW: the producer, its outcome, the producing attempt, the
      // accepted data, and a file it can open.
      expect(view.entries).toHaveLength(1);
      expect(view.entries[0]?.from).toBe("work");
      expect(view.entries[0]?.outcome).toBe("done");
      expect(view.entries[0]?.attemptId).toBe("work#1");
      expect(view.entries[0]?.payload).toEqual({ kind: "value", value: { report: "A" } });
      const file = view.entries[0]?.artifacts[0];
      expect(file).toBeDefined();
      if (file === undefined) return;
      expect(readFileSync(file.path).equals(A)).toBe(true);
      expect(digestOf(readFileSync(file.path))).toBe(deposit.digest);
      expect(readdirSync(view.directory).sort()).toEqual(
        [file.file, INPUT_VIEW_MANIFEST_FILE].sort(),
      );
      // THE REQUEST ITSELF IS UNCHANGED: the view is delivered BESIDE the
      // runtime's own decision, not written into it.
      expect(recorded[0]?.request.inputs).toEqual(request.inputs);
    });
  });

  it("hands over nothing for a node that declares no inputs", async () => {
    await withRoots((roots) => {
      const recorded: RecordedDelivery[] = [];
      const adapter = openAdapter({
        contentStoreRoot: roots.contentStoreRoot,
        deliveryRoot: roots.deliveryRoot,
        indexRoot: join(roots.root, "index"),
        recorded,
      });
      adapter.create(requestOf([]), dispatchEffectKeyOf(GRAPH, "review#2"));
      adapter.create(
        { ...requestOf([]), attemptId: "review#3", inputs: undefined },
        dispatchEffectKeyOf(GRAPH, "review#3"),
      );
      expect(recorded.map((entry) => entry.inputView)).toEqual([undefined, undefined]);
      // AND NOTHING WAS PUBLISHED FOR THEM.
      expect(existsSync(roots.deliveryRoot)).toBe(false);
    });
  });
});

// ── Refusals ────────────────────────────────────────────────────────────────

describe("HostOutcomeDispatch — a view that cannot be built launches nothing", () => {
  it("refuses a missing object, names the input, and starts no execution", async () => {
    await withRoots((roots) => {
      const recorded: RecordedDelivery[] = [];
      const adapter = openAdapter({
        contentStoreRoot: roots.contentStoreRoot,
        deliveryRoot: roots.deliveryRoot,
        indexRoot: join(roots.root, "index"),
        recorded,
      });
      const missing = {
        ref: REF,
        artifactId: artifactIdOf("f".repeat(64)),
        digest: "f".repeat(64),
        size: 12,
      };
      const request = requestOf([inputOf([missing])]);
      const effect = dispatchEffectKeyOf(GRAPH, "review#2");

      let caught: unknown;
      try {
        adapter.create(request, effect);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(InputViewRefusalError);
      if (!(caught instanceof InputViewRefusalError)) return;
      expect(caught.refusals.map((refusal) => refusal.code)).toEqual([
        "input-artifact-unreadable",
      ]);
      expect(caught.refusals[0]?.from).toBe("work");
      expect(caught.refusals[0]?.ref).toBe(REF);
      expect(caught.refusals[0]?.artifactId).toBe(missing.artifactId);
      expect(caught.message).toContain(missing.artifactId);

      // NOTHING WAS LAUNCHED, and the claim the refusal released leaves the
      // effect with no execution: a later window creates exactly once.
      expect(recorded).toEqual([]);
      expect(adapter.lookup(effect).kind).toBe("absent");
      expect(existsSync(inputConsumerDirectory(roots.deliveryRoot, GRAPH, "review#2"))).toBe(false);
    });
  });

  it("refuses a tampered object, and the repaired store delivers the SAME consumer directory", async () => {
    await withRoots((roots) => {
      const deposit = putArtifact(roots.contentStoreRoot, A);
      if (deposit.kind !== "deposited") throw new Error("fixture: " + deposit.reason);
      const retainedRecord = {
        ref: REF,
        artifactId: deposit.artifactId,
        digest: deposit.digest,
        size: deposit.size,
      };
      writeFileSync(artifactObjectPath(roots.contentStoreRoot, deposit.artifactId), B);
      const recorded: RecordedDelivery[] = [];
      const adapter = openAdapter({
        contentStoreRoot: roots.contentStoreRoot,
        deliveryRoot: roots.deliveryRoot,
        indexRoot: join(roots.root, "index"),
        recorded,
      });
      const request = requestOf([inputOf([retainedRecord])]);
      const effect = dispatchEffectKeyOf(GRAPH, "review#2");

      expect(() => adapter.create(request, effect)).toThrow(InputViewRefusalError);
      expect(recorded).toEqual([]);
      expect(adapter.lookup(effect).kind).toBe("absent");

      // THE RECOVERY WINDOW: the store is put back to what the acceptance
      // retained, the SAME dispatch is delivered, and the consumer's directory is
      // the one the refused attempt never created.
      writeFileSync(artifactObjectPath(roots.contentStoreRoot, deposit.artifactId), A);
      adapter.create(request, effect);
      expect(recorded).toHaveLength(1);
      const view = recorded[0]?.inputView;
      expect(view?.directory).toBe(
        inputConsumerDirectory(roots.deliveryRoot, GRAPH, "review#2"),
      );
      const file = view?.entries[0]?.artifacts[0];
      expect(readFileSync(file?.path ?? "").equals(A)).toBe(true);
    });
  });

  it("refuses by name when the host was given no delivery location", async () => {
    await withRoots((roots) => {
      const deposit = putArtifact(roots.contentStoreRoot, A);
      if (deposit.kind !== "deposited") throw new Error("fixture: " + deposit.reason);
      const recorded: RecordedDelivery[] = [];
      const adapter = openAdapter({
        contentStoreRoot: roots.contentStoreRoot,
        deliveryRoot: undefined,
        indexRoot: join(roots.root, "index"),
        recorded,
      });
      let caught: unknown;
      try {
        adapter.create(
          requestOf([
            inputOf([
              {
                ref: REF,
                artifactId: deposit.artifactId,
                digest: deposit.digest,
                size: deposit.size,
              },
            ]),
          ]),
          dispatchEffectKeyOf(GRAPH, "review#2"),
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(InputViewRefusalError);
      if (!(caught instanceof InputViewRefusalError)) return;
      expect(caught.refusals.map((refusal) => refusal.code)).toEqual([
        "input-delivery-unavailable",
      ]);
      expect(recorded).toEqual([]);
    });
  });

  it("keeps each consumer's files under its own attempt directory", async () => {
    await withRoots((roots) => {
      const deposit = putArtifact(roots.contentStoreRoot, A);
      if (deposit.kind !== "deposited") throw new Error("fixture: " + deposit.reason);
      const record = {
        ref: REF,
        artifactId: deposit.artifactId,
        digest: deposit.digest,
        size: deposit.size,
      };
      const recorded: RecordedDelivery[] = [];
      const adapter = openAdapter({
        contentStoreRoot: roots.contentStoreRoot,
        deliveryRoot: roots.deliveryRoot,
        indexRoot: join(roots.root, "index"),
        recorded,
      });
      adapter.create(requestOf([inputOf([record])]), dispatchEffectKeyOf(GRAPH, "review#2"));
      adapter.create(
        { ...requestOf([inputOf([record])]), attemptId: "audit#3" },
        dispatchEffectKeyOf(GRAPH, "audit#3"),
      );

      const first = recorded[0]?.inputView;
      const second = recorded[1]?.inputView;
      expect(first?.directory).not.toBe(second?.directory);
      expect(JSON.stringify(first)).not.toContain(second?.directory ?? "\u0000");
      expect(JSON.stringify(second)).not.toContain(first?.directory ?? "\u0000");
      expect(readFileSync(first?.entries[0]?.artifacts[0]?.path ?? "").equals(A)).toBe(true);
      expect(readFileSync(second?.entries[0]?.artifacts[0]?.path ?? "").equals(A)).toBe(true);
    });
  });
});
