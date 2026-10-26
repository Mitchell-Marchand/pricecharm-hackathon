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
  assert.deepEqual(events, [
    {
      provider: 'openai',
      model: 'mock-model',
      inputTokens: 42,
      outputTokens: 12,
      operation: 'intake_turn',
      requestId: 'mock-request-id',
    },
  ]);
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
