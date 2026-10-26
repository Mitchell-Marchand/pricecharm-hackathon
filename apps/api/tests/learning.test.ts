import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
const originalFetch = globalThis.fetch;
let learning: typeof import('../src/learning.js');
before(async () => {
  process.env.AI_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = 'mock-only';
  process.env.OPENAI_MODEL = 'mock-model';
  learning = await import('../src/learning.js');
});
after(() => {
  globalThis.fetch = originalFetch;
});
test('PDF extraction sends a real file part, validates unknown fields and requests reviewable drafts', async () => {
  let body: any;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    body = JSON.parse(String(init?.body));
    return Response.json({
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({
                projects: [
                  {
                    title: 'Window project',
                    description: 'Exterior cleaning',
                    quantity: null,
                    finalPriceCents: 25000,
                    rationale: '',
                    currency: 'USD',
                    inputs: [],
                    issues: ['Quantity is not given.'],
                  },
                ],
                notes: ['Owner review required.'],
              }),
            },
          ],
        },
      ],
      usage: { input_tokens: 100, output_tokens: 80 },
    });
  };
  const pdf = Buffer.from('%PDF-1.7\n%%EOF').toString('base64');
  const result = await learning.extractHistoricalProjects({
    service: { name: 'Windows', description: 'Exterior', unitLabel: 'window' },
    documents: [{ filename: 'invoice.pdf', mimeType: 'application/pdf', dataBase64: pdf }],
  });
  assert.equal(result.projects[0].quantity, null);
  assert.equal(result.projects[0].rationale, '');
  assert.equal(body.input[0].content[1].type, 'input_file');
  assert.equal(body.input[0].content[1].file_data, `data:application/pdf;base64,${pdf}`);
  assert.equal(body.store, false);
  assert.ok(body.instructions.includes('Unknown quantity or amount must be null'));
  assert.ok(body.instructions.includes('Remove names, emails'));
});
test('learned policy rejects malformed model amounts and unrecognized rules', async () => {
  globalThis.fetch = async () =>
    Response.json({
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({
                unitPriceCents: 1.1,
                basePriceCents: 0,
                minimumChargeCents: 100,
                requiredInputs: ['Access'],
                exclusions: [],
                pricingRules: [],
                explanation: 'Invalid fractional cents',
                uncertainties: [],
              }),
            },
          ],
        },
      ],
    });
  await assert.rejects(
    () =>
      learning.proposeFromExamples({
        service: {
          name: 'Windows',
          description: 'Exterior',
          unitLabel: 'window',
          unitPriceCents: 1000,
          basePriceCents: 0,
          minimumChargeCents: 100,
          requiredInputs: ['Access'],
          exclusions: [],
        },
        examples: [
          {
            title: 'One',
            description: 'Accessible',
            quantity: 1,
            finalPriceCents: 1000,
            rationale: 'Standard',
          },
        ],
        ownerNotes: '',
      }),
    /invalid|response/i,
  );
});
test('unidentified empty extraction placeholders become notes, preserving real projects with missing prices', () => {
  const empty = {
    title: '',
    description: '',
    quantity: null,
    finalPriceCents: null,
    rationale: '',
    currency: '',
    inputs: [],
    issues: ['No identifiable project in this section.'],
  };
  const result = learning.normalizeHistoricalDraft({
    projects: [
      empty,
      {
        ...empty,
        title: 'Identifiable work',
        description: 'Fifteen exterior windows',
        quantity: 15,
      },
    ],
    notes: [],
  });
  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0].finalPriceCents, null);
  assert.equal(result.notes.length, 1);
});

