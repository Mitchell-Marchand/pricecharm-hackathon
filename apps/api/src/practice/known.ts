import { emptySpec, SIZE_FACT, specFromScenario, type JobSpec } from '../pricing/spec.js';
import { parseQuantity } from '../pricing/units.js';
import type { Fact, PracticeScenario } from './types.js';

/**
 * A practice job as the owner knew it when they priced it: what the customer said, what the owner
 * asked and was told, and what the photos showed. The pretend customer knows more, and nothing
 * learns from what they knew but never said or showed. Customers without a fact sheet (the
 * benchmark's, which say everything up front) and ones from before photos were marked say all of it.
 */
function marked(scenario: PracticeScenario) {
  return (scenario.facts ?? []).some((fact) => fact.visible);
}

/** The facts the owner had: the ones they asked about, and the ones the photos show. */
export function knownFacts(scenario: PracticeScenario, asked: string[]): Fact[] {
  const facts = scenario.facts ?? [];
  if (!marked(scenario)) return facts;
  return facts.filter((fact) => fact.visible || asked.includes(fact.key));
}

/** Whether the customer said the size themselves: in their first message, or when asked. */
function saidSize(scenario: PracticeScenario, asked: string[]) {
  const sizeFacts = (scenario.facts ?? []).filter((fact) => SIZE_FACT.test(fact.key));
  return (
    !sizeFacts.length ||
    sizeFacts.some((fact) => asked.includes(fact.key)) ||
    Boolean(scenario.opener && parseQuantity(scenario.opener))
  );
}

/** The job's size as the owner knew it, from what was said or shown. Empty when they didn't. */
export function knownSpec(scenario: PracticeScenario, asked: string[]): JobSpec {
  const sizeFacts = (scenario.facts ?? []).filter((fact) => SIZE_FACT.test(fact.key));
  const known =
    !marked(scenario) || saidSize(scenario, asked) || sizeFacts.some((fact) => fact.visible);
  return known ? specFromScenario(scenario) : emptySpec();
}

/**
 * The job's size as a live chat would have it before the photos are read: only what the customer
 * said. What the photos show comes to the Charm the way a live customer's does, from its reading.
 */
export function saidSpec(scenario: PracticeScenario, asked: string[]): JobSpec {
  return !marked(scenario) || saidSize(scenario, asked) ? specFromScenario(scenario) : emptySpec();
}

/**
 * What the photos showed that the conversation doesn't say, for the formula to read with the
 * job: "In the photos, the number of trees: Just the one little oak out front."
 */
export function photoLines(scenario: PracticeScenario, asked: string[]): string[] {
  if (!marked(scenario)) return [];
  return (scenario.facts ?? [])
    .filter((fact) => fact.visible && !asked.includes(fact.key))
    .map((fact) => `In the photos, ${fact.label}: ${fact.answer}`);
}
