import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { captureFilePath } from "../../src/computer/capture.ts";
import { PiToolFactory } from "../../src/platform/adapters/pi/tool-factory.ts";
import { defineTool } from "../../src/platform/ports/tool-factory.ts";

async function captureDestination(ctx: Record<string, unknown>): Promise<string> {
  const tool = defineTool({
    description: "Resolve a screenshot destination without capturing the screen",
    args: {},
    async execute(_args, context) {
      return captureFilePath(context.worktree, new Date("2026-01-02T03:04:05.000Z"), 1);
    },
  });
  const compiled = new PiToolFactory().compileAll({ capture_destination: tool }).capture_destination as {
    execute(
      callId: string,
      args: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: () => void,
      ctx: Record<string, unknown>,
    ): Promise<{ content: Array<{ text: string }> }>;
  };
  const result = await compiled.execute("capture-path", {}, new AbortController().signal, () => {}, ctx);
  return result.content[0]!.text;
}

describe("Pi screenshot workspace", () => {
  it("uses Pi's cwd when the host supplies no separate worktree field", async () => {
    const cwd = join(process.cwd(), "example-session-workspace");
    expect(await captureDestination({ cwd })).toBe(join(cwd, ".rolebox/computer/20260102T030405000Z-001.png"));
  });

  it("prefers an explicitly supplied worktree over cwd", async () => {
    const worktree = join(process.cwd(), "example-explicit-worktree");
    expect(await captureDestination({ cwd: process.cwd(), worktree })).toBe(
      join(worktree, ".rolebox/computer/20260102T030405000Z-001.png"),
    );
  });
});
