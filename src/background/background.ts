/**
 * Sommelier Assistant - Background Service Worker
 * Handles: Task queue with rate limiting, Vivino fetch & parse
 */

import type {
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

const VIVINO_SEARCH_BASE = 'https://www.vivino.com/en/search/wines?q=';
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

async function searchVivino(wineName: string): Promise<VivinoSearchResult | null> {
  const cleanName = normalizeWineSearchQuery(wineName);
  const htmlUrl = `${VIVINO_SEARCH_BASE}${encodeURIComponent(cleanName)}`;
  await logBackground('info', `Searching Vivino for`, { wineName: cleanName });

  let response: Response;
  try {
    response = await fetch(htmlUrl, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: 'https://www.vivino.com/',
      },
      redirect: 'follow',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logBackground('error', `Vivino fetch failed`, { error: msg, url: htmlUrl });
    throw err;
  }

  await logBackground('info', `Vivino HTML response`, {
    status: response.status,
    ok: response.ok,
    url: response.url,
  });

  if (response.status === 404) return null;
  if (response.status === 429) {
    throw new Error('Too many requests. Please wait a moment and try again.');
  }
  if (!response.ok) {
    await logBackground('error', `Vivino HTTP error`, { status: response.status });
    throw new Error(`Vivino returned ${response.status}`);
  }

  const html = await response.text();
  await logBackground('debug', `Vivino HTML received`, {
    htmlLength: html.length,
    hasPreloaded: html.includes('__PRELOADED_STATE__'),
    hasNextData: html.includes('__NEXT_DATA__'),
  });

  const result = parseVivinoSearchHtml(html, cleanName);
  if (!result) {
    await logBackground('warn', `Vivino parse failed`, {
      htmlLength: html.length,
      htmlPreview: html.slice(0, 300),
    });
  }
  return result;
}

/**
 * Unescape HTML entities in a string.
 */
function unescapeHtml(str: string): string {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'");
}

/** Raw attribute value for data-preloaded-state (HTML-escaped JSON; inner quotes are &quot;). */
function extractDataPreloadedStateRaw(html: string): string | null {
  const lower = html.toLowerCase();
  const needle = 'data-preloaded-state="';
  const start = lower.indexOf(needle);
  if (start === -1) return null;
  const from = start + needle.length;
  const end = html.indexOf('"', from);
  if (end === -1) return null;
  return html.slice(from, end);
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
  for (const v of Object.values(o)) {
    const found = findSearchMatchesArray(v, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Pick best wine from Vivino search `matches` for the given search term. */
function pickBestFromMatches(
  matches: Array<Record<string, unknown>>,
  _searchTerm: string
): VivinoSearchResult | null {
  const searchWords = _searchTerm.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  let bestRated: VivinoSearchResult | null = null;
  let bestRatedScore = -1;
  let bestByName: VivinoSearchResult | null = null;
  let bestByNameScore = -1;
  for (const match of matches) {
    const vintage = match?.vintage as Record<string, unknown> | undefined;
    if (!vintage) continue;
    const stats = (vintage.statistics ?? {}) as Record<string, unknown>;
    const rating = (stats.ratings_average ?? 0) as number;
    const count = (stats.ratings_count ?? 0) as number;
    const wine = (vintage.wine ?? {}) as Record<string, unknown>;
    const slug = (vintage.seo_name ?? wine.seo_name ?? '') as string;
    const id = (wine.id ?? vintage.id ?? '') as string;
    const vivinoUrl =
      slug && id
        ? `https://www.vivino.com/${slug}/w/${id}`
        : `https://www.vivino.com/en/search/wines?q=${encodeURIComponent(_searchTerm)}`;
    const name = (vintage.name ?? wine.name ?? '') as string;
    const nameLower = name.toLowerCase();
    const matchCount = searchWords.filter((w) => nameLower.includes(w)).length;
    const score = searchWords.length > 0 ? matchCount / searchWords.length : 1;
    const result = { rating, reviewCount: count, vivinoUrl, vivinoWineName: name || undefined };
    if (rating > 0 && score > bestRatedScore) {
      bestRatedScore = score;
      bestRated = result;
      if (score >= 0.5) return bestRated;
    }
    if (score > bestByNameScore) {
      bestByNameScore = score;
      bestByName = result;
    }
  }
  if (bestRated) return bestRated;
  if (bestByName && bestByNameScore >= 0.5) return bestByName;
  return null;
}

/**
 * Parse Vivino search page HTML for first wine result.
 * Tries: data-preloaded-state, application/json scripts, __PRELOADED_STATE__, __NEXT_DATA__, regex.
 */
function parseVivinoSearchHtml(html: string, _searchTerm: string): VivinoSearchResult | null {
  // 0a. data-preloaded-state (escaped JSON; avoid fragile [^"]+ if a raw quote slips in)
  const rawPreloaded = extractDataPreloadedStateRaw(html);
  if (rawPreloaded) {
    try {
      const jsonStr = unescapeHtml(rawPreloaded);
      const data = JSON.parse(jsonStr) as Record<string, unknown>;
      const searchResults = (data?.search_results ?? data?.searchResults) as
        | Record<string, unknown>
        | undefined;
      const matches = searchResults?.matches as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(matches) && matches.length > 0) {
        const picked = pickBestFromMatches(matches, _searchTerm);
        if (picked) return picked;
      }
    } catch {
      /* fall through */
    }
  }

  // 0b. Large application/json blocks (e.g. locale-specific / explore pages without data-preloaded-state)
  const jsonScriptRe = /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let scriptMatch: RegExpExecArray | null;
  while ((scriptMatch = jsonScriptRe.exec(html)) !== null) {
    const body = scriptMatch[1].trim();
    if (body.length < 500 || !body.includes('"matches"')) continue;
    try {
      const data = JSON.parse(body) as unknown;
      const matches = findSearchMatchesArray(data);
      if (matches && matches.length > 0) {
        const picked = pickBestFromMatches(matches, _searchTerm);
        if (picked) return picked;
      }
    } catch {
      /* next script */
    }
  }

  const extractFromRecords = (records: unknown[]): VivinoSearchResult | null => {
    const first = records[0] as Record<string, unknown> | undefined;
    if (!first?.vintage) return null;
    const v = first.vintage as Record<string, unknown>;
    const wine = v.wine as Record<string, unknown> | undefined;
    if (!wine) return null;
    const stats = (v.statistics ?? (v.aggregate as Record<string, unknown>)?.statistics ?? {}) as Record<string, unknown>;
    const rating = (stats.ratings_average ?? stats.rating ?? 0) as number;
    const count = (stats.ratings_count ?? stats.num_reviews ?? 0) as number;
    const slug = (wine.slug ?? wine.seo_name ?? '') as string;
    const id = (wine.id ?? v.id ?? '') as string;
    const vivinoUrl = slug
      ? `https://www.vivino.com/${slug}/w/${id}`
      : `https://www.vivino.com/en/search/wines?q=${encodeURIComponent(_searchTerm)}`;
    const vivinoWineName = (v.name ?? wine.name ?? '') as string;
    return rating > 0 ? { rating, reviewCount: count, vivinoUrl, vivinoWineName: vivinoWineName || undefined } : null;
  };

  // 1. Try __PRELOADED_STATE__
  const preloadedMatch = html.match(
    /window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\});?\s*(?:<\/script>|$)/m
  );
  if (preloadedMatch) {
    try {
      const data = JSON.parse(preloadedMatch[1]);
      const records =
        data?.explore_vintage?.records ??
        data?.records ??
        data?.explore?.records ??
        [];
      const arr = Array.isArray(records) ? records : [];
      if (arr.length > 0) {
        const r = extractFromRecords(arr);
        if (r) return r;
      }
    } catch {
      /* fall through */
    }
  }

  // 2. Try __NEXT_DATA__
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (nextDataMatch) {
    try {
      const data = JSON.parse(nextDataMatch[1]);
      const props = data?.props?.pageProps ?? data?.props ?? {};
      const records =
        props?.explore_vintage?.records ?? props?.records ?? props?.explore?.records ?? [];
      const arr = Array.isArray(records) ? records : [];
      if (arr.length > 0) {
        const r = extractFromRecords(arr);
        if (r) return r;
      }
    } catch {
      /* fall through */
    }
  }

  // 3. Regex fallback: look for rating pattern and first wine link
  const ratingMatch = html.match(
    /(?:rating|ratings_average|"average"[:\s]*)(?:["'])?(\d\.\d)(?:["'])?/i
  );
  const linkMatch = html.match(/href="(\/[\w-]+\/w\/\d+[^"]*)"/);
  const rating = ratingMatch ? parseFloat(ratingMatch[1]) : 0;
  const vivinoUrl = linkMatch
    ? `https://www.vivino.com${linkMatch[1].replace(/&amp;/g, '&')}`
    : `https://www.vivino.com/en/search/wines?q=${encodeURIComponent(_searchTerm)}`;

  const reviewMatch = html.match(/(?:ratings_count|num_reviews|"count"[:\s]*)(?:["'])?(\d+)/i);
  const reviewCount = reviewMatch ? parseInt(reviewMatch[1], 10) : 0;

  if (rating > 0 && rating <= 5) {
    return { rating, reviewCount, vivinoUrl };
  }

  return null;
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
