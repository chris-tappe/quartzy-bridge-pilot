"use strict";

const REQUEST_LIST_KEY = "requestList";
const LEGACY_LIST_KEY = "saved_requests";

const emptyState = document.getElementById("emptyState");
const dataState = document.getElementById("dataState");
const addToList = document.getElementById("addToList");
const toastEl = document.getElementById("toast");
const lineQuantityEl = document.getElementById("lineQuantity");
const requestListEl = document.getElementById("requestList");
const requestListEmpty = document.getElementById("requestListEmpty");
const requestListBody = document.getElementById("requestListBody");
const requestListToggle = document.getElementById("requestListToggle");
const headerCaptureLive = document.getElementById("headerCaptureLive");
const cancelAddEl = document.getElementById("cancelAdd");
const addSuccessWrap = document.getElementById("addSuccessWrap");
const FIELDS = ["itemName", "catalogNumber", "price", "unitSize"];
const REQUEST_LIST_UI_KEY = "quartzyConnect.requestListExpanded";

const valueEls = {
  itemName: document.getElementById("vItemName"),
  catalogNumber: document.getElementById("vCatalog"),
  price: document.getElementById("vPrice"),
  unitSize: document.getElementById("vUnit")
};

const FIELD_ORDER = FIELDS.slice();
const mappingModeBar = document.getElementById("mappingModeBar");
const mappingModeToggle = document.getElementById("mappingModeToggle");
const mappingModeHint = document.getElementById("mappingModeHint");

let mappingMode = false;
let mappingField = null;
let mappingTabId = null;

const panelForm = document.getElementById("panelForm");
const viewRequest = document.getElementById("viewRequest");
const viewDebug = document.getElementById("viewDebug");
const tabNewRequest = document.getElementById("tabNewRequest");
const tabDebug = document.getElementById("tabDebug");
const debugContext = document.getElementById("debugContext");
const debugFieldsEl = document.getElementById("debugFields");

const FIELD_DEBUG_LABELS = {
  itemName: "Item name",
  catalogNumber: "Catalog #",
  price: "Price",
  unitSize: "Unit size"
};

/**
 * @param {object|null|undefined} ex
 * @returns {string}
 */
function describeWandExtractRule(ex) {
  if (!ex || !ex.type) {
    return "— (legacy: full node text on re-capture; re-wand to add a rule)";
  }
  if (ex.type === "entire") {
    return "Full anchor element (your highlight matched the whole block).";
  }
  if (ex.type === "toFirstDelimiter" && (ex.delimiter === "," || ex.delimiter === ";")) {
    return "Text from the start of the block up to the first " + (ex.delimiter === ";" ? "semicolon" : "comma") + " (e.g. pack / size line).";
  }
  if (ex.type === "slice") {
    return "Character range " + (ex.start != null ? ex.start : "—") + "–" + (ex.end != null ? ex.end : "end") + " in the saved node’s text (stable if the line doesn’t change).";
  }
  if (ex.type === "literal") {
    return "Exact highlight; re-applied if the same text still appears in the node.";
  }
  return String(ex.type);
}

let activePanelView = "request";

/**
 * @param {string|null|undefined} raw
 * @returns {{ label: string, body: string }}
 */
function humanizeFieldSourceKey(raw) {
  const t = raw == null || String(raw).trim() === "" ? null : String(raw).trim();
  if (!t) {
    return {
      label: "Unspecified (not a single code path)",
      body:
        "The extension did not tag this field. The value can still come from a merge of JSON-LD, page heading, or generic unit patterns without a specific token."
    };
  }
  if (t === "magic-wand") {
    return {
      label: "User highlight (magic wand)",
      body: "You just selected this text on the product page. It overrides the automated value for the current session and is also saved to localStorage as a per-site DOM target when a selector could be built."
    };
  }
  if (t === "table-row") {
    return {
      label: "Table row (your selection)",
      body:
        "A product variant was inferred from the table row you clicked. Edit any field in the side panel before adding to your list if needed."
    };
  }
  if (t === "variant-dom") {
    return {
      label: "Visible variant (radio or row)",
      body: "Price or unit was read from the page near the selected option (e.g. checked radio) so the capture matches the variant you chose, not only static JSON-LD."
    };
  }
  if (t === "dom-hint") {
    return {
      label: "Saved DOM (localStorage)",
      body:
        "A CSS path saved from a past wand for this site was used to re-read this field (see stored selector on this field below). Overrides JSON-LD for that field; optional on-page AI is not used in the default build."
    };
  }
  if (t === "ai-fallback") {
    return {
      label: "AI (page text) — when enabled in content",
      body:
        "The content script can call an on-page AI path (on-device or proxy) from a minimized product region. This is off by default (USE_AI_EXTRACTION in content.js). When off, you should not see this source for new captures."
    };
  }
  if (t === "ucp-well-known") {
    return { label: "UCP: .well-known/ucp", body: "Product hints from the site’s ucp well-known JSON when present." };
  }
  if (t.indexOf("json-ld:") === 0) {
    return { label: "JSON-LD", body: "Structured data path: " + t };
  }
  if (t.indexOf("ucp:") === 0) {
    return { label: "UCP meta", body: "Microformat / ucp: meta tag: " + t };
  }
  return { label: t, body: "Internal field source key from the content script or extractor." };
}

