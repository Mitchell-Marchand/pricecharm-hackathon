import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { closeDatabase, mutate, rows, transaction } from '../src/db.js';
import { deleteBusinessAccount } from '../src/accounts.js';
import { scheduleExpiredDraftDeletion } from '../src/workspace.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const origin = 'http://localhost:3100';
after(() => closeDatabase());

test(
  'a draft holds setup before signup, moves between browsers, and becomes the business at signup',
  { skip: !enabled },
  async () => {
    const app = createApp();
    const browser = request.agent(app);
    const missing = await browser.get('/api/v1/onboarding');
    assert.equal(missing.status, 401);
    assert.equal(missing.body.error.code, 'SETUP_REQUIRED');

    const started = await browser.post('/api/v1/onboarding/start').set('Origin', origin).send({});
    assert.equal(started.status, 201, JSON.stringify(started.body));
    assert.equal(started.body.data.draft, true);
    assert.equal(started.body.data.step, 'trade');
    assert.match(String(started.headers['set-cookie']), /quotient_draft=.*HttpOnly/);
    const again = await browser.post('/api/v1/onboarding/start').set('Origin', origin).send({});
    assert.equal(again.status, 200, 'Starting again keeps the same draft');

    const updated = await browser
      .patch('/api/v1/onboarding/business')
      .set('Origin', origin)
      .send({
        tradeId: 'pressure-washing',
        services: ['Driveways', 'House wash', 'Gutter brightening'],
        name: 'Moss & Stone Exterior Care',
        area: 'Portland, OR',
        radius: '25',
      });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.deepEqual(updated.body.data.business, {
      tradeId: 'pressure-washing',
      customTrade: '',
      services: ['Driveways', 'House wash', 'Gutter brightening'],
      customServices: ['Gutter brightening'],
      name: 'Moss & Stone Exterior Care',
      area: 'Portland, OR',
      locations: ['Portland, OR'],
      currency: 'USD',
      radius: '25',
    });
    // More places to work from: the first stays the main one.
    const placed = await browser
      .patch('/api/v1/onboarding/business')
      .set('Origin', origin)
      .send({ locations: ['Portland, OR', 'Vancouver, WA'] });
    assert.deepEqual(
      [placed.body.data.business.locations, placed.body.data.business.area],
      [['Portland, OR', 'Vancouver, WA'], 'Portland, OR'],
    );
    // Before a card, the currency can change, and back.
    for (const currency of ['INR', 'USD']) {
      const changed = await browser
        .patch('/api/v1/onboarding/business')
        .set('Origin', origin)
        .send({ currency });
      assert.equal(changed.body.data.business.currency, currency);
    }
    const reordered = await browser
      .patch('/api/v1/onboarding/business')
      .set('Origin', origin)
      .send({ services: ['House wash', 'Driveways'] });
    assert.deepEqual(reordered.body.data.business.services, ['House wash', 'Driveways']);
    for (const bad of [
      { tradeId: 'not-a-trade' },
      { services: ['Driveways', 'driveways'] },
      { radius: '30' },
      { locations: ['Portland, OR', 'portland, or'] },
      { locations: ['a', 'b', 'c', 'd', 'e', 'f'] },
    ]) {
      const rejected = await browser
        .patch('/api/v1/onboarding/business')
        .set('Origin', origin)
        .send(bad);
      assert.equal(rejected.status, 400, JSON.stringify(bad));
    }
    const stepped = await browser
      .patch('/api/v1/onboarding/step')
      .set('Origin', origin)
      .send({ step: 'practice' });
    assert.equal(stepped.body.data.step, 'practice');
    const draftId = String(
      (
        await rows(
          "SELECT id FROM businesses WHERE name='Moss & Stone Exterior Care' AND status='draft' ORDER BY created_at DESC LIMIT 1",
        )
      )[0].id,
    );
    // A setup saved on a step from before practice came first picks up where it now fits.
    await mutate("UPDATE businesses SET onboarding_step='jobs' WHERE id=?", [draftId]);
    const picked = await browser.get('/api/v1/onboarding');
    assert.equal(picked.body.data.step, 'practice');
    const [draft] = await rows('SELECT slug FROM businesses WHERE id=?', [draftId]);
    const hidden = await request(app).get(`/api/v1/chat/${draft.slug}`);
    assert.equal(hidden.status, 404, 'Drafts have no public page');

    // "Email me a link": the link moves the setup to another browser and retires the first one.
    const owner = `qa-draft-${randomUUID()}@example.test`;
    const link = await browser
      .post('/api/v1/onboarding/resume-link')
      .set('Origin', origin)
      .send({ email: owner });
    assert.equal(link.status, 200, JSON.stringify(link.body));
    assert.ok(link.body.data.devToken);
    const [queued] = await rows(
      "SELECT COUNT(*) AS count FROM email_outbox WHERE business_id=? AND dedupe_key LIKE 'resume-link:%'",
      [draftId],
    );
    assert.equal(Number(queued.count), 1);
    const phone = request.agent(app);
    const resumed = await phone
      .post('/api/v1/onboarding/resume')
      .set('Origin', origin)
      .send({ token: link.body.data.devToken });
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.equal(resumed.body.data.business.name, 'Moss & Stone Exterior Care');
    assert.equal((await browser.get('/api/v1/onboarding')).status, 401);
    const reused = await request(app)
      .post('/api/v1/onboarding/resume')
      .set('Origin', origin)
      .send({ token: link.body.data.devToken });
    assert.equal(reused.status, 410, 'A resume link works once');

    const signup = await phone.post('/api/v1/auth/register').set('Origin', origin).send({
      firstName: 'Maya',
      lastName: 'Lopez',
      email: owner,
      password: 'test password strong123',
    });
    assert.equal(signup.status, 201, JSON.stringify(signup.body));
    assert.equal(signup.body.data.business.id, draftId, 'Signup claims the draft');
    assert.match(signup.body.data.business.slug, /^moss-and-stone-exterior-care-[0-9a-f]{8}$/);
    assert.equal(signup.body.data.user.name, 'Maya Lopez');
    assert.match(String(signup.headers['set-cookie']), /quotient_draft=;/);
    const [business] = await rows('SELECT status,draft_token_hash FROM businesses WHERE id=?', [
      draftId,
    ]);
    assert.equal(business.status, 'active');
    assert.equal(business.draft_token_hash, null);
    const [user] = await rows('SELECT first_name,last_name FROM users WHERE email=?', [owner]);
    assert.deepEqual({ ...user }, { first_name: 'Maya', last_name: 'Lopez' });
    const signedIn = await phone.get('/api/v1/onboarding');
    assert.equal(signedIn.body.data.draft, false);
    assert.equal(signedIn.body.data.step, 'live');
    assert.deepEqual(signedIn.body.data.business.services, ['House wash', 'Driveways']);
  },
);

