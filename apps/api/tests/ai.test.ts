import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { z } from 'zod';

const originalFetch = globalThis.fetch;
const originalProvider = process.env.AI_PROVIDER;
const originalKey = process.env.OPENAI_API_KEY;
const originalModel = process.env.OPENAI_MODEL;
let ai: typeof import('../src/ai/index.js');

before(async () => {
  process.env.AI_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = 'test-key-not-a-real-provider-credential';
  process.env.OPENAI_MODEL = 'mock-model';
  ai = await import('../src/ai/index.js');
});
beforeEach(() => {
  process.env.OPENAI_API_KEY = 'test-key-not-a-real-provider-credential';
  globalThis.fetch = async () => {
    throw new Error('A test must explicitly mock its provider response.');
  };
});
after(() => {
  globalThis.fetch = originalFetch;
  if (originalProvider === undefined) delete process.env.AI_PROVIDER;
  else process.env.AI_PROVIDER = originalProvider;
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalKey;
  if (originalModel === undefined) delete process.env.OPENAI_MODEL;
  else process.env.OPENAI_MODEL = originalModel;
});

function response(result: unknown, overrides: Record<string, unknown> = {}): Response {
  return Response.json(
    {
      status: 'completed',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] },
      ],
      usage: { input_tokens: 42, output_tokens: 12 },
      ...overrides,
    },
    { headers: { 'x-request-id': 'mock-request-id' } },
  );
}

// A small stand-in for the app's real requests (intake, quote drafts, practice customers).
const replyJson = {
  type: 'object',
  properties: { reply: { type: 'string' } },
  required: ['reply'],
  additionalProperties: false,
};
const replySchema = z.object({ reply: z.string().min(1).max(200) }).strict();
const ask = (images: { mimeType: string; dataBase64: string }[] = [], adapter: typeof ai = ai) =>
  adapter.requestJson(
    'intake_turn',
    'Reply to the customer.',
    { message: 'I have 12 windows.' },
    replyJson,
    replySchema,
    images,
  );

test('Responses uses strict structured output, actual vision parts, and records token usage', async () => {
  let requestBody: any;
  const events: unknown[] = [];
  const photo = Buffer.from('normalized-photo-fixture').toString('base64');
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    requestBody = JSON.parse(String(init?.body));
    return response({ reply: 'How many are upstairs?' });
  };
  const result = await ai.runWithAiUsage(
    {
      businessId: 'tenant-a',
      record: async (event) => {
        events.push(event);
      },
    },
    () => ask([{ mimeType: 'image/jpeg', dataBase64: photo }]),
  );
  assert.equal(result.reply, 'How many are upstairs?');
  assert.equal(requestBody.store, false);
  assert.equal(requestBody.text.format.type, 'json_schema');
  assert.equal(requestBody.text.format.strict, true);
  assert.equal(requestBody.input[0].content[1].type, 'input_image');
  assert.equal(requestBody.input[0].content[1].image_url, `data:image/jpeg;base64,${photo}`);
  assert.ok(!requestBody.input[0].content[0].text.includes(photo));
  const [{ durationMs, ...usage }] = events;
  assert.ok(typeof durationMs === 'number' && durationMs >= 0, 'How long the call took');
  assert.deepEqual(usage, {
    provider: 'openai',
    model: 'mock-model',
    inputTokens: 42,
    outputTokens: 12,
    operation: 'intake_turn',
    requestId: 'mock-request-id',
  });
});

test('incomplete and schema-invalid responses fail closed after usage is recorded', async () => {
  const events: unknown[] = [];
  globalThis.fetch = async () => response({ reply: 'Hi' }, { status: 'incomplete' });
  await assert.rejects(
    ai.runWithAiUsage(
      {
        businessId: 'tenant-a',
        record: async (event) => {
          events.push(event);
        },
      },
      () => ask(),
    ),
    ai.AiError,
  );
  assert.equal(events.length, 1);
  globalThis.fetch = async () => response({ reply: 'Hi', extra: 'not in the schema' });
  await assert.rejects(ask(), ai.AiError);
  globalThis.fetch = async () => response({ reply: 'x'.repeat(201) });
  await assert.rejects(ask(), ai.AiError);
});

