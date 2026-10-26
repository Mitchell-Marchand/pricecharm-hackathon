import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AiError } from './ai/index.js';
import { reportError } from './error-reporting.js';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export const ok = (data: unknown) => ({ data });
export const requestId: RequestHandler = (req, res, next) => {
  res.locals.requestId = randomUUID();
  res.setHeader('X-Request-Id', res.locals.requestId);
  next();
};
export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  next();
};
export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof AiError) {
    res.status(503).json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Check the highlighted fields.',
        details: error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
    return;
  }
  if (error instanceof ApiError) {
    res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    });
    return;
  }
  if (error instanceof RangeError) {
    res.status(422).json({ error: { code: 'PRICING_LIMIT', message: error.message } });
    return;
  }
  if (error?.type === 'entity.too.large') {
    res
      .status(413)
      .json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request exceeds the allowed size.' } });
    return;
  }
  if (error instanceof SyntaxError && 'body' in error) {
    res
      .status(400)
      .json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON.' } });
    return;
  }
  if (error?.code === 'ER_DUP_ENTRY') {
    res.status(409).json({
      error: { code: 'CONFLICT', message: 'This record already exists. Refresh and try again.' },
    });
    return;
  }
  console.error(
    JSON.stringify({
      level: 'error',
      requestId: res.locals.requestId,
      code: error?.code || error?.name || 'unknown',
    }),
  );
  reportError(error, { requestId: String(res.locals.requestId || '') });
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong. Please try again.',
      requestId: res.locals.requestId,
    },
  });
};

export function rateLimit(limit: number, windowMs: number): RequestHandler {
  const buckets = new Map<string, { count: number; until: number }>();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    if (buckets.size > 5000)
      for (const [id, value] of buckets) if (value.until <= now) buckets.delete(id);
    let bucket = buckets.get(key);
    if (!bucket || bucket.until <= now) {
      bucket = { count: 0, until: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > limit) {
      res.set('Retry-After', String(Math.ceil((bucket.until - now) / 1000)));
      next(new ApiError(429, 'RATE_LIMITED', 'Please wait a moment before trying again.'));
      return;
    }
    if (buckets.size > 10_000) {
      next(new ApiError(503, 'BUSY', 'The service is busy. Please try again shortly.'));
      return;
    }
    next();
  };
}
