// 1. On load, check if we have saved data for this tab
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tabId = tabs[0]?.id;
  if (tabId) {
    chrome.storage.local.get([`data_${tabId}`], (result) => {
      const savedData = result[`data_${tabId}`];
      if (savedData) {
        updateUI(savedData);
        // Optional: clear the badge once the user sees it
        chrome.action.setBadgeText({ tabId: tabId, text: "" });
      }
    });
  }
});

// Listen for automated updates (live)
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "UPDATE_SIDE_PANEL") {
    updateUI(message.data);
  }
});

// --- View Management ---

async function updateViewMode() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  const fisherView = document.getElementById('fisher-view');
  const quartzyView = document.getElementById('quartzy-view');
  const statusPill = document.querySelector('.status-pill');

  if (tab.url.includes("fishersci.com")) {
    fisherView.style.display = 'block';
    quartzyView.style.display = 'none';
    statusPill.innerHTML = '&bull; ACTIVE (Fisher)';
    statusPill.style.color = '#1e7e34'; // Green
  } else if (tab.url.includes("quartzy.com")) {
    fisherView.style.display = 'none';
    quartzyView.style.display = 'block';
    statusPill.innerHTML = '&bull; BRIDGE MODE';
    statusPill.style.color = '#f1662a'; // Orange
  } else {
    fisherView.style.display = 'none';
    quartzyView.style.display = 'none';
    statusPill.innerHTML = '&bull; IDLE';
    statusPill.style.color = '#666';
  }
}

// Update view on load and tab change triggers
updateViewMode();
chrome.tabs.onActivated.addListener(updateViewMode);
chrome.tabs.onUpdated.addListener(updateViewMode);


// --- Quartzy Bridge Logic ---

document.getElementById('fetchBridgeBtn').addEventListener('click', async () => {
  const input = document.getElementById('quartzyInput');
  const statusMsg = document.getElementById('bridgeStatus');
  const catNum = input.value.trim();

  if (!catNum) {
    alert("Please enter a catalog number.");
    return;
  }

  // Reset UI
  const resultArea = document.getElementById('resultArea');
  resultArea.style.display = 'none';
  statusMsg.style.display = 'block';
  statusMsg.innerText = "Locating Fisher tab...";
  statusMsg.style.color = "#666";

  // 1. Find a Fisher Tab to use as proxy
  const tabs = await chrome.tabs.query({ url: "*://*.fishersci.com/*" });

  if (tabs.length === 0) {
    statusMsg.innerText = "Error: No open Fisher Scientific tab found. Please open one.";
    statusMsg.style.color = "red";
    return;
  }

  const proxyTab = tabs[0]; // Use the first one found
  statusMsg.innerText = `Proxying via Fisher tab (ID: ${proxyTab.id})...`;

  // 2. Send Message to that tab
  chrome.tabs.sendMessage(proxyTab.id, {
    type: "FETCH_PRICE_ON_DEMAND",
    catalogNumber: catNum
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error(chrome.runtime.lastError);
      statusMsg.innerText = "Error: Could not talk to Fisher tab. Reload it?";
      statusMsg.style.color = "red";
      return;
    }

    if (response && response.success) {
      statusMsg.style.display = 'none';
      updateUI(response.data);
    } else {
      statusMsg.innerText = "Error: " + (response?.error || "Unknown error");
      statusMsg.style.color = "red";
    }
  });
});


// --- Fisher Manual Logic (Existing) ---
// Fix the manual button with robust selectors matching content.js / vendors.json
document.getElementById('scrapeBtn').addEventListener('click', async () => {
  console.log("[SidePanel] Scrape button clicked.");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      console.error("[SidePanel] No active tab found.");
      return;
    }
    console.log(`[SidePanel] Target Tab: ${tab.id} (${tab.url})`);

    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        console.log("[PageContext] Manual scrape triggered.");
        // Re-run the core logic inside the tab with ALL selectors
        const catNumSelectors = ['[itemprop="sku"]', '.product-catalog-number', '.cat-num', '#catalogNumber'];
        const priceSelectors = ['#totalPrice', '.pdp-price', '.full-price', '[id^="price_"]'];

        let catNum = "";
        let price = "";

        catNumSelectors.forEach(sel => {
          const el = document.querySelector(sel);
          if (el) {
            console.log(`[PageContext] Found CatNum Candidate: ${sel} -> ${el.innerText}`);
            if (el.innerText.trim()) catNum = el.innerText.replace('Catalog No. ', '').trim();
          }
        });

        priceSelectors.forEach(sel => {
          const el = document.querySelector(sel);
          if (el) {
            console.log(`[PageContext] Found Price Candidate: ${sel} -> ${el.innerText}`);
            if (el.innerText.trim() && el.innerText.includes('$')) price = el.innerText.trim();
          }
        });

        const result = { catalogNumber: catNum, price: price };
        console.log("[PageContext] Returning result:", result);
        return result;
      }
    }, (results) => {
      if (chrome.runtime.lastError) {
        console.error("[SidePanel] Script injection failed:", chrome.runtime.lastError.message);
        return;
      }
      console.log("[SidePanel] Script results:", results);
      if (results?.[0]?.result) {
        updateUI(results[0].result);
      } else {
        console.warn("[SidePanel] No results returned from script.");
      }
    });
  } catch (err) {
    console.error("[SidePanel] Critical Error in Scrape Handler:", err);
  }
});


function updateUI(data) {
  const resultArea = document.getElementById('resultArea');
  if (!resultArea) return;

  // Only update if we actually have something (even partial)
  // or if we want to show "Not Found" state, we could handle that here.
  // The original check required both, we'll keep it but be lenient on "--"
  if (data.catalogNumber || data.price) {
    resultArea.style.display = 'block';
    document.getElementById('catNum').textContent = data.catalogNumber || "--";
    document.getElementById('priceVal').textContent = data.price || "--";
  }
}