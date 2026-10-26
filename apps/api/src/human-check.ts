import type { Request, RequestHandler } from 'express';
import { ApiError } from './http.js';

/** Each page renders the Turnstile widget with its own action, so a token only works where it was earned. */
export type HumanCheckAction = 'signup' | 'guest_preview' | 'quote_chat' | 'onboarding';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Cloudflare Turnstile. The browser sends its token in X-Turnstile-Token; each token works once. */
export async function verifyHuman(req: Request, action: HumanCheckAction): Promise<void> {
  // Without a secret (local runs and tests) there's nothing to check against.
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) return;
  const token = req.get('x-turnstile-token')?.trim();
  if (!token || token.length > 2048)
    throw new ApiError(400, 'HUMAN_CHECK_REQUIRED', 'Please finish the quick check and try again.');
  let result: { success?: boolean; action?: string };
  try {
    const response = await fetch(VERIFY_URL, {
      method: 'POST',
      body: new URLSearchParams({
        secret,
        response: token,
        ...(req.ip ? { remoteip: req.ip } : {}),
      }),
      signal: AbortSignal.timeout(5000),
    });
    result = (await response.json()) as typeof result;
  } catch {
    throw new ApiError(
      503,
      'HUMAN_CHECK_UNAVAILABLE',
      'We couldn’t run the quick check just now. Please try again.',
    );
  }
  if (!result.success || (result.action && result.action !== action))
    throw new ApiError(403, 'HUMAN_CHECK_FAILED', 'The quick check didn’t pass. Please try again.');
}

export function requireHuman(action: HumanCheckAction): RequestHandler {
  return async (req, _res, next) => {
    await verifyHuman(req, action);
    next();
  };
}
