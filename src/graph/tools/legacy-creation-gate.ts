/**
 * Graph Execution Engine v2 — E-gate step 1: no NEW durable legacy record.
 *
 * Version: 1.0
 * Date: 2026-09-22
 *
 * Stage E opens with "stop creating new legacy graphs"
 * (docs/graph-outcome-protocol.md § "Implementation order and release gates",
 * step 5, and the stage-E order: stop creating → drain → list blockers →
 * retire). This module owns that one decision for the build's CREATION ingress,
 * so the rule has one owner, one stable code and one diagnostic instead of a
 * check sprinkled through the tool surface.
 *
 * THE DEFECT IT CLOSES IS THE BACKFILL, NOT THE PROTOCOL. A fresh legacy engine
 * state carries no `executionProtocolVersion` at all: `createEngineState` does
 * not set one, and `serializeEngineState` writes the key only when the state
 * holds it. The format-2 decoder — and ONLY the format-2 decoder — then
 * BINDS such a record to protocol 1 (`LEGACY_SIGNAL_PROTOCOL`) because "format
 * 2 IS the legacy signal protocol" (see `engine-persistence.ts`, B3 backfill).
 * That inference is correct for a record written before the field existed, and
 * it is exactly wrong for a record written today: the store ends up with a
 * brand-new protocol-1 graph that is indistinguishable from a two-year-old one,
 * which is what makes "drain or explicitly migrate legacy executions"
 * undecidable — every drain is followed by a new legacy graph nobody asked for.
 *
 * THE DEFAULT REFUSES; A HOST MAY DECLARE THAT IT STILL NEEDS THE LEGACY
 * INGRESS. The refusal fires when ALL hold: the host has not declared
 * `allowNewLegacyGraphs`, a state directory is configured (so there is a
 * durable store to pollute), and that store holds NO record for the graph id
 * (so the coming write would CREATE one). The declaration exists because the
 * outcome path cannot replace the legacy one yet — it refuses by default until
 * a deployment injects a credential-isolation adapter (D7) — and closing this
 * ingress under a host that still relies on it is exactly the retirement the
 * stage-E order puts AFTER the drain. It is deliberately explicit and
 * greppable so the remaining creation sites are enumerable, and removing the
 * declaration IS the step-1 change for that host.
 *
 * WHAT IS REFUSED, AND WHAT IS NOT. Nothing else is touched by either answer:
 *
 * - an EXISTING record — `legacy`, `declared` or unreadable — is not a
 *   creation: recovery, resume and rebuild keep working exactly as before, which
 *   is what draining the in-flight graphs requires;
 * - a toolset with no `stateDir` writes nothing at all, so in-memory graph work
 *   is untouched;
 * - the engine primitive (`createEngine` / `EnginePersistence`) is untouched:
 *   this is a policy of the CREATION ingress, not a change to the legacy run
 *   path, which stays fully executable (nothing is deleted and no legacy
 *   capability is removed).
 *
 * The refusal names the alternative that exists today: a new graph is declared
 * through `graph_declare`, which pins `executionProtocolVersion =
 * OUTCOME_PROTOCOL` on the record it writes.
 */

import { engineStatePath } from "../engine/engine-persistence.ts";
import { readExistingDeclaredGraph } from "./declare-graph.ts";

/** The stable code a caller branches on; the diagnostic wording is not API. */
export const LEGACY_GRAPH_CREATION_REFUSED =
  "legacy-graph-creation-refused" as const;

export type LegacyGraphCreationRefusalCode =
  typeof LEGACY_GRAPH_CREATION_REFUSED;

/** One refused creation: the code, the graph, the path and the reason. */
export interface LegacyGraphCreationRefusal {
  readonly code: LegacyGraphCreationRefusalCode;
  readonly graphId: string;
  /** The record path the write would have created. */
  readonly stateFilePath: string;
  /** What was refused and why. Wording is not API; the code is. */
  readonly diagnostic: string;
}

/** The one sentence the refusal is built on. */
export function legacyGraphCreationRefusedReason(
  graphId: string,
  stateFilePath: string,
): string {
  return (
    `refused to create a NEW legacy-protocol graph \"${graphId}\" at ${stateFilePath}: ` +
    "this build must not add protocol-1 records to the store. A fresh legacy " +
    "state is persisted with NO execution-protocol identity, and the format-2 " +
    "decoder then BINDS it to execution protocol 1 by backfill — the graph " +
    "created now would be indistinguishable from one written before the field " +
    "existed. Stage E (" +
    "docs/graph-outcome-protocol.md, steps 1 and 5) stops creating new legacy " +
    "graphs before it drains the existing ones. Nothing was dispatched and no " +
    "file was written. To create a graph, declare it under the outcome protocol " +
    "(graph_declare). RESUMING an existing record is NOT refused: this fires " +
    "only where the store holds no record for this graph."
  );
}

/**
 * The decision, as a value: `null` when the creation is allowed, otherwise the
 * refusal to raise. Pure over the store: it READS the record's existence (the
 * same read `graph_create`'s id reservation uses) and writes nothing.
 */
export function legacyGraphCreationRefusal(input: {
  readonly stateDir: string | undefined;
  readonly graphId: string;
  /**
   * The host's explicit declaration that it still creates new durable legacy
   * graphs (`GraphToolSetDeps.allowNewLegacyGraphs`). Defaults to refusing
   * everywhere it is not stated.
   */
  readonly allowedByHost: boolean;
}): LegacyGraphCreationRefusal | null {
  // The host declared the allowance: this ingress is the legacy path's, and
  // closing it is a stage-E step the host has not taken (yet).
  if (input.allowedByHost) return null;
  // No store configured: no record can be created, so there is nothing to gate.
  if (input.stateDir === undefined) return null;
  // A record already exists (legacy, declared or unreadable): resuming,
  // rebuilding or recovering it is not a creation and is never refused.
  if (readExistingDeclaredGraph(input.stateDir, input.graphId).kind !== "absent") {
    return null;
  }
  const stateFilePath = engineStatePath(input.stateDir, input.graphId);
  return Object.freeze({
    code: LEGACY_GRAPH_CREATION_REFUSED,
    graphId: input.graphId,
    stateFilePath,
    diagnostic: legacyGraphCreationRefusedReason(input.graphId, stateFilePath),
  });
}

/**
 * Raised when a creation ingress would mint a new protocol-1 record. It carries
 * the refusal as DATA (code, graph, path) so a caller can branch without
 * parsing the message.
 */
export class LegacyGraphCreationRefusedError extends Error {
  readonly code: LegacyGraphCreationRefusalCode;
  readonly graphId: string;
  readonly stateFilePath: string;

  constructor(refusal: LegacyGraphCreationRefusal) {
    super(refusal.diagnostic);
    this.name = "LegacyGraphCreationRefusedError";
    this.code = refusal.code;
    this.graphId = refusal.graphId;
    this.stateFilePath = refusal.stateFilePath;
  }
}
