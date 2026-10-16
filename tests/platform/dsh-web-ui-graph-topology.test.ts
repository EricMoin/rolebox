/// <reference types="bun-types" />

/**
 * `layoutGraphTopology` — the pure geometry behind the Rolebox monitor's
 * engine-graph figure (`src/platform/adapters/dsh/web-ui/graph-topology.ts`).
 *
 * The function is the only place a v3 declaration's nodes and edges become
 * coordinates, so it is tested on its own contract:
 *
 *   - RANKS over the strongly connected component condensation (a cycle can
 *     neither inflate a rank nor recurse), ordered inside each rank strictly by
 *     declaration order.
 *   - ROUTING: every edge is an orthogonal polyline that leaves its source's
 *     own bottom port and enters its target's own top (or, for a back edge,
 *     bottom) port; no two edges share a collinear run; the rank-skipping
 *     edges take a right rail outside the box columns; the back edges hairpin
 *     below their rank row.
 *   - LANES: one lane per horizontal run, packed with the exported pitch, so a
 *     chip can sit on its own line without touching a neighbour.
 *   - TIGHTNESS and CENTRING: the canvas is the ink's own bounding box plus the
 *     padding, and every rank is centred under the widest one.
 *   - CHIPS: one only for a divergent source (or a back edge), placed on its
 *     own run and clear of every other edge.
 *   - DETERMINISM, and a defensive boundary that drops unknown, self,
 *     duplicate and non-string input instead of throwing.
 *
 * @module
 */

import { describe, it, expect } from "bun:test";
import {
  layoutGraphTopology,
  TOPOLOGY_BOX_HEIGHT,
  TOPOLOGY_BOX_MAX_WIDTH,
  TOPOLOGY_BOX_MIN_WIDTH,
  TOPOLOGY_LABEL_CLEARANCE,
  TOPOLOGY_LANE_PITCH,
  TOPOLOGY_PADDING_X,
  TOPOLOGY_PADDING_Y,
  TOPOLOGY_PORT_PITCH,
  TOPOLOGY_RANK_GAP,
  TOPOLOGY_SAMPLE_COUNT,
  type TopologyBox,
  type TopologyEdge,
  type TopologyLayout,
} from "../../src/platform/adapters/dsh/web-ui/graph-topology.ts";

interface Point {
  x: number;
  y: number;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Segment =
  | { kind: "L"; x1: number; y1: number; x2: number; y2: number }
  | { kind: "Q"; x1: number; y1: number; cx: number; cy: number; x2: number; y2: number };

/** The `d` grammar the layout is allowed to emit (and nothing else). */
function parsePath(d: string): Segment[] {
  const tokens = d.trim().split(/[\s,]+/);
  const segments: Segment[] = [];
  let at = 0;
  let x = 0;
  let y = 0;
  const next = (): number => Number(tokens[at++]!);
  while (at < tokens.length) {
    const command = tokens[at++]!;
    if (command === "M") {
      x = next();
      y = next();
    } else if (command === "L") {
      const x2 = next();
      const y2 = next();
      segments.push({ kind: "L", x1: x, y1: y, x2, y2 });
      x = x2;
      y = y2;
    } else if (command === "Q") {
      const cx = next();
      const cy = next();
      const x2 = next();
      const y2 = next();
      segments.push({ kind: "Q", x1: x, y1: y, cx, cy, x2, y2 });
      x = x2;
      y = y2;
    } else {
      throw new Error("unexpected path command " + command + " in " + d);
    }
  }
  return segments;
}

/** The path's start (the source's bottom port). */
function pathStart(d: string): Point {
  const match = /^M\s+(-?[\d.]+)\s+(-?[\d.]+)/.exec(d.trim());
  if (match === null) throw new Error("path has no move: " + d);
  return { x: Number(match[1]), y: Number(match[2]) };
}

/** The path's end (the port the edge enters). */
function pathEnd(d: string): Point {
  const segments = parsePath(d);
  const last = segments[segments.length - 1]!;
  return { x: last.x2, y: last.y2 };
}

/** The flattened polyline of a path — corners sampled into short chords. */
function routePolyline(d: string, steps = 64): Point[] {
  const segments = parsePath(d);
  const points: Point[] = [];
  if (segments.length === 0) return points;
  points.push({ x: segments[0]!.x1, y: segments[0]!.y1 });
  for (const segment of segments) {
    if (segment.kind === "L") {
      points.push({ x: segment.x2, y: segment.y2 });
      continue;
    }
    const from = points[points.length - 1]!;
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const s = 1 - t;
      points.push({
        x: s * s * from.x + 2 * s * t * segment.cx + t * t * segment.x2,
        y: s * s * from.y + 2 * s * t * segment.cy + t * t * segment.y2,
      });
    }
    void segment;
  }
  return points;
}

/**
 * The equal arc-length samples the acceptance instrument reads (`getPointAt
 * Length` at `count` even steps), so the label rules are checked against the
 * same points the browser measures.
 */
function samplePath(d: string, count = TOPOLOGY_SAMPLE_COUNT): Point[] {
  const polyline = routePolyline(d);
  if (polyline.length === 0) return [];
  const cumulative: number[] = [0];
  for (let i = 1; i < polyline.length; i++) {
    const previous = polyline[i - 1]!;
    const current = polyline[i]!;
    cumulative.push(
      cumulative[i - 1]! + Math.hypot(current.x - previous.x, current.y - previous.y),
    );
  }
  const total = cumulative[cumulative.length - 1]!;
  const out: Point[] = [];
  if (total <= 0) return [polyline[0]!];
  let at = 0;
  for (let index = 0; index <= count; index++) {
    const target = (total * index) / count;
    while (at < cumulative.length - 2 && cumulative[at + 1]! < target) at += 1;
    const spanStart = cumulative[at]!;
    const spanEnd = cumulative[at + 1]!;
    const t = spanEnd === spanStart ? 0 : (target - spanStart) / (spanEnd - spanStart);
    const from = polyline[at]!;
    const to = polyline[at + 1]!;
    out.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
  }
  return out;
}