function formatDebugTimestamp(ts) {
  if (ts == null) return "—";
  const n = Number(ts);
  if (Number.isNaN(n)) return "—";
  try {
    return new Date(n).toLocaleString();
  } catch (e) {
    return "—";
  }
}

/**
 * @param {object|null} data
 * @param {chrome.tabs.Tab|null} tab
 */
function updateDebugView(data, tab) {
  if (!debugContext || !debugFieldsEl) return;
  if (!data || (tab && isQuartzyDomainUrl(tab.url))) {
    debugContext.textContent = "No debug data for this context (e.g. Quartzy app tab, or no capture).";
    debugFieldsEl.textContent = "";
    return;
  }
  if (!isMappableContentUrl((data && data.url) || (tab && tab.url))) {
    debugContext.textContent = "This tab is not a normal product page, so the extension does not attach capture provenance here.";
    debugFieldsEl.textContent = "";
    return;
  }
  const loading = data.isLoading === true;
  const v = (data && data.vendor) || "—";
  const u = (data && data.url) || "—";
  const phase = (data && data.capturePhase) || "—";
  const lines = [
    "Vendor (hostname): " + v,
    "URL: " + u,
    "Status: " + (loading ? "LOADING" : "DONE") + " · phase: " + phase
  ];
  debugContext.textContent = lines.join("\n");
  debugFieldsEl.textContent = "";

  FIELDS.forEach((f) => {
    const block = document.createElement("div");
    block.className = "debug-section";
    const title = document.createElement("div");
    title.className = "debug-kicker";
    title.textContent = (FIELD_DEBUG_LABELS[f] || f).toUpperCase();
    const val = isFilled(data, f) ? String(data[f]) : "— (empty)";
    const p1 = document.createElement("p");
    p1.className = "debug-p";
    p1.textContent = "Current value: " + val;
    const rawSrc = data.fieldSources && data.fieldSources[f] != null ? data.fieldSources[f] : null;
    const h = humanizeFieldSourceKey(rawSrc);
    const p2 = document.createElement("p");
    p2.className = "debug-p";
    p2.appendChild(document.createTextNode("Final source: " + h.label + ". "));
    const s = document.createElement("span");
    s.className = "debug-code";
    s.style.display = "inline";
    s.style.padding = "2px 4px";
    s.style.marginTop = "0";
    s.textContent = "Key: " + (rawSrc == null || rawSrc === "" ? "(null/empty)" : String(rawSrc));
    p2.appendChild(s);
    const p2b = document.createElement("p");
    p2b.className = "debug-p";
    p2b.textContent = h.body;
    const p3 = document.createElement("p");
    p3.className = "debug-p";
    p3.textContent =
      "First merge (H1, JSON-LD, generic unit), before per-site saved DOM and session wand: " +
      (data.heuristicProvenance && data.heuristicProvenance[f] != null ? String(data.heuristicProvenance[f]) : "—");
    const aiN = data.aiRefined && data.aiRefined[f] === true;
    const p4 = document.createElement("p");
    p4.className = "debug-p";
    p4.textContent =
      "aiRefined for this field (only if on-page AI is enabled in the content script): " +
      (aiN ? "yes" : "no");
    block.appendChild(title);
    block.appendChild(p1);
    block.appendChild(p2);
    block.appendChild(p2b);
    block.appendChild(p3);
    block.appendChild(p4);
    const hint = data.domHintSelectors && data.domHintSelectors[f];
    if (hint && hint.selector) {
      const p5 = document.createElement("p");
      p5.className = "debug-p";
      p5.appendChild(document.createTextNode("Stored per-site CSS selector (localStorage on this origin): "));
      const code = document.createElement("span");
      code.className = "debug-code";
      code.textContent = hint.selector;
      p5.appendChild(code);
      const p5b = document.createElement("p");
      p5b.className = "debug-p";
      p5b.textContent = "Last saved sample: " + (hint.valueSample || "—") + " · saved: " + formatDebugTimestamp(hint.updatedAt);
      block.appendChild(p5);
      block.appendChild(p5b);
      if (hint.extract) {
        const p5c = document.createElement("p");
        p5c.className = "debug-p";
        p5c.textContent = "Wand re-capture: " + describeWandExtractRule(hint.extract);
        block.appendChild(p5c);
      }
    } else {
      const p5 = document.createElement("p");
      p5.className = "debug-p";
      p5.textContent = "No stored per-site CSS selector in localStorage for this field (wand again to build one).";
      block.appendChild(p5);
    }
    debugFieldsEl.appendChild(block);
  });
}

