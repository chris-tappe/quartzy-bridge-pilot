## Quartzy Bridge Pilot – AI Agent Guide

This repository contains a Chrome Extension (Manifest V3) that bridges Quartzy with vendor product pages. The guidance below is for AI agents working in this codebase so behavior stays consistent and aligned with how the extension is designed.

### Project Overview

- This repository contains a Chrome Extension (Manifest V3) that bridges Quartzy with vendor product pages (Fisher, VWR/Avantor).
- Content scripts run on vendor domains to scrape or fetch product metadata (price, unit size, description, URL, vendor name).
- A background service worker coordinates storage, tab-level state, and side panel updates.
- A Quartzy-side content script reads or writes request data into Quartzy forms.

### Architecture & File Boundaries

- **`manifest.json`**
  - Treat as the single source of truth for permissions, host patterns, and script entrypoints.
  - When adding new domains or scripts, update `host_permissions`, `content_scripts`, `background`, and `web_accessible_resources` intentionally; avoid broad wildcards beyond what the extension needs.
- **`background.js`**
  - Keep it focused on routing messages, persisting tab-scoped data (`data_${tabId}`), badge updates, and SPA navigation handling.
  - Avoid heavy DOM logic or vendor-specific parsing here; push that to content scripts.
- **`content.js` and vendor scripts** (`fisher_script.js`, `vwr_script.js`, `vwr_interceptor.js`)
  - Own DOM scraping and network interception for vendor product pages.
  - Normalize scraped data into a consistent shape before sending to the background or side panel.
- **`quartzy_script.js`**
  - Owns reading selected items from Quartzy and populating Quartzy forms based on messages.
  - Use helpers that work with framework-controlled inputs (e.g., call the native `value` setter then dispatch `input`/`change` events).
- **`sidepanel.html` / `sidepanel.js`**
  - Own rendering and UX of the Quartzy Bridge side panel; keep it free of low-level scraping logic.

### Messaging & Data Flow Conventions

- Use `chrome.runtime.sendMessage` / `chrome.runtime.onMessage` with **explicit `type` strings** that are namespaced and self-descriptive, for example:
  - `FISHER_DATA_FOUND`, `UPDATE_SIDE_PANEL`, `GET_QUARTZY_SELECTION`, `POPULATE_QUARTZY_REQUEST`.
- When adding new message types:
  - Document the payload shape in comments near both sender and receiver.
  - Keep each message type focused on a single responsibility.
  - Prefer one-way messages plus state in `chrome.storage.local` over complex request/response protocols.
- Store tab-specific data in keys of the form `data_${tabId}` and **always clean up** on `chrome.tabs.onRemoved`.

### DOM Scraping & Selector Strategy

- Prefer **robust selectors** over brittle ones:
  - Use semantic classes, `aria-*` attributes, and labels before deep, layout-dependent selectors.
  - When targeting Ember/React/Vue-controlled inputs or dropdowns, use the same patterns as existing helpers (e.g., Ember power-select search input, `aria-label` lookups).
- When scraping unit size or similar metadata (see `extractUnitSize` patterns):
  - Check the most specific/obvious elements first (selected buttons or UOM in the buy box).
  - Fall back through multiple selectors to handle legacy layouts.
  - Provide a reasonable default (like `"Each"`) instead of failing when scraping fails.
- For new scraping logic, prefer **short polling windows or event-driven triggers** over expensive, long-running intervals to limit performance impact.

### Coding Style & Language

- Use **modern JavaScript** (ES6+) with `const`/`let` and strict equality (`===`).
- Follow the existing style conventions in this repo:
  - Include semicolons at statement ends.
  - Use double quotes in JSON / manifest and be consistent within files.
  - Keep top-level functions small and focused; extract helpers instead of inlining large blocks into listeners.
- When interacting with Chrome APIs:
  - Prefer the `chrome.*` namespace used throughout this project.
  - Always handle error branches on async operations (e.g., check `response.ok`, wrap `chrome.tabs.sendMessage` in `try/catch` or `.catch`).

### Logging & Observability

- Prefix logs consistently to distinguish contexts:
  - Use `[Quartzy Bridge]` for content / Quartzy-side scripts.
  - Use `[Background]` for background service worker logs.
- Log key state transitions and one-time errors:
  - Example: when vendor data is scraped, when a Quartzy form is populated, when navigation triggers a re-scrape.
  - Avoid noisy per-frame or per-keystroke logging that can flood the console.
- Do not log sensitive user data beyond what is necessary to debug (avoid full payload dumps if they might include PII).

### External APIs & Network Interception

- When calling vendor APIs (e.g., Fisher pricing services):
  - Log the catalog number and high-level outcome, not full raw responses when avoidable.
  - Be resilient to response shape changes (e.g., value may be nested under `priceAndAvailability`).
  - Guard against missing fields so that a failed fetch falls back to DOM scraping instead of breaking the flow.
- For injected interceptors like `vwr_interceptor.js`:
  - Keep them minimal and focused on capturing just the data needed, then posting it back via `window.postMessage` to the content script.

### Testing & Manual Verification

- For any change to scraping, network calls, or message types, include a brief manual test plan in the PR or commit message, for example:
  - Open a Fisher product page, verify scrape/log output, and confirm the side panel shows updated price and unit size.
  - Open a VWR/Avantor product page, ensure the interceptor fires and data flows into the side panel.
  - From Quartzy, verify that `GET_QUARTZY_SELECTION` and `POPULATE_QUARTZY_REQUEST` still work as expected.

