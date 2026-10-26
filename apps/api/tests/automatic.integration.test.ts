import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import request from 'supertest';
import { mutate, rows, transaction, closeDatabase } from '../src/db.js';

test(
  'approved automatic quotes require independent evidence, verified contacts and safe facts; delivery, budgets and decisions are idempotent',
  { skip: process.env.RUN_DB_TESTS !== '1' },
  async () => {
    process.env.NODE_ENV = 'test';
    process.env.AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'isolated-test-key';
    process.env.MAIL_PROVIDER = 'local';
    process.env.BILLING_PROVIDER = 'local';
    process.env.TRUST_PROXY = '1';
    process.env.AI_DAILY_BUSINESS_LIMIT = '500';
    process.env.AI_DAILY_APP_LIMIT = '999999';
    const realFetch = globalThis.fetch;
    let providerCalls = 0,
      aiNeedsReview = false;
    globalThis.fetch = async (input) => {
      assert.equal(
        String(input),
        'https://api.openai.com/v1/responses',
        'Tests must never contact another external endpoint',
      );
      providerCalls++;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return new Response(
        JSON.stringify({
          status: 'completed',
          usage: { input_tokens: 10, output_tokens: 5 },
          output: [
            {
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    reply: 'Your project details are recorded.',
                    extractedInputs: [],
                    missingInputs: [],
                    needsReview: aiNeedsReview,
                    reviewReason: aiNeedsReview ? 'The access conditions are unclear.' : '',
                  }),
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const { createApp } = await import('../src/app.js');
    const { decryptEmail } = await import('../src/integrations/email.js');
    const app = createApp(),
      owner = request.agent(app),
      origin = 'http://localhost:3100';
    const ipMarker = randomUUID().replaceAll('-', ''),
      fixtureIp = `2001:db8:${ipMarker.slice(0, 4)}:${ipMarker.slice(4, 8)}::1`;
    let businessId: string | undefined;
    try {
      const registration = await owner
        .post('/api/v1/auth/register')
        .set('Origin', origin)
        .send({
          name: 'QA Automation',
          businessName: 'QA Automation',
          email: `qa-automation-${randomUUID()}@example.test`,
          password: 'test password strong123',
        });
      assert.equal(registration.status, 201, JSON.stringify(registration.body));
      businessId = registration.body.data.business.id;
      const slug = registration.body.data.business.slug;
      await owner
        .patch('/api/v1/business')
        .set('Origin', origin)
        .send({ description: 'Routine concrete washing', serviceArea: 'Austin' })
        .expect(200);
      const created = await owner
        .post('/api/v1/services')
        .set('Origin', origin)
        .send({
          name: 'Concrete washing',
          description: 'Concrete driveways and patios',
          unitLabel: 'square feet',
          unitPriceCents: 25,
          basePriceCents: 2000,
          minimumChargeCents: 10000,
          maxAutoQuoteCents: 20000,
          requiredInputs: ['area', 'surface'],
          exclusions: ['Roof cleaning'],
        });
      assert.equal(created.status, 201);
      const serviceId = created.body.data.id;
      await owner
        .patch(`/api/v1/services/${serviceId}`)
        .set('Origin', origin)
        .send({ mode: 'automatic' })
        .expect(409);
      for (const quantity of [400, 500, 600])
        await owner
          .post('/api/v1/examples')
          .set('Origin', origin)
          .send({
            serviceId,
            title: `Historical ${quantity}`,
            description: `Historical concrete project ${quantity}`,
            quantity,
            finalPriceCents: 2000 + quantity * 25,
            rationale: 'Standard area pricing',
          })
          .expect(201);
      const initialEvaluation = await owner
        .post(`/api/v1/services/${serviceId}/evaluate`)
        .set('Origin', origin)
        .send({});
      assert.equal(initialEvaluation.body.data.configurationPassed, true);
      assert.equal(initialEvaluation.body.data.automaticReady, false);
      const noVerifiedOwner = await owner
        .post(`/api/v1/services/${serviceId}/publish`)
        .set('Origin', origin)
        .send({ mode: 'automatic', approveAutomatic: true });
      assert.equal(noVerifiedOwner.status, 409);
      assert.equal(noVerifiedOwner.body.error.code, 'OWNER_EMAIL_UNVERIFIED');
      await mutate('UPDATE users SET email_verified_at = UTC_TIMESTAMP(3) WHERE business_id = ?', [
        businessId!,
      ]);
      const noIndependent = await owner
        .post(`/api/v1/services/${serviceId}/publish`)
        .set('Origin', origin)
        .send({ mode: 'automatic', approveAutomatic: true });
      assert.equal(noIndependent.status, 409);
      assert.equal(noIndependent.body.error.code, 'INDEPENDENT_EVALUATION_REQUIRED');
      const copied = await owner
        .post(`/api/v1/services/${serviceId}/test-cases`)
        .set('Origin', origin)
        .send({
          title: 'Copied teaching project',
          description: 'Historical concrete project 400',
          quantity: 400,
          expectedCents: 12000,
          inputs: { area: '400', surface: 'concrete', location: 'Austin' },
        });
      assert.equal(copied.status, 409);
      assert.equal(copied.body.error.code, 'CASE_NOT_INDEPENDENT');
      for (const quantity of [400, 500, 600])
        await owner
          .post(`/api/v1/services/${serviceId}/test-cases`)
          .set('Origin', origin)
          .send({
            title: `Independent patio ${quantity}`,
            description: `A different concrete patio measuring ${quantity}`,
            quantity,
            expectedCents: 2000 + quantity * 25,
            inputs: { area: String(quantity), surface: 'concrete', location: 'Austin' },
            toleranceCents: 100,
            tolerancePercent: 5,
          })
          .expect(201);
      await owner
        .post(`/api/v1/services/${serviceId}/test-cases`)
        .set('Origin', origin)
        .send({
          title: 'Excluded roof project',
          description: 'Customer wants roof cleaning',
          quantity: 400,
          expectedCents: 0,
          inputs: { area: '400', surface: 'concrete', location: 'Austin' },
          expectedOutcome: 'review',
        })
        .expect(201);
      const evaluation = await owner
        .post(`/api/v1/services/${serviceId}/evaluate`)
        .set('Origin', origin)
        .send({});
      assert.equal(evaluation.body.data.automaticReady, true, JSON.stringify(evaluation.body));
      assert.equal(evaluation.body.data.independentCaseCount, 4);
      assert.equal(evaluation.body.data.languageEvaluation.passed, true);
      assert.equal(evaluation.body.data.languageEvaluation.caseCount, 4);
      const evaluatedModel = evaluation.body.data.languageEvaluation.model;
      process.env.OPENAI_MODEL = 'changed-model-requires-evaluation';
      await owner
        .post(`/api/v1/services/${serviceId}/publish`)
        .set('Origin', origin)
        .send({ mode: 'automatic', approveAutomatic: true })
        .expect(409);
      process.env.OPENAI_MODEL = evaluatedModel;

      const defaultInput = {
        customerName: 'QA Customer',
        customerEmail: 'qa-automatic-customer@example.test',
        quantity: 500,
        description: 'A standard concrete driveway in Austin',
        contactConsent: true,
        inputs: { area: '500', surface: 'concrete', location: 'Austin' },
      };
      const sandbox = await owner
        .post('/api/v1/playground/sessions')
        .set('Origin', origin)
        .send({ serviceId });
      assert.equal(sandbox.status, 201);
      assert.equal(sandbox.body.data.session.source, 'playground');
      assert.equal(sandbox.body.data.session.contact.verified, true);
      const sandboxPath = `/api/v1/public/${slug}/sessions/${sandbox.body.data.session.id}`;
      await request(app)
        .post(`${sandboxPath}/verification`)
        .set('Authorization', `Bearer ${sandbox.body.data.token}`)
        .send({ email: defaultInput.customerEmail })
        .expect(409);
      const sandboxQuote = await request(app)
        .post(`${sandboxPath}/quote`)
        .set('Authorization', `Bearer ${sandbox.body.data.token}`)
        .send(defaultInput);
      assert.equal(sandboxQuote.status, 201, JSON.stringify(sandboxQuote.body));
      assert.equal(sandboxQuote.body.data.status, 'issued');
      const privateDiagnostic = 'Private owner preview: inspect the pricing boundary.';
      await mutate('UPDATE quotes SET review_reason=? WHERE business_id=? AND id=?', [
        privateDiagnostic,
        businessId!,
        sandboxQuote.body.data.id,
      ]);
      const previewView = (
        await request(app)
          .get(sandboxPath)
          .set('Authorization', `Bearer ${sandbox.body.data.token}`)
          .expect(200)
      ).body.data;
      assert.equal(previewView.reviewReason, privateDiagnostic);
      assert.equal(previewView.quote.reviewReason, privateDiagnostic);
      const [sandboxUsage] = await rows(
        'SELECT COUNT(*) AS count FROM quote_usage WHERE business_id = ?',
        [businessId!],
      );
      assert.equal(Number(sandboxUsage.count), 0);
      assert.equal((await owner.get('/api/v1/dashboard')).body.data.stats.totalQuotes, 0);
      await owner
        .post(`/api/v1/services/${serviceId}/publish`)
        .set('Origin', origin)
        .send({ mode: 'automatic' })
        .expect(409);
      const published = await owner
        .post(`/api/v1/services/${serviceId}/publish`)
        .set('Origin', origin)
        .send({ mode: 'automatic', approveAutomatic: true });
      assert.equal(published.status, 200);
      assert.equal(published.body.data.approvedVersion, published.body.data.version);
      await owner
        .patch('/api/v1/business')
        .set('Origin', origin)
        .send({ autoQuoteEnabled: true })
        .expect(200);

      async function start(verified = true) {
        const response = await request(app)
          .post(`/api/v1/public/${slug}/sessions`)
          .send({ serviceId });
        assert.equal(response.status, 201);
        const id = response.body.data.session.id,
          token = response.body.data.token,
          path = `/api/v1/public/${slug}/sessions/${id}`;
        if (verified) {
          const verification = await request(app)
            .post(`${path}/verification`)
            .set('X-Forwarded-For', fixtureIp)
            .set('Authorization', `Bearer ${token}`)
            .send({ email: defaultInput.customerEmail });
          assert.equal(verification.status, 200, JSON.stringify(verification.body));
          assert.ok(verification.body.data.devCode);
          const confirmed = await request(app)
            .post(`${path}/verify-contact`)
            .set('Authorization', `Bearer ${token}`)
            .send({
              verificationId: verification.body.data.verificationId,
              code: verification.body.data.devCode,
            });
          assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
        }
        return { id, token, path };
      }
      const issuedSession = await start();
      const beforeCalls = providerCalls;
      const simultaneous = await Promise.all(
        [0, 1].map(() =>
          request(app)
            .post(`${issuedSession.path}/quote`)
            .set('Authorization', `Bearer ${issuedSession.token}`)
            .send(defaultInput),
        ),
      );
      assert.ok(simultaneous.some((response) => response.status === 201));
      assert.ok(simultaneous.every((response) => [200, 201, 409].includes(response.status)));
      const issued = simultaneous.find((response) => [200, 201].includes(response.status))!.body
        .data;
      assert.equal(issued.status, 'issued');
      assert.equal(issued.totalCents, 14500);
      assert.equal(issued.issuedBy, 'automatic');
      assert.equal(
        providerCalls - beforeCalls,
        1,
        'The durable quote lease prevents duplicate model spend',
      );
      const usageBeforeRetry = (
        await rows(
          "SELECT COUNT(*) AS count FROM usage_events WHERE business_id = ? AND kind = 'ai_reservation'",
          [businessId!],
        )
      )[0].count;
      await request(app)
        .post(`${issuedSession.path}/quote`)
        .set('Authorization', `Bearer ${issuedSession.token}`)
        .send(defaultInput)
        .expect(200);
      const [usageAfterRetry] = await rows(
        "SELECT COUNT(*) AS count FROM usage_events WHERE business_id = ? AND kind = 'ai_reservation'",
        [businessId!],
      );
      assert.equal(usageAfterRetry.count, usageBeforeRetry);
      const ledger = await rows(
        'SELECT * FROM quote_usage WHERE business_id = ? AND quote_id = ?',
        [businessId!, issued.id],
      );
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0].source, 'automatic');
      assert.equal(Number(ledger[0].verified_contact), 1);
      assert.equal(Number(ledger[0].trial_covered), 1);
      const delivered = await rows(
        "SELECT id FROM usage_events WHERE business_id = ? AND quote_id = ? AND kind = 'quote_delivered'",
        [businessId!, issued.id],
      );
      assert.equal(delivered.length, 1);
      const [email] = await rows(
        'SELECT payload_encrypted FROM email_outbox WHERE business_id = ? AND dedupe_key = ?',
        [businessId!, `quote:${issued.id}:issued`],
      );
      assert.ok(email, 'Issued quote notification must be durable in the same transaction');
      const [ownerEmail] = await rows(
        'SELECT payload_encrypted FROM email_outbox WHERE business_id = ? AND dedupe_key = ?',
        [businessId!, `quote:${issued.id}:owner-issued`],
      );
      assert.ok(ownerEmail, 'The owner hears about every automatic quote');
      const ownerNotice = decryptEmail(ownerEmail.payload_encrypted);
      assert.match(ownerNotice.subject, /^Quote sent: \$145\.00 to /);
      assert.ok(ownerNotice.text.includes(`/dashboard/quotes?quote=${issued.id}`));
      const emailText = decryptEmail(email.payload_encrypted).text,
        resumeUrl = new URL(emailText.match(/https?:\/\/\S+/)![0]);
      const resumeParameters = resumeUrl.hash
        ? new URLSearchParams(resumeUrl.hash.slice(1))
        : resumeUrl.searchParams;
      assert.equal(resumeParameters.get('session'), issuedSession.id);
      const emailedToken = resumeParameters.get('token');
      assert.ok(emailedToken);
      assert.notEqual(emailedToken, issuedSession.token);
      await request(app)
        .get(issuedSession.path)
        .set('Authorization', `Bearer ${emailedToken}`)
        .expect(200);
      await mutate(
        'UPDATE public_sessions SET email_token_expires_at = DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE business_id = ? AND id = ?',
        [businessId!, issuedSession.id],
      );
      await request(app)
        .get(issuedSession.path)
        .set('Authorization', `Bearer ${emailedToken}`)
        .expect(404);
      await request(app)
        .get(issuedSession.path)
        .set('Authorization', `Bearer ${issuedSession.token}`)
        .expect(200);
      await mutate('UPDATE quotes SET review_reason=? WHERE business_id=? AND id=?', [
        'Private automatic decision details',
        businessId!,
        issued.id,
      ]);
      const accepted = await request(app)
        .post(`${issuedSession.path}/decision`)
        .set('Authorization', `Bearer ${issuedSession.token}`)
        .send({ decision: 'accepted' })
        .expect(200);
      assert.equal(accepted.body.data.reviewReason, undefined);
      const acceptedAgain = await request(app)
        .post(`${issuedSession.path}/decision`)
        .set('Authorization', `Bearer ${issuedSession.token}`)
        .send({ decision: 'accepted' })
        .expect(200);
      assert.equal(acceptedAgain.body.data.reviewReason, undefined);
      await request(app)
        .post(`${issuedSession.path}/decision`)
        .set('Authorization', `Bearer ${issuedSession.token}`)
        .send({ decision: 'declined' })
        .expect(409);

      const callsBeforeUnverified = providerCalls;
      const unverified = await start(false),
        unverifiedQuote = await request(app)
          .post(`${unverified.path}/quote`)
          .set('Authorization', `Bearer ${unverified.token}`)
          .send(defaultInput);
      assert.equal(unverifiedQuote.body.data.status, 'review');
      assert.equal(unverifiedQuote.body.data.totalCents, 0);
      assert.equal(
        providerCalls,
        callsBeforeUnverified,
        'Unverified final submissions cannot consume extra model calls',
      );
      const missing = await start(),
        missingQuote = await request(app)
          .post(`${missing.path}/quote`)
          .set('Authorization', `Bearer ${missing.token}`)
          .send({ ...defaultInput, inputs: { area: '500', location: 'Austin' } });
      assert.equal(missingQuote.body.data.status, 'review');
      assert.equal(
        missingQuote.body.data.reviewReason,
        undefined,
        'Private review diagnostics are not customer-facing',
      );
      const liveView = await request(app)
        .get(missing.path)
        .set('Authorization', `Bearer ${missing.token}`)
        .expect(200);
      assert.equal(liveView.body.data.reviewReason, undefined);
      assert.equal(liveView.body.data.quote.reviewReason, undefined);
      const ownerQuotes = (await owner.get('/api/v1/quotes').expect(200)).body.data;
      assert.match(
        ownerQuotes.find((quote: any) => quote.id === missingQuote.body.data.id).reviewReason,
        /surface/,
      );
      const beforeFollowup = providerCalls;
      const ownerMessage = await owner
        .post(`/api/v1/quotes/${missingQuote.body.data.id}/messages`)
        .set('Origin', origin)
        .send({ content: 'What material is the surface?' });
      assert.equal(ownerMessage.status, 200);
      assert.equal(ownerMessage.body.data.messages.at(-1).author, 'owner');
      const customerFollowup = await request(app)
        .post(`${missing.path}/messages`)
        .set('Authorization', `Bearer ${missing.token}`)
        .send({ content: 'The surface is concrete.' });
      assert.equal(customerFollowup.status, 200);
      assert.equal(customerFollowup.body.data.session.humanHandoff, true);
      assert.equal(providerCalls, beforeFollowup, 'Owner handoff stops AI replies');
      await request(app)
        .post(`${missing.path}/messages`)
        .set('Authorization', `Bearer ${missing.token}`)
        .send({ content: 'Thanks for checking.' })
        .expect(200);
      const [replyNotifications] = await rows(
        'SELECT COUNT(*) AS count FROM email_outbox WHERE business_id = ? AND dedupe_key LIKE ?',
        [businessId!, `quote:${missingQuote.body.data.id}:customer-message:%`],
      );
      assert.equal(
        Number(replyNotifications.count),
        1,
        'Customer followup notifications are durable and debounced',
      );
      const excluded = await start(),
        excludedQuote = await request(app)
          .post(`${excluded.path}/quote`)
          .set('Authorization', `Bearer ${excluded.token}`)
          .send({ ...defaultInput, description: 'I need roof cleaning' });
      assert.equal(excludedQuote.body.data.status, 'review');
      const spoofed = await start(false);
      await request(app)
        .post(`${spoofed.path}/quote`)
        .set('Authorization', `Bearer ${spoofed.token}`)
        .send({ ...defaultInput, needsReview: false, verifiedContact: true })
        .expect(400);
      aiNeedsReview = true;
      const ambiguous = await start(),
        ambiguousQuote = await request(app)
          .post(`${ambiguous.path}/quote`)
          .set('Authorization', `Bearer ${ambiguous.token}`)
          .send(defaultInput);
      assert.equal(ambiguousQuote.body.data.status, 'review');
      aiNeedsReview = false;
      await owner
        .patch('/api/v1/business')
        .set('Origin', origin)
        .send({ autoQuoteEnabled: false })
        .expect(200);
      const paused = await start(),
        pausedQuote = await request(app)
          .post(`${paused.path}/quote`)
          .set('Authorization', `Bearer ${paused.token}`)
          .send(defaultInput);
      assert.equal(pausedQuote.body.data.status, 'review');
      await owner
        .patch('/api/v1/business')
        .set('Origin', origin)
        .send({ autoQuoteEnabled: true })
        .expect(200);
      const limited = await start();
      await mutate(
        "UPDATE billing_accounts SET trial_ends_at = DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 DAY),trial_quote_limit=0,subscription_status='past_due' WHERE business_id = ?",
        [businessId!],
      );
      const limitedQuote = await request(app)
        .post(`${limited.path}/quote`)
        .set('Authorization', `Bearer ${limited.token}`)
        .send(defaultInput);
      assert.equal(limitedQuote.body.data.status, 'review');
      const unknown = await start(false),
        unknownQuote = await request(app)
          .post(`${unknown.path}/quote`)
          .set('Authorization', `Bearer ${unknown.token}`)
          .send({
            ...defaultInput,
            quantity: 1,
            quantityUnknown: true,
            inputs: { surface: 'concrete', location: 'Austin' },
          });
      assert.equal(unknownQuote.body.data.status, 'review');
      await owner
        .post(`/api/v1/quotes/${unknownQuote.body.data.id}/approve`)
        .set('Origin', origin)
        .send({})
        .expect(409);
      await owner
        .patch(`/api/v1/quotes/${unknownQuote.body.data.id}`)
        .set('Origin', origin)
        .send({ totalCents: 17500, reason: 'Measured scope and final price confirmed by owner' })
        .expect(200);
      await owner
        .post(`/api/v1/quotes/${unknownQuote.body.data.id}/approve`)
        .set('Origin', origin)
        .send({})
        .expect(200);
      const custom = await start(false),
        customQuote = await request(app)
          .post(`${custom.path}/quote`)
          .set('Authorization', `Bearer ${custom.token}`)
          .send({
            ...defaultInput,
            quantity: 10_000_000,
            inputs: { ...defaultInput.inputs, area: '10000000' },
          });
      assert.equal(customQuote.status, 201);
      assert.equal(customQuote.body.data.status, 'review');
      await owner
        .post(`/api/v1/quotes/${customQuote.body.data.id}/approve`)
        .set('Origin', origin)
        .send({})
        .expect(409);
      const stale = await start(false);
      const changedService = await owner
        .patch(`/api/v1/services/${serviceId}`)
        .set('Origin', origin)
        .send({ unitPriceCents: 26 });
      assert.equal(changedService.status, 200);
      assert.equal(changedService.body.data.basePriceCents, 2000);
      assert.equal(changedService.body.data.minimumChargeCents, 10000);
      assert.deepEqual(changedService.body.data.requiredInputs, ['area', 'surface']);
      const staleQuote = await request(app)
        .post(`${stale.path}/quote`)
        .set('Authorization', `Bearer ${stale.token}`)
        .send(defaultInput);
      assert.equal(staleQuote.status, 201);
      assert.equal(staleQuote.body.data.status, 'review');
      const [automaticCount] = await rows(
        "SELECT COUNT(*) AS count FROM quote_usage WHERE business_id = ? AND source='automatic'",
        [businessId!],
      );
      assert.equal(
        Number(automaticCount.count),
        1,
        'All review and owner-test cases are excluded from automatic usage',
      );
    } finally {
      globalThis.fetch = realFetch;
      await mutate('DELETE FROM auth_rate_limits WHERE bucket_key = ?', [
        createHash('sha256').update(`contact-ip:${fixtureIp}`).digest('hex'),
      ]);
      if (businessId)
        await transaction(async (connection) => {
          const days = await rows(
            "SELECT DATE(created_at) AS day,COUNT(*) AS count FROM usage_events WHERE business_id=? AND kind='ai_reservation' GROUP BY DATE(created_at)",
            [businessId!],
            connection,
          );
          for (const day of days) {
            await rows(
              'SELECT total_reserved FROM ai_daily_budgets WHERE budget_day=? FOR UPDATE',
              [day.day],
              connection,
            );
            await mutate(
              'UPDATE ai_daily_budgets SET total_reserved=GREATEST(0,total_reserved-?) WHERE budget_day=?',
              [Number(day.count), day.day],
              connection,
            );
          }
          await mutate(
            'DELETE FROM owner_sessions WHERE user_id IN (SELECT id FROM users WHERE business_id=?)',
            [businessId!],
            connection,
          );
          for (const table of [
            'attachments',
            'usage_events',
            'jobs',
            'quotes',
            'public_sessions',
            'messages',
            'training_sessions',
            'evaluations',
            'examples',
            'service_test_cases',
            'services',
            'users',
          ])
            await mutate(`DELETE FROM ${table} WHERE business_id=?`, [businessId!], connection);
          await mutate('DELETE FROM businesses WHERE id=?', [businessId!], connection);
        });
      await closeDatabase();
    }
  },
);
