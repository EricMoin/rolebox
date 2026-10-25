
/** One declared node, in declaration order. `agent` is carried for callers. */
export interface TopologyNodeInput {
  readonly id: string;
  readonly agent?: string;
}

/** One declared control edge: an outcome of `from` routes to `to`. */
export interface TopologyEdgeInput {
  readonly from: string;
  readonly to: string;
  readonly outcome: string;
}

/** One declared loop group (members and the cycle they bound). */
export interface TopologyLoopGroupInput {
  readonly id: string;
  readonly nodes: readonly string[];
}

/** Everything the layout needs — exactly the declaration's own shape. */
export interface TopologyInput {
  readonly nodes: readonly TopologyNodeInput[];
  readonly edges: readonly TopologyEdgeInput[];
  readonly loopGroups?: readonly TopologyLoopGroupInput[];
}

/** One node box. `rank` is the condensation rank (0 = topmost row). */
export interface TopologyBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rank: number;
}

/** An axis-aligned rectangle in the figure's own coordinates. */
export interface TopologyRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One drawn edge. `d` is the orthogonal polyline (rounded corners, `M`/`L`/`Q`
 * only); `back` marks an edge whose target rank is not strictly greater than
 * its source's (the intra-SCC hairpin, drawn dashed below its rank row);
 * `label` is the outcome chip's rectangle — `null` when the chip is
 * suppressed because the source declares only one outgoing outcome.
 */
export interface TopologyEdge {
  from: string;
  to: string;
  outcome: string;
  d: string;
  back: boolean;
  label: TopologyRect | null;
}

/** One loop-group field, covering the ranks its members occupy. */
export interface TopologyBand {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The band label's own reserved box, inside the band's top gutter. */
  label: TopologyRect;
}

/** The finished drawing: intrinsic size, ranks, boxes, edges and bands. */
export interface TopologyLayout {
  width: number;
  height: number;
  ranks: string[][];
  boxes: TopologyBox[];
  edges: TopologyEdge[];
  bands: TopologyBand[];
}

// ── Geometry constants ─────────────────────────────────────────────────────
//
// Every number the figure is drawn from lives here, so the panel styles only
// colour and the tests assert against names instead of magic values.

/** Padding between the canvas edge and the drawn ink, per side. */
export const TOPOLOGY_PADDING_X = 14;
export const TOPOLOGY_PADDING_Y = 12;
/** Fixed box height — one rank row is exactly this tall. */
export const TOPOLOGY_BOX_HEIGHT = 34;
/** Narrowest box (a one-character id). */
export const TOPOLOGY_BOX_MIN_WIDTH = 64;
/** Widest box — a long id ellipsizes rather than widening a rank forever. */
export const TOPOLOGY_BOX_MAX_WIDTH = 168;
/** Estimated advance width of one id character at the label's font size. */
export const TOPOLOGY_BOX_CHAR_WIDTH = 7;
/** Width allowance: the state mark's column, the label's padding and gaps. */
export const TOPOLOGY_BOX_TEXT_PADDING = 45;
/** Fixed gap between two boxes of one rank. */
export const TOPOLOGY_COLUMN_GAP = 18;
/** The base gap between two rank rows — one quiet lane's worth of channel. */
export const TOPOLOGY_RANK_GAP = 52;
/** Vertical air a plain (chip-less) lane keeps from a box row. */
export const TOPOLOGY_LANE_CLEARANCE = 6;
/** Vertical air a chip-bearing lane keeps from a box row (chip half + air). */
export const TOPOLOGY_CHIP_CLEARANCE = 9;
/** The floor pitch between two lanes of one channel. */
export const TOPOLOGY_LANE_PITCH = 12;
/** The air two chip-bearing lanes keep between their chips. */
export const TOPOLOGY_CHIP_GAP = 4;
/** The state mark's origin inside a box. */
export const TOPOLOGY_MARK_OFFSET_X = 7;
export const TOPOLOGY_MARK_OFFSET_Y = 9;
/** The node label's left inset (past the mark) and right padding. */
export const TOPOLOGY_LABEL_OFFSET_X = 27;
export const TOPOLOGY_LABEL_RIGHT_PADDING = 6;
/** Rough advance width of one label character — the ellipsis budget. */
export const TOPOLOGY_LABEL_CHAR_WIDTH = 6.4;
/** Horizontal inset of the first port from its box's corner. */
export const TOPOLOGY_PORT_INSET = 4;
/**
 * The least x pitch two neighbouring ports should keep: a chip centred on a
 * lane stays clear of every other edge crossing it when the crossings are at
 * least twice its own clearance (2 * 8px) apart, and a box widens to spread a
 * busy top or bottom edge that far.
 */
export const TOPOLOGY_PORT_SPREAD = 16;
/** However busy a box's edge is, it never widens past this. */
export const TOPOLOGY_BOX_PORT_MAX_WIDTH = 260;
/** The least x distance two ports of one box may share. */
export const TOPOLOGY_PORT_PITCH = 2;
/** Room between the box columns and the first skip edge's rail. */
export const TOPOLOGY_RAIL_GAP = 16;
/** The corner radius of an orthogonal turn. */
export const TOPOLOGY_TURN_RADIUS = 5;
/** The outcome chip's fixed height. */
export const TOPOLOGY_EDGE_LABEL_HEIGHT = 14;
export const TOPOLOGY_EDGE_LABEL_MIN_WIDTH = 24;
export const TOPOLOGY_EDGE_LABEL_MAX_WIDTH = 132;
export const TOPOLOGY_EDGE_LABEL_CHAR_WIDTH = 6;
export const TOPOLOGY_EDGE_LABEL_PADDING = 10;
/** Least distance a chip's centre keeps from any other edge's path. */
export const TOPOLOGY_LABEL_CLEARANCE = 8;
/** The most a chip's centre may sit off its OWN path (the checker allows 1.5). */
export const TOPOLOGY_LABEL_ON_EDGE = 1.2;
/**
 * The pitch the acceptance instrument samples a path at (300 spans, so 301
 * points). A chip is fitted against the same grid: on a path longer than
 * `300 * 1.5px` the instrument's own points thin out, and a label that only
 * sits on the drawn line could still fall between two of them.
 */
export const TOPOLOGY_SAMPLE_COUNT = 300;
/** Above this many lanes a channel falls back to a greedy stacking order. */
export const TOPOLOGY_LANE_ORDER_LIMIT = 12;
/** Air between a band's border and the ink of the loop it covers. */
export const TOPOLOGY_BAND_PADDING = 8;
/**
 * Air a band's bottom border keeps above the next rank's boxes. A band closes
 * BELOW its own hairpin, so the channel under a group's lowest member rank
 * reserves this much room for it (the acceptance instrument asks for 4px).
 */
export const TOPOLOGY_BAND_CLOSE_CLEARANCE = 6;
/** The band label's reserved box height. */
export const TOPOLOGY_BAND_LABEL_HEIGHT = 12;
/** The air between the band label's box and the rank it sits above. */
export const TOPOLOGY_BAND_LABEL_GAP = 6;
/** Horizontal inset of the band label inside its band. */
export const TOPOLOGY_BAND_LABEL_INSET_X = 5;
/** Rough advance width of one band-label character. */
export const TOPOLOGY_BAND_LABEL_CHAR_WIDTH = 6;
/** The gutter a band keeps above its first covered rank for its own label. */
export const TOPOLOGY_BAND_LABEL_GUTTER = TOPOLOGY_BAND_LABEL_HEIGHT + TOPOLOGY_BAND_LABEL_GAP;
/** A band's whole headroom above the first rank it covers. */
export const TOPOLOGY_BAND_HEADROOM = TOPOLOGY_BAND_PADDING + TOPOLOGY_BAND_LABEL_GUTTER;
/**
 * The air a RAISED band's top border keeps below the rank above it. A band
 * normally starts in the label gutter above its first member row; when the
 * channel above that row carries a chip of an edge that touches the loop, the
 * border rises over that whole channel instead, and this is the clearance it
 * then keeps from the boxes above.
 */
