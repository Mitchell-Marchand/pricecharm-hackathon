import { z } from 'zod';
import { requestJson } from '../ai/index.js';
import { formatQuantity } from '../pricing/units.js';
import { jobSpec, ONE_TIME, type SimJob, type SimOwner } from './owners.js';

/**
 * A customer in a real chat, for the benchmark's --chat runs: they say what they want and a
 * detail or two, then answer only what they're asked. The app's own customer chat asks them
 * (src/ai/intake.ts), and the job is priced from that conversation, as a live quote is.
 */

export type CustomerFact = {
  key: string;
  text: string;
  /** Whether the owner's price depends on it, so a chat that never learns it can't price right. */
  needed: boolean;
};

/** Everything the customer knows about their job, in their words, one fact at a time. */
export function jobFacts(owner: SimOwner, job: SimJob): CustomerFact[] {
  const spec = jobSpec(owner, job);
  const rule = owner.rules.services.find((item) => item.name === job.service)!;
  const facts: CustomerFact[] = [
    { key: 'service', text: `What they want: ${job.service}`, needed: true },
    { key: 'size', text: `Size: ${formatQuantity(spec.quantity, spec.unit)}`, needed: true },
  ];
  if (rule.extra && job.extra !== undefined)
    facts.push({ key: 'count', text: `${rule.extra.unit}: ${job.extra}`, needed: true });
  facts.push({
    key: 'condition',
    text: `Condition: ${spec.condition || 'normal, nothing unusual'}`,
    needed: job.heavy,
  });
  if (spec.access || rule.height)
    facts.push({
      key: 'access',
      text: `Access: ${spec.access || 'nothing unusual, easy to get to'}`,
      needed: job.twoStory,
    });
  if (job.option) facts.push({ key: 'option', text: `Which kind: ${job.option}`, needed: true });
  if (job.second)
    facts.push({
      key: 'second',
      text: `Also wants: ${job.second.service}, ${formatQuantity(job.second.quantity, owner.rules.services.find((item) => item.name === job.second!.service)!.unit)}`,
      needed: true,
    });
  for (const [index, addOn] of job.addOns.entries())
    facts.push({
      key: `extra${index + 1}`,
      text: `Also wants: ${addOn.label}${addOn.count ? ` (${addOn.count})` : ''}`,
      needed: true,
    });
  if (owner.rules.recurring)
    facts.push({
      key: 'schedule',
      text: `How often: ${job.frequency && job.frequency !== ONE_TIME ? job.frequency : 'just once'}`,
      needed: Boolean(job.frequency && job.frequency !== ONE_TIME),
    });
  return facts;
}

const turnJson = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    told: { type: 'array', items: { type: 'string' } },
  },
  required: ['reply', 'told'],
  additionalProperties: false,
};
const turnSchema = z
  .object({
    reply: z.string().trim().min(1).max(600),
    told: z.array(z.string().max(20)).max(20),
  })
  .strict();

/** What the customer says next: their first message, or their answer to the business's question. */
export function customerTurn(input: {
  trade: string;
  facts: CustomerFact[];
  /** Everything about the job in one message, for how they'd word it. */
  wording: string;
  conversation: { from: 'customer' | 'assistant'; text: string }[];
  model?: string;
}) {
  return requestJson(
    'bench_customer',
    `You play a customer asking a ${input.trade} business for a quote, in a test of the business's chat. The facts are everything you know about your job; "wording" says how you'd put all of it.
- With no conversation yet, write your first message: what you want done and at most one or two of the other facts, the way people text when they leave things out. Some people give the size, some don't.
- Otherwise answer only what the business's last message asks, in one or two short, casual sentences, using the facts exactly as given. Don't bring up facts they didn't ask about. If they ask whether there's anything else, name the extras and second service you want.
- If they ask for photos or a video, say you can't send any right now.
- If they ask something your facts don't cover, like your address or when you'd like it done, give a short, plausible answer that adds no work, like "Sometime in the next couple of weeks."
- Never ask for the price or make up facts that would change the job.
- told: the keys of every fact your message gives, from the facts' keys.`,
    {
      facts: input.facts.map(({ key, text }) => ({ key, text })),
      wording: input.wording,
      conversation: input.conversation,
    },
    turnJson,
    turnSchema,
    [],
    [],
    { model: input.model },
  );
}

/**
 * The facts of a practice customer and what the owner asked them, for a --chat run: an owner who
 * asks their practice customers the usual things, so the customer chat's checklist
 * (questionList in src/charm-notes.ts) is what it would be in the app.
 */
export function practiceFacts(owner: SimOwner, job: SimJob) {
  const spec = jobSpec(owner, job);
  const rule = owner.rules.services.find((item) => item.name === job.service)!;
  const questions: Record<string, string> = {
    size: `About how many ${spec.unit} is it?`,
    count: `How many ${rule.extra?.unit ?? ''}?`,
    condition: 'What shape is it in right now?',
    access: 'Is it easy to get to, or up high or hard to reach?',
    option: 'Which kind do you want?',
    schedule: 'Is this a one-time job, or would you like it on a regular schedule?',
  };
  const facts = jobFacts(owner, job)
    .filter((fact) => questions[fact.key])
    .map((fact) => ({
      key: fact.key,
      label: fact.key,
      question: questions[fact.key],
      answer: fact.text,
    }));
  facts.push({
    key: 'more',
    label: 'anything else',
    question: 'Anything else you’d like done while we’re there?',
    answer: job.addOns.length || job.second ? 'Yes, a few extras.' : 'No, that’s it.',
  });
  return facts;
}
