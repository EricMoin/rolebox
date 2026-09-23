/**
 * The read-only store audit and the host's boot sweep — the surviving evidence
 * surfaces over a declared (outcome-protocol) graph store.
 *
 * The audit's universe is the workspace's ONE graph store (P1 item 5), so a
 * graph is one stored DEFINITION plus its run-state row. A RETIRED per-graph v2
 * container left on disk is not a graph this build can read: it is a
 * `retired-state-record` BLOCKER that names the file, and the store beside it
 * is never initialized over it. These cases pin that reading, the zero-write
 * property of the audit, the graph_audit tool face, and the host sweep's
 * first-execution/restart behaviour.
 */

import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import { auditGraphStore, type DrainAuditReport } from "../../src/graph/audit/drain-audit.ts";
import {
  buildDeclaredOutcomeGraph,
  persistDeclaredGraph,
} from "../../src/graph/tools/declare-graph.ts";
import { engineStateDir } from "../../src/graph/persistence/engine-persistence.ts";
import { OutcomeHost } from "../../src/graph/host/outcome-host.ts";
import { SqliteAcceptanceLedger } from "../../src/graph/ledger/sqlite-ledger.ts";
import {
  OutcomeGraphRuntime,
  type OutcomeDispatchRequest,
} from "../../src/graph/outcome/runtime.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { createOutcomeGraphTools } from "../../src/graph/tools/index.ts";
import { testHostCredentialIsolation } from "./helpers/credential-isolation.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

const LINEAR: GraphDeclarationV3 = {
  version: 3,
  name: "audit.linear",
  nodes: [
    { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }] },
    { id: "ship", agent: "agent.ship", prompt: "Ship it.", outcomes: [{ id: "delivered" }] },
  ],
  edges: [{ from: "work", to: "ship", outcome: "done" }],
};

const OPEN: GraphDeclarationV3 = {
  version: 3,
  name: "audit.open",
  nodes: [
    { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }] },
  ],
  edges: [],
};

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function entryOf(report: DrainAuditReport, graphId: string) {
  const entry = report.entries.find((candidate) => candidate.graphId === graphId);
  if (entry === undefined) throw new Error("fixture: no audit entry for " + graphId);
  return entry;
}

/**
 * A RETIRED per-graph v2 container on disk — what the previous layout wrote and
 * this build no longer reads, writes or converts.
 *
 * Written as RAW TEXT on purpose: production has no writer for it any more
 * (`EnginePersistence` is deleted), and the audit must report the file's
 * PRESENCE, which is a fact about the directory rather than about its content.
 */
function writeRetiredContainer(dir: string, slug: string): string {
  const path = join(engineStateDir(dir), "engine-" + slug + ".json");
  mkdirSync(engineStateDir(dir), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ version: 2, graphId: slug, phase: "executing" }),
    "utf-8",
  );
  return path;
}

/** Run one declared graph to completion through the outcome runtime. */
async function runToCompletion(dir: string, declaration: GraphDeclarationV3): Promise<void> {
  const graph = buildDeclaredOutcomeGraph({ declaration });
  persistDeclaredGraph(graph, engineStateDir(dir));
  const ledger = await SqliteAcceptanceLedger.create(engineStateDir(dir));
  try {
    const credentials = new Map<string, string>();
    const runtime = new OutcomeGraphRuntime({
      plan: graph.plan,
      ledger,
      dispatch: (request) => {
        credentials.set(request.nodeId, request.credential);
      },
      validators: createValidatorRegistry([]),
      artifactRoot: dir,
      clock: () => NOW,
      credentialIsolation: testHostCredentialIsolation(engineStateDir(dir)),
    });
    runtime.start(NOW);
    // Settle the entry node; the acceptance arms the successor.
    const work = credentials.get("work");
    if (work === undefined) throw new Error("fixture: no attempt for work");
    expect(
      runtime.submit({ nodeId: "work", outcomeId: "done", credential: work }, NOW + 1).kind,
    ).toBe("accepted");
    const ship = credentials.get("ship");
    if (ship === undefined) throw new Error("fixture: no attempt for ship");
    expect(
      runtime.submit({ nodeId: "ship", outcomeId: "delivered", credential: ship }, NOW + 2).kind,
    ).toBe("accepted");
  } finally {
    ledger.close();
  }
}

