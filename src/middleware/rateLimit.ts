import express from 'express';
import { checkRateLimitWithFallback, RATE_LIMIT_TIERS, type TierName } from '../services/rateLimit.js';

/**
 * Normalizes client IP by stripping IPv6-mapped IPv4 prefix (::ffff:).
 * Prevents split counter bugs where the same user gets double quota.
 */
function normalizeIP(ip: string | undefined): string {
  if (!ip) return '127.0.0.1';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/**
 * Automatically determines rate limit tier based on request URL and authenticated user tier.
 */
function getTier(path: string, userTier?: string): TierName {
  if (path.startsWith('/auth/register') || path.startsWith('/auth/login')) {
    return 'account_creation';
  }
  if (path.startsWith('/api/ai/')) {
    if (userTier === 'pro' || userTier === 'enterprise') {
      return 'ai_pro';
    }
    return 'ai_free';
  }
  return 'api';
}

export const rateLimitMiddleware: express.RequestHandler = async (req, res, next) => {
  const tier = getTier(req.path, req.user?.tier);
  const tierConfig = RATE_LIMIT_TIERS[tier];
  const { limit, window: windowSeconds, keyBy } = tierConfig;

  // Key by IP for unauthenticated routes; by user ID for authenticated routes
  const keyValue = keyBy === 'ip' ? normalizeIP(req.ip) : (req.user?._id?.toString() ?? normalizeIP(req.ip));

  // Partition by fixed time bucket (current epoch seconds divided by window)
  const nowSeconds = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(nowSeconds / windowSeconds);
  const key = `rl:${tier}:${keyValue}:${bucket}`;

  const result = await checkRateLimitWithFallback(key, limit, windowSeconds);

  // Calculate exact reset timestamp in seconds
  const resetAt = (bucket + 1) * windowSeconds;
  const resetInSeconds = Math.max(1, resetAt - nowSeconds);

  // Set RFC-standard rate limit response headers on EVERY request
  res.setHeader('X-RateLimit-Limit', limit);
  res.setHeader('X-RateLimit-Remaining', result.remaining);
  res.setHeader('X-RateLimit-Reset', resetAt);

  if (!result.allowed) {
    res.setHeader('Retry-After', resetInSeconds);
    res.status(429).json({
      error: 'Rate limit exceeded',
      limit,
      used: result.count,
      remaining: 0,
      resetAt,
      resetInSeconds,
      tier,
      source: result.source
    });
    return;
  }

  next();
};
