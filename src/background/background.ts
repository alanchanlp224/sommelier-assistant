/**
 * Sommelier Assistant - Background Service Worker
 * Handles: Task queue with rate limiting, Vivino Explore API search
 */

import type {
  DetectionResultMessage,
  DomainConfig,
  ExtensionConfig,
  ExtensionMessage,
  LogEntry,
  VivinoSearchResult,
} from '../types';
import { logBackground, getLogs, isLoggingEnabled } from '../shared/logger';
import { DEFAULT_DOMAIN_PRESETS } from '../shared/defaultWhitelist';
import {
  DEFAULT_GITHUB_RELEASE_REPO,
  compareSemver,
  fetchLatestRelease,
} from '../shared/githubUpdate';
import { normalizeWineSearchQuery } from '../shared/normalizeWineSearchQuery';

/** Explore list JSON — same source the SPA loads after shell HTML (see `public/rules.json` for MV3 headers). */
const VIVINO_EXPLORE_API = 'https://www.vivino.com/api/explore/explore';

const DEFAULT_MIN_DELAY_MS = 1500;
const DEFAULT_MAX_DELAY_MS = 3000;

const DELAY_MIN_KEY = 'sommelier_delay_min_ms';
const DELAY_MAX_KEY = 'sommelier_delay_max_ms';

const GITHUB_UPDATE_ALARM = 'sommelier-github-release-check';
const PENDING_GITHUB_UPDATE_KEY = 'sommelier_pending_github_update';

/** Period between automatic checks (GitHub unauthenticated limit is 60 req/hr per IP). */
const GITHUB_CHECK_PERIOD_MINUTES = 360;

/** Task queue: one search at a time with randomized delay */
interface QueuedTask {
  wineName: string;
  tabId: number;
  resolve: (result: VivinoSearchResult | null) => void;
}

let taskQueue: QueuedTask[] = [];
let isProcessing = false;

function cancelTasksForTab(tabId: number): void {
  const before = taskQueue.length;
  taskQueue = taskQueue.filter((t) => {
    if (t.tabId === tabId) {
      t.resolve(null);
      return false;
    }
    return true;
  });
  if (before !== taskQueue.length) {
    logBackground('info', `Cancelled ${before - taskQueue.length} tasks for tab ${tabId}`);
  }
}

async function getDelayRange(): Promise<{ min: number; max: number }> {
  const { [DELAY_MIN_KEY]: min, [DELAY_MAX_KEY]: max } = await chrome.storage.local.get([
    DELAY_MIN_KEY,
    DELAY_MAX_KEY,
  ]);
  const minMs = typeof min === 'number' && min >= 0 ? min : DEFAULT_MIN_DELAY_MS;
  const maxMs = typeof max === 'number' && max >= 0 ? max : DEFAULT_MAX_DELAY_MS;
  return { min: minMs, max: Math.max(minMs, maxMs) };
}

