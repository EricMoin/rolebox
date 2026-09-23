/**
 * P2 — the three principals, and the worker binding that keeps them apart.
 *
 * WHY THIS FILE EXISTS. §8.1 found that both shipped entries declared no
 * identity at all: the attempt was bound to the DECLARING invocation (a
 * different subject from the worker), the platform's real child session was
 * dropped, and a submission's session was therefore not an authentication
 * factor. This file pins the replacement boundary:
 *
 * - the HOST answers what it CONFIRMED it dispatched an attempt AS — the real
 *   execution id and the child session — from its durable execution row, and
 *   that answer survives a restart;
 * - a submission is judged by the SESSION it actually arrives from, against
 *   that binding (the ingress cases live in
 *   `submit-ingress-credentials.test.ts`, which drives the shipped tool face);
 * - the COMPLETION authority authenticates its own execution source instead of
 *   impersonating the declaring principal, and refuses a completion with no
 *   confirmed execution rather than settling one on an in-process observation.
 *
 * The pure half is here too: every reading the contract can produce (identified
 * / none / refused), and every refusal the binding check can name. No case
 * writes outside a temp directory.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import type { CompletionPolicyRegistry } from "../../src/graph/policy/completion-policy.ts";
import { hostWorkerIdentityCapability } from "../../src/graph/host/identity.ts";
import { OutcomeHost } from "../../src/graph/host/outcome-host.ts";
import { SqliteAcceptanceLedger } from "../../src/graph/ledger/sqlite-ledger.ts";
import {
  HOST_IDENTITY_UNAVAILABLE_CODE,
  HOST_WORKER_ABSENT_CODE,
  HOST_WORKER_SESSION_MISMATCH_CODE,
  HOST_WORKER_UNAVAILABLE_CODE,
  HOST_WORKER_UNBOUND_CODE,
  hostWorkerBindingRefusal,
  hostWorkerIdentityRefusal,
  readCurrentWorkerSession,
  readHostIdentityCapability,
  readHostWorkerBinding,
  readHostWorkerBindingFor,
  readHostWorkerIdentityCapability,
  type HostWorkerAttemptRef,
  type HostWorkerBinding,
  type HostWorkerIdentityCapability,
} from "../../src/graph/outcome/host-identity.ts";
import type { OutcomeDispatchRequest } from "../../src/graph/outcome/runtime.ts";
import type { HostExecutionIdentity } from "../../src/graph/host/execution-index.ts";
import {
  buildDeclaredOutcomeGraph,
  persistDeclaredGraph,
} from "../../src/graph/tools/declare-graph.ts";
import {
  AUTHORIZED,
  EMPTY_VALIDATORS,
  GRAPH_ID,
  naturalDeclaration,
  plainDeclaration,
  PLAIN_GRAPH_ID,
} from "./helpers/host-graph-fixture.ts";

const WORK_ATTEMPT: HostWorkerAttemptRef = Object.freeze({
  graphId: PLAIN_GRAPH_ID,
  nodeId: "work",
  attemptId: "work#1",
});

const tmpDirs: string[] = [];

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

// ── The contract, as a value ────────────────────────────────────────────────

/** One readable worker capability over fixed answers. */
function capabilityWith(answers: {
  readonly session?: string;
  readonly binding?: unknown;
}): HostWorkerIdentityCapability {
  // The answer is handed back VERBATIM (a single widening from `unknown`), so
  // a case can make the host answer a malformed value — what the readers must
  // refuse — rather than only an absent one.
  const answered = answers.binding as HostWorkerBinding | undefined;
  return hostWorkerIdentityCapability("test-host:worker-identity", {
    current: () => undefined,
    currentSession: () => answers.session,
    bindingFor: () => answered,
  });
}

