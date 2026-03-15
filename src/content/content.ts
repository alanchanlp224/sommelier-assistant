/**
 * Sommelier Assistant - Content Script
 * DOM scanning, floating trigger icon, badge injection with Shadow DOM
 */

import type { DomainConfig, SearchResultMessage, SearchErrorMessage } from '../types';
import { startDetection } from './detection';

function logContent(level: 'info' | 'warn' | 'error' | 'debug', message: string, data?: unknown): void {
  chrome.runtime.sendMessage({ type: 'LOG', level, source: 'content', message, data }, () => {});
}

/** Check if current hostname matches any whitelisted domain */
async function getMatchingConfig(): Promise<DomainConfig | null> {
  const hostname = window.location.hostname.replace(/^www\./, '');
  const { whitelist } = (await chrome.storage.sync.get('whitelist')) as {
    whitelist?: DomainConfig[];
  };
  const list = whitelist ?? [];
  return list.find((d) => hostname === d.domain.replace(/^www\./, '')) ?? null;
}

/** Names to skip when scanning - common WooCommerce/shop UI text mistaken for wine names */
const SKIP_NAMES = new Set([
  'sale!',
  'add to basket',
  'add to cart',
  'view cart',
  'read more',
  'load more',
  'free shipping',
]);

function isLikelyWineName(name: string): boolean {
  const normalized = name.toLowerCase().trim();
  if (SKIP_NAMES.has(normalized)) return false;
  if (normalized.length < 3) return false;
  return true;
}

/** WooCommerce fallback selectors when config returns no results */
const WOOCOMMERCE_FALLBACKS: Pick<DomainConfig, 'containerSelector' | 'nameSelector'>[] = [
  { containerSelector: 'li.product', nameSelector: '.woocommerce-loop-product__title' },
  { containerSelector: 'li.product', nameSelector: 'h2, h3' },
  { containerSelector: 'ul.products li', nameSelector: '.woocommerce-loop-product__title, h2, h3, a' },
  { containerSelector: 'li.product', nameSelector: 'a' },
];