function setPanelView(view) {
  if (view !== "request" && view !== "debug") return;
  activePanelView = view;
  const isReq = view === "request";
  if (viewRequest) viewRequest.hidden = !isReq;
  if (viewDebug) viewDebug.hidden = isReq;
  if (tabNewRequest) {
    tabNewRequest.classList.toggle("is-active", isReq);
    tabNewRequest.setAttribute("aria-selected", isReq ? "true" : "false");
  }
  if (tabDebug) {
    tabDebug.classList.toggle("is-active", !isReq);
    tabDebug.setAttribute("aria-selected", isReq ? "false" : "true");
  }
  getActiveTabKey((tabId, tab) => {
    if (tabId == null) {
      if (!isReq) {
        if (debugContext) {
          debugContext.textContent = "No active tab.";
        }
        if (debugFieldsEl) debugFieldsEl.textContent = "";
      }
      return;
    }
    const key = "data_" + tabId;
    chrome.storage.local.get([key], (result) => {
      if (isReq) return;
      const d = result[key];
      if (d) {
        updateDebugView(d, tab);
      } else {
        if (debugContext) {
          debugContext.textContent = "No capture data. Focus a product tab and wait for capture.";
        }
        if (debugFieldsEl) {
          debugFieldsEl.textContent = "";
        }
      }
    });
  });
}

function isQuartzyDomainUrl(url) {
  if (!url) return false;
  try {
    const h = new URL(String(url).trim()).hostname.toLowerCase();
    if (h === "quartzy.com" || h.endsWith(".quartzy.com")) {
      return true;
    }
  } catch (e) {
    /* ignore */
  }
  return false;
}

function isFilled(data, key) {
  return data && data[key] != null && String(data[key]).trim().length > 0;
}

function isNonEmptyTrim(s) {
  return typeof s === "string" && s.trim().length > 0;
}

function getPanelFieldValue(field) {
  const el = valueEls[field];
  if (!el) return "";
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
    return String(el.value != null ? el.value : "").trim();
  }
  return String(el.textContent || "").trim();
}

function setPanelFieldValueFromData(field, data) {
  const el = valueEls[field];
  if (!el) return;
  const v = data && data[field] != null ? String(data[field]) : "";
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
    el.value = v;
  } else {
    el.textContent = v || "—";
  }
}

function canAddToList(data) {
  if (!data) return false;
  if (data.isLoading === true) return false;
  return FIELDS.every((k) => isNonEmptyTrim(getPanelFieldValue(k)));
}

/** Wands work on any normal web page the extension can read (https/http in the user’s tab). */
function isMappableContentUrl(url) {
  if (!url || typeof url !== "string") return false;
  return /^https?:\/\//i.test(url) && !/^https?:\/\/(chrome\.)?google\./i.test(url);
}

let toastTimer = null;
let addSuccessTimer = null;

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove("show");
  }, 3000);
}

function showAddSuccessPill() {
  if (!addSuccessWrap) return;
  addSuccessWrap.hidden = false;
  if (addSuccessTimer) clearTimeout(addSuccessTimer);
  addSuccessTimer = setTimeout(() => {
    addSuccessWrap.hidden = true;
    addSuccessTimer = null;
  }, 3500);
}

function isWandContextOk(data, tab) {
  return isMappableContentUrl((tab && tab.url) || (data && data.url));
}

function updateRowBadges(data, tab) {
  const loading = data && data.isLoading === true;
  const sidePanelHasFocus = typeof document.hasFocus === "function" ? document.hasFocus() : true;
  FIELDS.forEach((f) => {
    const vEl = valueEls[f];
    const isFieldInput = vEl && (vEl.tagName === "INPUT" || vEl.tagName === "TEXTAREA");
    if (isFieldInput && sidePanelHasFocus && document.activeElement === vEl) {
      /* user is currently typing here; don't overwrite */
    } else {
      setPanelFieldValueFromData(f, data);
    }
    const hasVal = isNonEmptyTrim(getPanelFieldValue(f));
    vEl.classList.toggle("missing", !hasVal);
    const ok = document.querySelector(`[data-filled-check][data-field="${f}"]`);
    if (ok) ok.style.display = hasVal ? "inline" : "none";
    const air = document.querySelector(`[data-ai-refined][data-field="${f}"]`);
    if (air) {
      const ar = data && data.aiRefined && data.aiRefined[f] === true;
      air.style.display = hasVal && ar ? "inline" : "none";
    }
  });
  const mappingOk = isWandContextOk(data, tab) && !loading;
  if (mappingModeToggle) {
    mappingModeToggle.disabled = !mappingOk;
  }
  if (!mappingOk && mappingMode) {
    setMappingMode(false);
  }
  if (lineQuantityEl) {
    lineQuantityEl.disabled = loading;
  }
  refreshAddButtonState(data, tab);
}

function refreshAddButtonState(data, tab) {
  if (!addToList) return;
  if (!data) {
    addToList.disabled = true;
    return;
  }
  if (data.isLoading === true) {
    addToList.disabled = true;
    return;
  }
  if (tab && (isQuartzyDomainUrl(tab.url) || !isMappableContentUrl(String(tab.url || "")))) {
    addToList.disabled = true;
    return;
  }
  addToList.disabled = !canAddToList(data);
}

function setRequestListExpanded(expanded) {
  if (!requestListBody || !requestListToggle) return;
  if (expanded) {
    requestListBody.hidden = false;
    requestListToggle.setAttribute("aria-expanded", "true");
  } else {
    requestListBody.hidden = true;
    requestListToggle.setAttribute("aria-expanded", "false");
  }
  try {
    localStorage.setItem(REQUEST_LIST_UI_KEY, expanded ? "1" : "0");
  } catch (e) {
    /* ignore */
  }
}

