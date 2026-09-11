import { join, dirname, isAbsolute } from "node:path";
import type { FunctionContext } from "./context.ts";
import { createSubLogger } from "../logger.ts";



const log = createSubLogger("function:handlers");

type HandlerModule = {
  onToolAfter?: (ctx: FunctionContext, ev: { tool: string; args: unknown }) => void | Promise<void>;
  onIdle?: (ctx: FunctionContext) => void | Promise<void>;
  shouldContinue?: (ctx: FunctionContext) => boolean;
};

const cache = new Map<string, HandlerModule | null>();

export async function loadHandlers(fnFilePath: string, handlersField?: string): Promise<HandlerModule | null> {
  if (!handlersField) return null;
  const abs = isAbsolute(handlersField) ? handlersField : join(dirname(fnFilePath), handlersField);
  if (cache.has(abs)) return cache.get(abs)!;
  try {
    const mod = (await import(abs)) as HandlerModule;
    cache.set(abs, mod);
    return mod;
  } catch (err) {
    log.warn("Failed to load Tier-2 handlers", { abs, err });
    cache.set(abs, null);
    return null;
  }
}

export async function safeCall<T>(fn: (() => T | Promise<T>) | undefined): Promise<T | undefined> {
  if (!fn) return undefined;
  try {
    return await fn();
  } catch (err) {
    log.warn("Tier-2 handler threw", err);
    return undefined;
  }
}