describe("the worker-identity capability is read by SHAPE, never by a flag", () => {
  it("reads the worker declaration and keeps the D9 declaration a different shape", () => {
    const capability = capabilityWith({ session: "child-session:work#1" });
    const read = readHostWorkerIdentityCapability(capability);
    expect(read).toBeDefined();
    expect(read?.currentSession()).toBe("child-session:work#1");
    expect(Object.isFrozen(read)).toBe(true);

    // A strict identity capability is a DIFFERENT declaration: it carries no
    // worker answers and is never read as one.
    const strict = Object.freeze({
      version: 1 as const,
      id: "host:identity",
      current: () => undefined,
    });
    expect(readHostIdentityCapability(strict)).toBeDefined();
    expect(readHostWorkerIdentityCapability(strict)).toBeUndefined();
    // ...and the gate accepts it: declaring D9 is a valid, readable choice.
    expect(hostWorkerIdentityRefusal(strict)).toBeUndefined();

    for (const bad of [
      undefined,
      { version: 1, id: "host", current: () => undefined },
      {
        version: 2,
        id: "host",
        current: () => undefined,
        currentSession: () => undefined,
        bindingFor: () => undefined,
      },
      {
        version: 1,
        id: "",
        current: () => undefined,
        currentSession: () => undefined,
        bindingFor: () => undefined,
      },
      {
        version: 1,
        id: "host",
        current: () => undefined,
        currentSession: "not-a-function",
        bindingFor: () => undefined,
      },
      {
        version: 1,
        id: "host",
        current: () => undefined,
        currentSession: () => undefined,
        bindingFor: () => undefined,
        extra: true,
      },
    ]) {
      expect(readHostWorkerIdentityCapability(bad)).toBeUndefined();
    }
    // ABSENT is not malformed: no capability means neither binding is enabled.
    expect(hostWorkerIdentityRefusal(undefined)).toBeUndefined();
    // A PARTIAL declaration is refused by the D9 code, before anything is read.
    const partial = hostWorkerIdentityRefusal({
      version: 1,
      id: "host",
      current: () => undefined,
      currentSession: () => undefined,
    });
    expect(partial?.code).toBe(HOST_IDENTITY_UNAVAILABLE_CODE);
    expect(partial?.path).toBe("$.hostIdentity");
  });

  it("reads a binding strictly: every identity fact, no partial trust", () => {
    const full = {
      graphId: "g",
      nodeId: "n",
      attemptId: "n#1",
      executionId: "exec-1",
      taskId: "task-1",
      workerSessionId: "child-1",
    };
    expect(readHostWorkerBinding(full)).toEqual(full);
    // The task id is the ONLY optional key.
    expect(
      readHostWorkerBinding({
        graphId: "g",
        nodeId: "n",
        attemptId: "n#1",
        executionId: "exec-1",
        workerSessionId: "child-1",
      }),
    ).toEqual({
      graphId: "g",
      nodeId: "n",
      attemptId: "n#1",
      executionId: "exec-1",
      workerSessionId: "child-1",
    });
    for (const bad of [
      { ...full, extra: 1 },
      { ...full, workerSessionId: "" },
      { ...full, executionId: "" },
      { ...full, attemptId: undefined },
      { ...full, taskId: "" },
      "child-1",
      null,
    ]) {
      expect(readHostWorkerBinding(bad)).toBeUndefined();
    }
  });

  it("reports a host FAILURE as unavailable, never as 'no binding'", () => {
    const throwing = hostWorkerIdentityCapability("test-host:throwing", {
      current: () => undefined,
      currentSession: () => {
        throw new Error("session index unreachable");
      },
      bindingFor: () => {
        throw new Error("execution index unreachable");
      },
    });
    const session = readCurrentWorkerSession(throwing);
    expect(session.kind).toBe("refused");
    if (session.kind === "refused") {
      expect(session.refusal.code).toBe(HOST_WORKER_UNAVAILABLE_CODE);
      expect(session.refusal.message).toContain("session index unreachable");
    }
    const binding = readHostWorkerBindingFor(throwing, WORK_ATTEMPT);
    expect(binding.kind).toBe("refused");
    if (binding.kind === "refused") {
      expect(binding.refusal.message).toContain("execution index unreachable");
    }

    // A host that answers something which is not a binding is refused too.
    const malformed = capabilityWith({ binding: { graphId: "g", nodeId: "n" } });
    const reading = readHostWorkerBindingFor(malformed, WORK_ATTEMPT);
    expect(reading.kind).toBe("refused");
    if (reading.kind === "refused") {
      expect(reading.refusal.code).toBe(HOST_WORKER_UNAVAILABLE_CODE);
      expect(reading.refusal.path).toBe("$.workerBinding");
    }

    // A binding for a DIFFERENT attempt is never re-aimed at this one.
    const reAimed = capabilityWith({
      binding: {
        graphId: PLAIN_GRAPH_ID,
        nodeId: "work",
        attemptId: "work#9",
        executionId: "exec-9",
        workerSessionId: "child-9",
      },
    });
    const mismatch = readHostWorkerBindingFor(reAimed, WORK_ATTEMPT);
    expect(mismatch.kind).toBe("refused");
    if (mismatch.kind === "refused") {
      expect(mismatch.refusal.message).toContain("never re-aimed");
    }

    // NO capability at all is 'unbound'-adjacent: the caller holds none, and the
    // reading says so instead of answering as if a binding existed.
    expect(readCurrentWorkerSession(undefined).kind).toBe("refused");
  });

  it("names exactly which check refuses which shape", () => {
    const binding = {
      graphId: PLAIN_GRAPH_ID,
      nodeId: "work",
      attemptId: "work#1",
      executionId: "exec-1",
      workerSessionId: "child-1",
    };
    // The recorded child session passes.
    expect(
      hostWorkerBindingRefusal(
        { kind: "binding", binding },
        { kind: "identified", sessionId: "child-1" },
      ),
    ).toBeUndefined();
    // Unrelated session.
    const mismatched = hostWorkerBindingRefusal(
      { kind: "binding", binding },
      { kind: "identified", sessionId: "someone-else" },
    );
    expect(mismatched?.code).toBe(HOST_WORKER_SESSION_MISMATCH_CODE);
    expect(mismatched?.path).toBe("$.workerSession");
    // No session attributed to the call.
    const absent = hostWorkerBindingRefusal(
      { kind: "binding", binding },
      { kind: "none" },
    );
    expect(absent?.code).toBe(HOST_WORKER_ABSENT_CODE);
    // No confirmed execution for the attempt.
    const unbound = hostWorkerBindingRefusal(
      { kind: "unbound", attempt: WORK_ATTEMPT },
      { kind: "identified", sessionId: "child-1" },
    );
    expect(unbound?.code).toBe(HOST_WORKER_UNBOUND_CODE);
    expect(unbound?.path).toBe("$.workerBinding");
    // A host failure outranks everything else.
    const hostFailure = hostWorkerBindingRefusal(
      {
        kind: "refused",
        refusal: {
          code: HOST_WORKER_UNAVAILABLE_CODE,
          path: "$.workerBinding",
          message: "unreachable",
        },
      },
      { kind: "none" },
    );
    expect(hostFailure?.code).toBe(HOST_WORKER_UNAVAILABLE_CODE);
  });
});

