import { useEffect, useState } from 'react';
import type { DomainConfig, DetectionResultMessage, LogEntry } from '../types';
import { LOG_ENABLED_KEY } from '../shared/logger';

const DELAY_MIN_KEY = 'sommelier_delay_min_ms';
const DELAY_MAX_KEY = 'sommelier_delay_max_ms';
const DEFAULT_MIN_DELAY = 1500;
const DEFAULT_MAX_DELAY = 3000;

const DEFAULT_PRESETS: DomainConfig[] = [
  {
    domain: 'wine.com',
    containerSelector: '.product-tile, .product-item, [data-product]',
    nameSelector: '.product-name, .product-title, .title, h2 a, h3 a',
  },
  {
    domain: 'wineview.com.hk',
    containerSelector: 'li.product, li.has-post-title',
    nameSelector: '.woocommerce-loop-product__title, h2, h3, a',
  },
  {
    domain: 'tencellars.hk',
    containerSelector: '.product-item, .product, article, [data-product]',
    nameSelector: 'h1',
    winerySelector: 'h2',
  },
];

function App() {
  const [whitelist, setWhitelist] = useState<DomainConfig[]>([]);
  const [newDomain, setNewDomain] = useState('');
  const [newContainer, setNewContainer] = useState('');
  const [newName, setNewName] = useState('');
  const [newWinery, setNewWinery] = useState('');
  const [saved, setSaved] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [logCount, setLogCount] = useState(0);
  const [loggingEnabled, setLoggingEnabled] = useState(true);
  const [testResult, setTestResult] = useState<{
    passed: boolean;
    wineName: string;
    expectedRating: number;
    actualRating?: number;
    error?: string;
  } | null>(null);
  const [delayMin, setDelayMin] = useState(DEFAULT_MIN_DELAY);
  const [delayMax, setDelayMax] = useState(DEFAULT_MAX_DELAY);

  useEffect(() => {
    chrome.storage.sync.get('whitelist', (data) => {
      const list = data.whitelist as DomainConfig[] | undefined;
      setWhitelist(Array.isArray(list) && list.length > 0 ? list : DEFAULT_PRESETS);
    });
    chrome.storage.local.get(['pendingDetection', 'sommelier_logs', LOG_ENABLED_KEY, DELAY_MIN_KEY, DELAY_MAX_KEY], (data) => {
      const logs = (data.sommelier_logs as LogEntry[] | undefined) ?? [];
      setLogCount(logs.length);
      setLoggingEnabled(data[LOG_ENABLED_KEY] !== false);
      setDelayMin(typeof data[DELAY_MIN_KEY] === 'number' ? data[DELAY_MIN_KEY] : DEFAULT_MIN_DELAY);
      setDelayMax(typeof data[DELAY_MAX_KEY] === 'number' ? data[DELAY_MAX_KEY] : DEFAULT_MAX_DELAY);
      const pending = data.pendingDetection as DetectionResultMessage | undefined;
      if (pending?.type === 'DETECTION_RESULT') {
        setNewDomain(pending.domain);
        setNewContainer(pending.containerSelector);
        setNewName(pending.nameSelector);
        setNewWinery(pending.winerySelector ?? '');
        chrome.storage.local.remove('pendingDetection');
        setDetecting(false);
      }
    });
    const onStorageChange = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string
    ) => {
      if (area === 'local') {
        if (changes.sommelier_logs) {
          const logs = (changes.sommelier_logs.newValue as LogEntry[] | undefined) ?? [];
          setLogCount(logs.length);
        }
        if (changes[LOG_ENABLED_KEY]) {
          setLoggingEnabled(changes[LOG_ENABLED_KEY].newValue !== false);
        }
        if (changes[DELAY_MIN_KEY]?.newValue !== undefined) {
          setDelayMin(changes[DELAY_MIN_KEY].newValue as number);
        }
        if (changes[DELAY_MAX_KEY]?.newValue !== undefined) {
          setDelayMax(changes[DELAY_MAX_KEY].newValue as number);
        }
      }
    };
    chrome.storage.onChanged.addListener(onStorageChange);
    return () => chrome.storage.onChanged.removeListener(onStorageChange);
  }, []);

  useEffect(() => {
    const listener = (msg: { type?: string }) => {
      if (msg?.type === 'DETECTION_RESULT') {
        const d = msg as DetectionResultMessage;
        setNewDomain(d.domain);
        setNewContainer(d.containerSelector);
        setNewName(d.nameSelector);
        setNewWinery(d.winerySelector ?? '');
        setDetecting(false);
        chrome.storage.local.set({ pendingDetection: msg });
      } else if (msg?.type === 'DETECTION_CANCELLED') {
        setDetecting(false);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const runDetection = () => {
    setDetectError(null);
    setDetecting(true);
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) {
        setDetectError('Could not find the current tab.');
        setDetecting(false);
        return;
      }
      if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('edge://') || tab.url?.startsWith('about:')) {
        setDetectError('Please open a wine shop website first, then try again.');
        setDetecting(false);
        return;
      }
      chrome.tabs.update(tab.id, { active: true });

      const trySendDetection = () => {
        chrome.tabs.sendMessage(tab.id!, { type: 'START_DETECTION' }, () => {
          if (chrome.runtime.lastError) {
            chrome.scripting.executeScript(
              { target: { tabId: tab.id! }, files: ['content.js'] },
              () => {
                if (chrome.runtime.lastError) {
                  setDetectError('Cannot run on this page. Try refreshing, then click Detect again.');
                  setDetecting(false);
                  return;
                }
                chrome.tabs.sendMessage(tab.id!, { type: 'START_DETECTION' }, () => {
                  if (chrome.runtime.lastError) {
                    setDetectError('Please refresh the page, then try again.');
                    setDetecting(false);
                  }
                });
              }
            );
          }
        });
      };
      trySendDetection();
    });
  };

  const save = () => {
    chrome.storage.sync.set({ whitelist }, () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });
  };

  const addDomain = () => {
    const domain = newDomain.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
    if (!domain || !newContainer.trim() || !newName.trim()) return;
    if (whitelist.some((d) => d.domain === domain)) return;
    const winery = newWinery.trim() || undefined;
    const updated = [
      ...whitelist,
      {
        domain,
        containerSelector: newContainer.trim(),
        nameSelector: newName.trim(),
        ...(winery && { winerySelector: winery }),
      },
    ];
    setWhitelist(updated);
    setNewDomain('');
    setNewContainer('');
    setNewName('');
    setNewWinery('');
    chrome.storage.sync.set({ whitelist: updated }, () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });
  };

  const removeDomain = (domain: string) => {
    const updated = whitelist.filter((d) => d.domain !== domain);
    setWhitelist(updated);
    chrome.storage.sync.set({ whitelist: updated });
  };

  const downloadLogs = () => {
    chrome.runtime.sendMessage({ type: 'GET_LOGS' }, (response) => {
      if (chrome.runtime.lastError || !response?.logs) return;
      const logs = response.logs as LogEntry[];
      const text = logs
        .map(
          (l) =>
            `[${l.ts}] [${l.level.toUpperCase()}] [${l.source}] ${l.message}${
              l.data ? ' ' + JSON.stringify(l.data) : ''
            }`
        )
        .join('\n');
      const blob = new Blob([text], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sommelier-logs-${new Date().toISOString().slice(0, 10)}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    });
  };

  const clearLogs = () => {
    chrome.storage.local.set({ sommelier_logs: [] });
    setLogCount(0);
  };

  const runValidationTest = () => {
    setTestResult(null);
    chrome.runtime.sendMessage({ type: 'RUN_VALIDATION_TEST' }, (response) => {
      if (chrome.runtime.lastError) {
        setTestResult({
          passed: false,
          wineName: 'Chateau Mont Perat 2022',
          expectedRating: 3.7,
          error: chrome.runtime.lastError.message,
        });
        return;
      }
      setTestResult({
        passed: response.passed,
        wineName: response.wineName,
        expectedRating: response.expectedRating,
        actualRating: response.actualRating,
        error: response.error,
      });
    });
  };

  const updateDomain = (domain: string, field: keyof DomainConfig, value: string) => {
    const updated = whitelist.map((d) => {
      if (d.domain !== domain) return d;
      const next = { ...d, [field]: value };
      if (field === 'winerySelector' && !value) delete next.winerySelector;
      return next;
    });
    setWhitelist(updated);
    chrome.storage.sync.set({ whitelist: updated });
  };

  return (
    <div className="min-h-[400px] bg-stone-50">
      <header className="bg-wine-900 text-white px-4 py-3">
        <h1 className="text-lg font-semibold">Sommelier Assistant</h1>
        <p className="text-sm text-wine-200 mt-0.5">
          Whitelist domains & configure selectors
        </p>
      </header>

      <main className="p-4 space-y-4">
        <section>
          <h2 className="text-sm font-medium text-stone-700 mb-2">
            Whitelisted Sites
          </h2>
          <div className="space-y-3">
            {whitelist.map((d) => (
              <div
                key={d.domain}
                className="bg-white rounded-lg border border-stone-200 p-3 shadow-sm"
              >
                <div className="flex items-center justify-between mb-2">
                  <input
                    type="text"
                    value={d.domain}
                    onChange={(e) => updateDomain(d.domain, 'domain', e.target.value)}
                    className="flex-1 text-sm font-medium border border-stone-200 rounded px-2 py-1.5 focus:ring-2 focus:ring-wine-500 focus:border-wine-500"
                    placeholder="domain.com"
                  />
                  <button
                    onClick={() => removeDomain(d.domain)}
                    className="ml-2 text-red-600 hover:text-red-700 text-sm font-medium"
                  >
                    Remove
                  </button>
                </div>
                <div className="space-y-2">
                  <div>
                    <label className="text-xs text-stone-500 block mb-0.5">
                      Container selector
                    </label>
                    <input
                      type="text"
                      value={d.containerSelector}
                      onChange={(e) =>
                        updateDomain(d.domain, 'containerSelector', e.target.value)
                      }
                      className="w-full text-xs font-mono border border-stone-200 rounded px-2 py-1.5 focus:ring-2 focus:ring-wine-500"
                      placeholder=".product-item"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-stone-500 block mb-0.5">
                      Name selector
                    </label>
                    <input
                      type="text"
                      value={d.nameSelector}
                      onChange={(e) =>
                        updateDomain(d.domain, 'nameSelector', e.target.value)
                      }
                      className="w-full text-xs font-mono border border-stone-200 rounded px-2 py-1.5 focus:ring-2 focus:ring-wine-500"
                      placeholder=".title"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-stone-500 block mb-0.5">
                      Winery selector (optional)
                    </label>
                    <input
                      type="text"
                      value={d.winerySelector ?? ''}
                      onChange={(e) =>
                        updateDomain(d.domain, 'winerySelector', e.target.value)
                      }
                      className="w-full text-xs font-mono border border-stone-200 rounded px-2 py-1.5 focus:ring-2 focus:ring-wine-500"
                      placeholder="h2, .producer"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="border-t border-stone-200 pt-4">
          <h2 className="text-sm font-medium text-stone-700 mb-2">
            Add new site
          </h2>
          <button
            onClick={runDetection}
            disabled={detecting}
            className="w-full py-2.5 rounded-lg font-medium transition flex items-center justify-center gap-2 bg-amber-100 text-amber-800 border border-amber-200 hover:bg-amber-200 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {detecting ? (
              <>
                <span className="inline-block w-4 h-4 border-2 border-amber-600 border-t-transparent rounded-full animate-spin" />
                Click on the page: product card, then wine name
              </>
            ) : (
              <>
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                Detect on current page
              </>
            )}
          </button>
          {detectError && (
            <p className="text-sm text-red-600 mt-1">{detectError}</p>
          )}
          <p className="text-xs text-stone-500 mt-1">
            Opens the current page and guides you to click the product card, then the wine name.
          </p>
          <div className="space-y-2 mt-3">
            <input
              type="text"
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              placeholder="Domain (e.g. wine-shop.com)"
              className="w-full text-sm border border-stone-200 rounded px-3 py-2 focus:ring-2 focus:ring-wine-500"
            />
            <input
              type="text"
              value={newContainer}
              onChange={(e) => setNewContainer(e.target.value)}
              placeholder="Container selector (e.g. .product-card)"
              className="w-full text-sm font-mono border border-stone-200 rounded px-3 py-2 focus:ring-2 focus:ring-wine-500"
            />
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Name selector (e.g. .product-title)"
              className="w-full text-sm font-mono border border-stone-200 rounded px-3 py-2 focus:ring-2 focus:ring-wine-500"
            />
            <input
              type="text"
              value={newWinery}
              onChange={(e) => setNewWinery(e.target.value)}
              placeholder="Winery selector (optional, e.g. h2)"
              className="w-full text-sm font-mono border border-stone-200 rounded px-3 py-2 focus:ring-2 focus:ring-wine-500"
            />
            <button
              onClick={addDomain}
              className="w-full bg-wine-600 text-white rounded-lg py-2 text-sm font-medium hover:bg-wine-700 transition"
            >
              Add to whitelist
            </button>
          </div>
        </section>

        <section className="border-t border-stone-200 pt-4">
          <h2 className="text-sm font-medium text-stone-700 mb-2">
            Search delay
          </h2>
          <p className="text-xs text-stone-500 mb-2">
            Wait time (ms) between Vivino searches. Helps avoid rate limiting.
          </p>
          <div className="flex gap-3 mb-2">
            <div className="flex-1">
              <label className="text-xs text-stone-500 block mb-0.5">Min (ms)</label>
              <input
                type="number"
                min={0}
                max={60000}
                value={delayMin}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (!isNaN(v) && v >= 0) {
                    setDelayMin(v);
                    chrome.storage.local.set({ [DELAY_MIN_KEY]: v });
                  }
                }}
                className="w-full text-sm font-mono border border-stone-200 rounded px-2 py-1.5"
              />
            </div>
            <div className="flex-1">
              <label className="text-xs text-stone-500 block mb-0.5">Max (ms)</label>
              <input
                type="number"
                min={0}
                max={60000}
                value={delayMax}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (!isNaN(v) && v >= 0) {
                    setDelayMax(v);
                    chrome.storage.local.set({ [DELAY_MAX_KEY]: v });
                  }
                }}
                className="w-full text-sm font-mono border border-stone-200 rounded px-2 py-1.5"
              />
            </div>
          </div>
        </section>

        <section className="border-t border-stone-200 pt-4">
          <h2 className="text-sm font-medium text-stone-700 mb-2">
            Validation test
          </h2>
          <p className="text-xs text-stone-500 mb-2">
            Searches Vivino for &quot;Chateau Mont Perat 2022&quot; and validates score is 3.7.
          </p>
          <button
            onClick={runValidationTest}
            className="w-full py-2 rounded-lg text-sm font-medium bg-stone-200 text-stone-700 hover:bg-stone-300 transition mb-2"
          >
            Run validation test
          </button>
          {testResult && (
            <div
              className={`p-2 rounded text-xs ${
                testResult.passed ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
              }`}
            >
              {testResult.passed ? (
                <>✓ PASSED: {testResult.wineName} → {testResult.actualRating} (expected {testResult.expectedRating})</>
              ) : (
                <>
                  ✗ FAILED: {testResult.wineName}
                  <br />
                  Expected {testResult.expectedRating}, got {testResult.actualRating ?? '—'}
                  {testResult.error && <> — {testResult.error}</>}
                </>
              )}
            </div>
          )}
        </section>

        <section className="border-t border-stone-200 pt-4">
          <h2 className="text-sm font-medium text-stone-700 mb-2">
            Debug logs
          </h2>
          <p className="text-xs text-stone-500 mb-2">
            Monitor scan, Vivino search, and errors. Download to debug issues.
          </p>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm text-stone-600">Logging</label>
            <button
              role="switch"
              aria-checked={loggingEnabled}
              onClick={() => {
                const next = !loggingEnabled;
                setLoggingEnabled(next);
                chrome.storage.local.set({ [LOG_ENABLED_KEY]: next });
              }}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-wine-500 focus:ring-offset-2 ${
                loggingEnabled ? 'bg-wine-600' : 'bg-stone-300'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition ${
                  loggingEnabled ? 'translate-x-5' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
          <div className="flex gap-2">
            <button
              onClick={downloadLogs}
              className="flex-1 py-2 rounded-lg text-sm font-medium bg-stone-200 text-stone-700 hover:bg-stone-300 transition"
            >
              Download logs ({logCount})
            </button>
            <button
              onClick={clearLogs}
              className="py-2 px-3 rounded-lg text-sm font-medium text-stone-600 hover:text-stone-800"
            >
              Clear
            </button>
          </div>
        </section>

        <button
          onClick={save}
          className={`w-full py-2.5 rounded-lg font-medium transition ${
            saved
              ? 'bg-green-600 text-white'
              : 'bg-wine-700 text-white hover:bg-wine-800'
          }`}
        >
          {saved ? 'Saved!' : 'Save settings'}
        </button>
      </main>
    </div>
  );
}

export default App;
