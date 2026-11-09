import { describe, expect, it, vi } from "vitest";
import { sendDesktopMessage } from "../../../../../src/platform/adapters/codex/desktop/relay.ts";

describe("desktop WebSocket write backpressure", () => {
  it("keeps only one fragment in flight until its write callback completes", async () => {
    const send = vi.fn(); const callbacks: Array<(error?: Error) => void> = [];
    send.mockImplementation((_data, _options, callback) => { callbacks.push(callback); });
    const message = Buffer.alloc(2 * 1024 * 1024 + 7, 120);
    const pending = sendDesktopMessage({ send }, message);
    expect(send).toHaveBeenCalledTimes(1);
    callbacks.shift()!(); await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(2);
    callbacks.shift()!(); await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(3);
    callbacks.shift()!(); await pending;
    expect(send.mock.calls.map(call => call[1])).toEqual([
      { binary: false, fin: false }, { binary: false, fin: false }, { binary: false, fin: true },
    ]);
    const chunks = send.mock.calls.map(call => call[0] as Buffer);
    expect(chunks.every(chunk => chunk.length <= 1024 * 1024)).toBe(true);
    expect(Buffer.concat(chunks).equals(message)).toBe(true);
  });

  it("stops sending subsequent fragments when a write fails", async () => {
    const send = vi.fn(); const failure = new Error("write failed");
    send.mockImplementation((_data, _options, callback) => { callback(failure); });
    await expect(sendDesktopMessage({ send }, Buffer.alloc(3 * 1024 * 1024))).rejects.toBe(failure);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
