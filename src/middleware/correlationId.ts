import { randomUUID } from 'crypto';
import express from 'express';

declare global {
  namespace Express {
    interface Request {
      correlationId: string;
      user?: import('../models/User.js').IUser;
    }
  }
}

export const correlationIdMiddleware: express.RequestHandler = (req, res, next) => {
  const existing = req.headers['x-correlation-id'] as string | undefined;
  req.correlationId = existing && /^[a-f0-9-]{36}$/i.test(existing) ? existing : randomUUID();
  res.setHeader('X-Correlation-ID', req.correlationId);
  next();
};