// ── What the host confirmed it dispatched an attempt AS ─────────────────────

interface WorkerHost {
  readonly host: OutcomeHost;
  readonly deliveries: OutcomeDispatchRequest[];
  readonly childSessions: Map<string, string>;
}

/**
 * The shipped host assembly over one store root, with a platform that reports a
 * real execution for every delivery it accepts (or reports none, when the case
 * is about an unconfirmed create).
 *
 * The child session is minted as `child-session:<attemptId>` by the SAME
 * one-line mapping the dsh entry installs — the run id IS the published child
 * session id — so every session this file uses is a platform-minted id.
 */
function openWorkerHost(options: {
  readonly dir: string;
  readonly storeRoot: string;
  readonly confirm: boolean;
  readonly completionPolicies?: CompletionPolicyRegistry;
  /** Omit the platform derivation, for the host that cannot substantiate it. */
  readonly withoutWorkerSession?: boolean;
  /** Override the derivation, for a platform whose session id is not the execution id. */
  readonly workerSessionOf?: (execution: HostExecutionIdentity) => string | undefined;
}): WorkerHost {
  const deliveries: OutcomeDispatchRequest[] = [];
  const childSessions = new Map<string, string>();
  let host: OutcomeHost | undefined;
  const opened = OutcomeHost.open({
    workspaceDir: options.dir,
    storeRoot: options.storeRoot,
    deliver: (request, effect) => {
      deliveries.push(request);
      if (!options.confirm) return;
      const childSession = "child-session:" + request.attemptId;
      childSessions.set(request.attemptId, childSession);
      host?.confirmExecution(effect, { executionId: childSession });
    },
    validators: EMPTY_VALIDATORS,
    // THE SHIPPED DECISION: the declaring invocation is attribution, not the
    // worker's identity, and the platform's own child-session fact is the
    // binding (dsh: the run id IS the published child session id).
    declareInvocationIdentity: false,
    ...(options.withoutWorkerSession
      ? {}
      : {
          workerSessionOf:
            options.workerSessionOf ??
            ((execution: HostExecutionIdentity) => execution.executionId),
        }),
    ...(options.completionPolicies === undefined
      ? {}
      : { completionPolicies: options.completionPolicies }),
  });
  host = opened;
  return { host: opened, deliveries, childSessions };
}

/** One graph persisted into the root the host reads its plan from. */
function persistGraph(
  declaration: GraphDeclarationV3,
  storeRoot: string,
  completionPolicies?: CompletionPolicyRegistry,
): void {
  persistDeclaredGraph(
    buildDeclaredOutcomeGraph({
      declaration,
      ...(completionPolicies === undefined ? {} : { completionPolicies }),
    }),
    storeRoot,
  );
}

