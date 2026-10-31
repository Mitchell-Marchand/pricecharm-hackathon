import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import request from 'supertest';
import { closeDatabase, mutate, rows } from '../src/db.js';
import { json } from '../src/models.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const origin = 'http://localhost:3100';
after(() => closeDatabase());

test(
  'customers chat and see their quote, leave their details to say yes; the owner approves anything unusual',
  { skip: !enabled },
  async () => {
    process.env.UPLOAD_DIR ??= await fs.mkdtemp(path.join(os.tmpdir(), 'pricecharm-live-'));
    // Each customer comes from their own address, as they would, so the chat's per-address
    // limits don't run out across this many requests.
    process.env.TRUST_PROXY = '1';
    let visitor = 0;
    const customerAgent = () =>
      request.agent(app).set('X-Forwarded-For', `198.51.100.${++visitor}`);
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

    async function chat(slug: string, agent = customerAgent()) {
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

    /** Describes a job. With nothing to check first, the quote comes back with the last answer. */
    async function reachQuote(
      slug: string,
      agent?: ReturnType<typeof request.agent>,
      job = { service: 'Driveways', size: 'About 600 sq ft, two cars.' },
    ) {
      const customer = await chat(slug, agent);
      let view = (await customer.call('post', '/messages', { text: job.service })).body.data;
      assert.match(view.messages.at(-1).text, /\[Demo\]/);
      view = (await customer.call('post', '/messages', { text: job.size })).body.data;
      assert.deepEqual(view.messages.at(-1).chips, ['Skip photos']);
      const last = await customer.call('post', '/messages', { text: 'Skip photos' });
      assert.equal(last.status, 200, JSON.stringify(last.body));
      return { customer, view: last.body.data };
    }
    const sam = () => ({ name: 'Sam Kim', email: `sam-${randomUUID()}@example.test` });
    const emailKeys = async (businessId: string) =>
      (await rows('SELECT dedupe_key FROM email_outbox WHERE business_id=?', [businessId])).map(
        (email) => String(email.dedupe_key),
      );

    // Going live the way an owner does: a plan, a card, then deploying. No email check first.
    async function goLive(owner: ReturnType<typeof request.agent>, plan = 'per_quote') {
      await owner.post('/api/v1/app/billing/plan').set('Origin', origin).send({ plan }).expect(200);
      await owner.post('/api/v1/billing/checkout').set('Origin', origin).send({}).expect(200);
      await owner.post('/api/v1/app/deploy').set('Origin', origin).send({}).expect(200);
    }

    // 0. The card stops working after going live: even an automatic quote waits, and the owner
    // is told why once the customer says where to send it.
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
    assert.equal(unpaid.view.status, 'contact', 'A quote that waits needs somewhere to go');
    assert.equal(unpaid.view.waitingForOwner, true);
    assert.equal(unpaid.view.quote, null);
    assert.match(unpaid.view.messages.at(-1).text, /Where should they send it\?$/);
    assert.ok(
      !(await emailKeys(rival.id)).includes(`owner-review:${unpaid.customer.id}:once`),
      'The owner isn’t asked about a request nobody can be sent',
    );
    assert.equal(
      (await rival.owner.get('/api/v1/app/home')).body.data.counts.needsOk,
      0,
      'Nor does it wait in their quotes yet',
    );
    const unpaidView = await unpaid.customer.call('post', '/contact', sam());
    assert.equal(unpaidView.status, 200, JSON.stringify(unpaidView.body));
    assert.equal(unpaidView.body.data.chat.status, 'review');
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

    // 1. Automatic quotes on: the quote shows as soon as the chat has the details, before any
    // contact details, and showing it is what's billed.
    await shop.owner
      .patch('/api/v1/app/settings')
      .set('Origin', origin)
      .send({ autoSend: true })
      .expect(200);
    const automatic = await reachQuote(shop.slug);
    assert.equal(automatic.view.status, 'sent');
    assert.equal(automatic.view.messages.at(-1).text, 'Here’s your quote.');
    assert.equal(automatic.view.quote.card.customer, '');
    assert.equal(
      automatic.view.quote.card.lines[0].amountCents,
      27500,
      'Priced from similar past jobs',
    );
    const ledger = (quoteId: string) =>
      rows('SELECT source,trial_covered,fee_cents FROM quote_usage WHERE quote_id=?', [quoteId]);
    const [usage] = await ledger(automatic.view.quote.id);
    assert.deepEqual(
      { ...usage, trial_covered: Boolean(usage.trial_covered), fee_cents: Number(usage.fee_cents) },
      { source: 'live_auto', trial_covered: false, fee_cents: 200 },
      '$2 on the per-quote plan once it shows, from the first one',
    );
    assert.ok(
      (await emailKeys(shop.id)).every((key) => !key.includes(automatic.customer.id)),
      'Nobody is emailed about a look',
    );
    const noDetails = await automatic.customer.call('post', '/accept');
    assert.equal(noDetails.body.error?.code, 'CONTACT_REQUIRED', 'A yes says how to reach them');
    assert.equal(
      (await automatic.customer.call('post', '/contact', { name: 'Sam Kim', phone: '555-0142' }))
        .body.error?.code,
      'EMAIL_REQUIRED',
      'A copy needs an email',
    );
    assert.equal(
      (await automatic.customer.call('post', '/contact', { name: 'Sam Kim', phone: '12' })).body
        .error?.code,
      'PHONE_INVALID',
    );

    // Asking for a copy puts the quote in their inbox and tells the owner it may be worth a
    // follow-up, with no second charge.
    const automaticEmail = sam().email;
    const copied = await automatic.customer.call('post', '/contact', {
      name: 'Sam Kim',
      email: automaticEmail,
    });
    assert.equal(copied.status, 200, JSON.stringify(copied.body));
    assert.equal(copied.body.data.chat.quote.card.customer, 'Sam K.');
    assert.equal(
      copied.body.data.chat.messages.at(-1).text,
      `Sent. A copy is on its way to ${automaticEmail}.`,
    );
    assert.equal((await ledger(automatic.view.quote.id)).length, 1, 'Billed once, when it showed');
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
      keys.includes(`owner-lead:${automatic.customer.id}:once`),
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
    assert.equal(accepted.body.data.status, 'accepted', 'Their details are already in');
    assert.equal(
      (await automatic.customer.call('post', '/accept')).status,
      409,
      'A quote is accepted once',
    );
    assert.equal((await ledger(autoQuote.id)).length, 1, 'And billed once');

    // A yes from someone who only looked: their name and a phone number come with it.
    const looked = await reachQuote(shop.slug);
    const yes = await looked.customer.call('post', '/accept', {
      name: 'Ana Ruiz',
      phone: '(503) 555-0142',
    });
    assert.equal(yes.status, 200, JSON.stringify(yes.body));
    assert.equal(yes.body.data.status, 'accepted');
    assert.equal(yes.body.data.contact.phone, '(503) 555-0142');
    assert.equal(Number((await ledger(looked.view.quote.id))[0].fee_cents), 200);
    const [yesEmail] = await rows('SELECT payload_encrypted FROM email_outbox WHERE dedupe_key=?', [
      `owner-accepted:${looked.customer.id}:once`,
    ]);
    assert.match(decryptEmail(yesEmail.payload_encrypted).text, /Phone: \(503\) 555-0142/);
    assert.ok(
      !(await emailKeys(shop.id)).includes(`live-quote:${looked.customer.id}:customer`),
      'No email to send a copy to',
    );
    // Each quote shown is billed, even to someone who had one this week.
    const again = await reachQuote(shop.slug);
    await again.customer
      .call('post', '/visit', { name: 'Ana Ruiz', phone: '503.555.0142' })
      .expect(200);
    assert.equal(Number((await ledger(again.view.quote.id))[0].fee_cents), 200);

    // 2. Automatic quotes off: the quote waits for the owner, who edits and sends it.
    await shop.owner
      .patch('/api/v1/app/settings')
      .set('Origin', origin)
      .send({ autoSend: false })
      .expect(200);
    const held = await reachQuote(shop.slug);
    assert.equal(held.view.status, 'contact');
    const waiting = await held.customer.call('post', '/contact', {
      name: 'Sam Kim',
      email: automaticEmail,
    });
    assert.equal(waiting.body.data.chat.waitingForOwner, true);
    assert.equal(
      waiting.body.data.chat.quote,
      null,
      'The customer sees no price until the owner approves',
    );
    assert.match(
      waiting.body.data.chat.messages.at(-1).text,
      /We’ll email you as soon as Maya sends it/,
    );
    // Reopening the chat shows no more: no quote, no reason it waits, no picture of it done.
    const reopened = (await held.customer.call('get', '')).body.data;
    assert.equal(reopened.quote, null, 'A held quote never reaches a real customer');
    assert.deepEqual(reopened.wouldWait, []);
    assert.equal((await held.customer.call('get', '/preview/before')).status, 404);
    const home = (await shop.owner.get('/api/v1/app/home')).body.data;
    assert.equal(home.counts.needsOk, 1);
    assert.match(home.waiting[0].reviewReason, /You approve each quote for now/);
    const [listed] = (await shop.owner.get('/api/v1/app/quotes?filter=review')).body.data;
    const detail = (await shop.owner.get(`/api/v1/app/quotes/${listed.id}`)).body.data;
    assert.equal(detail.customer, 'Sam Kim');
    assert.equal(detail.reachable, true);
    assert.deepEqual(
      detail.checks
        .filter((check: { passed: boolean }) => !check.passed)
        .map((check: { id: string }) => check.id),
      ['auto'],
    );
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
    const [ownerUsage] = await ledger(listed.id);
    assert.equal(ownerUsage.source, 'live_owner', 'Owner-approved quotes count too');
    assert.equal(Number(ownerUsage.fee_cents), 200, 'Billed once it shows');
    assert.equal(
      (
        await shop.owner
          .post(`/api/v1/app/quotes/${listed.id}/approve`)
          .set('Origin', origin)
          .send({})
      ).status,
      409,
    );

    // 3. The owner trying their own link: no bill, no emails, and the draft shows right away.
    const before = (
      await rows('SELECT COUNT(*) AS count FROM email_outbox WHERE business_id=?', [shop.id])
    )[0].count;
    const trial = await reachQuote(shop.slug, shop.owner);
    assert.equal(trial.view.test, true);
    assert.equal(trial.view.waitingForOwner, true);
    assert.ok(trial.view.quote, 'The owner sees the quote their Charm drafted');
    assert.match(
      trial.view.messages.at(-1).text,
      /will look this over and get back to you/,
      'And the chat says what a real customer would get',
    );
    assert.deepEqual(
      trial.view.wouldWait.map((check: { id: string }) => check.id),
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
    await trial.customer
      .call('post', '/accept', { name: 'Test Customer', email: 'test@example.test' })
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

    // 4. Automatic quotes on: a size it hasn't priced still goes out, as the widest range, and the
    // owner sees why. A service it's still learning goes out as a price range.
    await shop.owner
      .patch('/api/v1/app/settings')
      .set('Origin', origin)
      .send({ autoSend: true })
      .expect(200);
    let lastReached: Awaited<ReturnType<typeof reachQuote>> | null = null;
    async function waitsBecause(job: { service: string; size: string }) {
      const reached = await reachQuote(shop.slug, undefined, job);
      lastReached = reached;
      assert.equal(reached.view.waitingForOwner, true, job.size);
      await reached.customer.call('post', '/contact', sam()).expect(200);
      const [quote] = await rows('SELECT checks_json FROM live_quotes WHERE chat_id=?', [
        reached.customer.id,
      ]);
      return json<{ id: string; passed: boolean; detail: string }[]>(quote.checks_json, []);
    }
    const oversized = await reachQuote(shop.slug, undefined, {
      service: 'Driveways',
      size: 'About 2,000 sq ft.',
    });
    assert.equal(oversized.view.status, 'sent', 'A size it hasn’t priced still gets a price');
    assert.equal(oversized.view.quote.card.style, 'range');
    const [oversizedQuote] = await rows(
      'SELECT checks_json,total_cents FROM live_quotes WHERE chat_id=?',
      [oversized.customer.id],
    );
    const big = json<{ id: string; passed: boolean; detail: string }[]>(
      oversizedQuote.checks_json,
      [],
    );
    assert.deepEqual(
      big.filter((check) => !check.passed).map((check) => check.id),
      ['range', 'size'],
      'Only things about the job flag it, never how trained the Charm is',
    );
    assert.match(
      big.find((check) => check.id === 'size')?.detail ?? '',
      /much bigger than the Driveways jobs you’ve priced, which go up to 600 sq ft/,
    );
    const { range: wide } = oversized.view.quote.card;
    const total = Number(oversizedQuote.total_cents);
    assert.ok(
      wide.lowCents <= total * 0.76 && wide.highCents >= total * 1.24,
      `A doubt gets the widest range: ${JSON.stringify(wide)} around ${total}`,
    );
    // An owner who sends firm prices while it learns still never gets a doubt sent as one.
    await shop.owner
      .patch('/api/v1/app/settings')
      .set('Origin', origin)
      .send({ learningStyle: 'firm' })
      .expect(200);
    const doubtedFirm = await reachQuote(shop.slug, undefined, {
      service: 'Driveways',
      size: 'About 2,000 sq ft.',
    });
    assert.equal(doubtedFirm.view.status, 'sent');
    assert.equal(doubtedFirm.view.quote.card.style, 'range', 'A doubt never goes out firm');
    await shop.owner
      .patch('/api/v1/app/settings')
      .set('Origin', origin)
      .send({ learningStyle: 'range' })
      .expect(200);
    const learning = await reachQuote(shop.slug, undefined, {
      service: 'House wash',
      size: 'About 2,000 sq ft.',
    });
    const ranged = learning.view;
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
    await learning.customer.call('post', '/contact', sam()).expect(200);
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
      (item: { id: string }) => item.id === automatic.view.quote.id,
    );
    assert.equal(firm.range, null, 'A trained service quotes a firm price');

    // 5. Over the owner's own limit, a quote waits. The "needs your OK" email opens that one quote
    // with an Approve button, no sign-in.
    await shop.owner
      .patch('/api/v1/app/settings')
      .set('Origin', origin)
      .send({ limitCents: 5000 })
      .expect(200);
    const overLimit = await waitsBecause({ service: 'Driveways', size: 'About 600 sq ft.' });
    assert.deepEqual(
      overLimit.filter((check) => !check.passed).map((check) => check.id),
      ['limit'],
    );
    await shop.owner
      .patch('/api/v1/app/settings')
      .set('Origin', origin)
      .send({ limitCents: null })
      .expect(200);
    const bigRequest = lastReached!;
    const bigChat = bigRequest.customer.id;
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
      shown.body.data.reasons.some((reason: string) => /over your \$50 limit/.test(reason)),
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

    // 6. A photo is read like a video, outside the request: the chat shows it's looking, and the
    // assistant carries on from it once it's read.
    const photoAgent = customerAgent();
    const photographer = await chat(shop.slug, photoAgent);
    await photographer.call('post', '/messages', { text: 'Driveways' }).expect(200);
    const askedForPhoto = await photographer.call('post', '/messages', {
      text: 'About 600 sq ft, two cars.',
    });
    assert.deepEqual(askedForPhoto.body.data.messages.at(-1).chips, ['Skip photos']);
    const driveway = await sharp({
      create: { width: 60, height: 40, channels: 3, background: '#8a8f96' },
    })
      .jpeg()
      .toBuffer();
    const uploaded = await photoAgent
      .post(`${photographer.base}/photos`)
      .set('Origin', origin)
      .set('Authorization', `Bearer ${photographer.token}`)
      .attach('file', driveway, 'driveway.jpg');
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    assert.equal(uploaded.body.data.measuring, true, 'The chat shows it’s looking at the photo');
    assert.equal(uploaded.body.data.measuringPhotos, true);
    let photoView = uploaded.body.data;
    for (let tries = 0; photoView.measuring && tries < 100; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      photoView = (await photographer.call('get', '')).body.data;
    }
    assert.equal(photoView.measuring, false, 'It carries on once the photo is read');
    assert.notEqual(photoView.status, 'chatting', 'The assistant answered from the photo');
    const [photoChat] = await rows(
      'SELECT photo_reading_json,photo_read_until FROM lead_chats WHERE id=?',
      [photographer.id],
    );
    const reading = json<{ photoIds: string[]; result: { source?: string } | null }>(
      photoChat.photo_reading_json,
      { photoIds: [], result: null },
    );
    assert.equal(reading.photoIds.length, 1);
    assert.equal(reading.result?.source, 'photos');
    assert.equal(photoChat.photo_read_until, null, 'And lets go of the chat');
    assert.equal(
      (await rows('SELECT id FROM live_quotes WHERE chat_id=?', [photographer.id])).length,
      1,
      'The quote came after the reading',
    );
  },
);
