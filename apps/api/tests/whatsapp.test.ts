import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { ACCEPT_WORDINGS } from '../src/live/accept-wording.js';
import {
  CHIP,
  LIMITS,
  QUOTE,
  REASON,
  WhatsAppError,
  messageBody,
  quoteMessage,
  readWebhook,
  reasonsMessage,
  send,
  signedByMeta,
  withChoices,
} from '../src/channels/whatsapp.js';
import type { Quote } from '../src/practice/types.js';

afterEach(() => mock.restoreAll());

/** One message as Meta's webhook carries it. */
function webhook(message: Record<string, unknown>, contact: Record<string, unknown> = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001111', phone_number_id: 'number-1' },
              contacts: [
                {
                  profile: { name: 'Sam Kim' },
                  wa_id: '16505551234',
                  user_id: 'US.1349',
                  ...contact,
                },
              ],
              messages: [
                {
                  from: '16505551234',
                  from_user_id: 'US.1349',
                  id: 'wamid.in-1',
                  timestamp: '1793000000',
                  ...message,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

test('only a body signed with the app secret counts as from Meta', () => {
  const body = Buffer.from('{"object":"whatsapp_business_account"}');
  const signature = `sha256=${createHmac('sha256', 'app-secret').update(body).digest('hex')}`;
  assert.equal(signedByMeta(body, signature, 'app-secret'), true);
  assert.equal(signedByMeta(body, signature, 'another-secret'), false);
  assert.equal(signedByMeta(Buffer.from('{}'), signature, 'app-secret'), false);
  assert.equal(signedByMeta(body, signature.slice(0, -2), 'app-secret'), false);
  assert.equal(signedByMeta(body, undefined, 'app-secret'), false);
  assert.equal(signedByMeta(body, signature, ''), false);
});

test('a text message comes out with who sent it, keyed on Meta’s ID for them', () => {
  const { messages, deliveries } = readWebhook(
    webhook({ type: 'text', text: { body: 'How much to clean 20 windows?' } }),
  );
  assert.deepEqual(deliveries, []);
  assert.deepEqual(messages, [
    {
      id: 'wamid.in-1',
      phoneNumberId: 'number-1',
      sender: 'US.1349',
      phone: '+16505551234',
      name: 'Sam Kim',
      at: new Date(1793000000 * 1000).toISOString(),
      kind: 'text',
      text: 'How much to clean 20 windows?',
    },
  ]);
});

test('a customer Meta doesn’t share a number for is still answered, by their ID', () => {
  const [message] = readWebhook(
    webhook({ from: undefined, type: 'text', text: { body: 'Hi' } }, { wa_id: undefined }),
  ).messages;
  assert.equal(message.sender, 'US.1349');
  assert.equal(message.phone, null);
  // Before Meta's IDs, the number was the only key.
  const [older] = readWebhook(
    webhook(
      { from_user_id: undefined, type: 'text', text: { body: 'Hi' } },
      { user_id: undefined },
    ),
  ).messages;
  assert.equal(older.sender, '16505551234');
});

test('taps, photos, videos, places and voice notes each come out as what they are', () => {
  const read = (message: Record<string, unknown>) => readWebhook(webhook(message)).messages[0];
  assert.deepEqual(
    read({
      type: 'interactive',
      interactive: {
        type: 'button_reply',
        button_reply: { id: QUOTE.accept, title: 'Works for me' },
      },
    }),
    {
      ...read({ type: 'text', text: { body: '' } }),
      kind: 'choice',
      text: 'Works for me',
      choice: QUOTE.accept,
    },
  );
  assert.equal(
    read({
      type: 'interactive',
      interactive: {
        type: 'list_reply',
        list_reply: { id: `${REASON}price`, title: 'Over my budget' },
      },
    }).choice,
    `${REASON}price`,
  );
  const photo = read({
    type: 'image',
    image: { id: 'media-7', mime_type: 'image/jpeg', caption: 'Back side' },
  });
  assert.equal(photo.kind, 'photo');
  assert.equal(photo.mediaId, 'media-7');
  assert.equal(photo.text, 'Back side');
  assert.equal(read({ type: 'video', video: { id: 'media-8' } }).kind, 'video');
  assert.equal(
    read({
      type: 'location',
      location: { latitude: 45.5, longitude: -122.6, name: 'Home', address: '12 Elm St, Portland' },
    }).text,
    'My location: Home, 12 Elm St, Portland',
  );
  assert.equal(
    read({ type: 'location', location: { latitude: 45.512345, longitude: -122.6 } }).text,
    'My location: 45.51235, -122.60000',
  );
  assert.equal(read({ type: 'audio', audio: { id: 'media-9' } }).kind, 'voice');
  assert.equal(read({ type: 'reaction', reaction: { emoji: '👍' } }).kind, 'ignored');
});

test('what became of our messages comes out of the same webhook; other webhooks are skipped', () => {
  const payload = webhook({ type: 'text', text: { body: 'Hi' } });
  const value = payload.entry[0].changes[0].value as Record<string, unknown>;
  value.messages = undefined;
  value.statuses = [
    { id: 'wamid.out-1', status: 'read', timestamp: '1793000100', recipient_id: '16505551234' },
    {
      id: 'wamid.out-2',
      status: 'failed',
      timestamp: '1793000100',
      errors: [{ code: 131047, title: 'Re-engagement message' }],
    },
    { id: 'wamid.out-3', status: 'played', timestamp: '1793000100' },
  ];
  assert.deepEqual(readWebhook(payload), {
    messages: [],
    deliveries: [
      { id: 'wamid.out-1', status: 'read', error: null },
      { id: 'wamid.out-2', status: 'failed', error: 131047 },
    ],
  });
  assert.deepEqual(readWebhook({ object: 'page', entry: [] }), { messages: [], deliveries: [] });
  assert.deepEqual(readWebhook('nonsense'), { messages: [], deliveries: [] });
});

test('a few short suggestions become buttons, more become a list, and a tap reads as typed', () => {
  assert.deepEqual(withChoices('How many windows?', []), {
    kind: 'text',
    text: 'How many windows?',
  });
  const buttons = withChoices('Which service?', ['Windows', 'Gutters', 'Windows', ' ']);
  assert.equal(buttons.kind, 'buttons');
  assert.deepEqual(buttons.kind === 'buttons' && buttons.buttons, [
    { id: `${CHIP}Windows`, title: 'Windows' },
    { id: `${CHIP}Gutters`, title: 'Gutters' },
  ]);
  const services = ['Windows', 'Gutters', 'Screens', 'Pressure washing the whole driveway'];
  const list = withChoices('Which service?', services);
  assert.equal(list.kind, 'list');
  if (list.kind !== 'list') return;
  assert.equal(list.rows.length, 4);
  for (const [index, row] of list.rows.entries()) {
    assert.equal(row.id, `${CHIP}${services[index]}`);
    assert.ok(row.title.length <= LIMITS.rowTitle, row.title);
  }
  assert.equal(list.rows[3].title, 'Pressure washing the…');
  assert.equal(list.rows[3].description, 'Pressure washing the whole driveway');
  assert.equal(withChoices('x'.repeat(LIMITS.body + 1), ['Yes']).kind, 'text');
});

const card: Quote = {
  number: 12,
  customer: 'Sam K.',
  place: 'Portland, OR',
  issuedAt: '2026-10-30',
  lines: [
    { id: 'a', label: 'Outside windows (24)', amountCents: 24000 },
    { id: 'b', label: 'Screens', amountCents: 4050 },
  ],
  discount: { kind: 'percent', value: 10, reason: 'Second visit' },
  start: 'Next week',
  duration: 'About 3 hours',
  included: [],
  excluded: [],
  validDays: 14,
  note: '',
};

test('a quote is one message with its lines, total, link and the web card’s buttons', () => {
  const message = quoteMessage({
    quote: card,
    totalCents: 25245,
    business: 'Bright Panes',
    owner: 'Dana at Bright Panes',
    sent: { photos: true, video: false },
    acceptLabel: 'Works for me',
    link: 'https://pricecharm.com/q/bright#chat=1&token=t',
  });
  assert.equal(message.kind, 'buttons');
  if (message.kind !== 'buttons') return;
  assert.equal(
    message.text,
    [
      '*Quote from Bright Panes*',
      '',
      '• Outside windows (24): $240',
      '• Screens: $40.50',
      '• Second visit: −$28.05',
      '',
      '*Total: $252.45*',
      'Can start: Next week · Takes about 3 hours',
      'Based on your photos and what you told us.',
      '',
      'See the full quote: https://pricecharm.com/q/bright#chat=1&token=t',
    ].join('\n'),
  );
  // The longest line that fits WhatsApp's 60 characters, naming who books it.
  assert.equal(message.footer, 'No payment now. Dana at Bright Panes will reach out to book.');
  assert.deepEqual(
    message.buttons.map((button) => [button.id, button.title]),
    [
      [QUOTE.accept, 'Works for me'],
      [QUOTE.question, 'Ask a question'],
      [QUOTE.decline, 'Not going ahead'],
    ],
  );
});

test('a price range shows what’s included but not what each part costs', () => {
  const message = quoteMessage({
    quote: {
      ...card,
      discount: null,
      style: 'range',
      range: { lowCents: 25000, highCents: 32500 },
    },
    totalCents: 28050,
    business: 'Bright Panes',
    owner: 'Dana at Bright Panes',
    sent: { photos: false, video: true },
    acceptLabel: 'Looks good to me',
    link: 'https://pricecharm.com/q/bright',
  });
  assert.ok(message.kind === 'buttons');
  assert.match(message.text, /^• Outside windows \(24\)$/m);
  assert.doesNotMatch(message.text, /\$240|\$40\.50|\$280/);
  assert.match(message.text, /\*Price range: \$250 to \$325\*/);
  // It says what the customer sent and names no one they haven't met.
  assert.match(
    message.text,
    /A price range based on your video\. You’ll know the exact price before any work starts\./,
  );
  assert.doesNotMatch(message.text, /Dana/);
});

test('every part of a quote message fits WhatsApp’s limits, however long the quote', () => {
  const lines = Array.from({ length: 20 }, (_, index) => ({
    id: String(index),
    label: `Room ${index + 1}: walls, ceiling and trim, two coats, with prep and cleanup`,
    amountCents: 45000,
  }));
  const message = quoteMessage({
    quote: { ...card, lines, discount: null },
    totalCents: 900000,
    business: 'A Painting Company With Quite a Long Name LLC',
    owner: 'Alexandra Konstantinopoulou at A Painting Company With Quite a Long Name LLC',
    sent: { photos: false, video: false },
    acceptLabel: 'An owner wording that runs long',
    link: `https://pricecharm.com/q/painting#chat=${'c'.repeat(36)}&token=${'t'.repeat(43)}`,
  });
  assert.ok(message.kind === 'buttons');
  assert.ok(message.text.length <= LIMITS.body, String(message.text.length));
  assert.match(message.text, /• and \d+ more/);
  assert.match(message.text, /See the full quote: https:/);
  assert.ok((message.footer ?? '').length <= LIMITS.footer);
  assert.equal(message.buttons[0].title, 'Looks good to me');
  for (const button of message.buttons) assert.ok(button.title.length <= LIMITS.buttonTitle);
  for (const { label } of ACCEPT_WORDINGS) assert.ok(label.length <= LIMITS.buttonTitle, label);
});

test('turning a quote down offers the web’s reasons, each short enough for a list row', () => {
  const message = reasonsMessage('Dana');
  assert.ok(message.kind === 'list');
  assert.equal(message.text, 'Mind saying why? It helps Dana.');
  assert.equal(message.rows[0].title, 'Over my budget');
  for (const row of message.rows) {
    assert.ok(row.id.startsWith(REASON));
    assert.ok(row.title.length <= LIMITS.rowTitle, row.title);
  }
});

test('messages go to the customer’s number when Meta shares it, or to Meta’s ID for them', async () => {
  const sent: Record<string, unknown>[] = [];
  mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.match(url, /\/number-1\/messages$/);
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer token-1');
    sent.push(JSON.parse(String(init.body)));
    return Response.json({ messages: [{ id: `wamid.out-${sent.length}` }] });
  });
  const line = { phoneNumberId: 'number-1', token: 'token-1' };
  assert.equal(
    await send(line, { phone: '+1 650 555 1234', userId: 'US.1349' }, { kind: 'text', text: 'Hi' }),
    'wamid.out-1',
  );
  await send(
    line,
    { phone: null, userId: 'US.1349' },
    { kind: 'text', text: 'See https://x.test' },
  );
  assert.equal(sent[0].to, '16505551234');
  assert.equal(sent[0].recipient, undefined);
  assert.equal(sent[1].recipient, 'US.1349');
  assert.deepEqual(sent[1].text, { body: 'See https://x.test', preview_url: true });
});

test('WhatsApp’s refusals come back with its code, and only passing ones are worth retrying', async () => {
  mock.method(globalThis, 'fetch', async () =>
    Response.json({ error: { message: 'Re-engagement message', code: 131047 } }, { status: 400 }),
  );
  const error = await send(
    { phoneNumberId: 'number-1', token: 'token-1' },
    { phone: '+16505551234', userId: '' },
    { kind: 'text', text: 'Hi' },
  ).catch((caught: unknown) => caught);
  assert.ok(error instanceof WhatsAppError);
  assert.equal(error.code, 131047);
  assert.equal(error.passing, false);
  assert.equal(new WhatsAppError('Slow down', 131056, 400).passing, true);
  assert.equal(new WhatsAppError('Down', null, 503).passing, true);
});

test('buttons and lists are sent the way WhatsApp expects them', () => {
  assert.deepEqual(
    messageBody({
      kind: 'buttons',
      text: 'Which?',
      footer: 'Tap one',
      buttons: [{ id: 'a', title: 'A' }],
    }),
    {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: 'Which?' },
        footer: { text: 'Tap one' },
        action: { buttons: [{ type: 'reply', reply: { id: 'a', title: 'A' } }] },
      },
    },
  );
  assert.deepEqual(
    messageBody({
      kind: 'list',
      text: 'Which?',
      button: 'Pick one',
      rows: [{ id: 'a', title: 'A' }],
    }),
    {
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: 'Which?' },
        action: { button: 'Pick one', sections: [{ rows: [{ id: 'a', title: 'A' }] }] },
      },
    },
  );
});
