/**
 * Retail sites (e.g. HK) inject statutory liquor notices into product tiles — exclude from wine title extraction.
 */

/** True if text is (or contains) a common HK/E-style “do not sell to minors” shop notice */
export function isLiquorLawDisclaimerText(text: string): boolean {
  const n = text.normalize('NFKC').toLowerCase();
  if (n.includes('intoxicating liquor') && (n.includes('minor') || n.includes('sold or supplied'))) return true;
  if (n.includes('under the law of hong kong') && n.includes('liquor')) return true;
  if (n.includes('must not be sold or supplied to a minor')) return true;
  return false;
}

/** Remove trailing statutory notice when concatenated with a real title */
export function stripLiquorLawDisclaimerSuffix(raw: string): string {
  let s = raw;
  const patterns = [
    /\s*:\s*Under the law of Hong Kong\b[\s\S]*/i,
    /\s*Under the law of Hong Kong\b[\s\S]*/i,
    /\s*intoxicating liquor must not be sold[\s\S]*/i,
  ];
  for (const re of patterns) {
    const next = s.replace(re, '').trim();
    if (next.length > 0) s = next;
  }
  return s.trim();
}

// Smoke: isLiquorLawDisclaimerText(': Under the law… intoxicating liquor… minor') === true