/** Every straight horizontal run a path draws (the corners are `Q` pieces). */
function horizontalRuns(d: string): Array<{ y: number; x1: number; x2: number }> {
  return parsePath(d)
    .filter(
      (segment): segment is Extract<Segment, { kind: "L" }> =>
        segment.kind === "L" && segment.y1 === segment.y2,
    )
    .map((segment) => ({
      y: segment.y1,
      x1: Math.min(segment.x1, segment.x2),
      x2: Math.max(segment.x1, segment.x2),
    }));
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function inside(box: Rect, point: Point, inset = 1): boolean {
  return (
    box.x + inset < point.x &&
    point.x < box.x + box.width - inset &&
    box.y + inset < point.y &&
    point.y < box.y + box.height - inset
  );
}

/** How many points of `a` have a twin in `b` (the shared-run measurement). */
function coincidentSamples(a: Point[], b: Point[], tolerance = 0.75): number {
  let count = 0;
  for (const point of a) {
    for (const other of b) {
      if (Math.abs(point.x - other.x) <= tolerance && Math.abs(point.y - other.y) <= tolerance) {
        count += 1;
        break;
      }
    }
  }
  return count;
}

function edgeName(edge: TopologyEdge): string {
  return edge.from + " -" + edge.outcome + "-> " + edge.to;
}

function chipEdges(layout: TopologyLayout): TopologyEdge[] {
  return layout.edges.filter((edge) => edge.label !== null);
}

/** The chips as plain rectangles (the layout models "no chip" as null). */
function chips(layout: TopologyLayout): Rect[] {
  return layout.edges
    .map((edge) => edge.label)
    .filter((label): label is Rect => label !== null);
}

interface Declaration {
  nodes: Array<{ id: string }>;
  edges: Array<{ from: string; to: string; outcome: string }>;
  loopGroups?: Array<{ id: string; nodes: string[] }>;
}

function declare(declaration: Declaration): TopologyLayout {
  return layoutGraphTopology({
    nodes: declaration.nodes,
    edges: declaration.edges,
    loopGroups: declaration.loopGroups,
  });
}

/** The live `perf-mesh-r0-c0` shape: two fans, a join, a cycle and a skip. */
const MESH: Declaration = {
  nodes: [
    "in-a",
    "in-b",
    "w-1",
    "w-2",
    "w-3",
    "w-4",
    "w-5",
    "j-quorum",
    "j-all",
    "loop-work",
    "loop-check",
    "sink",
    "err-sink",
  ].map((id) => ({ id })),
  edges: [
    { from: "in-a", to: "w-1", outcome: "ok" },
    { from: "in-a", to: "w-2", outcome: "ok" },
    { from: "in-a", to: "w-3", outcome: "ok" },
    { from: "in-b", to: "w-4", outcome: "ok" },
    { from: "in-b", to: "w-5", outcome: "ok" },
    { from: "w-1", to: "j-quorum", outcome: "ok" },
    { from: "w-2", to: "j-quorum", outcome: "ok" },
    { from: "w-3", to: "j-quorum", outcome: "ok" },
    { from: "w-4", to: "j-all", outcome: "ok" },
    { from: "w-5", to: "j-all", outcome: "ok" },
    { from: "j-quorum", to: "loop-work", outcome: "ok" },
    { from: "loop-work", to: "loop-check", outcome: "draft" },
    { from: "loop-check", to: "loop-work", outcome: "retry" },
    { from: "loop-check", to: "sink", outcome: "done" },
    { from: "j-all", to: "sink", outcome: "ok" },
    { from: "w-2", to: "err-sink", outcome: "fail" },
  ],
  loopGroups: [{ id: "refine", nodes: ["loop-work", "loop-check"] }],
};

/** The ink the canvas must wrap: boxes, chips, bands and every path. */
function inkBounds(layout: TopologyLayout): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  const include = (x: number, y: number, width: number, height: number): void => {
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x + width);
    bottom = Math.max(bottom, y + height);
  };
  for (const box of layout.boxes) include(box.x, box.y, box.width, box.height);
  for (const chip of chips(layout)) include(chip.x, chip.y, chip.width, chip.height);
  for (const band of layout.bands) {
    include(band.x, band.y, band.width, band.height);
    include(band.label.x, band.label.y, band.label.width, band.label.height);
  }
  for (const edge of layout.edges) {
    for (const point of samplePath(edge.d, 120)) include(point.x, point.y, 0, 0);
  }
  return { left, top, right, bottom };
}

/**
 * Every rank reads left to right in declaration order: the box order the
 * acceptance instrument reads off the rendered `x` attributes.
 */
function expectDeclaredRankOrder(layout: TopologyLayout, declared: readonly string[]): void {
  const at = new Map(declared.map((id, index) => [id, index]));
  const rows = new Map<number, TopologyBox[]>();
  for (const box of layout.boxes) {
    const row = rows.get(box.y) ?? [];
    row.push(box);
    rows.set(box.y, row);
  }
  for (const [y, row] of rows) {
    const drawn = [...row].sort((a, b) => a.x - b.x).map((box) => box.id);
    const declaredOrder = [...row].sort((a, b) => at.get(a.id)! - at.get(b.id)!).map((box) => box.id);
    expect(drawn, "rank at y=" + y + " is not in declaration order").toEqual(declaredOrder);
  }
}

/** `a` swallowed `b` whole, with `slack` pixels to spare on every side. */
function containsClear(a: Rect, b: Rect, slack: number): boolean {
  return (
    b.x >= a.x + slack &&
    b.x + b.width <= a.x + a.width - slack &&
    b.y >= a.y + slack &&
    b.y + b.height <= a.y + a.height - slack
  );
}

/** `a` and `b` are at least `slack` apart (no shared pixel nearer than that). */
function apartBy(a: Rect, b: Rect, slack: number): boolean {
  return (
    b.x + b.width <= a.x - slack ||
    b.x >= a.x + a.width + slack ||
    b.y + b.height <= a.y - slack ||
    b.y >= a.y + a.height + slack
  );
}

function overlapsInset(a: Rect, b: Rect, inset: number): boolean {
  return !(
    a.x + a.width - inset <= b.x + inset ||
    b.x + b.width - inset <= a.x + inset ||
    a.y + a.height - inset <= b.y + inset ||
    b.y + b.height - inset <= a.y + inset
  );
}

/**
 * Every property a loop-group band must hold, as plain problems: it encloses
 * its member boxes, its own back arcs and its own chips; it contains no
 * non-member box (2px clear); no chip comes within 2px of its border; bands
 * never overlap. Empty means the band is correct.
 */