function getInitialRequestListExpanded() {
  try {
    return localStorage.getItem(REQUEST_LIST_UI_KEY) === "1";
  } catch (e) {
    return false;
  }
}

function updateStatusHeader(data, tab) {
  const showSpinner = !!(data && data.isLoading === true);
  if (panelForm) {
    panelForm.classList.toggle("is-capturing", showSpinner);
    panelForm.setAttribute("aria-busy", showSpinner ? "true" : "false");
  }
  if (headerCaptureLive) {
    if (!data) {
      headerCaptureLive.textContent = "";
      return;
    }
    if (tab && (isQuartzyDomainUrl(tab.url) || (tab.url && !isMappableContentUrl(tab.url)))) {
      headerCaptureLive.textContent = "";
      return;
    }
    headerCaptureLive.textContent = showSpinner ? "Loading product data" : "";
  }
}

function hasCaptureToShow(data, tab) {
  if (tab && isQuartzyDomainUrl(tab.url)) {
    return false;
  }
  if (tab && !isMappableContentUrl((tab && tab.url) || "")) {
    return false;
  }
  if (!data) {
    return false;
  }
  if (isQuartzyDomainUrl(data.url)) {
    return false;
  }
  if (data.isLoading === true && isMappableContentUrl(data.url)) {
    return true;
  }
  if (FIELDS.some((f) => isFilled(data, f))) {
    return true;
  }
  return isMappableContentUrl(data.url);
}

function showData(data, tab) {
  if (!hasCaptureToShow(data, tab)) {
    emptyState.style.display = "block";
    dataState.style.display = "none";
    if (addToList) addToList.disabled = true;
    updateStatusHeader(data, tab);
    return;
  }
  emptyState.style.display = "none";
  dataState.style.display = "block";
  updateStatusHeader(data, tab);
  updateRowBadges(data, tab);
  if (activePanelView === "debug") {
    updateDebugView(data, tab);
  }
}

function getActiveTabKey(cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs[0] || tabs[0].id == null) {
      cb(null, null);
      return;
    }
    cb(tabs[0].id, tabs[0]);
  });
}

function loadForActiveTab() {
  getActiveTabKey((tabId, tab) => {
    if (tabId == null) {
      showData(null, null);
      return;
    }
    const key = "data_" + tabId;
    chrome.storage.local.get([key], (result) => {
      const data = result[key];
      showData(data, tab);
    });
  });
}

loadForActiveTab();

FIELDS.forEach((f) => {
  const el = valueEls[f];
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
    el.addEventListener("input", function () {
      const hasVal = isNonEmptyTrim(getPanelFieldValue(f));
      el.classList.toggle("missing", !hasVal);
      const ok = document.querySelector('[data-filled-check][data-field="' + f + '"]');
      if (ok) ok.style.display = hasVal ? "inline" : "none";
      getActiveTabKey((tabId, tab) => {
        if (tabId == null) return;
        chrome.storage.local.get(["data_" + tabId], (r) => {
          const data = r["data_" + tabId];
          refreshAddButtonState(data, tab);
        });
      });
    });
  }
});

if (tabNewRequest && tabDebug) {
  tabNewRequest.addEventListener("click", () => {
    setPanelView("request");
  });
  tabDebug.addEventListener("click", () => {
    setPanelView("debug");
  });
}

function clearMappingFieldHighlight() {
  document.querySelectorAll("[data-input-row].is-mapping-target").forEach((r) => {
    r.classList.remove("is-mapping-target");
  });
}

function highlightMappingField(field) {
  clearMappingFieldHighlight();
  const row = document.querySelector('[data-input-row="' + field + '"]');
  if (row) row.classList.add("is-mapping-target");
}

function setMappingField(field) {
  if (!mappingMode) return;
  if (mappingTabId == null) return;
  if (!field || FIELD_ORDER.indexOf(field) < 0) return;
  if (mappingField === field) {
    highlightMappingField(field);
    return;
  }
  mappingField = field;
  highlightMappingField(field);
  const inp = valueEls[field];
  if (inp && typeof inp.focus === "function") {
    try {
      inp.focus({ preventScroll: false });
    } catch (e) {
      try { inp.focus(); } catch (e2) { /* ignore */ }
    }
  }
  chrome.tabs.sendMessage(mappingTabId, { type: "WAND_START", field: field }, (response) => {
    if (chrome.runtime.lastError) {
      showToast("Map from page: reload the product page or try again.");
      setMappingMode(false);
      return;
    }
    if (!response || !response.success) {
      showToast("Could not arm the wand on this page. Try reloading.");
      setMappingMode(false);
    }
  });
}

