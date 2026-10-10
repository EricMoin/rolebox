/// <reference types="bun-types" />

/**
 * Pi tool-result image transport.
 *
 * `toPiResult` (src/platform/adapters/pi/tool-factory.ts) must emit Pi image
 * content blocks AFTER the text block, so a fetched picture or a computer
 * screenshot reaches the model as an image instead of the bare `[image: …]`
 * text line (previously the attachment was dropped entirely).
 *
 * The fixture is the canonical ToolResult `web_fetch` produces for an image
 * (`src/web/web-fetch.ts` `buildImageAttachment`, lines 429-452): a display
 * title, a text output line, metadata, and one `type: "file"` attachment whose
 * `url` is a base64 `data:` URI. No network and no GUI: the payload is a real
 * 70-byte 1x1 PNG.
 *
 * @module
 */

import { describe, it, expect } from "bun:test";
import { PiToolFactory } from "../../src/platform/adapters/pi/tool-factory.ts";
import { defineTool } from "../../src/platform/ports/tool-factory.ts";
import type { ToolResult } from "../../src/platform/types.ts";

// ── Fixtures ───────────────────────────────────────────────────────────────

/** A real 1x1 PNG (70 bytes); its signature and length are asserted below. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function pngBytes(): Buffer {
  return Buffer.from(PNG_BASE64, "base64");
}

/**
 * The exact canonical result shape `web_fetch` returns for an image
 * (`src/web/web-fetch.ts:429-452` — `buildImageAttachment`).
 */
function webFetchImageResult(): ToolResult {
  return {
    title: "Image: https://example.test/shot.png",
    output: `[image: image/png, ${pngBytes().byteLength} bytes]`,
    metadata: {},
    attachments: [
      {
        type: "file",
        mime: "image/png",
        url: `data:image/png;base64,${PNG_BASE64}`,
        filename: "shot.png",
      },
    ],
  };
}

type PiCompiledTool = {
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (msg: string) => void,
    ctx: Record<string, unknown>,
  ) => Promise<{ content: Array<Record<string, unknown>>; details: Record<string, unknown> }>;
};

/** Compile one canonical tool under a stable name and run it through Pi's execute. */
async function runTool(result: ToolResult): Promise<{
  content: Array<Record<string, unknown>>;
  details: Record<string, unknown>;
}> {
  const factory = new PiToolFactory();
  const tool = defineTool({
    description: "returns a canonical result",
    args: {},
    async execute() {
      return result;
    },
  });
  const compiled = factory.compileAll({ t: tool })["t"] as unknown as PiCompiledTool;
  return compiled.execute(
    "call-1",
    {},
    new AbortController().signal,
    () => {},
    { sessionManager: { getSessionId: () => "session-1" } },
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("PiToolFactory image attachment transport", () => {
  it("uses a real PNG fixture (deterministic, no network)", () => {
    const bytes = pngBytes();
    expect(bytes.byteLength).toBe(70);
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });

  it("emits the image block AFTER the text block for a web_fetch image attachment", async () => {
    const result = webFetchImageResult() as Exclude<ToolResult, string>;
    const { content, details } = await runTool(result);

    expect(content).toEqual([
      { type: "text", text: result.output },
      { type: "image", data: PNG_BASE64, mimeType: "image/png" },
    ]);
    // `metadata` never rides the text; it stays in details.
    expect(details).toEqual({});
  });

  it("keeps display metadata in details and out of every content block", async () => {
    const result: ToolResult = {
      ...(webFetchImageResult() as Exclude<ToolResult, string>),
      metadata: { internal: "never model-visible" },
    };
    const { content, details } = await runTool(result);

    expect(details).toEqual({ internal: "never model-visible" });
    expect(JSON.stringify(content)).not.toContain("never model-visible");
  });

  it("skips non-image and malformed attachments silently, keeping the text block", async () => {
    const result: ToolResult = {
      output: "mixed attachments",
      attachments: [
        // Non-image media type (a PDF keeps its existing text line).
        { type: "file", mime: "application/pdf", url: "data:application/pdf;base64,AAAA" },
        // Image media type but not a data URI.
        { type: "file", mime: "image/png", url: "https://example.test/x.png" },
        // Data URI without a base64 payload.
        { type: "file", mime: "image/png", url: "data:image/png;base64" },
        // Data URI that is not base64-encoded.
        { type: "file", mime: "image/png", url: "data:image/png,AAAA" },
        // Base64 payload carrying an illegal character.
        { type: "file", mime: "image/png", url: "data:image/png;base64,AA A" },
        // Empty URL.
        { type: "file", mime: "image/png", url: "" },
      ],
    };
    const { content, details } = await runTool(result);

    expect(content).toEqual([{ type: "text", text: "mixed attachments" }]);
    expect(details).toEqual({});
  });

  it("converts every image attachment in order, after the text block", async () => {
    const result: ToolResult = {
      output: "two images",
      attachments: [
        {
          type: "file",
          mime: "image/png",
          url: `data:image/png;base64,${PNG_BASE64}`,
          filename: "shot.png",
        },
        // The DATA URI's media type is what the block declares, mirroring the
        // codex adapter's MCP projection.
        { type: "file", mime: "image/png", url: "data:image/jpeg;base64,/9j/4AAQ" },
      ],
    };
    const { content } = await runTool(result);

    expect(content).toEqual([
      { type: "text", text: "two images" },
      { type: "image", data: PNG_BASE64, mimeType: "image/png" },
      { type: "image", data: "/9j/4AAQ", mimeType: "image/jpeg" },
    ]);
  });

  it("leaves a plain string result as one text block", async () => {
    const { content, details } = await runTool("plain output");

    expect(content).toEqual([{ type: "text", text: "plain output" }]);
    expect(details).toEqual({});
  });

  it("leaves a structured result without attachments as one text block", async () => {
    const { content } = await runTool({ output: "no attachments", metadata: { n: 1 } });

    expect(content).toEqual([{ type: "text", text: "no attachments" }]);
  });
});
