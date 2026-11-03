import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import request from 'supertest';
import { closeDatabase, mutate, rows } from '../src/db.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const origin = 'http://localhost:3100';
after(() => closeDatabase());

test(
  'an agent gets a quote for someone, who says yes on the quote page; only that yes is billed',
  { skip: !enabled },
  async () => {
    process.env.TRUST_PROXY = '1';
    const { createApp } = await import('../src/app.js');
    const app = createApp();

    // A pressure washer who prices driveways from three past jobs and quotes on their own. From
    // an address of its own, so it doesn't use up the setup limits the other tests share.
    const owner = request.agent(app).set('X-Forwarded-For', '203.0.113.50');
    await owner.post('/api/v1/onboarding/start').set('Origin', origin).send({}).expect(201);
    await owner
      .patch('/api/v1/onboarding/business')
      .set('Origin', origin)
      .send({
        tradeId: 'pressure-washing',
        services: ['Driveways', 'House wash'],
        name: 'Agent Ready Washing',
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
        email: `qa-agent-${randomUUID()}@example.test`,
        password: 'test password strong123',
      });
    assert.equal(signup.status, 201, JSON.stringify(signup.body));
    const businessId = String(signup.body.data.business.id);
    const slug = String(signup.body.data.business.slug);
    await owner
      .post('/api/v1/app/billing/plan')
      .set('Origin', origin)
      .send({ plan: 'per_quote' })
      .expect(200);
    await owner.post('/api/v1/billing/checkout').set('Origin', origin).send({}).expect(200);
    await owner.post('/api/v1/app/deploy').set('Origin', origin).send({}).expect(200);
    await owner
      .patch('/api/v1/app/settings')
      .set('Origin', origin)
      .send({ autoSend: true })
      .expect(200);
    // Past the free quotes, so showing a quote would normally cost $2.
    await mutate('UPDATE billing_accounts SET trial_quote_limit=0 WHERE business_id=?', [
      businessId,
    ]);

    // Off until keys are set, and then only with one.
    delete process.env.AGENT_API_KEYS;
    await request(app).get(`/api/v1/agent/businesses/${slug}`).expect(404);
    process.env.AGENT_API_KEYS = 'other-key, agent-test-key';
    await request(app).get(`/api/v1/agent/businesses/${slug}`).expect(401);
    await request(app)
      .get(`/api/v1/agent/businesses/${slug}`)
      .set('X-Agent-Key', 'wrong')
      .expect(401);

    const agent = (method: 'get' | 'post', path: string, token?: string) => {
      const call = request(app)
        [method](`/api/v1/agent/businesses/${slug}${path}`)
        .set('X-Agent-Key', 'agent-test-key')
        .set('X-Forwarded-For', '203.0.113.7');
      return token ? call.set('Authorization', `Bearer ${token}`) : call;
    };

    // What the price depends on comes from the owner's formula, as the chat's own drivers do.
    await mutate(
      'INSERT INTO pricing_formulas (business_id,examples_key,learned_json) VALUES (?,?,?)',
      [
        businessId,
        'test',
        JSON.stringify({
          formula: {
            services: [
              { name: 'Driveways', unit: 'sq ft', rateCents: 45, points: [], minimumCents: null },
            ],
            surcharges: [
              { name: 'Heavy oil stains', when: 'heavy oil stains', percent: 18, flatCents: null },
            ],
            addOns: [{ name: 'Gutter cleaning', per: 'job', cents: 6000 }],
            bundlePercent: null,
            roundToCents: 500,
            minimumCents: null,
            itemizes: false,
          },
          notes: [],
          examples: [],
          gaps: [],
          fits: true,
        }),
      ],
    );
    const profile = await agent('get', '');
    assert.equal(profile.status, 200, JSON.stringify(profile.body));
    assert.equal(profile.body.data.name, 'Agent Ready Washing');
    assert.deepEqual(profile.body.data.services, ['Driveways', 'House wash']);
    assert.equal(profile.body.data.taking, true);
    assert.ok(Array.isArray(profile.body.data.asksAbout));
    assert.deepEqual(profile.body.data.priceDependsOn, {
      sizes: [{ service: 'Driveways', unit: 'sq ft', alsoCounts: null }],
      conditions: ['heavy oil stains'],
      extras: [{ name: 'Gutter cleaning', counted: false }],
    });

    // No browser, no human check: the key is enough to start.
    const started = await agent('post', '/requests').send({ message: 'Driveways' });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const token = String(started.body.data.token);
    const id = String(started.body.data.request.id);
    assert.equal(started.body.data.request.status, 'asking');
    assert.equal(started.body.data.request.next, 'answer');
    assert.match(started.body.data.request.reply, /\[Demo\]/);

    let view = (
      await agent('post', `/requests/${id}/messages`, token)
        .send({ message: 'About 600 sq ft, two cars.' })
        .expect(200)
    ).body.data;
    assert.deepEqual(view.choices, ['Skip photos']);
    // The person's own photo, sent the way the quote link sends one.
    const photo = await sharp({
      create: { width: 64, height: 48, channels: 3, background: '#888' },
    })
      .jpeg()
      .toBuffer();
    const sent = await agent('post', `/requests/${id}/photos`, token).attach('file', photo, {
      filename: 'driveway.jpg',
      contentType: 'image/jpeg',
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    view = sent.body.data;
    const [photos] = await rows(
      'SELECT COUNT(*) AS count FROM attachments WHERE conversation_id=?',
      [id],
    );
    assert.equal(Number(photos.count), 1);
    // It's read outside the request, and the agent waits until the Charm has looked.
    assert.deepEqual([view.status, view.next], ['reading_photos', 'wait']);
    for (let tries = 0; view.next === 'wait' && tries < 50; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      view = (await agent('get', `/requests/${id}`, token).expect(200)).body.data;
    }
    assert.equal(view.status, 'quoted');
    assert.equal(view.next, 'hand_to_person');
    assert.equal(view.job.service, 'Driveways');
    // Driveways is still learning, so it goes out as a range around the owner's price. It's the
    // main service, which wants 8 sized prices, so the range is still wide.
    assert.deepEqual(view.quote.price, { kind: 'range', lowCents: 21000, highCents: 34000 });
    assert.equal(view.quote.text, '$210 to $340');
    assert.deepEqual(view.quote.lines, [{ label: view.quote.lines[0].label, cents: 27500 }]);
    assert.match(view.quote.validUntil, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(view.quote.assumes, ['600 sq ft'], 'What the price is for');
    assert.deepEqual(view.quote.ifs, []);
    assert.equal(view.quote.confirmUrl, `${origin}/q/${slug}#chat=${id}&token=${token}`);
    assert.deepEqual(
      (await agent('get', `/requests/${id}`, token).expect(200)).body.data,
      view,
      'Reading it again changes nothing',
    );

    const [quote] = await rows('SELECT id,seen_at FROM live_quotes WHERE chat_id=?', [id]);
    const ledger = () =>
      rows('SELECT charge,source,fee_cents FROM quote_usage WHERE quote_id=?', [quote.id]);
    assert.deepEqual(await ledger(), [], 'The agent seeing it costs nothing');
    assert.equal(quote.seen_at, null, 'Nor counts for the accept button test');

    // The person opens the link the agent handed them: the same chat, with the quote.
    const person = (method: 'get' | 'post', path = '') =>
      request(app)
        [method](`/api/v1/chat/${slug}/${id}${path}`)
        .set('Origin', origin)
        .set('X-Forwarded-For', '198.51.100.40')
        .set('Authorization', `Bearer ${token}`);
    const page = (await person('get').expect(200)).body.data;
    assert.equal(page.quote.card.lines[0].amountCents, 27500);
    assert.ok(
      page.messages.some((message: { photos: unknown[] }) => message.photos.length === 1),
      'With the photo the agent sent',
    );
    assert.deepEqual(await ledger(), []);

    // An agent can't say yes for them.
    const agentYes = await agent('post', `/requests/${id}/accept`, token).send({});
    assert.ok(agentYes.status >= 400, JSON.stringify(agentYes.body));
    assert.deepEqual(await ledger(), []);

    // Their yes is the quote shown, and billed once.
    const yes = await person('post', '/accept').send({ name: 'Sam Kim', phone: '555-0142' });
    assert.equal(yes.status, 200, JSON.stringify(yes.body));
    assert.equal(yes.body.data.quote.status, 'accepted');
    assert.deepEqual(
      (await ledger()).map((row) => ({ ...row, fee_cents: Number(row.fee_cents) })),
      [{ charge: 'delivered', source: 'live_auto', fee_cents: 200 }],
    );
    const done = (await agent('get', `/requests/${id}`, token).expect(200)).body.data;
    assert.equal(done.status, 'accepted');
    assert.equal(done.next, 'done');

    // A business that isn't taking requests says so.
    await mutate('UPDATE businesses SET link_on=0 WHERE id=?', [businessId]);
    const closed = await agent('post', '/requests').send({ message: 'Driveways' });
    assert.equal(closed.body.error?.code, 'NOT_TAKING_REQUESTS');
    delete process.env.AGENT_API_KEYS;
  },
);
