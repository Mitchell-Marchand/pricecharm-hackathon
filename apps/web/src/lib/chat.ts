import { api, json } from './api';
import type { Quote } from './quote';

export interface BusinessProfile {
  name: string;
  initials: string;
  trade: string;
  services: string[];
  ownerFirstName: string;
  websiteDomain: string;
}

export interface ChatMessage {
  id: string;
  from: 'customer' | 'assistant' | 'owner';
  kind: 'text' | 'status';
  text: string;
  photos: { id: string; url: string }[];
  chips: string[];
  createdAt: string;
}

export interface ChatView {
  id: string;
  status: 'chatting' | 'contact' | 'quoting' | 'review' | 'sent' | 'accepted' | 'visit' | 'closed';
  test: boolean;
  serviceName: string;
  messages: ChatMessage[];
  contact: { name: string; email: string | null; verified: boolean };
  quote: { id: string; status: string; card: Quote; sentAt: string | null } | null;
  waitingForOwner: boolean;
}

export type ChatAccess = { chatId: string; token: string };

/** Shown before the chat starts. The API opens every chat with the same words. */
export const greeting = (businessName: string) =>
  `Hi! I'm the quote assistant for ${businessName}. I can put a price together for you in a couple of minutes. What do you need done?`;

const storageKey = (slug: string) => `quotefolk:chat:${slug}`;

export function savedAccess(slug: string): ChatAccess | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(storageKey(slug)) || 'null');
    return value?.chatId && value?.token ? value : null;
  } catch {
    return null;
  }
}

export function saveAccess(slug: string, access: ChatAccess | null) {
  try {
    if (access) window.localStorage.setItem(storageKey(slug), JSON.stringify(access));
    else window.localStorage.removeItem(storageKey(slug));
  } catch {
    // Without storage the chat still works; it just can't be reopened later from this browser.
  }
}

/** The link in a customer's quote email: /q/slug#chat=…&token=… */
export function accessFromLink(): ChatAccess | null {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const chatId = params.get('chat'),
    token = params.get('token');
  if (!chatId || !token) return null;
  window.history.replaceState(null, '', window.location.pathname);
  return { chatId, token };
}

const auth = (access: ChatAccess) => ({ Authorization: `Bearer ${access.token}` });
const base = (slug: string, access: ChatAccess) => `/chat/${slug}/${access.chatId}`;

export const loadProfile = (slug: string) => api<BusinessProfile>(`/chat/${slug}`);

export const startChat = (
  slug: string,
  source: 'link' | 'widget',
  headers: Record<string, string>,
) =>
  api<{ token: string; chat: ChatView }>(`/chat/${slug}/start`, {
    method: 'POST',
    headers,
    ...json({ source }),
  });

export const loadChat = (slug: string, access: ChatAccess) =>
  api<ChatView>(base(slug, access), { headers: auth(access) });

export const sendMessage = (slug: string, access: ChatAccess, text: string) =>
  api<ChatView>(`${base(slug, access)}/messages`, {
    method: 'POST',
    headers: auth(access),
    ...json({ text }),
  });

export function sendPhoto(slug: string, access: ChatAccess, blob: Blob) {
  const body = new FormData();
  body.append('file', blob, 'photo.jpg');
  return api<ChatView>(`${base(slug, access)}/photos`, {
    method: 'POST',
    headers: auth(access),
    body,
  });
}

export const requestCode = (slug: string, access: ChatAccess, name: string, email: string) =>
  api<{ verificationId: string | null; devCode?: string; chat: ChatView | null }>(
    `${base(slug, access)}/contact`,
    { method: 'POST', headers: auth(access), ...json({ name, email }) },
  );

export const verifyCode = (
  slug: string,
  access: ChatAccess,
  verificationId: string,
  code: string,
) =>
  api<ChatView>(`${base(slug, access)}/verify`, {
    method: 'POST',
    headers: auth(access),
    ...json({ verificationId, code }),
  });

/** Why a customer isn't going ahead. The API keeps the same list. */
export const LOSS_REASONS = [
  { id: 'price', label: 'More than I want to spend' },
  { id: 'someone_else', label: 'Went with someone else' },
  { id: 'timing', label: 'The timing doesn’t work' },
  { id: 'not_now', label: 'Not doing it for now' },
  { id: 'other', label: 'Something else' },
] as const;
export type LossReason = (typeof LOSS_REASONS)[number]['id'];

export const decide = (
  slug: string,
  access: ChatAccess,
  decision: 'accept' | 'visit' | 'decline',
  reason?: LossReason,
) =>
  api<ChatView>(`${base(slug, access)}/${decision}`, {
    method: 'POST',
    headers: auth(access),
    ...json(decision === 'decline' ? { reason: reason ?? 'other' } : {}),
  });

/** Chat photos need the chat's token, so they're fetched and shown as local object URLs. */
export async function photoUrl(access: ChatAccess, url: string): Promise<string> {
  const response = await fetch(url, { headers: auth(access), credentials: 'include' });
  if (!response.ok) throw new Error('Photo unavailable.');
  return URL.createObjectURL(await response.blob());
}
