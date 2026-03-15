/**
 * Shared logger - sends logs to background for storage.
 * Content script uses sendMessage; background writes directly.
 */

import type { LogEntry } from '../types';

const MAX_LOGS = 500;
const STORAGE_KEY = 'sommelier_logs';
export const LOG_ENABLED_KEY = 'sommelier_logging_enabled';

function now(): string {
  return new Date().toISOString();
}

/** Check if logging is enabled (default: true) */
export async function isLoggingEnabled(): Promise<boolean> {
  const { [LOG_ENABLED_KEY]: enabled } = await chrome.storage.local.get(LOG_ENABLED_KEY);
  return enabled !== false;
}

/** Log from content script - sends to background */
export function logContent(
  level: LogEntry['level'],
  message: string,
  data?: unknown
): void {
  chrome.runtime.sendMessage(
    { type: 'LOG', level, source: 'content', message, data },
    () => {
      if (chrome.runtime.lastError) {
        console.warn('[Sommelier] Log failed:', chrome.runtime.lastError.message);
      }
    }
  );
}

/** Log from background - writes directly to storage (only when logging enabled) */
export async function logBackground(
  level: LogEntry['level'],
  message: string,
  data?: unknown
): Promise<void> {
  const enabled = await isLoggingEnabled();
  if (!enabled) return;
  const entry: LogEntry = { ts: now(), level, source: 'background', message, data };
  const { [STORAGE_KEY]: existing = [] } = await chrome.storage.local.get(STORAGE_KEY);
  const logs = [...(existing as LogEntry[]), entry].slice(-MAX_LOGS);
  await chrome.storage.local.set({ [STORAGE_KEY]: logs });
}

/** Get logs from storage */
export async function getLogs(): Promise<LogEntry[]> {
  const { [STORAGE_KEY]: logs = [] } = await chrome.storage.local.get(STORAGE_KEY);
  return logs as LogEntry[];
}

/** Clear logs */
export async function clearLogs(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: [] });
}
