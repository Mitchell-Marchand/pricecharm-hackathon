import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import sharp from 'sharp';
import { closeDatabase, mutate, rows } from '../src/db.js';

test(
  'practice photos persist partial successes, retry only missing views, isolate tenants and retain teaching links',
  { skip: process.env.RUN_DB_TESTS !== '1' },
  async () => {
    process.env.NODE_ENV = 'test';
    process.env.AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'mock-only-image-key';
    process.env.OPENAI_MODEL = 'mock-model';
    process.env.MAIL_PROVIDER = 'local';
    process.env.BILLING_PROVIDER = 'local';
    process.env.AI_DAILY_BUSINESS_LIMIT = '100';
    process.env.AI_DAILY_APP_LIMIT = '999999';
    const originalFetch = globalThis.fetch,
      ids: string[] = [];
    let textCalls = 0,
      imageCalls = 0,
      failSecond = true,
      unsolicitedPhotos = false;
    let unsolicitedReply = '';
    let lastTextBody: any;
    const bodies: any[] = [];
    const sample = await sharp({
      create: { width: 120, height: 80, channels: 3, background: '#b9b0a5' },
    })
      .jpeg()
      .toBuffer();
    const scenario = {
      title: 'Three-room painting practice',
      customerName: 'Fictional customer',
      description: 'Please paint my living room, kitchen and bedroom.',
      details: [
        { name: 'quantity', value: '3 rooms' },
        { name: 'rooms', value: 'Living room, kitchen, bedroom' },
        { name: 'condition', value: 'Ordinary scuffs on painted walls' },
        { name: 'location', value: 'Austin' },
        { name: 'access', value: 'Ground level' },
      ],
    };
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(url) === 'https://api.openai.com/v1/images/generations') {
        imageCalls++;
        bodies.push(body);
        if (failSecond && imageCalls === 2)
          return Response.json(
            { error: { message: 'Mock transient image failure' } },
            { status: 503 },
          );
        return Response.json({
          data: [{ b64_json: sample.toString('base64') }],
          usage: { input_tokens: 12, output_tokens: 34 },
        });
      }
      assert.equal(String(url), 'https://api.openai.com/v1/responses');
      textCalls++;
      lastTextBody = body;
      const result = String(body.instructions).includes('Create one explicitly fictional')
        ? scenario
        : {
            reply: unsolicitedPhotos ? unsolicitedReply : 'I will send the photos shortly.',
            photoRequest: unsolicitedPhotos
              ? {
                  scenes: [
                    {
                      subject: 'unsolicited new angle',
                      title: 'Unrequested new view',
                      description: 'Another view of the fictional project.',
                    },
                  ],
                }
              : null,
          };
      return Response.json({
        status: 'completed',
        usage: { input_tokens: 10, output_tokens: 5 },
        output: [{ content: [{ type: 'output_text', text: JSON.stringify(result) }] }],
      });
    };
    const { createApp } = await import('../src/app.js');
    const { deleteBusinessAccount } = await import('../src/accounts.js');
    const { runOneJob } = await import('../src/worker.js');
    const { addMessage, trainingById } = await import('../src/models.js');
    const { processTrainingPhotos } = await import('../src/training-photos.js');
    const app = createApp(),
      owner = request.agent(app),
      other = request.agent(app),
      origin = 'http://localhost:3100';
    try {
      for (const agent of [owner, other]) {
        const registered = await agent
          .post('/api/v1/auth/register')
          .set('Origin', origin)
          .send({
            name: 'Photo QA',
            businessName: 'Photo QA',
            email: `qa-photo-${randomUUID()}@example.test`,
            password: 'fictional-photo-test-password123',
          })
          .expect(201);
        ids.push(registered.body.data.business.id);
      }
      const businessId = ids[0];
      const service = (
        await owner
          .post('/api/v1/services')
          .set('Origin', origin)
          .send({
            name: 'Room painting',
            description: 'Interior wall painting',
            unitLabel: 'room',
            unitPriceCents: 10000,
            minimumChargeCents: 0,
            basePriceCents: 0,
            maxAutoQuoteCents: 0,
            requiredInputs: [],
            exclusions: [],
          })
          .expect(201)
      ).body.data;
      const initial = (
        await owner
          .post('/api/v1/training')
          .set('Origin', origin)
          .send({ serviceId: service.id })
          .expect(201)
      ).body.data;
      const base = `/api/v1/training/${initial.id}`;
      await addMessage(businessId, initial.id, 'training', 'user', 'Can you send photos?');
      await addMessage(
        businessId,
        initial.id,
        'training',
        'assistant',
        'I will send them shortly.',
      );
      let session = (
        await owner
          .post(`${base}/messages`)
          .set('Origin', origin)
          .send({ content: 'All rooms, please.' })
          .expect(200)
      ).body.data;
      const pending = session.messages.at(-1).photos;
      assert.equal(pending.status, 'pending');
      assert.deepEqual(pending.attachments, []);
      assert.doesNotMatch(session.messages.at(-1).content, /will send|shortly/i);
      const requestId = pending.requestId;
      const beforeDuplicate = textCalls;
      await owner.post(`${base}/photos`).set('Origin', origin).send({}).expect(200);
      await owner.get(base).expect(200);
      assert.equal(textCalls, beforeDuplicate);
      assert.equal(imageCalls, 0, 'GET and pending duplicates cannot generate images');
      const [photoRequest] = await rows(
        'SELECT job_id,scenes_json FROM training_photo_requests WHERE id=? AND business_id=?',
        [requestId, businessId],
      );
      assert.equal(
        JSON.parse(
          typeof photoRequest.scenes_json === 'string'
            ? photoRequest.scenes_json
            : JSON.stringify(photoRequest.scenes_json),
        ).length,
        3,
      );
      assert.equal(await runOneJob(photoRequest.job_id), true);
      assert.equal(
        imageCalls,
        2,
        'An explicit HTTP503 must not automatically repeat a paid image call',
      );
      session = (await owner.get(base).expect(200)).body.data;
      let photos = session.messages.at(-1).photos;
      assert.equal(photos.status, 'failed');
      assert.equal(photos.retryable, true);
      assert.equal(photos.attachments.length, 1);
      const first = photos.attachments[0];
      assert.equal(first.label, 'Living room');
      const binary = await owner.get(first.url).expect(200);
      assert.match(binary.headers['content-type'], /image\/jpeg/);
      assert.equal(binary.headers['cache-control'], 'private, no-store');
      const metadata = await sharp(binary.body).metadata();
      assert.equal(metadata.width, 120);
      assert.equal(metadata.exif, undefined);
      await request(app).get(first.url).expect(401);
      await other.get(first.url).expect(404);
      await other
        .post(`${base}/photos/${requestId}/retry`)
        .set('Origin', origin)
        .send({})
        .expect(404);
      await owner.get(`/api/v1/training/${randomUUID()}/photos/${first.id}`).expect(404);
      failSecond = false;
      await owner
        .post(`${base}/photos/${requestId}/retry`)
        .set('Origin', origin)
        .send({})
        .expect(200);
      const [retried] = await rows(
        'SELECT job_id FROM training_photo_requests WHERE id=? AND business_id=?',
        [requestId, businessId],
      );
      assert.notEqual(retried.job_id, photoRequest.job_id);
      await processTrainingPhotos(businessId, requestId, photoRequest.job_id);
      assert.equal(imageCalls, 2, 'A late old job cannot pay for a new attempt');
      await runOneJob(retried.job_id);
      session = (await owner.get(base).expect(200)).body.data;
      photos = session.messages.at(-1).photos;
      assert.equal(photos.status, 'ready');
      assert.equal(photos.attachments.length, 3);
      assert.equal(photos.attachments[0].id, first.id);
      assert.equal(imageCalls, 4, 'Retry generated only the two unfinished views');
      assert.deepEqual(
        photos.attachments.map((asset: any) => asset.label),
        ['Living room', 'Kitchen', 'Bedroom'],
      );
      const [beforeUnsolicited] = await rows(
        'SELECT COUNT(*) AS count FROM training_photo_requests WHERE business_id=? AND training_session_id=?',
        [businessId, initial.id],
      );
      const [jobsBeforeUnsolicited] = await rows(
        "SELECT COUNT(*) AS count FROM jobs WHERE business_id=? AND type='training_photos'",
        [businessId],
      );
      const imagesBeforeUnsolicited = imageCalls;
      unsolicitedPhotos = true;
      for (const [content, reply] of [
        ['For this project, my quote would be $325.', 'Here are the photos.'],
        ['That includes the extra preparation.', 'I will send the photos shortly.'],
      ]) {
        unsolicitedReply = reply;
        const turn = (
          await owner.post(`${base}/messages`).set('Origin', origin).send({ content }).expect(200)
        ).body.data;
        assert.equal(turn.messages.at(-2).content, content);
        assert.equal(turn.messages.at(-1).photos, undefined);
        assert.equal(
          turn.messages.at(-1).content,
          'I can describe the project details. What else would you need to know?',
          'A discarded model photo plan cannot leave a delivery claim behind',
        );
        assert.equal(JSON.parse(lastTextBody.input[0].content[0].text).requestPhotos, false);
      }
      unsolicitedPhotos = false;
      const [afterUnsolicited] = await rows(
        'SELECT COUNT(*) AS count FROM training_photo_requests WHERE business_id=? AND training_session_id=?',
        [businessId, initial.id],
      );
      const [jobsAfterUnsolicited] = await rows(
        "SELECT COUNT(*) AS count FROM jobs WHERE business_id=? AND type='training_photos'",
        [businessId],
      );
      assert.equal(
        Number(afterUnsolicited.count),
        Number(beforeUnsolicited.count),
        'A model photo plan cannot authorize a new batch after a price or reason-only reply',
      );
      assert.equal(Number(jobsAfterUnsolicited.count), Number(jobsBeforeUnsolicited.count));
      assert.equal(imageCalls, imagesBeforeUnsolicited);
      const priorCalls = imageCalls;
      const reuse = (
        await owner
          .post(`${base}/messages`)
          .set('Origin', origin)
          .send({ content: 'Please show photos of all rooms again.' })
          .expect(200)
      ).body.data.messages.at(-1).photos;
      assert.equal(reuse.status, 'ready');
      assert.deepEqual(
        reuse.attachments.map((asset: any) => asset.id),
        photos.attachments.map((asset: any) => asset.id),
      );
      assert.equal(imageCalls, priorCalls);
      assert.equal(
        lastTextBody.input[0].content.filter((part: any) => part.type === 'input_image').length,
        3,
        'Subsequent turns receive the actual generated photos',
      );
      assert.ok(lastTextBody.input[0].content[0].text.includes('photoContext'));
      assert.ok(
        bodies.every(
          (body) =>
            body.model === 'gpt-image-2.5-flare' &&
            body.n === 1 &&
            body.output_format === 'jpeg' &&
            body.quality === 'low',
        ),
      );
      const [usage] = await rows(
        "SELECT COUNT(*) AS count FROM usage_events WHERE business_id=? AND kind='ai_call' AND JSON_UNQUOTE(JSON_EXTRACT(metadata_json,'$.operation'))='generate_practice_photo'",
        [businessId],
      );
      assert.equal(Number(usage.count), 3);
      const interrupted = (
        await owner
          .post('/api/v1/training')
          .set('Origin', origin)
          .send({ serviceId: service.id })
          .expect(201)
      ).body.data;
      const interruptedBase = `/api/v1/training/${interrupted.id}`;
      const interruptedRequest = (
        await owner
          .post(`${interruptedBase}/photos`)
          .set('Origin', origin)
          .send({ content: 'Show a photo of the living room.' })
          .expect(200)
      ).body.data.messages.at(-1).photos.requestId;
      const [interruptedJob] = await rows(
        'SELECT job_id FROM training_photo_requests WHERE business_id=? AND id=?',
        [businessId, interruptedRequest],
      );
      await mutate(
        'UPDATE training_photo_requests SET generation_started_at=UTC_TIMESTAMP(3) WHERE business_id=? AND id=?',
        [businessId, interruptedRequest],
      );
      await processTrainingPhotos(businessId, interruptedRequest, interruptedJob.job_id);
      assert.equal(
        imageCalls,
        priorCalls,
        'A recovered started image job never automatically repeats its paid call',
      );
      await mutate('UPDATE training_photo_requests SET attempts=3 WHERE business_id=? AND id=?', [
        businessId,
        interruptedRequest,
      ]);
      const capped = (await owner.get(interruptedBase).expect(200)).body.data.messages.at(
        -1,
      ).photos;
      assert.equal(capped.status, 'failed');
      assert.equal(capped.retryable, false);
      await owner
        .post(`${interruptedBase}/photos/${interruptedRequest}/retry`)
        .set('Origin', origin)
        .send({})
        .expect(422);
      await owner
        .post(`${base}/complete`)
        .set('Origin', origin)
        .send({
          finalPriceCents: 30000,
          rationale: 'Three rooms at the approved room price.',
          saveAsExample: true,
        })
        .expect(200);
      const [linked] = await rows(
        'SELECT COUNT(*) AS count FROM attachments WHERE business_id=? AND conversation_id=? AND example_id IS NOT NULL',
        [businessId, initial.id],
      );
      assert.equal(Number(linked.count), 3);
      assert.equal(
        (await trainingById(businessId, initial.id)).messages.at(-2)?.photos?.attachments.length,
        3,
      );
    } finally {
      globalThis.fetch = originalFetch;
      for (const businessId of ids) {
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
