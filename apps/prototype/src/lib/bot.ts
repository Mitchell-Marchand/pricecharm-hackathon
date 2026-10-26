import { PHOTO_REQUEST, PRICE_MENTION, SMALL_TALK, type Scenario } from '../data/scenarios';

/** Scripted practice customer: answers only from the scenario's fact sheet. */

export interface PracticeReply {
  text: string;
  photos?: string[];
  asked: string[];
  sentPhoto?: boolean;
  nudgeQuote?: boolean;
}

const NOT_SURE = [
  "Hmm, I'm not sure. What should I look for?",
  'Good question. I honestly don’t know.',
  "I'd have to check. Does that change the price much?",
];

export function practiceReply(
  scenario: Scenario,
  message: string,
  context: { photoSent: boolean; turn: number },
): PracticeReply {
  const text = message.trim();
  if (PHOTO_REQUEST.test(text)) {
    if (!context.photoSent) {
      return {
        text: scenario.extraPhoto.text,
        photos: [scenario.extraPhoto.photo],
        asked: ['photos'],
        sentPhoto: true,
      };
    }
    return { text: "That's all the photos I have right now. Anything else you need?", asked: [] };
  }
  const matches = scenario.facts.filter((fact) => fact.pattern.test(text));
  if (!matches.length && PRICE_MENTION.test(text)) return { text: scenario.priceNudge, asked: [], nudgeQuote: true };
  if (matches.length) {
    const answered = matches.slice(0, 2);
    return { text: answered.map((fact) => fact.answer).join(' '), asked: answered.map((fact) => fact.key) };
  }
  if (SMALL_TALK.test(text) && text.length < 40) return { text: 'Of course! Ask me anything about the job.', asked: [] };
  return { text: NOT_SURE[context.turn % NOT_SURE.length], asked: [] };
}

export function typingDelay(text = ''): number {
  return Math.min(2200, 700 + text.length * 14);
}