async function randomDelay(): Promise<number> {
  const { min, max } = await getDelayRange();
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function processQueue(): Promise<void> {
  if (isProcessing || taskQueue.length === 0) return;
  isProcessing = true;

  const task = taskQueue.shift()!;
  // Skip if tab was closed/navigated (task may have been cancelled but not removed)
  try {
    const tab = await chrome.tabs.get(task.tabId);
    if (!tab?.id) {
      task.resolve(null);
      isProcessing = false;
      if (taskQueue.length > 0) processQueue();
      return;
    }
  } catch {
    task.resolve(null);
    isProcessing = false;
    if (taskQueue.length > 0) processQueue();
    return;
  }
  const delay = await randomDelay();
  await new Promise((r) => setTimeout(r, delay));

  const sendToTab = (msg: object) => {
    try {
      chrome.tabs.sendMessage(task.tabId, msg);
    } catch {
      // Tab may have been closed
    }
  };

  logBackground('info', `Searching Vivino for: "${task.wineName}"`, { tabId: task.tabId });

  try {
    const result = await searchVivino(task.wineName);
    task.resolve(result);
    if (result) {
      logBackground('info', `Vivino result for "${task.wineName}"`, {
        rating: result.rating,
        reviewCount: result.reviewCount,
        vivinoUrl: result.vivinoUrl,
      });
      sendToTab({
        type: 'SEARCH_RESULT',
        wineName: task.wineName,
        rating: result.rating,
        reviewCount: result.reviewCount,
        vivinoUrl: result.vivinoUrl,
        vivinoWineName: result.vivinoWineName,
        tabId: task.tabId,
      });
    } else {
      logBackground('warn', `No Vivino result for "${task.wineName}"`);
      sendToTab({
        type: 'SEARCH_ERROR',
        wineName: task.wineName,
        error: 'No results found',
        tabId: task.tabId,
      });
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logBackground('error', `Vivino search failed for "${task.wineName}"`, { error: errMsg });
    task.resolve(null);
    sendToTab({
      type: 'SEARCH_ERROR',
      wineName: task.wineName,
      error: err instanceof Error ? err.message : 'Search failed',
      tabId: task.tabId,
    });
  } finally {
    isProcessing = false;
    if (taskQueue.length > 0) {
      processQueue();
    }
  }
}

function queueSearch(wineName: string, tabId: number): Promise<VivinoSearchResult | null> {
  return new Promise((resolve) => {
    taskQueue.push({ wineName, tabId, resolve });
    processQueue();
  });
}

function buildVivinoExploreApiUrl(
  searchTerm: string,
  page: number,
  orderBy: string,
  order: 'asc' | 'desc',
  paramStyle: 'country_code' | 'country_codes_array' = 'country_code'
): string {
  if (paramStyle === 'country_codes_array') {
    const p = new URLSearchParams();
    p.append('country_codes[]', 'us');
    p.append('country_codes[]', 'fr');
    p.append('currency_code', 'USD');
    p.set('min_rating', '0');
    p.set('order_by', orderBy);
    p.set('order', order);
    p.set('page', String(page));
    p.set('per_page', '25');
    p.set('price_range_min', '0');
    p.set('price_range_max', '1000000');
    p.set('search_term', searchTerm);
    /** Vivino web client always appends `language` (see webpack `Vg` / explore helpers). */
    p.set('language', 'en');
    return `${VIVINO_EXPLORE_API}?${p.toString()}`;
  }
  const params = new URLSearchParams({
    country_code: 'US',
    currency_code: 'USD',
    min_rating: '0',
    order_by: orderBy,
    order,
    page: String(page),
    per_page: '25',
    price_range_min: '0',
    price_range_max: '1000000',
    search_term: searchTerm,
    language: 'en',
  });
  return `${VIVINO_EXPLORE_API}?${params.toString()}`;
}

function parseVivinoJsonFromText(text: string): unknown | null {
  const t = text.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return null;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return null;
  }
}

function parseVivinoExploreApiResponse(data: unknown, searchTerm: string): VivinoSearchResult | null {
  const matches = findSearchMatchesArray(data);
  if (!matches || matches.length === 0) return null;
  return pickBestFromMatches(matches, searchTerm);
}

function vivinoExploreRecordsMatched(data: unknown): number | null {
  if (!data || typeof data !== 'object') return null;
  const ev = (data as Record<string, unknown>).explore_vintage;
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return null;
  const n = (ev as Record<string, unknown>).records_matched;
  return typeof n === 'number' ? n : null;
}

/** For failed searches: log Vivino payload shape (and optional raw snippet) without huge strings. */
function summarizeExplorePayload(data: unknown, maxPreview = 16): Record<string, unknown> {
  const rm = vivinoExploreRecordsMatched(data);
  const out: Record<string, unknown> = { records_matched: rm };
  const matches = findSearchMatchesArray(data);
  if (!matches?.length) {
    out.matches_in_payload = 0;
    return out;
  }
  out.matches_in_payload = matches.length;
  out.match_previews = matches.slice(0, maxPreview).map((m) => {
    const vintage = m?.vintage as Record<string, unknown> | undefined;
    const wine = (vintage?.wine ?? {}) as Record<string, unknown>;
    const stats = (vintage?.statistics ?? {}) as Record<string, unknown>;
    const name = String(vintage?.name ?? wine?.name ?? '');
    const slug = String(vintage?.seo_name ?? wine?.seo_name ?? '');
    return {
      name: name.slice(0, 130),
      slug: slug.slice(0, 90),
      ratings_average: stats.ratings_average ?? 0,
      ratings_count: stats.ratings_count ?? 0,
    };
  });
  return out;
}

interface VivinoApiSearchTrace {
  lastPayload: unknown | null;
  /** Truncated raw JSON from last successful Vivino HTTP body (for debugging misses). */
  lastRawSnippet: string | null;
}

async function searchVivinoExploreWithParamStyle(
  cleanName: string,
  paramStyle: 'country_code' | 'country_codes_array',
  trace?: VivinoApiSearchTrace
): Promise<VivinoSearchResult | null> {
  const sortPlans: Array<{ orderBy: string; order: 'asc' | 'desc'; maxPage: number }> = [
    { orderBy: 'price', order: 'desc', maxPage: 4 },
    { orderBy: 'price', order: 'asc', maxPage: 4 },
    { orderBy: 'ratings_average', order: 'desc', maxPage: 2 },
  ];

  for (const { orderBy, order, maxPage } of sortPlans) {
    for (let page = 1; page <= maxPage; page++) {
      const url = buildVivinoExploreApiUrl(cleanName, page, orderBy, order, paramStyle);
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          headers: {
            /** Mirrors Vivino's web `fetch` wrapper (`X-Requested-With`, JSON accept/type). */
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'Accept-Language': 'en-US,en;q=0.9',
            Referer: 'https://www.vivino.com/en/explore',
          },
          redirect: 'follow',
        });
      } catch (err) {
        await logBackground('warn', `Vivino API fetch failed`, {
          error: err instanceof Error ? err.message : String(err),
          url,
        });
        continue;
      }

      if (res.status === 429) {
        throw new Error('Too many requests. Please wait a moment and try again.');
      }
      if (!res.ok) {
        let bodyPeek = '';
        try {
          bodyPeek = (await res.clone().text()).slice(0, 220);
        } catch {
          /* ignore */
        }
        await logBackground('debug', `Vivino API response`, {
          status: res.status,
          page,
          orderBy,
          order,
          paramStyle,
          bodyPeek,
        });
        continue;
      }

      const textBody = await res.text();
      if (trace) {
        trace.lastRawSnippet = textBody.slice(0, 4000);
      }
      const data = parseVivinoJsonFromText(textBody);
      if (data === null) {
        await logBackground('debug', `Vivino API body not JSON`, {
          page,
          orderBy,
          paramStyle,
          bodySnippet: textBody.slice(0, 400),
        });
        continue;
      }
      if (trace) {
        trace.lastPayload = data;
      }

      const rm = vivinoExploreRecordsMatched(data);
      if (rm === 0 && page === 1) {
        await logBackground('debug', `Vivino API zero records for query`, {
          cleanName,
          paramStyle,
          vivinoPayloadSummary: summarizeExplorePayload(data),
          rawResponseSnippet: textBody.slice(0, 2500),
        });
        return null;
      }

      const picked = parseVivinoExploreApiResponse(data, cleanName);
      if (picked) {
        await logBackground('info', `Vivino API matched wine`, {
          page,
          orderBy,
          order,
          paramStyle,
          vivinoUrl: picked.vivinoUrl,
        });
        return picked;
      }
    }
  }

  return null;
}

