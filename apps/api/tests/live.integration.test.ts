import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { closeDatabase, mutate, rows } from '../src/db.js';
import { json } from '../src/models.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const origin = 'http://localhost:3100';
after(() => closeDatabase());

test(
  'customers chat, confirm their email and get a quote; the owner approves anything unusual',
  { skip: !enabled },
  async () => {
    process.env.UPLOAD_DIR ??= await fs.mkdtemp(path.join(os.tmpdir(), 'pricecharm-live-'));
    const { createApp } = await import('../src/app.js');
    const { decryptEmail } = await import('../src/integrations/email.js');
    const app = createApp();

    async function business(name: string) {
      const owner = request.agent(app);
      await owner.post('/api/v1/onboarding/start').set('Origin', origin).send({}).expect(201);
      await owner
        .patch('/api/v1/onboarding/business')
        .set('Origin', origin)
        .send({
          tradeId: 'pressure-washing',
          services: ['Driveways', 'House wash'],
          name,
          area: 'Portland, OR',
        })
        .expect(200);
      const jobIds: string[] = [];
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
        jobIds.push(String(job.body.data.id));
      }
      // Two practice driveways where its guess matched the owner's, so Driveways is learned.
      const [{ business_id: draftId }] = await rows(
        'SELECT business_id FROM past_jobs WHERE id=?',
        [jobIds[0]],
      );
      for (const position of [0, 1]) {
        const lines = [{ id: 'a', label: 'Driveway wash', amountCents: 27500 }];
        await mutate(
          `INSERT INTO practice_runs (id,business_id,position,status,scenario_json,outcome,quote_json,shadow_json,finished_at)
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
          email: `qa-live-${randomUUID()}@example.test`,
          password: 'test password strong123',
        });
      assert.equal(signup.status, 201, JSON.stringify(signup.body));
      const [created] = await rows('SELECT auto_send FROM businesses WHERE id=?', [draftId]);
      assert.equal(Boolean(created.auto_send), true, 'The Charm quotes on its own from signup');
      return {
        owner,
        id: String(signup.body.data.business.id),
        slug: String(signup.body.data.business.slug),
      };
    }
    const shop = await business('Moss & Stone Exterior Care');
    const rival = await business('Other Washers');

    async function chat(slug: string, agent = request.agent(app)) {
      const profile = await agent.get(`/api/v1/chat/${slug}`);
      assert.equal(profile.status, 200);
      assert.deepEqual(profile.body.data.services, ['Driveways', 'House wash']);
      assert.equal(profile.body.data.ownerFirstName, 'Maya');
      const started = await agent.post(`/api/v1/chat/${slug}/start`).set('Origin', origin).send({});
      assert.equal(started.status, 201, JSON.stringify(started.body));
      const token = started.body.data.token as string;
      const id = started.body.data.chat.id as string;
      assert.deepEqual(started.body.data.chat.messages[0].chips, ['Driveways', 'House wash']);
      const base = `/api/v1/chat/${slug}/${id}`;
      const call = (method: 'get' | 'post', suffix: string, body?: object) =>
        agent[method](`${base}${suffix}`)
          .set('Origin', origin)
          .set('Authorization', `Bearer ${token}`)
          .send(body);
      return { id, token, base, call, test: started.body.data.chat.test as boolean };
    }

    async function reachQuote(
      slug: string,
      agent?: ReturnType<typeof request.agent>,
      job = { service: 'Driveways', size: 'About 600 sq ft, two cars.' },
      email = `sam-${randomUUID()}@example.test`,
    ) {
      const customer = await chat(slug, agent);
      let view = (await customer.call('post', '/messages', { text: job.service })).body.data;
      assert.match(view.messages.at(-1).text, /\[Demo\]/);
      view = (await customer.call('post', '/messages', { text: job.size })).body.data;
      assert.deepEqual(view.messages.at(-1).chips, ['Skip photos']);
      view = (await customer.call('post', '/messages', { text: 'Skip photos' })).body.data;
      assert.equal(
        view.status,
        'contact',
        'Once it has the details, it asks where to send the quote',
      );
      const contact = await customer.call('post', '/contact', {
        name: 'Sam Kim',
        email,
      });
      assert.equal(contact.status, 200, JSON.stringify(contact.body));
      return { customer, contact: contact.body.data, email };
    }

    // Going live the way an owner does: a plan, a card, then deploying. No email check first.
    async function goLive(owner: ReturnType<typeof request.agent>, plan = 'per_quote') {
      await owner.post('/api/v1/app/billing/plan').set('Origin', origin).send({ plan }).expect(200);
      await owner.post('/api/v1/billing/checkout').set('Origin', origin).send({}).expect(200);
      await owner.post('/api/v1/app/deploy').set('Origin', origin).send({}).expect(200);
    }

    // 0. The card stops working after going live: even an automatic quote waits, and the owner
    // is told why.
    await goLive(rival.owner);
    await mutate("UPDATE billing_accounts SET subscription_status='past_due' WHERE business_id=?", [
      rival.id,
    ]);
    await rival.owner
      .patch('/api/v1/app/settings')
      .set('Origin', origin)
      .send({ autoSend: true })
      .expect(200);
    const unpaid = await reachQuote(rival.slug);
    const unpaidView = await unpaid.customer.call('post', '/verify', {
      verificationId: unpaid.contact.verificationId,
      code: unpaid.contact.devCode,
    });
    assert.equal(unpaidView.body.data.waitingForOwner, true);
    const [unpaidQuote] = await rows('SELECT id,review_reason FROM live_quotes WHERE chat_id=?', [
      unpaid.customer.id,
    ]);
    assert.match(unpaidQuote.review_reason, /Add a payment method/);
    const [alert] = await rows('SELECT payload_encrypted FROM email_outbox WHERE dedupe_key=?', [
      `owner-review:${unpaid.customer.id}:once`,
    ]);
    assert.match(decryptEmail(alert.payload_encrypted).text, /Why it’s waiting: Add a payment/);
    const blocked = await rival.owner
      .post(`/api/v1/app/quotes/${unpaidQuote.id}/approve`)
      .set('Origin', origin)
      .send({});
    assert.equal(blocked.body.error?.code, 'BILLING_LIMIT', 'Approving needs billing too');
    const approveLink = (text: string) => {
      const found = /\/approve\/([0-9a-f-]{36})#token=([A-Za-z0-9_-]{43})/.exec(text);
      assert.ok(found, text);
      return { id: found[1], token: found[2] };
    };
    const unpaidLink = approveLink(decryptEmail(alert.payload_encrypted).text);
    const blockedTap = await request(app)
      .post(`/api/v1/approve/${unpaidLink.id}`)
      .set('Origin', origin)
      .send({ token: unpaidLink.token });
    assert.equal(
      blockedTap.body.error?.code,
      'BILLING_LIMIT',
      'The email’s link needs billing too',
    );

    await goLive(shop.owner);

    // 1. Automatic quotes on: the quote goes out as soon as the email is confirmed.
    await shop.owner
      .patch('/api/v1/app/settings')
      .set('Origin', origin)
      .send({ autoSend: true })
      .expect(200);
    const automatic = await reachQuote(shop.slug);
    assert.ok(automatic.contact.verificationId);
    const wrong = await automatic.customer.call('post', '/verify', {
      verificationId: automatic.contact.verificationId,
      code: '000000' === automatic.contact.devCode ? '111111' : '000000',
    });
    assert.equal(wrong.status, 400);
    const sent = await automatic.customer.call('post', '/verify', {
      verificationId: automatic.contact.verificationId,
      code: automatic.contact.devCode,
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.data.status, 'sent');
    assert.equal(sent.body.data.quote.card.customer, 'Sam K.');
    assert.equal(
      sent.body.data.quote.card.lines[0].amountCents,
      27500,
      'Priced from similar past jobs',
    );
    const [usage] = await rows(
      'SELECT source,trial_covered,fee_cents FROM quote_usage WHERE quote_id=?',
      [sent.body.data.quote.id],
    );
    assert.deepEqual(
      { ...usage, trial_covered: Boolean(usage.trial_covered), fee_cents: Number(usage.fee_cents) },
      {
        source: 'live_auto',
        trial_covered: false,
        fee_cents: 200,
      },
      '$2 for the quote on the per-quote plan, from the first one',
    );
    const emails = await rows(
      'SELECT dedupe_key,payload_encrypted FROM email_outbox WHERE business_id=? ORDER BY created_at',
      [shop.id],
    );
    const keys = emails.map((email) => String(email.dedupe_key));
    assert.ok(
      keys.includes(`live-quote:${automatic.customer.id}:customer`),
      'The customer gets the quote',
    );
    assert.ok(
      keys.includes(`owner-sent:${automatic.customer.id}:once`),
      'The owner hears about it',
    );
    const customerEmail = decryptEmail(
      emails.find((email) => email.dedupe_key === `live-quote:${automatic.customer.id}:customer`)!
        .payload_encrypted,
    );
    const link = new URL(customerEmail.text.match(/https?:\/\/\S+/)![0]);
    const linkParams = new URLSearchParams(link.hash.slice(1));
    assert.equal(linkParams.get('chat'), automatic.customer.id);
    const viaEmail = await request(app)
      .get(automatic.customer.base)
      .set('Authorization', `Bearer ${linkParams.get('token')}`);
    assert.equal(viaEmail.status, 200, 'The emailed link opens the quote');
    const [autoQuote] = await rows('SELECT id FROM live_quotes WHERE chat_id=?', [
      automatic.customer.id,
    ]);
    await shop.owner
      .post(`/api/v1/app/quotes/${autoQuote.id}/messages`)
      .set('Origin', origin)
      .send({ text: 'Can you move the cars before we arrive?' })
      .expect(200);
    const afterReply = await request(app)
      .get(automatic.customer.base)
      .set('Authorization', `Bearer ${linkParams.get('token')}`);
    assert.equal(afterReply.status, 200, 'A later email keeps the quote email’s link working');
    const accepted = await automatic.customer.call('post', '/accept');
    assert.equal(accepted.body.data.status, 'accepted');
    assert.equal(
      (await automatic.customer.call('post', '/accept')).status,
      409,
      'A quote is accepted once',
    );

    // 2. Automatic quotes off: the quote waits for the owner, who edits and sends it. It's from the
    // email that just got a quote, which holds it too, so one address can't run up their bill.
    await shop.owner
      .patch('/api/v1/app/settings')
      .set('Origin', origin)
      .send({ autoSend: false })
      .expect(200);
    const held = await reachQuote(shop.slug, undefined, undefined, automatic.email);
    const waiting = await held.customer.call('post', '/verify', {
      verificationId: held.contact.verificationId,
      code: held.contact.devCode,
    });
    assert.equal(waiting.body.data.waitingForOwner, true);
    assert.equal(
      waiting.body.data.quote,
      null,
      'The customer sees no price until the owner approves',
    );
    const home = (await shop.owner.get('/api/v1/app/home')).body.data;
    assert.equal(home.counts.needsOk, 1);
    assert.match(home.waiting[0].reviewReason, /You approve each quote for now/);
    const [listed] = (await shop.owner.get('/api/v1/app/quotes?filter=review')).body.data;
    const detail = (await shop.owner.get(`/api/v1/app/quotes/${listed.id}`)).body.data;
    assert.equal(detail.customer, 'Sam Kim');
    assert.deepEqual(
      detail.checks
        .filter((check: { passed: boolean }) => !check.passed)
        .map((check: { id: string }) => check.id),
      ['auto', 'repeat'],
    );
    assert.match(home.waiting[0].reviewReason, /already got a quote from you in the last week/);
    assert.equal(
      (await rows('SELECT id FROM quote_usage WHERE quote_id=?', [listed.id])).length,
      0,
      'Nothing is billed while it waits',
    );
    assert.equal((await rival.owner.get(`/api/v1/app/quotes/${listed.id}`)).status, 404);
    const approved = await shop.owner
      .post(`/api/v1/app/quotes/${listed.id}/approve`)
      .set('Origin', origin)
      .send({
        card: {
          ...detail.card,
          lines: [{ id: 'l0', label: 'Driveway wash, two cars', amountCents: 26000 }],
          discount: null,
        },
      });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.data.status, 'sent');
    assert.equal(approved.body.data.totalCents, 26000);
    const customerView = (await held.customer.call('get', '')).body.data;
    assert.equal(customerView.quote.card.lines[0].amountCents, 26000);
    const [ownerUsage] = await rows('SELECT source FROM quote_usage WHERE quote_id=?', [listed.id]);
    assert.equal(ownerUsage.source, 'live_owner', 'Owner-approved quotes count too');
    assert.equal(
      (
        await shop.owner
          .post(`/api/v1/app/quotes/${listed.id}/approve`)
          .set('Origin', origin)
          .send({})
      ).status,
      409,
    );

    // 3. The owner trying their own link: no code, no bill, no emails.
    const before = (
      await rows('SELECT COUNT(*) AS count FROM email_outbox WHERE business_id=?', [shop.id])
    )[0].count;
    const trial = await reachQuote(shop.slug, shop.owner);
    assert.equal(trial.contact.verificationId, null);
    assert.equal(trial.contact.chat.test, true);
    assert.equal(trial.contact.chat.waitingForOwner, true);
    assert.ok(trial.contact.chat.quote, 'The owner sees the quote their Charm drafted');
    assert.deepEqual(
      trial.contact.chat.wouldWait.map((check: { id: string }) => check.id),
      ['auto'],
      'And why a real customer would wait for it',
    );
    const [trialQuote] = await rows('SELECT id FROM live_quotes WHERE chat_id=?', [
      trial.customer.id,
    ]);
    await shop.owner
      .post(`/api/v1/app/quotes/${trialQuote.id}/approve`)
      .set('Origin', origin)
      .send({})
      .expect(200);
    assert.equal(
      (await rows('SELECT id FROM quote_usage WHERE quote_id=?', [trialQuote.id])).length,
      0,
    );
    const afterCount = (
      await rows('SELECT COUNT(*) AS count FROM email_outbox WHERE business_id=?', [shop.id])
    )[0].count;
    assert.equal(Number(afterCount), Number(before), 'Tests send no email');
    const listedTests = (await shop.owner.get('/api/v1/app/quotes')).body.data.filter(
      (item: { test: boolean }) => item.test,
    );
    assert.equal(listedTests.length, 1);

    // 4. Automatic quotes on: a size it hasn't priced waits, and a service it's still learning goes
    // out as a price range.
    await shop.owner
      .patch('/api/v1/app/settings')
      .set('Origin', origin)
      .send({ autoSend: true })
      .expect(200);
    let lastReached: Awaited<ReturnType<typeof reachQuote>> | null = null;
    async function waitsBecause(job: { service: string; size: string }) {
      const reached = await reachQuote(shop.slug, undefined, job);
      lastReached = reached;
      const view = await reached.customer.call('post', '/verify', {
        verificationId: reached.contact.verificationId,
        code: reached.contact.devCode,
      });
      assert.equal(view.body.data.waitingForOwner, true, job.size);
      const [quote] = await rows('SELECT checks_json FROM live_quotes WHERE chat_id=?', [
        reached.customer.id,
      ]);
      return json<{ id: string; passed: boolean; detail: string }[]>(quote.checks_json, []);
    }
    const big = await waitsBecause({ service: 'Driveways', size: 'About 2,000 sq ft.' });
    const bigRequest = lastReached!;
    const bigChat = bigRequest.customer.id;
    assert.deepEqual(
      big.filter((check) => !check.passed).map((check) => check.id),
      ['range', 'size'],
      'Only things about the job hold it, never how trained the Charm is',
    );
    assert.match(
      big.find((check) => check.id === 'size')?.detail ?? '',
      /much bigger than the Driveways jobs you’ve priced, which go up to 600 sq ft/,
    );
    const learning = await reachQuote(shop.slug, undefined, {
      service: 'House wash',
      size: 'About 2,000 sq ft.',
    });
    const ranged = (
      await learning.customer.call('post', '/verify', {
        verificationId: learning.contact.verificationId,
        code: learning.contact.devCode,
      })
    ).body.data;
    assert.equal(ranged.status, 'sent', 'A service with no jobs yet still gets a quote');
    const { style, range } = ranged.quote.card;
    const [rangedQuote] = await rows('SELECT total_cents FROM live_quotes WHERE chat_id=?', [
      learning.customer.id,
    ]);
    assert.equal(style, 'range');
    assert.ok(
      range.lowCents < Number(rangedQuote.total_cents) &&
        range.highCents > Number(rangedQuote.total_cents),
      JSON.stringify(range),
    );
    const [rangeEmail] = await rows(
      'SELECT payload_encrypted FROM email_outbox WHERE dedupe_key=?',
      [`live-quote:${learning.customer.id}:customer`],
    );
    assert.match(
      decryptEmail(rangeEmail.payload_encrypted).text,
      /for \$\d+ to \$\d+\./,
      'The email quotes the range',
    );
    const firm = (await shop.owner.get('/api/v1/app/quotes?filter=all')).body.data.find(
      (item: { id: string }) => item.id === sent.body.data.quote.id,
    );
    assert.equal(firm.range, null, 'A trained service quotes a firm price');

    // 5. The "needs your OK" email opens that one quote with an Approve button, no sign-in.
    const [tappedQuote] = await rows('SELECT id,total_cents FROM live_quotes WHERE chat_id=?', [
      bigChat,
    ]);
    const [tapEmail] = await rows('SELECT payload_encrypted FROM email_outbox WHERE dedupe_key=?', [
      `owner-review:${bigChat}:once`,
    ]);
    const emailText = decryptEmail(tapEmail.payload_encrypted).text;
    assert.match(
      emailText,
      /Approve it as it is, no sign-in needed \(this link works for 3 days\)/,
    );
    const tapLink = approveLink(emailText);
    assert.equal(tapLink.id, tappedQuote.id);
    const passerby = request.agent(app);
    const tap = (path: string, body: object) =>
      passerby.post(`/api/v1/approve/${path}`).set('Origin', origin).send(body);
    const shown = await tap(`${tapLink.id}/view`, { token: tapLink.token });
    assert.equal(shown.status, 200, JSON.stringify(shown.body));
    assert.equal(shown.body.data.status, 'waiting');
    assert.equal(shown.body.data.customer, 'Sam');
    assert.equal(shown.body.data.totalCents, Number(tappedQuote.total_cents));
    assert.ok(
      shown.body.data.reasons.some((reason: string) => /much bigger/.test(reason)),
      'It says why it waited',
    );
    assert.ok(!JSON.stringify(shown.body).includes('@example.test'), 'No contact details');
    const otherToken = tapLink.token.replace(/^./, (first) => (first === 'A' ? 'B' : 'A'));
    assert.equal((await tap(`${tapLink.id}/view`, { token: otherToken })).status, 404);
    assert.equal(
      (await tap(`${listed.id}/view`, { token: tapLink.token })).status,
      404,
      'Only the quote it was sent for',
    );
    assert.equal(
      (await tap(tapLink.id, { token: tapLink.token, card: { lines: [] } })).status,
      400,
      'It can only send it as it is',
    );
    await mutate(
      'UPDATE live_quotes SET approve_token_expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 MINUTE) WHERE id=?',
      [tapLink.id],
    );
    assert.equal(
      (await tap(tapLink.id, { token: tapLink.token })).body.error?.code,
      'LINK_EXPIRED',
    );
    await mutate(
      'UPDATE live_quotes SET approve_token_expires_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 DAY) WHERE id=?',
      [tapLink.id],
    );
    const tappedSent = await tap(tapLink.id, { token: tapLink.token });
    assert.equal(tappedSent.status, 200, JSON.stringify(tappedSent.body));
    assert.equal(tappedSent.body.data.status, 'sent');
    const [tappedUsage] = await rows('SELECT source FROM quote_usage WHERE quote_id=?', [
      tapLink.id,
    ]);
    assert.equal(tappedUsage.source, 'live_owner', 'Billed like any quote the owner approves');
    assert.equal((await bigRequest.customer.call('get', '')).body.data.status, 'sent');
    assert.equal(
      (await tap(tapLink.id, { token: tapLink.token })).body.error?.code,
      'QUOTE_NOT_WAITING',
      'Once sent, a second tap does nothing',
    );
  },
);