test('a quote draft that runs long is clipped, not thrown away', async () => {
  const { draftQuote } = await import('../src/ai/quote-engine.js');
  const lines = Array.from({ length: 25 }, (_, index) => ({
    label: `Window ${index + 1}`,
    amountCents: 1500,
  }));
  globalThis.fetch = async () =>
    response({
      decision: 'quote',
      reason: 'No past interior window jobs to go on, so this is based on '.repeat(6),
      lines,
      discountKind: 'none',
      discountValue: null,
      discountReason: '',
      start: 'Next week',
      duration: '',
      confidence: 'low',
      reasoning: 'x '.repeat(400),
    });
  const drafted = await draftQuote({
    history: {} as never,
    request: { serviceName: 'Interior windows', conversation: [] },
    images: [],
  });
  assert.ok(drafted.reason.length <= 200 && drafted.reason.endsWith('…'), drafted.reason);
  assert.ok(drafted.reasoning.length <= 600);
  assert.equal(drafted.lines.length, 20, 'As many lines as an owner can send');
  assert.equal(drafted.lines.at(-1)?.label, 'Everything else');
  assert.equal(
    drafted.lines.reduce((sum, line) => sum + line.amountCents, 0),
    25 * 1500,
    'No money is lost',
  );
});

test('the generic baseline sees the job but none of the owner’s history, and always prices it', async () => {
  const { draftGenericQuote } = await import('../src/ai/quote-engine.js');
  let requestBody: any;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return response({
      decision: 'site_visit',
      reason: 'Would want to see it',
      lines: [{ label: 'Driveway, 600 sq ft', amountCents: 18000 }],
      discountKind: 'percent',
      discountValue: 10,
      discountReason: 'First job',
      start: '',
      duration: '',
      confidence: 'medium',
      reasoning: 'Typical local rate.',
    });
  };
  const drafted = await draftGenericQuote({
    business: { trade: 'Pressure washing', services: ['Driveways'], area: 'Raleigh, NC' },
    request: {
      serviceName: 'Driveways',
      conversation: [{ from: 'customer', text: 'Two-car driveway, pretty dirty.' }],
      details: '600 sq ft',
    },
    images: [],
  });
  const sent = requestBody.input[0].content[0].text;
  assert.match(sent, /600 sq ft/);
  assert.doesNotMatch(sent, /pastJobs|practice|liveQuotes|rates/);
  assert.equal(drafted.decision, 'quote', 'Every job gets a price to compare');
  assert.equal(drafted.discount, null);
  assert.equal(drafted.lines[0].amountCents, 18000);
});

test('explicit transient failure is retried once, with no demo fallback', async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    return new Response('unavailable', { status: 503 });
  };
  await assert.rejects(ask(), ai.AiError);
  assert.equal(attempts, 2);
  assert.equal(ai.aiMode, 'live');
});

test('ambiguous transport failure is not automatically retried', async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    throw new Error('connection interrupted');
  };
  await assert.rejects(ask(), ai.AiError);
  assert.equal(attempts, 1);
});

test('missing live credentials fail without a network call', async () => {
  delete process.env.OPENAI_API_KEY;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return response({ reply: 'Hi' });
  };
  await assert.rejects(ask(), /Configure OPENAI_API_KEY/);
  assert.equal(requests, 0);
});

test('photo limits are enforced before provider invocation', async () => {
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return response({ reply: 'Hi' });
  };
  await assert.rejects(
    ask(Array.from({ length: 4 }, () => ({ mimeType: 'image/jpeg', dataBase64: 'aGVsbG8=' }))),
    ai.AiError,
  );
  await assert.rejects(ask([{ mimeType: 'image/gif', dataBase64: 'aGVsbG8=' }]), ai.AiError);
  assert.equal(requests, 0);
});

test('Anthropic uses a constrained tool result and separate base64 image content', async () => {
  process.env.AI_PROVIDER = 'anthropic';
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const originalAnthropicModel = process.env.ANTHROPIC_MODEL;
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key-not-real';
  process.env.ANTHROPIC_MODEL = 'mock-anthropic-model';
  try {
    const adapter = (await import(
      new URL('../src/ai/index.ts?test-provider=anthropic', import.meta.url).href
    )) as typeof ai;
    let requestBody: any;
    globalThis.fetch = async (url, init) => {
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', name: 'emit_result', input: { reply: 'Upstairs too?' } }],
        usage: { input_tokens: 30, output_tokens: 10 },
      });
    };
    const photo = Buffer.from('normalized-fixture').toString('base64');
    const result = await ask([{ mimeType: 'image/png', dataBase64: photo }], adapter);
    assert.equal(result.reply, 'Upstairs too?');
    assert.equal(requestBody.tool_choice.name, 'emit_result');
    assert.equal(requestBody.messages[0].content[1].source.data, photo);
    assert.ok(!requestBody.messages[0].content[0].text.includes(photo));
  } finally {
    process.env.AI_PROVIDER = 'openai';
    if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    if (originalAnthropicModel === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = originalAnthropicModel;
  }
});

