import 'dotenv/config';
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';

export type AiProvider = 'openai' | 'anthropic' | 'demo';
export type AiUsage = {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  operation: string;
  requestId?: string;
};
type UsageContext = {
  conversationId?: string;
  record: (usage: AiUsage) => Promise<void>;
  businessId: string;
};
export type AiRequestOptions = { maxAttempts?: 1 | 2 };
export type AiImage = { mimeType: string; dataBase64: string };
export type AiDocument = { filename: string; mimeType: 'application/pdf'; dataBase64: string };
const providerValue = process.env.AI_PROVIDER ?? 'openai';
if (!['openai', 'anthropic', 'demo'].includes(providerValue)) {
  throw new Error('AI_PROVIDER must be openai, anthropic, or demo.');
}
export const aiProvider = providerValue as AiProvider;
export const aiMode: 'live' | 'demo' = aiProvider === 'demo' ? 'demo' : 'live';
const usageContexts = new AsyncLocalStorage<UsageContext>();

export function runWithAiUsage<T>(context: UsageContext, task: () => Promise<T>): Promise<T> {
  return usageContexts.run(context, task);
}
export async function recordProviderUsage(usage: AiUsage): Promise<void> {
  await usageContexts.getStore()?.record(usage);
}

export class AiError extends Error {
  readonly status = 503;
  readonly statusCode = 503;
  readonly code = 'AI_UNAVAILABLE';
  constructor(message = 'The AI service is unavailable. Please try again shortly.') {
    super(message);
    this.name = 'AiError';
  }
}

function boundedEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? Math.floor(parsed) : fallback;
}

type JsonSchema = Record<string, unknown>;
export const practicePhotoSceneSchema = z
  .object({
    subject: z.string().trim().min(1).max(100).optional(),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(1200),
  })
  .strict();
