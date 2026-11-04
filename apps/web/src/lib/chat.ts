import { api, json, upload, whileBusy } from './api';
import type { Quote } from './quote';
import type { Currency } from './currency';
import type { Say, Words } from './words';

/** A business's logo, trimmed and at most 512 px on its longer side. */
export interface Logo {
  url: string;
  width: number;
  height: number;
}

export interface BusinessProfile {
  name: string;
  initials: string;
  trade: string;
  /** What its prices are in. An older API leaves it out, for dollars. */
  currency?: Currency;
  services: string[];
  /** Who the chat says will follow up: the owner's first name unless they chose another. */
  ownerFirstName: string;
  websiteDomain: string;
  /** Taking quote requests: the owner has deployed the agent and hasn't paused it. */
  taking: boolean;
  /** Missing from an API older than this page. */
  logo?: Logo | null;
  /** Takes walk-around videos. Missing from older APIs, which don't. */
  videos?: boolean;
  /** The form at a yes, a visit or a question asks for the job's street address. Missing from older APIs. */
  asksAddress?: boolean;
  /** What the chat opens in. Missing from older APIs, which only speak English. */
  language?: string;
  /** What customers can switch it to, with the default first. */
  languages?: { code: string; native: string }[];
  /** The fixed lines in that language, when it isn't English. */
  words?: Words;
}

export interface ChatMessage {
  id: string;
  from: 'customer' | 'assistant' | 'owner';
  kind: 'text' | 'status';
  text: string;
  photos: { id: string; url: string }[];
  /** A walk-around video, and what was counted in it once it's measured. Missing from older APIs. */
  video?: { id: string; status: 'measuring' | 'measured' | 'failed'; found: string[] } | null;
  chips: string[];
  /** This asks for a photo. Missing from older APIs. */
  asksPhoto?: boolean;
  createdAt: string;
}

export interface ChatView {
  id: string;
  status: 'chatting' | 'contact' | 'quoting' | 'review' | 'sent' | 'accepted' | 'visit' | 'closed';
  test: boolean;
  serviceName: string;
  /** What the chat is in now, which follows what the customer writes. Missing from older APIs. */
  language?: string;
  messages: ChatMessage[];
  /** phone is missing from older APIs. */
  contact: { name: string; email: string | null; phone?: string | null };
  quote: {
    id: string;
    status: string;
    card: Quote;
    sentAt: string | null;
    /** The words on its accept button. Missing from older APIs. */
    acceptLabel?: string;
    /** Their photo and a picture of the job done, once it's drawn. Missing from older APIs. */
    /** `from` is missing from older APIs, which drew it from a photo. */
    preview?: { before: string; after: string; from?: 'photo' | 'video' } | null;
  } | null;
  waitingForOwner: boolean;
  /** In an owner's test, why this quote would wait for them. Missing from older APIs. */
  wouldWait?: { id: string; detail: string }[];
  /** Whether this chat takes walk-around videos. Missing from older APIs, which don't. */
  videosAllowed?: boolean;
  /** A video or the photos are being measured; the assistant carries on once they're done. */
  measuring?: boolean;
  /** What's being measured is the customer's photos. Missing from older APIs. */
  measuringPhotos?: boolean;
  /** How far that has got, once it has started. Missing from older APIs. */
  progress?: ReadingProgress | null;
}

/** A video or photo reading's step, and what it has seen so far. */
export interface ReadingProgress {
  step: 'preparing' | 'watching' | 'counting' | 'checking' | 'replying';
  /** What the video or photos show, in a sentence or two. */
  seen?: string;
  /** What's being counted: "windows". */
  counting?: string[];
  /** What was counted, before each one is looked at up close: "15 windows". */
  found?: string[];
}

export type ChatAccess = { chatId: string; token: string };

/** Shown before the chat starts. The API opens every chat with the same words. */
/** The first hello, naming the person behind the business when there is one, since later lines do. */
export const greeting = (t: Say, business: string, owner?: string) =>
  owner
    ? t(
        "Hi! I'm the quote assistant for {business}. I can put a price together for you in a couple of minutes, then {owner} takes it from there. What do you need done?",
        { business, owner },
      )
    : t(
        "Hi! I'm the quote assistant for {business}. I can put a price together for you in a couple of minutes. What do you need done?",
        { business },
      );

const storageKey = (slug: string) => `pricecharm:chat:${slug}`;

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
/** Whether the person looking is this business's signed-in owner, who can always test. */
export const loadViewer = (slug: string) => api<{ owner: boolean }>(`/chat/${slug}/viewer`);