async function searchVivinoViaExploreApi(
  cleanName: string,
  trace?: VivinoApiSearchTrace
): Promise<VivinoSearchResult | null> {
  const primary = await searchVivinoExploreWithParamStyle(cleanName, 'country_code', trace);
  if (primary) return primary;
  return searchVivinoExploreWithParamStyle(cleanName, 'country_codes_array', trace);
}

async function searchVivino(wineName: string): Promise<VivinoSearchResult | null> {
  const cleanName = normalizeWineSearchQuery(wineName);
  await logBackground('info', `Searching Vivino for`, { wineName: cleanName });

  const trace: VivinoApiSearchTrace = { lastPayload: null, lastRawSnippet: null };
  const apiResult = await searchVivinoViaExploreApi(cleanName, trace);
  if (!apiResult) {
    const vivinoPayloadSummary = trace.lastPayload ? summarizeExplorePayload(trace.lastPayload) : null;
    const matchedCount =
      vivinoPayloadSummary && typeof vivinoPayloadSummary.matches_in_payload === 'number'
        ? vivinoPayloadSummary.matches_in_payload
        : 0;
    let hint = 'No JSON body captured (HTTP error or non-JSON response).';
    if (trace.lastPayload && vivinoPayloadSummary) {
      const rm = vivinoPayloadSummary.records_matched;
      if (matchedCount > 0) {
        hint = 'Vivino returned matches but none passed anchor/year filters.';
      } else if (typeof rm === 'number' && rm === 0) {
        hint = 'Vivino records_matched was 0 for this query.';
      } else {
        hint = 'Payload parsed but no matches array extracted.';
      }
    }
    await logBackground('warn', `No Vivino result after Explore API search`, {
      cleanName,
      vivinoPayloadSummary,
      rawResponseSnippet: trace.lastRawSnippet ?? undefined,
      hint,
    });
  }
  return apiResult;
}

