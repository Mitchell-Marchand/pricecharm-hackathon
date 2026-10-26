import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { closeDatabase, rows } from '../src/db.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const origin = 'http://localhost:3100';
after(() => closeDatabase());

test(
  'customers chat, confirm their email and get a quote; the owner approves anything unusual',
  { skip: !enabled },
  async () => {
    process.env.UPLOAD_DIR ??= await fs.mkdtemp(path.join(os.tmpdir(), 'quotefolk-live-'));
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
      for (const priceCents of [25000, 27500, 30000])
        await owner
          .post('/api/v1/onboarding/jobs')
          .set('Origin', origin)
          .send({
            serviceName: 'Driveways',
            description: 'Two-car driveway wash.',
            priceCents,
            size: '600 sq ft',
          })
          .expect(201);
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

    async function reachQuote(slug: string, agent?: ReturnType<typeof request.agent>) {
      const customer = await chat(slug, agent);
      let view = (await customer.call('post', '/messages', { text: 'Driveways' })).body.data;
      assert.match(view.messages.at(-1).text, /\[Demo\]/);
      view = (await customer.call('post', '/messages', { text: 'About 600 sq ft, two cars.' })).body
        .data;
      assert.deepEqual(view.messages.at(-1).chips, ['Skip photos']);
      view = (await customer.call('post', '/messages', { text: 'Skip photos' })).body.data;
      assert.equal(
        view.status,
        'contact',
        'Once it has the details, it asks where to send the quote',
      );
      const contact = await customer.call('post', '/contact', {
        name: 'Sam Kim',
        email: `sam-${randomUUID()}@example.test`,
      });
      assert.equal(contact.status, 200, JSON.stringify(contact.body));
      return { customer, contact: contact.body.data };
    }

    // 0. No payment method yet: even an automatic quote waits, and the owner is told why.
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

    // The shop sets up billing the way an owner does: confirm the email, then add a card.
    const verification = await shop.owner
      .post('/api/v1/auth/request-verification')
      .set('Origin', origin)
      .send({})
      .expect(200);
    await shop.owner
      .post('/api/v1/auth/verify-email')
      .set('Origin', origin)
      .send({ token: verification.body.data.devToken })
      .expect(200);
    await shop.owner.post('/api/v1/billing/checkout').set('Origin', origin).send({}).expect(200);

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
        fee_cents: 275,
      },
      '1% of the $275 quote, from the first one',
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

    // 2. Automatic quotes off: the quote waits for the owner, who edits and sends it.
    await shop.owner
      .patch('/api/v1/app/settings')
      .set('Origin', origin)
      .send({ autoSend: false })
      .expect(200);
    const held = await reachQuote(shop.slug);
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
    assert.ok(
      detail.checks.some(
        (check: { id: string; passed: boolean }) => check.id === 'auto' && !check.passed,
      ),
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
  },
);
