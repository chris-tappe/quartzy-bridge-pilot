// Allows users to open the side panel by clicking on the action toolbar icon
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

// --- Fisher fallback search: fetch search HTML, handle redirect or send HTML for parsing ---
const FISHER_SEARCH_BASE = "https://www.fishersci.com/us/en/catalog/search/products?keyword=";

/**
 * Fetch Fisher search page. Returns { redirected: true, catalogNumber } if redirected to a product,
 * or { redirected: false, html } for the raw HTML to parse in a content script.
 */
async function fetchFisherSearchHtml(query) {
  const url = FISHER_SEARCH_BASE + encodeURIComponent(query.trim());
  const response = await fetch(url, { redirect: "follow" });

  if (response.redirected && response.url) {
    const u = response.url;
    if (u.includes("/shop/products/") || u.includes("/catalog/")) {
      const path = u.split("?")[0];
      const segments = path.split("/").filter(Boolean);
      const last = segments[segments.length - 1];
      const catalog = (last && last.endsWith(".html")) ? last.slice(0, -5) : last;
      if (catalog && catalog !== "products" && catalog.length >= 2) {
        console.log("[Quartzy Bridge] Fisher redirect catalog:", catalog);
        return { redirected: true, catalogNumber: catalog };
      }
    }
  }

  const html = await response.text();
  return { redirected: false, html };
}

// --- VWR keyword search: map MPN to SPN (e.g. "Corning 3960" -> "29445-164") ---
const VWR_KEYWORD_SEARCH_BASE = "https://occapi.avantorsciences.com/occ/v2/us.vwr.com/products/keywordSearch";

function extractCorePart(query) {
  const trimmed = (query || "").trim();
  if (!trimmed) return "";
  const tokens = trimmed.split(/\s+/);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i].replace(/[^a-zA-Z0-9]/g, "");
    if (t.length > 0) return t;
  }
  return trimmed.replace(/[^a-zA-Z0-9]/g, "") || trimmed;
}

