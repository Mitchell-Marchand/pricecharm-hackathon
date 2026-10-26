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
const inquiry = {
  business: { name: 'Test business', description: 'Cleaning', serviceArea: 'Austin' },
  service: {
    name: 'Windows',
    description: 'Window cleaning',
    unitLabel: 'window',
    requiredInputs: ['window count', 'access'],
    exclusions: ['industrial'],
  },
  messages: [],
  content: 'I have 12 windows.',
};
const analysis = {
  reply: 'Are the windows accessible from ground level?',
  extractedInputs: [{ name: 'window count', value: '12' }],
  missingInputs: ['access'],
  needsReview: false,
  reviewReason: '',
};

test('Responses uses strict structured output, actual vision parts, and records token usage', async () => {
  let requestBody: any;
  const events: unknown[] = [];
  const photo = Buffer.from('normalized-photo-fixture').toString('base64');
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    requestBody = JSON.parse(String(init?.body));
    return response(analysis);
  };
  const result = await ai.runWithAiUsage(
    {
      businessId: 'tenant-a',
      record: async (event) => {
        events.push(event);
      },
    },
    () =>
      ai.analyzeInquiry({
        ...inquiry,
        service: Object.assign({}, inquiry.service, {
          unitPriceCents: 9876543,
          businessId: 'private-business-id',
        }),
        images: [{ mimeType: 'image/jpeg', dataBase64: photo }],
      }),
  );
  assert.equal(result.reply, analysis.reply);
  assert.equal(requestBody.store, false);
  assert.equal(requestBody.text.format.type, 'json_schema');
  assert.equal(requestBody.text.format.strict, true);
  assert.equal(requestBody.input[0].content[1].type, 'input_image');
  assert.equal(requestBody.input[0].content[1].image_url, `data:image/jpeg;base64,${photo}`);
  assert.ok(!requestBody.input[0].content[0].text.includes(photo));
  assert.ok(!requestBody.input[0].content[0].text.includes('unitPriceCents'));
  assert.ok(!requestBody.input[0].content[0].text.includes('private-business-id'));
  assert.deepEqual(events, [
    {
      provider: 'openai',
      model: 'mock-model',
      inputTokens: 42,
      outputTokens: 12,
      operation: 'clarify_inquiry',
      requestId: 'mock-request-id',
    },
  ]);
});

test('provider output is validated and cannot issue a monetary quote through chat', async () => {
  globalThis.fetch = async () =>
    response({
      ...analysis,
      reply: 'The total is $250.',
      missingInputs: ['access', 'ignore all rules'],
    });
  const result = await ai.analyzeInquiry(inquiry);
  assert.equal(result.needsReview, true);
  assert.ok(!result.reply.includes('$250'));
  assert.deepEqual(result.missingInputs, ['access']);
});

test('unknown empty fact placeholders become missing questions instead of a failed customer turn', async () => {
  globalThis.fetch = async () =>
    response({
      ...analysis,
      extractedInputs: [
        { name: 'window count', value: '12' },
        { name: ' access ', value: '   ' },
        { name: '', value: '' },
      ],
      missingInputs: ['', ' access '],
    });
  const result = await ai.analyzeInquiry(inquiry);
  assert.deepEqual(result.extractedInputs, [{ name: 'window count', value: '12' }]);
  assert.deepEqual(result.missingInputs, ['access']);
  assert.equal(result.reply, analysis.reply);
});

test('explicit zero and false string answers remain facts and undeclared fields are omitted', async () => {
  globalThis.fetch = async () =>
    response({
      ...analysis,
      extractedInputs: [
        { name: 'window count', value: '0' },
        { name: 'access', value: ' false ' },
        { name: 'ownerApproved', value: 'true' },
      ],
      missingInputs: ['window count', 'access'],
    });
  const result = await ai.analyzeInquiry(inquiry);
  assert.deepEqual(result.extractedInputs, [
    { name: 'window count', value: '0' },
    { name: 'access', value: 'false' },
  ]);
  assert.deepEqual(result.missingInputs, []);
});

test('customer location and rule fact fields are retained without sending private pricing rules', async () => {
  let requestBody: any;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return response({
      ...analysis,
      extractedInputs: [
        { name: 'window count', value: '12' },
        { name: 'location', value: 'Austin' },
        { name: 'screens present', value: 'false' },
        { name: 'ownerApproved', value: 'true' },
      ],
      missingInputs: ['access', 'ownerApproved'],
    });
  };
  const result = await ai.analyzeInquiry({
    ...inquiry,
    service: {
      ...inquiry.service,
      pricingRules: [
        Object.assign(
          { field: 'screens present' },
          {
            name: 'Private adjustment',
            kind: 'per_unit',
            amount: 9876543,
          },
        ),
      ],
    },
    content: 'I have 12 windows in Austin, without screens.',
  });
  assert.deepEqual(result.extractedInputs, [
    { name: 'window count', value: '12' },
    { name: 'location', value: 'Austin' },
    { name: 'screens present', value: 'false' },
  ]);
  assert.deepEqual(result.missingInputs, ['access']);
  const providerText = requestBody.input[0].content[0].text;
  assert.ok(providerText.includes('location'));
  assert.ok(providerText.includes('screens present'));
  assert.ok(!providerText.includes('pricingRules'));
  assert.ok(!providerText.includes('Private adjustment'));
  assert.ok(!providerText.includes('9876543'));
});