describe("OutcomeHost.workerIdentity — what the attempt was dispatched AS", () => {
  it("answers the platform's execution and child session, and survives a restart", async () => {
    const dir = makeDir("worker-binding-restart-");
    const storeRoot = join(dir, "host-store");
    persistGraph(plainDeclaration(), storeRoot);

    const first = openWorkerHost({ dir, storeRoot, confirm: true });
    let platformExecutionId = "";
    try {
      const started = await first.host.startDeclaredGraph(PLAIN_GRAPH_ID, {
        sessionId: "session-declarer",
        agent: "agent.orchestrator",
      });
      expect(started.kind).toBe("started");
      platformExecutionId = first.childSessions.get("work#1") ?? "";
      expect(platformExecutionId).toBe("child-session:work#1");

      const binding = first.host.workerIdentity.bindingFor(WORK_ATTEMPT);
      expect(binding).toEqual({
        graphId: PLAIN_GRAPH_ID,
        nodeId: "work",
        attemptId: "work#1",
        executionId: platformExecutionId,
        workerSessionId: platformExecutionId,
      });
      // The reading the ingress performs answers the same binding.
      const reading = readHostWorkerBindingFor(first.host.workerIdentity, WORK_ATTEMPT);
      expect(reading.kind).toBe("binding");
    } finally {
      first.host.close();
    }

    // A SECOND object graph over the same store root — the restart. The binding
    // is not process memory: it is the durable execution row the platform's
    // confirmation wrote, plus the platform's own derivation.
    const second = openWorkerHost({ dir, storeRoot, confirm: false });
    try {
      const rebound = second.host.workerIdentity.bindingFor(WORK_ATTEMPT);
      expect(rebound?.executionId).toBe(platformExecutionId);
      expect(rebound?.workerSessionId).toBe(platformExecutionId);
      // The process that dispatched nothing new still answers NOTHING about an
      // attempt it never saw confirmed.
      expect(
        second.host.workerIdentity.bindingFor({
          graphId: PLAIN_GRAPH_ID,
          nodeId: "work",
          attemptId: "work#9",
        }),
      ).toBeUndefined();
    } finally {
      second.host.close();
    }
  });

  it("records the task id and the worker session as the distinct facts they are", async () => {
    const dir = makeDir("worker-binding-task-");
    const storeRoot = join(dir, "host-store");
    persistGraph(plainDeclaration(), storeRoot);
    // THE Pi SHAPE: the execution is the dispatch task, and the worker session
    // is a DIFFERENT id on the same task. Both must reach the binding, and the
    // session — never the task id — is what a submission is judged by.
    const fixture = openWorkerHost({
      dir,
      storeRoot,
      confirm: true,
      workerSessionOf: (execution) => `pi-session:${execution.executionId}`,
    });
    try {
      await fixture.host.startDeclaredGraph(PLAIN_GRAPH_ID, {
        sessionId: "session-declarer",
        agent: "agent.orchestrator",
      });
      const binding = fixture.host.workerIdentity.bindingFor(WORK_ATTEMPT);
      expect(binding?.executionId).toBe("child-session:work#1");
      expect(binding?.workerSessionId).toBe("pi-session:child-session:work#1");
    } finally {
      fixture.host.close();
    }
  });

  it("answers NOTHING when the host declared no way to name the child session", async () => {
    const dir = makeDir("worker-binding-no-resolver-");
    const storeRoot = join(dir, "host-store");
    persistGraph(plainDeclaration(), storeRoot);
    const fixture = openWorkerHost({
      dir,
      storeRoot,
      confirm: true,
      withoutWorkerSession: true,
    });
    try {
      await fixture.host.startDeclaredGraph(PLAIN_GRAPH_ID, {
        sessionId: "session-declarer",
        agent: "agent.orchestrator",
      });
      // The EXECUTION is a real confirmed host fact...
      expect(
        fixture.host.dispatch.lookup({
          graphId: PLAIN_GRAPH_ID,
          effectId: "dispatch:work#1",
          attemptId: "work#1",
        }).kind,
      ).toBe("created");
      // ...but this host cannot say which session it created, so it records NO
      // binding and nothing settles the attempt through the worker path. A
      // capability that cannot be substantiated is refused, not faked.
      expect(fixture.host.workerIdentity.bindingFor(WORK_ATTEMPT)).toBeUndefined();
      const reading = readHostWorkerBindingFor(fixture.host.workerIdentity, WORK_ATTEMPT);
      expect(reading.kind).toBe("unbound");
    } finally {
      fixture.host.close();
    }
  });

  it("answers NOTHING for an attempt whose execution the platform never confirmed", async () => {
    const dir = makeDir("worker-binding-unconfirmed-");
    const storeRoot = join(dir, "host-store");
    persistGraph(plainDeclaration(), storeRoot);
    const fixture = openWorkerHost({ dir, storeRoot, confirm: false });
    try {
      await fixture.host.startDeclaredGraph(PLAIN_GRAPH_ID, {
        sessionId: "session-declarer",
        agent: "agent.orchestrator",
      });
      // The delivery happened; the platform never named an execution.
      expect(fixture.deliveries.map((request) => request.attemptId)).toEqual(["work#1"]);
      expect(fixture.host.workerIdentity.bindingFor(WORK_ATTEMPT)).toBeUndefined();
      const reading = readHostWorkerBindingFor(fixture.host.workerIdentity, WORK_ATTEMPT);
      expect(reading.kind).toBe("unbound");
    } finally {
      fixture.host.close();
    }
  });
});

