/**
 * Shared fixtures for the shipped host assembly's tests.
 *
 * One natural-completion graph, one plain (worker-submitted) graph, the
 * completion policy that authorizes the first, a temp-directory registry and
 * the host opener the cases share. Nothing here asserts anything: the cases
 * live beside their subjects (`outcome-host.test.ts` for the completion and
 * identity decisions, `outcome-projection.test.ts` for the record the operator
 * surfaces read).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../../src/graph/compiler/declaration-v3.ts";
import { OutcomeHost } from "../../../src/graph/host/outcome-host.ts";
import type { OutcomeDispatchRequest } from "../../../src/graph/outcome/runtime.ts";
import { createValidatorRegistry } from "../../../src/graph/outcome/validators.ts";
import {
  completionPolicyRefOf,
  createCompletionPolicyRegistry,
  type CompletionPolicyBody,
  type CompletionPolicyRegistry,
} from "../../../src/graph/policy/completion-policy.ts";

export const NOW = 1_700_000_000_000;
export const GRAPH_ID = "graph.outcome-host";
export const PLAIN_GRAPH_ID = "graph.outcome-host.plain";
export const POLICY_ID = "test.outcome-host";
export const POLICY_REVISION = "1";
export const EMPTY_VALIDATORS = createValidatorRegistry([]);

/** work -> ship, BOTH completing naturally, under {@link AUTHORIZED}. */
export function naturalDeclaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: GRAPH_ID,
    nodes: [
      {
        id: "work",
        agent: "agent.work",
        prompt: "Do the work.",
        outcomes: [{ id: "done" }],
        completion: { mode: "natural", outcome: "done" },
      },
      {
        id: "ship",
        agent: "agent.ship",
        prompt: "Ship it.",
        outcomes: [{ id: "shipped" }],
        completion: { mode: "natural", outcome: "shipped" },
      },
    ],
    edges: [{ from: "work", to: "ship", outcome: "done" }],
    completion_policy: { id: POLICY_ID, revision: POLICY_REVISION },
  };
}

/** One node with a plain (submitted) outcome: the worker settles it itself. */
export function plainDeclaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: PLAIN_GRAPH_ID,
    nodes: [
      { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }] },
    ],
    edges: [],
  };
}

export const POLICY_BODY: CompletionPolicyBody = {
  version: 1,
  default: "ungranted",
  rules: [
    { graphId: GRAPH_ID, nodeId: "work", outcome: "done", decision: "allow" },
    { graphId: GRAPH_ID, nodeId: "ship", outcome: "shipped", decision: "allow" },
  ],
};

export const AUTHORIZED: CompletionPolicyRegistry = createCompletionPolicyRegistry({
  policies: [
    {
      ref: completionPolicyRefOf({
        id: POLICY_ID,
        revision: POLICY_REVISION,
        body: POLICY_BODY,
      }),
      body: POLICY_BODY,
    },
  ],
});

const tmpDirs: string[] = [];

/** One temp directory, removed when the process exits. */
export function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

process.on("exit", () => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

/** One host over one store root, with the deliveries it was handed recorded. */
export function openHost(options: {
  readonly dir: string;
  readonly storeRoot: string;
  readonly deliveries: OutcomeDispatchRequest[];
  readonly declareInvocationIdentity?: boolean;
  readonly completionPolicies?: CompletionPolicyRegistry;
}): OutcomeHost {
  return OutcomeHost.open({
    workspaceDir: options.dir,
    storeRoot: options.storeRoot,
    deliver: (request) => {
      options.deliveries.push(request);
    },
    validators: EMPTY_VALIDATORS,
    durability: "memory",
    clock: () => NOW,
    ...(options.completionPolicies === undefined
      ? {}
      : { completionPolicies: options.completionPolicies }),
    ...(options.declareInvocationIdentity === undefined
      ? {}
      : { declareInvocationIdentity: options.declareInvocationIdentity }),
  });
}
