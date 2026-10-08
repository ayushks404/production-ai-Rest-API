import { LRUCache } from 'lru-cache';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

/**
 * Atomic Redis Lua Script:
 * Combines INCR and conditional EXPIRE in a single Redis CPU cycle.
 * Eliminates concurrency race condition where concurrent requests see count=1 before EXPIRE is set.
 */
const RATE_LIMIT_SCRIPT = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
  end
  return count
`;

/**
 * Bounded In-Memory Fallback:
 * If Redis is temporarily down, fallback to memory bounded at max 10,000 entries.
 * Prevents Node process OOM during sustained Redis outages.
 */
const inMemoryCounters = new LRUCache<string, number>({
  max: 10_000,
  ttl: 120_000 // 2 minutes TTL
});

export const RATE_LIMIT_TIERS = {
  account_creation: { limit: 5,   window: 3600, keyBy: 'ip'     as const },
  api:              { limit: 200, window: 60,   keyBy: 'userId' as const },
  ai_free:          { limit: 10,  window: 60,   keyBy: 'userId' as const },
  ai_pro:           { limit: 100, window: 60,   keyBy: 'userId' as const },
} as const;

export type TierName = keyof typeof RATE_LIMIT_TIERS;

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  remaining: number;
  source: 'redis' | 'memory';
}

/**
 * Executes atomic rate limit check against Redis with fallback to in-memory LRU
 */
export async function checkRateLimitWithFallback(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  try {
    const count = (await redis.eval(RATE_LIMIT_SCRIPT, 1, key, String(windowSeconds))) as number;
    return {
      allowed: count <= limit,
      count,
      remaining: Math.max(0, limit - count),
      source: 'redis'
    };
  } catch (err: any) {
    logger.warn('Rate limit Redis unavailable - executing in-memory LRU fallback', {
      error: err.message,
      key
    });

    const count = (inMemoryCounters.get(key) ?? 0) + 1;
    inMemoryCounters.set(key, count);

    return {
      allowed: count <= limit,
      count,
      remaining: Math.max(0, limit - count),
      source: 'memory'
    };
  }
}