function bandProblems(layout: TopologyLayout, declaration: Declaration): string[] {
  const problems: string[] = [];
  const groups = new Map(
    (declaration.loopGroups ?? []).map((group) => [group.id, new Set(group.nodes)]),
  );
  for (const band of layout.bands) {
    const members = groups.get(band.id) ?? new Set<string>();
    const rect: Rect = { x: band.x, y: band.y, width: band.width, height: band.height };
    for (const box of layout.boxes) {
      const boxRect = { x: box.x, y: box.y, width: box.width, height: box.height };
      if (members.has(box.id) && !containsClear(rect, boxRect, -1.5)) {
        problems.push("band " + band.id + " misses member box " + box.id);
      }
      if (!members.has(box.id) && overlapsInset(rect, boxRect, 2)) {
        problems.push("band " + band.id + " contains non-member box " + box.id);
      }
    }
    for (const edge of layout.edges) {
      if (!edge.back || !members.has(edge.from) || !members.has(edge.to)) continue;
      const escaped = samplePath(edge.d).filter(
        (point) =>
          !(
            rect.x - 1.5 <= point.x &&
            point.x <= rect.x + rect.width + 1.5 &&
            rect.y - 1.5 <= point.y &&
            point.y <= rect.y + rect.height + 1.5
          ),
      );
      if (escaped.length > 0) {
        problems.push(
          "band " + band.id + " lets arc " + edgeName(edge) + " escape (" + escaped.length + " samples)",
        );
      }
    }
    for (const edge of layout.edges) {
      if (edge.label === null) continue;
      if ((members.has(edge.from) || members.has(edge.to)) && !containsClear(rect, edge.label, -1.5)) {
        problems.push("band " + band.id + " misses the chip of " + edgeName(edge));
      }
      if (!containsClear(rect, edge.label, 2) && !apartBy(rect, edge.label, 2)) {
        problems.push("chip " + edgeName(edge) + " lies on the border of band " + band.id);
      }
    }
  }
  for (let i = 0; i < layout.bands.length; i++) {
    for (let j = i + 1; j < layout.bands.length; j++) {
      const a = layout.bands[i]!;
      const b = layout.bands[j]!;
      if (overlaps({ x: a.x, y: a.y, width: a.width, height: a.height }, b)) {
        problems.push("bands " + a.id + " and " + b.id + " overlap");
      }
    }
  }
  return problems;
}