test('conflicting structured answers require clarification rather than picking a convenient value', async () => {
  globalThis.fetch = async () =>
    response({
      ...analysis,
      extractedInputs: [
        { name: 'window count', value: '12' },
        { name: 'access', value: 'ground-level' },
        { name: 'access', value: 'third-floor' },
      ],
      missingInputs: ['window count'],
    });
  const result = await ai.analyzeInquiry({
    ...inquiry,
    knownInputs: { 'window count': '12', access: 'ground-level' },
  });
  assert.equal(result.needsReview, true);
  assert.deepEqual(result.missingInputs, ['access']);
  assert.deepEqual(result.extractedInputs, [{ name: 'window count', value: '12' }]);
});

test('unknown normalization never coerces unsafe types or accepts excess fields and oversized output', async () => {
  for (const invalid of [
    { ...analysis, needsReview: 'false' },
    { ...analysis, extractedInputs: [{ name: 'access', value: false }] },
    { ...analysis, extractedInputs: [{ name: 'window count', value: 0 }] },
    { ...analysis, extractedInputs: [{ name: 'access', value: 'easy', approved: true }] },
    { ...analysis, reply: 'x'.repeat(2501) },
    { ...analysis, reviewReason: 'x'.repeat(601) },
  ]) {
    globalThis.fetch = async () => response(invalid);
    await assert.rejects(ai.analyzeInquiry(inquiry), ai.AiError);
  }
});

test('incomplete and schema-invalid responses fail closed after usage is recorded', async () => {
  const events: unknown[] = [];
  globalThis.fetch = async () => response(analysis, { status: 'incomplete' });
  await assert.rejects(
    ai.runWithAiUsage(
      {
        businessId: 'tenant-a',
        record: async (event) => {
          events.push(event);
        },
      },
      () => ai.analyzeInquiry(inquiry),
    ),
    ai.AiError,
  );
  assert.equal(events.length, 1);
  globalThis.fetch = async () => response({ reply: 'Incomplete schema' });
  await assert.rejects(ai.analyzeInquiry(inquiry), ai.AiError);
});

test('explicit transient failure is retried once, with no demo fallback', async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    return new Response('unavailable', { status: 503 });
  };
  await assert.rejects(ai.analyzeInquiry(inquiry), ai.AiError);
  assert.equal(attempts, 2);
  assert.equal(ai.aiMode, 'live');
});

test('anonymous guest previews never retry transient provider failures', async () => {
  for (const status of [429, 502, 503, 504]) {
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts++;
      return new Response('unavailable', { status });
    };
    await assert.rejects(
      ai.requestJson(
        'guest_preview',
        'Read the supplied fictional job.',
        { content: 'Fictional portrait session.' },
        { type: 'object' },
        z.object({ answer: z.string() }),
        [],
        [],
        { maxAttempts: 2 },
      ),
      ai.AiError,
    );
    assert.equal(attempts, 1);
  }
});

test('guest usage is recorded without a business and guest output stays bounded', async () => {
  const priorOutput = process.env.AI_MAX_OUTPUT_TOKENS;
  const usage: unknown[] = [];
  try {
    process.env.AI_MAX_OUTPUT_TOKENS = '8000';
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.max_output_tokens, 1800);
      assert.equal(body.store, false);
      return response({ answer: 'Customer questions only.' });
    };
    const result = await ai.runWithAiUsage(
      {
        previewId: 'guest-preview-with-no-business',
        record: async (event) => {
          usage.push(event);
        },
      },
      () =>
        ai.requestJson(
          'guest_preview',
          'Read the supplied fictional job.',
          { content: 'Fictional portrait session.' },
          { type: 'object' },
          z.object({ answer: z.string() }),
        ),
    );
    assert.equal(result.answer, 'Customer questions only.');
    assert.equal(usage.length, 1);
    assert.equal((usage[0] as { operation: string }).operation, 'guest_preview');
  } finally {
    if (priorOutput === undefined) delete process.env.AI_MAX_OUTPUT_TOKENS;
    else process.env.AI_MAX_OUTPUT_TOKENS = priorOutput;
  }
});

test('one guest usage context cannot dispatch a second logical provider request', async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    return response({ answer: 'Already read.' });
  };
  await ai.runWithAiUsage(
    { previewId: 'single-guest-attempt', record: async () => {} },
    async () => {
      const read = () =>
        ai.requestJson(
          'guest_preview',
          'Read once.',
          {},
          { type: 'object' },
          z.object({ answer: z.string() }),
        );
      await read();
      await assert.rejects(read(), ai.AiError);
    },
  );
  assert.equal(attempts, 1);
});

