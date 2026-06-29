import { describe, it, expect } from "bun:test";
import { extractSessionErrorMessage } from "../../src/dispatch/manager.ts";

describe("extractSessionErrorMessage", () => {
  it("extracts the message from an Error instance", () => {
    expect(extractSessionErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("returns a plain string unchanged", () => {
    expect(extractSessionErrorMessage("rate limited")).toBe("rate limited");
  });

  it("digs the message out of an opencode { name, data: { message } } payload", () => {
    expect(
      extractSessionErrorMessage({
        name: "ProviderError",
        data: { message: "context length exceeded" },
      }),
    ).toBe("ProviderError: context length exceeded");
  });

  it("uses a top-level message when present", () => {
    expect(extractSessionErrorMessage({ message: "upstream 500" })).toBe("upstream 500");
  });

  it("falls back to the error name when there is no message", () => {
    expect(extractSessionErrorMessage({ name: "AbortError" })).toBe("AbortError");
  });

  it("never yields [object Object] for an opaque object", () => {
    const result = extractSessionErrorMessage({ code: 42 });
    expect(result).not.toContain("[object Object]");
    expect(result).toContain("42");
  });

  it("returns a sensible default for undefined", () => {
    expect(extractSessionErrorMessage(undefined)).toBe("Unknown session error");
  });
});
