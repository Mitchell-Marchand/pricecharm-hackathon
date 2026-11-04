import { createHash, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { mutate, rows, transaction, type Sql } from './db.js';
import { ApiError, ok } from './http.js';
import { json } from './models.js';
import { recordRequestEvent } from './metrics.js';
import { editInsight, forgetInsight } from './practice/engine.js';
import type { Insight, PracticeScenario } from './practice/types.js';
import { minimumFor } from './pricing/formula.js';
import { currentFormula, refreshFormula } from './pricing/formula-draft.js';
import { loadPricingData } from './pricing/history.js';
import { fitRates, rateWords, type PricePoint } from './pricing/rates.js';
import { changeWords, currentPriceChange } from './price-change.js';
import { requireWorkspace, workspace } from './workspace.js';

/**
 * What the Charm knows, where the owner can change it: the questions it asks customers, its rate
 * for each service, and notes about their prices that every draft follows. Questions and notes
 * the owner writes are charm_notes rows. The rest comes from practice.
 */

export const PHOTO_QUESTION = 'Can you send a few photos?';
/** Questions learned from practice, after the photo request. The owner's own come on top. */
const LEARNED_QUESTIONS = 5;
const MAX_OWN = { question: 8, price: 30 } as const;

export type CharmQuestion = {
  id: string;
  text: string;
  /** The chat asks for photos whatever this list says, so that one can't be changed. */
  source: 'photos' | 'owner' | 'practice';
};
export type PriceNote = { id: string; text: string; source: 'owner' | 'practice' };

const sameText = (text: string) => text.trim().toLowerCase();
/** A learned question has no row of its own, so its id comes from its words. */
const learnedId = (text: string) =>
  `learned-${createHash('sha256').update(sameText(text)).digest('hex').slice(0, 16)}`;
/** A practice correction is one line in a run's insights. */
const practiceNoteId = (runId: string, insightId: string) => `practice.${runId}.${insightId}`;

const FILLER = new Set(
  'a an the is it its are do does did you your we our there this that of to for in on at or and how many much what which any be with need needs want done too house home job place'.split(
    ' ',
  ),
);
const SAME_WORD: Record<string, string> = { single: 'one', stories: 'story', storey: 'story' };

/** A question's words that say what it's about: "Is it single-story or two-story?" → one, story, two. */
function questionWords(question: string) {
  return new Set(
    question
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((word) => SAME_WORD[word] ?? word.replace(/(?<=..)s$/, ''))
      .filter((word) => word && !FILLER.has(word)),
  );
}

/**
 * The same question when they're about the same words, or one's are all in the other's and it
 * says enough to tell.
 */
function sameQuestion(a: Set<string>, b: Set<string>) {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  return (small.size >= 2 || small.size === big.size) && [...small].every((word) => big.has(word));
}

/** The questions the customer chat works from, in order: photos, the owner's, then practice's. */
export async function questionList(businessId: string, connection?: Sql) {
  const own = await rows(
    "SELECT id,kind,text FROM charm_notes WHERE business_id=? AND kind IN ('question','skip') ORDER BY created_at,id",
    [businessId],
    connection,
  );
  const questions: CharmQuestion[] = [{ id: 'photos', text: PHOTO_QUESTION, source: 'photos' }];
  for (const row of own)
    if (row.kind === 'question')
      questions.push({ id: String(row.id), text: String(row.text), source: 'owner' });
  const skipped = new Set(
    own.filter((row) => row.kind === 'skip').map((row) => sameText(String(row.text))),
  );
  // The first few it learned, less any the owner took out. Taking one out doesn't bring in another.
  // Practice customers each word their questions their own way, so the same question asked two
  // ways ("Is it single-story or two-story?", "Is the house one story or two?") is kept once.
  const learned: string[] = [];
  const seen: Set<string>[] = [];
  const runs = await rows(
    "SELECT scenario_json,asked_json FROM practice_runs WHERE business_id=? AND status='finished' ORDER BY position",
    [businessId],
    connection,
  );
  for (const run of runs) {
    const scenario = json<PracticeScenario>(run.scenario_json, {} as PracticeScenario);
    for (const key of json<string[]>(run.asked_json, [])) {
      const question = scenario.facts?.find((fact) => fact.key === key)?.question;
      if (!question) continue;
      const words = questionWords(question);
      if (seen.some((other) => sameQuestion(other, words))) continue;
      seen.push(words);
      learned.push(question);
    }
  }
  const asked = new Set(questions.map((item) => sameText(item.text)));
  for (const question of learned.slice(0, LEARNED_QUESTIONS))
    if (!skipped.has(sameText(question)) && !asked.has(sameText(question)))
      questions.push({ id: learnedId(question), text: question, source: 'practice' });
  return questions;
}

/** The questions the customer chat asks, from the owner and their practice customers. */
export async function questionChecklist(businessId: string): Promise<string[]> {
  return (await questionList(businessId)).map((item) => item.text);
}

/** Notes the drafts follow: the owner's own, then lines they corrected after practice. */
export async function priceNotes(businessId: string): Promise<PriceNote[]> {
  const own = await rows(
    "SELECT id,text FROM charm_notes WHERE business_id=? AND kind='price' ORDER BY created_at,id",
    [businessId],
  );
  const runs = await rows(
    "SELECT id,insights_json FROM practice_runs WHERE business_id=? AND status='finished' ORDER BY position",
    [businessId],
  );
  return [
    ...own.map((row) => ({ id: String(row.id), text: String(row.text), source: 'owner' as const })),
    ...runs.flatMap((run) =>
      json<(Insight & { edited?: boolean })[]>(run.insights_json, [])
        .filter((insight) => insight.edited)
        .map((insight) => ({
          id: practiceNoteId(String(run.id), insight.id),
          text: insight.text,
          source: 'practice' as const,
        })),
    ),
  ];
}

const SOURCES: [PricePoint['source'], string, string][] = [
  ['job', 'past job', 'past jobs'],
  ['practice', 'practice quote', 'practice quotes'],
  ['quote', 'real quote', 'real quotes'],
];
const joinList = (items: string[]) =>
  items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

/**
 * Each service's rate, the one its drafts are held to, and what it comes from: "About $25 per
 * window, lowest $100" from "1 past job and 3 practice quotes, 10 to 24 windows". Empty for a
 * service with no prices that have a size.
 */
async function serviceRates(businessId: string) {
  const data = await loadPricingData(businessId);
  const rates = fitRates(data.points);
  // Once their formula prices their quotes, small jobs go as low as its minimum, not as low as
  // the cheapest job they happen to have done.
  const learned = await currentFormula(businessId, data).catch(() => null);
  // Quotes price at the middle of the formula's readings, so its minimum is theirs too.
  const formulas = (learned ? [learned, ...(learned.also ?? [])] : [])
    .filter((reading) => reading.fits)
    .map((reading) => reading.formula);
  return data.history.business.services.map((service) => {
    const rate = rates
      .filter((item) => sameText(item.service) === sameText(service))
      .sort((a, b) => b.points - a.points)[0];
    if (!rate) return { service, price: '', basis: '' };
    const points = data.points.filter(
      (point) =>
        sameText(point.service) === sameText(service) &&
        point.unit === rate.unit &&
        point.quantity > 0 &&
        point.cents > 0,
    );
    const from = SOURCES.flatMap(([source, one, many]) => {
      const count = points.filter((point) => point.source === source).length;
      return count ? [`${count} ${count === 1 ? one : many}`] : [];
    });
    const minimums = formulas.flatMap((formula) => {
      const rule = formula.services.find((item) => sameText(item.name) === sameText(service));
      return rule ? [minimumFor(formula, rule) ?? 0] : [];
    });
    const minimum = minimums.sort((a, b) => a - b)[Math.floor(minimums.length / 2)];
    const { currency } = data.history.business;
    const { price, sizes } = minimums.length
      ? rateWords(rate, minimum || null, currency)
      : rateWords(rate, undefined, currency);
    return {
      service,
      price: price.charAt(0).toUpperCase() + price.slice(1),
      basis: `From ${joinList(from)}, ${sizes}`,
    };
  });
}

export async function charmKnows(businessId: string) {
  return {
    questions: await questionList(businessId),
    rates: await serviceRates(businessId),
    notes: await priceNotes(businessId),
    priceChange: await currentPriceChange(businessId).then(
      (change) => change && { ...change, words: changeWords(change) },
    ),
  };
}

const textInput = (max: number) =>
  z
    .object({
      text: z
        .string()
        .max(2000)
        .transform((value) => value.replace(/\s+/g, ' ').trim())
        .pipe(
          z
            .string()
            .min(1, 'Write something first.')
            .max(max, `Keep it to ${max} characters or fewer.`),
        ),
    })
    .strict();
const questionInput = textInput(160);
const noteInput = textInput(200);
const ownId = z.uuid();

/** Adds the owner's question or note, under the limit. Locks the business so two can't both fit. */
async function addOwn(
  connection: Sql,
  businessId: string,
  kind: 'question' | 'price',
  text: string,
) {
  await rows('SELECT id FROM businesses WHERE id=? FOR UPDATE', [businessId], connection);
  const [count] = await rows(
    'SELECT COUNT(*) AS count FROM charm_notes WHERE business_id=? AND kind=?',
    [businessId, kind],
    connection,
  );
  if (Number(count.count) >= MAX_OWN[kind])
    throw new ApiError(
      422,
      'NOTE_LIMIT',
      kind === 'question'
        ? `You can add up to ${MAX_OWN.question} questions.`
        : `You can add up to ${MAX_OWN.price} notes.`,
    );
  await mutate(
    'INSERT INTO charm_notes (id,business_id,kind,text) VALUES (?,?,?,?)',
    [randomUUID(), businessId, kind, text],
    connection,
  );
}

/** A question the chat already asks, other than the one being changed. */
async function alreadyAsked(connection: Sql, businessId: string, text: string, except?: string) {
  const questions = await questionList(businessId, connection);
  if (questions.some((item) => item.id !== except && sameText(item.text) === sameText(text)))
    throw new ApiError(422, 'QUESTION_EXISTS', 'It already asks that.');
}

/** The question by its id, or a 404. The photo request can't be changed. */
async function findQuestion(connection: Sql, businessId: string, id: string) {
  const question = (await questionList(businessId, connection)).find((item) => item.id === id);
  if (!question) throw new ApiError(404, 'QUESTION_NOT_FOUND', 'That question isn’t here anymore.');
  if (question.source === 'photos')
    throw new ApiError(
      422,
      'QUESTION_FIXED',
      'It always asks for photos first. Customers can skip them.',
    );
  return question;
}

/** Stops asking a question it learned from practice, even when practice turns it up again. */
const skip = (connection: Sql, businessId: string, text: string) =>
  mutate(
    "INSERT INTO charm_notes (id,business_id,kind,text) VALUES (?,?,'skip',?)",
    [randomUUID(), businessId, text],
    connection,
  );

/** "practice.<run>.<line>" for a practice correction, or null for the owner's own note. */
function practiceNote(id: string) {
  const match = /^practice\.([0-9a-f-]{36})\.([\w-]{1,40})$/.exec(id);
  return match ? { runId: match[1], insightId: match[2] } : null;
}

export const charmNotesRouter = Router();

charmNotesRouter.get('/onboarding/knows', requireWorkspace, async (req, res) => {
  res.json(ok(await charmKnows(workspace(req).businessId)));
});

charmNotesRouter.post('/onboarding/knows/questions', requireWorkspace, async (req, res) => {
  const { text } = questionInput.parse(req.body);
  const { businessId } = workspace(req);
  await transaction(async (connection) => {
    await alreadyAsked(connection, businessId, text);
    await addOwn(connection, businessId, 'question', text);
  });
  await recordRequestEvent(req, businessId, 'charm_question_changed', { action: 'add' });
  res.status(201).json(ok(await charmKnows(businessId)));
});

charmNotesRouter.put('/onboarding/knows/questions/:id', requireWorkspace, async (req, res) => {
  const { text } = questionInput.parse(req.body);
  const { businessId } = workspace(req);
  const id = z.string().max(80).parse(req.params.id);
  const source = await transaction(async (connection) => {
    const question = await findQuestion(connection, businessId, id);
    if (question.text === text) return question.source;
    await alreadyAsked(connection, businessId, text, id);
    if (question.source === 'owner')
      await mutate(
        "UPDATE charm_notes SET text=? WHERE id=? AND business_id=? AND kind='question'",
        [text, id, businessId],
        connection,
      );
    else {
      // Rewording one it learned: the owner's words take its place.
      await skip(connection, businessId, question.text);
      await addOwn(connection, businessId, 'question', text);
    }
    return question.source;
  });
  await recordRequestEvent(req, businessId, 'charm_question_changed', { action: 'edit', source });
  res.json(ok(await charmKnows(businessId)));
});

charmNotesRouter.delete('/onboarding/knows/questions/:id', requireWorkspace, async (req, res) => {
  const { businessId } = workspace(req);
  const id = z.string().max(80).parse(req.params.id);
  const source = await transaction(async (connection) => {
    const question = await findQuestion(connection, businessId, id);
    if (question.source === 'owner')
      await mutate(
        "DELETE FROM charm_notes WHERE id=? AND business_id=? AND kind='question'",
        [id, businessId],
        connection,
      );
    else await skip(connection, businessId, question.text);
    return question.source;
  });
  await recordRequestEvent(req, businessId, 'charm_question_changed', { action: 'remove', source });
  res.json(ok(await charmKnows(businessId)));
});

charmNotesRouter.post('/onboarding/knows/notes', requireWorkspace, async (req, res) => {
  const { text } = noteInput.parse(req.body);
  const { businessId } = workspace(req);
  await transaction((connection) => addOwn(connection, businessId, 'price', text));
  refreshFormula(businessId);
  await recordRequestEvent(req, businessId, 'charm_note_changed', { action: 'add' });
  res.status(201).json(ok(await charmKnows(businessId)));
});

charmNotesRouter.put('/onboarding/knows/notes/:id', requireWorkspace, async (req, res) => {
  const { text } = noteInput.parse(req.body);
  const { businessId } = workspace(req);
  const id = z.string().max(120).parse(req.params.id);
  const practice = practiceNote(id);
  if (practice) await editInsight(businessId, practice.runId, practice.insightId, text);
  else {
    const updated = await mutate(
      "UPDATE charm_notes SET text=? WHERE id=? AND business_id=? AND kind='price'",
      [text, ownId.parse(id), businessId],
    );
    if (!updated.affectedRows)
      throw new ApiError(404, 'NOTE_NOT_FOUND', 'That note isn’t here anymore.');
  }
  refreshFormula(businessId);
  await recordRequestEvent(req, businessId, 'charm_note_changed', {
    action: 'edit',
    source: practice ? 'practice' : 'owner',
  });
  res.json(ok(await charmKnows(businessId)));
});

charmNotesRouter.delete('/onboarding/knows/notes/:id', requireWorkspace, async (req, res) => {
  const { businessId } = workspace(req);
  const id = z.string().max(120).parse(req.params.id);
  const practice = practiceNote(id);
  if (practice) await forgetInsight(businessId, practice.runId, practice.insightId);
  else {
    const deleted = await mutate(
      "DELETE FROM charm_notes WHERE id=? AND business_id=? AND kind='price'",
      [ownId.parse(id), businessId],
    );
    if (!deleted.affectedRows)
      throw new ApiError(404, 'NOTE_NOT_FOUND', 'That note isn’t here anymore.');
  }
  refreshFormula(businessId);
  await recordRequestEvent(req, businessId, 'charm_note_changed', {
    action: 'remove',
    source: practice ? 'practice' : 'owner',
  });
  res.json(ok(await charmKnows(businessId)));
});
