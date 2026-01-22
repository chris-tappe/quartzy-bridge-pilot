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
  if (changeInfo.status === 'complete' && tab.url && tab.url.includes("fishersci.com/shop/products")) {
    console.log(`[Background] Navigation complete on tab ${tabId}: ${tab.url}`);

    // Send message to Content Script to re-run scrape
    chrome.tabs.sendMessage(tabId, { type: "TRIGGER_SCRAPE" })
      .catch(err => console.log("Content script still not ready?", err));
  }
});