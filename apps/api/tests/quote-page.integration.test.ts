import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import request from 'supertest';
import { closeDatabase, mutate, rows } from '../src/db.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const origin = 'http://localhost:3100';
after(() => closeDatabase());

/** A mark on a see-through canvas, so the margin around it is trimmed. */
async function logoFile(width: number, height: number, color: string) {
  const mark = await sharp({
    create: { width, height, channels: 4, background: color },
  })
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: width + 100,
      height: height + 100,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: mark, left: 50, top: 50 }])
    .png()
    .toBuffer();
}

test(
  'owners set their logo, who customers hear from, what follows a yes, and the accept button',
  { skip: !enabled },
  async () => {
    process.env.UPLOAD_DIR ??= await fs.mkdtemp(path.join(os.tmpdir(), 'pricecharm-page-'));
    // Earlier test files have started setups from this address today.
    process.env.LOCAL_SETUPS_PER_ADDRESS ??= '500';
    // Each customer comes from their own address, so the chat's per-address limits hold out.
    process.env.TRUST_PROXY = '1';
    let visitor = 0;
    const { createApp } = await import('../src/app.js');
    const app = createApp();

    // Hand back the setup and customer-contact allowances this uses, so later test files keep
    // theirs.
    const allowance = new Map(
      (await rows('SELECT bucket_key,attempts FROM auth_rate_limits')).map((row) => [
        String(row.bucket_key),
        Number(row.attempts),
      ]),
    );
    const handBack = async () => {
      for (const row of await rows('SELECT bucket_key,attempts FROM auth_rate_limits'))
        if (Number(row.attempts) > (allowance.get(String(row.bucket_key)) ?? 0))
          await mutate('UPDATE auth_rate_limits SET attempts=? WHERE bucket_key=?', [
            allowance.get(String(row.bucket_key)) ?? 0,
            row.bucket_key,
          ]);
    };

    // A live business whose Driveways quotes go out on their own.
    const owner = request.agent(app);
    await owner.post('/api/v1/onboarding/start').set('Origin', origin).send({}).expect(201);
    await handBack();
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
    const [{ business_id: businessId }] = await rows(
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
          businessId,
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
        email: `qa-page-${randomUUID()}@example.test`,
        password: 'test password strong123',
      });
    assert.equal(signup.status, 201, JSON.stringify(signup.body));
    const slug = String(signup.body.data.business.slug);
    await owner
      .post('/api/v1/app/billing/plan')
      .set('Origin', origin)
      .send({ plan: 'per_accepted' })
      .expect(200);
    await owner.post('/api/v1/billing/checkout').set('Origin', origin).send({}).expect(200);
    await owner.post('/api/v1/app/deploy').set('Origin', origin).send({}).expect(200);
    const setPage = (body: object) =>
      owner.patch('/api/v1/app/quote-page').set('Origin', origin).send(body);

    // A customer gets a quote, sent on its own as soon as the chat has the details.
    async function quoted(
      agent = request.agent(app).set('X-Forwarded-For', `198.51.100.${++visitor}`),
    ) {
      const started = await agent.post(`/api/v1/chat/${slug}/start`).set('Origin', origin).send({});
      assert.equal(started.status, 201, JSON.stringify(started.body));
      const base = `/api/v1/chat/${slug}/${started.body.data.chat.id}`;
      const call = (method: 'get' | 'post', suffix = '', body?: object) =>
        agent[method](`${base}${suffix}`)
          .set('Origin', origin)
          .set('Authorization', `Bearer ${started.body.data.token}`)
          .send(body);
      let view = null;
      for (const text of ['Driveways', 'About 600 sq ft, two cars.', 'Skip photos'])
        view = (await call('post', '/messages', { text }).expect(200)).body.data;
      // Asked where to send it: a quote that waits, or an owner who wants details first.
      if (view.status === 'contact')
        view = (await call('post', '/contact', sam()).expect(200)).body.data.chat;
      await handBack();
      const [quote] = await rows('SELECT * FROM live_quotes WHERE chat_id=?', [view.id]);
      return { call, view, quote };
    }
    const sam = () => ({ name: 'Sam Kim', email: `sam-${randomUUID()}@example.test` });

    // 1. The defaults: the owner's first name, and wordings PriceCharm tries.
    const start = (await owner.get('/api/v1/app/quote-page').expect(200)).body.data;
    assert.equal(start.logo, null);
    assert.equal(start.contactName, '');
    assert.equal(start.ownerFirstName, 'Maya');
    assert.equal(
      start.defaults.acceptedMessage,
      'You’re all set. Maya will be in touch to schedule.',
    );
    assert.equal(start.defaults.visitMessage, 'Got it. Maya will get in touch to set up a visit.');
    assert.equal(start.acceptLabel, '');
    assert.deepEqual(start.wordings, ['Looks good to me', 'Works for me', 'Let’s do it']);
    assert.equal(start.contactFirst, false, 'Customers see the price first');

    // 2. The logo: checked, trimmed, served to anyone, replaced and removed.
    const upload = (bytes: Buffer, type = 'image/png', name = 'logo.png') =>
      owner
        .post('/api/v1/app/quote-page/logo')
        .set('Origin', origin)
        .attach('file', bytes, { filename: name, contentType: type });
    assert.equal((await upload(Buffer.from('not an image'), 'text/plain', 'logo.txt')).status, 415);
    const fake = await upload(Buffer.from('not really a png'));
    assert.equal(fake.body.error?.code, 'INVALID_IMAGE');
    const tiny = await upload(
      await sharp({
        create: { width: 40, height: 40, channels: 4, background: '#228833' },
      })
        .png()
        .toBuffer(),
    );
    assert.equal(tiny.body.error?.code, 'LOGO_TOO_SMALL');
    assert.equal(
      (
        await request(app)
          .post('/api/v1/app/quote-page/logo')
          .set('Origin', origin)
          .attach('file', await logoFile(200, 100, '#dd2222'), 'logo.png')
      ).status,
      401,
      'Only the signed-in owner can change it',
    );
    const first = await upload(await logoFile(200, 100, '#dd2222'));
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const logo = first.body.data.logo;
    assert.deepEqual(
      { width: logo.width, height: logo.height },
      { width: 200, height: 100 },
      'The see-through margin is trimmed',
    );
    assert.match(logo.url, new RegExp(`^/api/v1/chat/${slug}/logo/[0-9a-f-]{36}$`));
    const profile = (await request(app).get(`/api/v1/chat/${slug}`).expect(200)).body.data;
    assert.deepEqual(profile.logo, logo);
    const served = await request(app).get(logo.url).expect(200);
    assert.equal(served.headers['content-type'], 'image/png');
    assert.match(String(served.headers['cache-control']), /immutable/);
    assert.equal((await sharp(served.body).metadata()).width, 200);
    const second = (await upload(await logoFile(160, 160, '#2244dd'))).body.data.logo;
    assert.notEqual(second.url, logo.url);
    await request(app).get(logo.url).expect(404);
    await request(app).get(second.url).expect(200);
    const kept = await rows("SELECT id FROM attachments WHERE business_id=? AND purpose='logo'", [
      businessId,
    ]);
    assert.equal(kept.length, 1, 'A new logo replaces the old one');
    const removed = await owner
      .delete('/api/v1/app/quote-page/logo')
      .set('Origin', origin)
      .expect(200);
    assert.equal(removed.body.data.logo, null);
    await request(app).get(second.url).expect(404);
    assert.equal((await request(app).get(`/api/v1/chat/${slug}`)).body.data.logo, null);
    await upload(await logoFile(200, 100, '#dd2222')).expect(200);

    // 3. Who customers hear from, and the lines after a yes and a visit request.
    const tooLong = await setPage({ contactName: 'J'.repeat(41) });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.error.details[0].message, 'Keep the name to 40 characters or fewer.');
    let page = (await setPage({ contactName: '  Jenny  ' }).expect(200)).body.data;
    assert.equal(page.contactName, 'Jenny');
    assert.equal(
      page.defaults.acceptedMessage,
      'You’re all set. Jenny will be in touch to schedule.',
    );
    assert.equal(
      (await request(app).get(`/api/v1/chat/${slug}`)).body.data.ownerFirstName,
      'Jenny',
    );
    page = (
      await setPage({ acceptedMessage: 'You’re all set. Jenny will be in touch to schedule.' })
    ).body.data;
    assert.equal(page.acceptedMessage, '', 'The default, typed out, stays the default');
    page = (
      await setPage({
        acceptedMessage: 'Thanks! I’ll text you\ntoday to pick a day.',
        visitMessage: 'Great, I’ll call you tomorrow to find a time to come by.',
      }).expect(200)
    ).body.data;
    assert.equal(page.acceptedMessage, 'Thanks! I’ll text you today to pick a day.');

    // 4. The accept button: a wording PriceCharm is trying, kept with the quote, counted from
    // when the customer first sees it.
    const yes = await quoted();
    assert.equal(yes.view.status, 'sent', JSON.stringify(yes.view.messages.at(-1)));
    assert.ok(start.wordings.includes(yes.view.quote.acceptLabel), yes.view.quote.acceptLabel);
    assert.ok(['looks_good', 'works', 'do_it'].includes(yes.quote.accept_variant));
    assert.ok(yes.quote.seen_at, 'The customer saw it when their quote came back');
    const again = (await yes.call('get').expect(200)).body.data;
    assert.equal(again.quote.acceptLabel, yes.view.quote.acceptLabel, 'It keeps its words');
    const accepted = (await yes.call('post', '/accept', sam()).expect(200)).body.data;
    assert.equal(accepted.messages.at(-1).text, 'Thanks! I’ll text you today to pick a day.');
    const detail = (await owner.get(`/api/v1/app/quotes/${yes.quote.id}`).expect(200)).body.data;
    assert.equal(detail.acceptLabel, yes.view.quote.acceptLabel);

    const visit = await quoted();
    const visited = (await visit.call('post', '/visit', sam()).expect(200)).body.data;
    assert.equal(
      visited.messages.at(-1).text,
      'Great, I’ll call you tomorrow to find a time to come by.',
    );

    // The owner's own words: on every new quote, and not part of the test.
    assert.equal((await setPage({ acceptLabel: 'x'.repeat(25) })).status, 400);
    await setPage({ acceptLabel: 'Let’s book it' }).expect(200);
    const own = await quoted();
    assert.equal(own.view.quote.acceptLabel, 'Let’s book it');
    assert.equal(own.quote.accept_variant, 'owner');
    const { wordingStats } = await import('../src/live/accept-wording.js');
    const stats = await wordingStats();
    assert.ok(stats.every((item) => item.id !== 'owner'));
    const tried = stats.find((item) => item.id === yes.quote.accept_variant);
    assert.ok(tried && tried.seen >= 1 && tried.accepted >= 1, JSON.stringify(stats));

    // The owner trying their own link sees the button, but their test never counts.
    const test = await quoted(owner);
    assert.equal(test.view.test, true);
    assert.equal(test.view.quote.acceptLabel, 'Let’s book it');
    assert.equal(test.quote.seen_at, null);

    // Back to the defaults: the first name, the usual lines, and the test.
    await setPage({ contactName: '', acceptedMessage: '', visitMessage: '', acceptLabel: '' });
    const reset = await quoted();
    assert.notEqual(reset.quote.accept_variant, 'owner');
    const yesAgain = (await reset.call('post', '/accept', sam()).expect(200)).body.data;
    assert.equal(
      yesAgain.messages.at(-1).text,
      'You’re all set. Maya will be in touch to schedule.',
    );

    // When a quote waits for the owner, the chat names whoever customers hear from.
    await setPage({ contactName: 'Jenny' });
    await owner.patch('/api/v1/app/settings').set('Origin', origin).send({ autoSend: false });
    const held = await quoted();
    assert.equal(held.view.quote, null);
    assert.match(
      held.view.messages.at(-2).text,
      /^Jenny at Moss & Stone Exterior Care wants to look this one over/,
    );
    assert.match(held.view.messages.at(-1).text, /as soon as Jenny sends it/);

    // Owners who'd rather hear from everyone first can ask for contact details before the price.
    await owner.patch('/api/v1/app/settings').set('Origin', origin).send({ autoSend: true });
    assert.equal((await setPage({ contactFirst: true }).expect(200)).body.data.contactFirst, true);
    const asked = await quoted();
    assert.equal(asked.view.status, 'sent', 'It shows once they leave their details');
    assert.equal(asked.view.contact.name, 'Sam Kim');
    const [askedUsage] = await rows('SELECT fee_cents FROM quote_usage WHERE quote_id=?', [
      asked.quote.id,
    ]);
    assert.ok(askedUsage, 'Billed once it shows');
    await setPage({ contactFirst: false }).expect(200);

    // The weekly report says how each wording is doing.
    const { metricsReport, formatReport } = await import('../src/metrics.js');
    const report = await metricsReport(7);
    assert.equal(report.acceptButton.wordings.length, 3);
    assert.match(formatReport(report), /The accept button/);
  },
);