/** Extract wine names from page using config selectors, with fallbacks */
function scanWines(config: DomainConfig): { name: string; element: HTMLElement }[] {
  const trySelectors = (
    containerSel: string,
    nameSel: string,
    winerySel?: string,
    source?: string
  ): { name: string; element: HTMLElement }[] => {
    const results: { name: string; element: HTMLElement }[] = [];
    const containers = document.querySelectorAll(containerSel);
    logContent('debug', `trySelectors: ${containers.length} containers`, {
      containerSel,
      nameSel,
      winerySel,
      source,
    });
    containers.forEach((container) => {
      const nameEl = container.querySelector(nameSel) as HTMLElement | null;
      if (!nameEl) return;
      const wineName = nameEl.textContent?.trim();
      if (!wineName || wineName.length < 2) return;
      if (!isLikelyWineName(wineName)) return;

      let searchName = wineName;
      let winery: string | null = null;
      if (winerySel) {
        const wineryEl = container.querySelector(winerySel) as HTMLElement | null;
        winery = wineryEl?.textContent?.trim() ?? null;
        if (winery && isLikelyWineName(winery)) {
          searchName = `${winery} ${wineName}`.trim();
        }
      }

      logContent('debug', 'Wine captured', {
        wineName,
        winery: winery ?? '(not found)',
        searchName,
        wineryAppended: winery != null && winery.length > 0,
      });
      results.push({ name: searchName, element: nameEl });
    });
    return results;
  };

  const trySelectorsNoWinery = (
    containerSel: string,
    nameSel: string
  ): { name: string; element: HTMLElement }[] => {
    const results: { name: string; element: HTMLElement }[] = [];
    const containers = document.querySelectorAll(containerSel);
    containers.forEach((container) => {
      const candidates = container.querySelectorAll(nameSel);
      for (const el of candidates) {
        const name = (el as HTMLElement).textContent?.trim();
        if (!name || name.length < 2) continue;
        if (!isLikelyWineName(name)) continue;
        results.push({ name, element: el as HTMLElement });
        break;
      }
    });
    return results;
  };

  let results = trySelectors(
    config.containerSelector,
    config.nameSelector,
    config.winerySelector,
    'config'
  );

  if (results.length === 0 && config.winerySelector) {
    logContent('info', 'Primary selectors returned 0, trying without winery', {
      containerSelector: config.containerSelector,
      nameSelector: config.nameSelector,
    });
    results = trySelectorsNoWinery(config.containerSelector, config.nameSelector);
  }
  // Try winery fallbacks BEFORE WooCommerce (WooCommerce never has winery)
  // TenCellars-style: winery + wine in same container - use :has() to find containers with both
  if (results.length === 0 && config.winerySelector) {
    try {
      const parts = config.containerSelector.split(',').map((s) => s.trim());
      const withHas = parts
        .map((p) => `${p}:has(${config.winerySelector}):has(${config.nameSelector})`)
        .join(', ');
      results = trySelectors(withHas, config.nameSelector, config.winerySelector, 'config:has()');
      if (results.length > 0) {
        logContent('info', 'config:has() fallback matched (winery appended)', {
          count: results.length,
          sample: results.slice(0, 2).map((r) => r.name),
        });
      }
    } catch {
      /* :has() not supported or selector invalid */
    }
  }
  // Fallback: div with h2 and h1 as descendants (TenCellars-style product card)
  if (results.length === 0 && config.winerySelector && config.nameSelector) {
    try {
      const hasSel = `div:has(${config.winerySelector}):has(${config.nameSelector})`;
      const fallbackResults = trySelectors(hasSel, config.nameSelector, config.winerySelector, 'div:has(h2):has(h1)');
      // Dedupe by search name (parent div may match and give duplicates)
      const seen = new Set<string>();
      results = fallbackResults.filter((r) => {
        const key = normalizeName(r.name);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (results.length > 0) {
        logContent('info', 'div:has(h2):has(h1) fallback matched (winery appended)', {
          count: results.length,
          sample: results.slice(0, 2).map((r) => r.name),
        });
      }
    } catch {
      /* ignore */
    }
  }
  if (results.length === 0) {
    logContent('info', 'Trying WooCommerce fallback selectors (no winery)', { winerySelector: config.winerySelector });
    for (const fallback of WOOCOMMERCE_FALLBACKS) {
      results = trySelectorsNoWinery(fallback.containerSelector, fallback.nameSelector);
      if (results.length > 0) {
        logContent('info', 'WooCommerce fallback matched (no winery appended)', {
          containerSelector: fallback.containerSelector,
          nameSelector: fallback.nameSelector,
        });
        break;
      }
    }
  }

  return results;
}

/** Create the floating Sommelier trigger icon */
function createTriggerIcon(onClick: () => void): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.id = 'sommelier-trigger';
  wrapper.innerHTML = `
    <style>
      #sommelier-trigger {
        position: fixed;
        bottom: 24px;
        right: 24px;
        width: 56px;
        height: 56px;
        border-radius: 50%;
        background: linear-gradient(135deg, #722f37 0%, #4a1c22 100%);
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 2147483646;
        transition: transform 0.2s, box-shadow 0.2s;
      }
      #sommelier-trigger:hover {
        transform: scale(1.05);
        box-shadow: 0 6px 16px rgba(0,0,0,0.4);
      }
      #sommelier-trigger.sommelier-running {
        animation: sommelier-flash 1s ease-in-out infinite;
      }
      @keyframes sommelier-flash {
        0%, 100% { opacity: 1; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
        50% { opacity: 0.7; box-shadow: 0 0 20px rgba(114,47,55,0.6); }
      }
      #sommelier-trigger svg {
        width: 28px;
        height: 28px;
        fill: white;
      }
    </style>
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M6 3v6c0 2.97 2.16 5.43 5 5.91V19H8v2h8v-2h-3v-4.09c2.84-.48 5-2.94 5-5.91V3H6zm10 5H8V5h8v3z"/>
    </svg>
  `;
  wrapper.onclick = () => {
    if (isScanRunning) {
      chrome.runtime.sendMessage({ type: 'SEARCH_CANCEL' });
      pendingResultCount = 0;
      setRunning(false);
    } else {
      onClick();
    }
  };
  return wrapper;
}

/** Create badge element with Shadow DOM */
function createBadge(
  rating: number,
  reviewCount: number,
  vivinoUrl: string,
  vivinoWineName?: string
): HTMLElement {
  const color =
    rating > 0
      ? rating > 4.0
        ? '#22c55e'
        : rating >= 3.5
          ? '#eab308'
          : '#ef4444'
      : '#6b7280';
  const host = document.createElement('div');
  host.setAttribute('data-sommelier-badge', '');
  const shadow = host.attachShadow({ mode: 'closed' });
  const link = document.createElement('a');
  link.href = vivinoUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  const scoreText =
    rating > 0
      ? `<span class="star">★</span> ${rating.toFixed(1)}${reviewCount > 0 ? ` (${reviewCount})` : ''}`
      : `<span class="star">★</span> N/A (no ratings yet)`;
  const namePart = vivinoWineName ? ` <span class="vivino-name">— ${vivinoWineName}</span>` : '';
  link.title = vivinoWineName
    ? `${vivinoWineName} · ${reviewCount} reviews on Vivino`
    : reviewCount > 0
      ? `${reviewCount} reviews on Vivino`
      : 'No ratings yet on Vivino';
  link.innerHTML = scoreText + namePart;
  link.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.sendMessage({ type: 'OPEN_TAB', url: vivinoUrl });
  });
  const style = document.createElement('style');
  style.textContent = `
    :host {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-left: 8px;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 13px;
      font-weight: 600;
    }
    a {
      color: inherit;
      text-decoration: none;
      padding: 2px 8px;
      border-radius: 6px;
      background: ${color}22;
      color: ${color};
      border: 1px solid ${color}44;
      transition: opacity 0.2s;
    }
    a:hover { opacity: 0.9; }
    .star { color: #fbbf24; }
    .vivino-name { font-size: 11px; font-weight: 500; opacity: 0.9; }
  `;
  shadow.appendChild(style);
  shadow.appendChild(link);
  return host;
}