export type PracticePhotoScene = z.infer<typeof practicePhotoSceneSchema>;
export async function requestJson<T>(
  operation: string,
  instructions: string,
  input: unknown,
  schema: JsonSchema,
  validator: z.ZodType<T>,
  images: AiImage[] = [],
  documents: AiDocument[] = [],
  options: AiRequestOptions = {},
): Promise<T> {
  if (aiProvider === 'demo')
    throw new AiError('A live model was requested while demo mode is enabled.');
  const key = aiProvider === 'openai' ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY;
  const model =
    aiProvider === 'openai'
      ? (process.env.OPENAI_MODEL ?? 'gpt-4.1-mini')
      : process.env.ANTHROPIC_MODEL;
  if (!key || !model) {
    throw new AiError(
      `Configure ${aiProvider === 'openai' ? 'OPENAI_API_KEY and OPENAI_MODEL' : 'ANTHROPIC_API_KEY and ANTHROPIC_MODEL'} to use the selected AI provider.`,
    );
  }
  const maxOutput = boundedEnv('AI_MAX_OUTPUT_TOKENS', 1800, 256, 8000);
  const maxAttempts = options.maxAttempts === 1 ? 1 : 2;
  if (
    documents.length > 1 ||
    documents.some(
      (document) =>
        document.mimeType !== 'application/pdf' ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(document.dataBase64) ||
        Buffer.byteLength(document.dataBase64, 'base64') > 4 * 1024 * 1024,
    )
  )
    throw new AiError('Upload one PDF smaller than 4 MB.');
  if (
    images.length > 3 ||
    images.some(
      (image) =>
        !['image/jpeg', 'image/png', 'image/webp'].includes(image.mimeType) ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(image.dataBase64) ||
        Buffer.byteLength(image.dataBase64, 'base64') > 1024 * 1024,
    )
  ) {
    throw new AiError('Attach at most three supported photos, each no larger than 1 MB.');
  }
  const timeout = boundedEnv('AI_TIMEOUT_MS', 25000, 1000, 60000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    // No endpoint override: API credentials are sent only to the selected provider's official endpoint.
    const url =
      aiProvider === 'openai'
        ? 'https://api.openai.com/v1/responses'
        : 'https://api.anthropic.com/v1/messages';
    const body =
      aiProvider === 'openai'
        ? {
            model,
            store: false,
            instructions,
            input: [
              {
                role: 'user',
                content: [
                  { type: 'input_text', text: JSON.stringify(input) },
                  ...documents.map((document) => ({
                    type: 'input_file',
                    filename: document.filename,
                    file_data: `data:application/pdf;base64,${document.dataBase64}`,
                  })),
                  ...images.map((image) => ({
                    type: 'input_image',
                    image_url: `data:${image.mimeType};base64,${image.dataBase64}`,
                    detail: 'low',
                  })),
                ],
              },
            ],
            max_output_tokens: maxOutput,
            text: {
              format: { type: 'json_schema', name: 'quotient_response', strict: true, schema },
            },
          }
        : {
            model,
            max_tokens: maxOutput,
            system: `${instructions}\nUse the emit_result tool to return your response.`,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: JSON.stringify(input) },
                  ...documents.map((document) => ({
                    type: 'document',
                    source: {
                      type: 'base64',
                      media_type: 'application/pdf',
                      data: document.dataBase64,
                    },
                  })),
                  ...images.map((image) => ({
                    type: 'image',
                    source: { type: 'base64', media_type: image.mimeType, data: image.dataBase64 },
                  })),
                ],
              },
            ],
            tools: [
              {
                name: 'emit_result',
                description: 'Return the validated result.',
                input_schema: schema,
              },
            ],
            tool_choice: { type: 'tool', name: 'emit_result' },
          };
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (aiProvider === 'openai') headers.Authorization = `Bearer ${key}`;
    else {
      headers['x-api-key'] = key;
      headers['anthropic-version'] = '2023-06-01';
    }
    let response: Response | undefined;
    // Only retry explicit transient HTTP failures once; never retry timeouts or ambiguous transport failures.
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (
        response.ok ||
        ![429, 502, 503, 504].includes(response.status) ||
        attempt + 1 >= maxAttempts
      )
        break;
      await response.body?.cancel();
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(delay);
          reject(new AiError());
        };
        const delay = setTimeout(() => {
          controller.signal.removeEventListener('abort', onAbort);
          resolve();
        }, 350);
        controller.signal.addEventListener('abort', onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
    }
    if (!response?.ok) {
      // Provider error bodies can include submitted material; do not log or expose them.
      await response?.body?.cancel();
      throw new AiError(
        response?.status === 401 || response?.status === 403
          ? 'The AI provider credentials need attention. Please contact the business owner.'
          : undefined,
      );
    }
    const raw: unknown = await response.json();
    const payload = z
      .object({ usage: z.record(z.string(), z.unknown()).optional() })
      .passthrough()
      .parse(raw);
    const tokenUsage = payload.usage ?? {};
    const context = usageContexts.getStore();
    if (context) {
      await context.record({
        provider: aiProvider,
        model,
        operation,
        inputTokens: Number(tokenUsage.input_tokens ?? 0),
        outputTokens: Number(tokenUsage.output_tokens ?? 0),
        requestId:
          response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? undefined,
      });
    }
    let result: unknown;
    if (aiProvider === 'openai') {
      const parsed = z
        .object({
          status: z.string(),
          output: z.array(
            z
              .object({
                content: z
                  .array(z.object({ type: z.string(), text: z.string().optional() }).passthrough())
                  .optional(),
              })
              .passthrough(),
          ),
        })
        .passthrough()
        .parse(raw);
      if (parsed.status !== 'completed')
        throw new AiError('The AI response was incomplete. Please try again.');
      const text = parsed.output
        .flatMap((item) => item.content ?? [])
        .filter((item) => item.type === 'output_text')
        .map((item) => item.text ?? '')
        .join('');
      if (!text)
        throw new AiError(
          'The AI could not answer this request. Please ask the business owner for help.',
        );
      result = JSON.parse(text);
    } else {
      const parsed = z
        .object({
          stop_reason: z.string(),
          content: z.array(
            z
              .object({
                type: z.string(),
                name: z.string().optional(),
                input: z.unknown().optional(),
              })
              .passthrough(),
          ),
        })
        .passthrough()
        .parse(raw);
      if (parsed.stop_reason === 'max_tokens')
        throw new AiError('The AI response was incomplete. Please try again.');
      result = parsed.content.find(
        (item) => item.type === 'tool_use' && item.name === 'emit_result',
      )?.input;
    }
    const validated = validator.safeParse(result);
    if (!validated.success) {
      const fields = new Set([
        'unitLabel',
        'unitPriceCents',
        'basePriceCents',
        'minimumChargeCents',
        'requiredInputs',
        'exclusions',
        'pricingRules',
        'explanation',
        'uncertainties',
        'reply',
        'photoRequest',
        'scenes',
        'subject',
        'title',
        'description',
        'id',
        'name',
        'field',
        'operator',
        'value',
        'kind',
        'amount',
        'projects',
        'quantity',
        'finalPriceCents',
        'rationale',
        'currency',
        'inputs',
        'issues',
        'notes',
        'draft',
        'example',
        'evidence',
        'extractedInputs',
        'missingInputs',
        'needsReview',
        'reviewReason',
      ]);
      console.error(
        JSON.stringify({
          event: 'ai_response_invalid',
          operation,
          provider: aiProvider,
          model,
          issues: validated.error.issues.slice(0, 10).map((issue) => ({
            code: issue.code,
            path: issue.path.map((part) =>
              typeof part === 'number' ? part : fields.has(String(part)) ? part : 'field',
            ),
          })),
        }),
      );
      throw new AiError('The AI returned an invalid response. Please try again.');
    }
    return validated.data;
  } catch (error) {
    if (error instanceof AiError) throw error;
    throw new AiError();
  } finally {
    clearTimeout(timer);
  }
}
