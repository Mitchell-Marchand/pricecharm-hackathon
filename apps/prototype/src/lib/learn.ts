import { FACT_LABELS, SCENARIOS_BY_ID } from '../data/scenarios';
import type { Insight, Job, Quote, Run, State } from './types';
import { joinList, lowerFirst, money, rate, round5 } from './util';

/** Mock pricing "brain": learns a per-sq-ft rate and add-ons from past jobs and practice quotes. */

const FALLBACK_RATE_CENTS = 45;

export function subtotal(quote: Quote): number {
  return quote.lines.reduce((sum, line) => sum + line.amountCents, 0);
}

export function discountCents(quote: Quote): number {
  if (!quote.discount) return 0;
  const base = subtotal(quote);
  return quote.discount.kind === 'amount'
    ? Math.min(quote.discount.value, base)
    : Math.round((base * quote.discount.value) / 100);
}

export function total(quote: Quote): number {
  return Math.max(0, subtotal(quote) - discountCents(quote));
}

export function sqFt(text: string): number | null {
  const match = text.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(?:sq\.?\s*ft|sqft|square\s*f(?:ee|oo)t|sf)\b/i);
  return match ? Number(match[1]) : null;
}

function jobRate(job: Job): number | null {
  if (!job.priceCents) return null;
  const area = sqFt(job.size) ?? sqFt(job.description);
  return area ? job.priceCents / area : null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function learnedRate(state: Pick<State, 'runs' | 'jobs'>, beforeRun: number) {
  const fromPractice = state.runs.slice(0, beforeRun).flatMap((run) =>
    run.outcome === 'quote' && run.quote?.lines[0]
      ? [run.quote.lines[0].amountCents / SCENARIOS_BY_ID[run.scenarioId].areaSqFt]
      : [],
  );
  if (fromPractice.length) return { cents: average(fromPractice), basis: 'practice' as const };
  const fromJobs = state.jobs.map(jobRate).filter((value): value is number => value !== null);
  if (fromJobs.length) return { cents: median(fromJobs), basis: 'jobs' as const };
  return { cents: FALLBACK_RATE_CENTS, basis: 'none' as const };
}

export function previousAddOn(state: Pick<State, 'runs'>, beforeRun: number, pattern: RegExp): number | null {
  for (const run of state.runs.slice(0, beforeRun).reverse()) {
    const line = run.quote?.lines.slice(1).find((item) => pattern.test(item.label));
    if (line) return line.amountCents;
  }
  return null;
}

function previousPercentOff(state: Pick<State, 'runs'>, beforeRun: number): number | null {
  for (const run of state.runs.slice(0, beforeRun).reverse()) {
    if (run.quote?.discount?.kind === 'percent') return run.quote.discount.value;
  }
  return null;
}

/** The AI's private guess, made before the owner's quote is revealed. */
export function shadowQuote(state: Pick<State, 'runs' | 'jobs'>, runIndex: number): { cents: number; flag: boolean } {
  const scenario = SCENARIOS_BY_ID[state.runs[runIndex].scenarioId];
  let cents = learnedRate(state, runIndex).cents * scenario.areaSqFt;
  for (const hint of scenario.addOnHints) cents += previousAddOn(state, runIndex, hint.pattern) ?? hint.typicalCents;
  const percentOff = scenario.id === 'marcus' ? previousPercentOff(state, runIndex) : null;
  if (percentOff) cents *= 1 - percentOff / 100;
  return { cents: round5(cents), flag: scenario.siteVisitLikely };
}

export function gapPercent(guessCents: number, ownerCents: number): number | null {
  return ownerCents > 0 ? Math.round((Math.abs(guessCents - ownerCents) / ownerCents) * 100) : null;
}

function askedLine(run: Run): string {
  const asked = run.asked.filter((key) => FACT_LABELS[key]).map((key) => FACT_LABELS[key].short);
  return asked.length
    ? `Asks about ${joinList([...new Set(asked)])}`
    : 'Quotes straight from the photos when a job looks clear';
}

function withReason(reason: string): string {
  return reason.trim() ? ` (${lowerFirst(reason.trim())})` : '';
}

export function quoteInsights(run: Run, quote: Quote): Insight[] {
  const scenario = SCENARIOS_BY_ID[run.scenarioId];
  const items = [askedLine(run)];
  const main = quote.lines[0];
  if (main) items.push(`Charges about ${rate(main.amountCents / scenario.areaSqFt)} per sq ft for ${scenario.kindLabel}`);
  for (const line of quote.lines.slice(1)) items.push(`Adds ${lowerFirst(line.label)} for ${money(line.amountCents)}`);
  if (quote.discount) {
    items.push(
      quote.discount.kind === 'percent'
        ? `Gives ${quote.discount.value}% off${withReason(quote.discount.reason)}`
        : `Takes ${money(quote.discount.value)} off${withReason(quote.discount.reason)}`,
    );
  }
  if (quote.start) {
    const onSite = quote.duration.trim() ? `, about ${quote.duration.trim().replace(/^about\s+/i, '')} on site` : '';
    items.push(`Can usually start ${lowerFirst(quote.start)}${onSite}`);
  }
  if (quote.note.trim()) items.push(`Remembers why: “${quote.note.trim()}”`);
  return items.map((text, index) => ({ id: `${run.scenarioId}-${index}`, text }));
}

export function siteVisitInsights(run: Run, reason: string): Insight[] {
  const scenario = SCENARIOS_BY_ID[run.scenarioId];
  const items = run.asked.length ? [askedLine(run)] : [];
  items.push(`Asks to see jobs like this first: “${reason.trim()}”`);
  items.push(
    scenario.siteVisitCue
      ? `Won't send a price for ${scenario.siteVisitCue} until you've looked`
      : 'Sends jobs like this to you instead of quoting',
  );
  return items.map((text, index) => ({ id: `${run.scenarioId}-${index}`, text }));
}

export interface PracticeResult {
  scenarioId: string;
  agree: boolean;
  gap: number | null;
  guessCents: number | null;
  ownerCents: number | null;
  siteVisit: boolean;
  aiFlagged: boolean;
}

export function practiceResults(runs: Run[]): PracticeResult[] {
  return runs
    .filter((run) => run.finished)
    .map((run) => {
      if (run.outcome === 'site-visit') {
        return {
          scenarioId: run.scenarioId,
          agree: run.shadowFlag,
          gap: null,
          guessCents: run.shadowCents,
          ownerCents: null,
          siteVisit: true,
          aiFlagged: run.shadowFlag,
        };
      }
      const ownerCents = run.quote ? total(run.quote) : 0;
      const gap = gapPercent(run.shadowCents ?? 0, ownerCents);
      return {
        scenarioId: run.scenarioId,
        agree: gap !== null && gap <= 15,
        gap,
        guessCents: run.shadowCents,
        ownerCents,
        siteVisit: false,
        aiFlagged: run.shadowFlag,
      };
    });
}

/** Recommended default from the plan: auto-send when the last two guesses agreed with the owner. */
export function autoSendReady(runs: Run[]): boolean {
  const lastTwo = practiceResults(runs).slice(-2);
  return lastTwo.length === 2 && lastTwo.every((result) => result.agree);
}