/** Start one declared graph and leave its entry attempt armed. */
async function startAndLeaveArmed(dir: string, declaration: GraphDeclarationV3): Promise<void> {
  const graph = buildDeclaredOutcomeGraph({ declaration });
  persistDeclaredGraph(graph, engineStateDir(dir));
  const ledger = await SqliteAcceptanceLedger.create(engineStateDir(dir));
  try {
    const runtime = new OutcomeGraphRuntime({
      plan: graph.plan,
      ledger,
      dispatch: () => undefined,
      validators: createValidatorRegistry([]),
      artifactRoot: dir,
      clock: () => NOW,
      credentialIsolation: testHostCredentialIsolation(engineStateDir(dir)),
    });
    runtime.start(NOW);
  } finally {
    ledger.close();
  }
}

/** Hash + mtime of every file under a directory, for the zero-write proof. */
function snapshotTree(dir: string): string {
  const hash = createHash("sha256");
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const info = statSync(path);
      if (info.isDirectory()) {
        hash.update("dir:" + name + "\n");
        walk(path);
      } else {
        hash.update("file:" + name + ":" + info.mtimeMs + "\n");
        hash.update(readFileSync(path));
      }
    }
  };
  walk(dir);
  return hash.digest("hex");
}

// ── Audit ───────────────────────────────────────────────────────────────────

describe("auditGraphStore — the surviving store evidence", () => {
  it("classifies stored definitions and reports every record it cannot account for", async () => {
    const dir = makeTmpDir("audit-mixed-");
    await runToCompletion(dir, LINEAR);
    await startAndLeaveArmed(dir, OPEN);
    // A RETIRED per-graph v2 container: no decoder, never read, never rewritten.
    writeRetiredContainer(dir, "audit.legacy");

    const report = await auditGraphStore({ directory: dir, now: () => NOW });

    expect(report.totals.graphs).toBe(2);
    expect(report.totals.terminal).toBe(1);
    expect(report.totals.inFlight).toBe(1);
    expect(report.totals.blocked).toBe(0);
    expect(report.totals.outcomeInFlight).toBe(1);
    // The retired container is a BLOCKER even though every stored graph reads
    // cleanly: "nothing looked non-terminal" is not "nothing left to account for".
    expect(report.verdict).toBe("blocked");
    expect(report.drained).toBe(false);
    const retired = report.blockers.find((entry) => entry.code === "retired-state-record");
    expect(retired?.file).toBe("engine-audit.legacy.json");

    const terminal = entryOf(report, "audit.linear");
    expect(terminal.protocol).toBe("outcome");
    expect(terminal.classification).toBe("terminal");
    expect(terminal.phase).toBe("complete");
    expect(terminal.blockerCodes).toEqual([]);

    const inFlight = entryOf(report, "audit.open");
    expect(inFlight.protocol).toBe("outcome");
    expect(inFlight.classification).toBe("in-flight");
    expect(inFlight.armed?.map((node) => node.nodeId)).toEqual(["work"]);
  });

  it("blocks a store the format gate refuses, and never reports it as empty", async () => {
    const dir = makeTmpDir("audit-damaged-");
    // A zero-byte authoritative file is a DAMAGED store, never an absent one.
    mkdirSync(engineStateDir(dir), { recursive: true });
    writeFileSync(join(engineStateDir(dir), "graph-acceptance-ledger.sqlite"), "");

    const report = await auditGraphStore({ directory: dir, now: () => NOW });

    expect(report.totals.graphs).toBe(0);
    expect(report.ledger).toBe("unreadable");
    expect(report.verdict).toBe("blocked");
    expect(report.blockers.map((entry) => entry.code)).toContain("ledger-unreadable");
  });

  it("writes nothing: every file is byte-identical and mtime-identical after an audit", async () => {
    const dir = makeTmpDir("audit-nowrite-");
    await runToCompletion(dir, LINEAR);
    await startAndLeaveArmed(dir, OPEN);
    writeRetiredContainer(dir, "audit.legacy");

    const before = snapshotTree(dir);
    await auditGraphStore({ directory: dir, now: () => NOW });
    expect(snapshotTree(dir)).toBe(before);
  });

  it("is reachable through the graph_audit tool and the toolset method", async () => {
    const dir = makeTmpDir("audit-tool-");
    await startAndLeaveArmed(dir, OPEN);

    const tools = createOutcomeGraphTools(createGraphToolSet({ stateDir: dir }));
    const auditTool = tools.graph_audit;
    if (auditTool === undefined) throw new Error("graph_audit was not registered");
    const output = await auditTool.execute(
      {},
      {
        sessionID: "s1",
        messageID: "m1",
        agent: "test-agent",
        directory: dir,
        worktree: dir,
        abort: new AbortController().signal,
        metadata: () => {},
        ask: async () => {},
      } as never,
    );
    const parsed = JSON.parse(String(output)) as DrainAuditReport;
    expect(parsed.totals.inFlight).toBe(1);

    const toolset = createGraphToolSet({ stateDir: dir });
    const direct = await toolset.graph_audit();
    expect(direct.totals).toEqual(parsed.totals);
  });
});