// ── The completion authority's own source ───────────────────────────────────

interface PersistedAttempt {
  readonly events: number;
  readonly status: string | undefined;
}

async function readAttempt(storeRoot: string, graphId: string): Promise<PersistedAttempt> {
  const ledger = await SqliteAcceptanceLedger.create(storeRoot);
  try {
    const record = ledger.readGraphState(graphId);
    const body =
      typeof record?.body === "object" && record.body !== null
        ? (record.body as Record<string, unknown>)
        : undefined;
    const nodes = Array.isArray(body?.["nodes"]) ? (body["nodes"] as unknown[]) : [];
    let status: string | undefined;
    for (const entry of nodes) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (record["nodeId"] === "work") {
        status = typeof record["status"] === "string" ? record["status"] : undefined;
        break;
      }
    }
    return { events: ledger.acceptedEvents(graphId).length, status };
  } finally {
    ledger.close();
  }
}

describe("the host completion authority authenticates its own execution source", () => {
  it("refuses a completion whose attempt has no CONFIRMED host execution", async () => {
    const dir = makeDir("worker-completion-unconfirmed-");
    const storeRoot = join(dir, "host-store");
    persistGraph(naturalDeclaration(), storeRoot, AUTHORIZED);
    const fixture = openWorkerHost({
      dir,
      storeRoot,
      confirm: false,
      completionPolicies: AUTHORIZED,
    });
    try {
      await fixture.host.startDeclaredGraph(GRAPH_ID, {
        sessionId: "session-declarer",
        agent: "agent.orchestrator",
      });
      const report = await fixture.host.complete(GRAPH_ID, "work#1");
      expect(report.kind).toBe("unbound");
      if (report.kind === "unbound") {
        expect(report.reason).toContain("CONFIRMED host execution");
      }
      const after = await readAttempt(storeRoot, GRAPH_ID);
      expect(after.events).toBe(0);
      expect(after.status).toBe("dispatched");
    } finally {
      fixture.host.close();
    }
  });

  it("settles a confirmed attempt without impersonating the declaring principal", async () => {
    const dir = makeDir("worker-completion-authority-");
    const storeRoot = join(dir, "host-store");
    persistGraph(naturalDeclaration(), storeRoot, AUTHORIZED);
    const fixture = openWorkerHost({
      dir,
      storeRoot,
      confirm: true,
      completionPolicies: AUTHORIZED,
    });
    try {
      await fixture.host.startDeclaredGraph(GRAPH_ID, {
        sessionId: "session-declarer",
        agent: "agent.orchestrator",
      });
      // A completion is observed OUT OF BAND, under whatever attribution happens
      // to be current. The authority must not move the host's attribution: the
      // declaring principal is not the completion's identity.
      fixture.host.setInvocation({
        sessionId: "session-observer",
        agent: "agent.observer",
      });
      const report = await fixture.host.complete(GRAPH_ID, "work#1");
      expect(report.kind).toBe("settled");
      if (report.kind === "settled") {
        expect(report.nodeId).toBe("work");
        expect(report.settlement.kind).toBe("accepted");
      }
      expect(fixture.host.hostIdentity.current()).toEqual({
        sessionId: "session-observer",
        agentId: "agent.observer",
      });
      const after = await readAttempt(storeRoot, GRAPH_ID);
      expect(after.events).toBe(1);
      expect(after.status).toBe("settled");
    } finally {
      fixture.host.close();
    }
  });
});