test(
  'starting over gives the browser a new setup and leaves the old one',
  { skip: !enabled },
  async () => {
    process.env.TRUST_PROXY = '1';
    const app = createApp();
    // From addresses of their own, so they don't use up the setup limits the other tests share.
    const browser = request.agent(app).set('X-Forwarded-For', '203.0.113.60');
    const nothing = await browser.post('/api/v1/onboarding/restart').set('Origin', origin).send({});
    assert.equal(nothing.status, 401, 'There has to be a setup to start over from');

    await browser.post('/api/v1/onboarding/start').set('Origin', origin).send({}).expect(201);
    const name = `Old Setup ${randomUUID()}`;
    await browser
      .patch('/api/v1/onboarding/business')
      .set('Origin', origin)
      .send({ tradeId: 'roofing', services: ['Repairs'], name, area: 'Austin, TX' })
      .expect(200);
    await browser
      .patch('/api/v1/onboarding/step')
      .set('Origin', origin)
      .send({ step: 'practice' })
      .expect(200);

    const fresh = await browser
      .post('/api/v1/onboarding/restart')
      .set('Origin', origin)
      .send({ currency: 'CAD' });
    assert.equal(fresh.status, 201, JSON.stringify(fresh.body));
    assert.equal(fresh.body.data.draft, true);
    assert.equal(fresh.body.data.step, 'trade');
    assert.equal(fresh.body.data.business.tradeId, null);
    assert.equal(fresh.body.data.business.name, '');
    assert.equal(fresh.body.data.business.currency, 'CAD');
    const now = await browser.get('/api/v1/onboarding');
    assert.equal(now.body.data.step, 'trade', 'The browser is on the new setup');
    const [old] = await rows('SELECT status FROM businesses WHERE name=?', [name]);
    assert.equal(old.status, 'draft', 'The old setup is left to expire');

    await browser
      .patch('/api/v1/onboarding/business')
      .set('Origin', origin)
      .send({ name: 'New Setup', area: 'Austin, TX' })
      .expect(200);
    await browser
      .post('/api/v1/auth/register')
      .set('Origin', origin)
      .send({
        firstName: 'Sam',
        lastName: 'Kim',
        email: `qa-restart-${randomUUID()}@example.test`,
        password: 'test password strong123',
      })
      .expect(201);
    const finished = await browser
      .post('/api/v1/onboarding/restart')
      .set('Origin', origin)
      .send({});
    assert.equal(finished.status, 409, 'An account never starts over');
    assert.equal(finished.body.error.code, 'SETUP_FINISHED');

    // Each new one counts against the day's allowance, so it can't be used to farm setups.
    const repeat = request.agent(app).set('X-Forwarded-For', '203.0.113.61');
    await repeat.post('/api/v1/onboarding/start').set('Origin', origin).send({}).expect(201);
    for (let made = 1; made < 10; made++)
      await repeat.post('/api/v1/onboarding/restart').set('Origin', origin).send({}).expect(201);
    const over = await repeat.post('/api/v1/onboarding/restart').set('Origin', origin).send({});
    assert.equal(over.status, 429);
    assert.equal(over.body.error.code, 'SETUP_LIMIT');
  },
);

