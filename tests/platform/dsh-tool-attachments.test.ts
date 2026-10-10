/// <reference types="bun-types" />

/**
 * dsh tool-result image transport.
 *
 * dsh content blocks reference a stored image instead of carrying bytes
 * (`ImageBlock = { type: 'image'; attachment: ImageAttachmentRef }`,
 * `@deepseek-ai/dsh-llm/lib/types/types.d.ts:54-58`), so the adapter can only
 * emit an image AFTER the bytes were committed through the mounted attachment
 * service. These cases pin the whole contract with a fake service and the
 * canonical result shape `web_fetch` produces for an image
 * (`src/web/web-fetch.ts:429-452`): `execute` saves every canonical image
 * attachment and parks the durable refs on the value, `output.render` emits
 * `[text, image, …]`, and WITHOUT a service both stay exactly the text-only
 * behavior they had before image transport existed.
 *
 * No network and no GUI: the payload is a real 70-byte 1x1 PNG.
 *
 * @module
 */

import { describe, it, expect } from "bun:test";
import {
  DSH_IMAGE_ATTACHMENT_REFS_KEY,
  DshToolFactory,
} from "../../src/platform/adapters/dsh/tool-factory.ts";
import type {
  DshToolDefinition,
  DshToolRunContext,
} from "../../src/platform/adapters/dsh/tool-factory.ts";
import type {
  DshAttachmentService,
  DshImageAttachmentRef,
  DshImageMediaType,
} from "../../src/platform/adapters/dsh/attachment.ts";
import { defineTool } from "../../src/platform/ports/tool-factory.ts";
import type { ToolResult } from "../../src/platform/types.ts";

// ── Fixtures ───────────────────────────────────────────────────────────────

/** A real 1x1 PNG (70 bytes). */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function pngBytes(): Buffer {
  return Buffer.from(PNG_BASE64, "base64");
}

/**
 * The exact canonical result shape `web_fetch` returns for an image
 * (`src/web/web-fetch.ts:429-452` — `buildImageAttachment`).
 */
