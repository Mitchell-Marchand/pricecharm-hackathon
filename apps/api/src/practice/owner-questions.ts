import { randomUUID } from 'node:crypto';
import { mutate, rows, type Sql } from '../db.js';
import { ApiError } from '../http.js';
import { json } from '../models.js';
import { currencyOf, wholeMoney } from '../money.js';
import { GENERAL_DRIVERS, TRADE_DRIVERS, type TradeDriver } from './trade-drivers.js';
import { quoteTotal, type Quote } from './types.js';

/**
 * After each practice quote, the Charm asks the owner one thing about how they price, the kind of
 * thing a few quotes are slowest to show: does a tree's height change the price, is a recoat
 * cheaper than a refinish, what's the least they'd charge. The answer is saved as one of their
 * price notes, which the formula follows over their quotes, and when it says the thing matters,
 * the live chat asks customers about it. On the benchmark, three practice quotes left 124 of 151
 * new jobs needing something none of them had shown.
 */

export type OwnerQuestion = TradeDriver & {
  /** What the owner said, word for word, once they have. */
  answer?: string;
  skipped?: boolean;
  /** The price note the answer was saved as. */
  noteId?: string;
};

/** As MAX_OWN in src/charm-notes.ts: the notes and questions an owner can have in all. */
const MAX_NOTES = 30;
const MAX_QUESTIONS = 8;

const sameText = (text: string) => text.trim().toLowerCase();
const words = (text: string) =>
  new Set(
    sameText(text)
      .split(/[^a-z]+/)
      .filter(Boolean),
  );

/** Whether the owner does what a driver is about, when it's only about some of the trade's work. */
function fits(driver: TradeDriver, services: string[]) {
  if (!driver.services?.length) return true;
  return driver.services.some((name) =>
    services.some((service) => {
      const [a, b] = [sameText(name), sameText(service)];
      if (a.includes(b) || b.includes(a)) return true;
      const theirs = words(service);
      return [...words(name)].some((word) => word.length >= 5 && theirs.has(word));
    }),
  );
}

/** A round amount near this one, for a tap answer: $125, $250, $1,200. */
function roundAmount(cents: number) {
  const step = cents < 20_000 ? 2_500 : cents < 100_000 ? 5_000 : 10_000;
  return Math.max(step, Math.round(cents / step) * step);
}

/** The least they'd charge, offered at a few amounts under the cheapest job they've priced. */
function minimumQuestion(cheapest: number, currency: string): TradeDriver {
  const amounts = [...new Set([0.4, 0.65, 0.9].map((share) => roundAmount(cheapest * share)))];
  return {
    key: 'minimum',
    label: 'Minimum charge',
    ask: 'What’s the least you’d charge for any job?',
    answers: amounts.map((cents) => wholeMoney(cents, currencyOf(currency))),
    no: 'No minimum',
  };
}

const TOGETHER: TradeDriver = {
  key: 'together',
  label: 'Two services together',
  ask: 'When someone books two of your services at once, do they pay less?',
  answers: ['Yes, about 10% off', 'Yes, about 15% off'],
  no: 'No, same prices',
};

/**
 * The questions for this business, in the order they're asked: what most moves a price in their
 * trade comes first, their minimum second, and two services together once the trade's first few
 * are in.
 */
function questionsFor(
  tradeId: string | null,
  services: string[],
  cheapest: number | null,
  currency: string,
) {
  const trade = ((tradeId && TRADE_DRIVERS[tradeId]) || GENERAL_DRIVERS).filter((driver) =>
    fits(driver, services),
  );
  const minimum = cheapest ? [minimumQuestion(cheapest, currency)] : [];
  const together = services.length > 1 ? [TOGETHER] : [];
  return [...trade.slice(0, 1), ...minimum, ...trade.slice(1, 3), ...together, ...trade.slice(3)];
}

/**
 * Picks the next question for the owner and keeps it on this practice customer, or null when
 * there's nothing left to ask. Never one they were asked before, or one their own notes already
 * answer.
 */