function setMappingMode(on) {
  if (on === mappingMode) {
    if (mappingModeToggle) mappingModeToggle.checked = on;
    return;
  }
  if (on) {
    getActiveTabKey((tabId, tab) => {
      if (tabId == null || !isMappableContentUrl((tab && tab.url) || "")) {
        showToast("Open a normal product page to start mapping.");
        if (mappingModeToggle) mappingModeToggle.checked = false;
        return;
      }
      mappingMode = true;
      mappingTabId = tabId;
      if (mappingModeBar) mappingModeBar.classList.add("is-on");
      if (mappingModeHint) mappingModeHint.hidden = false;
      if (mappingModeToggle) mappingModeToggle.checked = true;
      document.body.classList.add("mapping-mode-on");
      if (activePanelView !== "request") setPanelView("request");
      mappingField = null;
      setMappingField("itemName");
    });
    return;
  }
  const prevTab = mappingTabId;
  mappingMode = false;
  mappingField = null;
  mappingTabId = null;
  if (mappingModeBar) mappingModeBar.classList.remove("is-on");
  if (mappingModeHint) mappingModeHint.hidden = true;
  if (mappingModeToggle) mappingModeToggle.checked = false;
  document.body.classList.remove("mapping-mode-on");
  clearMappingFieldHighlight();
  if (prevTab != null) {
    try {
      chrome.tabs.sendMessage(prevTab, { type: "WAND_STOP" }, () => {
        if (chrome.runtime.lastError) {
          /* tab gone or content script reloaded; safe to ignore */
        }
      });
    } catch (e) {
      /* ignore */
    }
  }
}

function advanceMappingField() {
  const idx = FIELD_ORDER.indexOf(mappingField);
  if (idx < 0 || idx >= FIELD_ORDER.length - 1) {
    setMappingMode(false);
    showToast("All fields mapped. Add to list when ready.");
    return;
  }
  setMappingField(FIELD_ORDER[idx + 1]);
}

if (mappingModeToggle) {
  mappingModeToggle.addEventListener("change", () => {
    setMappingMode(!!mappingModeToggle.checked);
  });
}

FIELDS.forEach((f) => {
  const el = valueEls[f];
  if (!el) return;
  el.addEventListener("focus", () => {
    if (mappingMode && mappingField !== f) {
      setMappingField(f);
    }
  });
});

document.querySelectorAll("[data-input-row]").forEach((row) => {
  row.addEventListener("click", (e) => {
    if (!mappingMode) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    const f = row.getAttribute("data-input-row");
    if (f && f !== mappingField) {
      setMappingField(f);
    }
  });
});

function newRequestId() {
  return "req_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function getQuantity() {
  const n = lineQuantityEl ? parseInt(String(lineQuantityEl.value), 10) : 1;
  if (Number.isNaN(n) || n < 1) return 1;
  return Math.min(999999, n);
}

function formatRequestLineForDom(entry) {
  const title = (entry.itemName && String(entry.itemName).trim()) || "(no name)";
  const parts = [
    "Qty: " + (entry.quantity != null ? entry.quantity : 1),
    (entry.catalogNumber && "Cat: " + entry.catalogNumber) || null,
    entry.unitSize ? "Unit: " + entry.unitSize : null,
    entry.price ? entry.price : null
  ].filter(Boolean);
  return { title, meta: parts.join(" · ") };
}

function renderRequestList(list) {
  if (!requestListEl || !requestListEmpty) return;
  if (!list || list.length === 0) {
    requestListEmpty.style.display = "block";
    requestListEmpty.textContent = "No items saved yet.";
    requestListEl.style.display = "none";
    requestListEl.innerHTML = "";
    return;
  }
  requestListEmpty.style.display = "none";
  requestListEl.style.display = "flex";
  requestListEl.innerHTML = "";
  list.forEach((entry) => {
    const { title, meta } = formatRequestLineForDom(entry);
    const line = document.createElement("div");
    line.className = "request-line";
    line.setAttribute("data-request-id", entry.id || "");
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "remove-line";
    rm.setAttribute("aria-label", "Remove this line");
    rm.textContent = "Remove";
    rm.addEventListener("click", () => {
      if (!entry.id) return;
      removeRequestById(entry.id);
    });
    const titleEl = document.createElement("div");
    titleEl.className = "req-title";
    const titleText = document.createElement("span");
    titleText.className = "req-title-text";
    titleText.textContent = title;
    titleEl.appendChild(titleText);
    titleEl.appendChild(rm);
    const metaEl = document.createElement("div");
    metaEl.className = "req-meta";
    metaEl.textContent = (entry.vendor && entry.url ? entry.vendor + " — " : "") + meta;
    if (entry.url) {
      metaEl.title = entry.url;
    }
    line.appendChild(titleEl);
    line.appendChild(metaEl);
    requestListEl.appendChild(line);
  });
}

function removeRequestById(id) {
  chrome.storage.local.get([REQUEST_LIST_KEY], (r) => {
    const list = Array.isArray(r[REQUEST_LIST_KEY]) ? r[REQUEST_LIST_KEY] : [];
    const next = list.filter((x) => x.id !== id);
    chrome.storage.local.set({ [REQUEST_LIST_KEY]: next }, () => {
      if (chrome.runtime.lastError) {
        showToast("Could not update the list.");
        return;
      }
      renderRequestList(next);
    });
  });
}

