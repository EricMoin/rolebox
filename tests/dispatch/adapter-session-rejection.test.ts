/**
 * Subtask 4 — error fidelity for SERVER REJECTIONS at the adapter boundary.
 *
 * When the opencode SDK returns a result-tuple error (the `r.error` field —
 * a real server-side rejection, e.g. HTTP 400 `BadRequestError`), the
 * OpencodeSessionAdapter must surface the UNDERLYING reason instead of a bare
 * null, via a tagged SessionCreateRejectedError. This proves:
 *   - the real reason (r.error.data.message) is extracted and carried;
 *   - the thrown error is tagged SessionCreateRejectedError so the dispatch
 *     launcher's retry loop (subtask 3) does NOT treat it as transient.
 *
 * SDK error shape (research, @opencode-ai/sdk@1.17.10):
 *   - result-tuple path (ThrowOnError=false default): resolves to
 *     `{ data: undefined, error: TError }`  — gen/client/types.gen.d.ts:75-77
 *   - SessionCreateErrors = { 400: BadRequestError } — gen/types.gen.d.ts:1822
 *   - BadRequestError = { name: "BadRequest", data: { message, kind? } }
 *                                                       — gen/types.gen.d.ts:617
 */
import { describe, it, expect } from "bun:test";
import { OpencodeSessionAdapter } from "../../src/platform/adapters/opencode/session";
import { SessionCreateRejectedError, isSessionCreateRejected } from "../../src/platform/types";

/**
 * Build an adapter whose underlying SDK `session.create` returns the given
 * result-tuple value, exercising the `r.error` branch.
 */
function adapterWithSessionCreate(
  sessionCreate: () => Promise<unknown>,
): OpencodeSessionAdapter {
  const sdkClient = { session: { create: sessionCreate } } as unknown as {
    session: { create: (opts: unknown) => Promise<unknown> };
  };
  return new OpencodeSessionAdapter(sdkClient as never);
}

/** Await create and return the thrown rejection error, asserting one was thrown. */
async function captureRejection(
  p: Promise<unknown>,
): Promise<SessionCreateRejectedError> {
  let caught: unknown;
  try {
    await p;
  } catch (err) {
    caught = err;
  }
  // Must have rejected with a tagged rejection (never a bare null / resolved value).
  expect(caught).toBeDefined();
  expect(isSessionCreateRejected(caught)).toBe(true);
  return caught as SessionCreateRejectedError;
}

describe("OpencodeSessionAdapter.create — server rejection (r.error) reason fidelity", () => {
  it("throws a tagged SessionCreateRejectedError carrying the real reason (BadRequestError shape)", async () => {
    const adapter = adapterWithSessionCreate(() =>
      Promise.resolve({
        data: undefined,
        error: {
          name: "BadRequest",
          data: { message: "parent session not found", kind: "Body" },
        },
      }),
    );

    const err = await captureRejection(
      adapter.create({ directory: "/tmp/test", parentID: "ses_missing" }),
    );
    expect(err).toBeInstanceOf(SessionCreateRejectedError);
    expect(err.message).toBe("parent session not found");
    expect(err.code).toBe("BadRequest");
    expect(err.isSessionRejected).toBe(true);
  });

  it("falls back to a bare { message } object when data.message is absent", async () => {
    const adapter = adapterWithSessionCreate(() =>
      Promise.resolve({ data: undefined, error: { message: "quota exceeded" } }),
    );

    const err = await captureRejection(adapter.create({ directory: "/tmp/test" }));
    expect(err.message).toBe("quota exceeded");
  });

  it("serializes a non-string non-message error object instead of degrading to '[object Object]'", async () => {
    const adapter = adapterWithSessionCreate(() =>
      Promise.resolve({ data: undefined, error: { detail: "bad body" } }),
    );

    const err = await captureRejection(adapter.create({ directory: "/tmp/test" }));
    expect(err.message).not.toContain("[object Object]");
    expect(err.message).toContain("detail");
  });

  it("still returns a synthesized SessionInfo on a SUCCESSFUL create (r.error absent) — no regression", async () => {
    const adapter = adapterWithSessionCreate(() =>
      Promise.resolve({ data: { id: "ses_ok" }, error: undefined }),
    );

    const info = await adapter.create({ directory: "/tmp/test" });
    expect(info).not.toBeNull();
    expect(info?.id).toBe("ses_ok");
  });
});
