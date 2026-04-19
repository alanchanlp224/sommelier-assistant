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
];
