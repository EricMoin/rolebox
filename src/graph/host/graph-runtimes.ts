import { SqliteAcceptanceLedger } from "../ledger/sqlite-ledger.ts";
import { OutcomeGraphRuntime } from "../outcome/runtime.ts";
import type { OutcomeGraphRuntimeOptions } from "../outcome/runtime-contract.ts";
import { describeStoredReading, readStoredDefinition } from "../persistence/declared-record.ts";

export interface RunningGraphRuntime {
  readonly runtime: OutcomeGraphRuntime;
  readonly ledger: SqliteAcceptanceLedger;
  readonly declarationDigest: string;
  readonly planRevision: string;
}

/** Owns cached runtimes and their ledger handles, including opens still in flight. */
export class HostGraphRuntimes {
  private readonly pending = new Map<string, Promise<RunningGraphRuntime>>();
  private readonly opened = new Set<RunningGraphRuntime>();
  private closed = false;

  constructor(
    private readonly storeRoot: string,
    private readonly options: Omit<OutcomeGraphRuntimeOptions, "plan" | "ledger">,
  ) {}

  async get(graphId: string): Promise<RunningGraphRuntime> {
    this.assertOpen();
    let pending = this.pending.get(graphId);
    if (pending === undefined) {
      pending = this.open(graphId);
      this.pending.set(graphId, pending);
    }
    let entry: RunningGraphRuntime;
    try {
      entry = await pending;
    } catch (error) {
      if (this.pending.get(graphId) === pending) this.pending.delete(graphId);
      throw error;
    }
    if (this.closed) {
      entry.ledger.close();
      this.assertOpen();
    }
    this.opened.add(entry);
    // A cached plan remains usable only while the durable definition corroborates it.
    this.assertDefinitionCurrent(graphId, entry);
    return entry;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.opened) entry.ledger.close();
    this.opened.clear();
    this.pending.clear();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("outcome-host: this host has been closed");
  }

  private assertDefinitionCurrent(
    graphId: string,
    entry: RunningGraphRuntime,
  ): void {
    const reading = readStoredDefinition(this.storeRoot, graphId);
    if (reading.kind !== "ok") {
      throw new Error(
        "outcome-host: the stored definition of graph " +
        JSON.stringify(graphId) +
        " is no longer readable in " +
        this.storeRoot +
        " (" +
        describeStoredReading(reading) +
        ") — the run path this process opened for it is STALE, and nothing is started, " +
        "resumed or settled from a plan the store no longer corroborates",
      );
    }
    const declared = reading.declared;
    if (
      declared.declarationDigest !== entry.declarationDigest ||
      declared.plan.planRevision !== entry.planRevision
    ) {
      throw new Error(
        "outcome-host: the stored definition of graph " +
        JSON.stringify(graphId) +
        " changed after this process opened its run path (declaration " +
        JSON.stringify(entry.declarationDigest) +
        " -> " +
        JSON.stringify(declared.declarationDigest) +
        ", plan revision " +
        JSON.stringify(entry.planRevision) +
        " -> " +
        JSON.stringify(declared.plan.planRevision) +
        ") — a definition a run may be executing is never replaced in place, so the " +
        "cached run path is refused rather than used",
      );
    }
  }

  private async open(graphId: string): Promise<RunningGraphRuntime> {
    const reading = readStoredDefinition(this.storeRoot, graphId);
    if (reading.kind !== "ok") {
      throw new Error(
        "outcome-host: graph " +
        JSON.stringify(graphId) +
        " has no readable stored definition in " +
        this.storeRoot +
        " (" +
        describeStoredReading(reading) +
        ") — a declared graph is dispatched only from its SAVED plan, and the " +
        "retired per-graph v2 container is never read as one",
      );
    }
    const plan = reading.declared.plan;
    const ledger = await SqliteAcceptanceLedger.create(this.storeRoot);
    try {
      this.assertOpen();
      const runtime = new OutcomeGraphRuntime({ ...this.options, plan, ledger });
      const entry = {
        runtime,
        ledger,
        declarationDigest: reading.declared.declarationDigest,
        planRevision: plan.planRevision,
      };
      this.assertDefinitionCurrent(graphId, entry);
      return entry;
    } catch (error) {
      ledger.close();
      throw error;
    }
  }
}