test('Meta uses the Responses API with reasoning room and skips commentary', async () => {
  process.env.AI_PROVIDER = 'meta';
  const originalMetaKey = process.env.META_API_KEY;
  const originalMetaModel = process.env.META_MODEL;
  process.env.META_API_KEY = 'test-meta-key-not-real';
  delete process.env.META_MODEL;
  try {
    const adapter = (await import(
      new URL('../src/ai/index.ts?test-provider=meta', import.meta.url).href
    )) as typeof ai;
    let requestBody: any;
    let authorization: string | null = null;
    globalThis.fetch = async (url, init) => {
      assert.equal(url, 'https://api.meta.ai/v1/responses');
      authorization = new Headers(init?.headers).get('authorization');
      requestBody = JSON.parse(String(init?.body));
      return response(
        { reply: 'Upstairs too?' },
        {
          output: [
            { type: 'reasoning', id: 'rs_1' },
            {
              type: 'message',
              phase: 'commentary',
              content: [{ type: 'output_text', text: 'Checking the windows.' }],
            },
            {
              type: 'message',
              content: [{ type: 'output_text', text: JSON.stringify({ reply: 'Upstairs too?' }) }],
            },
          ],
        },
      );
    };
    const photo = Buffer.from('normalized-fixture').toString('base64');
    const result = await ask([{ mimeType: 'image/png', dataBase64: photo }], adapter);
    assert.equal(result.reply, 'Upstairs too?');
    assert.equal(authorization, 'Bearer test-meta-key-not-real');
    assert.equal(requestBody.model, 'muse-spark-1.3');
    assert.equal(requestBody.store, false);
    assert.equal(requestBody.reasoning.effort, 'low');
    assert.ok(requestBody.max_output_tokens > 2500);
    assert.equal(requestBody.input[0].content[1].image_url, `data:image/png;base64,${photo}`);
    assert.equal(requestBody.input[0].content[1].detail, undefined);

    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return response({ reply: 'Hi' });
    };
    process.env.META_MODEL = 'muse-spark-1.3-contributor';
    await assert.rejects(ask([], adapter), /Standard-mode/);
    assert.equal(calls, 0);
  } finally {
    process.env.AI_PROVIDER = 'openai';
    if (originalMetaKey === undefined) delete process.env.META_API_KEY;
    else process.env.META_API_KEY = originalMetaKey;
    if (originalMetaModel === undefined) delete process.env.META_MODEL;
    else process.env.META_MODEL = originalMetaModel;
  }
});

test('demo mode never calls a live provider', async () => {
  process.env.AI_PROVIDER = 'demo';
  try {
    const adapter = (await import(
      new URL('../src/ai/index.ts?test-provider=demo', import.meta.url).href
    )) as typeof ai;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new Error('Demo must not use a live provider.');
    };
    assert.equal(adapter.aiMode, 'demo');
    await assert.rejects(ask([], adapter), adapter.AiError);
    assert.equal(calls, 0);
  } finally {
    process.env.AI_PROVIDER = 'openai';
  }
});

test('the benchmark keeps each answer, and a replay gives it back without the model or a key', async () => {
  const saved: Record<string, { operation: string; answers: unknown[] }> = {};
  ai.useSavedAnswers({
    replayOnly: false,
    answer: () => undefined,
    keep: (key, operation, answer) => {
      saved[key] ??= { operation, answers: [] };
      saved[key].answers.push(answer);
    },
  });
  try {
    globalThis.fetch = async () => response({ reply: 'How many are upstairs?' });
    assert.deepEqual(await ask(), { reply: 'How many are upstairs?' });
    assert.deepEqual(Object.values(saved), [
      { operation: 'intake_turn', answers: [{ reply: 'How many are upstairs?' }] },
    ]);

    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new Error('A replay never reaches the model.');
    };
    delete process.env.OPENAI_API_KEY;
    ai.useSavedAnswers({
      replayOnly: true,
      answer: (key) => saved[key]?.answers[0],
      keep: () => {},
    });
    assert.deepEqual(await ask(), { reply: 'How many are upstairs?' });
    const unsaved = ai.requestJson(
      'intake_turn',
      'Reply to the customer.',
      { message: 'I have 30 windows.' },
      replyJson,
      replySchema,
    );
    await assert.rejects(unsaved, /wasn’t in the saved run/);
    assert.equal(calls, 0);
  } finally {
    ai.useSavedAnswers(null);
  }
});