export const TOPOLOGY_BAND_TOP_CLEARANCE = 2;

// ── Local structural guard (the payload is untrusted) ──────────────────────

/** One vertex of a route, in the layout's local coordinate space. */
interface RoutePoint {
  x: number;
  y: number;
}

/** A route's polyline plus the metadata the emit stage needs. */
interface Route {
  points: RoutePoint[];
  back: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Deterministic box width from an id's length, clamped to the exported range. */
function boxWidth(id: string): number {
  const estimated = id.length * TOPOLOGY_BOX_CHAR_WIDTH + TOPOLOGY_BOX_TEXT_PADDING;
  return Math.min(
    TOPOLOGY_BOX_MAX_WIDTH,
    Math.max(TOPOLOGY_BOX_MIN_WIDTH, Math.round(estimated)),
  );
}

/** Deterministic outcome-chip size from the outcome text's length. */
function labelWidth(outcome: string): number {
  const estimated = outcome.length * TOPOLOGY_EDGE_LABEL_CHAR_WIDTH + TOPOLOGY_EDGE_LABEL_PADDING;
  return Math.min(
    TOPOLOGY_EDGE_LABEL_MAX_WIDTH,
    Math.max(TOPOLOGY_EDGE_LABEL_MIN_WIDTH, Math.round(estimated)),
  );
}

/** One decimal at most, so the emitted path text is stable and readable. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A bottom port's own half-pixel column: even integers only. */
function snapEven(x: number): number {
  return 2 * Math.round((x - 0.5) / 2) + 0.5;
}

/** A top port's own half-pixel column: odd integers only. */
function snapOdd(x: number): number {
  return 2 * Math.round((x - 1.5) / 2) + 1.5;
}

/**
 * The width a box needs to carry `count` ports on one edge at the minimum
 * pitch: the same spread the port pass walks, plus one pitch of slack for the
 * half-pixel family snap.
 */
function portSpanWidth(count: number): number {
  return TOPOLOGY_PORT_INSET * 2 + TOPOLOGY_PORT_PITCH * (count + 2);
}

/**
 * Distinct port x positions for one box edge, ordered left to right.
 *
 * `count` ports are spread over the box's middle, then snapped onto the
 * family's own half-pixel grid (bottom = even, top = odd) so no two families
 * can ever share a vertical run. The box is always sized so that spread
 * already keeps at least {@link TOPOLOGY_PORT_PITCH} between neighbours (see
 * {@link portSpanWidth} in the width pass), so the monotone push below only
 * absorbs the snap: a port is never clamped back onto an earlier one, because
 * two ports folded together would draw two exactly collinear vertical runs.
 */
function portPositions(
  box: { x: number; width: number },
  count: number,
  odd: boolean,
): number[] {
  const inner = Math.max(2, box.width - TOPOLOGY_PORT_INSET * 2);
  const out: number[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < count; k++) {
    const raw = box.x + TOPOLOGY_PORT_INSET + (inner * (k + 1)) / (count + 1);
    let x = odd ? snapOdd(raw) : snapEven(raw);
    if (x < previous + TOPOLOGY_PORT_PITCH) x = previous + TOPOLOGY_PORT_PITCH;
    out.push(round2(x));
    previous = x;
  }
  return out;
}

/** One piece of the emitted route: a straight run or a rounded corner. */
type RoundedSegment =
  | { kind: "L"; x1: number; y1: number; x2: number; y2: number }
  | { kind: "Q"; x1: number; y1: number; cx: number; cy: number; x2: number; y2: number };

/**
 * The route as the pieces that are actually emitted: every interior vertex
 * becomes a small arc when both of its legs are long enough, so the corner
 * radius here is exactly the one `polylineToPath` writes (and the one the fit
 * below measures against).
 */
function roundedSegments(points: RoutePoint[], radius: number): RoundedSegment[] {
  const segments: RoundedSegment[] = [];
  if (points.length < 2) return segments;
  let cursor = points[0]!;
  for (let i = 1; i < points.length - 1; i++) {
    const corner = points[i]!;
    const next = points[i + 1]!;
    const inLength = Math.hypot(cursor.x - corner.x, cursor.y - corner.y);
    const outLength = Math.hypot(next.x - corner.x, next.y - corner.y);
    const r = inLength === 0 || outLength === 0
      ? 0
      : Math.min(radius, inLength / 2, outLength / 2);
    if (r <= 0.5) {
      segments.push({ kind: "L", x1: cursor.x, y1: cursor.y, x2: corner.x, y2: corner.y });
      cursor = corner;
      continue;
    }
    const approachX = corner.x + ((cursor.x - corner.x) / inLength) * r;
    const approachY = corner.y + ((cursor.y - corner.y) / inLength) * r;
    const leaveX = corner.x + ((next.x - corner.x) / outLength) * r;
    const leaveY = corner.y + ((next.y - corner.y) / outLength) * r;
    segments.push({
      kind: "L",
      x1: cursor.x,
      y1: cursor.y,
      x2: approachX,
      y2: approachY,
    });
    segments.push({
      kind: "Q",
      x1: approachX,
      y1: approachY,
      cx: corner.x,
      cy: corner.y,
      x2: leaveX,
      y2: leaveY,
    });
    cursor = { x: leaveX, y: leaveY };
  }
  const last = points[points.length - 1]!;
  segments.push({ kind: "L", x1: cursor.x, y1: cursor.y, x2: last.x, y2: last.y });
  return segments;
}

/** Distance from a point to one line segment. */
function pointToSegment(
  x: number,
  y: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  let t = 0;
  if (lengthSquared > 0) {
    t = ((x - x1) * dx + (y - y1) * dy) / lengthSquared;
    t = Math.max(0, Math.min(1, t));
  }
  return Math.hypot(x - (x1 + dx * t), y - (y1 + dy * t));
}

/** The very segments the path is written from, at their emitted precision. */
function drawnSegments(points: RoutePoint[], radius: number): RoundedSegment[] {
  return roundedSegments(points, radius).map((segment) =>
    segment.kind === "L"
      ? {
          kind: "L" as const,
          x1: round2(segment.x1),
          y1: round2(segment.y1),
          x2: round2(segment.x2),
          y2: round2(segment.y2),
        }
      : {
          kind: "Q" as const,
          x1: round2(segment.x1),
          y1: round2(segment.y1),
          cx: round2(segment.cx),
          cy: round2(segment.cy),
          x2: round2(segment.x2),
          y2: round2(segment.y2),
        },
  );
}

/** One straight horizontal run of a route, with its own span on the path. */
interface RouteRunSpan {
  y: number;
  x1: number;
  x2: number;
  arcStart: number;
  arcEnd: number;
}

/** Everything the chip fit needs to know about one edge's drawn route. */
interface RouteFit {
  segments: RoundedSegment[];
  /** The instrument's own points: equal arc-length steps along the path. */
  samples: RoutePoint[];
  runs: RouteRunSpan[];
  total: number;
}

/**
 * Serialize an orthogonal polyline with rounded corners: `M`, `L` and `Q`
 * only, every coordinate rounded to two decimals so the text is stable.
 */
function polylineToPath(segments: RoundedSegment[]): string {
  if (segments.length === 0) return "";
  const first = segments[0]!;
  const parts: string[] = ["M " + first.x1 + " " + first.y1];
  for (const segment of segments) {
    if (segment.kind === "L") {
      parts.push("L " + segment.x2 + " " + segment.y2);
    } else {
      parts.push(
        "Q " + segment.cx + " " + segment.cy + " " + segment.x2 + " " + segment.y2,
      );
    }
  }
  return parts.join(" ");
}

/**
 * Measure one drawn route the way the acceptance instrument does: flatten it
 * (each rounded corner into short chords), walk it once for the cumulative arc
 * length, then read off the equal arc-length sample points and the arc span of
 * every straight horizontal run.
 */
function fitRoute(segments: RoundedSegment[], sampleCount: number): RouteFit {
  const points: RoutePoint[] = [];
  const cumulative: number[] = [];
  const runSpans: RouteRunSpan[] = [];
  let total = 0;
  const start = segments[0];
  if (start === undefined) {
    return { segments, samples: [], runs: [], total: 0 };
  }
  let cursor: RoutePoint = { x: start.x1, y: start.y1 };
  points.push(cursor);
  cumulative.push(0);
  for (const segment of segments) {
    if (segment.kind === "L") {
      const length = Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1);
      const arcStart = total;
      total += length;
      points.push({ x: segment.x2, y: segment.y2 });
      cumulative.push(total);
      if (Math.abs(segment.y1 - segment.y2) < 1e-9) {
        runSpans.push({
          y: segment.y1,
          x1: Math.min(segment.x1, segment.x2),
          x2: Math.max(segment.x1, segment.x2),
          arcStart,
          arcEnd: total,
        });
      }
      cursor = { x: segment.x2, y: segment.y2 };
    } else {
      const steps = 64;
      let previous = cursor;
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        const u = 1 - t;
        const x =
          u * u * segment.x1 + 2 * u * t * segment.cx + t * t * segment.x2;
        const y =
          u * u * segment.y1 + 2 * u * t * segment.cy + t * t * segment.y2;
        total += Math.hypot(x - previous.x, y - previous.y);
        points.push({ x, y });
        cumulative.push(total);
        previous = { x, y };
      }
      cursor = previous;
    }
  }
  const samples: RoutePoint[] = [];
  if (total <= 0) {
    samples.push(points[0]!);
  } else {
    let at = 0;
    for (let index = 0; index <= sampleCount; index++) {
      const target = (total * index) / sampleCount;
      while (at < cumulative.length - 2 && cumulative[at + 1]! < target) at += 1;
      const spanStart = cumulative[at]!;
      const spanEnd = cumulative[at + 1]!;
      const t = spanEnd === spanStart ? 0 : (target - spanStart) / (spanEnd - spanStart);
      const from = points[at]!;
      const to = points[at + 1]!;
      samples.push({
        x: Math.round((from.x + (to.x - from.x) * t) * 100) / 100,
        y: Math.round((from.y + (to.y - from.y) * t) * 100) / 100,
      });
    }
  }
  return { segments, samples, runs: runSpans, total };
}

