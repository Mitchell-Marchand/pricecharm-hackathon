import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { closeDatabase, mutate, readOnlySnapshot, rows, transaction } from '../src/db.js';

test(
  'paged inbox traverses tied historical requests in both directions with scoped counts and consistent read-only snapshots',
  { skip: process.env.RUN_DB_TESTS !== '1' },
  async () => {
    process.env.NODE_ENV = 'test';
    process.env.AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'mock-only';
    process.env.MAIL_PROVIDER = 'local';
    process.env.BILLING_PROVIDER = 'local';
    const realFetch = globalThis.fetch;
    let providerCalls = 0;
    globalThis.fetch = async () => {
      providerCalls++;
      throw new Error('Inbox reads must not use a provider');
    };
    const { createApp } = await import('../src/app.js'),
      { deleteBusinessAccount } = await import('../src/accounts.js');
    const app = createApp(),
      owner = request.agent(app),
      other = request.agent(app),
      origin = 'http://localhost:3100',
      businessIds: string[] = [],
      serviceIds: string[] = [],
      prefix = randomUUID().slice(0, 8),
      at = new Date('2026-10-20T12:34:56.789Z');
    const id = (index: number) => `${prefix}-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const page = async (filter = 'all', cursor?: string, agent = owner) => {
      const query = new URLSearchParams({ filter });
      if (cursor !== undefined) query.set('cursor', cursor);
      return (await agent.get(`/api/v1/quotes/page?${query}`).expect(200)).body.data;
    };
    const cursorData = (value: string) =>
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const ids = (data: any) => data.quotes.map((quote: any) => quote.id);
    const snapshot = async () =>
      JSON.stringify(
        await Promise.all([
          ...['quotes', 'services', 'email_outbox', 'jobs', 'usage_events', 'messages'].map(
            (table) =>
              rows(`SELECT * FROM ${table} WHERE business_id=? ORDER BY id`, [businessIds[0]]),
          ),
          rows('SELECT * FROM ai_daily_budgets ORDER BY budget_day'),
        ]),
      );
    const seed = async (quoteId: string, status: string, tenant = 0, source = 'live', date = at) =>
      mutate(
        'INSERT INTO quotes(id,business_id,service_id,service_version,customer_name,customer_email,status,description,quantity,total_cents,currency,assumptions_json,line_items_json,calculation_json,source,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [
          quoteId,
          businessIds[tenant],
          serviceIds[tenant],
          1,
          `Fictional history ${quoteId}`,
          'fictional-history@example.test',
          status,
          'An archived fictional service request',
          1,
          10000,
          'USD',
          '[]',
          '[]',
          '{}',
          source,
          date,
        ],
      );
    try {
      for (const agent of [owner, other]) {
        const registered = (
          await agent
            .post('/api/v1/auth/register')
            .set('Origin', origin)
            .send({
              name: 'Inbox history QA',
              businessName: 'Fictional history QA',
              email: `qa-history-${randomUUID()}@example.test`,
              password: 'history-fixture-password123',
            })
            .expect(201)
        ).body.data;
        businessIds.push(registered.business.id);
        serviceIds.push(
          (
            await agent
              .post('/api/v1/services')
              .set('Origin', origin)
              .send({
                name: 'Appliance repair',
                description: 'Appliance repair requests',
                unitLabel: 'project',
              })
              .expect(201)
          ).body.data.id,
        );
      }
      const statuses = ['review', 'issued', 'accepted', 'declined'];
      for (let index = 0; index < 253; index++)
        await seed(id(index), statuses[index % statuses.length]);
      await seed(id(999), 'review', 0, 'playground', new Date(at.getTime() + 1000));
      for (let index = 1000; index < 1030; index++)
        await seed(id(index), 'review', 1, 'live', new Date(at.getTime() + 1000));
      const before = await snapshot(),
        first = await page();
      assert.equal(first.pageSize, 25);
      assert.deepEqual(first.counts, { all: 253, review: 64, issued: 63 });
      assert.equal(first.newerCursor, null);
      assert.ok(first.olderCursor);
      assert.match(first.olderCursor, /^[A-Za-z0-9_-]{1,512}$/);
      assert.equal(cursorData(first.olderCursor).createdAt, at.toISOString());
      assert.deepEqual(
        ids(first),
        Array.from({ length: 25 }, (_, offset) => id(252 - offset)),
      );
      const traversed: string[] = [],
        pages = [first];
      let current = first;
      for (;;) {
        traversed.push(...ids(current));
        assert.deepEqual(current.counts, first.counts);
        assert.equal(
          current.quotes.every((quote: any) => quote.createdAt === at.toISOString()),
          true,
        );
        if (!current.olderCursor) break;
        const next = await page('all', current.olderCursor);
        assert.deepEqual(
          ids(await page('all', next.newerCursor)),
          ids(current),
          'Newer can reconstruct the preceding page from its URL cursor alone',
        );
        pages.push(next);
        current = next;
      }
      assert.equal(pages.length, 11);
      assert.equal(traversed.length, 253);
      assert.equal(
        new Set(traversed).size,
        253,
        'Same-millisecond UUID ties never duplicate or skip unchanged rows',
      );
      assert.deepEqual(
        traversed,
        Array.from({ length: 253 }, (_, offset) => id(252 - offset)),
      );
      let backward = pages.at(-1);
      while (backward.newerCursor) {
        backward = await page('all', backward.newerCursor);
      }
      assert.deepEqual(ids(backward), ids(first));
      const reviewed = await page('review'),
        issued = await page('issued');
      assert.deepEqual(reviewed.counts, first.counts);
      assert.deepEqual(issued.counts, first.counts);
      assert.equal(
        reviewed.quotes.every((quote: any) => quote.status === 'review'),
        true,
      );
      assert.equal(
        issued.quotes.every((quote: any) => quote.status === 'issued'),
        true,
      );
      assert.equal(
        first.quotes.some((quote: any) => quote.status === 'accepted'),
        true,
      );
      assert.equal(
        first.quotes.some((quote: any) => quote.status === 'declined'),
        true,
      );
      const legacy = (await owner.get('/api/v1/quotes').expect(200)).body.data;
      assert.ok(Array.isArray(legacy));
      assert.equal(legacy.length, 200);
      assert.deepEqual(
        legacy.map((quote: any) => quote.id),
        traversed.slice(0, 200),
      );
      assert.ok(
        Array.isArray((await owner.get('/api/v1/quotes?paged=1').expect(200)).body.data),
        'Legacy array behavior stays compatible even for previously ignored query strings',
      );

      const base = cursorData(first.olderCursor),
        foreignPage = await page('all', undefined, other);
      const invalidValues = [
        '',
        'not-base64!',
        first.olderCursor + '=',
        'A'.repeat(513),
        encode({ ...base, v: 2 }),
        encode({ ...base, businessId: businessIds[1] }),
        encode({ ...base, filter: 'review' }),
        encode({ ...base, direction: 'sideways' }),
        encode({ ...base, id: 'not-a-uuid' }),
        encode({ ...base, createdAt: '2026-10-20T12:34:56.78Z' }),
        encode({ ...base, createdAt: '2026-10-20T12:34:56.789+00:00' }),
        encode({ ...base, createdAt: '0001-01-01T00:00:00.000Z' }),
        encode({ ...base, extra: true }),
        foreignPage.olderCursor,
      ];
      for (const value of invalidValues) {
        const response = await owner
          .get(`/api/v1/quotes/page?filter=all&cursor=${encodeURIComponent(value)}`)
          .expect(400);
        assert.equal(response.body.error.code, 'INVALID_CURSOR');
      }
      await other.get(`/api/v1/quotes/page?cursor=${first.olderCursor}`).expect(400);
      assert.equal(
        (
          await owner
            .get(`/api/v1/quotes/page?filter=review&cursor=${first.olderCursor}`)
            .expect(400)
        ).body.error.code,
        'INVALID_CURSOR',
      );
      await owner.get('/api/v1/quotes/page?filter=accepted').expect(400);
      await owner.get('/api/v1/quotes/page?limit=200').expect(400);
      await owner
        .get(`/api/v1/quotes/page?cursor=${first.olderCursor}&cursor=${first.olderCursor}`)
        .expect(400);
      await request(app).get('/api/v1/quotes/page').expect(401);
      const forgedPosition = encode({
        ...base,
        businessId: businessIds[0],
        createdAt: new Date(at.getTime() + 1000).toISOString(),
        id: id(1029),
        direction: 'older',
      });
      const scoped = await page('all', forgedPosition);
      assert.deepEqual(scoped.counts, first.counts);
      assert.equal(
        scoped.quotes.every((quote: any) => traversed.includes(quote.id)),
        true,
        'Untrusted cursor coordinates cannot change tenant/source authority',
      );
      assert.equal(
        await snapshot(),
        before,
        'All paging and cursor validation leave policy, quotes, outbox, jobs, usage and allowance unchanged',
      );
      assert.equal(providerCalls, 0);

      const anchor = cursorData(reviewed.olderCursor);
      await readOnlySnapshot(async (connection) => {
        const [oldCount] = await rows(
          "SELECT COUNT(*) AS count FROM quotes WHERE business_id=? AND source='live' AND status='review'",
          [businessIds[0]],
          connection,
        );
        await transaction(async (writer) =>
          mutate(
            "UPDATE quotes SET status='issued' WHERE business_id=? AND id=?",
            [businessIds[0], anchor.id],
            writer,
          ),
        );
        const [sameSnapshot] = await rows(
          "SELECT COUNT(*) AS count FROM quotes WHERE business_id=? AND source='live' AND status='review'",
          [businessIds[0]],
          connection,
        );
        assert.equal(
          Number(sameSnapshot.count),
          Number(oldCount.count),
          'Related reads retain one committed snapshot while an independent writer can proceed',
        );
      });
      const afterAnchor = await page('review', reviewed.olderCursor);
      assert.equal(afterAnchor.counts.review, 63);
      assert.equal(afterAnchor.counts.issued, 64);
      assert.equal(
        afterAnchor.quotes.length,
        25,
        'A changed anchor status does not invalidate the cursor',
      );
      assert.equal(
        afterAnchor.quotes.some((quote: any) => quote.id === anchor.id),
        false,
      );
      await assert.rejects(
        readOnlySnapshot((connection) =>
          mutate(
            'UPDATE quotes SET description=? WHERE business_id=? AND id=?',
            ['Forbidden write', businessIds[0], anchor.id],
            connection,
          ),
        ),
        (error: any) => error.errno === 1792,
      );
      await transaction((connection) =>
        mutate(
          'UPDATE quotes SET description=? WHERE business_id=? AND id=?',
          ['A permitted fixture write after the read-only transaction', businessIds[0], anchor.id],
          connection,
        ),
      );
      assert.equal(
        (await rows('SELECT description FROM quotes WHERE id=?', [anchor.id]))[0].description,
        'A permitted fixture write after the read-only transaction',
        'The existing write helper remains writable',
      );

      const insertedId = id(900);
      await seed(insertedId, 'review', 0, 'live', new Date(at.getTime() + 1));
      const continued = await page('all', first.olderCursor);
      assert.deepEqual(
        ids(continued),
        ids(pages[1]),
        'A newer insert never shifts an existing older seek page',
      );
      assert.equal(continued.counts.all, 254);
      assert.equal(
        continued.quotes.some((quote: any) => quote.id === insertedId),
        false,
      );
      assert.equal(
        (await page()).quotes[0].id,
        insertedId,
        'Explicit newest refresh reveals new requests',
      );

      const lastReviewCursor = afterAnchor.olderCursor,
        lastPosition = cursorData(lastReviewCursor);
      await mutate(
        "UPDATE quotes SET status='issued' WHERE business_id=? AND source='live' AND status='review' AND (created_at<? OR (created_at=? AND id<?))",
        [
          businessIds[0],
          new Date(lastPosition.createdAt),
          new Date(lastPosition.createdAt),
          lastPosition.id,
        ],
      );
      const empty = await page('review', lastReviewCursor);
      assert.deepEqual(empty.quotes, []);
      assert.equal(empty.olderCursor, null);
      assert.equal(empty.newerCursor, null);
      assert.equal(empty.counts.all, 254);
      assert.ok(
        empty.counts.review > 0,
        'An empty historical page does not pretend the filtered business inbox is empty',
      );
      assert.ok(
        (await page('review')).quotes.length > 0,
        'A fresh newest read is the explicit empty-page recovery',
      );
      assert.equal(providerCalls, 0);
    } finally {
      globalThis.fetch = realFetch;
      for (const businessId of businessIds) {
        const deletionId = randomUUID();
        await mutate('INSERT INTO account_deletion_audits(id,business_id,status) VALUES (?,?,?)', [
          deletionId,
          businessId,
          'scheduled',
        ]);
        await mutate('UPDATE businesses SET deletion_requested_at=UTC_TIMESTAMP(3) WHERE id=?', [
          businessId,
        ]);
        await deleteBusinessAccount(businessId, deletionId);
      }
      await closeDatabase();
    }
  },
);
