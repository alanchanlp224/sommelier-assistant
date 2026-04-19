/**
 * Selector detection for non-technical users.
 * Two-step click flow: 1) Click product card, 2) Click wine name.
 */

import type { DetectionResultMessage } from '../types';

/** Find the product card container - walk up to element with similar siblings */
function findProductContainer(clickedEl: HTMLElement): HTMLElement {
  let current: HTMLElement | null = clickedEl;
  while (current) {
    const parentEl: HTMLElement | null = current.parentElement;
    if (!parentEl) break;
    const currentTag = current.tagName;
    const siblings = Array.from(parentEl.children) as Element[];
    const sameTagSiblings = siblings.filter((child) => child.tagName === currentTag);
    if (sameTagSiblings.length >= 2) return current;
    current = parentEl;
  }
  return clickedEl;
}

/** Generate a CSS selector for an element (prefer classes that match siblings) */
function getSelectorForElement(el: HTMLElement, scope?: Document | Element): string {
  const root = scope ?? document.body;

  if (el.id && !el.id.match(/^[a-zA-Z_][\w-]*$/)) {
    // Skip dynamic/auto-generated IDs
  } else if (el.id) {
    const idSelector = '#' + CSS.escape(el.id);
    try {
      if (root.querySelectorAll(idSelector).length === 1) return idSelector;
    } catch {
      /* ignore */
    }
  }

  const tag = el.tagName.toLowerCase();
  const classList = typeof el.className === 'string'
    ? el.className.trim().split(/\s+/).filter((cls) => cls && !/^\d/.test(cls))
    : [];

  for (const classToken of classList) {
    const classSelector = tag + '.' + CSS.escape(classToken);
    try {
      const matches = root.querySelectorAll(classSelector);
      if (matches.length >= 1) return classSelector;
    } catch {
      /* ignore */
    }
  }

  if (classList.length > 0) {
    const fullClassSelector = tag + classList.map((cls) => '.' + CSS.escape(cls)).join('');
    try {
      if (root.querySelectorAll(fullClassSelector).length >= 1) return fullClassSelector;
    } catch {
      /* ignore */
    }
  }

  return tag;
}

/** Generate name selector that works within the container */
function getNameSelector(nameEl: HTMLElement, container: HTMLElement): string {
  const tag = nameEl.tagName.toLowerCase();
  const classList = typeof nameEl.className === 'string'
    ? nameEl.className.trim().split(/\s+/).filter((cls) => cls && !/^\d/.test(cls))
    : [];

  const selectorCandidates: string[] = [];
  if (classList.length > 0) {
    selectorCandidates.push(tag + '.' + CSS.escape(classList[0]));
    if (classList.length > 1) {
      selectorCandidates.push(tag + classList.map((cls) => '.' + CSS.escape(cls)).join(''));
    }
  }
  selectorCandidates.push(tag);

  for (const selector of selectorCandidates) {
    try {
      const found = container.querySelector(selector);
      if (found === nameEl) return selector;
    } catch {
      /* ignore */
    }
  }

  return tag;
}

function getStepText(step: 1 | 2 | 3): string {
  if (step === 1) return 'Click on any <strong>product card</strong> (the box that contains one wine).';
  if (step === 2) return 'Now click on the <strong>wine name</strong> inside that product.';
  return 'Click on the <strong>winery/producer name</strong> (optional, for better search).';
}

function createOverlay(step: 1 | 2 | 3, onCancel: () => void, onSkip?: () => void): HTMLElement {
  const stepText = getStepText(step);
  const showSkip = step === 3 && onSkip;
  const skipButtonHtml = showSkip ? '<button class="btn btn-skip">Skip</button>' : '';

  const overlay = document.createElement('div');
  overlay.id = 'sommelier-detection-overlay';
  overlay.innerHTML =
    '<style>#sommelier-detection-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.3);z-index:2147483645;display:flex;align-items:flex-start;justify-content:flex-end;padding:16px;font-family:system-ui,-apple-system,sans-serif;pointer-events:none}#sommelier-detection-box{pointer-events:auto;background:white;border-radius:12px;padding:20px;max-width:320px;box-shadow:0 20px 40px rgba(0,0,0,0.2);text-align:left}#sommelier-detection-box h3{margin:0 0 8px;font-size:16px;color:#1f2937}#sommelier-detection-box p{margin:0 0 16px;color:#6b7280;font-size:13px;line-height:1.5}#sommelier-detection-box .btn{padding:8px 16px;border-radius:8px;font-size:13px;font-weight:500;cursor:pointer;border:none}#sommelier-detection-box .btn-cancel{background:#f3f4f6;color:#6b7280}#sommelier-detection-box .btn-cancel:hover{background:#e5e7eb}#sommelier-detection-box .btn-row{display:flex;gap:8px}#sommelier-detection-box .btn-skip{background:#722f37;color:white}#sommelier-detection-box .btn-skip:hover{background:#5a252c}</style>' +
    '<div id="sommelier-detection-box"><h3>Step ' +
    String(step) +
    ' of 3</h3><p>' +
    stepText +
    '</p><div class="btn-row">' +
    skipButtonHtml +
    '<button class="btn btn-cancel">Cancel</button></div></div>';

  overlay.querySelector('.btn-cancel')!.addEventListener('click', onCancel);
  const skipBtn = overlay.querySelector('.btn-skip');
  if (skipBtn && onSkip) skipBtn.addEventListener('click', onSkip);
  return overlay;
}