function loadRequestList() {
  chrome.storage.local.get([REQUEST_LIST_KEY, LEGACY_LIST_KEY], (r) => {
    let list = r[REQUEST_LIST_KEY];
    if (!Array.isArray(list) || list.length === 0) {
      const legacy = r[LEGACY_LIST_KEY];
      if (Array.isArray(legacy) && legacy.length) {
        list = legacy.map((row) => ({
          id: newRequestId(),
          itemName: row.itemName,
          catalogNumber: row.catalogNumber,
          price: row.price,
          unitSize: row.unitSize,
          url: row.url,
          vendor: row.vendor,
          quantity: 1,
          addedAt: Date.now()
        }));
        chrome.storage.local.set({ [REQUEST_LIST_KEY]: list, [LEGACY_LIST_KEY]: [] });
      } else {
        list = [];
      }
    }
    renderRequestList(list);
  });
}

if (addToList) {
  addToList.addEventListener("click", () => {
    getActiveTabKey((tabId) => {
      if (tabId == null) return;
      const key = "data_" + tabId;
      chrome.storage.local.get([key, REQUEST_LIST_KEY], (r) => {
        const data = r[key];
        if (!data || !canAddToList(data)) return;
        const list = (r && Array.isArray(r[REQUEST_LIST_KEY]) && r[REQUEST_LIST_KEY]) || [];
        const quantity = getQuantity();
        const item = {
          id: newRequestId(),
          itemName: getPanelFieldValue("itemName"),
          catalogNumber: getPanelFieldValue("catalogNumber"),
          price: getPanelFieldValue("price"),
          unitSize: getPanelFieldValue("unitSize"),
          url: data.url,
          vendor: data.vendor,
          quantity,
          addedAt: Date.now()
        };
        const next = list.concat([item]);
        chrome.storage.local.set({ [REQUEST_LIST_KEY]: next }, () => {
          if (chrome.runtime.lastError) {
            showToast("Could not save to your request list.");
            return;
          }
          renderRequestList(next);
          if (lineQuantityEl) lineQuantityEl.value = "1";
          showAddSuccessPill();
        });
      });
    });
  });
}

loadRequestList();

if (requestListToggle && requestListBody) {
  setRequestListExpanded(getInitialRequestListExpanded());
  requestListToggle.addEventListener("click", function () {
    const on = requestListToggle.getAttribute("aria-expanded") === "true";
    setRequestListExpanded(!on);
  });
}

if (cancelAddEl && lineQuantityEl) {
  cancelAddEl.addEventListener("click", function () {
    lineQuantityEl.value = "1";
  });
}

/* —— Fetch Price test tool (gated by QUARTZY_FETCH_PRICE_TEST_ENABLED) —— */
const fetchPriceStandalone = document.getElementById("fetchPriceStandalone");
const fetchPriceBlock = document.getElementById("fetchPriceBlock");
const fetchPriceUrlEl = document.getElementById("fetchPriceUrl");
const fetchPriceCatalogEl = document.getElementById("fetchPriceCatalog");
const fetchPriceBtn = document.getElementById("fetchPriceBtn");
const fetchPriceLoginBadge = document.getElementById("fetchPriceLoginBadge");
const fetchPriceStatus = document.getElementById("fetchPriceStatus");
const fetchPriceResult = document.getElementById("fetchPriceResult");
const fetchPriceDebug = document.getElementById("fetchPriceDebug");
const fetchPriceDebugSummary = document.getElementById("fetchPriceDebugSummary");
const fetchPriceDebugPre = document.getElementById("fetchPriceDebugPre");
const fetchPriceCopyDebug = document.getElementById("fetchPriceCopyDebug");
let fetchPriceInFlight = false;
/** @type {object|null} */
let lastFetchPriceDebug = null;

function isFetchPriceTestEnabled() {
  return typeof QUARTZY_FETCH_PRICE_TEST_ENABLED !== "undefined" && QUARTZY_FETCH_PRICE_TEST_ENABLED === true;
}

function initFetchPriceUi() {
  const shell = fetchPriceStandalone || fetchPriceBlock;
  if (!shell) return;
  if (!isFetchPriceTestEnabled()) {
    shell.hidden = true;
    return;
  }
  shell.hidden = false;
  if (fetchPriceBlock) fetchPriceBlock.hidden = false;
  if (fetchPriceBtn) {
    fetchPriceBtn.addEventListener("click", onFetchPriceClick);
  }
  if (fetchPriceCopyDebug) {
    fetchPriceCopyDebug.addEventListener("click", onCopyFetchPriceDebug);
  }
  setFetchPriceLoginBadge("unknown");
}

/**
 * @param {object|null|undefined} debug
 * @param {object} [result]
 */
