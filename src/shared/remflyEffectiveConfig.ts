/**
 * Discovery mode can save invalid Remfly selectors (e.g. `p.montserrat` as “container”).
 * Fall back to the shipped preset so listing pages still scan real product cards.
 *
 * Important: Do not import `defaultWhitelist.ts` here — that pulls a shared Rollup chunk and
 * Vite emits `import … from "./chunks/…"` at the top of `content.js`. Chrome runs content
 * scripts as classic scripts, so top-level `import` fails to parse and the trigger never appears.
 * Keep these strings aligned with the remfly row in `defaultWhitelist.ts`.
 */
import type { DomainConfig } from '../types';

const REMFLY_DOMAIN = 'remfly.com.hk';

/** Mirrors `DEFAULT_DOMAIN_PRESETS` entry for remfly.com.hk in defaultWhitelist.ts */
const REMFLY_BUILTIN: Pick<DomainConfig, 'containerSelector' | 'nameSelector' | 'winerySelector'> = {
  containerSelector: 'div.product-cardcontainer',
  nameSelector:
    'p.montserrat.rem-text-16.text-remdark.list-none, p.montserrat.rem-text-16.text-remdark.grid-none, p.montserrat.rem-text-16.text-remdark',
};

function presetRemfly(): DomainConfig {
  return {
    domain: REMFLY_DOMAIN,
    ...REMFLY_BUILTIN,
  };
}

/** True when saved selectors match patterns we’ve seen break First Growths scans */
export function remflyStoredSelectorsLookBroken(config: DomainConfig): boolean {
  const host = config.domain.replace(/^www\./, '');
  if (host !== REMFLY_DOMAIN) return false;

  const c = (config.containerSelector || '').trim();
  const nameSel = (config.nameSelector || '').trim();
  const winerySel = config.winerySelector?.trim();

  if (c.startsWith('p.')) return true;
  if (nameSel === 'p' && winerySel === 'p') return true;

  return false;
}

/** Use built-in Remfly card selectors when stored config would not target product tiles */
export function effectiveRemflyConfig(stored: DomainConfig): DomainConfig {
  if (!remflyStoredSelectorsLookBroken(stored)) return stored;
  const preset = presetRemfly();
  return {
    domain: stored.domain,
    containerSelector: preset.containerSelector,
    nameSelector: preset.nameSelector,
    winerySelector: preset.winerySelector,
  };
}
