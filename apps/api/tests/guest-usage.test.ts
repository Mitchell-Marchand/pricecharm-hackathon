import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { mutate, rows, transaction, closeDatabase } from '../src/db.js';
import { guestIpBudgetKey, reserveGuestAiCall, withGuestAiUsage } from '../src/usage.js';
import { recordProviderUsage } from '../src/ai/index.js';
import { hashToken } from '../src/auth.js';
import { cleanupGuestPreviews } from '../src/worker.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const testSecret = Buffer.alloc(32, 61).toString('base64');
function saveEnvironment(keys: string[]) {
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
after(() => closeDatabase());

test('guest IP budget fingerprints are stable, daily-separated, and require a production secret', () => {
  const restore = saveEnvironment(['NODE_ENV', 'MAIL_ENCRYPTION_KEY', 'DB_PASS']);
  try {
    process.env.MAIL_ENCRYPTION_KEY = testSecret;
    const first = guestIpBudgetKey('192.0.2.17', '2026-10-28');
    assert.equal(first, guestIpBudgetKey('::ffff:192.0.2.17', '2026-10-28'));
    assert.equal(first, guestIpBudgetKey('192.0.2.17', '2026-10-28'));
    assert.notEqual(first, guestIpBudgetKey('192.0.2.17', '2026-10-29'));
    assert.notEqual(first, guestIpBudgetKey('192.0.2.18', '2026-10-28'));
    assert.ok(!first.includes('192.0.2.17'));
    process.env.NODE_ENV = 'production';
    delete process.env.MAIL_ENCRYPTION_KEY;
    process.env.DB_PASS = 'test-only-local-fallback';
    assert.throws(() => guestIpBudgetKey('192.0.2.17', '2026-10-28'), {
      code: 'GUEST_PREVIEW_UNAVAILABLE',
    });
  } finally {
    restore();
  }
});

test(
  'guest reservations are durable, race-safe and idempotent; failures retain allowance and usage has no tenant',
  { skip: !enabled },
  async () => {
    const restore = saveEnvironment([
      'MAIL_ENCRYPTION_KEY',
      'AI_DAILY_APP_LIMIT',
      'GUEST_PREVIEW_DAILY_APP_LIMIT',
      'GUEST_PREVIEW_DAILY_IP_LIMIT',
    ]);
    const sessionId = randomUUID(),
      previewIds: string[] = [],
      rateKeys = new Set<string>();
    let reserved = 0;
    try {
      process.env.MAIL_ENCRYPTION_KEY = createHash('sha256').update(randomUUID()).digest('base64');
      await mutate(
        'INSERT INTO guest_preview_sessions(id,proof_hash,expires_at) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 30 MINUTE))',
        [sessionId, hashToken(randomUUID())],
      );
      await mutate(
        'INSERT INTO ai_daily_budgets(budget_day,total_reserved,guest_reserved) VALUES(UTC_DATE(),0,0) ON DUPLICATE KEY UPDATE total_reserved=total_reserved',
      );
      const [baseline] = await rows(
        "SELECT total_reserved,guest_reserved,DATE_FORMAT(budget_day,'%Y-%m-%d') AS day FROM ai_daily_budgets WHERE budget_day=UTC_DATE()",
      );
      process.env.AI_DAILY_APP_LIMIT = String(Number(baseline.total_reserved) + 100);
      process.env.GUEST_PREVIEW_DAILY_APP_LIMIT = String(Number(baseline.guest_reserved) + 100);
      process.env.GUEST_PREVIEW_DAILY_IP_LIMIT = '3';
      async function create(ip: string) {
        const id = randomUUID();
        previewIds.push(id);
        rateKeys.add(hashToken(guestIpBudgetKey(ip, String(baseline.day))));
        await transaction(async (connection) => {
          await mutate(
            "INSERT INTO guest_previews(id,session_id,request_id,input_hash,status,expires_at) VALUES(?,?,?,?,'processing',DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 30 MINUTE))",
            [id, sessionId, randomUUID(), hashToken(id)],
            connection,
          );
          await reserveGuestAiCall({ previewId: id, ip }, connection);
        });
        return id;
      }
      const concurrent = await Promise.allSettled(
        Array.from({ length: 10 }, () => create('192.0.2.41')),
      );
      const successes = concurrent
        .filter((result): result is PromiseFulfilledResult<string> => result.status === 'fulfilled')
        .map((result) => result.value);
      assert.equal(successes.length, 3);
      assert.ok(
        concurrent
          .filter((result) => result.status === 'rejected')
          .every((result) => result.reason.code === 'GUEST_PREVIEW_LIMIT'),
      );
      await Promise.all(
        Array.from({ length: 6 }, () =>
          transaction((connection) =>
            reserveGuestAiCall({ previewId: successes[0], ip: '192.0.2.41' }, connection),
          ),
        ),
      );
      let [current] = await rows(
        'SELECT total_reserved,guest_reserved FROM ai_daily_budgets WHERE budget_day=UTC_DATE()',
      );
      assert.equal(Number(current.total_reserved) - Number(baseline.total_reserved), 3);
      assert.equal(Number(current.guest_reserved) - Number(baseline.guest_reserved), 3);
      await mutate("UPDATE guest_previews SET status='failed' WHERE id=?", [successes[0]]);
      await assert.rejects(create('192.0.2.41'), { code: 'GUEST_PREVIEW_LIMIT' });
      let invoked = false;
      await assert.rejects(
        withGuestAiUsage({ previewId: successes[0] }, async () => {
          invoked = true;
        }),
        { code: 'GUEST_PREVIEW_CHANGED' },
      );
      assert.equal(invoked, false);
      const usage = {
        provider: 'mock',
        model: 'mock-guest',
        operation: 'guest_preview',
        inputTokens: 20,
        outputTokens: 10,
      };
      await withGuestAiUsage({ previewId: successes[1] }, async () => {
        await recordProviderUsage(usage);
      });
      const [stored] = await rows('SELECT usage_json FROM guest_previews WHERE id=?', [
        successes[1],
      ]);
      assert.deepEqual(
        typeof stored.usage_json === 'string' ? JSON.parse(stored.usage_json) : stored.usage_json,
        usage,
      );
      await assert.rejects(
        withGuestAiUsage({ previewId: successes[1] }, async () => {
          throw new Error('Must not redispatch');
        }),
        { code: 'GUEST_PREVIEW_CHANGED' },
      );

      // A separate request/IP still shares the same durable guest and application counters.
      process.env.GUEST_PREVIEW_DAILY_APP_LIMIT = String(Number(current.guest_reserved));
      await assert.rejects(create('192.0.2.42'), { code: 'GUEST_PREVIEW_CAPACITY' });
      process.env.GUEST_PREVIEW_DAILY_APP_LIMIT = String(Number(baseline.guest_reserved) + 100);
      process.env.AI_DAILY_APP_LIMIT = String(Number(current.total_reserved));
      await assert.rejects(create('192.0.2.43'), { code: 'GUEST_PREVIEW_CAPACITY' });
      process.env.AI_DAILY_APP_LIMIT = String(Number(current.total_reserved) + 2);
      const sharedCap = await Promise.allSettled(
        Array.from({ length: 6 }, (_, index) => create(`192.0.2.${50 + index}`)),
      );
      assert.equal(sharedCap.filter((result) => result.status === 'fulfilled').length, 2);
      assert.ok(
        sharedCap
          .filter((result) => result.status === 'rejected')
          .every((result) => result.reason.code === 'GUEST_PREVIEW_CAPACITY'),
      );
      [current] = await rows(
        'SELECT total_reserved,guest_reserved FROM ai_daily_budgets WHERE budget_day=UTC_DATE()',
      );
      assert.equal(Number(current.total_reserved) - Number(baseline.total_reserved), 5);
      assert.equal(Number(current.guest_reserved) - Number(baseline.guest_reserved), 5);
    } finally {
      const [count] = await rows(
        'SELECT COUNT(*) AS count FROM guest_previews WHERE session_id=? AND reserved_at IS NOT NULL AND reservation_day=UTC_DATE()',
        [sessionId],
      );
      reserved = Number(count.count);
      await mutate(
        'UPDATE ai_daily_budgets SET total_reserved=GREATEST(total_reserved-?,0),guest_reserved=GREATEST(guest_reserved-?,0) WHERE budget_day=UTC_DATE()',
        [reserved, reserved],
      );
      for (const id of previewIds) await mutate('DELETE FROM guest_previews WHERE id=?', [id]);
      await mutate('DELETE FROM guest_preview_sessions WHERE id=?', [sessionId]);
      for (const key of rateKeys)
        await mutate('DELETE FROM auth_rate_limits WHERE bucket_key=?', [key]);
      restore();
    }
  },
);

test(
  'guest cleanup removes expired private data and proof sessions while preserving claimed receipts',
  { skip: !enabled },
  async () => {
    const expired = randomUUID(),
      alive = randomUUID(),
      deletedId = randomUUID(),
      claimedId = randomUUID(),
      aliveId = randomUUID();
    try {
      await mutate(
        'INSERT INTO guest_preview_sessions(id,proof_hash,expires_at) VALUES (?,?,DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 MINUTE)),(?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 10 MINUTE))',
        [expired, hashToken(expired), alive, hashToken(alive)],
      );
      for (const [id, session, status, isExpired] of [
        [deletedId, expired, 'ready', true],
        [claimedId, expired, 'claimed', true],
        [aliveId, alive, 'ready', false],
      ] as const) {
        await mutate(
          `INSERT INTO guest_previews(id,session_id,request_id,input_hash,status,source_text,expires_at,claim_receipt_json) VALUES(?,?,?,?,?,?,${isExpired ? 'DATE_SUB' : 'DATE_ADD'}(UTC_TIMESTAMP(3),INTERVAL 1 MINUTE),?)`,
          [
            id,
            session,
            randomUUID(),
            hashToken(id),
            status,
            status === 'claimed' ? null : 'Fictional test-only source.',
            status === 'claimed' ? JSON.stringify({ serviceId: 'retained-receipt' }) : null,
          ],
        );
      }
      await transaction(cleanupGuestPreviews);
      assert.equal((await rows('SELECT id FROM guest_previews WHERE id=?', [deletedId])).length, 0);
      assert.equal(
        (await rows('SELECT id FROM guest_preview_sessions WHERE id=?', [expired])).length,
        0,
      );
      const [claimed] = await rows(
        'SELECT session_id,source_text,claim_receipt_json FROM guest_previews WHERE id=?',
        [claimedId],
      );
      assert.equal(claimed.session_id, null);
      assert.equal(claimed.source_text, null);
      assert.ok(claimed.claim_receipt_json);
      assert.equal((await rows('SELECT id FROM guest_previews WHERE id=?', [aliveId])).length, 1);
    } finally {
      for (const id of [deletedId, claimedId, aliveId])
        await mutate('DELETE FROM guest_previews WHERE id=?', [id]);
      for (const id of [expired, alive])
        await mutate('DELETE FROM guest_preview_sessions WHERE id=?', [id]);
    }
  },
);
