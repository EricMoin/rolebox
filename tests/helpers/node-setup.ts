import { afterAll, afterEach, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./log-dir-preload.ts";

const temporaryEnvironment = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
const temporaryDirectory = mkdtempSync(join(tmpdir(), "rolebox-test-worker-"));
process.env.TMPDIR = process.env.TMP = process.env.TEMP = temporaryDirectory;
afterAll(() => {
  for (const [key, value] of Object.entries(temporaryEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

expect.extend({
  toStartWith(received: unknown, prefix: string) {
    return { pass: typeof received === "string" && received.startsWith(prefix), message: () => `expected ${String(received)} to start with ${prefix}` };
  },
  toEndWith(received: unknown, suffix: string) {
    return { pass: typeof received === "string" && received.endsWith(suffix), message: () => `expected ${String(received)} to end with ${suffix}` };
  },
  toBeNumber(received: unknown) {
    return { pass: typeof received === "number", message: () => `expected ${String(received)} to be a number` };
  },
  toBeFunction(received: unknown) {
    return { pass: typeof received === "function", message: () => `expected ${String(received)} to be a function` };
  },
  toBeString(received: unknown) {
    return { pass: typeof received === "string", message: () => `expected ${String(received)} to be a string` };
  },
});

declare module "vitest" {
  interface Assertion<T = any> {
    toStartWith(prefix: string): T;
    toEndWith(suffix: string): T;
    toBeNumber(): T;
    toBeFunction(): T;
    toBeString(): T;
  }
}

const environment = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
  Object.assign(process.env, environment);
});
