import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptySetupDraft,
  emptySetupEvidence,
  validateSetupEvidence,
  readyForSetupConfirmation,
  demoGuideServiceSetup,
  serviceSetupAcknowledgment,
  statedServiceWork,
  statedHistoricalRationale,
  hydrateMissingSetupFacts,
  type SetupDraft,
} from '../src/service-setup-ai.js';
import type { Business } from '../src/domain.js';

function answer(draft: Partial<SetupDraft> = {}) {
  return {
    reply: 'You can review this service and confirm it when ready.',
    draft: {
      ...emptySetupDraft,
      name: 'Concrete washing',
      description: 'Washing concrete driveways and patios',
      ...draft,
    },
    evidence: { ...emptySetupEvidence },
  };
}
const example = {
  title: 'Driveway',
  description: 'A driveway washed last week',
  quantity: 1000,
  finalPriceCents: 27500,
  rationale: 'Algae removal',
};

test('setup preserves unknown historical amounts and never accepts invented units or quantities', () => {
  const result = validateSetupEvidence(
    answer({ unitLabel: 'square feet', example }),
    'I wash driveways; I cannot remember the size or price of a recent project.',
  );
  assert.equal(result.draft.unitLabel, null);
  assert.equal(result.draft.example?.quantity, null);
  assert.equal(result.draft.example?.finalPriceCents, null);
  assert.equal(result.draft.example?.description, example.description);
  assert.equal(readyForSetupConfirmation(result.draft), true, 'Prices and units are optional');
});

test('pricing policies, hypotheticals and negated charges do not become historical prices', () => {
  for (const content of [
    'My minimum is $150.',
    'I would charge $150 for that job.',
    'We charge $150 per project.',
    'I never charged $150 for that job.',
  ]) {
    const draft = answer({ example: { ...example, finalPriceCents: 15000 } });
    draft.evidence.examplePrice = '$150';
    assert.equal(
      validateSetupEvidence(draft, content).draft.example?.finalPriceCents,
      null,
      content,
    );
  }
});

test('literal quote presentation wrappers preserve explicit square-foot quantity and historical charge', () => {
  const content =
    'My service is concrete driveway cleaning, and I quote by square foot. One recent job was a 1000 square foot concrete driveway in Austin with ground-level access. I charged exactly $275 USD because it needed extra preparation before pressure washing. Keep that as one past project, not a general rate or minimum price.';
  const draft = answer({ unitLabel: 'square foot', example });
  draft.evidence.unitLabel = 'quote: "I quote by square foot"';
  draft.evidence.exampleQuantity = 'quote: "a 1000 square foot concrete driveway"';
  draft.evidence.examplePrice = 'quote: "I charged exactly $275 USD"';
  const result = validateSetupEvidence(draft, content);
  assert.equal(result.draft.unitLabel, 'square foot');
  assert.equal(result.draft.example?.quantity, 1000);
  assert.equal(result.draft.example?.finalPriceCents, 27500);
  assert.equal(result.evidence.exampleQuantity, 'a 1000 square foot concrete driveway');
  assert.equal(
    'unitPriceCents' in result.draft,
    false,
    'A historical measurement never establishes a rate',
  );
});

test('a measurement cannot be reinterpreted as a charge and paraphrased evidence is rejected', () => {
  const draft = answer({ example: { ...example, finalPriceCents: 100000 } });
  draft.evidence.examplePrice = '1000';
  draft.evidence.exampleQuantity = 'quote: "a 1000 square feet driveway"';
  const result = validateSetupEvidence(draft, 'I washed a 1000 sqft driveway and charged $275.');
  assert.equal(
    result.draft.example?.finalPriceCents,
    27500,
    'The literal charge is recovered; the measurement never becomes $1000',
  );
  assert.equal(result.draft.example?.quantity, null);
});