function highlightElement(el: HTMLElement): void {
  el.style.outline = '3px solid #722f37';
  el.style.outlineOffset = '2px';
}

function clearHighlights(): void {
  document.querySelectorAll('[data-sommelier-highlight]').forEach((e) => {
    (e as HTMLElement).style.outline = '';
    (e as HTMLElement).style.outlineOffset = '';
    e.removeAttribute('data-sommelier-highlight');
  });
}

/** Clicks on the overlay UI must not be handled as page “product” clicks (capture runs first). */
function isSommelierOverlayClick(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : (target as Node | null)?.parentElement;
  return !!el?.closest('#sommelier-detection-overlay');
}

export function startDetection(): void {
  const cancel = () => {
    overlay.remove();
    clearHighlights();
    document.removeEventListener('click', step1Handler, true);
    chrome.runtime.sendMessage({ type: 'DETECTION_CANCELLED' });
  };

  const overlay = createOverlay(1, cancel);

  let containerEl: HTMLElement | null = null;
  let containerSelector = '';

  const step1Handler = (e: MouseEvent) => {
    if (isSommelierOverlayClick(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.target as HTMLElement;
    const container = findProductContainer(target);
    containerSelector = getSelectorForElement(container);
    const matches = document.querySelectorAll(containerSelector);
    if (matches.length < 2) {
      alert('Could not find similar product cards. Try clicking more in the center of a product.');
      return;
    }
    containerEl = container;
    clearHighlights();
    container.setAttribute('data-sommelier-highlight', '');
    highlightElement(container);

    overlay.remove();
    document.removeEventListener('click', step1Handler, true);

    const cancel2 = () => {
      overlay2.remove();
      clearHighlights();
      document.removeEventListener('click', step2Handler, true);
      chrome.runtime.sendMessage({ type: 'DETECTION_CANCELLED' });
    };

    const overlay2 = createOverlay(2, cancel2);
    document.body.appendChild(overlay2);

    const step2Handler = (e2: MouseEvent) => {
      if (isSommelierOverlayClick(e2.target)) return;
      const nameTarget = (e2.target as Node).nodeType === Node.ELEMENT_NODE
        ? (e2.target as HTMLElement)
        : (e2.target as Node).parentElement;
      if (!nameTarget || !containerEl || !containerEl.contains(nameTarget)) {
        alert('Please click on the wine name inside the highlighted product.');
        return;
      }
      e2.preventDefault();
      e2.stopPropagation();
      const nameSelector = getNameSelector(nameTarget, containerEl);
      overlay2.remove();
      clearHighlights();
      document.removeEventListener('click', step2Handler, true);

      const cancel3 = () => {
        overlay3.remove();
        clearHighlights();
        document.removeEventListener('click', step3Handler, true);
        chrome.runtime.sendMessage({ type: 'DETECTION_CANCELLED' });
      };

      const finishDetection = (winerySelector?: string) => {
        const domain = window.location.hostname.replace(/^www\./, '');
        const result: DetectionResultMessage = {
          type: 'DETECTION_RESULT',
          domain,
          containerSelector,
          nameSelector,
          ...(winerySelector && { winerySelector }),
        };
        chrome.runtime.sendMessage(result);
      };

      const overlay3 = createOverlay(3, cancel3, () => {
        overlay3.remove();
        document.removeEventListener('click', step3Handler, true);
        finishDetection();
      });
      document.body.appendChild(overlay3);

      const step3Handler = (e3: MouseEvent) => {
        if (isSommelierOverlayClick(e3.target)) return;
        const wineryTarget = (e3.target as Node).nodeType === Node.ELEMENT_NODE
          ? (e3.target as HTMLElement)
          : (e3.target as Node).parentElement;
        if (!wineryTarget || !containerEl || !containerEl.contains(wineryTarget)) {
          alert('Please click on the winery name inside the highlighted product, or click Skip.');
          return;
        }
        e3.preventDefault();
        e3.stopPropagation();
        const winerySelector = getNameSelector(wineryTarget, containerEl);
        overlay3.remove();
        document.removeEventListener('click', step3Handler, true);
        finishDetection(winerySelector);
      };

      document.addEventListener('click', step3Handler, true);
    };

    document.addEventListener('click', step2Handler, true);
  };

  document.body.appendChild(overlay);
  document.addEventListener('click', step1Handler, true);
}
