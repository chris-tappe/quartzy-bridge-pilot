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
const FIELDS = ["itemName", "catalogNumber", "price", "unitSize"];

const valueEls = {
  itemName: document.getElementById("vItemName"),
  catalogNumber: document.getElementById("vCatalog"),
  price: document.getElementById("vPrice"),
  unitSize: document.getElementById("vUnit")
};

const headerStatusText = document.getElementById("headerStatusText");
const headerStatusSpinner = document.getElementById("headerStatusSpinner");
const headerStatusLine = document.getElementById("headerStatusLine");
const panelForm = document.getElementById("panelForm");

const IDLE_STATUS =
  "Done. If a field is still empty, wait for the status above to say “Done” (spinner off), then use a wand to map that field on the product page.";

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

function canAddToList(data) {
  if (!data) return false;
  if (data.isLoading === true) return false;
  return FIELDS.every((k) => isFilled(data, k));
}

/** Wands work on any normal web page the extension can read (https/http in the user’s tab). */
function isMappableContentUrl(url) {
  if (!url || typeof url !== "string") return false;
  return /^https?:\/\//i.test(url) && !/^https?:\/\/(chrome\.)?google\./i.test(url);
}

let toastTimer = null;
function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove("show");
  }, 3000);
}

function isWandContextOk(data, tab) {
  return isMappableContentUrl((tab && tab.url) || (data && data.url));
}

function updateRowBadges(data, tab) {
  const loading = data && data.isLoading === true;
  FIELDS.forEach((f) => {
    const hasVal = isFilled(data, f);
    const vEl = valueEls[f];
    vEl.classList.toggle("missing", !hasVal);
    vEl.textContent = hasVal ? String(data[f]) : "—";
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
}

function updateStatusHeader(data, tab) {
  if (!headerStatusText) return;
  const showSpinner = !!(data && data.isLoading === true);
  if (headerStatusSpinner) {
    headerStatusSpinner.classList.toggle("is-visible", showSpinner);
  }
  if (headerStatusLine) {
    headerStatusLine.setAttribute("aria-busy", showSpinner ? "true" : "false");
  }
  if (panelForm) {
    panelForm.classList.toggle("is-capturing", showSpinner);
    panelForm.setAttribute("aria-busy", showSpinner ? "true" : "false");
  }
  if (!data) {
    headerStatusText.textContent =
      "Select a product website tab in this window, or focus a tab that already has a product page. Capture shows a status while the page is read.";
    return;
  }
  if (tab && isQuartzyDomainUrl(tab.url)) {
    headerStatusText.textContent =
      "Quartzy in-app pages are not read by this panel. Open a vendor’s product page in a normal https tab, then return here.";
    if (headerStatusSpinner) {
      headerStatusSpinner.classList.remove("is-visible");
    }
    return;
  }
  if (tab && tab.url && !isMappableContentUrl(tab.url)) {
    headerStatusText.textContent = "This tab is not a normal website page, so there is nothing to capture here.";
    if (headerStatusSpinner) {
      headerStatusSpinner.classList.remove("is-visible");
    }
    return;
  }
  if (data.statusMessage && String(data.statusMessage).trim().length) {
    headerStatusText.textContent = String(data.statusMessage).trim();
    return;
  }
  headerStatusText.textContent = IDLE_STATUS;
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
  if (addToList) {
    addToList.disabled = !canAddToList(data);
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
          itemName: data.itemName,
          catalogNumber: data.catalogNumber,
          price: data.price,
          unitSize: data.unitSize,
          url: data.url,
          vendor: data.vendor,
          quantity,
          addedAt: Date.now()
        };
        const next = list.concat([item]);
        const count = next.length;
        chrome.storage.local.set({ [REQUEST_LIST_KEY]: next }, () => {
          if (chrome.runtime.lastError) {
            showToast("Could not save to your request list.");
            return;
          }
          renderRequestList(next);
          if (lineQuantityEl) lineQuantityEl.value = "1";
          showToast("Added to your request list. " + count + " " + (count === 1 ? "line saved." : "lines saved."));
        });
      });
    });
  });
}

loadRequestList();

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
