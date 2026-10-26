import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import request from 'supertest';
import { closeDatabase, mutate, rows } from '../src/db.js';

test(
  'explicit owner updates create independent seven-day email access while stale grants fail closed at access and dispatch',
  { skip: process.env.RUN_DB_TESTS !== '1' },
  async () => {
    process.env.NODE_ENV = 'test';
    process.env.AI_PROVIDER = 'demo';
    process.env.MAIL_PROVIDER = 'local';
    process.env.BILLING_PROVIDER = 'local';
    process.env.MAIL_ENCRYPTION_KEY = Buffer.alloc(32, 0x8c).toString('base64');
    const realFetch = globalThis.fetch,
      realSend = SESv2Client.prototype.send;
    let providerCalls = 0,
      mailSends = 0;
    globalThis.fetch = async () => {
      providerCalls++;
      throw new Error('No external provider calls are allowed');
    };
    (SESv2Client.prototype as any).send = async () => ({ MessageId: `mock-mail-${++mailSends}` });
    const { createApp } = await import('../src/app.js'),
      { decryptEmail, encryptEmail, deliverEmail, queueEmail } =
        await import('../src/integrations/email.js'),
      { deleteBusinessAccount } = await import('../src/accounts.js'),
      { runOneJob } = await import('../src/worker.js');
    const app = createApp(),
      owner = request.agent(app),
      origin = 'http://localhost:3100';
    let businessId = '',
      slug = '',
      serviceId = '';
    const get = (access: any) =>
      request(app)
        .get(`/api/v1/public/${slug}/sessions/${access.sessionId}`)
        .set('Authorization', `Bearer ${access.token}`);
    const sendReply = (quoteId: string, content = 'Please review the project details here.') =>
      owner.post(`/api/v1/quotes/${quoteId}/messages`).set('Origin', origin).send({ content });
    const approve = (quoteId: string) =>
      owner.post(`/api/v1/quotes/${quoteId}/approve`).set('Origin', origin).send({});
    const email = async (quoteId: string, event: 'issued' | 'owner_message') => {
      const [row] = await rows(
        `SELECT * FROM email_outbox WHERE business_id=? AND dedupe_key ${event === 'issued' ? '= ?' : 'LIKE ?'} ORDER BY created_at DESC,id DESC LIMIT 1`,
        [
          businessId,
          event === 'issued' ? `quote:${quoteId}:issued` : `quote:${quoteId}:owner-message:%`,
        ],
      );
      assert.ok(row, 'A durable customer notification must exist');
      const payload = decryptEmail(String(row.payload_encrypted)),
        access = payload.requestAccess!;
      assert.ok(access, 'Private request mail must carry encrypted structured grant metadata');
      const url = new URL(payload.text.match(/https?:\/\/\S+/)![0]),
        parameters = new URLSearchParams(url.hash.slice(1));
      assert.equal(parameters.get('session'), access.sessionId);
      assert.equal(access.quoteId, quoteId);
      assert.equal(access.event, event);
      assert.equal(String(row.payload_encrypted).includes(access.tokenHash), false);
      return { row, payload, access, sessionId: access.sessionId, token: parameters.get('token')! };
    };
    const verify = async (access: any, address: string) => {
      const path = `/api/v1/public/${slug}/sessions/${access.sessionId}`,
        previousProvider = process.env.MAIL_PROVIDER;
      process.env.MAIL_PROVIDER = 'local';
      try {
        const challenge = (
          await request(app)
            .post(`${path}/verification`)
            .set('Authorization', `Bearer ${access.token}`)
            .send({ email: address })
            .expect(200)
        ).body.data;
        await request(app)
          .post(`${path}/verify-contact`)
          .set('Authorization', `Bearer ${access.token}`)
          .send({ verificationId: challenge.verificationId, code: challenge.devCode })
          .expect(200);
      } finally {
        process.env.MAIL_PROVIDER = previousProvider;
      }
    };
    const inquiry = async (verified = true) => {
      const started = (
        await request(app)
          .post(`/api/v1/public/${slug}/sessions`)
          .set('Origin', origin)
          .send({ serviceId })
          .expect(201)
      ).body.data;
      const access = { sessionId: started.session.id, token: started.token },
        address = `fixture-${randomUUID()}@example.test`;
      const quote = (
        await request(app)
          .post(`/api/v1/public/${slug}/sessions/${access.sessionId}/quote`)
          .set('Authorization', `Bearer ${access.token}`)
          .send({
            customerName: 'Fictional customer',
            customerEmail: address,
            quantity: 1,
            quantityUnknown: true,
            description: 'A household appliance needs diagnosis in Austin',
            inputs: { location: 'Austin' },
            contactConsent: true,
          })
          .expect(201)
      ).body.data;
      if (verified) await verify(access, address);
      await owner
        .patch(`/api/v1/quotes/${quote.id}`)
        .set('Origin', origin)
        .send({ totalCents: 22500, reason: 'Owner reviewed the project and set its final price' })
        .expect(200);
      return { ...access, quoteId: quote.id, address };
    };
    const expireOriginal = async (access: any) => {
      await mutate(
        'UPDATE public_sessions SET created_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 90 DAY),expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 83 DAY) WHERE business_id=? AND id=?',
        [businessId, access.sessionId],
      );
      await mutate(
        'UPDATE contact_verifications SET created_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 90 DAY),expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 90 DAY) WHERE business_id=? AND session_id=?',
        [businessId, access.sessionId],
      );
      return (
        await rows(
          'SELECT token_hash,expires_at FROM public_sessions WHERE business_id=? AND id=?',
          [businessId, access.sessionId],
        )
      )[0];
    };
    const configureMockSes = () => {
      process.env.MAIL_PROVIDER = 'ses';
      process.env.SES_EMAIL_FROM = 'sender@example.test';
      process.env.AWS_REGION = 'us-east-1';
    };
    const skipped = async (id: string, reason: RegExp) => {
      const sendsBefore = mailSends;
      await deliverEmail(id);
      const [row] = await rows('SELECT * FROM email_outbox WHERE id=?', [id]);
      assert.equal(row.status, 'skipped');
      assert.match(row.last_error, reason);
      assert.equal(row.sent_at, null);
      assert.equal(row.provider_message_id, null);
      await deliverEmail(id);
      const [job] = await rows('SELECT id FROM jobs WHERE dedupe_key=?', [`mail:${id}`]);
      assert.ok(await runOneJob(job.id));
      assert.equal(
        (await rows('SELECT status FROM jobs WHERE id=?', [job.id]))[0].status,
        'completed',
      );
      assert.equal(mailSends, sendsBefore, 'Skipped/replayed jobs must not send any email');
    };
    try {
      const registered = (
        await owner
          .post('/api/v1/auth/register')
          .set('Origin', origin)
          .send({
            name: 'Request access QA',
            businessName: 'Fictional request access QA',
            email: `qa-request-access-${randomUUID()}@example.test`,
            password: 'request-access-fixture123',
          })
          .expect(201)
      ).body.data;
      businessId = registered.business.id;
      slug = registered.business.slug;
      await mutate('UPDATE users SET email_verified_at=UTC_TIMESTAMP(3) WHERE business_id=?', [
        businessId,
      ]);
      await owner
        .patch('/api/v1/business')
        .set('Origin', origin)
        .send({ description: 'Household appliance diagnosis', serviceArea: 'Austin' })
        .expect(200);
      serviceId = (
        await owner
          .post('/api/v1/services')
          .set('Origin', origin)
          .send({
            name: 'Appliance diagnosis',
            description: 'Household appliance diagnosis',
            unitLabel: 'project',
            unitPriceCents: 0,
            basePriceCents: 0,
            minimumChargeCents: 0,
            requiredInputs: [],
          })
          .expect(201)
      ).body.data.id;
      await owner
        .post(`/api/v1/services/${serviceId}/publish`)
        .set('Origin', origin)
        .send({ mode: 'review' })
        .expect(200);

      const original = await inquiry(),
        originalRecord = await expireOriginal(original);
      await get(original).expect(404);
      const beforeReply = Date.now();
      await sendReply(original.quoteId).expect(200);
      const first = await email(original.quoteId, 'owner_message');
      assert.ok(Date.parse(first.access.expiresAt) >= beforeReply + 7 * 86400000);
      assert.ok(Date.parse(first.access.expiresAt) <= Date.now() + 7 * 86400000);
      const fresh = (await get(first).expect(200)).body.data;
      assert.equal(fresh.expiresAt, first.access.expiresAt);
      assert.equal(fresh.contact.verified, true);
      assert.equal(fresh.humanHandoff, true);
      await get(original).expect(404);
      await request(app)
        .post(`/api/v1/public/${slug}/sessions/${original.sessionId}/verification`)
        .set('Authorization', `Bearer ${original.token}`)
        .send({ email: original.address })
        .expect(404);
      await request(app)
        .post(`/api/v1/public/${slug}/sessions/${original.sessionId}/verify-contact`)
        .set('Authorization', `Bearer ${original.token}`)
        .send({ verificationId: randomUUID(), code: '000000' })
        .expect(404);
      await verify(first, original.address);
      assert.equal(
        (await get(first).expect(200)).body.data.contact.verified,
        true,
        'Renewed access can verify contact without extending the original browser',
      );
      const beforeGet = JSON.stringify(
        await rows('SELECT * FROM public_sessions WHERE id=?', [original.sessionId]),
      );
      await get(first).expect(200);
      await get(first).expect(200);
      assert.equal(
        JSON.stringify(
          await rows('SELECT * FROM public_sessions WHERE id=?', [original.sessionId]),
        ),
        beforeGet,
        'GET and restore must never rotate or renew access',
      );
      await approve(original.quoteId).expect(200);
      const issued = await email(original.quoteId, 'issued');
      await get(first).expect(404);
      const issuedView = (await get(issued).expect(200)).body.data;
      assert.equal(issuedView.expiresAt, issued.access.expiresAt);
      assert.equal(issuedView.quote.status, 'issued');
      assert.equal(issuedView.quote.totalCents, 22500);
      assert.equal(issuedView.contact.verified, true);
      const [issuedRecord] = await rows('SELECT verified_contact FROM quotes WHERE id=?', [
        original.quoteId,
      ]);
      assert.equal(Number(issuedRecord.verified_contact), 1);
      const [afterGrant] = await rows(
        'SELECT token_hash,expires_at,email_token_hash,email_token_expires_at FROM public_sessions WHERE id=?',
        [original.sessionId],
      );
      assert.equal(afterGrant.token_hash, originalRecord.token_hash);
      assert.equal(
        new Date(afterGrant.expires_at).getTime(),
        new Date(originalRecord.expires_at).getTime(),
      );
      const beforeApprovalRetry = JSON.stringify(afterGrant);
      await approve(original.quoteId).expect(200);
      assert.equal(
        JSON.stringify(
          (
            await rows(
              'SELECT token_hash,expires_at,email_token_hash,email_token_expires_at FROM public_sessions WHERE id=?',
              [original.sessionId],
            )
          )[0],
        ),
        beforeApprovalRetry,
      );
      assert.equal(
        Number(
          (
            await rows('SELECT COUNT(*) AS count FROM email_outbox WHERE dedupe_key=?', [
              `quote:${original.quoteId}:issued`,
            ])
          )[0].count,
        ),
        1,
      );
      configureMockSes();
      await skipped(first.row.id, /replaced/);
      await deliverEmail(issued.row.id);
      await deliverEmail(issued.row.id);
      assert.equal(mailSends, 1);
      assert.equal(
        (await rows('SELECT status FROM email_outbox WHERE id=?', [issued.row.id]))[0].status,
        'sent',
      );

      await sendReply(original.quoteId, 'Please confirm that this scope is correct.').expect(200);
      const next = await email(original.quoteId, 'owner_message');
      await get(issued).expect(404);
      await get(original).expect(404);
      await get(next).expect(200);
      await request(app)
        .post(`/api/v1/public/${slug}/sessions/${next.sessionId}/messages`)
        .set('Authorization', `Bearer ${next.token}`)
        .send({ content: 'The scope is correct.' })
        .expect(200);
      await request(app)
        .post(`/api/v1/public/${slug}/sessions/${next.sessionId}/decision`)
        .set('Authorization', `Bearer ${next.token}`)
        .send({ decision: 'accepted' })
        .expect(200);
      const closedGrant = JSON.stringify(
        (
          await rows(
            'SELECT email_token_hash,email_token_expires_at FROM public_sessions WHERE id=?',
            [next.sessionId],
          )
        )[0],
      );
      await sendReply(original.quoteId).expect(409);
      await approve(original.quoteId).expect(409);
      assert.equal(
        JSON.stringify(
          (
            await rows(
              'SELECT email_token_hash,email_token_expires_at FROM public_sessions WHERE id=?',
              [next.sessionId],
            )
          )[0],
        ),
        closedGrant,
      );
      await skipped(next.row.id, /unavailable/);

      const lateIssue = await inquiry(),
        lateOriginal = await expireOriginal(lateIssue);
      await approve(lateIssue.quoteId).expect(200);
      const late = await email(lateIssue.quoteId, 'issued');
      assert.equal((await get(late).expect(200)).body.data.contact.verified, true);
      assert.equal(
        Number(
          (await rows('SELECT verified_contact FROM quotes WHERE id=?', [lateIssue.quoteId]))[0]
            .verified_contact,
        ),
        1,
        'A late initial approval records the verified newly granted contact',
      );
      assert.equal(
        new Date(
          (
            await rows('SELECT expires_at FROM public_sessions WHERE id=?', [lateIssue.sessionId])
          )[0].expires_at,
        ).getTime(),
        new Date(lateOriginal.expires_at).getTime(),
      );
      await get(lateIssue).expect(404);
      await request(app)
        .get(`/api/v1/public/${slug}/sessions/${original.sessionId}`)
        .set('Authorization', `Bearer ${late.token}`)
        .expect(404);
      const past = new Date(Date.now() - 1000).toISOString();
      await mutate('UPDATE public_sessions SET email_token_expires_at=? WHERE id=?', [
        new Date(past),
        late.sessionId,
      ]);
      await mutate('UPDATE email_outbox SET payload_encrypted=? WHERE id=?', [
        encryptEmail({ ...late.payload, requestAccess: { ...late.access, expiresAt: past } }),
        late.row.id,
      ]);
      await get(late).expect(404);
      await get(lateIssue).expect(404);
      await skipped(late.row.id, /expired/);

      const stillLive = await inquiry(),
        browserExpiry = new Date(Date.now() + 3600000);
      await mutate('UPDATE public_sessions SET expires_at=? WHERE id=?', [
        browserExpiry,
        stillLive.sessionId,
      ]);
      await approve(stillLive.quoteId).expect(200);
      const liveEmail = await email(stillLive.quoteId, 'issued');
      assert.equal(
        (await get(stillLive).expect(200)).body.data.expiresAt,
        browserExpiry.toISOString(),
      );
      assert.equal(
        (await get(liveEmail).expect(200)).body.data.expiresAt,
        liveEmail.access.expiresAt,
        'Each capability reports its own expiry, never the maximum',
      );
      await mutate('UPDATE public_sessions SET verified_email=? WHERE id=?', [
        'different@example.test',
        stillLive.sessionId,
      ]);
      await skipped(liveEmail.row.id, /verified inquiry contact/);

      const unverified = await inquiry(false);
      await expireOriginal(unverified);
      await approve(unverified.quoteId).expect(200);
      assert.equal(
        Number(
          (
            await rows('SELECT COUNT(*) AS count FROM email_outbox WHERE dedupe_key=?', [
              `quote:${unverified.quoteId}:issued`,
            ])
          )[0].count,
        ),
        0,
      );
      assert.equal(
        (
          await rows('SELECT email_token_hash FROM public_sessions WHERE id=?', [
            unverified.sessionId,
          ])
        )[0].email_token_hash,
        null,
      );
      await get(unverified).expect(404);

      const legacyId = await queueEmail({
        businessId,
        dedupeKey: `quote:${lateIssue.quoteId}:owner-message:${randomUUID()}`,
        to: lateIssue.address,
        subject: 'Legacy private update',
        text: 'Legacy private link text must not bypass structured validation.',
      });
      await skipped(legacyId, /Legacy/);
      const identityId = await queueEmail({
        businessId,
        dedupeKey: `identity-fixture:${randomUUID()}`,
        to: 'identity@example.test',
        subject: 'Identity verification',
        text: 'An unrelated identity email remains deliverable.',
      });
      const dashboardId = await queueEmail({
        businessId,
        dedupeKey: `quote:${randomUUID()}:review`,
        to: 'owner@example.test',
        subject: 'New request',
        text: `${origin}/dashboard/quotes`,
      });
      await deliverEmail(identityId);
      await deliverEmail(dashboardId);
      assert.equal(mailSends, 3, 'Unrelated identity and owner-dashboard messages are unaffected');

      const revokedConsent = await inquiry();
      await approve(revokedConsent.quoteId).expect(200);
      const consentMail = await email(revokedConsent.quoteId, 'issued');
      await mutate('UPDATE public_sessions SET contact_consent_at=NULL WHERE id=?', [
        revokedConsent.sessionId,
      ]);
      await skipped(consentMail.row.id, /verified inquiry contact/);
      await mutate('UPDATE public_sessions SET contact_consent_at=UTC_TIMESTAMP(3) WHERE id=?', [
        revokedConsent.sessionId,
      ]);
      await sendReply(revokedConsent.quoteId).expect(200);
      const deletedMail = await email(revokedConsent.quoteId, 'owner_message');
      await mutate('UPDATE businesses SET deletion_requested_at=UTC_TIMESTAMP(3) WHERE id=?', [
        businessId,
      ]);
      await get(deletedMail).expect(404);
      await skipped(deletedMail.row.id, /unavailable/);
      assert.equal(mailSends, 3);
      assert.equal(providerCalls, 0);
      const deletionId = randomUUID();
      await mutate('INSERT INTO account_deletion_audits(id,business_id,status) VALUES (?,?,?)', [
        deletionId,
        businessId,
        'scheduled',
      ]);
      await deleteBusinessAccount(businessId, deletionId);
      businessId = '';
      await get(deletedMail).expect(404);
      await deliverEmail(deletedMail.row.id);
      assert.equal(mailSends, 3, 'A deleted notification cannot reach the mail provider');
    } finally {
      globalThis.fetch = realFetch;
      (SESv2Client.prototype as any).send = realSend;
      process.env.MAIL_PROVIDER = 'local';
      if (businessId) {
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