async function fetchVwrCatalogNumber(query) {
  const encoded = encodeURIComponent(query.trim());
  const url = `${VWR_KEYWORD_SEARCH_BASE}?query=${encoded}&pageSize=10&fields=BASIC&lang=en_US&curr=USD&newStorefront=true`;
  try {
    const res = await fetch(url);
    if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    const products = data?.products || data?.productList || [];
    const corePart = extractCorePart(query).toLowerCase();

    for (const product of products) {
      const vendorNums = product.vendorCatalogNumbers || product.vendorCatalogNumber || [];
      const arr = Array.isArray(vendorNums) ? vendorNums : [vendorNums];
      const vwrNum = (product.vwrCatalogNumber ?? product.catalogNumber ?? "").toString().trim();
      const articleNum = (product.vwrArticleNumber ?? product.articleNumber ?? "").toString().trim();
      const vendorMatch = arr.some((v) => String(v).trim().toLowerCase() === corePart);
      const articleMatch = articleNum && articleNum.toLowerCase().includes(corePart);
      if ((vendorMatch || articleMatch) && vwrNum) {
        console.log("[Quartzy Bridge] VWR catalog mapping success:", query, "->", vwrNum);
        return { success: true, vwrCatalogNumber: vwrNum };
      }
    }
    console.log("[Quartzy Bridge] VWR catalog mapping failure: no matching product for query:", query);
    return { success: false, error: "no_match" };
  } catch (err) {
    console.log("[Quartzy Bridge] VWR keyword search error:", err?.message || err);
    return { success: false, error: err?.message || "fetch_error" };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "FISHER_DATA_FOUND") {
    saveAndNotify(sender.tab.id, message.data);
  } else if (message.type === "RESOLVE_FISHER_CATALOG_NUMBER") {
    const { query, tabId } = message;
    if (!query || !tabId) {
      sendResponse({ success: false, error: "missing query or tabId" });
      return;
    }
    (async () => {
      try {
        const result = await fetchFisherSearchHtml(query);
        if (result.redirected && result.catalogNumber) {
          sendResponse({ success: true, catalogNumber: result.catalogNumber });
          return;
        }
        if (!result.html) {
          sendResponse({ success: false, error: "no html" });
          return;
        }
        chrome.tabs.sendMessage(tabId, { type: "PARSE_FISHER_HTML", html: result.html }, (parseResponse) => {
          if (chrome.runtime.lastError) {
            console.log("[Quartzy Bridge] Fisher HTML parse error:", chrome.runtime.lastError.message);
            sendResponse({ success: false, error: chrome.runtime.lastError.message });
            return;
          }
          if (parseResponse && parseResponse.success && parseResponse.catalogNumber) {
            sendResponse({ success: true, catalogNumber: parseResponse.catalogNumber });
          } else {
            sendResponse({ success: false, error: parseResponse?.error || "no_match" });
          }
        });
      } catch (err) {
        console.log("[Quartzy Bridge] Fisher search error:", err?.message || err);
        sendResponse({ success: false, error: err?.message || "fetch_error" });
      }
    })();
    return true;
  } else if (message.type === "RESOLVE_VWR_CATALOG_NUMBER") {
    const query = message.query;
    if (!query) {
      sendResponse({ success: false, error: "missing query" });
      return;
    }
    fetchVwrCatalogNumber(query).then(sendResponse).catch((err) => {
      console.log("[Quartzy Bridge] RESOLVE_VWR_CATALOG_NUMBER error:", err);
      sendResponse({ success: false, error: err?.message });
    });
    return true;
  } else if (message.type === "OPEN_VENDOR_TAB") {
    const vendor = message.vendor;
    const isVwr = vendor === "VWR";

    const vwrQuery = { url: ["*://*.vwr.com/*", "*://*.avantorsciences.com/*"] };
    const fisherQuery = { url: "*://*.fishersci.com/*" };

    const query = isVwr ? vwrQuery : fisherQuery;
    const targetUrl = isVwr ? "https://www.avantorsciences.com/us/en/" : "https://www.fishersci.com";

    chrome.tabs.query(query, (tabs) => {
      if (tabs && tabs.length > 0) {
        const tab = tabs[0];
        // Reuse existing vendor tab but keep focus on current Quartzy tab
        sendResponse({ success: true, tabId: tab.id, created: false });
      } else {
        // Open vendor tab in background so user stays on Quartzy
        chrome.tabs.create({ url: targetUrl, active: false }, (tab) => {
          if (chrome.runtime.lastError || !tab) {
            console.log("[Background] Failed to open vendor tab", chrome.runtime.lastError);
            sendResponse({ success: false });
          } else {
            console.log("[Background] Opened vendor tab", vendor, tab.id);
            sendResponse({ success: true, tabId: tab.id, created: true });
          }
        });
      }
    });

    return true; // Keep sendResponse alive for async calls
  }
});


// Helper to save data and show badge
function saveAndNotify(tabId, data) {
  // 1. Save to storage
  chrome.storage.local.set({ [`data_${tabId}`]: data }, () => {
    console.log(`Data saved for tab ${tabId}`, data);
  });

  // 2. Set badge
  chrome.action.setBadgeText({ tabId: tabId, text: "!" });
  chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: "#26C8D0" });

  // 3. Update Side Panel if open
  chrome.runtime.sendMessage({
    type: "UPDATE_SIDE_PANEL",
    data: data
  });
}



// Clean up storage when a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove(`data_${tabId}`);
});

// Detect SPA navigation (history changes)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Only trigger if URL changed and it's a Fisher product page
  // AND the page has finished loading (ensure content script is ready)
  const isFisher = tab.url.includes("fishersci.com/shop/products");
  const isVwr = tab.url.includes("vwr.com/store/product") || tab.url.includes("avantorsciences.com/us/en/product");

  if (changeInfo.status === 'complete' && tab.url && (isFisher || isVwr)) {
    console.log(`[Background] Navigation complete on tab ${tabId}: ${tab.url}`);

    // Send message to Content Script to re-run scrape
    chrome.tabs.sendMessage(tabId, { type: "TRIGGER_SCRAPE" })
      .catch(err => console.log("Content script still not ready?", err));
  }
});