describe("layoutGraphTopology", () => {
  it("ranks a linear chain 0, 1, 2 top to bottom", () => {
    const layout = declare({
      nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
      edges: [
        { from: "a", to: "b", outcome: "done" },
        { from: "b", to: "c", outcome: "done" },
      ],
    });

    expect(layout.ranks).toEqual([["a"], ["b"], ["c"]]);
    expect(layout.boxes.map((box) => [box.id, box.rank])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
    const [a, b, c] = layout.boxes;
    expect(a!.y).toBeLessThan(b!.y);
    expect(b!.y).toBeLessThan(c!.y);
    expect(layout.edges.map((edge) => edge.back)).toEqual([false, false]);
    // The quiet base gap is what a two-lane channel gets.
    expect(b!.y - (a!.y + a!.height)).toBe(TOPOLOGY_RANK_GAP);
  });

  it("puts both branches of a diamond on one rank and the join below them", () => {
    const layout = declare({
      nodes: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
      edges: [
        { from: "a", to: "b", outcome: "left" },
        { from: "a", to: "c", outcome: "right" },
        { from: "b", to: "d", outcome: "done" },
        { from: "c", to: "d", outcome: "done" },
      ],
    });

    expect(layout.ranks).toEqual([["a"], ["b", "c"], ["d"]]);
    const b = layout.boxes.find((box) => box.id === "b")!;
    const c = layout.boxes.find((box) => box.id === "c")!;
    const d = layout.boxes.find((box) => box.id === "d")!;
    expect(b.y).toBe(c.y);
    expect(d.y).toBeGreaterThan(b.y);
    expect(layout.edges.every((edge) => edge.back === false)).toBe(true);
  });

  it("keeps a rank in declaration order, never in crossing order", () => {
    // `w-1` has two neighbours one rank up and `w-2` one, so a barycenter pass
    // would pull `w-2` in front of it. Declaration order must win: the figure
    // is a stable projection of the declaration, and the runs stay tidy
    // because an edge's PORTS are ordered by the other end's x instead.
    const layout = declare({
      nodes: [{ id: "s-1" }, { id: "s-2" }, { id: "w-1" }, { id: "w-2" }],
      edges: [
        { from: "s-1", to: "w-1", outcome: "ok" },
        { from: "s-1", to: "w-2", outcome: "ok" },
        { from: "s-2", to: "w-1", outcome: "ok" },
      ],
    });

    expect(layout.ranks).toEqual([["s-1", "s-2"], ["w-1", "w-2"]]);
    expectDeclaredRankOrder(layout, ["s-1", "s-2", "w-1", "w-2"]);
    // Every rank still shares one centre.
    expectCentreShared(layout);
  });

  it("keeps two fans of five workers in declaration order (the perf-mesh shape)", () => {
    // The live `perf-mesh-r0-c0`: two sources fan into five workers whose
    // second worker also feeds a later rank, plus the quorum/all joins and the
    // refine loop. Crossing reduction used to scramble the rows into
    // `w-1, w-3, w-2, w-4, w-5` and `j-quorum, err-sink, j-all`.
    const layout = declare(MESH);

    expect(layout.ranks).toEqual([
      ["in-a", "in-b"],
      ["w-1", "w-2", "w-3", "w-4", "w-5"],
      ["j-quorum", "j-all", "err-sink"],
      ["loop-work", "loop-check"],
      ["sink"],
    ]);
    expectDeclaredRankOrder(layout, MESH.nodes.map((node) => node.id));
    // The two port families are still ordered by the other end's x, so the
    // worker row's outgoing ports read left to right like the row itself.
    const joiner = layout.boxes.find((box) => box.id === "w-1")!;
    const w2 = layout.boxes.find((box) => box.id === "w-2")!;
    expect(joiner.x).toBeLessThan(w2.x);
  });

  it("gives a cycle one shared rank and marks both of its edges back", () => {
    const layout = declare({
      nodes: [{ id: "change" }, { id: "review" }],
      edges: [
        { from: "change", to: "review", outcome: "done" },
        { from: "review", to: "change", outcome: "revise" },
      ],
    });

    // One SCC, one rank: a cycle can never inflate the rank count.
    expect(layout.ranks).toEqual([["change", "review"]]);
    expect(layout.boxes.map((box) => box.rank)).toEqual([0, 0]);
    expect(layout.edges.map((edge) => edge.back)).toEqual([true, true]);
    // A back edge hairpins BELOW its rank's box row and never crosses a box.
    const rowBottom = Math.max(...layout.boxes.map((box) => box.y + box.height));
    for (const edge of layout.edges) {
      for (const point of samplePath(edge.d, 200)) {
        expect(point.y).toBeGreaterThanOrEqual(rowBottom - 0.5);
      }
      // Its chip sits on its own hairpin's run.
      expect(edge.label).not.toBeNull();
      const centre = {
        x: edge.label!.x + edge.label!.width / 2,
        y: edge.label!.y + edge.label!.height / 2,
      };
      expect(centre.y).toBeGreaterThan(rowBottom);
    }
  });

  it("is deterministic for the same graph passed twice", () => {
    const declaration: Declaration = {
      nodes: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
      edges: [
        { from: "a", to: "b", outcome: "done" },
        { from: "b", to: "c", outcome: "revise" },
        { from: "c", to: "b", outcome: "again" },
        { from: "c", to: "d", outcome: "done" },
      ],
      loopGroups: [{ id: "lg-1", nodes: ["b", "c"] }],
    };
    const first = declare(declaration);
    const second = declare(declaration);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("drops unknown-node, self and duplicate edges", () => {
    const layout = layoutGraphTopology({
      nodes: [{ id: "a" }, { id: "b" }],
      edges: [
        { from: "a", to: "ghost", outcome: "done" },
        { from: "ghost", to: "b", outcome: "done" },
        { from: "a", to: "a", outcome: "done" },
        { from: "a", to: "b", outcome: "done" },
        { from: "a", to: "b", outcome: "done" },
        { from: "a", to: "b", outcome: "revise" },
      ],
    });

    expect(layout.edges.map((edge) => edge.from + "/" + edge.outcome + "/" + edge.to)).toEqual([
      "a/done/b",
      "a/revise/b",
    ]);
    expect(layout.ranks).toEqual([["a"], ["b"]]);
  });

  it("ignores non-string ids and nodes that are not records", () => {
    const layout = layoutGraphTopology({
      nodes: [
        { id: 42 } as unknown as { id: string },
        null as unknown as { id: string },
        { id: "ok" },
      ],
      edges: [],
    });

    expect(layout.boxes.map((box) => box.id)).toEqual(["ok"]);
    expect(layout.ranks).toEqual([["ok"]]);
  });

  it("returns the zero-size layout for empty or unusable input", () => {
    const empty = { width: 0, height: 0, ranks: [], boxes: [], edges: [], bands: [] };
    expect(layoutGraphTopology({ nodes: [], edges: [] })).toEqual(empty);
    expect(
      layoutGraphTopology({ nodes: [], edges: [{ from: "a", to: "b", outcome: "x" }] }),
    ).toEqual(empty);
    expect(layoutGraphTopology(undefined as never)).toEqual(empty);
    expect(layoutGraphTopology(null as never)).toEqual(empty);
    expect(layoutGraphTopology({} as never)).toEqual(empty);
  });

  it("keeps a single node as one positive-size box with no edges", () => {
    const layout = layoutGraphTopology({ nodes: [{ id: "solo" }], edges: [] });
    expect(layout.ranks).toEqual([["solo"]]);
    expect(layout.boxes).toHaveLength(1);
    expect(layout.edges).toEqual([]);
    expect(layout.bands).toEqual([]);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
    expect(layout.boxes[0]!.width).toBeGreaterThanOrEqual(TOPOLOGY_BOX_MIN_WIDTH);
    expect(layout.boxes[0]!.width).toBeLessThanOrEqual(TOPOLOGY_BOX_MAX_WIDTH);
    expect(layout.boxes[0]!.height).toBe(TOPOLOGY_BOX_HEIGHT);
  });

  it("never overlaps two boxes of one rank on x", () => {
    const layout = declare({
      nodes: [{ id: "a" }, { id: "bbbbbbbbbbbb" }, { id: "ccc" }],
      edges: [
        { from: "a", to: "bbbbbbbbbbbb", outcome: "x" },
        { from: "a", to: "ccc", outcome: "y" },
      ],
    });

    const rank = layout.ranks[1]!;
    const boxes = rank
      .map((id) => layout.boxes.find((box) => box.id === id)!)
      .sort((left, right) => left.x - right.x);
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i]!.x).toBeGreaterThanOrEqual(boxes[i - 1]!.x + boxes[i - 1]!.width);
    }
  });

  it("agrees with its boxes: positive size that contains every box", () => {
    const layout = declare({
      nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
      edges: [
        { from: "a", to: "b", outcome: "done" },
        { from: "b", to: "c", outcome: "done" },
      ],
    });

    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
    for (const box of layout.boxes) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(layout.width);
      expect(box.y + box.height).toBeLessThanOrEqual(layout.height);
    }
  });

  it("gives every declared edge its own outgoing and incoming port", () => {
    const layout = declare(MESH);

    // The path starts on the source's bottom port and ends on the target's own
    // port, so the ports can be read straight off the drawn path.
    const sourcePorts = new Map<string, Array<{ x: number; key: number }>>();
    const targetPorts = new Map<string, Array<{ x: number; key: number }>>();
    const centre = (id: string): number => {
      const box = layout.boxes.find((entry) => entry.id === id)!;
      return box.x + box.width / 2;
    };
    for (const edge of layout.edges) {
      const bottom = pathStart(edge.d);
      const top = pathEnd(edge.d);
      const outgoing = sourcePorts.get(edge.from) ?? [];
      outgoing.push({ x: bottom.x, key: centre(edge.to) });
      sourcePorts.set(edge.from, outgoing);
      const incoming = targetPorts.get(edge.to) ?? [];
      const other = edge.back ? edge.from : edge.from;
      incoming.push({ x: top.x, key: centre(other) });
      targetPorts.set(edge.to, incoming);
    }
    for (const [id, ports] of sourcePorts) {
      const xs = ports.map((port) => port.x);
      expect(new Set(xs).size, id + " shares a source port").toBe(xs.length);
      const ordered = [...ports].sort((a, b) => a.key - b.key);
      for (let i = 1; i < ordered.length; i++) {
        expect(ordered[i]!.x).toBeGreaterThanOrEqual(ordered[i - 1]!.x);
      }
    }
    for (const [id, ports] of targetPorts) {
      const xs = ports.map((port) => port.x);
      expect(new Set(xs).size, id + " shares a target port").toBe(xs.length);
      const ordered = [...ports].sort((a, b) => a.key - b.key);
      for (let i = 1; i < ordered.length; i++) {
        expect(ordered[i]!.x).toBeGreaterThanOrEqual(ordered[i - 1]!.x);
      }
    }
  });

  it("keeps every port distinct however many edges one box carries", () => {
    // A box used to be capped at TOPOLOGY_BOX_PORT_MAX_WIDTH and its later ports
    // clamped back onto an earlier x, so two edges could leave the SAME port and
    // draw hundreds of pixels of exactly collinear run. The cap must give way to
    // the minimum pitch instead.
    for (const count of [125, 128, 129, 200]) {
      const fanOut = declare({
        nodes: [{ id: "src" }, ...Array.from({ length: count }, (_, i) => ({ id: "dst-" + i }))],
        edges: Array.from({ length: count }, (_, i) => ({
          from: "src",
          to: "dst-" + i,
          outcome: "ok",
        })),
      });
      const source = fanOut.boxes.find((box) => box.id === "src")!;
      const bottoms = fanOut.edges.map((edge) => pathStart(edge.d).x);
      expect(new Set(bottoms).size, count + " outgoing ports").toBe(count);
      for (const x of [...bottoms].sort((a, b) => a - b)) {
        // Every bottom port is its own half-pixel column (even family) ...
        expect(Math.abs((((x - 0.5) % 2) + 2) % 2)).toBeCloseTo(0, 9);
        // ... strictly inside the box ...
        expect(x).toBeGreaterThan(source.x);
        expect(x).toBeLessThan(source.x + source.width);
      }
      const orderedBottoms = [...bottoms].sort((a, b) => a - b);
      for (let i = 1; i < orderedBottoms.length; i++) {
        expect(orderedBottoms[i]! - orderedBottoms[i - 1]!, "outgoing port pitch")
          .toBeGreaterThanOrEqual(TOPOLOGY_PORT_PITCH);
      }
      // ... and no two edges share the vertical run out of the box.
      const verticals: Array<{ x: number; y1: number; y2: number }> = [];
      for (const edge of fanOut.edges) {
        for (const segment of parsePath(edge.d)) {
          if (segment.kind !== "L" || segment.x1 !== segment.x2) continue;
          verticals.push({
            x: segment.x1,
            y1: Math.min(segment.y1, segment.y2),
            y2: Math.max(segment.y1, segment.y2),
          });
        }
      }
      for (let i = 0; i < verticals.length; i++) {
        for (let j = i + 1; j < verticals.length; j++) {
          const a = verticals[i]!;
          const b = verticals[j]!;
          if (Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) <= 0) continue;
          expect(Math.abs(a.x - b.x), count + " edges share a vertical run").toBeGreaterThan(0.75);
        }
      }
    }

    // The fan-IN mirror: many sources into one target's top edge.
    const count = 200;
    const fanIn = declare({
      nodes: [...Array.from({ length: count }, (_, i) => ({ id: "src-" + i })), { id: "dst" }],
      edges: Array.from({ length: count }, (_, i) => ({
        from: "src-" + i,
        to: "dst",
        outcome: "ok",
      })),
    });
    const target = fanIn.boxes.find((box) => box.id === "dst")!;
    const tops = fanIn.edges.map((edge) => pathEnd(edge.d).x);
    expect(new Set(tops).size, "incoming ports").toBe(count);
    for (const x of tops) {
      // A top port lives on the odd family, so it can never coincide with a
      // bottom port or with a rail x (an integer).
      expect(Math.abs((((x - 1.5) % 2) + 2) % 2)).toBeCloseTo(0, 9);
      expect(x).toBeGreaterThan(target.x);
      expect(x).toBeLessThan(target.x + target.width);
    }
    const orderedTops = [...tops].sort((a, b) => a - b);
    for (let i = 1; i < orderedTops.length; i++) {
      expect(orderedTops[i]! - orderedTops[i - 1]!, "incoming port pitch")
        .toBeGreaterThanOrEqual(TOPOLOGY_PORT_PITCH);
    }
  });

  it("never lets two vertical runs share an x", () => {
    const layout = declare(MESH);
    const verticals: Array<{ x: number; y1: number; y2: number; edge: string }> = [];
    for (const edge of layout.edges) {
      for (const segment of parsePath(edge.d)) {
        if (segment.kind !== "L" || segment.x1 !== segment.x2) continue;
        verticals.push({
          x: segment.x1,
          y1: Math.min(segment.y1, segment.y2),
          y2: Math.max(segment.y1, segment.y2),
          edge: edgeName(edge),
        });
      }
    }
    for (let i = 0; i < verticals.length; i++) {
      for (let j = i + 1; j < verticals.length; j++) {
        const a = verticals[i]!;
        const b = verticals[j]!;
        if (a.edge === b.edge) continue;
        if (Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) <= 0) continue;
        expect(Math.abs(a.x - b.x), a.edge + " and " + b.edge + " share a vertical").toBeGreaterThan(
          0.75,
        );
      }
    }
  });

  it("never lets two edges share a collinear run", () => {
    for (const declaration of [MESH, meshFan(), cycleAndTail()]) {
      const layout = declare(declaration);
      const samples = layout.edges.map((edge) => samplePath(edge.d));
      for (let i = 0; i < samples.length; i++) {
        for (let j = i + 1; j < samples.length; j++) {
          expect(
            coincidentSamples(samples[i]!, samples[j]!),
            edgeName(layout.edges[i]!) + " shares a run with " + edgeName(layout.edges[j]!),
          ).toBeLessThanOrEqual(4);
        }
      }
    }
  });

  it("keeps every edge clear of a node it does not touch", () => {
    const layout = declare(MESH);
    for (const edge of layout.edges) {
      const points = samplePath(edge.d, 200);
      for (const box of layout.boxes) {
        if (box.id === edge.from || box.id === edge.to) continue;
        for (const point of points) {
          expect(
            inside({ x: box.x, y: box.y, width: box.width, height: box.height }, point),
            edgeName(edge) + " crosses node " + box.id,
          ).toBe(false);
        }
      }
    }
  });

  it("gives two runs that overlap on x their own lane", () => {
    const layout = declare(MESH);
    const runs: Array<{ y: number; x1: number; x2: number; edge: string }> = [];
    for (const edge of layout.edges) {
      for (const run of horizontalRuns(edge.d)) {
        runs.push({ ...run, edge: edgeName(edge) });
      }
    }
    for (let i = 0; i < runs.length; i++) {
      for (let j = i + 1; j < runs.length; j++) {
        const a = runs[i]!;
        const b = runs[j]!;
        if (Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) <= 0) continue;
        expect(
          Math.abs(a.y - b.y),
          a.edge + " and " + b.edge + " share a lane",
        ).toBeGreaterThanOrEqual(TOPOLOGY_LANE_PITCH);
      }
    }
  });

  it("wraps the ink with one padding per side and nothing more", () => {
    for (const declaration of [MESH, meshFan(), cycleAndTail()]) {
      const layout = declare(declaration);
      const ink = inkBounds(layout);
      const margins = {
        left: ink.left,
        top: ink.top,
        right: layout.width - ink.right,
        bottom: layout.height - ink.bottom,
      };
      for (const [side, margin] of Object.entries(margins)) {
        expect(margin, "canvas " + side + " margin").toBeGreaterThanOrEqual(0);
        expect(margin, "canvas " + side + " margin").toBeLessThanOrEqual(22);
      }
      expect(margins.left).toBeLessThanOrEqual(TOPOLOGY_PADDING_X + 6);
      expect(margins.top).toBeLessThanOrEqual(TOPOLOGY_PADDING_Y + 6);
    }
  });

  it("centres every rank under the widest one", () => {
    expectCentreShared(declare(MESH));
    expectCentreShared(declare(meshFan()));
    expectCentreShared(declare(cycleAndTail()));
  });

  it("routes a rank-skipping edge down a rail outside the box columns", () => {
    const layout = declare(MESH);
    const skip = layout.edges.find((edge) => edge.from === "j-all" && edge.to === "sink")!;
    const right = Math.max(...layout.boxes.map((box) => box.x + box.width));
    // It leaves the box columns to the right, and that rail is IN the canvas.
    const farthest = Math.max(...samplePath(skip.d, 200).map((point) => point.x));
    expect(farthest).toBeGreaterThan(right);
    expect(layout.width).toBeGreaterThanOrEqual(farthest);
    expect(skip.back).toBe(false);
    // The rail belongs to that edge only.
    const others = layout.edges.filter((edge) => edge !== skip);
    for (const point of samplePath(skip.d, 200)) {
      if (point.x <= right) continue;
      for (const other of others) {
        const distance = Math.min(
          ...samplePath(other.d, 200).map((candidate) =>
            Math.hypot(candidate.x - point.x, candidate.y - point.y),
          ),
        );
        expect(distance).toBeGreaterThan(1);
      }
    }
  });

  it("draws a chip only for a divergent source or a back edge", () => {
    const layout = declare(MESH);
    const declared = new Map<string, Set<string>>();
    for (const edge of MESH.edges) {
      const bucket = declared.get(edge.from) ?? new Set<string>();
      bucket.add(edge.outcome);
      declared.set(edge.from, bucket);
    }
    // The mesh's real readings: 16 edges, 5 chips.
    expect(layout.edges).toHaveLength(MESH.edges.length);
    expect(chipEdges(layout)).toHaveLength(5);
    expect(chipEdges(layout).map(edgeName).sort()).toEqual([
      "loop-check -done-> sink",
      "loop-check -retry-> loop-work",
      "loop-work -draft-> loop-check",
      "w-2 -fail-> err-sink",
      "w-2 -ok-> j-quorum",
    ]);
    for (const edge of layout.edges) {
      const wants = edge.back || (declared.get(edge.from)?.size ?? 0) >= 2;
      expect(edge.label !== null, edgeName(edge)).toBe(wants);
    }
  });

  it("centres every chip on its own edge and clear of the others", () => {
    for (const declaration of [MESH, meshFan(), cycleAndTail()]) {
      const layout = declare(declaration);
      const samples = layout.edges.map((edge) => samplePath(edge.d));
      for (let index = 0; index < layout.edges.length; index++) {
        const edge = layout.edges[index]!;
        if (edge.label === null) continue;
        const centre = {
          x: edge.label.x + edge.label.width / 2,
          y: edge.label.y + edge.label.height / 2,
        };
        const own = Math.min(
          ...samples[index]!.map((point) => Math.hypot(point.x - centre.x, point.y - centre.y)),
        );
        expect(own, "chip " + edgeName(edge) + " is off its own edge").toBeLessThanOrEqual(1.5);
        for (let other = 0; other < layout.edges.length; other++) {
          if (other === index) continue;
          const distance = Math.min(
            ...samples[other]!.map((point) =>
              Math.hypot(point.x - centre.x, point.y - centre.y),
            ),
          );
          expect(
            distance,
            "chip " + edgeName(edge) + " sits on " + edgeName(layout.edges[other]!),
          ).toBeGreaterThanOrEqual(TOPOLOGY_LABEL_CLEARANCE);
        }
      }
    }
  });

  it("keeps chips, boxes and band labels from overlapping", () => {
    for (const declaration of [MESH, meshFan(), cycleAndTail()]) {
      const layout = declare(declaration);
      const rectangles = chips(layout);
      for (let i = 0; i < rectangles.length; i++) {
        for (let j = i + 1; j < rectangles.length; j++) {
          expect(overlaps(rectangles[i]!, rectangles[j]!), "two chips overlap").toBe(false);
        }
      }
      for (const chip of rectangles) {
        for (const box of layout.boxes) {
          expect(
            overlaps(chip, { x: box.x, y: box.y, width: box.width, height: box.height }),
            "a chip overlaps node " + box.id,
          ).toBe(false);
        }
      }
      for (const band of layout.bands) {
        for (const box of layout.boxes) {
          expect(
            overlaps(band.label, { x: box.x, y: box.y, width: box.width, height: box.height }),
            "band " + band.id + " overlaps node " + box.id,
          ).toBe(false);
        }
      }
      for (let i = 0; i < layout.boxes.length; i++) {
        for (let j = i + 1; j < layout.boxes.length; j++) {
          const a = layout.boxes[i]!;
          const b = layout.boxes[j]!;
          expect(
            overlaps(
              { x: a.x, y: a.y, width: a.width, height: a.height },
              { x: b.x, y: b.y, width: b.width, height: b.height },
            ),
            "nodes " + a.id + " and " + b.id + " overlap",
          ).toBe(false);
        }
      }
    }
  });

  it("gives a loop group one band over the ranks its members occupy", () => {
    const layout = declare({
      nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
      edges: [
        { from: "a", to: "b", outcome: "done" },
        { from: "b", to: "c", outcome: "next" },
        { from: "c", to: "b", outcome: "revise" },
      ],
      loopGroups: [{ id: "lg-1", nodes: ["b", "c"] }],
    });

    expect(layout.bands).toHaveLength(1);
    const band = layout.bands[0]!;
    expect(band.id).toBe("lg-1");
    const b = layout.boxes.find((box) => box.id === "b")!;
    const c = layout.boxes.find((box) => box.id === "c")!;
    // The band covers both ranks, and its label sits ABOVE the first one.
    expect(band.y).toBeLessThan(b.y);
    expect(band.y + band.height).toBeGreaterThan(c.y + c.height);
    expect(band.label.y + band.label.height).toBeLessThanOrEqual(b.y);
    // ... and the label's gutter is reserved: no chip may cover it.
    for (const edge of chipEdges(layout)) {
      const chipRect = edge.label!;
      expect(
        overlaps(chipRect, band.label),
        "chip " + edgeName(edge) + " covers the band label",
      ).toBe(false);
    }
  });

  it("wraps a cyclic pair's hairpin arc and its own chips in one band", () => {
    const declaration: Declaration = {
      nodes: [{ id: "change" }, { id: "review" }],
      edges: [
        { from: "change", to: "review", outcome: "done" },
        { from: "review", to: "change", outcome: "revise" },
      ],
      loopGroups: [{ id: "repair", nodes: ["change", "review"] }],
    };
    const layout = declare(declaration);

    expect(layout.bands).toHaveLength(1);
    const band = layout.bands[0]!;
    expect(bandProblems(layout, declaration)).toEqual([]);
    // The band really did close around the hairpin: its bottom sits BELOW
    // every arc and chip of its own loop, not level with the box row.
    const rowBottom = Math.max(...layout.boxes.map((box) => box.y + box.height));
    for (const edge of layout.edges) {
      const lowest = Math.max(...samplePath(edge.d).map((point) => point.y));
      expect(lowest, edgeName(edge) + " escapes the hairpin channel").toBeGreaterThan(rowBottom);
      expect(band.y + band.height).toBeGreaterThan(lowest);
      expect(band.y + band.height).toBeGreaterThan(edge.label!.y + edge.label!.height);
      expect(containsClear({ x: band.x, y: band.y, width: band.width, height: band.height }, edge.label!, 2)).toBe(true);
    }
  });

  it("wraps all three hairpins of a three-node loop group", () => {
    const declaration: Declaration = {
      nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
      edges: [
        { from: "a", to: "b", outcome: "go" },
        { from: "b", to: "c", outcome: "go" },
        { from: "c", to: "a", outcome: "revise" },
      ],
      loopGroups: [{ id: "lg-three", nodes: ["a", "b", "c"] }],
    };
    const layout = declare(declaration);

    // One SCC, one rank, three hairpins — and one band around all of it.
    expect(layout.ranks).toEqual([["a", "b", "c"]]);
    expect(layout.edges.map((edge) => edge.back)).toEqual([true, true, true]);
    expect(layout.bands).toHaveLength(1);
    expect(bandProblems(layout, declaration)).toEqual([]);
    expect(chipEdges(layout)).toHaveLength(3);
    for (const edge of chipEdges(layout)) {
      expect(edge.label!.y).toBeGreaterThan(
        Math.max(...layout.boxes.map((box) => box.y)),
      );
    }
  });

  it("keeps a band clear of the nodes outside its own loop", () => {
    // The loop is `a <-> b`; `c -> d` is an unrelated branch whose boxes share
    // the loop's rank row and the rank below it.
    const declaration: Declaration = {
      nodes: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
      edges: [
        { from: "a", to: "b", outcome: "done" },
        { from: "b", to: "a", outcome: "revise" },
        { from: "c", to: "d", outcome: "done" },
      ],
      loopGroups: [{ id: "cycle", nodes: ["a", "b"] }],
    };
    const layout = declare(declaration);

    expect(layout.bands).toHaveLength(1);
    expect(bandProblems(layout, declaration)).toEqual([]);
    const band = layout.bands[0]!;
    const bandRect = { x: band.x, y: band.y, width: band.width, height: band.height };
    for (const id of ["c", "d"]) {
      const box = layout.boxes.find((candidate) => candidate.id === id)!;
      const boxRect = { x: box.x, y: box.y, width: box.width, height: box.height };
      expect(overlapsInset(bandRect, boxRect, 2), "band overlaps non-member " + id).toBe(false);
      expect(apartBy(bandRect, boxRect, 2), "non-member " + id + " is within 2px of the band").toBe(true);
    }
  });

  it("closes a band below its hairpin without swallowing the next rank", () => {
    // A band that has to grow around its own hairpin reserves the room in the
    // channel below its lowest member rank, so the NEXT rank's boxes stay out
    // of it and the rank rhythm stays inside the instrument's window.
    const layout = declare(MESH);
    const band = layout.bands[0]!;
    const bandRect = { x: band.x, y: band.y, width: band.width, height: band.height };
    expect(bandProblems(layout, MESH)).toEqual([]);
    for (const box of layout.boxes) {
      if (box.id === "loop-work" || box.id === "loop-check") continue;
      const boxRect = { x: box.x, y: box.y, width: box.width, height: box.height };
      expect(overlapsInset(bandRect, boxRect, 2), "band overlaps " + box.id).toBe(false);
    }
    // The band's bottom is below both hairpins and the `done` chip it owns.
    const arcs = layout.edges.filter((edge) => edge.back);
    for (const edge of arcs) {
      for (const point of samplePath(edge.d)) {
        expect(point.y).toBeLessThanOrEqual(bandRect.y + bandRect.height);
      }
    }
    const sink = layout.boxes.find((box) => box.id === "sink")!;
    expect(bandRect.y + bandRect.height).toBeLessThanOrEqual(sink.y - 2);
  });

  it("reserves the band's label gutter in the channel above its rank", () => {
    const layout = declare(MESH);
    const band = layout.bands[0]!;
    const work = layout.boxes.find((box) => box.id === "loop-work")!;
    for (const edge of chipEdges(layout)) {
      const overlapsLabel =
        edge.label!.x < band.label.x + band.label.width &&
        band.label.x < edge.label!.x + edge.label!.width &&
        edge.label!.y < band.label.y + band.label.height &&
        band.label.y < edge.label!.y + edge.label!.height;
      expect(overlapsLabel, "chip " + edgeName(edge) + " covers the band label").toBe(false);
    }
    expect(band.label.y + band.label.height).toBeLessThanOrEqual(work.y);
  });

  it("raises a band's top over a chip drawn in the channel above its top rank", () => {
    // The review's R2 case: `stage` is divergent and feeds a member of the
    // loop's top rank, so its chip is drawn in the channel ABOVE that rank. A
    // border pinned to the member row would leave the chip outside the loop it
    // belongs to; the border has to rise over that ink.
    const declaration: Declaration = {
      nodes: [{ id: "stage" }, { id: "err" }, { id: "m1" }, { id: "m2" }],
      edges: [
        { from: "stage", to: "m1", outcome: "ok" },
        { from: "stage", to: "err", outcome: "fail" },
        { from: "m1", to: "m2", outcome: "go" },
        { from: "m2", to: "m1", outcome: "revise" },
      ],
      loopGroups: [{ id: "lg", nodes: ["m1", "m2"] }],
    };
    const layout = declare(declaration);

    expect(layout.bands).toHaveLength(1);
    const band = layout.bands[0]!;
    const bandRect = { x: band.x, y: band.y, width: band.width, height: band.height };
    expect(bandProblems(layout, declaration)).toEqual([]);
    // The chip of the loop's entry edge is enclosed with real clearance — it
    // does not merely touch the border.
    const entry = layout.edges.find((edge) => edge.from === "stage" && edge.to === "m1")!;
    expect(entry.label).not.toBeNull();
    expect(containsClear(bandRect, entry.label!, 2)).toBe(true);
    // The label still sits in its gutter above the first member row, and the
    // raised border still keeps 2px from the boxes of the rank above.
    const m1 = layout.boxes.find((box) => box.id === "m1")!;
    const stage = layout.boxes.find((box) => box.id === "stage")!;
    expect(band.label.y + band.label.height).toBeLessThanOrEqual(m1.y);
    expect(
      apartBy(bandRect, { x: stage.x, y: stage.y, width: stage.width, height: stage.height }, 2),
    ).toBe(true);
  });

  it("keeps a rank-skipping edge's chip beside the loop it enters", () => {
    // The divergent `a` is TWO ranks above the loop, so its edge rides the rail
    // and owns two runs. Only the run beside the target rank lies under the
    // band's top; the chip must take that one.
    const declaration: Declaration = {
      nodes: [{ id: "a" }, { id: "b" }, { id: "m1" }, { id: "m2" }],
      edges: [
        { from: "a", to: "b", outcome: "ok" },
        { from: "a", to: "m2", outcome: "fail" },
        { from: "b", to: "m1", outcome: "ok" },
        { from: "m1", to: "m2", outcome: "go" },
        { from: "m2", to: "m1", outcome: "revise" },
      ],
      loopGroups: [{ id: "lg", nodes: ["m1", "m2"] }],
    };
    const layout = declare(declaration);

    const skip = layout.edges.find((edge) => edge.from === "a" && edge.to === "m2")!;
    expect(skip.back).toBe(false);
    expect(skip.label).not.toBeNull();
    const band = layout.bands[0]!;
    const bandRect = { x: band.x, y: band.y, width: band.width, height: band.height };
    expect(containsClear(bandRect, skip.label!, 2)).toBe(true);
    expect(bandProblems(layout, declaration)).toEqual([]);
  });
});

