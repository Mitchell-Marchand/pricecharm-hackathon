import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  importConfirmationHash,
  importConfirmationSchema,
  importDraft,
  importProjects,
  resolveImportSelection,
} from '../src/import-history.js';

function fixture() {
  return {
    id: randomUUID(),
    service_id: randomUUID(),
    unit_label: 'hour',
    filename: 'past-job.txt',
    status: 'pending',
    source_text: '\uFEFFOwner’s exact text\r\nSecond line.',
    source_basis: 'exact_owner_text',
    created_at: new Date(),
    draft_json: {
      projects: [
        {
          title: 'Birthday portraits',
          description: 'A short birthday portrait session',
          quantity: null,
          finalPriceCents: 18000,
          rationale: '',
          unitLabel: null,
          currency: 'USD',
          inputs: {},
          issues: ['Hours unknown'],
        },
        {
          title: 'Evening event',
          description: 'Two hours of event photography',
          quantity: 2,
          finalPriceCents: 36000,
          rationale: 'Evening event with editing',
          unitLabel: 'hour',
          currency: 'USD',
          inputs: {},
          issues: [],
        },
      ],
      notes: [],
    },
  } as any;
}
function review(project: ReturnType<typeof importProjects>[number], saveAsNote = true) {
  const { id, issues, ...values } = project;
  return { ...values, projectId: id, saveAsNote };
}
test('legacy draft rows have stable UUID project identities and exact provenance is never reconstructed', () => {
  const row = fixture(),
    projects = importProjects(row);
  assert.deepEqual(importProjects(row), projects);
  assert.notEqual(projects[0].id, projects[1].id);
  assert.match(projects[0].id, /^[a-f0-9-]{36}$/);
  assert.equal(
    projects[0].unitLabel,
    null,
    'The read DTO does not invent a source measurement unit',
  );
  assert.equal(importDraft(row).sourceNotes, row.source_text);
  assert.equal(importDraft(row, false).sourceNotes, undefined);
  assert.equal(importDraft({ ...row, source_basis: null }).sourceBasis, 'reviewed_extraction');
  assert.equal(importDraft({ ...row, source_basis: null }).sourceNotes, undefined);
});
test('partial-note mode is explicit, numeric examples remain strict and currency never defaults to USD', () => {
  const row = fixture(),
    [partial] = importProjects(row);
  const input = importConfirmationSchema.parse({ projects: [review(partial)] });
  const [saved] = resolveImportSelection(row, input);
  assert.equal(saved.quantity, null);
  assert.equal(saved.finalPriceCents, 18000);
  assert.equal(saved.unitLabel, null);
  assert.equal(saved.sourceCurrency, 'USD');
  assert.throws(
    () =>
      resolveImportSelection(
        row,
        importConfirmationSchema.parse({ projects: [review(partial, false)] }),
      ),
    /known quantity/,
  );
  assert.throws(() =>
    importConfirmationSchema.parse({ projects: [{ ...review(partial), quantity: 0 }] }),
  );
  assert.throws(
    () =>
      resolveImportSelection(
        row,
        importConfirmationSchema.parse({ projects: [{ ...review(partial), currency: 'CAD' }] }),
      ),
    /Confirm a USD amount/,
  );
  const [unknown] = resolveImportSelection(
    row,
    importConfirmationSchema.parse({
      projects: [{ ...review(partial), currency: null, finalPriceCents: null }],
    }),
  );
  assert.equal(unknown.currency, null);
  assert.equal(unknown.finalPriceCents, null);
});
test('confirmation fingerprints identify semantic retries and reject a changed outcome or selection', () => {
  const row = fixture(),
    projects = importProjects(row);
  const values = [
    review(projects[0]),
    { ...review(projects[1], false), inputs: { b: 'two', a: 'one' } },
  ];
  const first = resolveImportSelection(row, importConfirmationSchema.parse({ projects: values }));
  const reordered = resolveImportSelection(
    row,
    importConfirmationSchema.parse({
      projects: [{ ...values[1], inputs: { a: 'one', b: 'two' } }, values[0]],
    }),
  );
  assert.equal(importConfirmationHash(row.id, first), importConfirmationHash(row.id, reordered));
  const changed = resolveImportSelection(
    row,
    importConfirmationSchema.parse({
      projects: [{ ...values[0], finalPriceCents: 19000 }, values[1]],
    }),
  );
  assert.notEqual(importConfirmationHash(row.id, first), importConfirmationHash(row.id, changed));
  assert.throws(
    () =>
      resolveImportSelection(
        row,
        importConfirmationSchema.parse({ projects: [values[0], values[0]] }),
      ),
    /once/,
  );
  assert.throws(
    () =>
      resolveImportSelection(
        row,
        importConfirmationSchema.parse({ projects: [{ ...values[0], projectId: randomUUID() }] }),
      ),
    /from this draft/,
  );
});
test('an explicitly cleared review unit remains unknown; only omitted legacy fields use source units', () => {
  const row = fixture();
  row.draft_json.projects[0].unitLabel = 'hour';
  const [partial, complete] = importProjects(row);
  const [cleared] = resolveImportSelection(
    row,
    importConfirmationSchema.parse({
      projects: [{ ...review(partial), unitLabel: null, rationale: '' }],
    }),
  );
  assert.equal(cleared.unitLabel, null);
  assert.equal(cleared.rationale, '');
  const { unitLabel, ...omitted } = review(partial);
  const [legacy] = resolveImportSelection(
    row,
    importConfirmationSchema.parse({ projects: [omitted] }),
  );
  assert.equal(legacy.unitLabel, 'hour');
  assert.throws(
    () =>
      resolveImportSelection(
        row,
        importConfirmationSchema.parse({
          projects: [{ ...review(complete, false), unitLabel: null }],
        }),
      ),
    /Confirm the quantity unit/,
  );
});
test('an empty extraction or notices without actual job evidence cannot be saved as notes', () => {
  const row = fixture(),
    [partial] = importProjects(row);
  const input = importConfirmationSchema.parse({ projects: [review(partial)] });
  assert.throws(
    () => resolveImportSelection({ ...row, draft_json: { projects: [] } }, input),
    /no identifiable job/,
  );
  const empty = {
    ...row,
    draft_json: {
      projects: [
        {
          ...partial,
          title: 'Unknown project',
          description: 'Unknown',
          quantity: null,
          finalPriceCents: null,
          issues: ['No actual job found'],
        },
      ],
    },
  };
  assert.throws(() => resolveImportSelection(empty, input), /Missing-field notices/);
});
