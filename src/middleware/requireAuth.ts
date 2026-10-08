import express from 'express';
import { verifyToken } from '../services/jwt.js';
import { User } from '../models/User.js';
import { AppError } from '../lib/errors.js';

/**
 * Helper to extract token from either:
 * 1. Authorization: Bearer <token> (Header for mobile/API clients)
 * 2. accessToken Cookie (for web browser clients)
 */
function extractToken(req: express.Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  return req.cookies?.accessToken ?? null;
}

/**
 * Strict authentication middleware:
 * Requires a valid RS256 JWT, verifies expiration and signature,
 * fetches user from DB using lean(), and attaches to req.user.
 */
export const requireAuth: express.RequestHandler = async (req, _res, next) => {
  const token = extractToken(req);
  if (!token) {
    return next(new AppError('Authentication required. Missing token.', 401, 'MISSING_TOKEN'));
  }

  try {
    const payload = await verifyToken(token);
    const userId = payload.sub as string;

    // .lean() returns a lightweight plain JavaScript object instead of heavy Mongoose Document
    const user = await User.findById(userId).lean();
    if (!user) {
      return next(new AppError('User belonging to this token no longer exists.', 401, 'USER_NOT_FOUND'));
    }

    req.user = user as any;
    next();
  } catch (err: any) {
    next(new AppError('Invalid or expired token', 401, 'INVALID_TOKEN'));
  }
};

/**
 * Optional authentication middleware:
 * If token is present and valid, attaches req.user.
 * If token is absent or invalid, silently continues without error.
 * Perfect for public routes with tiered bonuses for logged-in users.
 */
export const optionalAuth: express.RequestHandler = async (req, _res, next) => {
  const token = extractToken(req);
  if (token) {
    try {
      const payload = await verifyToken(token);
      const userId = payload.sub as string;
      const user = await User.findById(userId).lean();
      if (user) {
        req.user = user as any;
      }
    } catch {
      // Silently swallow errors for optional auth routes
    }
  }
  next();
};