test('setup sanitizes extra model questions without rejecting valid facts and its local fallback is explicitly labeled', () => {
  const response = answer();
  response.reply = 'What service? What price?';
  const sanitized = validateSetupEvidence(response, '');
  assert.equal(sanitized.reply, 'What service?');
  assert.equal(sanitized.draft.name, response.draft.name);
  const result = demoGuideServiceSetup({
    business: {} as Business,
    draft: emptySetupDraft,
    messages: [],
    content: 'We provide interior painting for homes',
  });
  assert.match(result.reply, /\[Demo guide\]/);
  assert.equal(result.draft.unitLabel, null);
  assert.equal(result.draft.example, null);
  assert.equal(readyForSetupConfirmation(result.draft), true);
});

test('an explicit quoted unit survives omitted model output and aliases without implying a rate', () => {
  const content =
    'My service is concrete driveway cleaning, and I quote by square foot. One recent job was a 1000 square foot concrete driveway. I charged exactly $275 USD because it needed extra preparation. Keep that as one past project, not a general rate or minimum price.';
  const result = validateSetupEvidence(answer(), content);
  assert.equal(result.draft.unitLabel, 'square foot');
  assert.equal(result.evidence.unitLabel, 'by square foot');
  assert.equal(result.draft.example, null);
  const alias = answer({ unitLabel: 'sqft' });
  alias.evidence.unitLabel = 'quote: "square foot"';
  assert.equal(validateSetupEvidence(alias, content).draft.unitLabel, 'sqft');
  for (const unsupported of [
    'I washed a 1000 square foot driveway and charged $275.',
    'I do not quote by square foot.',
    'I would quote by square foot if I measured it.',
    'I quote by square foot or hour depending on the project.',
    'I quote per hour for repairs. I quote per project for installations.',
  ])
    assert.equal(validateSetupEvidence(answer(), unsupported).draft.unitLabel, null, unsupported);
});

test('one literal past-job measurement and its because-clause recover omitted or paraphrased model facts', () => {
  const owner =
    'My service is concrete driveway cleaning, and I quote by square foot. One recent job was a 1000 square foot concrete driveway in Austin with ground-level access. I charged exactly $275 USD because it needed extra preparation before pressure washing. Keep that as one past project, not a general rate or minimum price.';
  for (const omitted of [true, false]) {
    const response = answer({
      example: { ...example, quantity: omitted ? null : 1000, rationale: '' },
    });
    response.evidence.exampleQuantity = omitted ? null : '1000 square feet';
    response.evidence.examplePrice = '$275 USD';
    const result = validateSetupEvidence(response, owner);
    assert.equal(result.draft.unitLabel, 'square foot');
    assert.equal(result.draft.example?.quantity, 1000);
    assert.equal(result.evidence.exampleQuantity, '1000 square foot');
    assert.equal(result.draft.example?.finalPriceCents, 27500);
    assert.equal(
      result.draft.example?.rationale,
      'because it needed extra preparation before pressure washing',
    );
    assert.equal('unitPriceCents' in result.draft, false);
  }
});

test('historical fallback leaves ambiguous measurements unknown while preserving an independently stated job reason', () => {
  for (const [owner, reason] of [
    [
      'I quote by square foot. One recent job was a 1000 square foot driveway and a 250 square foot patio. I charged $275 because both were dirty.',
      'because both were dirty',
    ],
    [
      'I quote by square foot. Last week I washed 1000 sqft and charged $275 because it had algae. Another recent job was 2000 sqft and I charged $400 because it was bigger.',
      '',
    ],
    [
      'I quote by square foot. I would have washed a 1000 sqft driveway and charged $275 because it had algae.',
      '',
    ],
    [
      'I quote by square foot. I never washed that 1000 sqft driveway or charged $275 because it was cancelled.',
      '',
    ],
    [
      'I quote by hour. One recent job was a 1000 square foot driveway and I charged $275 because it needed preparation.',
      'because it needed preparation',
    ],
    [
      'One recent job was a 1000 square foot driveway and I charged $275 because it needed preparation.',
      'because it needed preparation',
    ],
  ]) {
    const response = answer({ example: { ...example, quantity: null, rationale: '' } });
    response.evidence.examplePrice = '$275';
    const result = validateSetupEvidence(response, owner);
    assert.equal(result.draft.example?.quantity, null, owner);
    assert.equal(result.draft.example?.rationale, reason, owner);
  }
});

