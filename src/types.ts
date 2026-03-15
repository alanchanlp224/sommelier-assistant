/**
 * Configuration for a whitelisted wine e-commerce domain.
 * Each site has different HTML structure, so we store selectors.
 */
export interface DomainConfig {
  /** Domain without protocol (e.g., "wine.com", "generic-wine-shop.com") */
  domain: string;
  /** CSS selector for the product card container */
  containerSelector: string;
  /** CSS selector for the wine name inside the product card */
  nameSelector: string;
  /** Optional: CSS selector for winery/producer name. When set, search uses "winery + wine name" */
  winerySelector?: string;
}

/** Stored configuration - whitelist of domains with their selectors */
export interface ExtensionConfig {
  whitelist: DomainConfig[];
}

/** Message sent from Content Script to Background - request Vivino search */
export interface SearchRequestMessage {
  type: 'SEARCH_REQUEST';
  wineNames: string[];
}

/** Message sent from Content Script to Background - cancel search for current tab */
export interface SearchCancelMessage {
  type: 'SEARCH_CANCEL';
}

/** Message sent from Background to Content Script - Vivino result for one wine */
export interface SearchResultMessage {
  type: 'SEARCH_RESULT';
  wineName: string;
  rating: number;
  reviewCount: number;
  vivinoUrl: string;
  vivinoWineName?: string;
  tabId: number;
}

/** Message sent when search fails for a wine */
export interface SearchErrorMessage {
  type: 'SEARCH_ERROR';
  wineName: string;
  error: string;
  tabId: number;
}

/** Message to open a URL in a new tab */
export interface OpenTabMessage {
  type: 'OPEN_TAB';
  url: string;
}

/** Message from Popup to Content Script - start selector detection */
export interface StartDetectionMessage {
  type: 'START_DETECTION';
}

/** Message from Content Script - detection complete with selectors */
export interface DetectionResultMessage {
  type: 'DETECTION_RESULT';
  domain: string;
  containerSelector: string;
  nameSelector: string;
  winerySelector?: string;
}

/** Message from Content Script - user cancelled detection */
export interface DetectionCancelledMessage {
  type: 'DETECTION_CANCELLED';
}

/** Union type for all extension messages */
export type ExtensionMessage =
  | SearchRequestMessage
  | SearchCancelMessage
  | SearchResultMessage
  | SearchErrorMessage
  | OpenTabMessage
  | StartDetectionMessage
  | DetectionResultMessage
  | DetectionCancelledMessage
  | LogMessage
  | GetLogsMessage
  | RunValidationTestMessage;

/** Vivino search result parsed from HTML */
export interface VivinoSearchResult {
  rating: number;
  reviewCount: number;
  vivinoUrl: string;
  /** Resolved wine name from Vivino (may differ from search term) */
  vivinoWineName?: string;
}

/** Log entry for debugging */
export interface LogEntry {
  ts: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  source: 'content' | 'background' | 'popup';
  message: string;
  data?: unknown;
}

/** Message to add a log entry */
export interface LogMessage {
  type: 'LOG';
  level: LogEntry['level'];
  source: LogEntry['source'];
  message: string;
  data?: unknown;
}

/** Message to get logs */
export interface GetLogsMessage {
  type: 'GET_LOGS';
}

/** Message to run internal validation test */
export interface RunValidationTestMessage {
  type: 'RUN_VALIDATION_TEST';
}
