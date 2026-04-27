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
  FIELDS.forEach((f) => {
    const vEl = valueEls[f];
    const isFieldInput = vEl && (vEl.tagName === "INPUT" || vEl.tagName === "TEXTAREA");
    if (isFieldInput && document.activeElement === vEl) {
      /* do not overwrite text the user is editing */
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
  const wandsOn = isWandContextOk(data, tab) && !loading;
  FIELDS.forEach((field) => {
    const w = document.querySelector(`[data-wand="${field}"]`);
    if (w) w.disabled = !wandsOn;
  });
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

function sendWand(field) {
  getActiveTabKey((tabId, tab) => {
    if (tabId == null) {
      showToast("No active tab to map.");
      return;
    }
    if (!isMappableContentUrl(tab && tab.url)) {
      showToast("Open a product page in this window (a normal website tab).");
      return;
    }
    chrome.tabs.sendMessage(tabId, { type: "WAND_START", field: field }, (response) => {
      if (chrome.runtime.lastError) {
        showToast("Map from page: reload the product page or try again.");
        return;
      }
      if (!response || !response.success) {
        showToast("Selection is already in progress, or the page is not ready.");
        return;
      }
      showToast("Select the text for this field on the page, then release.");
    });
  });
}

document.querySelectorAll("[data-wand]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const field = btn.getAttribute("data-wand");
    if (field) sendWand(field);
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

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "UPDATE_SIDE_PANEL" && message.tabId != null && message.data) {
    getActiveTabKey((tabId, tab) => {
      if (tabId != null && tabId === message.tabId) {
        showData(message.data, tab);
      }
    });
  }
});

chrome.tabs.onActivated.addListener(() => {
  loadForActiveTab();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
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
