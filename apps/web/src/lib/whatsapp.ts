import { api, json } from './api';

/** What Settings needs to show WhatsApp: Meta's sign-up, when it's set up, and the number connected. */
export interface WhatsApp {
  signup: { appId: string; configId: string; graphVersion: string } | null;
  connected: { number: string } | null;
}

export const loadWhatsApp = () => api<WhatsApp>('/app/whatsapp');
export const connectWhatsApp = (input: { code: string; wabaId: string; phoneNumberId: string }) =>
  api<WhatsApp>('/app/whatsapp', { method: 'POST', ...json(input) });
export const disconnectWhatsApp = () => api<WhatsApp>('/app/whatsapp', { method: 'DELETE' });

type FacebookSdk = {
  init(options: object): void;
  login(
    callback: (response: { authResponse?: { code?: string } | null }) => void,
    options: object,
  ): void;
};

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

let loading: Promise<FacebookSdk> | null = null;

/**
 * Loads Meta's JavaScript SDK, once. It has to be ready before the owner clicks, since a popup
 * opened after waiting on a download is blocked.
 */
export function loadFacebook(signup: NonNullable<WhatsApp['signup']>): Promise<FacebookSdk> {
  if (window.FB) return Promise.resolve(window.FB);
  loading ??= new Promise<FacebookSdk>((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB?.init({
        appId: signup.appId,
        autoLogAppEvents: true,
        xfbml: false,
        version: signup.graphVersion,
      });
      if (window.FB) resolve(window.FB);
    };
    const script = document.createElement('script');
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () => {
      loading = null;
      reject(new Error('Meta’s sign-up didn’t load. Check your connection and try again.'));
    };
    document.body.appendChild(script);
  });
  return loading;
}

const fromFacebook = (origin: string) => {
  try {
    return /(^|\.)facebook\.com$/.test(new URL(origin).hostname);
  } catch {
    return false;
  }
};

/**
 * Meta's WhatsApp sign-up, in its popup. Resolves with what PriceCharm needs to connect the number
 * the owner picked, or null if they closed it. Meta says which number in a message to this page,
 * and hands over the one-time code when the popup closes, in either order.
 */
export function whatsAppSignup(
  signup: NonNullable<WhatsApp['signup']>,
): Promise<{ code: string; wabaId: string; phoneNumberId: string } | null> {
  const FB = window.FB;
  if (!FB) return Promise.reject(new Error('Meta’s sign-up is still loading. Try again.'));
  return new Promise((resolve, reject) => {
    let code = '',
      picked: { wabaId: string; phoneNumberId: string } | null = null,
      settled = false;
    const finish = (result: Parameters<typeof resolve>[0] | Error) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const ready = () => {
      if (code && picked) finish({ code, ...picked });
    };
    function onMessage(event: MessageEvent) {
      if (!fromFacebook(event.origin)) return;
      let data: {
        type?: string;
        event?: string;
        data?: { waba_id?: string; phone_number_id?: string; error_message?: string };
      };
      try {
        data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }
      if (data?.type !== 'WA_EMBEDDED_SIGNUP') return;
      if (data.event === 'CANCEL') finish(null);
      else if (data.event === 'ERROR')
        finish(new Error(data.data?.error_message || 'Meta’s sign-up stopped. Try again.'));
      else if (data.data?.waba_id && data.data.phone_number_id) {
        picked = { wabaId: data.data.waba_id, phoneNumberId: data.data.phone_number_id };
        ready();
      }
    }
    window.addEventListener('message', onMessage);
    FB.login(
      (response) => {
        code = response.authResponse?.code ?? '';
        if (!code) return finish(null);
        ready();
        // The number comes in a message just before; if it never does, they didn't pick one.
        setTimeout(
          () => finish(new Error('Meta didn’t say which number you picked. Try again.')),
          15_000,
        );
      },
      {
        config_id: signup.configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup: {}, featureType: '', sessionInfoVersion: '3' },
      },
    );
  });
}