export const startChat = (
  slug: string,
  source: 'link' | 'widget',
  language: string,
  headers: Record<string, string>,
) =>
  api<{ token: string; chat: ChatView }>(`/chat/${slug}/start`, {
    method: 'POST',
    headers,
    ...json({ source, language }),
  });

/** A language's fixed lines and the business's services in it. */
export const loadWords = (slug: string, language: string) =>
  api<{ words: Words; services: string[] }>(`/chat/${slug}/words/${language}`);

export const chooseLanguage = (slug: string, access: ChatAccess, language: string) =>
  api<ChatView>(`${base(slug, access)}/language`, {
    method: 'POST',
    headers: auth(access),
    ...json({ language }),
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
  return whileBusy(() =>
    api<ChatView>(`${base(slug, access)}/photos`, {
      method: 'POST',
      headers: auth(access),
      body,
    }),
  );
}

/** A walk-around video, with stills taken from it in the browser and where in it each was taken. */
export function sendVideo(
  slug: string,
  access: ChatAccess,
  video: File,
  stills: { blob: Blob; ms: number }[],
  durationMs: number | null,
  onProgress: (sent: number, total: number) => void,
) {
  const body = new FormData();
  if (durationMs !== null) body.append('durationMs', String(durationMs));
  body.append('stillTimes', JSON.stringify(stills.map((still) => still.ms)));
  for (const [index, still] of stills.entries())
    body.append('stills', still.blob, `still-${index}.jpg`);
  // Phones label the same files differently; the server checks what's inside.
  const type = video.type === 'video/quicktime' ? 'video/quicktime' : 'video/mp4';
  body.append(
    'video',
    new File([video], type === 'video/quicktime' ? 'walkaround.mov' : 'walkaround.mp4', { type }),
  );
  return upload<ChatView>(`${base(slug, access)}/videos`, body, auth(access), onProgress);
}

export const videoPath = (slug: string, access: ChatAccess, videoId: string) =>
  `/api/v1${base(slug, access)}/videos/${videoId}`;

/** A name and a way to reach them: an email, a phone number, or both. */
/** Who the customer is, and the job's street address where the business asks for it. */
export type Contact = { name: string; email: string; phone: string; address?: string };

/**
 * Where the customer leaves their details: before the price, when the owner asks for that; for a
 * quote that waits for the owner; or on a quote they can see, for a copy or a question.
 */
export const leaveContact = (
  slug: string,
  access: ChatAccess,
  contact: Contact,
  purpose: 'copy' | 'question' = 'copy',
) =>
  api<{ chat: ChatView | null }>(`${base(slug, access)}/contact`, {
    method: 'POST',
    headers: auth(access),
    ...json({ ...contact, purpose }),
  });

/** Counts the customer opening a form for their details, so it shows how many finish it. */
export const openedForm = (
  slug: string,
  access: ChatAccess,
  form: 'yes' | 'visit' | 'copy' | 'question',
) =>
  api<{ ok: boolean }>(`${base(slug, access)}/opened`, {
    method: 'POST',
    headers: auth(access),
    ...json({ form }),
  }).catch(() => {});

/** Why a customer isn't going ahead. The API keeps the same list. */
export const LOSS_REASONS = [
  { id: 'price', label: 'More than I want to spend' },
  { id: 'someone_else', label: 'Went with someone else' },
  { id: 'timing', label: 'The timing doesn’t work' },
  { id: 'not_now', label: 'Not doing it for now' },
  { id: 'other', label: 'Something else' },
] as const;
export type LossReason = (typeof LOSS_REASONS)[number]['id'];

/** A yes or a visit request carries the customer's details, unless they left them already. */
export const decide = (
  slug: string,
  access: ChatAccess,
  decision: 'accept' | 'visit' | 'decline',
  answer?: { reason?: LossReason; contact?: Contact },
) =>
  api<ChatView>(`${base(slug, access)}/${decision}`, {
    method: 'POST',
    headers: auth(access),
    ...json(
      decision === 'decline' ? { reason: answer?.reason ?? 'other' } : (answer?.contact ?? {}),
    ),
  });

/** Chat photos need the chat's token, so they're fetched and shown as local object URLs. */
export async function photoUrl(access: ChatAccess, url: string): Promise<string> {
  const response = await fetch(url, { headers: auth(access), credentials: 'include' });
  if (!response.ok) throw new Error('Photo unavailable.');
  return URL.createObjectURL(await response.blob());
}
