import { rows } from './db.js';
import { businessIntro } from './business-intro.js';

const MAX_EVIDENCE = 200_000;
const quotedOrInstruction =
  /["“”`<>]|\b(?:pretend|imagine|instructions?|prompt|system|developer|assistant|website|says?|said|output|respond|ignore)\b|\b(?:write|quote|quoted)\s*[:"“']/i;
const correction =
  /\b(?:actually|correction|instead|no longer|used to|stopped|make (?:that|it)|change (?:the |my |our )?(?:area|coverage))\b|\b(?:don't|do not|never|not)\s+(?:serve|cover|work|operate|travel|offer|provide)\b/i;
const unsafeClause =
  /\b(?:last|recent(?:ly)?|yesterday|previous(?:ly)?|formerly|old|used to|would|could|might|maybe|if|unless|except|but|however|not|never|don't|do not|didn't|did not|charged|billed|invoiced|catered|cleaned|detailed|repaired|painted|washed|served|worked|operated|offered|provided|travelled|traveled|finished|completed)\b|[$€£¥@]|https?:/i;
const subject = '(?:I|we)\\s+(?:(?:currently|now|only|also)\\s+){0,2}';
const unparsedCoverage = /^(?:I|we)\s+(?:[\p{L}]+(?:['’][\p{L}]+)?\s+){0,3}(?:serve|cover)\b/iu;
const areaStatement = new RegExp(
  `^${subject}(?:(?:serve|cover)\\s+|(?:work|operate|travel)\\s+throughout\\s+|(?:offer|provide|perform|do|cater|clean|detail|repair|paint|wash|mow|install|photograph|teach)\\s+[\\p{L}\\p{M} &'-]{1,120}?\\s+(?:in|throughout|across|around|within)\\s+)(.+)$`,
  'iu',
);

/** Optional convenience, never coverage policy. Ambiguous source stays unanswered. */
export function suggestServiceArea(ownerMessages: readonly string[]): string | undefined {
  if (ownerMessages.reduce((size, message) => size + message.length, 0) > MAX_EVIDENCE) return;
  const candidates = new Map<string, string>();
  for (const message of ownerMessages) {
    if (correction.test(message)) return;
    if (quotedOrInstruction.test(message)) continue;
    // Avoid splitting names such as St. Louis or Washington, D.C. into false places.
    const clauses = message.split(/(?<=[.!?])\s+(?=(?:I|we|my|our|last|one|the|a)\b)/i);
    for (const text of clauses) {
      const clause = text.trim();
      const match = areaStatement.exec(clause),
        intro = businessIntro(clause),
        rawArea = match?.[1] || intro?.area;
      if (!rawArea) {
        if (
          unparsedCoverage.test(clause) ||
          /^(?:I|we)\s+(?:(?:currently|now)\s+)?run\b.+,\s+an?\s+.+\b(?:service|business)\s+in\b/i.test(
            clause,
          )
        )
          return;
        continue;
      }
      if (unsafeClause.test(clause)) return;
      const area = rawArea.replace(/[.!?]$/, '').trim();
      const online = /^(?:online|worldwide|globally|anywhere online|remotely worldwide)$/i.test(
        area,
      );
      if (
        area.length < 2 ||
        area.length > 500 ||
        !/^[\p{L}\p{M}][\p{L}\p{M}\d ,&'’()–-]*$/u.test(area) ||
        (!online &&
          (!/^\p{Lu}/u.test(area) || /^(?:the|a|an|all|every|each|your|their)\b/i.test(area))) ||
        /\b(?:up|food|meals?|tacos?|customers?|clients?|jobs?|projects?|events?|people|lunch(?:es)?|dinners?)\b/i.test(
          area,
        ) ||
        /\b(?:I|we|my|our|based|base|office|located|charge|pricing|prices?|rates?|fees?|minimum)\b/i.test(
          area,
        )
      )
        return;
      const normalized = area.toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
      candidates.set(normalized, area);
      if (candidates.size > 1) return;
    }
  }
  return candidates.values().next().value;
}

export async function serviceAreaSuggestions(
  businessId: string,
  serviceIds: readonly string[],
  currentArea: string,
): Promise<Record<string, string>> {
  if (currentArea.trim() || !serviceIds.length) return {};
  const setup = await rows(
    `SELECT setup.service_id,setup.messages_json FROM service_setup_sessions setup
     JOIN services service ON service.id=setup.service_id AND service.business_id=setup.business_id
     JOIN users owner ON owner.id=setup.user_id AND owner.business_id=setup.business_id
     WHERE setup.business_id=? AND setup.status='confirmed' AND setup.service_id IN (${serviceIds.map(() => '?').join(',')})
     ORDER BY setup.created_at,setup.id`,
    [businessId, ...serviceIds],
  );
  const sources = new Map<string, { messages: string[]; size: number; invalid: boolean }>();
  for (const record of setup) {
    const source = sources.get(record.service_id) || { messages: [], size: 0, invalid: false };
    sources.set(record.service_id, source);
    if (source.invalid) continue;
    try {
      const messages =
        typeof record.messages_json === 'string'
          ? JSON.parse(record.messages_json)
          : record.messages_json;
      if (!Array.isArray(messages)) throw new Error('Invalid setup evidence');
      for (const message of messages) {
        if (message?.role !== 'user') continue;
        if (typeof message.content !== 'string') throw new Error('Invalid owner evidence');
        source.size += message.content.length;
        if (source.size > MAX_EVIDENCE) throw new Error('Too much evidence for a suggestion');
        source.messages.push(message.content);
      }
    } catch {
      source.invalid = true;
      source.messages = [];
    }
  }
  return Object.fromEntries(
    [...sources].flatMap(([id, source]) => {
      const suggestion = source.invalid ? undefined : suggestServiceArea(source.messages);
      return suggestion ? [[id, suggestion]] : [];
    }),
  );
}