/** Map wine name -> element for injection */
const wineElementMap = new Map<string, HTMLElement>();

let isScanRunning = false;
let pendingResultCount = 0;
let triggerIconEl: HTMLElement | null = null;

function normalizeName(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function findElementForWine(wineName: string): HTMLElement | undefined {
  const normalized = normalizeName(wineName);
  for (const [key, el] of wineElementMap) {
    if (normalizeName(key) === normalized) return el;
  }
  return wineElementMap.get(wineName);
}

function setRunning(running: boolean): void {
  isScanRunning = running;
  if (triggerIconEl) {
    if (running) triggerIconEl.classList.add('sommelier-running');
    else triggerIconEl.classList.remove('sommelier-running');
  }
}

function handleSearchResult(msg: SearchResultMessage): void {
  pendingResultCount = Math.max(0, pendingResultCount - 1);
  if (pendingResultCount === 0) setRunning(false);

  const el = findElementForWine(msg.wineName);
  if (!el) {
    logContent('warn', `No DOM element for wine "${msg.wineName}"`, {
      knownNames: Array.from(wineElementMap.keys()).slice(0, 5),
    });
    return;
  }
  const existing = el.parentElement?.querySelector('[data-sommelier-badge]');
  if (existing) existing.remove();
  const badge = createBadge(msg.rating, msg.reviewCount, msg.vivinoUrl, msg.vivinoWineName);
  el.parentElement?.insertBefore(badge, el.nextSibling);
  logContent('info', `Badge injected for "${msg.wineName}"`, { rating: msg.rating });
}

function handleSearchError(msg: SearchErrorMessage): void {
  pendingResultCount = Math.max(0, pendingResultCount - 1);
  if (pendingResultCount === 0) setRunning(false);
  logContent('warn', `Search error for "${msg.wineName}"`, { error: msg.error });
}

/** Main scan & request flow */
async function runScan(): Promise<void> {
  const config = await getMatchingConfig();
  if (!config) {
    logContent('warn', 'Scan skipped: domain not in whitelist');
    alert('Sommelier Assistant: This site is not in your whitelist. Add it in the extension popup.');
    return;
  }

  logContent('info', 'Scan started', {
    domain: config.domain,
    containerSelector: config.containerSelector,
    nameSelector: config.nameSelector,
    winerySelector: config.winerySelector ?? '(none)',
  });

  const wines = scanWines(config);
  logContent('info', `Scan found ${wines.length} wines`, {
    wineNames: wines.map((w) => w.name).slice(0, 10),
    sampleWithWinery: wines.slice(0, 3).map((w) => ({
      searchName: w.name,
      hasWineryPrefix: w.name.split(' ').length > 2, // heuristic: "Domaine X Wine Y" has many parts
    })),
  });

  if (wines.length === 0) {
    alert('Sommelier Assistant: No wine products found. Try adjusting the selectors in settings.');
    setRunning(false);
    return;
  }

  wineElementMap.clear();
  wines.forEach(({ name, element }) => {
    const key = normalizeName(name);
    wineElementMap.set(key, element);
  });

  isScanRunning = true;
  pendingResultCount = wines.length;
  setRunning(true);

  chrome.runtime.sendMessage({
    type: 'SEARCH_REQUEST',
    wineNames: wines.map((w) => w.name),
  });
  logContent('info', 'Search request sent to background', { count: wines.length });
}

chrome.runtime.onMessage.addListener(
  (msg: SearchResultMessage | SearchErrorMessage | { type: 'START_DETECTION' }) => {
    if (msg.type === 'SEARCH_RESULT') handleSearchResult(msg);
    else if (msg.type === 'SEARCH_ERROR') handleSearchError(msg);
    else if (msg.type === 'START_DETECTION') startDetection();
  }
);

/** Initialize: show trigger if domain is whitelisted */
async function init(): Promise<void> {
  const config = await getMatchingConfig();
  if (!config) {
    const existing = document.getElementById('sommelier-trigger');
    if (existing) existing.remove();
    triggerIconEl = null;
    return;
  }

  const existing = document.getElementById('sommelier-trigger');
  if (existing) return;

  const icon = createTriggerIcon(runScan);
  triggerIconEl = icon;
  document.body.appendChild(icon);
}

// Run when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Re-check when whitelist changes (e.g. user added a site in popup)
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && changes.whitelist) {
    init();
  }
});
