import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ComputerCaptureGeometry, ComputerCaptureGuard, ComputerInputRequest } from "../platform/system/types.ts";

export const COMPUTER_DISPLAY_SCHEMA = z.object({
  id: z.number().int().nonnegative(),
  x: z.number(), y: z.number(),
  width: z.number().positive(), height: z.number().positive(),
  scale: z.number().positive(), primary: z.boolean(), name: z.string().optional(),
});

const GEOMETRY_SCHEMA = z.object({
  bounds: z.object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() }),
  displays: z.array(COMPUTER_DISPLAY_SCHEMA).min(1),
}).refine(value => new Set(value.displays.map(display => display.id)).size === value.displays.length,
  "display identifiers must be unique");

export function parseCaptureGeometry(output: string): ComputerCaptureGeometry {
  const result = GEOMETRY_SCHEMA.safeParse(JSON.parse(output));
  if (!result.success) throw new Error("the capture helper returned invalid screen geometry");
  return result.data;
}

interface ScreenshotOwner {
  readonly sessionID: string;
  readonly worktree: string;
  readonly platform: string;
}

interface Screenshot extends ScreenshotOwner, ComputerCaptureGuard {
  readonly width: number;
  readonly height: number;
}

type PointerRequest = Extract<ComputerInputRequest, { action: "click" | "move" | "scroll" | "drag" }>;

export class ComputerScreenshotRegistry {
  private readonly screenshots = new Map<string, { screenshot: Screenshot; created: number }>();

  constructor(private readonly now = Date.now, private readonly capacity = 64, private readonly maxAgeMs = 600_000) {}

  remember(screenshot: Screenshot): string {
    this.prune();
    while (this.screenshots.size >= this.capacity) this.screenshots.delete(this.screenshots.keys().next().value!);
    const id = randomUUID();
    this.screenshots.set(id, { screenshot: structuredClone(screenshot), created: this.now() });
    return id;
  }

  map(id: string, request: PointerRequest, owner: ScreenshotOwner): PointerRequest {
    this.prune();
    const screenshot = this.screenshots.get(id)?.screenshot;
    if (screenshot === undefined || screenshot.sessionID !== owner.sessionID || screenshot.worktree !== owner.worktree || screenshot.platform !== owner.platform) {
      throw new Error("screenshot_id is unknown, expired or belongs to another session; take a fresh screenshot");
    }
    const windowId = screenshot.target.windowId;
    if (request.windowId !== undefined && request.windowId !== windowId) {
      throw new Error("window_id must match the window captured by screenshot_id; take a screenshot of that window first");
    }
    const { bounds } = screenshot.geometry;
    const point = (x: number, y: number) => {
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= screenshot.width || y >= screenshot.height) {
        throw new Error("screenshot coordinates must lie inside the captured image");
      }
      const mappedX = Math.min(Math.ceil(bounds.x + bounds.w) - 1, Math.max(Math.ceil(bounds.x), Math.round(bounds.x + x * bounds.w / screenshot.width)));
      const mappedY = Math.min(Math.ceil(bounds.y + bounds.h) - 1, Math.max(Math.ceil(bounds.y), Math.round(bounds.y + y * bounds.h / screenshot.height)));
      if (!screenshot.geometry.displays.some(display => mappedX >= display.x && mappedX < display.x + display.width && mappedY >= display.y && mappedY < display.y + display.height)) {
        throw new Error("the selected screenshot point falls in a gap between displays; choose a point on a display");
      }
      return { x: mappedX, y: mappedY };
    };
    const target = { windowId, captureGuard: structuredClone({ target: screenshot.target, geometry: screenshot.geometry }) };
    if (request.action === "drag") {
      const from = point(request.fromX, request.fromY);
      const to = point(request.toX, request.toY);
      return { ...request, ...target, fromX: from.x, fromY: from.y, toX: to.x, toY: to.y };
    }
    if (request.x === undefined || request.y === undefined) throw new Error("scroll with screenshot_id requires both x and y in image pixels");
    return { ...request, ...target, ...point(request.x, request.y) };
  }

  private prune(): void {
    const now = this.now();
    for (const [id, entry] of this.screenshots) if (now - entry.created >= this.maxAgeMs) this.screenshots.delete(id);
  }
}

export const computerScreenshots = new ComputerScreenshotRegistry();
