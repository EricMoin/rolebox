/**
 * Structural port for the harness image-attachment service.
 *
 * dsh `ContentBlock`s reference a durably stored image instead of carrying
 * bytes (`ImageBlock = { type: 'image'; attachment: ImageAttachmentRef }`,
 * `@deepseek-ai/dsh-llm/lib/types/types.d.ts:54-58`), so the dsh adapter can
 * only turn a canonical base64 attachment into an image block AFTER the bytes
 * have been committed through the host's attachment service.
 *
 * This module mirrors structurally the parts of that service rolebox uses —
 * the harness `ImageAttachmentRef` and `AttachmentStore.saveImage`
 * (`packages/attachment/attachment/src/types.ts:11-32`) — exactly like the
 * rest of this adapter: NO value import of `@deepseek-ai/*` and no runtime
 * dependency on a host package. The dsh host owns the real implementation and
 * passes it in (see `DshToolFactoryOptions.attachments`).
 */

/** Raster image formats the harness attachment path accepts (`ImageMediaType`). */
export type DshImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/**
 * The accepted media types as a runtime list, so a media type that arrives as
 * a plain string — a canonical attachment's `mime`, or a ref restored from a
 * session log — can be validated before it is handed to the service or emitted
 * as an `ImageBlock`.
 */
export const DSH_IMAGE_MEDIA_TYPES: readonly DshImageMediaType[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

/** Whether `value` is one of the four raster formats the attachment path accepts. */
export function isDshImageMediaType(value: string): value is DshImageMediaType {
  return (DSH_IMAGE_MEDIA_TYPES as readonly string[]).includes(value);
}

/**
 * Structural mirror of the harness `ImageAttachmentRef`
 * (`packages/attachment/attachment/src/types.ts:11-32`): the durable,
 * serializable reference an `ImageBlock` carries. `attachmentId` is an opaque
 * storage id — never a filesystem path or a bearer URL — `mediaType` is the
 * format the store verified from the stored bytes, and `bytes`/`width`/
 * `height` are the stored image's exact encoded size and intrinsic dimensions.
 *
 * `originalDimensions` is deliberately NOT modelled: the adapter only forwards
 * a ref to the client, it never reads it.
 */
export interface DshImageAttachmentRef {
  attachmentId: string;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
  name?: string;
}

/**
 * The one harness attachment operation the dsh adapter needs: commit image
 * bytes and return their durable reference. The harness implementation
 * (`AttachmentStore.saveImage`) verifies the bytes against `mediaType`,
 * normalizes them and owns the deployment's byte/dimension limits; a rejection
 * means nothing was stored and therefore nothing may be referenced.
 *
 * The dsh entry wires the mounted host service (`ctx.get('attachments')`) into
 * this shape.
 */
export interface DshAttachmentService {
  saveImage(input: {
    data: Uint8Array;
    mediaType: DshImageMediaType;
    name?: string;
  }): Promise<DshImageAttachmentRef>;
}
