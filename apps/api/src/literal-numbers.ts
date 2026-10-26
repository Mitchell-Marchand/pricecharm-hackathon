/** Token offsets bind numeric evidence to complete expressions in the selected quote and input. */
export function selectedLiteral(
  content: string,
  quote: string,
  evidence: string | null,
  pattern: RegExp,
  rejectRanges = false,
) {
  if (!evidence?.trim()) return null;
  const selected = [...evidence.matchAll(pattern)];
  if (selected.length !== 1) return null;
  const token = selected[0],
    sourceTokens = new Map(
      [...content.matchAll(pattern)]
        .filter(
          (source) =>
            !/\d[ \t\u00a0\u202f]+$/.test(content.slice(0, source.index)) &&
            !/^[ \t\u00a0\u202f]+\d/.test(content.slice(source.index + source[0].length)) &&
            (!rejectRanges ||
              (!/\d[\d.,]*(?:\s*(?:USD|CAD|AUD|NZD|EUR|GBP|JPY|US dollars?|Canadian dollars?|dollars?))?\s*(?:[-–—]|to)\s*$/i.test(
                content.slice(0, source.index),
              ) &&
                !/^\s*(?:[-–—]|to)\s*(?:(?:(?:US|CA|AU|NZ|C|A)?\$|[€£¥]|USD|CAD|AUD|NZD|EUR|GBP|JPY)\s*)?\d/i.test(
                  content.slice(source.index + source[0].length),
                ))),
        )
        .map((source) => [source.index, source[0]]),
    );
  for (let job = content.indexOf(quote); job !== -1; job = content.indexOf(quote, job + 1)) {
    for (let at = quote.indexOf(evidence); at !== -1; at = quote.indexOf(evidence, at + 1)) {
      const start = job + at + token.index;
      if (sourceTokens.get(start) === token[0]) return token;
    }
  }
  return null;
}
export const monetaryLiteral =
  /(?<![\p{L}\p{N}.,])(?:[-−+]\s*)?(?:(?:(?:US|CA|AU|NZ|C|A)?\$|[€£¥]|\b(?:USD|CAD|AUD|NZD|EUR|GBP|JPY)\s*)\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)(?:\s*(?:USD|CAD|AUD|NZD|EUR|GBP|JPY)\b)?|\b(\d+(?:,\d{3})*(?:\.\d{1,2})?)\s*(?:USD|CAD|AUD|NZD|EUR|GBP|JPY|US dollars?|Canadian dollars?|dollars?)\b)(?![\p{L}\p{N},]|\.\d)/giu;