function webFetchImageResult(): Exclude<ToolResult, string> {
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

/** A recording double for the harness attachment service. */
function makeFakeAttachments() {
  const calls: Array<{ data: Uint8Array; mediaType: DshImageMediaType; name?: string }> = [];
  const refs: DshImageAttachmentRef[] = [];
  const service: DshAttachmentService = {
    async saveImage(input) {
      calls.push(input);
      const ref: DshImageAttachmentRef = {
        attachmentId: `att-${calls.length}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 1,
        height: 1,
        ...(input.name === undefined ? {} : { name: input.name }),
      };
      refs.push(ref);
      return ref;
    },
  };
  return { service, calls, refs };
}

function makeExec(): DshToolRunContext {
  return {
    signal: new AbortController().signal,
    callId: "call-1",
    deferContext: () => {},
    concludeTurn: () => {},
  };
}

/** Compile one canonical tool under a stable name. */
function compileOne(result: ToolResult, factory = new DshToolFactory()): DshToolDefinition {
  const tool = defineTool({
    description: "returns a canonical result",
    args: {},
    async execute() {
      return result;
    },
  });
  const compiled = factory.compileAll({ t: tool }) as Record<string, DshToolDefinition>;
  return compiled.t!;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("DshToolFactory image attachment transport", () => {
  it("uses a real PNG fixture (deterministic, no network)", () => {
    const bytes = pngBytes();
    expect(bytes.byteLength).toBe(70);
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });

  it("saves a web_fetch image attachment and renders an ImageBlock after the text block", async () => {
    const { service, calls, refs } = makeFakeAttachments();
    const factory = new DshToolFactory({ attachments: service });
    const tool = compileOne(webFetchImageResult(), factory);
    const canonical = webFetchImageResult();

    const value = (await tool.execute({}, makeExec())) as Record<string, unknown>;

    // The service received the DECODED bytes, the URI's media type and the
    // filename as the display name.
    expect(calls.length).toBe(1);
    expect(calls[0]!.mediaType).toBe("image/png");
    expect(calls[0]!.name).toBe("shot.png");
    expect(Buffer.from(calls[0]!.data).equals(pngBytes())).toBe(true);

    // The returned canonical value stays intact and additionally carries the
    // durable refs under the documented key.
    expect(value).toEqual({ ...canonical, [DSH_IMAGE_ATTACHMENT_REFS_KEY]: refs });

    expect(tool.output.render({}, value)).toEqual([
      { type: "text", text: canonical.output },
      { type: "image", attachment: refs[0]! },
    ]);
  });

  it("saves each image attachment in order and emits one block each", async () => {
    const { service, calls, refs } = makeFakeAttachments();
    const factory = new DshToolFactory({ attachments: service });
    const tool = compileOne(
      {
        output: "two images",
        attachments: [
          { type: "file", mime: "image/png", url: `data:image/png;base64,${PNG_BASE64}` },
          { type: "file", mime: "image/jpeg", url: "data:image/jpeg;base64,/9j/4AAQ" },
        ],
      },
      factory,
    );

    const value = (await tool.execute({}, makeExec())) as Record<string, unknown>;

    expect(calls.map((call) => call.mediaType)).toEqual(["image/png", "image/jpeg"]);
    expect(value[DSH_IMAGE_ATTACHMENT_REFS_KEY]).toEqual(refs);
    expect(tool.output.render({}, value)).toEqual([
      { type: "text", text: "two images" },
      { type: "image", attachment: refs[0]! },
      { type: "image", attachment: refs[1]! },
    ]);
  });

  it("skips non-image, malformed and non-canonical attachments without touching the service", async () => {
    const { service, calls } = makeFakeAttachments();
    const factory = new DshToolFactory({ attachments: service });
    const result: Exclude<ToolResult, string> = {
      output: "mixed attachments",
      attachments: [
        // Non-image media type (a PDF keeps its existing text line).
        { type: "file", mime: "application/pdf", url: "data:application/pdf;base64,AAAA" },
        // Not a data URI.
        { type: "file", mime: "image/png", url: "https://example.test/x.png" },
        // Data URI without a base64 payload.
        { type: "file", mime: "image/png", url: "data:image/png;base64" },
        // Not base64-encoded.
        { type: "file", mime: "image/png", url: "data:image/png,AAAA" },
        // Base64 payload carrying an illegal character.
        { type: "file", mime: "image/png", url: "data:image/png;base64,AA A" },
        // An image type the harness store does not accept — never guessed at.
        { type: "file", mime: "image/bmp", url: "data:image/bmp;base64,AAAA" },
        { type: "file", mime: "image/svg+xml", url: "data:image/svg+xml;base64,AAAA" },
      ],
    };
    const tool = compileOne(result, factory);

    const value = await tool.execute({}, makeExec());

    expect(calls.length).toBe(0);
    expect(value).toEqual(result);
    expect(tool.output.render({}, value)).toEqual([{ type: "text", text: "mixed attachments" }]);
  });

  it("propagates a saveImage rejection instead of silently dropping the image", async () => {
    const service: DshAttachmentService = {
      async saveImage() {
        throw new Error("attachment store offline");
      },
    };
    const tool = compileOne(webFetchImageResult(), new DshToolFactory({ attachments: service }));

    expect(tool.execute({}, makeExec())).rejects.toThrow("attachment store offline");
  });

  it("without a service, execute and render are exactly the text-only behavior", async () => {
    const canonical = webFetchImageResult();

    for (const factory of [new DshToolFactory(), new DshToolFactory({})]) {
      const tool = compileOne(canonical, factory);

      const value = await tool.execute({}, makeExec());
      expect(value).toEqual(canonical);
      expect(value).not.toHaveProperty(DSH_IMAGE_ATTACHMENT_REFS_KEY);

      expect(tool.output.render({}, value)).toEqual([{ type: "text", text: canonical.output }]);
      // Even a value that DOES carry refs renders text-only: without a service
      // the adapter never fabricates an image block.
      expect(
        tool.output.render({}, { output: "x", [DSH_IMAGE_ATTACHMENT_REFS_KEY]: [
          { attachmentId: "att-1", mediaType: "image/png", bytes: 1, width: 1, height: 1 },
        ] }),
      ).toEqual([{ type: "text", text: "x" }]);
    }
  });

  it("with a service, ignores a ref the value does not actually carry or that is malformed", async () => {
    const { service } = makeFakeAttachments();
    const tool = compileOne("plain", new DshToolFactory({ attachments: service }));

    expect(tool.output.render({}, { output: "x" })).toEqual([{ type: "text", text: "x" }]);
    expect(
      tool.output.render({}, {
        output: "x",
        [DSH_IMAGE_ATTACHMENT_REFS_KEY]: [
          { attachmentId: "", mediaType: "image/png", bytes: 1, width: 1, height: 1 },
          { attachmentId: "a", mediaType: "image/bmp", bytes: 1, width: 1, height: 1 },
          { attachmentId: "b", mediaType: "image/png", bytes: "1", width: 1, height: 1 },
        ],
      }),
    ).toEqual([{ type: "text", text: "x" }]);
  });

  it("keeps the JSON-string result envelope and its text untouched with a service mounted", async () => {
    const { service, calls } = makeFakeAttachments();
    const tool = compileOne('{"graph_id":"g1"}', new DshToolFactory({ attachments: service }));

    expect(await tool.execute({}, makeExec())).toEqual({ output: '{"graph_id":"g1"}', graph_id: "g1" });
    expect(calls.length).toBe(0);
  });
});
