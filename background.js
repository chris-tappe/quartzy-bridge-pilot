// Allows users to open the side panel by clicking on the action toolbar icon
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

// Listen for messages from the content script
// Listen for messages from the content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handler for DOM scraped data (or Content Script API success)
  if (message.type === "FISHER_DATA_FOUND") {
    saveAndNotify(sender.tab.id, message.data);
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