test('a clear inspection service needs no priced job and a missing model name uses only literal owner work', () => {
  const owner =
    'I repair household appliances in Austin. Before I quote any repair, I always need to inspect the appliance on site and diagnose the fault. I ask customers for the appliance make and model, what it is doing wrong, and photos if they have them. I do not have a standard repair rate or a call-out price yet.';
  const response = answer({
    name: null,
    description: 'On-site diagnosis and repair of household appliances',
    example: null,
  });
  response.reply = 'Could you tell me about a specific past job and what you charged?';
  const result = validateSetupEvidence(response, owner);
  assert.equal(result.draft.name, 'Repair household appliances');
  assert.equal(readyForSetupConfirmation(result.draft), true);
  assert.equal(result.draft.unitLabel, null);
  assert.equal(result.draft.example, null);
  assert.deepEqual(result.evidence, emptySetupEvidence);
  assert.deepEqual(statedServiceWork(owner), {
    name: 'Repair household appliances',
    description: 'I repair household appliances in Austin.',
  });
  const oldDraft = { ...emptySetupDraft };
  const recovered = hydrateMissingSetupFacts(oldDraft, owner);
  assert.equal(readyForSetupConfirmation(recovered), true);
  assert.equal(oldDraft.name, null, 'Read-only hydration never mutates stored data');
  for (const unclear of [
    'I do some work for customers.',
    'I might repair household appliances.',
    'I do not repair household appliances.',
    'I repair appliances or cars.',
    'I repair appliances. I paint houses.',
    'My business is Austin Services.',
    'What should I repair?',
  ]) {
    const unknown = hydrateMissingSetupFacts(emptySetupDraft, unclear);
    assert.equal(unknown.name, null, unclear);
    assert.equal(readyForSetupConfirmation(unknown), false, unclear);
  }
});

test('one actual charged-job because clause survives unknown hours or unit without inventing a quantity', () => {
  const owner =
    'I’m a photographer in Denver. I recently photographed a birthday portrait session and charged $180 because it was a brief shoot and included edited photos. I bill by the hour, but I didn’t record how many hours that job took. I price each job individually and don’t have a standard hourly rate.';
  for (const unitLabel of [null, 'hour']) {
    const response = answer({
      name: 'Portrait photography',
      description: 'Birthday portrait sessions',
      unitLabel,
      example: {
        title: 'Birthday portrait session',
        description: 'A brief birthday portrait shoot with edited photos',
        quantity: null,
        finalPriceCents: 18000,
        rationale: '',
      },
    });
    response.evidence.unitLabel = unitLabel ? 'by the hour' : null;
    response.evidence.examplePrice = '$180';
    const result = validateSetupEvidence(response, owner);
    assert.equal(result.draft.example?.quantity, null);
    assert.equal(result.draft.example?.finalPriceCents, 18000);
    assert.equal(
      result.draft.example?.rationale,
      'because it was a brief shoot and included edited photos',
    );
    assert.equal('unitPriceCents' in result.draft, false);
    const legacy = hydrateMissingSetupFacts(response.draft, owner);
    assert.equal(legacy.example?.rationale, result.draft.example?.rationale);
    assert.equal(legacy.example?.quantity, null);
    assert.equal(legacy.unitLabel, unitLabel, 'Legacy read recovery never guesses a missing unit');
  }
  for (const ambiguous of [
    'I would have charged $180 because it was brief.',
    'I never charged $180 because it was cancelled.',
    'I charged $180 because it was brief. I charged $200 because it included editing.',
    'I charged $180 because it was brief. I charged $180 because it included editing.',
    'I charged $9 per window because it was straightforward.',
  ])
    assert.equal(statedHistoricalRationale(ambiguous, 18000), null, ambiguous);
  assert.equal(statedHistoricalRationale(owner, null), null);
  assert.equal(statedHistoricalRationale(owner, 20000), null);
});

