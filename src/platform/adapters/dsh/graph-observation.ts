import type { HostExecutionObservation } from "../../../graph/host/outcome-host.ts";
import type { DshSessionEventLike, DshSessionStoreLike } from "./session.ts";

export async function readDshExecutionEvents(sessions: DshSessionStoreLike, persistence: unknown, id: string): Promise<readonly DshSessionEventLike[] | undefined> {
  const live = sessions.get(id);
  if (live) return live.events;
  const storage = persistence as {
    inspect?(id: string): Promise<{ events: readonly DshSessionEventLike[] }>;
    open?(id: string, access: "read"): Promise<{ read(): Promise<{ events: readonly DshSessionEventLike[] }>; close(): Promise<void> }>;
  } | undefined;
  if (storage?.open) {
    const handle = await storage.open(id, "read");
    try { return (await handle.read()).events; } finally { await handle.close(); }
  }
  return storage?.inspect ? (await storage.inspect(id)).events : undefined;
}

/** Structural record guard — every property read below goes through it. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !isArray(value);
}

/**
 * `Array.isArray` that cannot itself throw: a REVOKED `Proxy` throws inside it,
 * so the answer degrades to "not an array" instead of propagating.
 */
function isArray(value: unknown): boolean {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

/**
 * THE TOTALITY SEAM (a hostile property ACCESSOR is not hostile data).
 *
 * `isRecord` only has to survive a value whose SHAPE is wrong; a live object
 * — a `Proxy` with a throwing `get` trap, an object with a throwing accessor,
 * an array with a throwing index getter — passes the guard and then THROWS on
 * the very next property read. Every property read of an event, its data, a
 * message or a content block therefore goes through these helpers:
 *
 *   - a read that throws degrades to `undefined`, which the callers already
 *     treat as the documented absent/malformed reading — never a repair, a
 *     guess or a throw, and never a change for well-formed data;
 *   - `lengthOf`, `elementAt` and `windowFrom` make an array-like safe to
 *     ITERATE, to index and to slice. A throwing `length` accessor degrades to
 *     `0`, a throwing index accessor to a missing element and a throwing
 *     `slice` to an empty window, so the loop body they feed never throws and
 *     the caller's reading is the absent one.
 */
function readProperty(owner: unknown, key: string): unknown {
  if (owner === null || owner === undefined) return undefined;
  try {
    return (owner as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * A guarded ELEMENT read (`events[index]`, `content[blockIndex]`): an array
 * whose index accessor throws is a live object, not malformed data, and it
 * degrades to the same `undefined` a missing element produces.
 */
function elementAt(value: unknown, index: number): unknown {
  return readProperty(value, String(index));
}

/**
 * The events owned after a descriptor, from `start` to the end — or NOTHING when
 * the `slice` itself throws (`Array.prototype.slice` re-reads every index, so a
 * throwing index accessor takes the whole window with it).
 */
function windowFrom(value: unknown, start: number): readonly DshSessionEventLike[] {
  try {
    return isArray(value) ? (value as readonly DshSessionEventLike[]).slice(start) : [];
  } catch {
    return [];
  }
}

/** A safe `length` for an array-like whose `length` may throw; 0 when unreadable. */
function lengthOf(value: unknown): number {
  try {
    const raw = readProperty(value, "length");
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0;
  } catch {
    return 0;
  }
}

/**
 * The own-property names of a parsed declaration, or an empty reading when even
 * enumeration throws (`Object.keys` reaches a Proxy's `ownKeys` trap).
 */
function ownKeysOf(value: unknown): readonly string[] {
  try {
    return Object.keys(value as object);
  } catch {
    return [];
  }
}

/**
 * Index of the LAST `subagent/descriptor` event whose data is this label's
 * `version: 2`, `mode: "one-shot"` descriptor, or -1 when the session carries
 * no descriptor at all or its last descriptor belongs to something else.
 *
 * The LAST descriptor wins: a later descriptor — matching or not — resets the
 * ownership reading, because a session can host several subagent children.
 */
function ownedDescriptorIndex(events: readonly DshSessionEventLike[], label: string): number {
  if (!isArray(events)) return -1;
  let owner = -1;
  let owned = false;
  for (let index = 0; index < lengthOf(events); index++) {
    const event = elementAt(events, index);
    if (!isRecord(event) || readProperty(event, "type") !== "subagent/descriptor") continue;
    const data = isRecord(readProperty(event, "data")) ? readProperty(event, "data") : undefined;
    owner = index;
    owned = readProperty(data, "version") === 2 &&
      readProperty(data, "mode") === "one-shot" &&
      readProperty(data, "label") === label;
  }
  return owned ? owner : -1;
}

/**
 * The events owned by the one-shot dsh graph execution `label`: everything
 * AFTER its last `subagent/descriptor`, or nothing when the session's last
 * descriptor is not this label's one-shot descriptor.
 *
 * Both exported readers derive ownership from this one helper, so the
 * completion observation and the last-turn declaration reading cannot drift.
 */
function ownedWindow(events: readonly DshSessionEventLike[], label: string): readonly DshSessionEventLike[] {
  const owner = ownedDescriptorIndex(events, label);
  return owner < 0 ? [] : windowFrom(events, owner + 1);
}

/** Only a terminal turn after this one-shot child's own descriptor proves an end. */
export function observeDshExecutionEvents(events: readonly DshSessionEventLike[], label: string): HostExecutionObservation {
  const unknown = { kind: "unknown" as const, reason: "No confirmed terminal turn for this dsh graph execution" };
  let terminal: HostExecutionObservation = unknown;
  const window = ownedWindow(events, label);
  for (let index = 0; index < lengthOf(window); index++) {
    const event = elementAt(window, index);
    if (!isRecord(event)) continue;
    const type = readProperty(event, "type");
    const data = isRecord(readProperty(event, "data")) ? readProperty(event, "data") : undefined;
    if (type === "turn/start") terminal = unknown;
    else if (type === "turn/end") {
      const rawReason = readProperty(data, "reason");
      const reason = isRecord(rawReason) ? rawReason : undefined;
      const kind = readProperty(reason, "kind");
      terminal = kind === "completed" ? { kind: "completed" }
        : typeof kind === "string" && ["aborted", "error", "max-tokens", "refusal"].includes(kind)
          ? { kind: "failed", reason: "dsh execution ended: " + kind } : unknown;
    }
  }
  return terminal;
}

/**
 * The outcome declaration a dsh graph worker publishes in its LAST turn's text.
 *
 * The worker prompt asks for exactly one fenced `json` block, so the reading is
 * byte-deterministic:
 *
 *   - ownership: the owned window is everything after the LAST
 *     `subagent/descriptor` event (a later descriptor resets the window), and
 *     the window must be this label's `version: 2`, `mode: "one-shot"` one;
 *   - the FINAL turn is the last `turn/start` .. following `turn/end` pair
 *     inside that window, and its `data.reason.kind` must be `"completed"`
 *     (a failed or aborted turn is the completion observation's business, not a
 *     declaration source);
 *   - the turn's `assistant/message` events are read in event order and, within
 *     each message, in block order; every `type: "text"` block whose `text` is a
 *     string contributes its lines, and ALL such blocks are joined with a single
 *     `"\n"` — block-to-block and message-to-message alike — before the scan.
 *     Reasoning, tool, malformed and unknown blocks are skipped, never guessed;
 *   - a CANDIDATE is the text between a line that is exactly ` ```json ` (trailing
 *     whitespace ignored) and the next line that is exactly ` ``` ` — a line scan
 *     with no nested fences and no repair of an unterminated fence;
 *   - exactly one candidate must parse as a JSON object whose keys are all in
 *     `{outcome_id, data, evidence_refs}`, whose `outcome_id` is a non-empty
 *     string and whose `evidence_refs`, when present, is an array of non-empty
 *     strings.
 *
 * The function is total and pure: every property read is guarded, hostile or
 * missing event data can only produce `absent`/`malformed`, and it never throws.
 */
export type DshTurnDeclaration = {
  /** The declared outcome id — a non-empty string. */
  readonly outcomeId: string;
  /** The declared payload, present only when the block carried a `data` key. */
  readonly data?: unknown;
  /** The declared references, present only when the block carried `evidence_refs`. */
  readonly evidenceRefs?: readonly string[];
  /** Where the block was read: the `assistant/message` event and the closing `turn/end`. */
  readonly derivation: { readonly eventIndex: number; readonly turnIndex: number };
};

/** Total reading of a dsh graph worker's last-turn declaration. */
export type DshTurnDeclarationReading =
  | { readonly kind: "declared"; readonly declaration: DshTurnDeclaration }
  | { readonly kind: "absent"; readonly reason: string }
  | { readonly kind: "ambiguous"; readonly reason: string }
  | { readonly kind: "malformed"; readonly reason: string };

/** The only keys a declaration block may carry. */
const DECLARATION_KEYS = new Set(["outcome_id", "data", "evidence_refs"]);

/**
 * Read the single outcome declaration from the last turn of the owned one-shot
 * execution `label`. See {@link DshTurnDeclarationReading} for the exact,
 * byte-deterministic derivation contract.
 */
export function readDshLastTurnDeclaration(events: readonly DshSessionEventLike[], label: string): DshTurnDeclarationReading {
  const owner = ownedDescriptorIndex(events, label);
  if (owner < 0) return { kind: "absent", reason: "No one-shot dsh graph execution descriptor owns this session label" };
  const window = ownedWindow(events, label);
  const offset = owner + 1;

  // The final turn: the last `turn/start` .. following `turn/end` pair.
  let opened = -1;
  let final: { readonly start: number; readonly end: number } | undefined;
  for (let index = 0; index < lengthOf(window); index++) {
    const event = elementAt(window, index);
    if (!isRecord(event)) continue;
    const type = readProperty(event, "type");
    if (type === "turn/start") opened = index;
    else if (type === "turn/end") {
      if (opened >= 0) final = { start: opened, end: index };
      opened = -1;
    }
  }
  if (!final) return { kind: "absent", reason: "No terminal turn after the owning one-shot descriptor" };
  const closing = elementAt(window, final.end);
  const closingData = isRecord(readProperty(closing, "data")) ? readProperty(closing, "data") : undefined;
  const closingReason = isRecord(readProperty(closingData, "reason")) ? readProperty(closingData, "reason") : undefined;
  const kind = readProperty(closingReason, "kind");
  if (kind !== "completed") {
    return { kind: "absent", reason: "The final dsh turn did not complete: " + (typeof kind === "string" ? kind : "unknown") };
  }

  // Every string `text` block of the final turn's assistant messages, joined
  // block-to-block with "\n"; each remembered line keeps its source event index.
  const lines: Array<{ readonly text: string; readonly eventIndex: number }> = [];
  for (let index = final.start + 1; index < final.end; index++) {
    const event = elementAt(window, index);
    if (!isRecord(event) || readProperty(event, "type") !== "assistant/message") continue;
    const data = isRecord(readProperty(event, "data")) ? readProperty(event, "data") : undefined;
    const message = isRecord(readProperty(data, "message")) ? readProperty(data, "message") : undefined;
    const content = readProperty(message, "content");
    if (!isArray(content)) continue;
    for (let blockIndex = 0; blockIndex < lengthOf(content); blockIndex++) {
      const block = elementAt(content, blockIndex);
      const text = readProperty(block, "text");
      if (!isRecord(block) || readProperty(block, "type") !== "text" || typeof text !== "string") continue;
      for (const line of text.split("\n")) lines.push({ text: line, eventIndex: offset + index });
    }
  }

  // Line scan: ```` ```json ```` opens, the next line that is exactly ```` ``` ```` closes.
  const candidates: Array<{ readonly body: string; readonly eventIndex: number }> = [];
  for (let index = 0; index < lines.length; index++) {
    const opening = lines[index];
    if (opening.text.trimEnd() !== "```json") continue;
    let closingLine = -1;
    for (let next = index + 1; next < lines.length; next++) {
      if (lines[next].text.trimEnd() === "```") { closingLine = next; break; }
    }
    if (closingLine < 0) break;
    candidates.push({ body: lines.slice(index + 1, closingLine).map(line => line.text).join("\n"), eventIndex: opening.eventIndex });
    index = closingLine;
  }
  if (candidates.length === 0) return { kind: "absent", reason: "No fenced declaration block in the final dsh turn" };
  if (candidates.length > 1) {
    return {
      kind: "ambiguous",
      reason: `${candidates.length} declaration blocks in the final dsh turn (assistant/message events ${candidates.map(candidate => candidate.eventIndex).join(", ")})`,
    };
  }

  const candidate = candidates[0]!;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.body);
  } catch {
    return { kind: "malformed", reason: "The fenced declaration block is not valid JSON" };
  }
  if (!isRecord(parsed)) return { kind: "malformed", reason: "The fenced declaration block is not a JSON object" };
  for (const key of ownKeysOf(parsed)) {
    if (!DECLARATION_KEYS.has(key)) return { kind: "malformed", reason: `The declaration carries an unknown key: ${key}` };
  }
  const outcomeId = readProperty(parsed, "outcome_id");
  if (typeof outcomeId !== "string" || outcomeId.length === 0) {
    return { kind: "malformed", reason: "The declaration outcome_id is not a non-empty string" };
  }
  let evidenceRefs: readonly string[] | undefined;
  if (Object.hasOwn(parsed, "evidence_refs")) {
    const raw = readProperty(parsed, "evidence_refs");
    if (!Array.isArray(raw) || raw.some(reference => typeof reference !== "string" || reference.length === 0)) {
      return { kind: "malformed", reason: "The declaration evidence_refs is not an array of non-empty strings" };
    }
    evidenceRefs = raw as string[];
  }
  return {
    kind: "declared",
    declaration: {
      outcomeId,
      ...(Object.hasOwn(parsed, "data") ? { data: readProperty(parsed, "data") } : {}),
      ...(evidenceRefs ? { evidenceRefs } : {}),
      derivation: { eventIndex: candidate.eventIndex, turnIndex: offset + final.end },
    },
  };
}