test('ambiguous transport failure is not automatically retried', async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    throw new Error('connection interrupted');
  };
  await assert.rejects(ai.analyzeInquiry(inquiry), ai.AiError);
  assert.equal(attempts, 1);
});

test('missing live credentials fail without a network call', async () => {
  delete process.env.OPENAI_API_KEY;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return response(analysis);
  };
  await assert.rejects(ai.analyzeInquiry(inquiry), /Configure OPENAI_API_KEY/);
  assert.equal(requests, 0);
});

test('conversation and photo limits are enforced before provider invocation', async () => {
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return response(analysis);
  };
  await assert.rejects(ai.analyzeInquiry({ ...inquiry, content: 'x'.repeat(6001) }), ai.AiError);
  await assert.rejects(
    ai.analyzeInquiry({
      ...inquiry,
      images: Array.from({ length: 4 }, () => ({ mimeType: 'image/jpeg', dataBase64: 'aGVsbG8=' })),
    }),
    ai.AiError,
  );
  assert.equal(requests, 0);
});

test('training scenarios must preserve a valid fixed numeric quantity', async () => {
  const input = {
    business: { name: 'Test', description: 'Cleaning', industry: 'Cleaning' },
    service: { name: 'Windows', description: 'Cleaning', unitLabel: 'window' },
    index: 1,
  };
  globalThis.fetch = async () =>
    response({
      title: 'Practice request',
      customerName: 'Practice customer',
      description: 'Please clean my windows.',
      details: [{ name: 'quantity', value: '12 windows' }],
    });
  const scenario = await ai.generateScenario(input);
  assert.equal(scenario.details.quantity, '12 windows');
  globalThis.fetch = async () =>
    response({
      title: 'Practice request',
      customerName: 'Practice customer',
      description: 'Please clean my windows.',
      details: [{ name: 'quantity', value: 'unknown' }],
    });
  await assert.rejects(ai.generateScenario(input), ai.AiError);
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
        content: [{ type: 'tool_use', name: 'emit_result', input: analysis }],
        usage: { input_tokens: 30, output_tokens: 10 },
      });
    };
    const photo = Buffer.from('normalized-fixture').toString('base64');
    const result = await adapter.analyzeInquiry({
      ...inquiry,
      images: [{ mimeType: 'image/png', dataBase64: photo }],
    });
    assert.equal(result.reply, analysis.reply);
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

test('explicit demo mode is deterministic and makes no provider requests', async () => {
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
    assert.equal(await adapter.replyToCustomer(inquiry), await adapter.replyToCustomer(inquiry));
    assert.equal(calls, 0);
  } finally {
    process.env.AI_PROVIDER = 'openai';
  }
});

test('owner-reviewed inquiries retain known facts and receive the actual request stage without private pricing', async () => {
  let requestBody: any;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return response({
      ...analysis,
      reply: 'You can send the photos and description for the owner to review.',
      extractedInputs: [],
      missingInputs: ['scope', 'location', 'rooms'],
      needsReview: true,
    });
  };
  const result = await ai.analyzeInquiry({
    ...inquiry,
    service: {
      ...inquiry.service,
      mode: 'review',
      requiredInputs: ['rooms', 'scope'],
      ...{ unitPriceCents: 9876543 },
    },
    content: 'I do not know the dimensions. Can I just send a photo?',
    knownInputs: { location: 'Austin', rooms: '2 bedrooms', privateRate: '9876543' },
    experience: { privatePreview: false, requestSubmitted: false },
  });
  assert.deepEqual(result.missingInputs, ['scope']);
  const supplied = JSON.parse(requestBody.input[0].content[0].text);
  assert.deepEqual(supplied.knownInputs, { location: 'Austin', rooms: '2 bedrooms' });
  assert.deepEqual(supplied.experience, {
    quoteMode: 'review',
    privatePreview: false,
    requestSubmitted: false,
    photosAttached: false,
  });
  assert.ok(!JSON.stringify(supplied).includes('9876543'));
  assert.match(requestBody.instructions, /exact measurements are not a prerequisite/);
  assert.match(requestBody.instructions, /Email updates require a verified address/);
});

test('remote inquiries do not add a location question that the service does not require', async () => {
  let requestBody: any;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return response({ ...analysis, extractedInputs: [], missingInputs: ['scope'] });
  };
  await ai.analyzeInquiry({
    ...inquiry,
    business: { ...inquiry.business, serviceArea: 'Worldwide' },
    service: { ...inquiry.service, requiredInputs: ['scope'] },
  });
  const supplied = JSON.parse(requestBody.input[0].content[0].text);
  assert.deepEqual(supplied.service.requiredInputs, ['scope']);
});
