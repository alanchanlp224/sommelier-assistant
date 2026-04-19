/**
 * Strip parenthetical / bracketed retail copy from wine titles before external search.
 */

/** Remove `(...)`, `（…）`, and `[...]` segments; collapse spaces (repeat for back-to-back pairs). */
export function normalizeWineSearchQuery(raw: string): string {
  let s = raw.replace(/["']/g, '').trim();
  let prev = '';
  while (s !== prev) {
    prev = s;
    s = s
      .replace(/\([^)]*\)/g, ' ')
      .replace(/（[^）]*）/g, ' ')
      .replace(/\[[^\]]*\]/g, ' ');
  }
  return s.replace(/\s{2,}/g, ' ').trim();
}

// Smoke: normalizeWineSearchQuery('Sottimano 2020 (Promo text)') === 'Sottimano 2020'
