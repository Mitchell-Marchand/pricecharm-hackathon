const introduction =
  /^(?:I|we)\s+(?:(?:currently|now)\s+)?run\s+([\p{L}\p{M}\d &'’-]{1,100}),\s+an?\s+([\p{L}\p{M} &'’-]{3,120}?)\s+(?:service|business)(?:\s+in\s+(.+?))?[.!]?$/iu;
const unsafe =
  /["“”`<>$€£¥@]|https?:|\b(?:ignore|instructions?|prompt|password|confidential|secret|publish|reveal|expose|system|developer|assistant|respond|answer|write|say|tell|would|might|could|maybe|hypothetical|not|never|used to|previously|formerly|charged|billed|invoice|pricing|prices?|rates?|fees?|minimum|profit|margin)\b/i;

/** Literal current brand, category and optional location, never arbitrary model prose. */
export function businessIntro(
  clause: string,
): { brand: string; category: string; area: string | null } | null {
  const text = clause.trim(),
    match = introduction.exec(text);
  if (!match || unsafe.test(text)) return null;
  const category = match[2].trim();
  if (
    category.length < 3 ||
    /\d|\b(?:I|we|my|our|you|your|if|unless|but|because|with|without|based|located)\b/i.test(
      category,
    ) ||
    /^(?:(?:some|general|various|different|all kinds of)\s+)?(?:work|stuff|things|services?|jobs?|projects?|anything|everything|help|business|company)$/i.test(
      category,
    )
  )
    return null;
  return {
    brand: match[1].trim(),
    category: category[0].toUpperCase() + category.slice(1),
    area: match[3]?.replace(/[.!]$/, '').trim() || null,
  };
}

/** An editable identity suggestion from the original note, never a model or service label. */
export function businessNameSuggestion(content: string): string | null {
  if (
    content.length > 5000 ||
    /["“”`<>]|https?:|\b(?:ignore|instructions?|prompt|password|confidential|secret|publish|reveal|expose|system|developer|assistant|respond|answer|write|says?|said|tell|actually|correction|instead|rename[ds]?|renaming|rebrand(?:ed|ing)?|no longer|make (?:that|it)|change (?:the |my |our )?(?:business )?name)\b/i.test(
      content,
    )
  )
    return null;
  const brands = new Map<string, string>();
  for (const clause of content.split(/[;\n]|(?<=[.!?])\s+(?=[A-Za-z])/)) {
    const intro = businessIntro(clause);
    if (!intro) {
      if (/\b(?:run|ran)\b.+,\s+an?\s+.+\b(?:service|business)\b/i.test(clause)) return null;
      continue;
    }
    if (intro.brand.length < 2 || intro.brand.length > 100) return null;
    brands.set(intro.brand.toLocaleLowerCase('en-US').replace(/\s+/g, ' '), intro.brand);
    if (brands.size > 1) return null;
  }
  return brands.values().next().value || null;
}
