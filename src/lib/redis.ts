import { Redis } from 'ioredis';
import { config } from '../config/env.js';
import { logger } from './logger.js';

export const redis = new Redis(config.REDIS_URL, {
  retryStrategy: (times: number) => {
    const delay = Math.min(times * 50, 2000);
    logger.warn('Redis reconnecting', { attempt: times, delayMs: delay });
    return delay;
  },
  maxRetriesPerRequest: 3,
  lazyConnect: true
});

redis.on('connect', () => logger.info('Redis connected'));
redis.on('error', (err: Error) => logger.error('Redis error', { err: err.message }));
redis.on('close', () => logger.warn('Redis connection closed'));

redis.connect().catch((err: Error) => {
  logger.warn('Initial Redis connection failed; will retry via retryStrategy', { error: err.message });
});
