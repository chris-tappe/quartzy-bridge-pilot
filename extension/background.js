// Open side panel when the user clicks the extension icon (Manifest V3 sidePanel + action).
try {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("[Quartzy Connect] setPanelBehavior:", err));
} catch (e) {
  console.error("[Quartzy Connect] sidePanel API:", e);
}

/**
 * Optional: POST to your server that calls Gemini 3 Flash (or equivalent) and returns
 * a JSON object with keys: item_name, catalog_number, price, unit_size, currency.
 * Add the origin to manifest `host_permissions` and set the URL in code or storage.
 */
const AI_EXTRACT_PROXY_URL = "";

function parseJsonFromString(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t) return null;
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch (e) {
    return null;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PRODUCT_CAPTURE" && sender.tab && sender.tab.id != null) {
    saveAndNotify(sender.tab.id, message.data);
  }

  if (message.type === "AI_EXTRACT") {
    const doFetch = async () => {
      const base = (message && message.proxyUrl) || AI_EXTRACT_PROXY_URL;
      if (!base || !String(base).trim()) {
        sendResponse({ ok: false, error: "no_proxy" });
        return;
      }
      const url = String(base).trim();
      const systemPrompt = message.systemPrompt != null ? String(message.systemPrompt) : "";
      const body = {
        systemPrompt: systemPrompt,
        context: message.contextText,
        /* Proxy may map this to Google Gemini 3 / 2.5 / Flash, etc. */
        model: (message && message.model) || "gemini-2.0-flash"
      };
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          mode: "cors"
        });
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) || "fetch_error" });
        return;
      }
      if (!res || !res.ok) {
        sendResponse({ ok: false, error: "http_" + (res && res.status) });
        return;
      }
      const raw = await res.text();
      let parsed = parseJsonFromString(raw);
      if (!parsed) {
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          parsed = null;
        }
      }
      if (!parsed) {
        sendResponse({ ok: false, error: "parse" });
        return;
      }
      const o = parsed;
      if (o.item_name == null && o.itemName) {
        o.item_name = o.itemName;
      }
      if (o.catalog_number == null && o.catalogNumber) o.catalog_number = o.catalogNumber;
      if (o.unit_size == null && o.unitSize) o.unit_size = o.unitSize;
      sendResponse({ ok: true, parsed: o });
    };
    doFetch();
    return true;
  }
});

/** Matches which tabs run `content.js` in manifest (no chrome pages; Quartzy app is excluded). */
function isProductCapturePageUrl(url) {
  if (!url || typeof url !== "string") return false;
  if (!/^https?:\/\//i.test(url)) return false;
  if (/(^chrome-|^edge-|^brave-|^about:|^moz-extension:)/i.test(url) || /:\/\/chrome\.google\./i.test(url)) {
    return false;
  }
  try {
    const h = new URL(url).hostname.toLowerCase();
    if (h === "quartzy.com" || h.endsWith(".quartzy.com")) {
      return false;
    }
  } catch (e) {
    return false;
  }
  return true;
}

/**
 * Resets a tab’s saved capture and shows a loading state so the side panel does not show the previous page’s data.
 */
function resetTabDataForNewNavigation(tab) {
  if (!tab || tab.id == null || !tab.url) return;
  if (!isProductCapturePageUrl(tab.url)) return;
  const u = String(tab.url);
  let vendor = "Unknown";
  try {
    vendor = new URL(u).hostname.replace(/^www\./, "");
  } catch (e) {
    /* use default */
  }
  const data = {
    itemName: "",
    catalogNumber: "",
    price: "",
    unitSize: "",
    url: u,
    vendor,
    fieldSources: { itemName: null, catalogNumber: null, price: null, unitSize: null },
    aiRefined: { itemName: false, catalogNumber: false, price: false, unitSize: false },
    isLoading: true,
    capturePhase: "page-load",
    statusMessage: "Loading page…"
  };
  saveAndNotify(tab.id, data);
}

function saveAndNotify(tabId, data) {
  chrome.storage.local.set({ [`data_${tabId}`]: data }, () => {
    console.log("[Quartzy Connect] Data saved for tab", tabId, data);
  });
  chrome.action.setBadgeText({ tabId: tabId, text: "" });
  try {
    chrome.runtime.sendMessage({
      type: "UPDATE_SIDE_PANEL",
      tabId: tabId,
      data: data
    });
  } catch (e) {
    /* no receiver if side panel closed */
  }
}



// Clean up storage when a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove(`data_${tabId}`);
});

// When navigation starts, clear the prior capture for this tab so the side panel does not show stale data.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading" && tab) {
    const u = (changeInfo.url != null ? changeInfo.url : null) || tab.url;
    if (u) {
      resetTabDataForNewNavigation({ id: tab.id, url: u });
    }
  }
  if (changeInfo.status === "complete" && tab.url && /^https?:/i.test(tab.url)) {
    if (!isProductCapturePageUrl(tab.url)) {
      return;
    }
    console.log(`[Background] Navigation complete on tab ${tabId}: ${tab.url}`);

    chrome.tabs.sendMessage(tabId, { type: "TRIGGER_SCRAPE" })
      .catch((err) => console.log("[Quartzy Connect] Content script not ready:", err && err.message));
  }
});