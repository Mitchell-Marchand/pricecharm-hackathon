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
    lastName?: string;
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

export const login = (email: string, password: string) =>
  api<Me>('/auth/login', { method: 'POST', ...json({ email, password }) });
export const logout = () => api('/auth/logout', { method: 'POST', ...json({}) });
export const forgotPassword = (email: string) =>
  api<{ devToken?: string }>('/auth/forgot-password', { method: 'POST', ...json({ email }) });
export const resetPassword = (token: string, password: string) =>
  api('/auth/reset-password', { method: 'POST', ...json({ token, password }) });
export const verifyEmail = (token: string) =>
  api('/auth/verify-email', { method: 'POST', ...json({ token }) });

/** The one-time token in a link from one of our emails: /reset-password#token=… */
export function tokenFromLink(): string | null {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
  if (token) window.history.replaceState(null, '', window.location.pathname);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}