function renderFetchPriceDebug(debug, result) {
  if (!fetchPriceDebug || !fetchPriceDebugPre) return;
  if (!debug) {
    lastFetchPriceDebug = null;
    fetchPriceDebug.hidden = true;
    fetchPriceDebugPre.textContent = "";
    if (fetchPriceDebugSummary) fetchPriceDebugSummary.textContent = "";
    return;
  }
  lastFetchPriceDebug = debug;
  fetchPriceDebug.hidden = false;
  try {
    fetchPriceDebugPre.textContent = JSON.stringify(debug, null, 2);
  } catch (e) {
    fetchPriceDebugPre.textContent = String(debug);
  }
  if (fetchPriceDebugSummary) {
    const req = debug.request || {};
    const out = debug.outcome || {};
    const page = (debug.content && debug.content.page) || {};
    const cookie = (debug.background && debug.background.cookieCheck) || {};
    const lines = [
      "Request: " + (req.url || "—") + (req.catalogNumber ? " · cat " + req.catalogNumber : ""),
      "Tab saw: " + (page.title || out.pageTitle || "—") + (page.href || out.pageUrl ? " @ " + (page.href || out.pageUrl) : ""),
      "Containers: " +
        (page.pricingContainers && page.pricingContainers.length
          ? page.pricingContainers.join(", ")
          : "(none)") +
        " · radios: " +
        (page.uomRadioCount != null ? page.uomRadioCount : "—") +
        " · pattern: " +
        ((debug.content && debug.content.outcomeSource) || "—"),
      "Login: cookies=" +
        (cookie.state || "—") +
        (cookie.matchedNames && cookie.matchedNames.length
          ? " [" + cookie.matchedNames.join(", ") + "]"
          : "") +
        " → resolved " +
        (out.loginState || (result && result.loginState) || "—"),
      "Outcome: " +
        (out.ok === false || (result && result.ok === false) ? "FAIL" : "OK") +
        (out.error || (result && result.error) ? " (" + (out.error || result.error) + ")" : "") +
        " · mode=" +
        (out.mode || (result && result.mode) || "—") +
        " · variants=" +
        (out.variantCount != null
          ? out.variantCount
          : result && Array.isArray(result.variants)
            ? result.variants.length
            : "—")
    ];
    fetchPriceDebugSummary.textContent = lines.join("\n");
  }
}

function onCopyFetchPriceDebug() {
  if (!lastFetchPriceDebug) {
    showToast("No debug log yet. Run Fetch Price first.");
    return;
  }
  let text;
  try {
    text = JSON.stringify(lastFetchPriceDebug, null, 2);
  } catch (e) {
    text = String(lastFetchPriceDebug);
  }
  const done = function (ok) {
    showToast(ok ? "Debug JSON copied — paste it in chat." : "Could not copy. Select the log and copy manually.");
  };
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    navigator.clipboard.writeText(text).then(
      function () {
        done(true);
      },
      function () {
        fallbackCopyText(text, done);
      }
    );
  } else {
    fallbackCopyText(text, done);
  }
}

/**
 * @param {string} text
 * @param {(ok: boolean) => void} done
 */
function fallbackCopyText(text, done) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    done(!!ok);
  } catch (e) {
    done(false);
  }
}

/**
 * @param {'logged_in'|'logged_out'|'unknown'|string} state
 */
function setFetchPriceLoginBadge(state) {
  if (!fetchPriceLoginBadge) return;
  fetchPriceLoginBadge.classList.remove("is-in", "is-out", "is-unknown");
  if (state === "logged_in") {
    fetchPriceLoginBadge.classList.add("is-in");
    fetchPriceLoginBadge.textContent = "Logged in";
  } else if (state === "logged_out") {
    fetchPriceLoginBadge.classList.add("is-out");
    fetchPriceLoginBadge.textContent = "Logged out";
  } else {
    fetchPriceLoginBadge.classList.add("is-unknown");
    fetchPriceLoginBadge.textContent = "Unknown";
  }
}

/**
 * @param {string} text
 * @param {'loading'|'error'|'warn'|''} [kind]
 */
function setFetchPriceStatus(text, kind) {
  if (!fetchPriceStatus) return;
  if (!text) {
    fetchPriceStatus.hidden = true;
    fetchPriceStatus.textContent = "";
    fetchPriceStatus.className = "fetch-price-status";
    return;
  }
  fetchPriceStatus.hidden = false;
  fetchPriceStatus.textContent = text;
  fetchPriceStatus.className =
    "fetch-price-status" +
    (kind === "loading" ? " is-loading" : kind === "error" ? " is-error" : kind === "warn" ? " is-warn" : "");
}

/**
 * @param {object} result
 */
