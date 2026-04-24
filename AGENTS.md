## Quartzy Connect – AI Agent Guide

This repository contains a Chrome Extension (Manifest V3) that captures product information from the active tab and syncs with Quartzy. The guidance below is for AI agents working in this codebase.

### Project Overview

- The extension is **vendor-agnostic** on the open web: product data comes from **JSON-LD / structured extraction** via `ExtractionService.js`, or from **user-highlighted text** through wand selection in `selectionMode.js`.
- A background service worker persists per-tab capture (`data_${tabId}`) and forwards updates to the side panel.
- A Quartzy app content script reads table selections and fills request forms from messages.
- The side panel stores a persistent **`requestList`** in `chrome.storage.local` (with migration from the legacy `saved_requests` key).

### Architecture & File Boundaries

- **`manifest.json`**
  - Single source of truth for permissions, matches, and script entrypoints. No site-specific content scripts; avoid unnecessary `host_permissions`.
- **`background.js`**
  - Routes `PRODUCT_CAPTURE` to tab storage and `UPDATE_SIDE_PANEL`; cleans `data_${tabId}` on tab close; re-triggers `TRIGGER_SCRAPE` on navigation complete for HTTPS pages.
- **`ExtractionService.js`**
  - JSON-LD / UCP product extraction; normalized field names: `itemName`, `catalogNumber`, `price`, `unitSize`.
- **`content.js`**
  - Merges extraction with generic DOM hints, manages wand state, sends `PRODUCT_CAPTURE` (no vendor-specific networks or injectors).
- **`selectionMode.js`**
  - In-page text selection for wand capture.
- **`quartzy_script.js`**
  - `GET_QUARTZY_SELECTION`, `POPULATE_QUARTZY_REQUEST`, and form helpers for Ember inputs.
- **`sidepanel.html` / `sidepanel.js`**
  - Current capture UI, quantity for new lines, and the **Request list** section; no scraping logic.

### Messaging & Data Flow

- Use explicit `type` strings, for example: `PRODUCT_CAPTURE`, `UPDATE_SIDE_PANEL`, `WAND_START`, `TRIGGER_SCRAPE`, `GET_QUARTZY_SELECTION`, `POPULATE_QUARTZY_REQUEST`, `QUARTZY_SELECTION_UPDATED`.
- Store tab data under `data_${tabId}`. The saved multi-line list uses **`requestList`**.

### Coding Style & Language

- Modern JavaScript (ES6+), `const`/`let`, `===` where appropriate.
- Double quotes in JSON; semicolons in JS consistent with existing files.
- Log prefix: `[Quartzy Bridge]` in content/Quartzy scripts; `[Quartzy Connect]` is acceptable in the service worker for extension-specific messages.

### Testing (manual)

- On a product page with JSON-LD, confirm the side panel fills; use wands where fields are empty.
- Add a line with quantity and confirm it appears under Request list in storage.
- On Quartzy, spot-check `GET_QUARTZY_SELECTION` and `POPULATE_QUARTZY_REQUEST` if you touch `quartzy_script.js`.