test('signup without a draft still needs a business name', { skip: !enabled }, async () => {
  const response = await request(createApp())
    .post('/api/v1/auth/register')
    .set('Origin', origin)
    .send({
      firstName: 'Sam',
      lastName: 'Kim',
      email: `qa-nodraft-${randomUUID()}@example.test`,
      password: 'test password strong123',
    });
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, 'BUSINESS_NAME_REQUIRED');
});

test('expired drafts are deleted like closed accounts', { skip: !enabled }, async () => {
  const app = createApp();
  const browser = request.agent(app);
  await browser.post('/api/v1/onboarding/start').set('Origin', origin).send({});
  await browser
    .patch('/api/v1/onboarding/business')
    .set('Origin', origin)
    .send({ name: `Expired ${randomUUID()}`, services: ['Lawn mowing'] });
  const [draft] = await rows(
    "SELECT id FROM businesses WHERE status='draft' ORDER BY created_at DESC LIMIT 1",
  );
  await mutate(
    'UPDATE businesses SET draft_expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 MINUTE) WHERE id=?',
    [draft.id],
  );
  assert.equal((await browser.get('/api/v1/onboarding')).status, 401);
  await transaction((connection) => scheduleExpiredDraftDeletion(connection));
  const [audit] = await rows(
    "SELECT id FROM account_deletion_audits WHERE business_id=? AND status='scheduled'",
    [draft.id],
  );
  assert.ok(audit, 'Deletion is scheduled');
  await deleteBusinessAccount(String(draft.id), String(audit.id));
  assert.equal((await rows('SELECT id FROM businesses WHERE id=?', [draft.id])).length, 0);
  assert.equal((await rows('SELECT id FROM offerings WHERE business_id=?', [draft.id])).length, 0);
});