const service = {
  name: 'Window cleaning',
  description: 'Residential windows',
  unitLabel: 'window',
  unitPriceCents: 0,
  minimumChargeCents: 0,
  basePriceCents: 0,
  requiredInputs: ['access'],
  exclusions: [],
  pricingRules: [],
};
const past = {
  title: 'Past job',
  description: '24 windows',
  quantity: 24,
  unitLabel: 'window',
  finalPriceCents: 22500,
  rationale: 'A single charged job',
};
const proposed = {
  unitPriceCents: 938,
  basePriceCents: 22500,
  minimumChargeCents: 22500,
  requiredInputs: ['access'],
  exclusions: [],
  pricingRules: [],
  explanation: 'The standard base and minimum are both $225.',
  uncertainties: ['What is your normal minimum?'],
};
test('one historical total cannot manufacture a rate, base fee or minimum', () => {
  const result = learning.groundPricingProposal(
    {
      service,
      examples: [{ ...past, sourceNotes: 'I cleaned 24 windows and charged $225.' }],
      ownerNotes: '',
    },
    proposed,
  );
  assert.equal(result.unitPriceCents, 0);
  assert.equal(result.minimumChargeCents, 0);
  assert.equal(result.basePriceCents, 0);
  assert.ok(!result.explanation.includes('$225'));
  assert.ok(result.uncertainties.every((question) => question.endsWith('?')));
  const approved = learning.groundPricingProposal(
    {
      service: { ...service, unitPriceCents: 900, minimumChargeCents: 12000, basePriceCents: 1500 },
      examples: [past],
      ownerNotes: '',
    },
    proposed,
  );
  assert.equal(approved.unitPriceCents, 900);
  assert.equal(approved.minimumChargeCents, 12000);
  assert.equal(approved.basePriceCents, 1500);
});
test('case-by-case pricing does not force a formula or ask customers to estimate professional labor', () => {
  const input = {
    service: { ...service, name: 'Interior painting', unitLabel: 'project', requiredInputs: [] },
    examples: [{ ...past, unitLabel: 'project', quantity: 1, finalPriceCents: 95000 }],
    ownerNotes:
      'I do not have a square foot formula. I price each job based on preparation and time.',
  };
  const result = learning.groundPricingProposal(input, {
    ...proposed,
    requiredInputs: ['prep and time estimate', 'labor hours', 'profit margin'],
    pricingRules: [
      {
        id: 'catch-all',
        name: 'Preparation varies',
        field: 'prep and time estimate',
        operator: 'not_equals',
        value: 'standard',
        kind: 'review',
        amount: 0,
      },
    ],
    uncertainties: [],
  });
  assert.deepEqual(result.requiredInputs, ['Project scope']);
  assert.deepEqual(result.pricingRules, []);
  assert.deepEqual(result.uncertainties, []);
  const habitual = learning.groundPricingProposal(input, {
    ...proposed,
    uncertainties: [
      'What is the typical session length in hours?',
      'How many edited photos does each session usually include?',
      'Which access conditions need inspection?',
    ],
  });
  assert.deepEqual(habitual.uncertainties, ['Which access conditions need inspection?']);
  assert.equal(result.unitPriceCents + result.basePriceCents + result.minimumChargeCents, 0);
  assert.match(result.explanation, /You decide each job/);
  const moreHistory = learning.groundPricingProposal(
    { ...input, examples: Array.from({ length: 3 }, () => input.examples[0]) },
    { ...proposed, uncertainties: [] },
  );
  assert.equal(
    moreHistory.unitPriceCents + moreHistory.basePriceCents + moreHistory.minimumChargeCents,
    0,
    'More past jobs do not override an explicit case-by-case approach',
  );
  const useful = learning.groundPricingProposal(input, {
    ...proposed,
    requiredInputs: [
      'Rooms and surfaces',
      'Current and desired finish',
      'Visible damage',
      'Furniture and access',
    ],
    pricingRules: [
      {
        id: 'vague',
        name: 'Nonstandard work',
        field: 'Visible damage',
        operator: 'not_equals',
        value: 'normal',
        kind: 'review',
        amount: 0,
      },
    ],
    uncertainties: [],
  });
  assert.deepEqual(useful.requiredInputs, [
    'Rooms and surfaces',
    'Current and desired finish',
    'Visible damage',
    'Furniture and access',
  ]);
  assert.deepEqual(useful.pricingRules, []);
  const inventedInspection = learning.groundPricingProposal(input, {
    ...proposed,
    requiredInputs: ['Visible damage'],
    pricingRules: [
      {
        id: 'invented-inspection',
        name: 'Water damage',
        field: 'Visible damage',
        operator: 'contains',
        value: 'water',
        kind: 'review',
        amount: 0,
      },
    ],
    uncertainties: [],
  });
  assert.deepEqual(
    inventedInspection.pricingRules,
    [],
    'A question topic is not an owner inspection policy',
  );
  const approved = learning.groundPricingProposal(
    {
      ...input,
      service: {
        ...input.service,
        requiredInputs: ['labor hours'],
        pricingRules: [
          {
            id: 'actual',
            name: 'Owner inspection',
            field: 'condition',
            operator: 'not_equals',
            value: 'normal',
            kind: 'review',
            amount: 0,
          },
        ],
      },
    },
    {
      ...proposed,
      requiredInputs: ['labor hours'],
      pricingRules: [
        {
          id: 'actual',
          name: 'Owner inspection',
          field: 'condition',
          operator: 'not_equals',
          value: 'normal',
          kind: 'review',
          amount: 0,
        },
      ],
      uncertainties: [],
    },
  );
  assert.deepEqual(approved.requiredInputs, ['labor hours', 'condition']);
  assert.equal(approved.pricingRules.length, 1);
});
test('unassigned monetary corrections ask their target without blocking explicit prices or historical costs', () => {
  for (const note of [
    'Actually make it $45.',
    'Actually $45.',
    'Change that to$45 instead.',
    'Use $45 instead.',
  ])
    assert.equal(
      learning.ownerNoteCorrectionQuestion(note),
      'Is $45 your standard rate, your minimum job price, or another fee?',
      note,
    );
  for (const note of [
    'Actually use $45 per guest instead.',
    'Make the minimum $45.',
    'My minimum is$45.',
    '$45 minimum.',
    'The base fee is$45.',
    'I charged $45 for a recent job.',
    'I paid a helper $45.',
    'Actually make it $45 if stairs need cleaning.',
    'Screens add $45.',
  ])
    assert.equal(learning.ownerNoteCorrectionQuestion(note), undefined, note);
  for (const [note, field] of [
    ['Use $45 per window instead.', 'unitPriceCents'],
    ['My minimum is$45.', 'minimumChargeCents'],
    ['The base fee is$45.', 'basePriceCents'],
  ] as const) {
    const grounded = learning.groundPricingProposal(
      { service, examples: [past], ownerNotes: note },
      proposed,
    );
    assert.equal(grounded[field], 4500, note);
  }
});
test('explicit owner pricing grounds amounts and proposed units while rule questions remain complete', () => {
  const result = learning.groundPricingProposal(
    {
      service: { ...service, unitLabel: 'project' },
      examples: [{ ...past, unitLabel: 'project' }],
      ownerNotes:
        'My standard rate is $9 per window for interior/exterior cleaning. My minimum is $120. No base charge. Screens add $3 per window. Track restoration needs review.',
    },
    {
      ...proposed,
      pricingRules: [
        {
          id: 'screens',
          name: 'Screens',
          field: 'screens present',
          operator: 'equals',
          value: 'yes',
          kind: 'per_unit',
          amount: 300,
        },
        {
          id: 'tracks',
          name: 'Track restoration',
          field: 'window tracks condition',
          operator: 'equals',
          value: 'restoration',
          kind: 'review',
          amount: 0,
        },
      ],
    },
  );
  assert.equal(result.unitLabel, 'window');
  assert.equal(result.unitPriceCents, 900);
  assert.equal(result.minimumChargeCents, 12000);
  assert.equal(result.basePriceCents, 0);
  assert.equal(result.pricingRules.length, 2);
  assert.ok(result.requiredInputs.includes('window tracks condition'));
  const area = learning.groundPricingProposal(
    {
      service: { ...service, unitLabel: 'square feet' },
      examples: [past],
      ownerNotes: 'My usual rate is $0.25 per square foot, $150 minimum, no base.',
    },
    proposed,
  );
  assert.equal(area.unitPriceCents, 25);
  assert.equal(area.minimumChargeCents, 15000);
  assert.equal(area.basePriceCents, 0);
  const combined = learning.groundPricingProposal(
    {
      service: { ...service, unitLabel: 'project' },
      examples: [{ ...past, unitLabel: 'project' }],
      ownerNotes:
        'I normally charge $9 per window with a $120 minimum and no base charge. Window tracks needing restoration must come to me for review.',
    },
    proposed,
  );
  assert.equal(combined.unitLabel, 'window');
  assert.equal(combined.unitPriceCents, 900);
  assert.equal(combined.minimumChargeCents, 12000);
  assert.equal(combined.basePriceCents, 0);
});
test('a changed unit cannot carry old prices and three mismatched examples do not unlock inference', () => {
  const result = learning.groundPricingProposal(
    {
      service: { ...service, unitLabel: 'project', unitPriceCents: 22500 },
      examples: [past, past, past].map((item) => ({ ...item, unitLabel: 'project' })),
      ownerNotes: 'I charge per window.',
    },
    proposed,
  );
  assert.equal(result.unitLabel, 'window');
  assert.equal(result.unitPriceCents, 0);
  assert.equal(result.basePriceCents, 0);
  assert.equal(result.minimumChargeCents, 0);
  const unsupported = learning.groundPricingProposal(
    {
      service,
      examples: [past],
      ownerNotes: 'I might charge $9 per window. I charged a $225 total.',
    },
    {
      ...proposed,
      pricingRules: [
        {
          id: 'invented',
          name: 'Window base',
          field: 'access',
          operator: 'equals',
          value: 'easy',
          kind: 'fixed',
          amount: 22500,
        },
      ],
    },
  );
  assert.equal(unsupported.unitPriceCents, 0);
  assert.equal(unsupported.pricingRules.length, 0);
  for (const ownerNotes of [
    'I do not charge $9 per window. My minimum is not $225.',
    'I never add a $225 base fee.',
    'My normal rate is -9 dollars per window.',
  ]) {
    const denied = learning.groundPricingProposal(
      { service, examples: [past], ownerNotes },
      proposed,
    );
    assert.equal(denied.unitPriceCents, 0);
    assert.equal(denied.minimumChargeCents, 0);
    assert.equal(denied.basePriceCents, 0);
  }
});