export async function pickQuestion(
  connection: Sql,
  businessId: string,
  runId: string,
): Promise<OwnerQuestion | null> {
  const [business] = await rows(
    'SELECT trade_id,currency FROM businesses WHERE id=?',
    [businessId],
    connection,
  );
  const services = (
    await rows(
      'SELECT name FROM offerings WHERE business_id=? ORDER BY position',
      [businessId],
      connection,
    )
  ).map((row) => String(row.name));
  const runs = await rows(
    'SELECT outcome,quote_json,owner_question_json FROM practice_runs WHERE business_id=?',
    [businessId],
    connection,
  );
  const asked = new Set(
    runs.flatMap((run) => {
      const question = json<OwnerQuestion | null>(run.owner_question_json, null);
      return question ? [question.key] : [];
    }),
  );
  const notes = (
    await rows(
      "SELECT text FROM charm_notes WHERE business_id=? AND kind='price'",
      [businessId],
      connection,
    )
  ).map((row) => sameText(String(row.text)));
  const past = await rows(
    'SELECT price_cents FROM past_jobs WHERE business_id=?',
    [businessId],
    connection,
  );
  const totals = [
    ...runs.flatMap((run) => {
      const quote = run.outcome === 'quote' ? json<Quote | null>(run.quote_json, null) : null;
      return quote ? [quoteTotal(quote)] : [];
    }),
    ...past.map((job) => Number(job.price_cents)),
  ].filter((cents) => cents > 0);
  const question = questionsFor(
    business?.trade_id ? String(business.trade_id) : null,
    services,
    totals.length ? Math.min(...totals) : null,
    String(business?.currency ?? ''),
  ).find(
    (driver) =>
      !asked.has(driver.key) && !notes.some((note) => note.startsWith(sameText(driver.ask))),
  );
  if (!question) return null;
  await mutate(
    'UPDATE practice_runs SET owner_question_json=? WHERE id=? AND business_id=?',
    [JSON.stringify(question), runId, businessId],
    connection,
  );
  return question;
}

/**
 * The note an answer is saved as, with the question it answers: "Does a tree’s height change your
 * price? Yes, about 50% more over 30 ft." Without the question a no says too much: "Plated or
 * buffet: No, same price" was read as nothing about how the food is served changing the price,
 * and the benchmark's owners lost their charge for a staffed buffet.
 */
export function answerNote(question: TradeDriver, answer: string) {
  const said = answer.trim().replace(/\s+/g, ' ');
  const sentence = said.charAt(0).toUpperCase() + said.slice(1);
  return `${question.ask} ${sentence}${/[.!?]$/.test(sentence) ? '' : '.'}`.slice(0, 200);
}

/**
 * Saves the owner's answer to this practice customer's question as one of their price notes, and,
 * when it says the thing changes their price, adds the driver's question to the ones the live
 * chat asks customers. Skipping keeps nothing. The caller holds the practice run locked.
 */
export async function answerQuestion(
  connection: Sql,
  businessId: string,
  runId: string,
  reply: { answer: string } | { skip: true },
  /** When it was answered, for the benchmark, which saves its owners' answers after the fact. */
  at = new Date(),
): Promise<OwnerQuestion> {
  const [run] = await rows(
    'SELECT owner_question_json FROM practice_runs WHERE id=? AND business_id=?',
    [runId, businessId],
    connection,
  );
  const question = json<OwnerQuestion | null>(run?.owner_question_json, null);
  if (!question) throw new ApiError(404, 'QUESTION_NOT_FOUND', 'There’s no question here.');
  if (question.answer || question.skipped)
    throw new ApiError(409, 'QUESTION_ANSWERED', 'You’ve answered this one already.');
  let answered: OwnerQuestion;
  if ('skip' in reply) answered = { ...question, skipped: true };
  else {
    const [count] = await rows(
      "SELECT COUNT(*) AS count FROM charm_notes WHERE business_id=? AND kind='price'",
      [businessId],
      connection,
    );
    if (Number(count.count) >= MAX_NOTES)
      throw new ApiError(422, 'NOTE_LIMIT', `You can have up to ${MAX_NOTES} notes.`);
    const noteId = randomUUID();
    await mutate(
      "INSERT INTO charm_notes (id,business_id,kind,text,created_at) VALUES (?,?,'price',?,?)",
      [noteId, businessId, answerNote(question, reply.answer), at],
      connection,
    );
    if (question.customer && sameText(reply.answer) !== sameText(question.no)) {
      const own = await rows(
        "SELECT text FROM charm_notes WHERE business_id=? AND kind='question'",
        [businessId],
        connection,
      );
      if (
        own.length < MAX_QUESTIONS &&
        !own.some((row) => sameText(String(row.text)) === sameText(question.customer!))
      )
        await mutate(
          "INSERT INTO charm_notes (id,business_id,kind,text,created_at) VALUES (?,?,'question',?,?)",
          [randomUUID(), businessId, question.customer, at],
          connection,
        );
    }
    answered = { ...question, answer: reply.answer.trim(), noteId };
  }
  await mutate(
    'UPDATE practice_runs SET owner_question_json=? WHERE id=? AND business_id=?',
    [JSON.stringify(answered), runId, businessId],
    connection,
  );
  return answered;
}