function renderFetchPriceResult(result) {
  if (!fetchPriceResult) return;
  fetchPriceResult.textContent = "";
  if (!result) {
    fetchPriceResult.hidden = true;
    return;
  }
  fetchPriceResult.hidden = false;

  if (result.loginState === "logged_out" && result.ok) {
    const warn = document.createElement("p");
    warn.className = "fetch-price-status is-warn";
    warn.textContent = "Login required warning: vendor session looks logged out; prices may be list/public only.";
    fetchPriceResult.appendChild(warn);
  }

  const variants = Array.isArray(result.variants) ? result.variants : [];
  const mode = result.mode === "list" && variants.length > 1 ? "list" : "single";

  if (mode === "single") {
    const v = variants[0] || {};
    const p = document.createElement("p");
    p.className = "fetch-price-single";
    const price = isNonEmptyTrim(v.price) ? v.price : "—";
    const unit = isNonEmptyTrim(v.unitSize) ? " / " + v.unitSize : "";
    const cat = isNonEmptyTrim(v.catalogNumber) ? " · " + v.catalogNumber : "";
    const src = v.priceSource ? "  [" + v.priceSource + "]" : "";
    p.textContent = price + unit + cat + src;
    fetchPriceResult.appendChild(p);
  } else {
    const wrap = document.createElement("div");
    wrap.className = "fetch-price-table-wrap";
    const table = document.createElement("table");
    table.className = "fetch-price-table";
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    ["Label", "Catalog #", "Price", "Unit", "Source"].forEach(function (h) {
      const th = document.createElement("th");
      th.textContent = h;
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    variants.forEach(function (v) {
      const tr = document.createElement("tr");
      if (v && (v.isSuggestedMatch || v.isSelected)) {
        tr.classList.add("is-suggested");
      }
      const labelText =
        (v.label || "") + (v.isSelected ? " · selected" : v.isSuggestedMatch ? " · match" : "");
      const cells = [
        labelText,
        v.catalogNumber || "",
        v.price || "—",
        v.unitSize || "",
        v.priceSource || ""
      ];
      cells.forEach(function (c) {
        const td = document.createElement("td");
        td.textContent = c;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    fetchPriceResult.appendChild(wrap);
  }

  renderFetchPriceDebug(result.debug || null, result);
}

function onFetchPriceClick() {
  if (fetchPriceInFlight || !fetchPriceBtn) return;
  const url = fetchPriceUrlEl ? String(fetchPriceUrlEl.value || "").trim() : "";
  const catalogNumber = fetchPriceCatalogEl ? String(fetchPriceCatalogEl.value || "").trim() : "";
  if (!url) {
    setFetchPriceStatus("Enter a product URL.", "error");
    return;
  }
  fetchPriceInFlight = true;
  fetchPriceBtn.disabled = true;
  setFetchPriceStatus("Opening background tab and scraping…", "loading");
  setFetchPriceLoginBadge("unknown");
  if (fetchPriceResult) {
    fetchPriceResult.hidden = true;
    fetchPriceResult.textContent = "";
  }
  renderFetchPriceDebug(null);

  chrome.runtime.sendMessage(
    { type: "FETCH_PRICE_REQUEST", url: url, catalogNumber: catalogNumber || undefined },
    function (response) {
      fetchPriceInFlight = false;
      fetchPriceBtn.disabled = false;
      if (chrome.runtime.lastError) {
        setFetchPriceStatus(chrome.runtime.lastError.message || "Extension message failed.", "error");
        setFetchPriceLoginBadge("unknown");
        renderFetchPriceDebug({
          version: 1,
          generatedAt: new Date().toISOString(),
          request: { url: url, catalogNumber: catalogNumber },
          outcome: {
            ok: false,
            error: "runtime_lastError",
            message: chrome.runtime.lastError.message
          }
        });
        return;
      }
      const result = response || {};
      setFetchPriceLoginBadge(result.loginState || "unknown");

      if (!result.ok) {
        const code = result.error || "error";
        let msg = result.errorMessage || "Fetch failed.";
        if (code === "login_wall") {
          setFetchPriceStatus(msg, "warn");
        } else if (code === "bot_check") {
          setFetchPriceStatus(msg, "warn");
        } else if (code === "timeout") {
          setFetchPriceStatus(msg, "error");
        } else if (code === "page_load_failed") {
          setFetchPriceStatus(msg, "error");
        } else {
          setFetchPriceStatus(msg, "error");
        }
        if (Array.isArray(result.variants) && result.variants.length) {
          renderFetchPriceResult(result);
        } else {
          renderFetchPriceDebug(result.debug || null, result);
        }
        return;
      }

      setFetchPriceStatus(
        result.mode === "list" ? "Found " + (result.variants || []).length + " variants." : "Price fetched.",
        ""
      );
      renderFetchPriceResult(result);
    }
  );
}

initFetchPriceUi();

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "UPDATE_SIDE_PANEL" && message.tabId != null && message.data) {
    getActiveTabKey((tabId, tab) => {
      if (tabId != null && tabId === message.tabId) {
        showData(message.data, tab);
      }
    });
  }
  if (message.type === "WAND_CAPTURED" && mappingMode && message.field === mappingField) {
    advanceMappingField();
  }
});

chrome.tabs.onActivated.addListener((info) => {
  if (mappingMode && info && info.tabId !== mappingTabId) {
    setMappingMode(false);
  }
  loadForActiveTab();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (mappingMode && tabId === mappingTabId && (changeInfo.status === "loading" || changeInfo.url)) {
    setMappingMode(false);
  }
  if (changeInfo.status === "complete") {
    getActiveTabKey((activeId) => {
      if (activeId === tabId) loadForActiveTab();
    });
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[REQUEST_LIST_KEY]) {
    const next = changes[REQUEST_LIST_KEY].newValue;
    renderRequestList(Array.isArray(next) ? next : []);
  }
  getActiveTabKey((tabId, tab) => {
    if (tabId == null) return;
    const key = "data_" + tabId;
    if (changes[key]) {
      showData(changes[key].newValue, tab);
    }
  });
});
