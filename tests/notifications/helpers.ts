import { readFileSync } from "node:fs";
import { expect, vi } from "vitest";

export async function waitForNotificationLog(path: string): Promise<void> {
  await vi.waitFor(() => {
    const content = readFileSync(path, "utf8").trim();
    expect(content).not.toBe("");
    for (const line of content.split("\n")) JSON.parse(line);
  }, { timeout: 3_000, interval: 20 });
}