/** The least distance from a point to any sample inside a y window. */
function nearestInWindow(
  x: number,
  y: number,
  samples: RoutePoint[],
  window: number,
): number {
  let best = Number.POSITIVE_INFINITY;
  for (const sample of samples) {
    if (Math.abs(sample.y - y) > window) continue;
    const distance = Math.hypot(sample.x - x, sample.y - y);
    if (distance < best) best = distance;
  }
  return best;
}

/** Every vertical run of a route, as the lines a chip must keep clear of. */
function verticalRuns(points: RoutePoint[]): Array<{ x: number; y1: number; y2: number }> {
  const out: Array<{ x: number; y1: number; y2: number }> = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (Math.abs(a.x - b.x) > 1e-9) continue;
    out.push({ x: a.x, y1: Math.min(a.y, b.y), y2: Math.max(a.y, b.y) });
  }
  return out;
}

/**
 * Every x worth trying for a chip's centre on one run: the run's own sample
 * points first (a centre there sits exactly on the line the instrument reads),
 * then its ends, an even spread across it, and the points exactly one
 * clearance away from each edge crossing this lane. The fit below then
 * measures each candidate against the real sample sets.
 */
function chipCandidates(run: RouteRunSpan, fit: RouteFit, blockers: number[]): number[] {
  const out: number[] = [];
  const push = (value: number): void => {
    const clamped = Math.min(run.x2, Math.max(run.x1, value));
    if (!out.some((existing) => Math.abs(existing - clamped) < 0.05)) out.push(clamped);
  };
  for (const sample of fit.samples) {
    if (Math.abs(sample.y - run.y) > 0.5) continue;
    if (sample.x < run.x1 - 0.01 || sample.x > run.x2 + 0.01) continue;
    push(sample.x);
  }
  push(run.x1);
  push(run.x2);
  const spread = 8;
  for (let k = 1; k < spread; k++) {
    push(run.x1 + ((run.x2 - run.x1) * k) / spread);
  }
  const inside = blockers
    .filter((x) => x >= run.x1 - TOPOLOGY_LABEL_CLEARANCE && x <= run.x2 + TOPOLOGY_LABEL_CLEARANCE)
    .sort((a, b) => a - b);
  for (let i = 0; i < inside.length; i++) {
    push(inside[i]! + TOPOLOGY_LABEL_CLEARANCE);
    push(inside[i]! - TOPOLOGY_LABEL_CLEARANCE);
    if (i + 1 < inside.length) push((inside[i]! + inside[i + 1]!) / 2);
  }
  return out;
}

/** One horizontal run of one edge, waiting for its own lane. */
interface Lane {
  edge: number;
  channel: number;
  kind: "forward" | "back" | "rail-out" | "rail-in";
  x1: number;
  x2: number;
  chip: boolean;
  y: number;
}

/** One declared loop group resolved against the laid-out graph. */
interface GroupInfo {
  id: string;
  /** Rank of its highest member box. */
  top: number;
  /** Rank of its lowest member box. */
  bottom: number;
  /** Its member node ids, for the "does this edge touch the loop?" test. */
  members: ReadonlySet<string>;
  /** Its member node indices, in declaration order. */
  memberNodes: number[];
}

/** The x of every vertical that leaves a lane DOWNWARD inside its channel. */
function laneDownVerticals(lane: Lane): number[] {
  // A forward edge drops from its lane into the target's top port; a rail-in
  // lane does the same. A back edge only rises, and a rail-out lane leaves the
  // channel along the rail — which is right of every port, so it crosses none.
  return lane.kind === "forward" || lane.kind === "rail-in" ? [lane.x2] : [];
}

/** The x of every vertical that leaves a lane UPWARD inside its channel. */
function laneUpVerticals(lane: Lane): number[] {
  // A rail-in lane's upward leg IS the rail (right of every port): no crossing.
  if (lane.kind === "rail-in") return [];
  // A back edge rises out of its lane twice: into the source and into the
  // target, both on the rank row above.
  if (lane.kind === "back") return [lane.x1, lane.x2];
  return [lane.x1];
}

/**
 * How many times the two lanes' own verticals would cut the other's run when
 * `above` sits in a shallower lane than `below`. This is the exact crossing
 * count of the pair inside one channel, so ordering the lanes by it removes
 * every crossing that is not forced by the layered drawing itself.
 */
