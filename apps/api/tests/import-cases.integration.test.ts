import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import request from 'supertest';
import { closeDatabase, mutate, rows } from '../src/db.js';

test(
  'reviewed imports atomically preserve partial cases, numeric provenance, currency and retry receipts',
  { skip: process.env.RUN_DB_TESTS !== '1' },
  async () => {
    process.env.NODE_ENV = 'test';
    process.env.AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'mock-only';
    process.env.OPENAI_MODEL = 'mock-model';
    process.env.MAIL_PROVIDER = 'local';
    process.env.BILLING_PROVIDER = 'local';
    process.env.TRUST_PROXY = '1';
    process.env.AI_DAILY_BUSINESS_LIMIT = '100';
    process.env.AI_DAILY_APP_LIMIT = '999999';
    const originalFetch = globalThis.fetch,
      businessIds: string[] = [],
      learningInputs: any[] = [];
    let providerCalls = 0,
      requestIndex = 0;
    const project = (values: Record<string, unknown> = {}) => ({
      title: 'Birthday portrait session',
      description: 'A brief birthday portrait shoot with edited photographs',
      quantity: null,
      finalPriceCents: 18000,
      rationale: '',
      unitLabel: 'hour',
      currency: 'USD',
      inputs: [],
      issues: ['Hours were not recorded'],
      ...values,
    });
    let extracted = [project()];
    globalThis.fetch = async (url, init) => {
      assert.equal(
        String(url),
        'https://api.openai.com/v1/responses',
        'Only the mocked provider is available',
      );
      providerCalls++;
      const body = JSON.parse(String(init?.body));
      const learning = Object.hasOwn(body.text.format.schema.properties, 'unitPriceCents');
      if (learning)
        learningInputs.push(
          JSON.parse(body.input[0].content.find((item: any) => item.type === 'input_text').text),
        );
      return Response.json({
        status: 'completed',
        usage: { input_tokens: 10, output_tokens: 5 },
        output: [
          {
            content: [
              {
                type: 'output_text',
                text: JSON.stringify(
                  learning
                    ? {
                        unitLabel: null,
                        unitPriceCents: 18000,
                        basePriceCents: 18000,
                        minimumChargeCents: 18000,
                        requiredInputs: ['occasion', 'coverage wanted'],
                        pricingRules: [],
                        exclusions: [],
                        explanation: 'Review the job details before preparing a price.',
                        uncertainties: [],
                      }
                    : { projects: extracted, notes: [] },
                ),
              },
            ],
          },
        ],
      });
    };
    const { createApp } = await import('../src/app.js');
    const { deleteBusinessAccount } = await import('../src/accounts.js');
    const app = createApp(),
      owner = request.agent(app),
      other = request.agent(app),
      origin = 'http://localhost:3100';
    const ip = () => `2001:db8::${++requestIndex}`;
    const upload = (
      serviceId: string,
      bytes: Buffer,
      filename = 'past-job.txt',
      contentType = 'text/plain',
    ) =>
      owner
        .post('/api/v1/imports/document')
        .set('Origin', origin)
        .set('X-Forwarded-For', ip())
        .field('serviceId', serviceId)
        .attach('file', bytes, { filename, contentType });
    const review = (value: any, saveAsNote: boolean, changes: object = {}) => {
      const { id, issues, ...fields } = value;
      return { ...fields, projectId: id, saveAsNote, ...changes };
    };
    const confirm = (draftId: string, projects: any[]) =>
      owner.post(`/api/v1/imports/${draftId}/confirm`).set('Origin', origin).send({ projects });
    const serviceVersion = async (serviceId: string) =>
      Number(
        (
          await rows('SELECT version FROM services WHERE id=? AND business_id=?', [
            serviceId,
            businessIds[0],
          ])
        )[0].version,
      );
    try {
      for (const agent of [owner, other]) {
        const registered = (
          await agent
            .post('/api/v1/auth/register')
            .set('Origin', origin)
            .send({
              name: 'Import case QA',
              businessName: 'Fictional Import Case QA',
              email: `qa-import-case-${randomUUID()}@example.test`,
              password: 'fictional-import-cases123',
            })
            .expect(201)
        ).body.data;
        businessIds.push(registered.business.id);
      }
      const createService = async (name: string, unitLabel = 'hour') =>
        (
          await owner
            .post('/api/v1/services')
            .set('Origin', origin)
            .send({
              name,
              description: 'Photography priced individually from the actual scope',
              unitLabel,
              unitPriceCents: 0,
              basePriceCents: 0,
              minimumChargeCents: 0,
              maxAutoQuoteCents: 0,
              requiredInputs: [],
              exclusions: [],
            })
            .expect(201)
        ).body.data;
      const service = await createService('Portrait photography');
      const raw =
        '\uFEFFI photographed a birthday portrait session in Denver.\r\nI charged $180 because it was a brief shoot and included edited photos.\r\nI bill by the hour but did not record how many hours this job took.';
      const uploaded = await upload(service.id, Buffer.from(raw));
      assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
      const draft = uploaded.body.data.draft;
      assert.equal(draft.sourceBasis, 'exact_owner_text');
      assert.equal(draft.sourceNotes, raw, 'BOM and CRLF remain exact, not a generated paraphrase');
      assert.match(draft.projects[0].id, /^[a-f0-9-]{36}$/);
      assert.equal(providerCalls, 1);
      assert.equal(
        (await owner.get('/api/v1/imports').expect(200)).body.data.drafts[0].sourceNotes,
        undefined,
        'List responses do not duplicate whole private sources',
      );
      assert.equal(
        (await owner.get(`/api/v1/imports/${draft.id}`).expect(200)).body.data.draft.sourceNotes,
        raw,
      );
      await other.get(`/api/v1/imports/${draft.id}`).expect(404);
      await other
        .post(`/api/v1/imports/${draft.id}/confirm`)
        .set('Origin', origin)
        .send({ projects: [review(draft.projects[0], true)] })
        .expect(404);
      const noteRow = review(draft.projects[0], true, { unitLabel: null, rationale: '' }),
        versionBefore = await serviceVersion(service.id);
      const simultaneous = await Promise.all([
        confirm(draft.id, [noteRow]),
        confirm(draft.id, [noteRow]),
      ]);
      for (const result of simultaneous)
        assert.equal(result.status, 200, JSON.stringify(result.body));
      const saved = simultaneous[0].body.data;
      assert.equal(saved.imported, 0);
      assert.equal(saved.notesSaved, 1);
      assert.deepEqual(saved.exampleIds, []);
      assert.equal(saved.jobNoteIds.length, 1);
      assert.deepEqual(simultaneous[1].body.data.jobNoteIds, saved.jobNoteIds);
      assert.deepEqual(simultaneous.map((result) => result.body.data.alreadyConfirmed).sort(), [
        false,
        true,
      ]);
      assert.equal(
        await serviceVersion(service.id),
        versionBefore + 1,
        'Concurrent confirmation invalidates once',
      );
      const again = await confirm(draft.id, [noteRow]);
      assert.equal(again.body.data.alreadyConfirmed, true);
      assert.equal(again.body.data.notesSaved, 1);
      assert.deepEqual(again.body.data.jobNoteIds, saved.jobNoteIds);
      const conflict = await confirm(draft.id, [{ ...noteRow, finalPriceCents: 19000 }]);
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body.error.code, 'IMPORT_CONFIRMATION_CONFLICT');
      assert.equal(await serviceVersion(service.id), versionBefore + 1);
      assert.equal(providerCalls, 1, 'Confirm/retry/conflict never call AI');
      const duplicate = await upload(service.id, Buffer.from(raw));
      assert.equal(duplicate.status, 200);
      assert.equal(duplicate.body.data.draft.status, 'confirmed');
      assert.deepEqual(duplicate.body.data.draft.confirmation.jobNoteIds, saved.jobNoteIds);
      assert.equal(providerCalls, 1, 'Known source returns its receipt before another extraction');
      const dashboard = (await owner.get('/api/v1/dashboard').expect(200)).body.data;
      const note = dashboard.jobNotes.find((item: any) => item.id === saved.jobNoteIds[0]);
      assert.equal(note.source, 'import');
      assert.equal(note.sourceNotes, raw);
      assert.equal(note.sourceBasis, 'exact_owner_text');
      assert.equal(note.sourceFilename, 'past-job.txt');
      assert.equal(note.sourceCurrency, 'USD');
      assert.equal(note.quantity, null);
      assert.equal(
        note.unitLabel,
        null,
        'Owner-cleared source units remain unknown after save/reload',
      );
      assert.equal(note.finalPriceCents, 18000);
      assert.equal(
        note.rationale,
        '',
        'Reviewed blank rationale is not replaced by the original because clause',
      );
      assert.equal(dashboard.examples.length, 0);
      assert.equal(dashboard.stats.examplesCount, 0);
      assert.deepEqual((await other.get('/api/v1/dashboard').expect(200)).body.data.jobNotes, []);
      const learned = (
        await owner
          .post(`/api/v1/services/${service.id}/learn`)
          .set('Origin', origin)
          .set('X-Forwarded-For', ip())
          .send({})
          .expect(201)
      ).body.data.proposal;
      assert.deepEqual(learned.sourceCaseIds, saved.jobNoteIds);
      assert.deepEqual(learned.sourceExampleIds, []);
      assert.equal(learned.proposal.unitPriceCents, 0);
      assert.equal(learned.proposal.basePriceCents, 0);
      assert.equal(learned.proposal.minimumChargeCents, 0);
      assert.equal(learningInputs[0].caseNotes[0].sourceNotes, raw);
      assert.equal(
        learningInputs[0].ownerNotes,
        '',
        'Historical source text is not current pricing authority',
      );
      const evaluation = (
        await owner
          .post(`/api/v1/services/${service.id}/evaluate`)
          .set('Origin', origin)
          .send({})
          .expect(200)
      ).body.data;
      assert.equal(evaluation.configurationPassed, false);
      assert.equal(evaluation.automaticReady, false);

      extracted = [
        project({
          title: 'Evening event',
          description: 'Two hours photographing an evening event',
          quantity: 2,
          finalPriceCents: 36000,
          rationale: 'Evening coverage plus editing',
          unitLabel: null,
          issues: [],
        }),
        project(),
      ];
      const mixedRaw =
        'An evening event took two hours and I charged $360 because editing was included. A birthday portrait session cost $180; its hours were not recorded.';
      const mixed = (await upload(service.id, Buffer.from(mixedRaw))).body.data.draft;
      await owner
        .patch(`/api/v1/services/${service.id}`)
        .set('Origin', origin)
        .send({ unitLabel: 'project' })
        .expect(200);
      const mixedVersion = await serviceVersion(service.id);
      const { unitLabel: omittedLegacyUnit, ...completeRow } = review(mixed.projects[0], false);
      const partialRow = review(mixed.projects[1], true);
      await confirm(mixed.id, [completeRow, { ...partialRow, quantity: 0 }]).expect(400);
      assert.equal((await owner.get('/api/v1/examples').expect(200)).body.data.length, 0);
      assert.equal(
        (await owner.get(`/api/v1/imports/${mixed.id}`).expect(200)).body.data.draft.status,
        'pending',
      );
      const currencyRejected = await confirm(mixed.id, [
        completeRow,
        { ...partialRow, currency: 'CAD' },
      ]);
      assert.equal(currencyRejected.status, 400);
      assert.equal(currencyRejected.body.error.code, 'IMPORT_CURRENCY_REQUIRED');
      assert.equal(
        await serviceVersion(service.id),
        mixedVersion,
        'A bad mixed selection writes neither outcome',
      );
      await confirm(mixed.id, [completeRow, { ...partialRow, projectId: randomUUID() }]).expect(
        422,
      );
      const mixedSaved = (await confirm(mixed.id, [completeRow, partialRow]).expect(200)).body.data;
      assert.equal(mixedSaved.imported, 1);
      assert.equal(mixedSaved.notesSaved, 1);
      assert.equal(await serviceVersion(service.id), mixedVersion + 1);
      const numeric = (await owner.get('/api/v1/examples').expect(200)).body.data.find(
        (item: any) => item.id === mixedSaved.exampleIds[0],
      );
      assert.equal(numeric.unitLabel, 'hour', 'Frozen import units survive later service edits');
      assert.equal(
        numeric.sourceNotes,
        mixedRaw,
        'Complete numeric imports also retain exact original text',
      );
      assert.equal(numeric.sourceBasis, 'exact_owner_text');
      assert.equal(numeric.sourceFilename, 'past-job.txt');
      assert.equal(numeric.sourceCurrency, 'USD');
      const reordered = (await confirm(mixed.id, [partialRow, completeRow]).expect(200)).body.data;
      assert.equal(reordered.alreadyConfirmed, true);
      assert.deepEqual(reordered.exampleIds, mixedSaved.exampleIds);

      const pdf = await PDFDocument.create();
      pdf.addPage().drawText('Fictional photography invoice');
      extracted = [
        project({ currency: 'CAD', title: 'Imported portrait invoice' }),
        project({
          currency: 'CAD',
          title: 'Fixed portrait package',
          description: 'One fixed portrait package with edited photographs',
          quantity: 1,
          unitLabel: 'project',
          rationale: 'A fixed package for this one session',
          issues: [],
        }),
      ];
      const pdfDraft = (
        await upload(
          service.id,
          Buffer.from(await pdf.save()),
          'portrait-invoice.pdf',
          'application/pdf',
        ).expect(201)
      ).body.data.draft;
      assert.equal(pdfDraft.sourceBasis, 'reviewed_extraction');
      assert.equal(pdfDraft.sourceNotes, undefined);
      await confirm(pdfDraft.id, [review(pdfDraft.projects[0], true)]).expect(400);
      const pdfSaved = (
        await confirm(pdfDraft.id, [
          review(pdfDraft.projects[0], true, { finalPriceCents: null }),
          review(pdfDraft.projects[1], false, { currency: 'USD', finalPriceCents: 13200 }),
        ]).expect(200)
      ).body.data;
      const pdfNote = (await owner.get('/api/v1/dashboard').expect(200)).body.data.jobNotes.find(
        (item: any) => item.id === pdfSaved.jobNoteIds[0],
      );
      assert.equal(pdfNote.sourceNotes, '');
      assert.equal(pdfNote.sourceBasis, 'reviewed_extraction');
      assert.equal(pdfNote.sourceFilename, 'portrait-invoice.pdf');
      assert.equal(pdfNote.sourceCurrency, 'CAD');
      assert.equal(
        pdfNote.finalPriceCents,
        null,
        'An unconverted foreign source never masquerades as USD',
      );
      assert.equal(
        (await owner.get(`/api/v1/imports/${pdfDraft.id}`).expect(200)).body.data.draft.projects[0]
          .finalPriceCents,
        18000,
        'The original extracted amount remains available',
      );
      const converted = (await owner.get('/api/v1/examples').expect(200)).body.data.find(
        (item: any) => item.id === pdfSaved.exampleIds[0],
      );
      assert.equal(
        converted.finalPriceCents,
        13200,
        'Only an explicit owner-confirmed USD amount becomes numeric',
      );
      assert.equal(converted.sourceCurrency, 'CAD');
      assert.equal(converted.sourceBasis, 'reviewed_extraction');
      assert.equal(
        converted.sourceNotes,
        undefined,
        'A PDF extraction is never labeled as verbatim original words',
      );

      const beforeBadText = providerCalls;
      for (const bytes of [
        Buffer.alloc(0),
        Buffer.from([0xc3, 0x28]),
        Buffer.from('bad\0text'),
        Buffer.from('   '),
        Buffer.from('\uFEFF\t\r\n  '),
      ]) {
        const invalid = await upload(service.id, bytes);
        assert.equal(invalid.status, 422);
        assert.equal(invalid.body.error.code, 'INVALID_TEXT');
      }
      assert.equal(
        providerCalls,
        beforeBadText,
        'Invalid UTF-8, NUL and empty text fail before provider spend',
      );
      extracted = [];
      const empty = (
        await upload(service.id, Buffer.from('This is a source with no identifiable service job.'))
      ).body.data.draft;
      await confirm(empty.id, [{ ...noteRow, projectId: randomUUID() }]).expect(422);
      extracted = [
        project({
          title: 'Unknown project',
          description: 'Unknown',
          finalPriceCents: null,
          quantity: null,
          issues: ['No identifiable work found'],
        }),
      ];
      const notices = (
        await upload(
          service.id,
          Buffer.from('A document containing notices, with no identifiable job scope.'),
        )
      ).body.data.draft;
      await confirm(notices.id, [
        review(notices.projects[0], true, {
          description: 'A changed description cannot turn empty source notices into evidence',
        }),
      ]).expect(422);

      const legacyId = randomUUID();
      await mutate(
        "INSERT INTO import_drafts(id,business_id,service_id,filename,source_hash,status,draft_json,unit_label) VALUES (?,?,?,?,?,'confirmed',?,?)",
        [
          legacyId,
          businessIds[0],
          service.id,
          'old.pdf',
          randomUUID().replaceAll('-', '').padEnd(64, '0'),
          JSON.stringify({ projects: [project({ inputs: {} })], notes: [] }),
          'hour',
        ],
      );
      const legacyDraft = (await owner.get(`/api/v1/imports/${legacyId}`).expect(200)).body.data
        .draft;
      assert.equal(legacyDraft.sourceBasis, 'reviewed_extraction');
      assert.equal(legacyDraft.confirmation, undefined);
      const legacyRetry = await confirm(legacyId, [review(legacyDraft.projects[0], true)]);
      assert.equal(legacyRetry.status, 409);
      assert.equal(legacyRetry.body.error.code, 'IMPORT_ALREADY_CONFIRMED');

      const cascadeService = await createService('Disposable service notes');
      extracted = [project()];
      const cascadeDraft = (
        await upload(
          cascadeService.id,
          Buffer.from('A fictional portrait job charged $180 with its duration unknown.'),
        )
      ).body.data.draft;
      const cascadeNote = (
        await confirm(cascadeDraft.id, [review(cascadeDraft.projects[0], true)]).expect(200)
      ).body.data.jobNoteIds[0];
      await mutate('DELETE FROM services WHERE business_id=? AND id=?', [
        businessIds[0],
        cascadeService.id,
      ]);
      assert.equal(
        (
          await rows('SELECT id FROM owner_case_notes WHERE business_id=? AND id=?', [
            businessIds[0],
            cascadeNote,
          ])
        ).length,
        0,
      );
      assert.equal(
        (
          await rows('SELECT id FROM import_drafts WHERE business_id=? AND id=?', [
            businessIds[0],
            cascadeDraft.id,
          ])
        ).length,
        0,
      );

      const exported = (await owner.get('/api/v1/account/export').expect(200)).body.data;
      const exportedSource = exported.records.import_drafts.find(
        (item: any) => item.id === draft.id,
      );
      assert.equal(exportedSource.source_text, raw);
      assert.equal(exportedSource.source_basis, 'exact_owner_text');
      assert.match(exportedSource.source_hash, /^[a-f0-9]{64}$/);
      assert.match(exportedSource.confirmation_hash, /^[a-f0-9]{64}$/);
      assert.equal(
        exported.records.owner_case_notes.some((item: any) => item.id === saved.jobNoteIds[0]),
        true,
      );
      assert.equal(
        exported.records.users.some((item: any) => 'password_hash' in item),
        false,
      );
      assert.equal(
        (await other.get('/api/v1/account/export').expect(200)).body.data.records.owner_case_notes
          .length,
        0,
      );
      // Notes do not consume the numeric-example allowance; a blocked mixed batch still saves neither part.
      const placeholders: string[] = [],
        parameters: unknown[] = [];
      const existingExamples = Number(
        (
          await rows('SELECT COUNT(*) AS count FROM examples WHERE business_id=?', [businessIds[0]])
        )[0].count,
      );
      for (let index = 0; index < 500 - existingExamples; index++) {
        placeholders.push('(?,?,?,?,?,?,?,?,?,?)');
        parameters.push(
          randomUUID(),
          businessIds[0],
          service.id,
          `Allowance fixture ${index}`,
          'A complete fictional photography job',
          1,
          10000,
          'Known job details',
          'historical',
          'hour',
        );
      }
      await mutate(
        `INSERT INTO examples(id,business_id,service_id,title,description,quantity,final_price_cents,rationale,source,unit_label) VALUES ${placeholders.join(',')}`,
        parameters,
      );
      extracted = [
        project({
          title: 'Known event',
          description: 'A full photography event with recorded hours',
          quantity: 2,
          finalPriceCents: 30000,
          rationale: 'Evening coverage',
          unitLabel: 'hour',
          issues: [],
        }),
        project(),
      ];
      const limited = (
        await upload(
          service.id,
          Buffer.from('A separate complete event and another portrait job with hours unknown.'),
        )
      ).body.data.draft;
      const limitVersion = await serviceVersion(service.id),
        beforeCount = Number(
          (
            await rows('SELECT COUNT(*) AS count FROM owner_case_notes WHERE business_id=?', [
              businessIds[0],
            ])
          )[0].count,
        );
      const rejected = await confirm(limited.id, [
        review(limited.projects[0], false),
        review(limited.projects[1], true),
      ]);
      assert.equal(rejected.status, 422);
      assert.equal(rejected.body.error.code, 'EXAMPLE_LIMIT');
      assert.equal(await serviceVersion(service.id), limitVersion);
      assert.equal(
        Number(
          (
            await rows('SELECT COUNT(*) AS count FROM owner_case_notes WHERE business_id=?', [
              businessIds[0],
            ])
          )[0].count,
        ),
        beforeCount,
      );
      const noteAtLimit = (
        await confirm(limited.id, [review(limited.projects[1], true)]).expect(200)
      ).body.data;
      assert.equal(noteAtLimit.imported, 0);
      assert.equal(noteAtLimit.notesSaved, 1);
    } finally {
      globalThis.fetch = originalFetch;
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
        assert.equal(
          (await rows('SELECT id FROM owner_case_notes WHERE business_id=?', [businessId])).length,
          0,
        );
        assert.equal(
          (await rows('SELECT id FROM import_drafts WHERE business_id=?', [businessId])).length,
          0,
        );
      }
      await closeDatabase();
    }
  },
);