test('a saved answer is found again when only ids and times differ', () => {
  const key = (id: string, at: string, text: string) =>
    ai.answerKey('read_job', 'mock-model', 'Read the job.', { id, at, text });
  const first = key(
    '0b6f4f8e-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
    '2026-10-29T09:00:00.000Z',
    '12 windows',
  );
  assert.equal(
    key('9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b', '2026-10-30T17:45:12.345Z', '12 windows'),
    first,
  );
  assert.notEqual(
    key('0b6f4f8e-1c2d-4e5f-8a9b-0c1d2e3f4a5b', '2026-10-29T09:00:00.000Z', '14 windows'),
    first,
  );
  assert.notEqual(
    ai.answerKey('read_job', 'other-model', 'Read the job.', {
      id: '0b6f4f8e-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
      at: '2026-10-29T09:00:00.000Z',
      text: '12 windows',
    }),
    first,
    'Another model is another answer',
  );
});

test('a size given as an add-on’s count is dropped, not a failed read', async () => {
  const { readJobParts } = await import('../src/ai/formula.js');
  globalThis.fetch = async () =>
    response({
      service: 'House wash',
      size: 1440,
      surcharges: [],
      addOns: [
        { name: 'Sealing', count: 1440 },
        { name: 'Downspout flush', count: 3 },
      ],
      otherServices: [],
      uncovered: '',
    });
  const read = await readJobParts({
    formula: {
      services: [
        { name: 'House wash', unit: 'sq ft', rateCents: 20, points: [], minimumCents: null },
      ],
      surcharges: [],
      addOns: [
        { name: 'Sealing', per: 'unit', cents: 30 },
        { name: 'Downspout flush', per: 'item', cents: 1500 },
      ],
      bundlePercent: null,
      roundToCents: 100,
      minimumCents: null,
      itemizes: true,
    },
    request: {
      serviceName: 'House wash',
      conversation: [{ from: 'customer', text: 'Seal it too.' }],
    },
  });
  assert.deepEqual(read.addOns, [
    { name: 'Sealing', count: null },
    { name: 'Downspout flush', count: 3 },
  ]);
});

test('asking the same question again keeps its own saved answer', async () => {
  const saved: Record<string, unknown[]> = {};
  ai.useSavedAnswers({
    replayOnly: false,
    answer: () => undefined,
    keep: (key, _operation, answer) => {
      saved[key] = [...(saved[key] ?? []), answer];
    },
  });
  const again = (asking?: number) =>
    ai.requestJson(
      'intake_turn',
      'Reply to the customer.',
      { message: 'I have 12 windows.' },
      replyJson,
      replySchema,
      [],
      [],
      { asking },
    );
  try {
    const replies = ['First.', 'Second.'];
    globalThis.fetch = async () => response({ reply: replies.shift() });
    await again();
    await again(1);
    // The first asking is saved as it always was, so older saved runs still replay.
    assert.deepEqual(
      saved[
        ai.answerKey('intake_turn', 'mock-model', 'Reply to the customer.', {
          message: 'I have 12 windows.',
        })
      ],
      [{ reply: 'First.' }],
    );
    assert.deepEqual(
      saved[
        ai.answerKey('intake_turn#1', 'mock-model', 'Reply to the customer.', {
          message: 'I have 12 windows.',
        })
      ],
      [{ reply: 'Second.' }],
    );
  } finally {
    ai.useSavedAnswers(null);
  }
});

test('a formula quote is the middle of its readings, and a range when they disagree', async () => {
  const { priceFromFormula } = await import('../src/pricing/formula-draft.js');
  const reading = (rateCents: number) => ({
    formula: {
      services: [{ name: 'Windows', unit: 'windows', rateCents, points: [], minimumCents: null }],
      surcharges: [],
      addOns: [],
      bundlePercent: null,
      roundToCents: 100,
      minimumCents: null,
      itemizes: true,
    },
    notes: [],
    examples: [],
    gaps: [0, 0, 0],
    fits: true,
  });
  globalThis.fetch = async () =>
    response({
      service: 'Windows',
      size: 20,
      surcharges: [],
      addOns: [],
      otherServices: [],
      uncovered: '',
      unpriced: '',
    });
  const input = {
    serviceName: 'Windows',
    conversation: [{ from: 'customer' as const, text: '20 windows, please.' }],
    spec: null,
  };
  const close = await priceFromFormula(
    { ...reading(1000), also: [reading(1020), reading(990)] },
    input,
  );
  assert.equal(close.drafted?.lines[0].amountCents, 20000);
  assert.equal(close.drafted?.confidence, 'high');
  assert.deepEqual(close.use.used && close.use.readings, [19800, 20000, 20400]);

  const apart = await priceFromFormula(
    { ...reading(1000), also: [reading(1500), reading(900)] },
    input,
  );
  assert.equal(apart.drafted?.lines[0].amountCents, 20000);
  assert.equal(apart.drafted?.confidence, 'low');
  assert.match(apart.drafted?.reasoning ?? '', /anywhere from \$180 to \$300/);
});
