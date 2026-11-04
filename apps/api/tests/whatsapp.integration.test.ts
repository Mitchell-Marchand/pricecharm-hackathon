import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import request from 'supertest';
import { closeDatabase, mutate, rows } from '../src/db.js';
import { CHIP, QUOTE, REASON } from '../src/channels/whatsapp.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const origin = 'http://localhost:3100';
after(() => closeDatabase());

test(
  'a customer messages the business on WhatsApp, gets the Charm’s questions and quote there, and answers it with a tap',
  { skip: !enabled },
  async () => {
    process.env.UPLOAD_DIR ??= await fs.mkdtemp(path.join(os.tmpdir(), 'pricecharm-whatsapp-'));
    process.env.META_APP_SECRET = 'app-secret';
    process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';
    process.env.WHATSAPP_ACCESS_TOKEN = 'platform-token';
    // Signing up has a per-address limit that the whole test run shares, so the owner has their own.
    process.env.TRUST_PROXY = '1';
    const { createApp } = await import('../src/app.js');
    const { deliverWaiting } = await import('../src/channels/conversation.js');
    const app = createApp();

    // Meta's side: everything sent is kept, and a photo a customer sends downloads as this one.
    const photo = await sharp({
      create: { width: 64, height: 48, channels: 3, background: '#88aacc' },
    })
      .jpeg()
      .toBuffer();
    const sent: Record<string, any>[] = [];
    const typing: string[] = [];
    // The business's own number, once it connects it in Settings.
    const ownSent: Record<string, any>[] = [];
    const accountCalls: string[] = [];
    const templates: Record<string, any>[] = [];
    const realFetch = globalThis.fetch.bind(globalThis);
    mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://graph.facebook.com/') && url.includes('/oauth/access_token')) {
        const query = new URL(url).searchParams;
        assert.deepEqual(
          [query.get('client_id'), query.get('client_secret'), query.get('code')],
          ['10001', 'app-secret', 'signup-code-123'],
        );
        return Response.json({ access_token: 'business-token', token_type: 'bearer' });
      }
      if (url.startsWith('https://graph.facebook.com/') && /\/(22222|20000)\b/.test(url)) {
        assert.equal(
          (init?.headers as Record<string, string>).Authorization,
          'Bearer business-token',
          'The business’s own number sends with its own key',
        );
        const method = init?.method ?? 'GET';
        if (url.endsWith('/22222/register'))
          accountCalls.push(`register ${JSON.parse(String(init?.body)).pin.length}`);
        else if (url.endsWith('/20000/subscribed_apps'))
          accountCalls.push(`${method} subscribed_apps`);
        else if (url.endsWith('/20000/message_templates'))
          templates.push(JSON.parse(String(init?.body)));
        else if (url.includes('/22222?fields='))
          return Response.json({ display_phone_number: '+1 555-000-2222', verified_name: 'Moss' });
        else if (url.endsWith('/22222/messages')) {
          const body = JSON.parse(String(init?.body));
          if (body.status === 'read') return Response.json({ success: true });
          ownSent.push(body);
          return Response.json({ messages: [{ id: `wamid.own-${ownSent.length}` }] });
        }
        return Response.json({ success: true });
      }
      if (url.startsWith('https://graph.facebook.com/')) {
        assert.equal(
          (init?.headers as Record<string, string>).Authorization,
          'Bearer platform-token',
        );
        if (url.endsWith('/number-1/messages')) {
          const body = JSON.parse(String(init?.body));
          if (body.status === 'read') {
            typing.push(body.message_id);
            return Response.json({ success: true });
          }
          sent.push(body);
          return Response.json({ messages: [{ id: `wamid.out-${sent.length}` }] });
        }
        if (url.endsWith('/number-1/media')) return Response.json({ id: 'uploaded-1' });
        if (url.endsWith('/media-photo'))
          return Response.json({
            url: 'https://lookaside.fbsbx.com/whatsapp/media-photo',
            mime_type: 'image/jpeg',
            file_size: photo.length,
          });
      }
      if (url === 'https://lookaside.fbsbx.com/whatsapp/media-photo') return new Response(photo);
      return realFetch(input, init);
    });

    // A business that's live on the per-quote plan, with Driveways learned so quotes go out.
    const owner = request.agent(app).set('X-Forwarded-For', '203.0.113.40');
    await owner.post('/api/v1/onboarding/start').set('Origin', origin).send({}).expect(201);
    await owner
      .patch('/api/v1/onboarding/business')
      .set('Origin', origin)
      .send({
        tradeId: 'pressure-washing',
        services: ['Driveways', 'House wash'],
        name: 'Moss & Stone Exterior Care',
        area: 'Portland, OR',
      })
      .expect(200);
    let draftId = '';
    for (const priceCents of [25000, 27500, 30000]) {
      const job = await owner
        .post('/api/v1/onboarding/jobs')
        .set('Origin', origin)
        .send({
          serviceName: 'Driveways',
          description: 'Two-car driveway wash.',
          priceCents,
          size: '600 sq ft',
        })
        .expect(201);
      [{ business_id: draftId }] = await rows('SELECT business_id FROM past_jobs WHERE id=?', [
        job.body.data.id,
      ]);
    }
    for (const position of [0, 1]) {
      const lines = [{ id: 'a', label: 'Driveway wash', amountCents: 27500 }];
      await mutate(
        `REPLACE INTO practice_runs (id,business_id,position,status,scenario_json,outcome,quote_json,shadow_json,finished_at)
         VALUES (?,?,?,'finished',?,'quote',?,?,UTC_TIMESTAMP(3))`,
        [
          randomUUID(),
          draftId,
          position,
          JSON.stringify({
            firstName: 'Dana',
            lastInitial: 'R',
            place: '',
            serviceName: 'Driveways',
            facts: [],
          }),
          JSON.stringify({ lines, discount: null, included: [], excluded: [], validDays: 14 }),
          JSON.stringify({
            decision: 'quote',
            lines,
            discount: null,
            cents: 26000,
            confidence: 'high',
          }),
        ],
      );
    }
    const signup = await owner
      .post('/api/v1/auth/register')
      .set('Origin', origin)
      .send({
        firstName: 'Maya',
        lastName: 'Lopez',
        email: `qa-whatsapp-${randomUUID()}@example.test`,
        password: 'test password strong123',
      });
    assert.equal(signup.status, 201, JSON.stringify(signup.body));
    const businessId = String(signup.body.data.business.id);
    await owner
      .post('/api/v1/app/billing/plan')
      .set('Origin', origin)
      .send({ plan: 'per_quote' })
      .expect(200);
    await owner.post('/api/v1/billing/checkout').set('Origin', origin).send({}).expect(200);
    await owner.post('/api/v1/app/deploy').set('Origin', origin).send({}).expect(200);
    const accountId = randomUUID();
    await mutate(
      "INSERT INTO channel_accounts (id,business_id,kind,platform_id,display_name,test_numbers) VALUES (?,?,'whatsapp','number-1','+1 555 000 1111','16505557777')",
      [accountId, businessId],
    );

    // Meta checks the webhook once with our verify token.
    const verified = await request(app).get('/api/v1/hooks/meta').query({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'verify-me',
      'hub.challenge': '1158201444',
    });
    assert.equal(verified.status, 200);
    assert.equal(verified.text, '1158201444');
    await request(app)
      .get('/api/v1/hooks/meta')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' })
      .expect(403);

    let messageNumber = 0;
    const post = (value: Record<string, unknown>, secret = 'app-secret') => {
      const body = JSON.stringify({
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
                  ...value,
                },
              },
            ],
          },
        ],
      });
      return request(app)
        .post('/api/v1/hooks/meta')
        .set('Content-Type', 'application/json')
        .set(
          'X-Hub-Signature-256',
          `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
        )
        .send(body);
    };
    /** One customer message, answered: waits until it's handled and the replies have gone. */
    async function says(from: { phone: string; userId: string; name: string }, message: object) {
      const id = `wamid.in-${++messageNumber}`;
      const before = sent.length;
      const response = await post({
        contacts: [{ profile: { name: from.name }, wa_id: from.phone, user_id: from.userId }],
        messages: [
          {
            from: from.phone,
            from_user_id: from.userId,
            id,
            timestamp: String(Math.floor(Date.now() / 1000)),
            ...message,
          },
        ],
      });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      await answered(id, from.userId);
      return sent.slice(before);
    }
    /**
     * Waits until a message is handled and its replies have gone. They go after it's marked
     * handled, and the sender is let go once they have, so a slow machine can't see one without.
     */
    async function answered(id: string, sender: string) {
      for (let tries = 0; tries < 200; tries++) {
        const [inbox] = await rows('SELECT status FROM channel_inbox WHERE platform_message_id=?', [
          id,
        ]);
        const [held] = await rows(
          'SELECT lease_token FROM channel_senders WHERE sender=? AND lease_token IS NOT NULL',
          [sender],
        );
        if (inbox?.status === 'handled' && !held) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.fail(`${id} was never answered`);
    }
    const text = (body: string) => ({ type: 'text', text: { body } });
    const tap = (id: string, title: string) => ({
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id, title } },
    });

    // A webhook Meta didn't sign is turned away.
    assert.equal((await post({ messages: [] }, 'another-secret')).status, 401);

    // 1. The first message starts a chat with the name and number Meta passes on. The Charm's
    // first reply says hello and who it is, and asks its question, all in one message, and the
    // customer sees it typing first.
    const sam = { phone: '16505551234', userId: 'US.1349', name: 'Sam Kim' };
    let replies = await says(sam, text('Driveways'));
    assert.deepEqual(typing, ['wamid.in-1']);
    assert.equal(replies.length, 1, JSON.stringify(replies));
    assert.equal(replies[0].to, '16505551234');
    assert.match(
      replies[0].text.body,
      /^\[Demo\] Hi Sam! I’m the quote assistant for Moss & Stone Exterior Care\. \S/,
    );
    const [chat] = await rows('SELECT * FROM lead_chats WHERE channel_user_id=?', [sam.userId]);
    assert.equal(chat.source, 'whatsapp');
    assert.equal(chat.customer_name, 'Sam Kim');
    assert.equal(chat.customer_phone, '+16505551234');
    assert.equal(chat.business_id, businessId);

    // 2. A suggestion comes as a button.
    replies = await says(sam, text('About 600 sq ft, two cars.'));
    assert.equal(replies.length, 1);
    assert.equal(replies[0].type, 'interactive');
    assert.deepEqual(replies[0].interactive.action.buttons, [
      { type: 'reply', reply: { id: `${CHIP}Skip photos`, title: 'Skip photos' } },
    ]);

    // 3. Tapping it reads as typed. The quote is drafted and goes out on its own. It's billed once
    // WhatsApp says it reached them, since that's when it's shown.
    replies = await says(sam, tap(`${CHIP}Skip photos`, 'Skip photos'));
    const [quote] = await rows('SELECT * FROM live_quotes WHERE chat_id=?', [chat.id]);
    assert.equal(quote.status, 'sent');
    const quoteMessage = replies.find((reply) => reply.type === 'interactive');
    assert.ok(quoteMessage, JSON.stringify(replies));
    assert.ok(
      !replies.some((reply) => /Here’s your quote/.test(reply.text?.body ?? '')),
      'The quote says what it is, without a line before it',
    );
    assert.equal(replies.at(-1), quoteMessage, 'The quote comes after the Charm’s last word');
    assert.match(quoteMessage.interactive.body.text, /^\*Quote from Moss & Stone Exterior Care\*/);
    assert.match(
      quoteMessage.interactive.body.text,
      /See the full quote: http:\/\/localhost:3100\/q\//,
    );
    assert.deepEqual(
      quoteMessage.interactive.action.buttons.map((button: any) => button.reply.id),
      [QUOTE.accept, QUOTE.question, QUOTE.decline],
    );
    assert.equal(
      quoteMessage.interactive.action.buttons[0].reply.title,
      quote.accept_label,
      'The button says what the quote records it said',
    );
    const [{ count: billed }] = await rows(
      'SELECT COUNT(*) AS count FROM quote_usage WHERE quote_id=?',
      [quote.id],
    );
    assert.equal(Number(billed), 0, 'Not until WhatsApp says it arrived');
    const [sentRow] = await rows('SELECT channel_message_id FROM live_quotes WHERE id=?', [
      quote.id,
    ]);
    assert.ok(sentRow.channel_message_id);

    // Meta says it was delivered, which is when it counts as seen.
    await post({
      statuses: [
        {
          id: sentRow.channel_message_id,
          status: 'delivered',
          timestamp: '1',
          recipient_id: sam.phone,
        },
      ],
    }).expect(200);
    const [seen] = await rows('SELECT seen_at FROM live_quotes WHERE id=?', [quote.id]);
    assert.ok(seen.seen_at);
    const usage = async () =>
      (await rows('SELECT fee_cents FROM quote_usage WHERE quote_id=?', [quote.id])).map((row) =>
        Number(row.fee_cents),
      );
    assert.deepEqual(await usage(), [200], 'Billed once it arrived');
    await post({
      statuses: [
        { id: sentRow.channel_message_id, status: 'read', timestamp: '2', recipient_id: sam.phone },
      ],
    }).expect(200);
    assert.deepEqual(await usage(), [200], 'And only once');

    // 4. A question after the quote goes to the owner, and the customer hears that once.
    replies = await says(sam, tap(QUOTE.question, 'Ask a question'));
    assert.match(
      replies[0].text.body,
      /^Sure, what would you like to know\? I’ll pass it on to Maya at Moss & Stone Exterior Care\./,
    );
    replies = await says(sam, text('Can you also do the front path?'));
    assert.deepEqual(
      replies.map((reply) => reply.text.body),
      ['I’ve passed that on to Maya at Moss & Stone Exterior Care. They’ll reply to you here.'],
    );
    replies = await says(sam, text('It’s about 30 feet.'));
    assert.deepEqual(replies, [], 'Said once is enough');
    const keys = async () =>
      (await rows('SELECT dedupe_key FROM email_outbox WHERE business_id=?', [businessId])).map(
        (email) => String(email.dedupe_key),
      );
    assert.ok((await keys()).some((key) => key.startsWith(`owner-message:${chat.id}:`)));

    // The owner answers from PriceCharm, and it goes out on WhatsApp under their name.
    await owner
      .post(`/api/v1/app/quotes/${quote.id}/messages`)
      .set('Origin', origin)
      .send({ text: 'Sure, add $40 for the path.' })
      .expect(200);
    await deliverWaiting();
    assert.equal(
      sent.at(-1)?.text.body,
      '*Maya at Moss & Stone Exterior Care*\nSure, add $40 for the path.',
    );

    // 5. The yes is a tap. It's recorded as on the chat page, and the owner hears about it.
    replies = await says(sam, tap(QUOTE.accept, String(quote.accept_label)));
    const [accepted] = await rows('SELECT status FROM live_quotes WHERE id=?', [quote.id]);
    assert.equal(accepted.status, 'accepted');
    assert.equal(replies.length, 2);
    assert.match(replies[0].text.body, /Maya at Moss & Stone Exterior Care will be in touch/);
    assert.match(replies[1].text.body, /What’s the street address for the job\?/);
    assert.ok((await keys()).includes(`owner-accepted:${chat.id}:once`));
    // There's no form on WhatsApp, so the address comes as their next message. It's kept for the
    // owner and stays out of the chat, where the AI could read it.
    replies = await says(sam, text('Can you come in the morning?'));
    assert.equal(
      (await rows('SELECT job_address FROM lead_chats WHERE id=?', [chat.id]))[0].job_address,
      null,
      'A question isn’t an address',
    );
    replies = await says(sam, text('41 Linden Avenue, Portland'));
    const [addressed] = await rows('SELECT job_address FROM lead_chats WHERE id=?', [chat.id]);
    assert.equal(addressed.job_address, '41 Linden Avenue, Portland');
    assert.match(replies[0].text.body, /has it now/);
    const kept = await rows('SELECT text FROM lead_messages WHERE chat_id=?', [chat.id]);
    assert.ok(!kept.some((message) => String(message.text).includes('Linden')));
    assert.ok((await keys()).includes(`owner-address:${chat.id}:once`));

    // A day after the customer last wrote, WhatsApp won't deliver, so the owner hears that now
    // instead of the message quietly never arriving.
    await mutate(
      'UPDATE lead_chats SET last_inbound_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 2 DAY) WHERE id=?',
      [chat.id],
    );
    const late = await owner
      .post(`/api/v1/app/quotes/${quote.id}/messages`)
      .set('Origin', origin)
      .send({ text: 'Still keen?' });
    assert.equal(late.status, 409);
    assert.match(late.body.error.message, /Call or text them at \+16505551234\.$/);

    // A second customer sends a photo with their details. It's saved like one from the quote link
    // and the quote follows. Turning it down asks why, as the web does, and records the reason.
    const lee = { phone: '16505559876', userId: 'US.2001', name: 'Lee Park' };
    await says(lee, text('Driveways'));
    replies = await says(lee, {
      type: 'image',
      image: { id: 'media-photo', mime_type: 'image/jpeg', caption: 'About 600 sq ft, two cars.' },
    });
    const [leeChat] = await rows('SELECT id FROM lead_chats WHERE channel_user_id=?', [lee.userId]);
    const [{ count: photos }] = await rows(
      'SELECT COUNT(*) AS count FROM attachments WHERE conversation_id=?',
      [leeChat.id],
    );
    assert.equal(Number(photos), 1);
    assert.ok(
      replies.some((reply) => reply.type === 'interactive'),
      'The quote came',
    );
    replies = await says(lee, tap(QUOTE.decline, 'Not going ahead'));
    assert.equal(replies[0].interactive.type, 'list');
    assert.deepEqual(
      replies[0].interactive.action.sections[0].rows.map((row: any) => row.id),
      ['price', 'someone_else', 'timing', 'not_now', 'other'].map((reason) => `${REASON}${reason}`),
    );
    await says(lee, {
      type: 'interactive',
      interactive: {
        type: 'list_reply',
        list_reply: { id: `${REASON}someone_else`, title: 'Went with someone else' },
      },
    });
    const [lost] = await rows('SELECT status,outcome_reason FROM live_quotes WHERE chat_id=?', [
      leeChat.id,
    ]);
    assert.deepEqual({ ...lost }, { status: 'lost', outcome_reason: 'someone_else' });

    // Once Lee turned it down, writing again starts a new request.
    await says(lee, text('Actually, can you do the house too?'));
    const [{ count: leeChats }] = await rows(
      'SELECT COUNT(*) AS count FROM lead_chats WHERE channel_user_id=?',
      [lee.userId],
    );
    assert.equal(Number(leeChats), 2);

    // A webhook Meta delivers twice is answered once.
    const before = sent.length;
    const repeat = {
      contacts: [{ profile: { name: lee.name }, wa_id: lee.phone, user_id: lee.userId }],
      messages: [
        {
          from: lee.phone,
          from_user_id: lee.userId,
          id: `wamid.in-${messageNumber}`,
          timestamp: String(Math.floor(Date.now() / 1000)),
          ...text('Actually, can you do the house too?'),
        },
      ],
    };
    await post(repeat).expect(200);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(sent.length, before);

    // The owner trying their own line from their phone is a test, never billed or emailed.
    const maya = { phone: '16505557777', userId: 'US.4001', name: 'Maya Lopez' };
    await says(maya, text('Driveways'));
    const [mayaChat] = await rows('SELECT source FROM lead_chats WHERE channel_user_id=?', [
      maya.userId,
    ]);
    assert.equal(mayaChat.source, 'test');

    // When the owner pauses their Charm, it stops answering here too.
    await mutate('UPDATE businesses SET link_on=FALSE WHERE id=?', [businessId]);
    const quiet = { phone: '16505550000', userId: 'US.3001', name: 'Quinn' };
    assert.deepEqual(
      await waitSkipped(
        await post({
          contacts: [{ profile: { name: quiet.name }, wa_id: quiet.phone, user_id: quiet.userId }],
          messages: [
            {
              from: quiet.phone,
              from_user_id: quiet.userId,
              id: 'wamid.quiet',
              timestamp: '1',
              ...text('Hi'),
            },
          ],
        }),
      ),
      [],
    );

    // The owner connects the business's own number in Settings, through Meta's sign-up.
    process.env.META_APP_ID = '10001';
    process.env.WHATSAPP_SIGNUP_CONFIG_ID = 'config-1';
    await mutate('UPDATE businesses SET link_on=TRUE,auto_send=FALSE WHERE id=?', [businessId]);
    const settings = (await owner.get('/api/v1/app/whatsapp').expect(200)).body.data;
    assert.deepEqual(settings.signup, {
      appId: '10001',
      configId: 'config-1',
      graphVersion: 'v26.0',
    });
    const connected = await owner
      .post('/api/v1/app/whatsapp')
      .set('Origin', origin)
      .send({ code: 'signup-code-123', wabaId: '20000', phoneNumberId: '22222' });
    assert.equal(connected.status, 200, JSON.stringify(connected.body));
    assert.deepEqual(connected.body.data.connected, { number: '+1 555-000-2222' });
    assert.deepEqual(accountCalls, ['register 6', 'POST subscribed_apps']);
    assert.equal(templates[0]?.name, 'pricecharm_quote_ready');
    assert.equal(templates[0]?.category, 'UTILITY');
    const [own] = await rows(
      "SELECT token_ciphertext,waba_id,status FROM channel_accounts WHERE platform_id='22222'",
    );
    assert.equal(own.waba_id, '20000');
    assert.ok(!String(own.token_ciphertext).includes('business-token'), 'Its key is kept sealed');
    const [testLine] = await rows('SELECT status FROM channel_accounts WHERE id=?', [accountId]);
    assert.equal(testLine.status, 'off', 'One number per business');

    // A customer writes to it. The Charm answers with the business's own key, and a quote the owner
    // sends two days later goes out on the template, since WhatsApp allows nothing else by then.
    const kim = { phone: '16505554444', userId: 'US.5001', name: 'Kim Lee' };
    const toOwn = async (message: object) => {
      const id = `wamid.in-${++messageNumber}`;
      await post({
        metadata: { display_phone_number: '15550002222', phone_number_id: '22222' },
        contacts: [{ profile: { name: kim.name }, wa_id: kim.phone, user_id: kim.userId }],
        messages: [{ from: kim.phone, from_user_id: kim.userId, id, timestamp: '1', ...message }],
      }).expect(200);
      await answered(id, kim.userId);
    };
    // Only Kim's: earlier customers' chats can still be finishing in the background, and anything
    // they send now goes out on this number too.
    const toKim = () => ownSent.filter((body) => body.to === kim.phone);
    await toOwn(text('Driveways'));
    assert.match(toKim()[0]?.text?.body ?? '', /^\[Demo\] Hi Kim! I’m the quote assistant/);
    await toOwn(text('About 600 sq ft, two cars.'));
    await toOwn(tap(`${CHIP}Skip photos`, 'Skip photos'));
    const [kimChat] = await rows('SELECT id FROM lead_chats WHERE channel_user_id=?', [kim.userId]);
    const [held] = await rows('SELECT id,status FROM live_quotes WHERE chat_id=?', [kimChat.id]);
    assert.equal(held.status, 'review', 'Waiting for the owner, who checks each quote');
    await mutate(
      'UPDATE lead_chats SET last_inbound_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 2 DAY) WHERE id=?',
      [kimChat.id],
    );
    await owner
      .post(`/api/v1/app/quotes/${held.id}/approve`)
      .set('Origin', origin)
      .send({})
      .expect(200);
    await deliverWaiting();
    const templated = toKim().at(-1);
    assert.equal(templated?.type, 'template');
    assert.equal(templated?.template.name, 'pricecharm_quote_ready');
    assert.deepEqual(
      templated?.template.components[0].parameters
        .map((parameter: { text: string }) => parameter.text)
        .slice(0, 2),
      ['Kim', 'Moss & Stone Exterior Care'],
    );
    assert.match(
      templated?.template.components[0].parameters[2].text,
      /^http:\/\/localhost:3100\/q\//,
    );

    // Disconnecting stops its messages coming to PriceCharm and drops the key.
    const off = await owner.delete('/api/v1/app/whatsapp').set('Origin', origin).expect(200);
    assert.equal(off.body.data.connected, null);
    assert.equal(accountCalls.at(-1), 'DELETE subscribed_apps');
    const [gone] = await rows(
      "SELECT status,token_ciphertext FROM channel_accounts WHERE platform_id='22222'",
    );
    assert.deepEqual([gone.status, gone.token_ciphertext], ['off', null]);
    delete process.env.META_APP_ID;
    delete process.env.WHATSAPP_SIGNUP_CONFIG_ID;

    async function waitSkipped(response: request.Response) {
      assert.equal(response.status, 200);
      const start = sent.length;
      for (let tries = 0; tries < 100; tries++) {
        const [inbox] = await rows(
          "SELECT status FROM channel_inbox WHERE platform_message_id='wamid.quiet'",
        );
        if (inbox?.status === 'skipped') return sent.slice(start);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.fail('The paused business still took the message');
    }
  },
);
