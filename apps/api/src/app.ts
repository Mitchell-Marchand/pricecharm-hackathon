import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { getPool } from './db.js';
import { csrfProtection, login, logout, me, register, requireOwner } from './auth.js';
import { ApiError, errorHandler, ok, rateLimit, requestId, securityHeaders } from './http.js';
import { ownerRouter } from './owner.js';
import { publicRouter } from './public.js';
import { trainingRouter } from './training.js';
import { createUploadRouter } from './uploads.js';
import { aiMode, aiProvider } from './ai/index.js';
import { importRouter } from './imports.js';
import { knowledgeRouter } from './knowledge.js';
import {
  forgotPassword,
  resetPassword,
  requestOwnerVerification,
  verifyOwnerEmail,
} from './verification.js';
import {
  billingRouter,
  pricingHandler,
  stripeWebhook,
  validateBillingConfiguration,
} from './billing.js';
import { validateEmailConfiguration } from './integrations/email.js';
import { accountRouter } from './accounts.js';
import { serviceSetupRouter } from './service-setup.js';
import { guestPreviewRouter } from './guest-preview.js';
import { validateRuntimeConfiguration } from './config.js';
import { requireHuman } from './human-check.js';

export function createApp() {
  validateRuntimeConfiguration();
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.use(requestId, securityHeaders);
  const origins = (process.env.APP_ORIGIN || 'http://localhost:3100')
    .split(',')
    .map((item) => item.trim());
  validateEmailConfiguration();
  validateBillingConfiguration();
  if (process.env.NODE_ENV === 'production') {
    if (aiMode === 'demo') throw new Error('Production cannot run a demo AI provider.');
    if (
      (aiProvider === 'openai' && !process.env.OPENAI_API_KEY) ||
      (aiProvider === 'anthropic' &&
        (!process.env.ANTHROPIC_API_KEY || !process.env.ANTHROPIC_MODEL))
    )
      throw new Error('Configure credentials and model for the selected production AI provider.');
    if (
      !process.env.APP_ORIGIN ||
      origins.some((origin) => {
        try {
          const url = new URL(origin);
          return url.protocol !== 'https:' || url.origin !== origin;
        } catch {
          return true;
        }
      })
    )
      throw new Error('Production requires explicit HTTPS APP_ORIGIN values.');
    if (
      !z.email().safeParse(process.env.SUPPORT_EMAIL).success ||
      !process.env.OPERATOR_NAME?.trim() ||
      !process.env.OPERATOR_ADDRESS?.trim() ||
      !process.env.GOVERNING_LAW?.trim()
    )
      throw new Error(
        'Production requires SUPPORT_EMAIL, OPERATOR_NAME, OPERATOR_ADDRESS and GOVERNING_LAW for public product support and policies.',
      );
  }
  app.use(
    cors({
      origin: (origin, callback) => callback(null, !origin || origins.includes(origin)),
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Turnstile-Token'],
    }),
  );
  app.get('/health', (_req, res) =>
    res.json(
      ok({
        ok: true,
        service: 'quotient-api',
        release: process.env.APP_RELEASE || 'development',
        uptimeSeconds: Math.round(process.uptime()),
      }),
    ),
  );
  app.get('/ready', async (_req, res) => {
    await getPool().query('SELECT 1');
    res.json(ok({ ok: true }));
  });
  app.post(
    '/api/v1/billing/webhook',
    rateLimit(120, 60_000),
    express.raw({ type: 'application/json', limit: '1mb' }),
    stripeWebhook,
  );
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v1', rateLimit(300, 60_000));
  app.use('/api/v1', createUploadRouter());
  app.use('/api/v1/public', publicRouter);
  app.get('/api/v1/pricing', pricingHandler);
  app.get('/api/v1/site', (_req, res) =>
    res.json(
      ok({
        name: 'Quotefolk',
        operatorName: process.env.OPERATOR_NAME || 'Quotefolk local development',
        supportEmail: process.env.SUPPORT_EMAIL || 'support@example.test',
        // Shown in the privacy policy and terms: a postal address, and the US state whose laws apply.
        operatorAddress: process.env.OPERATOR_ADDRESS?.trim() || '',
        governingLaw: process.env.GOVERNING_LAW?.trim() || '',
      }),
    ),
  );
  app.use('/api/v1', csrfProtection);
  app.use('/api/v1', guestPreviewRouter);
  app.post('/api/v1/auth/register', rateLimit(10, 15 * 60_000), requireHuman('signup'), register);
  app.post('/api/v1/auth/login', rateLimit(15, 15 * 60_000), login);
  app.post('/api/v1/auth/logout', logout);
  app.get('/api/v1/auth/me', requireOwner, me);
  app.post('/api/v1/auth/forgot-password', rateLimit(15, 15 * 60_000), forgotPassword);
  app.post('/api/v1/auth/reset-password', rateLimit(15, 15 * 60_000), resetPassword);
  app.post('/api/v1/auth/request-verification', requireOwner, requestOwnerVerification);
  app.post('/api/v1/auth/verify-email', rateLimit(30, 15 * 60_000), verifyOwnerEmail);
  app.use(
    '/api/v1',
    requireOwner,
    ownerRouter,
    trainingRouter,
    importRouter,
    knowledgeRouter,
    billingRouter,
    accountRouter,
    serviceSetupRouter,
  );
  app.use((_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', 'Endpoint not found.')));
  app.use(errorHandler);
  return app;
}
