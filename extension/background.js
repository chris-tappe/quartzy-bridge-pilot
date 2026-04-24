// Open side panel when the user clicks the extension icon (Manifest V3 sidePanel + action).
try {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("[Quartzy Connect] setPanelBehavior:", err));
} catch (e) {
  console.error("[Quartzy Connect] sidePanel API:", e);
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === "PRODUCT_CAPTURE" && sender.tab && sender.tab.id != null) {
    saveAndNotify(sender.tab.id, message.data);
  }
});


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

// Detect SPA navigation (history changes)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Only trigger if URL changed and it's a Fisher product page
  // AND the page has finished loading (ensure content script is ready)
  if (changeInfo.status === "complete" && tab.url && /^https?:/i.test(tab.url)) {
    console.log(`[Background] Navigation complete on tab ${tabId}: ${tab.url}`);

    chrome.tabs.sendMessage(tabId, { type: "TRIGGER_SCRAPE" })
      .catch((err) => console.log("[Quartzy Connect] Content script not ready:", err && err.message));
  }
});