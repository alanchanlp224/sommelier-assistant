# Sommelier Assistant

A Chrome Extension (Manifest V3) that adds Vivino ratings to wine products on e-commerce websites.

## Features

- **Domain whitelist**: Add/remove sites and configure CSS selectors per domain
- **Floating trigger**: Click the wine glass icon to scan the page
- **Rate-limited search**: One Vivino request every 1.5–3 seconds to avoid bans
- **Color-coded badges**: Green (>4.0), Yellow (3.5–3.9), Red (<3.5)
- **Shadow DOM badges**: Isolated styling that won't break site CSS

## Setup

```bash
npm install
npm run build
```

## Load in Chrome

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `dist` folder

## Package for distribution

To create a shareable zip for others to install:

```bash
npm run package
```

This produces `sommelier-assistant.zip` in the project root. Recipients can:

1. Unzip the file
2. Open `chrome://extensions`
3. Enable "Developer mode"
4. Click "Load unpacked"
5. Select the unzipped folder

## Usage

1. Add your wine shop domain in the extension popup (click the puzzle icon → Sommelier Assistant)
2. Configure **container selector** (e.g. `.product-card`) and **name selector** (e.g. `.title`)
3. Visit the whitelisted site
4. Click the floating wine glass icon in the bottom-right
5. Vivino ratings appear next to each wine as they load

## Default presets

- **wineview.com.hk**: `li.product, li.has-post-title` / `.woocommerce-loop-product__title, h2, h3, a`
- **tencellars.hk**: `.product-item, .product, article, [data-product]` / `h1` (winery: `h2`)

## Tech stack

- Vite + React + TypeScript
- Tailwind CSS
- Chrome Manifest V3 (service worker, content scripts)