/** A double fan-in: two sources, three workers, one join. */
function meshFan(): Declaration {
  return {
    nodes: [
      { id: "in-1" },
      { id: "in-2" },
      { id: "w-1" },
      { id: "w-2" },
      { id: "w-3" },
      { id: "join-1" },
    ],
    edges: [
      { from: "in-1", to: "w-1", outcome: "ok" },
      { from: "in-1", to: "w-2", outcome: "ok" },
      { from: "in-2", to: "w-3", outcome: "ok" },
      { from: "w-1", to: "join-1", outcome: "ok" },
      { from: "w-2", to: "join-1", outcome: "ok" },
      { from: "w-3", to: "join-1", outcome: "ok" },
    ],
  };
}

/** A cycle with an exit and a divergent fan-out. */
function cycleAndTail(): Declaration {
  return {
    nodes: [{ id: "plan" }, { id: "build" }, { id: "verify" }, { id: "docs" }],
    edges: [
      { from: "plan", to: "build", outcome: "planned" },
      { from: "build", to: "verify", outcome: "built" },
      { from: "verify", to: "build", outcome: "revise" },
      { from: "verify", to: "docs", outcome: "approved" },
    ],
    loopGroups: [{ id: "lg-revise", nodes: ["build", "verify"] }],
  };
}

/** Every rank's box span shares one centre (the browser measures the same). */
function expectCentreShared(layout: TopologyLayout): void {
  const contentLeft = Math.min(...layout.boxes.map((box) => box.x));
  const contentRight = Math.max(...layout.boxes.map((box) => box.x + box.width));
  const rows = new Map<number, typeof layout.boxes>();
  for (const box of layout.boxes) {
    const row = rows.get(box.y) ?? [];
    row.push(box);
    rows.set(box.y, row);
  }
  for (const [y, row] of rows) {
    const left = Math.min(...row.map((box) => box.x));
    const right = Math.max(...row.map((box) => box.x + box.width));
    expect(
      Math.abs(left - contentLeft - (contentRight - right)),
      "rank at y=" + y + " is off-centre",
    ).toBeLessThanOrEqual(6);
  }
}
