import type { NotificationChannelConfig } from "./types.ts";
import type { NotificationChannel } from "./channels.ts";
import { createChannels } from "./channels.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("NotificationManager");

/**
 * Resolve notification channels for a cache key, lazily creating them
 * from the provided configs. The promise is cached to prevent races when
 * multiple notifications fire at the same time.
 */
export async function resolveChannels(
  channelCache: Map<string, NotificationChannel[] | Promise<NotificationChannel[]>>,
  cacheKey: string,
  configs: NotificationChannelConfig[],
): Promise<NotificationChannel[]> {
  const cached = channelCache.get(cacheKey);

  if (cached !== undefined) {
    if (Array.isArray(cached)) return cached;
    return cached;
  }

  const creationPromise = createChannels(configs);
  channelCache.set(cacheKey, creationPromise);

  try {
    const channels = await creationPromise;
    channelCache.set(cacheKey, channels);
    return channels;
  } catch (err) {
    channelCache.delete(cacheKey);
    log.warn("Failed to create notification channels", { err });
    return [];
  }
}