function laneCrossings(above: Lane, below: Lane): number {
  let count = 0;
  const belowLo = Math.min(below.x1, below.x2);
  const belowHi = Math.max(below.x1, below.x2);
  for (const x of laneDownVerticals(above)) if (x > belowLo && x < belowHi) count += 1;
  const aboveLo = Math.min(above.x1, above.x2);
  const aboveHi = Math.max(above.x1, above.x2);
  for (const x of laneUpVerticals(below)) if (x > aboveLo && x < aboveHi) count += 1;
  return count;
}

/** The deterministic reading order of a channel before crossing reduction. */
function laneBaseOrder(a: Lane, b: Lane): number {
  return (
    Math.min(a.x1, a.x2) - Math.min(b.x1, b.x2) ||
    Math.max(a.x1, a.x2) - Math.max(b.x1, b.x2) ||
    a.edge - b.edge ||
    kindOrder(a.kind) - kindOrder(b.kind)
  );
}

/**
 * Stack one channel's lanes so that as few of them cross as possible: a subset
 * DP finds the exact minimum-crossing order for a realistic channel (up to
 * `TOPOLOGY_LANE_ORDER_LIMIT` lanes), and a greedy insertion handles a
 * pathological one. Ties keep the deterministic reading order.
 */
function orderChannelLanes(channel: Lane[]): Lane[] {
  const base = [...channel].sort(laneBaseOrder);
  const count = base.length;
  if (count <= 1) return base;
  if (count > TOPOLOGY_LANE_ORDER_LIMIT) {
    const ordered: Lane[] = [];
    for (const lane of base) {
      let at = ordered.length;
      let best = Number.POSITIVE_INFINITY;
      for (let position = 0; position <= ordered.length; position++) {
        let cost = 0;
        for (let i = 0; i < position; i++) cost += laneCrossings(ordered[i]!, lane);
        for (let i = position; i < ordered.length; i++) cost += laneCrossings(lane, ordered[i]!);
        if (cost < best) {
          best = cost;
          at = position;
        }
      }
      ordered.splice(at, 0, lane);
    }
    return ordered;
  }
  const size = 1 << count;
  const best = new Float64Array(size).fill(Number.POSITIVE_INFINITY);
  const pick = new Int32Array(size).fill(-1);
  best[0] = 0;
  for (let mask = 1; mask < size; mask++) {
    for (let k = 0; k < count; k++) {
      if ((mask & (1 << k)) === 0) continue;
      const rest = mask & ~(1 << k);
      const previous = best[rest]!;
      if (previous === Number.POSITIVE_INFINITY) continue;
      let extra = 0;
      for (let j = 0; j < count; j++) {
        if ((rest & (1 << j)) === 0) continue;
        extra += laneCrossings(base[j]!, base[k]!);
      }
      if (previous + extra < best[mask]! - 1e-9) {
        best[mask] = previous + extra;
        pick[mask] = k;
      }
    }
  }
  const ordered: Lane[] = [];
  let mask = size - 1;
  while (mask > 0) {
    const k = pick[mask]!;
    ordered.push(base[k]!);
    mask &= ~(1 << k);
  }
  ordered.reverse();
  return ordered;
}

/** The stable tie-break rank of a lane's kind. */
function kindOrder(kind: Lane["kind"]): number {
  return kind === "forward" ? 0 : kind === "back" ? 1 : kind === "rail-out" ? 2 : 3;
}

/** The least centre distance two adjacent lanes of one channel may keep. */
function lanePitch(above: Lane, below: Lane): number {
  const half = (lane: Lane): number => (lane.chip ? TOPOLOGY_EDGE_LABEL_HEIGHT / 2 : 1);
  const needed =
    half(above) + half(below) + (above.chip && below.chip ? TOPOLOGY_CHIP_GAP : 0);
  return Math.max(TOPOLOGY_LANE_PITCH, needed);
}

/**
 * Lay one declared graph out as ranks of boxes with orthogonal, lane-routed
 * edges between them.
 *
 * Defensive by contract: a missing or malformed payload, an unknown endpoint,
 * a self-edge, a duplicate edge or a non-string id is DROPPED rather than
 * thrown. Empty input returns the zero-size layout.
 */
