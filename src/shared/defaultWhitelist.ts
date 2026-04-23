/**
 * Built-in wine shop presets shipped with the extension (single source of truth).
 * Merged into user storage on install and when the extension updates.
 */
import type { DomainConfig } from '../types';

export const DEFAULT_DOMAIN_PRESETS: DomainConfig[] = [
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
  {
    domain: 'watsonswine.com',
    containerSelector:
      'div.items:has(a[href*="/p/"]), div[class*="product"]:has(a[href*="/p/"]), div.items',
    nameSelector: 'a[href*="/p/"], a[href*="/product/"], h2, h3, a',
  },
  {
    domain: 'remfly.com.hk',
    /** Keep in sync with REMFLY_BUILTIN in remflyEffectiveConfig.ts (content script cannot import this file). */
    containerSelector: 'div.product-cardcontainer',
    nameSelector:
      'p.montserrat.rem-text-16.text-remdark.list-none, p.montserrat.rem-text-16.text-remdark.grid-none, p.montserrat.rem-text-16.text-remdark',
  },
];