// ── Host sweep ──────────────────────────────────────────────────────────────

describe("OutcomeHost.recoverDeclaredGraphs — first execution and restart", () => {
  it("starts on the first sweep, resumes on the second, and never re-delivers an armed attempt", async () => {
    const dir = makeTmpDir("audit-restart-");
    const graph = buildDeclaredOutcomeGraph({ declaration: LINEAR });
    persistDeclaredGraph(graph, engineStateDir(dir));

    const firstDeliveries: OutcomeDispatchRequest[] = [];
    const first = OutcomeHost.open({
      workspaceDir: dir,
      storeRoot: engineStateDir(dir),
      deliver: (request) => {
        firstDeliveries.push(request);
      },
      durability: "memory",
    });
    let firstReport;
    try {
      firstReport = await first.recoverDeclaredGraphs();
    } finally {
      first.close();
    }
    expect(firstReport.started).toEqual([graph.graphId + ":" + graph.plan.planRevision]);
    expect(firstReport.resumed).toEqual([]);
    expect(firstDeliveries.map((request) => request.attemptId)).toEqual(["work#1"]);

    // A SECOND host over the same store continues the armed attempt.
    const secondDeliveries: OutcomeDispatchRequest[] = [];
    const second = OutcomeHost.open({
      workspaceDir: dir,
      storeRoot: engineStateDir(dir),
      deliver: (request) => {
        secondDeliveries.push(request);
      },
      durability: "memory",
    });
    let secondReport;
    try {
      secondReport = await second.recoverDeclaredGraphs();
    } finally {
      second.close();
    }
    expect(secondReport.started).toEqual([]);
    expect(secondReport.resumed).toEqual([graph.graphId + ":executing"]);
    expect(secondDeliveries).toEqual([]);
  });

  it("never visits a retired container, never rewrites it, and starts nothing for it", async () => {
    const dir = makeTmpDir("audit-restart-legacy-");
    writeRetiredContainer(dir, "audit.legacy");

    const deliveries: OutcomeDispatchRequest[] = [];
    const host = OutcomeHost.open({
      workspaceDir: dir,
      storeRoot: engineStateDir(dir),
      deliver: (request) => {
        deliveries.push(request);
      },
      durability: "memory",
    });
    const before = readFileSync(join(engineStateDir(dir), "engine-audit.legacy.json"), "utf-8");
    try {
      // A retired per-graph container is not a STORED DEFINITION, so the sweep
      // — whose inventory is the store's own definition listing — never visits
      // it: it is not started, not resumed, and not rewritten. (The audit is
      // where it surfaces, as a retired-state-record blocker.)
      const report = await host.recoverDeclaredGraphs();
      expect(report.started).toEqual([]);
      expect(report.resumed).toEqual([]);
      expect(report.refused).toEqual([]);
      expect(deliveries).toEqual([]);
      expect(readFileSync(join(engineStateDir(dir), "engine-audit.legacy.json"), "utf-8")).toBe(
        before,
      );
    } finally {
      host.close();
    }
  });
});

process.on("exit", () => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});