export function layoutGraphTopology(input: TopologyInput): TopologyLayout {
  const empty: TopologyLayout = {
    width: 0,
    height: 0,
    ranks: [],
    boxes: [],
    edges: [],
    bands: [],
  };
  if (!isRecord(input)) return empty;

  // ── Declared nodes, in declaration order, first spelling of an id wins ───
  const rawNodes: unknown = input.nodes;
  const ids: string[] = [];
  const index = new Map<string, number>();
  if (Array.isArray(rawNodes)) {
    for (const entry of rawNodes) {
      if (!isRecord(entry)) continue;
      const id = entry.id;
      if (typeof id !== "string" || index.has(id)) continue;
      index.set(id, ids.length);
      ids.push(id);
    }
  }
  if (ids.length === 0) return empty;

  // ── Declared edges, deduplicated, self- and unknown-endpoint edges dropped ─
  const rawEdges: unknown = input.edges;
  const froms: number[] = [];
  const tos: number[] = [];
  const outcomes: string[] = [];
  // The outcomes each source DECLARES, counted before any edge is dropped: the
  // chip rule is about the node's own fan-out, so a duplicate or unroutable
  // edge still proves its source is divergent.
  const declaredOutcomes = new Map<string, Set<string>>();
  const seenEdges = new Set<string>();
  if (Array.isArray(rawEdges)) {
    for (const entry of rawEdges) {
      if (!isRecord(entry)) continue;
      const from = entry.from;
      const to = entry.to;
      const outcome = entry.outcome;
      if (typeof from === "string" && typeof outcome === "string") {
        const bucket = declaredOutcomes.get(from);
        if (bucket === undefined) declaredOutcomes.set(from, new Set([outcome]));
        else bucket.add(outcome);
      }
      if (typeof from !== "string" || typeof to !== "string" || typeof outcome !== "string") {
        continue;
      }
      const source = index.get(from);
      const target = index.get(to);
      if (source === undefined || target === undefined || source === target) continue;
      const key = from + "\u0000" + to + "\u0000" + outcome;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      froms.push(source);
      tos.push(target);
      outcomes.push(outcome);
    }
  }

  const nodeCount = ids.length;
  const edgeCount = froms.length;
  const adjacency: number[][] = Array.from({ length: nodeCount }, () => []);
  const reverse: number[][] = Array.from({ length: nodeCount }, () => []);
  for (let i = 0; i < edgeCount; i++) {
    adjacency[froms[i]!]!.push(tos[i]!);
    reverse[tos[i]!]!.push(froms[i]!);
  }

  // ── Strongly connected components (iterative Kosaraju: no recursion) ─────
  const visited = new Array<boolean>(nodeCount).fill(false);
  const finish: number[] = [];
  for (let start = 0; start < nodeCount; start++) {
    if (visited[start]) continue;
    visited[start] = true;
    const stack: Array<{ node: number; next: number }> = [{ node: start, next: 0 }];
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const neighbours = adjacency[top.node]!;
      if (top.next < neighbours.length) {
        const next = neighbours[top.next]!;
        top.next += 1;
        if (!visited[next]) {
          visited[next] = true;
          stack.push({ node: next, next: 0 });
        }
      } else {
        finish.push(top.node);
        stack.pop();
      }
    }
  }

  const component = new Array<number>(nodeCount).fill(-1);
  let componentCount = 0;
  for (let i = finish.length - 1; i >= 0; i--) {
    const start = finish[i]!;
    if (component[start] !== -1) continue;
    component[start] = componentCount;
    const stack = [start];
    while (stack.length > 0) {
      const node = stack.pop()!;
      for (const next of reverse[node]!) {
        if (component[next] === -1) {
          component[next] = componentCount;
          stack.push(next);
        }
      }
    }
    componentCount += 1;
  }

  // ── Longest path over the condensation, Kahn order, deterministic ties ───
  const componentEdges: Array<Set<number>> = Array.from(
    { length: componentCount },
    () => new Set<number>(),
  );
  const indegree = new Array<number>(componentCount).fill(0);
  for (let i = 0; i < edgeCount; i++) {
    const source = component[froms[i]!]!;
    const target = component[tos[i]!]!;
    if (source === target) continue;
    if (componentEdges[source]!.has(target)) continue;
    componentEdges[source]!.add(target);
    indegree[target] = (indegree[target] ?? 0) + 1;
  }
  // Each component's first node index, so a tie is broken by declaration order.
  const firstIndex = new Array<number>(componentCount).fill(Number.MAX_SAFE_INTEGER);
  for (let node = 0; node < nodeCount; node++) {
    const c = component[node]!;
    if (node < (firstIndex[c] ?? Number.MAX_SAFE_INTEGER)) firstIndex[c] = node;
  }
  const rankOfComponent = new Array<number>(componentCount).fill(0);
  const ready: number[] = [];
  for (let c = 0; c < componentCount; c++) {
    if ((indegree[c] ?? 0) === 0) ready.push(c);
  }
  ready.sort((a, b) => (firstIndex[a] ?? 0) - (firstIndex[b] ?? 0));
  while (ready.length > 0) {
    const current = ready.shift()!;
    for (const target of componentEdges[current]!) {
      rankOfComponent[target] = Math.max(
        rankOfComponent[target] ?? 0,
        (rankOfComponent[current] ?? 0) + 1,
      );
      indegree[target] = (indegree[target] ?? 0) - 1;
      if (indegree[target] === 0) {
        ready.push(target);
        ready.sort((a, b) => (firstIndex[a] ?? 0) - (firstIndex[b] ?? 0));
      }
    }
  }

  const nodeRank = new Array<number>(nodeCount).fill(0);
  for (let node = 0; node < nodeCount; node++) {
    nodeRank[node] = rankOfComponent[component[node]!] ?? 0;
  }
  let maxRank = 0;
  for (const rank of nodeRank) maxRank = Math.max(maxRank, rank);
  const rankCount = maxRank + 1;

  // ── Order within each rank: declaration order and nothing else ───────────
  //
  // Nodes are appended rank by rank in declaration order, so a rank always
  // reads `w-1, w-2, w-3` and the figure is a stable projection of the
  // declaration. No crossing-reduction pass may permute them: the runs stay
  // tidy because an edge's PORTS are ordered by the other end's x instead.
  const rankMembers: number[][] = Array.from({ length: rankCount }, () => []);
  for (let node = 0; node < nodeCount; node++) rankMembers[nodeRank[node]!]!.push(node);
  const ranks: string[][] = rankMembers.map((members) => members.map((node) => ids[node]!));

  // ── Edge classification: forward, back (intra-SCC) or rank-skipping ──────
  const isBack: boolean[] = new Array(edgeCount).fill(false);
  const isSkip: boolean[] = new Array(edgeCount).fill(false);
  for (let i = 0; i < edgeCount; i++) {
    const sourceRank = nodeRank[froms[i]!]!;
    const targetRank = nodeRank[tos[i]!]!;
    isBack[i] = targetRank <= sourceRank;
    isSkip[i] = targetRank > sourceRank + 1;
  }

  // ── Boxes: width from the id, widened when the node's edges need a pitch ──
  //
  // A box with many edges must be wide enough to spread its ports 16px apart:
  // that is what keeps a chip centred on one lane clear of every other edge
  // crossing it. A modest node keeps its id-sized box.
  const bottomDegree = new Array<number>(nodeCount).fill(0);
  const topDegree = new Array<number>(nodeCount).fill(0);
  for (let i = 0; i < edgeCount; i++) {
    bottomDegree[froms[i]!] = (bottomDegree[froms[i]!] ?? 0) + 1;
    if (isBack[i]!) bottomDegree[tos[i]!] = (bottomDegree[tos[i]!] ?? 0) + 1;
    else topDegree[tos[i]!] = (topDegree[tos[i]!] ?? 0) + 1;
  }
  const widths = ids.map((id, node) => {
    const ports = Math.max(bottomDegree[node] ?? 0, topDegree[node] ?? 0);
    const pitched = TOPOLOGY_PORT_SPREAD * (ports + 1) + TOPOLOGY_PORT_INSET * 2;
    return Math.max(
      boxWidth(id),
      // The cap bounds an ordinary box. A node whose edges no longer fit at the
      // minimum pitch must widen past it, because distinct same-family port x
      // positions need TOPOLOGY_PORT_PITCH each; capping such a box would fold
      // its later ports back onto earlier ones (exactly collinear runs).
      Math.min(TOPOLOGY_BOX_PORT_MAX_WIDTH, pitched),
      portSpanWidth(ports),
    );
  });
  const rankWidths = rankMembers.map((members) => {
    let total = 0;
    for (const node of members) total += widths[node]!;
    return total + TOPOLOGY_COLUMN_GAP * Math.max(0, members.length - 1);
  });
  let columnWidth = 0;
  for (const width of rankWidths) columnWidth = Math.max(columnWidth, width);
  const localX = new Array<number>(nodeCount).fill(0);
  for (let rank = 0; rank < rankCount; rank++) {
    let cursor = (columnWidth - (rankWidths[rank] ?? 0)) / 2;
    for (const node of rankMembers[rank]!) {
      localX[node] = cursor;
      cursor += widths[node]! + TOPOLOGY_COLUMN_GAP;
    }
  }
  const contentRight = columnWidth;
  const boxOf = (node: number): { x: number; width: number } => ({
    x: localX[node]!,
    width: widths[node]!,
  });
  const centreOf = (node: number): number => localX[node]! + widths[node]! / 2;

  // ── Ports: distinct x per edge, ordered by the other endpoint's centre ───
  const sourcePort = new Array<number>(edgeCount).fill(0);
  const targetPort = new Array<number>(edgeCount).fill(0);
  const bottomSlots: Array<Array<{ edge: number; role: "source" | "target" }>> = Array.from(
    { length: nodeCount },
    () => [],
  );
  const topSlots: number[][] = Array.from({ length: nodeCount }, () => []);
  for (let i = 0; i < edgeCount; i++) {
    // Every edge leaves its source's BOTTOM edge; a back edge also arrives at
    // its target's BOTTOM edge, so both families share one slot list there.
    bottomSlots[froms[i]!]!.push({ edge: i, role: "source" });
    if (isBack[i]!) bottomSlots[tos[i]!]!.push({ edge: i, role: "target" });
    else topSlots[tos[i]!]!.push(i);
  }
  const otherCentre = (edge: number, node: number): number =>
    froms[edge] === node ? centreOf(tos[edge]!) : centreOf(froms[edge]!);
  for (let node = 0; node < nodeCount; node++) {
    const box = boxOf(node);
    const bottom = [...bottomSlots[node]!].sort(
      (a, b) => otherCentre(a.edge, node) - otherCentre(b.edge, node) || a.edge - b.edge,
    );
    const bottomX = portPositions(box, bottom.length, false);
    for (let k = 0; k < bottom.length; k++) {
      const slot = bottom[k]!;
      if (slot.role === "source") sourcePort[slot.edge] = bottomX[k]!;
      else targetPort[slot.edge] = bottomX[k]!;
    }
    const top = [...topSlots[node]!].sort(
      (a, b) => otherCentre(a, node) - otherCentre(b, node) || a - b,
    );
    const topX = portPositions(box, top.length, true);
    for (let k = 0; k < top.length; k++) targetPort[top[k]!] = topX[k]!;
  }

  // ── Rails: one lane per rank-skipping edge, right of the box columns ─────
  const railX = new Array<number>(edgeCount).fill(0);
  let railIndex = 0;
  for (let i = 0; i < edgeCount; i++) {
    if (!isSkip[i]!) continue;
    railX[i] = round2(
      contentRight + TOPOLOGY_RAIL_GAP + railIndex * TOPOLOGY_LANE_PITCH,
    );
    railIndex += 1;
  }

  // ── Chips: only where the source is divergent, or the edge is a back edge ─
  const distinctOutcomes = ids.map((id) => declaredOutcomes.get(id)?.size ?? 0);
  const chipWidth = outcomes.map((outcome) => labelWidth(outcome));
  const wantsChip: boolean[] = new Array(edgeCount).fill(false);
  for (let i = 0; i < edgeCount; i++) {
    wantsChip[i] = isBack[i]! || (distinctOutcomes[froms[i]!] ?? 0) >= 2;
  }

  // ── One lane per horizontal run, packed inside its own channel ───────────
  const lanes: Lane[][] = Array.from({ length: rankCount }, () => []);
  const forwardLane = new Array<Lane | null>(edgeCount).fill(null);
  const railOutLane = new Array<Lane | null>(edgeCount).fill(null);
  const railInLane = new Array<Lane | null>(edgeCount).fill(null);
  for (let i = 0; i < edgeCount; i++) {
    const sourceRank = nodeRank[froms[i]!]!;
    const targetRank = nodeRank[tos[i]!]!;
    const chip = wantsChip[i]!;
    if (isBack[i]!) {
      const lane: Lane = {
        edge: i,
        channel: sourceRank,
        kind: "back",
        x1: sourcePort[i]!,
        x2: targetPort[i]!,
        chip,
        y: 0,
      };
      lanes[sourceRank]!.push(lane);
      forwardLane[i] = lane;
    } else if (!isSkip[i]!) {
      const lane: Lane = {
        edge: i,
        channel: sourceRank,
        kind: "forward",
        x1: sourcePort[i]!,
        x2: targetPort[i]!,
        chip,
        y: 0,
      };
      lanes[sourceRank]!.push(lane);
      forwardLane[i] = lane;
    } else {
      const out: Lane = {
        edge: i,
        channel: sourceRank,
        kind: "rail-out",
        x1: sourcePort[i]!,
        x2: railX[i]!,
        chip,
        y: 0,
      };
      const back: Lane = {
        edge: i,
        channel: targetRank - 1,
        kind: "rail-in",
        x1: railX[i]!,
        x2: targetPort[i]!,
        chip,
        y: 0,
      };
      lanes[sourceRank]!.push(out);
      lanes[targetRank - 1]!.push(back);
      railOutLane[i] = out;
      railInLane[i] = back;
    }
  }
  const orderedLanes = lanes.map((channel) => orderChannelLanes(channel));

  // ── Loop groups: members, the ranks they span, their own edges ───────────
  //
  // A band has to be read two ways: it must enclose the boxes, arcs and chips
  // of its OWN loop, and it must stay clear of every node outside it. Both are
  // decided from the placed geometry below, so the group keeps its member set
  // and rank span here.
  const gutterChannel = new Array<boolean>(rankCount).fill(false);
  const groups: GroupInfo[] = [];
  const rawGroups: unknown = input.loopGroups;
  if (Array.isArray(rawGroups)) {
    for (const entry of rawGroups) {
      if (!isRecord(entry)) continue;
      const id = entry.id;
      const declared = entry.nodes;
      if (typeof id !== "string" || !Array.isArray(declared)) continue;
      const members = new Set<string>();
      const memberNodes: number[] = [];
      let top = Number.MAX_SAFE_INTEGER;
      let bottom = -1;
      for (const member of declared) {
        if (typeof member !== "string") continue;
        const at = index.get(member);
        if (at === undefined || members.has(member)) continue;
        members.add(member);
        memberNodes.push(at);
        const rank = nodeRank[at]!;
        top = Math.min(top, rank);
        bottom = Math.max(bottom, rank);
      }
      if (bottom < 0) continue;
      groups.push({ id, top, bottom, members, memberNodes });
      // The band's label gutter is reserved out of the channel that ends at
      // its first covered rank, so a chip can never be painted over its name.
      if (top > 0) gutterChannel[top - 1] = true;
    }
  }

  // ── Lane depths inside a channel: gap-independent, pitch by pitch ────────
  //
  // A lane's depth below its rank's box row depends only on the lane order and
  // the pitches, never on the rank gap, so the band reserve below can be
  // measured before the gaps are known.
  const topPad = (lane: Lane): number =>
    lane.chip ? TOPOLOGY_CHIP_CLEARANCE : TOPOLOGY_LANE_CLEARANCE;
  const laneDepths: number[][] = orderedLanes.map((channel) => {
    const depths: number[] = [];
    let depth = 0;
    for (let k = 0; k < channel.length; k++) {
      depth += k === 0 ? topPad(channel[0]!) : lanePitch(channel[k - 1]!, channel[k]!);
      depths.push(depth);
    }
    return depths;
  });

  // ── Bands that must close over the channel above their top rank ──────────
  //
  // A loop's own hairpin lies BELOW its lowest member rank, but ink can also
  // sit in the channel ABOVE its highest one: a chip on an edge from a
  // divergent node above into a member of that top rank is drawn there. A band
  // whose top stayed in the label gutter would leave that chip outside it, so
  // the border rises to the top of that channel instead. The channel's lanes
  // then shift down by `bandTopOffset` (the rank gap grows by the same amount,
  // so the rhythm is unchanged) until every chip keeps the full band padding
  // inside the raised border, with TOPOLOGY_BAND_TOP_CLEARANCE left below the
  // rank above. The label keeps its own gutter above the member row.
  const raisedBandTop = new Array<boolean>(rankCount).fill(false);
  for (const group of groups) {
    if (group.top === 0) continue;
    for (const lane of orderedLanes[group.top - 1]!) {
      if (!lane.chip) continue;
      const source = ids[froms[lane.edge]!]!;
      const target = ids[tos[lane.edge]!]!;
      if (!group.members.has(source) && !group.members.has(target)) continue;
      raisedBandTop[group.top - 1] = true;
      break;
    }
  }
  const bandTopOffset = new Array<number>(rankCount).fill(0);
  for (let channel = 0; channel < rankCount; channel++) {
    if (!raisedBandTop[channel]!) continue;
    const channelLanes = orderedLanes[channel]!;
    const channelDepths = laneDepths[channel]!;
    let topmost = Number.POSITIVE_INFINITY;
    for (let k = 0; k < channelLanes.length; k++) {
      if (!channelLanes[k]!.chip) continue;
      topmost = Math.min(topmost, channelDepths[k]! - TOPOLOGY_EDGE_LABEL_HEIGHT / 2);
    }
    if (!Number.isFinite(topmost)) continue;
    bandTopOffset[channel] = Math.max(
      0,
      TOPOLOGY_BAND_PADDING + TOPOLOGY_BAND_TOP_CLEARANCE - topmost,
    );
  }

  // ── Rank gaps: one per channel, grown by its own lane count ──────────────
  const required: number[] = orderedLanes.map((channel, index) => {
    if (channel.length === 0) return 0;
    let total = topPad(channel[0]!) + topPad(channel[channel.length - 1]!);
    for (let k = 1; k < channel.length; k++) total += lanePitch(channel[k - 1]!, channel[k]!);
    if (gutterChannel[index]!) total += TOPOLOGY_BAND_HEADROOM;
    total += bandTopOffset[index]!;
    return total;
  });

  // A band also closes BELOW its own loop: under its deepest back arc or chip
  // it needs the band padding, and above the next rank's boxes it needs the
  // close clearance. The channel under a group's lowest member rank therefore
  // reserves that depth, so the band can never be cut by a box.
  const bandClose: number[] = new Array<number>(rankCount).fill(0);
  for (const group of groups) {
    const channel = group.bottom;
    if (channel + 1 >= rankCount) continue;
    const lanes = orderedLanes[channel]!;
    const depths = laneDepths[channel]!;
    let deepest = 0;
    for (let k = 0; k < lanes.length; k++) {
      const lane = lanes[k]!;
      const source = ids[froms[lane.edge]!]!;
      const target = ids[tos[lane.edge]!]!;
      const ownBack = isBack[lane.edge]! && group.members.has(source) && group.members.has(target);
      const ownChip = lane.chip && (group.members.has(source) || group.members.has(target));
      if (!ownBack && !ownChip) continue;
      const bottom = depths[k]! + (lane.chip ? TOPOLOGY_EDGE_LABEL_HEIGHT / 2 : 0);
      deepest = Math.max(deepest, bottom);
    }
    if (deepest <= 0) continue;
    bandClose[channel] = Math.max(
      bandClose[channel]!,
      deepest + TOPOLOGY_BAND_PADDING + TOPOLOGY_BAND_CLOSE_CLEARANCE,
    );
  }

  // The floor keeps the busiest channel at most twice the quietest one, so the
  // vertical rhythm stays visibly regular however busy one channel gets.
  const need = required.map((value, index) => Math.max(value, bandClose[index]!));
  let maxNeed = TOPOLOGY_RANK_GAP;
  for (const value of need) maxNeed = Math.max(maxNeed, value);
  const gapFloor = Math.max(TOPOLOGY_RANK_GAP, maxNeed / 2);
  const rankGap = need.map((value) => Math.max(gapFloor, value));
  const rankTop: number[] = [];
  let cursorY = 0;
  for (let rank = 0; rank < rankCount; rank++) {
    rankTop[rank] = cursorY;
    cursorY += TOPOLOGY_BOX_HEIGHT + (rankGap[rank] ?? TOPOLOGY_RANK_GAP);
  }
  const rankBottom = (rank: number): number => rankTop[rank]! + TOPOLOGY_BOX_HEIGHT;

  for (let rank = 0; rank < rankCount; rank++) {
    const channel = orderedLanes[rank]!;
    const depths = laneDepths[rank]!;
    for (let k = 0; k < channel.length; k++) {
      channel[k]!.y = rankBottom(rank) + bandTopOffset[rank]! + depths[k]!;
    }
  }

  // ── Routes: orthogonal polylines through the node's own ports ────────────
  const routes: Route[] = [];
  for (let i = 0; i < edgeCount; i++) {
    const sourceRank = nodeRank[froms[i]!]!;
    const targetRank = nodeRank[tos[i]!]!;
    const back = isBack[i]!;
    const points: RoutePoint[] = [];
    if (back) {
      const lane = forwardLane[i]!;
      points.push(
        { x: sourcePort[i]!, y: rankBottom(sourceRank) },
        { x: sourcePort[i]!, y: lane.y },
        { x: targetPort[i]!, y: lane.y },
        { x: targetPort[i]!, y: rankBottom(sourceRank) },
      );
    } else if (!isSkip[i]!) {
      const lane = forwardLane[i]!;
      points.push(
        { x: sourcePort[i]!, y: rankBottom(sourceRank) },
        { x: sourcePort[i]!, y: lane.y },
        { x: targetPort[i]!, y: lane.y },
        { x: targetPort[i]!, y: rankTop[targetRank]! },
      );
    } else {
      const out = railOutLane[i]!;
      const inbound = railInLane[i]!;
      points.push(
        { x: sourcePort[i]!, y: rankBottom(sourceRank) },
        { x: sourcePort[i]!, y: out.y },
        { x: railX[i]!, y: out.y },
        { x: railX[i]!, y: inbound.y },
        { x: targetPort[i]!, y: inbound.y },
        { x: targetPort[i]!, y: rankTop[targetRank]! },
      );
    }
    routes.push({ points, back });
  }
  const verticals: Array<{ edge: number; x: number; y1: number; y2: number }> = [];
  for (let i = 0; i < routes.length; i++) {
    for (const run of verticalRuns(routes[i]!.points)) {
      verticals.push({ edge: i, x: run.x, y1: run.y1, y2: run.y2 });
    }
  }

  // ── Chips: centred on their own run, clear of every other edge ───────────
  //
  // The fit reads the SAME samples the acceptance instrument reads (300 equal
  // arc-length steps along the drawn path): `own` is the distance to its own
  // path, `clearance` the distance to every other edge's path. A chip must sit
  // on its own line and well away from everyone else's, so the candidate that
  // maximises the worse of those two margins wins.
  const fits = routes.map((route) =>
    fitRoute(drawnSegments(route.points, TOPOLOGY_TURN_RADIUS), TOPOLOGY_SAMPLE_COUNT),
  );
  const chips: Array<TopologyRect | null> = new Array(edgeCount).fill(null);
  // A chip of an edge that ENTERS a member of a loop's top rank belongs inside
  // that band, and a rank-skipping edge owns two runs: only the one beside the
  // target rank is below the band's raised top, so it is preferred over the
  // lane far above the loop. That run always exists, so no chip is ever lost.
  const encloseableY = new Array<number>(edgeCount).fill(Number.NEGATIVE_INFINITY);
  for (let i = 0; i < edgeCount; i++) {
    const target = ids[tos[i]!]!;
    const targetRank = nodeRank[tos[i]!]!;
    for (const group of groups) {
      if (group.top !== targetRank || group.top === 0) continue;
      if (!group.members.has(target)) continue;
      encloseableY[i] = Math.max(
        encloseableY[i]!,
        rankBottom(group.top - 1) + TOPOLOGY_BAND_TOP_CLEARANCE,
      );
    }
  }
  for (let i = 0; i < edgeCount; i++) {
    if (!wantsChip[i]!) continue;
    const width = chipWidth[i]!;
    const fit = fits[i]!;
    let chosen:
      | { run: RouteRunSpan; centre: number; own: number; clearance: number; drift: number }
      | null = null;
    const preferredRuns = fit.runs.filter((run) => run.y >= encloseableY[i]! - 1e-9);
    for (const run of preferredRuns.length > 0 ? preferredRuns : fit.runs) {
      const blockers = verticals
        .filter(
          (vertical) =>
            vertical.edge !== i &&
            vertical.y1 < run.y - 0.25 &&
            vertical.y2 > run.y + 0.25,
        )
        .map((vertical) => vertical.x);
      const nearby: RoutePoint[] = [];
      for (let other = 0; other < edgeCount; other++) {
        if (other === i) continue;
        for (const sample of fits[other]!.samples) {
          if (Math.abs(sample.y - run.y) <= TOPOLOGY_LABEL_CLEARANCE + 1) nearby.push(sample);
        }
      }
      const runMid = (run.x1 + run.x2) / 2;
      for (const centre of chipCandidates(run, fit, blockers)) {
        const own = nearestInWindow(centre, run.y, fit.samples, 4);
        let clearance = Number.POSITIVE_INFINITY;
        for (const sample of nearby) {
          const distance = Math.hypot(sample.x - centre, sample.y - run.y);
          if (distance < clearance) clearance = distance;
        }
        const candidate = {
          run,
          centre,
          own,
          clearance,
          drift: Math.abs(centre - runMid),
        };
        if (chosen === null) {
          chosen = candidate;
          continue;
        }
        // Being ON the line is a hard requirement, so an on-line candidate
        // always wins; among those, the one furthest from every other edge
        // does. Only if a run offers nothing on its own line does the closer
        // (and then the better-separated) candidate win.
        const chosenOn = chosen.own <= TOPOLOGY_LABEL_ON_EDGE + 1e-9;
        const candidateOn = own <= TOPOLOGY_LABEL_ON_EDGE + 1e-9;
        if (candidateOn !== chosenOn) {
          if (candidateOn) chosen = candidate;
          continue;
        }
        if (candidateOn) {
          const better =
            clearance > chosen.clearance + 1e-9 ||
            (Math.abs(clearance - chosen.clearance) <= 1e-9 &&
              (own < chosen.own - 1e-9 ||
                (Math.abs(own - chosen.own) <= 1e-9 && candidate.drift < chosen.drift)));
          if (better) chosen = candidate;
          continue;
        }
        const better =
          own < chosen.own - 1e-9 ||
          (Math.abs(own - chosen.own) <= 1e-9 && clearance > chosen.clearance + 1e-9);
        if (better) chosen = candidate;
      }
    }
    if (chosen === null) continue;
    chips[i] = {
      x: round2(chosen.centre - width / 2),
      y: round2(chosen.run.y - TOPOLOGY_EDGE_LABEL_HEIGHT / 2),
      width,
      height: TOPOLOGY_EDGE_LABEL_HEIGHT,
    };
  }

  // ── Loop-group bands: around everything their own loop draws ─────────────
  //
  // A band is measured from the geometry that has ALREADY been placed, never
  // from its member rows alone: the member boxes, the group's own back arcs
  // and every chip its own edges carry all belong inside it. Its top is the
  // reserved label gutter above the highest member box, raised over the whole
  // channel above that row when a chip of a member-touching edge is drawn
  // there; its sides and bottom are that ink plus the band padding.
  //
  // Documented contract (the review's R3): one rectangle can only bound a
  // group whose members are CONTIGUOUS in each rank they occupy — a non-member
  // declared between two members of one rank necessarily falls inside that
  // rectangle, and RQ6 forbids reordering the rank to avoid it. Nested groups
  // likewise produce two overlapping rectangles. Every live declaration's
  // group is contiguous and unnested; per-member sub-outlines would be the way
  // to cover the other shapes, and that is a design change, not a fix.
  const bands: TopologyBand[] = groups.map((group) => {
    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    const include = (x: number, y: number, width: number, height: number): void => {
      left = Math.min(left, x);
      right = Math.max(right, x + width);
      bottom = Math.max(bottom, y + height);
    };
    for (const node of group.memberNodes) {
      include(localX[node]!, rankTop[nodeRank[node]!]!, widths[node]!, TOPOLOGY_BOX_HEIGHT);
    }
    for (let i = 0; i < edgeCount; i++) {
      const source = ids[froms[i]!]!;
      const target = ids[tos[i]!]!;
      const ownBack = isBack[i]! && group.members.has(source) && group.members.has(target);
      if (ownBack) {
        for (const point of routes[i]!.points) include(point.x, point.y, 0, 0);
      }
      const chip = chips[i];
      if (chip !== null && (group.members.has(source) || group.members.has(target))) {
        include(chip.x, chip.y, chip.width, chip.height);
      }
    }
    const raised = group.top > 0 && raisedBandTop[group.top - 1]!;
    const y = raised
      ? rankBottom(group.top - 1) + TOPOLOGY_BAND_TOP_CLEARANCE
      : rankTop[group.top]! - TOPOLOGY_BAND_HEADROOM;
    const x = left - TOPOLOGY_BAND_PADDING;
    const width = right - left + TOPOLOGY_BAND_PADDING * 2;
    return {
      id: group.id,
      x,
      y,
      width,
      height: bottom + TOPOLOGY_BAND_PADDING - y,
      label: {
        x: x + TOPOLOGY_BAND_LABEL_INSET_X,
        // The label keeps its place in the gutter above the member row, even
        // when the border above it has risen over the channel.
        y: rankTop[group.top]! - TOPOLOGY_BAND_HEADROOM + TOPOLOGY_BAND_LABEL_GUTTER -
          TOPOLOGY_BAND_LABEL_HEIGHT,
        width: Math.max(1, Math.round(group.id.length * TOPOLOGY_BAND_LABEL_CHAR_WIDTH)),
        height: TOPOLOGY_BAND_LABEL_HEIGHT,
      },
    };
  });

  // ── Canvas: the exact ink bounding box plus one padding per side ─────────
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const include = (x: number, y: number, width: number, height: number): void => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
  };
  for (let rank = 0; rank < rankCount; rank++) {
    for (const node of rankMembers[rank]!) {
      include(localX[node]!, rankTop[rank]!, widths[node]!, TOPOLOGY_BOX_HEIGHT);
    }
  }
  for (const route of routes) {
    for (const point of route.points) include(point.x, point.y, 0, 0);
  }
  for (const chip of chips) {
    if (chip !== null) include(chip.x, chip.y, chip.width, chip.height);
  }
  for (const band of bands) {
    include(band.x, band.y, band.width, band.height);
    include(band.label.x, band.label.y, band.label.width, band.label.height);
  }
  const offsetX = TOPOLOGY_PADDING_X - minX;
  const offsetY = TOPOLOGY_PADDING_Y - minY;
  const width = Math.ceil(maxX + offsetX + TOPOLOGY_PADDING_X);
  const height = Math.ceil(maxY + offsetY + TOPOLOGY_PADDING_Y);
  const shiftX = (x: number): number => round2(x + offsetX);
  const shiftY = (y: number): number => round2(y + offsetY);

  const boxes: TopologyBox[] = [];
  for (let rank = 0; rank < rankCount; rank++) {
    for (const node of rankMembers[rank]!) {
      boxes.push({
        id: ids[node]!,
        x: shiftX(localX[node]!),
        y: shiftY(rankTop[rank]!),
        width: widths[node]!,
        height: TOPOLOGY_BOX_HEIGHT,
        rank,
      });
    }
  }

  const edges: TopologyEdge[] = [];
  for (let i = 0; i < edgeCount; i++) {
    const route = routes[i]!;
    const chip = chips[i] ?? null;
    edges.push({
      from: ids[froms[i]!]!,
      to: ids[tos[i]!]!,
      outcome: outcomes[i]!,
      d: polylineToPath(
        drawnSegments(
          route.points.map((point) => ({ x: shiftX(point.x), y: shiftY(point.y) })),
          TOPOLOGY_TURN_RADIUS,
        ),
      ),
      back: route.back,
      label:
        chip === null
          ? null
          : {
              x: shiftX(chip.x),
              y: shiftY(chip.y),
              width: chip.width,
              height: chip.height,
            },
    });
  }

  const shiftedBands: TopologyBand[] = bands.map((band) => ({
    id: band.id,
    x: shiftX(band.x),
    y: shiftY(band.y),
    width: band.width,
    height: band.height,
    label: {
      x: shiftX(band.label.x),
      y: shiftY(band.label.y),
      width: band.label.width,
      height: band.label.height,
    },
  }));

  return { width, height, ranks, boxes, edges, bands: shiftedBands };
}