test('explicit pricing is confirmed by approval rather than redundant model questions', () => {
  const result = learning.groundPricingProposal(
    {
      service: { ...service, unitLabel: 'square feet' },
      examples: [past],
      ownerNotes: 'My usual rate is $0.25 per square foot, $150 minimum, no base.',
    },
    {
      ...proposed,
      uncertainties: [
        'Do you confirm a $150 minimum visit charge?',
        'Do you want to keep no base charge for all jobs?',
        'Is the $0.25 per square foot rate correct?',
        'Should restoration require an inspection?',
        'Do you confirm the minimum changes if access is restricted?',
      ],
    },
  );
  assert.deepEqual(result.uncertainties, [
    'Should restoration require an inspection?',
    'Do you confirm the minimum changes if access is restricted?',
  ]);
});

test('chronological actual owner notes retain unrelated constraints and replace only explicitly corrected prices', () => {
  const catering = { ...service, name: 'Event catering', unitLabel: 'project' };
  const first = 'I normally charge $40 per guest, with a $500 minimum and no base charge.';
  const second = 'Allergy requests must come to me for review.';
  const base = {
    ...proposed,
    unitLabel: 'guest',
    unitPriceCents: 4000,
    minimumChargeCents: 50000,
    basePriceCents: 0,
  };
  const retained = learning.groundPricingProposal(
    {
      service: catering,
      examples: [{ ...past, unitLabel: 'project' }],
      ownerNotes: [first, second].join('\n'),
      ownerNoteHistory: [first],
      currentOwnerNotes: second,
    },
    base,
  );
  assert.equal(retained.unitPriceCents, 4000);
  assert.equal(retained.minimumChargeCents, 50000);
  assert.equal(retained.unitLabel, 'guest');
  const correction = 'Actually use $45 per guest instead.';
  const changed = learning.groundPricingProposal(
    {
      service: catering,
      examples: [past],
      ownerNotes: [first, second, correction].join('\n'),
      ownerNoteHistory: [first, second],
      currentOwnerNotes: correction,
    },
    base,
  );
  assert.equal(changed.unitPriceCents, 4500);
  assert.equal(changed.minimumChargeCents, 50000);
  assert.equal(changed.basePriceCents, 0);
  const rich = learning.groundPricingProposal(
    {
      service: { ...catering, unitLabel: 'guest' },
      examples: [1, 2, 3].map((index) => ({
        ...past,
        title: `Catered event ${index}`,
        unitLabel: 'guest',
      })),
      ownerNotes: [first, second, correction].join('\n'),
      ownerNoteHistory: [first, second],
      currentOwnerNotes: correction,
    },
    base,
  );
  assert.equal(
    rich.unitPriceCents,
    4500,
    'More historical examples do not override a literal current owner correction',
  );
  const reset = learning.groundPricingProposal(
    {
      service: catering,
      examples: [past],
      ownerNotes: [first, 'No minimum.'].join('\n'),
      ownerNoteHistory: [first],
      currentOwnerNotes: 'No minimum.',
    },
    base,
  );
  assert.equal(reset.minimumChargeCents, 0);
  assert.equal(reset.unitPriceCents, 4000);
  assert.deepEqual(
    learning.ownerNotePricingConflicts(
      'My standard rate is $40 per guest. My standard rate is $45 per guest.',
      'guest',
    ),
    ['unit'],
  );
  assert.deepEqual(
    learning.ownerNotePricingConflicts(
      'Raise the minimum to $600. My standard rate is $40 per guest. My standard rate is $45 per guest.',
      'guest',
    ),
    ['unit'],
    'A correction to another field does not resolve conflicting rates',
  );
  const historicalReference = learning.groundPricingProposal(
    {
      service: catering,
      examples: [past],
      ownerNotes: 'Now my rate is $45 per guest. My previous rate was $40 per guest.',
      ownerNoteHistory: [first],
      currentOwnerNotes: 'Now my rate is $45 per guest. My previous rate was $40 per guest.',
    },
    base,
  );
  assert.equal(
    historicalReference.unitPriceCents,
    4500,
    'Mentioning the previous rate after the new rate does not undo the correction',
  );
});

test('safe empty proposal placeholders omit unknown text without weakening amounts or rules', () => {
  const normalized = learning.modelPricingProposalSchema.parse({
    ...proposed,
    unitLabel: ' ',
    exclusions: ['', '  '],
    uncertainties: [''],
    explanation: ' ',
  });
  assert.equal(normalized.unitLabel, undefined);
  assert.deepEqual(normalized.exclusions, []);
  assert.deepEqual(normalized.uncertainties, []);
  assert.ok(normalized.explanation.length > 0);
  assert.equal(
    learning.modelPricingProposalSchema.safeParse({ ...proposed, unitPriceCents: '4000' }).success,
    false,
  );
  assert.equal(
    learning.modelPricingProposalSchema.safeParse({
      ...proposed,
      pricingRules: [
        {
          id: 'unsafe',
          name: 'Review',
          field: 'condition',
          operator: 'equals',
          value: 'damage',
          kind: 'review',
          amount: 100,
        },
      ],
    }).success,
    false,
  );
});