function isVintageMatchRecord(x: unknown): boolean {
  return !!x && typeof x === 'object' && 'vintage' in (x as object);
}

/** Recursively find Vivino search `matches` array (snake or camel parent). */
function findSearchMatchesArray(root: unknown, depth = 0): Array<Record<string, unknown>> | null {
  if (depth > 30 || root === null || typeof root !== 'object') return null;
  if (Array.isArray(root)) {
    if (root.length > 0 && isVintageMatchRecord(root[0])) {
      return root as Array<Record<string, unknown>>;
    }
    return null;
  }
  const o = root as Record<string, unknown>;
  const sr = (o.search_results ?? o.searchResults) as Record<string, unknown> | undefined;
  if (sr && typeof sr === 'object' && !Array.isArray(sr)) {
    const m = sr.matches;
    if (Array.isArray(m) && m.length > 0 && isVintageMatchRecord(m[0])) {
      return m as Array<Record<string, unknown>>;
    }
  }
  const ev = (o.explore_vintage ?? o.exploreVintage) as Record<string, unknown> | undefined;
  if (ev && typeof ev === 'object' && !Array.isArray(ev)) {
    const m = ev.matches;
    if (Array.isArray(m) && m.length > 0 && isVintageMatchRecord(m[0])) {
      return m as Array<Record<string, unknown>>;
    }
  }
  for (const v of Object.values(o)) {
    const found = findSearchMatchesArray(v, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Normalize for matching accents (Château vs Chateau) and combining marks. */
function foldWineCompare(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Strip generic Bordeaux/wine tokens so we match the distinctive part of the query (e.g. Cantemerle, not just “Château”). */
const WINE_QUERY_STOPWORDS = new Set([
  'chateau',
  'châteaux',
  'château',
  'domaine',
  'wine',
  'the',
  'de',
  'du',
  'des',
  'la',
  'le',
  'les',
  'grand',
  'cru',
  'classé',
  'rouge',
  'blanc',
  'red',
  'white',
  'vintage',
]);

/**
 * Shop titles often append grape (e.g. “Pinot Noir”) but Vivino vintage names omit it —
 * excluding these as required anchors avoids rejecting the correct hit (e.g. Les Violettes).
 */
const GRAPE_VARIETY_ANCHOR_SKIP = new Set([
  'pinot',
  'noir',
  'gris',
  'chardonnay',
  'cabernet',
  'sauvignon',
  'merlot',
  'syrah',
  'shiraz',
  'riesling',
  'sangiovese',
  'nebbiolo',
  'gamay',
  'malbec',
  'tempranillo',
  'grenache',
  'mourvedre',
  'viognier',
  'semillon',
  'albarino',
  'dolcetto',
  'barbera',
  'zinfandel',
  'chenin',
  'muscat',
  'torrontes',
  'carmenere',
  'primitivo',
  'corvina',
  'vermentino',
  'gewurztraminer',
  'trebbiano',
  'pinotage',
  'furmint',
  'negroamaro',
  'carignan',
  'mencia',
  'aglianico',
  'grillo',
  'verdejo',
  'assyrtiko',
  'rose',
]);

function anchorTokensForWineQuery(term: string): { anchors: string[]; year: string | null } {
  const folded = foldWineCompare(term);
  const yearMatch = folded.match(/\b(19|20)\d{2}\b/);
  const year = yearMatch ? yearMatch[0] : null;
  const words = folded.split(/\s+/).filter((w) => w.length > 1 && !/^(19|20)\d{2}$/.test(w));
  let anchors = words.filter((w) => !WINE_QUERY_STOPWORDS.has(w));
  anchors = anchors.filter((w) => !GRAPE_VARIETY_ANCHOR_SKIP.has(w));
  if (anchors.length === 0) {
    anchors = words.filter((w) => w.length > 3 && !GRAPE_VARIETY_ANCHOR_SKIP.has(w));
  }
  if (anchors.length === 0) {
    anchors = words.filter((w) => !GRAPE_VARIETY_ANCHOR_SKIP.has(w));
  }
  if (anchors.length === 0) {
    anchors = words;
  }
  return { anchors, year };
}

/** Importance weight for a query token — longer estate-specific words matter more than short glue words. */
function tokenImportance(token: string): number {
  if (token.length <= 2) return 0.35;
  if (token.length === 3) return 0.75;
  if (token.length <= 5) return 1.0;
  return Math.min(2.0, 1.15 + token.length * 0.05);
}

/**
 * Score how well `token` matches Vivino fields (vintage title, wine name, slug-as-text).
 * Name match > winery-only > slug-only.
 */
function scoreTokenAgainstRecord(
  token: string,
  vintageNameFolded: string,
  wineNameFolded: string,
  slugFolded: string
): number {
  const w = tokenImportance(token);
  const slugAsText = slugFolded.replace(/-/g, ' ');
  if (vintageNameFolded.includes(token)) return w * 1.0;
  if (wineNameFolded.includes(token)) return w * 0.92;
  if (slugAsText.includes(token)) return w * 0.85;
  return 0;
}

const MATCH_YEAR_BONUS = 10;
const MATCH_RATING_WEIGHT = 0.18;
const MATCH_REVIEW_LOG_WEIGHT = 0.06;

/** Sum of weighted token hits + optional year bonus + weak Vivino popularity signals — highest wins. */
function vivinoRecordMatchScoreFields(
  tokens: string[],
  yearFromQuery: string | null,
  vintageNameFolded: string,
  wineNameFolded: string,
  slugFolded: string,
  rating: number,
  reviewCount: number
): { total: number; tokenSum: number; yearMatch: boolean } {
  let tokenSum = 0;
  for (const t of tokens) {
    tokenSum += scoreTokenAgainstRecord(t, vintageNameFolded, wineNameFolded, slugFolded);
  }

  const yearMatch = !!(
    yearFromQuery &&
    (vintageNameFolded.includes(yearFromQuery) ||
      wineNameFolded.includes(yearFromQuery) ||
      slugFolded.includes(yearFromQuery))
  );
  let total = tokenSum;
  if (yearFromQuery && yearMatch) total += MATCH_YEAR_BONUS;
  total += rating * MATCH_RATING_WEIGHT;
  total += Math.log1p(Math.max(0, reviewCount)) * MATCH_REVIEW_LOG_WEIGHT;

  return { total, tokenSum, yearMatch };
}

/** Pick Vivino row with highest composite match score for the shop search string. */
function pickBestFromMatches(
  matches: Array<Record<string, unknown>>,
  _searchTerm: string
): VivinoSearchResult | null {
  const { anchors, year: yearFromQuery } = anchorTokensForWineQuery(_searchTerm);
  const scoringTokens = [...new Set(anchors)];

  type Scored = {
    result: VivinoSearchResult;
    score: number;
    tokenSum: number;
    yearMatch: boolean;
  };
  const scored: Scored[] = [];

  for (const match of matches) {
    const vintage = match?.vintage as Record<string, unknown> | undefined;
    if (!vintage) continue;
    const stats = (vintage.statistics ?? {}) as Record<string, unknown>;
    const rating = (stats.ratings_average ?? 0) as number;
    const count = (stats.ratings_count ?? 0) as number;
    const wine = (vintage.wine ?? {}) as Record<string, unknown>;
    const slug = (vintage.seo_name ?? wine.seo_name ?? '') as string;
    const slugFolded = foldWineCompare(String(slug));
    const id = (wine.id ?? vintage.id ?? '') as string;
    const vivinoUrl =
      slug && id
        ? `https://www.vivino.com/${slug}/w/${id}`
        : `https://www.vivino.com/en/search/wines?q=${encodeURIComponent(_searchTerm)}`;
    const vintageName = (vintage.name ?? wine.name ?? '') as string;
    const wineOnlyName = (wine.name ?? '') as string;
    const vintageNameFolded = foldWineCompare(vintageName);
    const wineNameFolded = foldWineCompare(String(wineOnlyName));

    const { total, tokenSum, yearMatch } = vivinoRecordMatchScoreFields(
      scoringTokens,
      yearFromQuery,
      vintageNameFolded,
      wineNameFolded,
      slugFolded,
      rating,
      count
    );

    if (anchors.length > 0 && tokenSum === 0) continue;

    const result = {
      rating,
      reviewCount: count,
      vivinoUrl,
      vivinoWineName: vintageName || undefined,
    };
    scored.push({ result, score: total, tokenSum, yearMatch });
  }

  if (scored.length === 0) return null;

  scored.sort((a, b) => {
    if (Math.abs(a.score - b.score) > 1e-6) return b.score - a.score;
    if (a.yearMatch !== b.yearMatch) return (b.yearMatch ? 1 : 0) - (a.yearMatch ? 1 : 0);
    if (a.tokenSum !== b.tokenSum) return b.tokenSum - a.tokenSum;
    return b.result.rating - a.result.rating;
  });

  return scored[0].result;
}

/** Internal validation test: Chateau Mont Perat 2022 should return 3.7 */
async function runValidationTest(): Promise<{
  passed: boolean;
  wineName: string;
  expectedRating: number;
  actualRating?: number;
  url?: string;
  error?: string;
}> {
  const TEST_WINE = 'Chateau Mont Perat 2022';
  const EXPECTED_RATING = 3.7;

  await logBackground('info', `Running validation test: ${TEST_WINE}`, { expectedRating: EXPECTED_RATING });

  try {
    const result = await searchVivino(TEST_WINE);
    if (!result) {
      await logBackground('error', `Validation test failed: no result for ${TEST_WINE}`);
      return {
        passed: false,
        wineName: TEST_WINE,
        expectedRating: EXPECTED_RATING,
        error: 'No result returned from Vivino',
      };
    }

    const passed = Math.abs(result.rating - EXPECTED_RATING) < 0.01;
    if (passed) {
      await logBackground('info', `Validation test PASSED`, { rating: result.rating });
    } else {
      await logBackground('warn', `Validation test FAILED`, {
        expected: EXPECTED_RATING,
        actual: result.rating,
      });
    }

    return {
      passed,
      wineName: TEST_WINE,
      expectedRating: EXPECTED_RATING,
      actualRating: result.rating,
      url: result.vivinoUrl,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logBackground('error', `Validation test error`, { error: msg });
    return {
      passed: false,
      wineName: TEST_WINE,
      expectedRating: EXPECTED_RATING,
      error: msg,
    };
  }
}

/** Get default config with presets */
function getDefaultConfig(): ExtensionConfig {
  return { whitelist: [...DEFAULT_DOMAIN_PRESETS] };
}

/** Persist detected selectors into sync whitelist so the user does not need manual Save. */
async function mergeDetectionIntoWhitelist(m: DetectionResultMessage): Promise<void> {
  try {
    const { whitelist } = await chrome.storage.sync.get('whitelist');
    const list: DomainConfig[] = Array.isArray(whitelist) ? [...(whitelist as DomainConfig[])] : [];
    const norm = (d: string) => d.replace(/^www\./, '').toLowerCase();
    const entry: DomainConfig = {
      domain: norm(m.domain),
      containerSelector: m.containerSelector,
      nameSelector: m.nameSelector,
      ...(m.winerySelector ? { winerySelector: m.winerySelector } : {}),
    };
    const idx = list.findIndex((d) => norm(d.domain) === entry.domain);
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);
    await chrome.storage.sync.set({ whitelist: list });
    await logBackground('info', 'Whitelist saved from detection', { domain: entry.domain });
  } catch (err) {
    await logBackground('error', 'mergeDetectionIntoWhitelist failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function scheduleGithubReleaseAlarm(): void {
  chrome.alarms.get(GITHUB_UPDATE_ALARM, (existing) => {
    if (!existing) {
      chrome.alarms.create(GITHUB_UPDATE_ALARM, { periodInMinutes: GITHUB_CHECK_PERIOD_MINUTES });
    }
  });
}

/** Compare manifest version to latest GitHub release; badge + local hint when newer build exists. */
async function runGithubReleaseCheckAndBadge(): Promise<void> {
  const local = chrome.runtime.getManifest().version;
  try {
    const info = await fetchLatestRelease(DEFAULT_GITHUB_RELEASE_REPO);
    const hasUpdate = compareSemver(info.version, local) > 0;
    if (hasUpdate) {
      await chrome.storage.local.set({
        [PENDING_GITHUB_UPDATE_KEY]: {
          remoteVersion: info.version,
          zipBrowserDownloadUrl: info.zipBrowserDownloadUrl,
          releaseHtmlUrl: info.releaseHtmlUrl,
          releaseTitle: info.releaseTitle,
          checkedAt: new Date().toISOString(),
        },
      });
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#b91c1c' });
    } else {
      await chrome.storage.local.set({ [PENDING_GITHUB_UPDATE_KEY]: null });
      chrome.action.setBadgeText({ text: '' });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logBackground('warn', 'GitHub release check failed', { error: msg });
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const defaults = getDefaultConfig().whitelist;
  const { whitelist } = await chrome.storage.sync.get('whitelist');
  const existing = Array.isArray(whitelist) ? whitelist : [];

  if (details.reason === 'install') {
    if (existing.length === 0) {
      await chrome.storage.sync.set({ whitelist: defaults });
    }
  } else if (details.reason === 'update') {
    const domains = new Set(existing.map((d) => d.domain));
    const merged = [...existing];
    for (const d of defaults) {
      if (!domains.has(d.domain)) {
        merged.push(d);
        domains.add(d.domain);
      }
    }
    await chrome.storage.sync.set({ whitelist: merged });
  }

  scheduleGithubReleaseAlarm();
  await runGithubReleaseCheckAndBadge();
});

chrome.runtime.onStartup.addListener(() => {
  scheduleGithubReleaseAlarm();
  void runGithubReleaseCheckAndBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === GITHUB_UPDATE_ALARM) {
    void runGithubReleaseCheckAndBadge();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => cancelTasksForTab(tabId));

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === 'loading') {
    cancelTasksForTab(tabId);
  }
});

chrome.runtime.onMessage.addListener(
  (
    message: ExtensionMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ) => {
    if (message.type === 'LOG') {
      isLoggingEnabled().then((enabled) => {
        if (!enabled) {
          sendResponse({ ok: true });
          return;
        }
        const entry = {
          ts: new Date().toISOString(),
          level: message.level,
          source: message.source,
          message: message.message,
          data: message.data,
        };
        chrome.storage.local.get('sommelier_logs').then(({ sommelier_logs = [] }) => {
          const logs = [...(sommelier_logs as LogEntry[]), entry].slice(-500);
          chrome.storage.local.set({ sommelier_logs: logs });
        });
        sendResponse({ ok: true });
      });
      return true; // Keep channel open for async
    }
    if (message.type === 'GET_LOGS') {
      getLogs().then((logs) => sendResponse({ logs }));
      return true;
    }
    if (message.type === 'RUN_VALIDATION_TEST') {
      runValidationTest()
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ passed: false, error: String(err) }));
      return true;
    }
    if (message.type === 'OPEN_TAB') {
      chrome.tabs.create({ url: message.url });
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === 'DETECTION_RESULT') {
      void mergeDetectionIntoWhitelist(message as DetectionResultMessage);
      chrome.storage.local.set({ pendingDetection: message });
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === 'DETECTION_CANCELLED') {
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === 'SEARCH_CANCEL') {
      const tabId = sender.tab?.id;
      if (tabId) cancelTasksForTab(tabId);
      sendResponse({ ok: true });
      return false;
    }
    if (message.type !== 'SEARCH_REQUEST') return false;
    const tabId = sender.tab?.id;
    if (!tabId) {
      logBackground('error', 'SEARCH_REQUEST failed: no tab context');
      sendResponse({ ok: false, error: 'No tab context' });
      return false;
    }
    const { wineNames } = message;
    logBackground('info', 'SEARCH_REQUEST received', { tabId, wineNames, count: wineNames.length });
    wineNames.forEach((name) => queueSearch(name.trim(), tabId));
    sendResponse({ ok: true });
    return true; // Keep channel open for async
  }
);
