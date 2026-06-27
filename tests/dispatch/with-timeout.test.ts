import { describe, it, expect } from "bun:test";
import { withTimeout, TimeoutError } from "../../src/dispatch/with-timeout";

describe("withTimeout", () => {
  it("resolves passthrough when inner promise wins", async () => {
    const result = await withTimeout(Promise.resolve(42), 1000);
    expect(result).toBe(42);
  });

  it("rejects with TimeoutError when inner never resolves", async () => {
    try {
      await withTimeout(new Promise<void>(() => {}), 20, "msg");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TimeoutError);
      expect((err as TimeoutError).name).toBe("TimeoutError");
    }
  }, 5000);

  it("handles already-rejected promise", async () => {
    const err = new Error("boom");
    try {
      await withTimeout(Promise.reject(err), 1000);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBe(err);
    }
  });

  it("TimeoutError is instanceof TimeoutError", () => {
    const err = new TimeoutError(100);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err).toBeInstanceOf(Error);
  });

  it("label appears in error message", async () => {
    try {
      await withTimeout(new Promise<void>(() => {}), 20, "my-operation");
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = (err as TimeoutError).message;
      expect(msg).toContain("my-operation");
      expect(msg).toContain("20");
    }
  }, 5000);

  it("timer cleanup — no dangling timer after timeout", async () => {
    const result = await withTimeout(Promise.resolve("done"), 50);
    expect(result).toBe("done");
  });

  it("timer cleanup — resolves after timer is set", async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("slow"), 10));
    const result = await withTimeout(slow, 1000);
    expect(result).toBe("slow");
  });
});