test('a useful first-job summary invites practice while preserving unknown prices', () => {
  const noHistory = serviceSetupAcknowledgment(answer().draft);
  assert.match(noHistory, /Review the summary to continue/);
  assert.equal(noHistory.includes('$0'), false);
  assert.equal(noHistory.includes('?'), false);
  const history = serviceSetupAcknowledgment(answer({ example }).draft);
  assert.match(history, /\$275\.00 past job/);
  assert.equal(history.includes('rate'), false);
});

test('exact guest history keeps its empty separate rationale instead of taking another same-amount job reason', () => {
  const quote = 'The last cabinet repair was $90 USD because its door had split.';
  const owner = `I repair cabinets. ${quote} I charged $90 USD because an unrelated delivery needed extra travel.`;
  const guest: SetupDraft = {
    name: 'Cabinet repair',
    description: 'Repairing cabinet doors.',
    unitLabel: null,
    sourcePriceText: '$90 USD',
    sourceCurrency: 'USD',
    example: {
      title: 'Job described',
      description: quote,
      quantity: null,
      finalPriceCents: 9000,
      rationale: '',
    },
  };
  const hydrated = hydrateMissingSetupFacts(guest, owner);
  assert.equal(hydrated.example?.description, quote);
  assert.equal(hydrated.example?.rationale, '');
  assert.equal(
    guest.example?.rationale,
    '',
    'Read-only hydration leaves stored guest evidence untouched',
  );
  const legacy = hydrateMissingSetupFacts(
    { ...guest, example: { ...guest.example!, description: 'A cabinet repair discussed earlier' } },
    'I charged $90 USD because the cabinet needed extra preparation.',
  );
  assert.equal(
    legacy.example?.rationale,
    'because the cabinet needed extra preparation',
    'Legacy nonliteral history still recovers its supported reason',
  );
});

test('a single literal past charge survives omitted or invalid model evidence without becoming a rate', () => {
  const owner =
    'I quote by square foot. One recent job was a 1000 square foot driveway. I charged exactly $275 USD because it needed extra preparation before pressure washing. Keep that as one past project, not a general rate or minimum price.';
  for (const supplied of [null, 27500]) {
    const response = answer({
      example: { ...example, quantity: null, finalPriceCents: supplied, rationale: '' },
    });
    response.evidence.examplePrice = supplied === null ? null : 'I charged 275 dollars';
    const result = validateSetupEvidence(response, owner);
    assert.equal(result.draft.example?.finalPriceCents, 27500);
    assert.equal(result.draft.example?.quantity, 1000);
    assert.equal(
      result.draft.example?.rationale,
      'because it needed extra preparation before pressure washing',
    );
    assert.equal(result.evidence.examplePrice, '$275');
  }
  for (const text of [
    'I would have charged $275 for the job.',
    'I never charged $275 for the job.',
    'I usually charge $275 per project.',
    'I charged $9 per window.',
    'I charged between $200 and $300.',
    'I charged $200 to $300.',
    'I charged $225 for one job. I charged $275 for another job.',
    'I charged $275 last week. I am not sure what I charged.',
  ])
    assert.equal(
      validateSetupEvidence(answer({ example: { ...example, finalPriceCents: null } }), text).draft
        .example?.finalPriceCents,
      null,
      text,
    );
});

test('setup never labels a window measurement as a project count', () => {
  const response = answer({
    unitLabel: 'project',
    example: { ...example, quantity: 24, finalPriceCents: 22500 },
  });
  response.evidence.unitLabel = 'per project';
  response.evidence.exampleQuantity = '24 windows';
  response.evidence.examplePrice = '$225';
  const result = validateSetupEvidence(
    response,
    'I quote per project. I cleaned 24 windows and charged $225.',
  );
  assert.equal(result.draft.unitLabel, 'project');
  assert.equal(result.draft.example?.quantity, null);
});
