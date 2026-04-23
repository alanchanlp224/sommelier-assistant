/**
 * Remfly.com.hk product titles mix Chinese copy, promo badges, and English wine names — normalize for Vivino search.
 */

import { stripLiquorLawDisclaimerSuffix } from './liquorDisclaimer';

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g;

/** Strip leading promo badges (repeat — cards often chain “20% OFF 多買多平 …”). */
function stripLeadingPromoBadges(s: string): string {
  let t = s;
  for (let i = 0; i < 8; i++) {
    const next = t
      .replace(/^\s*\d{1,3}\s*%\s*OFF\b\s*/gi, ' ')
      .replace(/^\s*\d{1,3}\s*%\s*/g, ' ')
      .replace(/^\s*(多買多平|特價|限定|優惠|推廣)\s*/g, ' ')
      .replace(/^\s*OFF\s*/gi, ' ');
    if (next === t) break;
    t = next;
  }
  return t;
}

function stripPricesAndUnits(s: string): string {
  return s
    .replace(/HK\$[\d,]+\.?\d*/gi, ' ')
    .replace(/MOP\$[\d,]+\.?\d*/gi, ' ')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ml|cl|mL|L)\b/gi, ' ')
    .replace(/\b\d{1,3}\s*%\s*(?:OFF)?\b/gi, ' ');
}

/**
 * Keep English/Latin search text: drop CJK, promos, prices; expand Ch. → Chateau.
 */
export function remflyNormalizeSearchTitle(raw: string): string {
  let s = stripLiquorLawDisclaimerSuffix(raw.normalize('NFKC')).trim();
  s = s.replace(/【[^】]*】/g, ' ');
  s = stripLeadingPromoBadges(s);
  s = s.replace(/\[[^\]]*\]/g, ' ');
  s = stripLeadingPromoBadges(s);
  s = s.replace(CJK_RE, ' ');
  s = stripPricesAndUnits(s);
  s = s.replace(/\bCh\.\s*/gi, 'Chateau ');
  s = s.replace(/\s+/g, ' ').trim();

  const letters = s.replace(/[^a-z]/gi, '');
  if (letters.length < 4) {
    const fallback = stripPricesAndUnits(
      stripLeadingPromoBadges(raw.normalize('NFKC').replace(CJK_RE, ' '))
    )
      .replace(/\bCh\.\s*/gi, 'Chateau ')
      .replace(/\s+/g, ' ')
      .trim();
    if (fallback.replace(/[^a-z]/gi, '').length > letters.length) {
      s = fallback;
    }
  }
  if (s.replace(/[^a-z]/gi, '').length < 4) return '';
  return s;
}

// Smoke: remflyNormalizeSearchTitle('20% OFF 多買多平 Ch. Haut Brion 2014 HK$2950').includes('Chateau Haut Brion')
