import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import mongoose from 'mongoose';
import { config } from './config/env.js';
import { logger } from './lib/logger.js';
import { redis } from './lib/redis.js';
import { connectMongo } from './lib/mongoose.js';
import { correlationIdMiddleware } from './middleware/correlationId.js';
import { AppError } from './lib/errors.js';

import authRouter from './routes/auth.js';
import aiRouter from './routes/ai.js';

const app = express();

// ==========================================
// 1. LAYERED MIDDLEWARE (Order of execution)
// ==========================================

// Step 1: Assign or validate X-Correlation-ID header on every request
app.use(correlationIdMiddleware);

// Step 2: Essential security headers (CSP, HSTS, X-Content-Type-Options, etc.)
app.use(helmet());

// Step 3: CORS whitelist
app.use(
  cors({
    origin: config.ALLOWED_ORIGINS.split(',').map((o) => o.trim()),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
  })
);

// Step 4: Body parsers & Cookie parser
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(cookieParser());

// Step 5: HTTP logging stream through Winston (skip health probes to reduce log noise)
const morganStream = {
  write: (message: string) => {
    logger.info(message.trim(), { source: 'http' });
  }
};
app.use(
  morgan(':method :url :status :res[content-length] - :response-time ms', {
    stream: morganStream,
    skip: (req) => req.url.startsWith('/health')
  })
);

// ==========================================
// 2. HEALTH & OBSERVABILITY PROBES
// ==========================================

/**
 * GET /health/live
 * Liveness Probe: Quick, lightweight check to verify the process is alive.
 * Orchestrators (K8s, PM2) restart container/worker if this fails.
 */
app.get('/health/live', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime())
  });
});

/**
 * GET /health/ready
 * Readiness Probe: Deep check checking dependencies (MongoDB, Redis).
 * Returns 200 if all dependencies are healthy, 503 Service Unavailable if degraded.
 */
app.get('/health/ready', async (req, res) => {
  const checkMongo = async () => {
    const start = Date.now();
    const isConnected = mongoose.connection.readyState === 1;
    return {
      connected: isConnected,
      latencyMs: Date.now() - start
    };
  };

  const checkRedis = async () => {
    const start = Date.now();
    try {
      const pong = await redis.ping();
      return {
        connected: pong === 'PONG',
        latencyMs: Date.now() - start
      };
    } catch {
      return {
        connected: false,
        latencyMs: Date.now() - start
      };
    }
  };

  const [mongoRes, redisRes] = await Promise.allSettled([checkMongo(), checkRedis()]);

  const mongoStatus = mongoRes.status === 'fulfilled' ? mongoRes.value : { connected: false, latencyMs: 0 };
  const redisStatus = redisRes.status === 'fulfilled' ? redisRes.value : { connected: false, latencyMs: 0 };

  const isReady = mongoStatus.connected && redisStatus.connected;

  res.status(isReady ? 200 : 503).json({
    status: isReady ? 'ready' : 'degraded',
    correlationId: req.correlationId,
    services: {
      mongodb: mongoStatus,
      redis: redisStatus
    },
    timestamp: new Date().toISOString()
  });
});

// ==========================================
// 3. API ROUTES
// ==========================================
app.use('/auth', authRouter);
app.use('/api/ai', aiRouter);

// ==========================================
// 4. GLOBAL ERROR HANDLERS
// ==========================================

// 404 Route Handler
app.use((req, res, next) => {
  next(new AppError(`Endpoint ${req.method} ${req.originalUrl} not found`, 404, 'NOT_FOUND'));
});

// Centralized Express Error Handler
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  let statusCode = err.statusCode || 500;
  let errorCode = err.code || 'INTERNAL_ERROR';
  let isOperational = Boolean(err.isOperational);
  let message = isOperational ? err.message : 'An unexpected internal server error occurred';

  // Handle malformed JSON body sent by client
  if (err instanceof SyntaxError && 'body' in err) {
    statusCode = 400;
    errorCode = 'INVALID_JSON_BODY';
    isOperational = true;
    message = 'Malformed JSON payload in request body';
  }

  logger.error(err.message || 'Unhandled error', {
    correlationId: req.correlationId,
    statusCode,
    errorCode,
    stack: config.NODE_ENV !== 'production' ? err.stack : undefined
  });

  res.status(statusCode).json({
    error: {
      message,
      code: errorCode,
      correlationId: req.correlationId
    }
  });
});

// ==========================================
// 4. SERVER BOOTSTRAP & GRACEFUL SHUTDOWN
// ==========================================

const server = app.listen(config.PORT, async () => {
  logger.info(`Server initialized and running on port ${config.PORT}`, {
    env: config.NODE_ENV,
    port: config.PORT
  });

  // Connect to DB asynchronously without blocking server start
  await connectMongo();
});

// Graceful shutdown on SIGTERM / SIGINT
async function gracefulShutdown(signal: string) {
  logger.info(`Received ${signal}. Initiating graceful shutdown...`);

  // Stop accepting new connections
  server.close(async () => {
    logger.info('HTTP server closed. Draining database and cache connections...');
    try {
      await Promise.allSettled([
        mongoose.connection.close(false),
        redis.quit()
      ]);
      logger.info('All connections drained safely. Exiting process.');
      process.exit(0);
    } catch (err: any) {
      logger.error('Error during shutdown draining:', { error: err.message });
      process.exit(1);
    }
  });

  // Fallback safety timeout: 30 seconds (matches ecosystem.config.js kill_timeout)
  const forceKillTimeout = setTimeout(() => {
    logger.error('Graceful shutdown timeout exceeded. Forcefully killing process.');
    process.exit(1);
  }, 30000);

  forceKillTimeout.unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export default app;
