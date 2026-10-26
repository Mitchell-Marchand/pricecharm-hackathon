import { api, json } from './api';
import type { PracticeResult } from './practice';
import type { Quote } from './quote';

export interface Profile {
  asks: string[];
  prices: string[];
  handoffs: string[];
  results: PracticeResult[];
  autoSendReady: boolean;
  autoSend: boolean;
  jobsCount: number;
  practiceCount: number;
  practiceQuotes: Quote[];
}

export interface Me {
  user: {
    id: string;
    name: string;
    firstName?: string;
    email: string;
    emailVerified: boolean;
  };
  business: { id: string; name: string; slug: string };
}

export interface Share {
  slug: string;
  url: string;
  websiteDomain: string;
  widgetStyle: 'floating' | 'inline';
  embedCode: string;
}

export const loadProfile = () => api<Profile>('/onboarding/profile');
export const loadMe = () => api<Me>('/auth/me');
export const loadShare = () => api<Share>('/share');
export const saveShare = (patch: { website?: string; widgetStyle?: Share['widgetStyle'] }) =>
  api<Share>('/share', { method: 'PATCH', ...json(patch) });
export const sendInstructions = (email: string) =>
  api('/share/instructions', { method: 'POST', ...json({ email }) });
export const resendVerification = () =>
  api('/auth/request-verification', { method: 'POST', ...json({}) });

export function register(
  body: { firstName: string; lastName: string; email: string; password: string },
  headers: Record<string, string>,
) {
  return api<Me>('/auth/register', { method: 'POST', headers, ...json(body) });
}
