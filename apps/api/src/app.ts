import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { getPool } from './db.js';
import { csrfProtection, login, logout, me, register, requireOwner } from './auth.js';
import { ApiError, errorHandler, ok, rateLimit, requestId, securityHeaders } from './http.js';
import { createUploadRouter } from './uploads.js';
import { aiMode, aiProvider } from './ai/index.js';
import {
  forgotPassword,
  resetPassword,
  requestOwnerVerification,
  verifyOwnerCode,
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
import { isDeployed, validateRuntimeConfiguration } from './config.js';
import { requireHuman } from './human-check.js';
import { onboardingRouter } from './onboarding.js';
import { jobImportsRouter } from './job-imports.js';
import { quickbooksRouter } from './quickbooks.js';
import { approveLinkRouter } from './live/approve-link.js';
import { pastJobsRouter } from './past-jobs.js';
import { practiceRouter } from './practice/router.js';
import { profileRouter } from './profile.js';
import { charmRouter } from './charm.js';
import { charmNotesRouter } from './charm-notes.js';
import { turnDownsRouter } from './turn-downs.js';
import { locationsRouter } from './locations.js';
import { shareRouter } from './share.js';
import { chatRouter } from './live/router.js';
import { agentRouter } from './live/agent.js';
import { logoRouter, quotePageRouter } from './live/quote-page.js';
import { demoRouter } from './demo.js';
import { ownerQuotesRouter } from './live/owner.js';
import { visitsRouter } from './metrics.js';
import { activityRouter } from './activity.js';
import { metaWebhook, verifyMetaWebhook } from './channels/webhook.js';
import { channelRouter } from './channels/accounts.js';

/**
 * Requests one address may make to the API in a minute. The browser tests make a lot from one
 * address, so a local run can raise it with LOCAL_REQUESTS_PER_MINUTE. Deployed servers ignore that.
 */
function requestsPerMinute(): number {
  const local = Number(process.env.LOCAL_REQUESTS_PER_MINUTE);
  return local > 0 && process.env.NODE_ENV !== 'production' && !isDeployed() ? local : 300;
}

/**
 * Accounts one address may make in 15 minutes. The browser tests sign up more than that from one
 * address, so a local run can raise it with LOCAL_SIGNUPS_PER_ADDRESS. Deployed servers ignore that.
 */
function signupsPerAddress(): number {
  const local = Number(process.env.LOCAL_SIGNUPS_PER_ADDRESS);
  return local > 0 && process.env.NODE_ENV !== 'production' && !isDeployed() ? local : 10;
}

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
        (!process.env.ANTHROPIC_API_KEY || !process.env.ANTHROPIC_MODEL)) ||
      (aiProvider === 'meta' && !process.env.META_API_KEY)
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
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Turnstile-Token', 'X-PC-Session'],
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
  // Signed by Meta over the raw body, like Stripe's, so it comes before the JSON parser.
  app.get('/api/v1/hooks/meta', rateLimit(30, 60_000), verifyMetaWebhook);
  app.post(
    '/api/v1/hooks/meta',
    rateLimit(600, 60_000),
    express.raw({ type: 'application/json', limit: '1mb' }),
    metaWebhook,
  );
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v1', rateLimit(requestsPerMinute(), 60_000));
  app.use('/api/v1', createUploadRouter());
  app.get('/api/v1/pricing', pricingHandler);
  app.get('/api/v1/site', (_req, res) =>
    res.json(
      ok({
        name: 'PriceCharm',
        operatorName: process.env.OPERATOR_NAME || 'PriceCharm local development',
        supportEmail: process.env.SUPPORT_EMAIL || 'support@example.test',
        // Shown in the privacy policy and terms: a postal address, and the US state whose laws apply.
        operatorAddress: process.env.OPERATOR_ADDRESS?.trim() || '',
        governingLaw: process.env.GOVERNING_LAW?.trim() || '',
      }),
    ),
  );
  // Agents call from their own servers with a key and no cookies, so the browser origin check
  // that follows doesn't apply to them.
  app.use('/api/v1', agentRouter);
  app.use('/api/v1', csrfProtection);
  app.use(
    '/api/v1',
    onboardingRouter,
    pastJobsRouter,
    jobImportsRouter,
    quickbooksRouter,
    practiceRouter,
    profileRouter,
    charmRouter,
    charmNotesRouter,
    turnDownsRouter,
    chatRouter,
    logoRouter,
    demoRouter,
    visitsRouter,
    activityRouter,
  );
  app.post(
    '/api/v1/auth/register',
    rateLimit(signupsPerAddress(), 15 * 60_000),
    requireHuman('signup'),
    register,
  );
  app.post('/api/v1/auth/login', rateLimit(15, 15 * 60_000), login);
  app.post('/api/v1/auth/logout', logout);
  app.get('/api/v1/auth/me', requireOwner, me);
  app.post('/api/v1/auth/forgot-password', rateLimit(15, 15 * 60_000), forgotPassword);
  app.post('/api/v1/auth/reset-password', rateLimit(15, 15 * 60_000), resetPassword);
  app.post('/api/v1/auth/request-verification', requireOwner, requestOwnerVerification);
  app.post('/api/v1/auth/verify-email', rateLimit(30, 15 * 60_000), verifyOwnerEmail);
  app.post(
    '/api/v1/auth/verify-email-code',
    rateLimit(30, 15 * 60_000),
    requireOwner,
    verifyOwnerCode,
  );
  // The one-tap link in an owner's email works without signing in, for that one quote.
  app.use('/api/v1', approveLinkRouter);
  app.use(
    '/api/v1',
    requireOwner,
    billingRouter,
    accountRouter,
    shareRouter,
    ownerQuotesRouter,
    quotePageRouter,
    locationsRouter,
    channelRouter,
  );
  app.use((_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', 'Endpoint not found.')));
  app.use(errorHandler);
  return app;
}
