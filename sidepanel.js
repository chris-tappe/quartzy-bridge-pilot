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
  } else if (message.type === "QUARTZY_SELECTION_UPDATED") {
    updateSelectedItemsUI(message.data);
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

    // Fetch selection
    try {
      chrome.tabs.sendMessage(tab.id, { type: "GET_QUARTZY_SELECTION" }, (response) => {
        if (response && response.success) {
          updateSelectedItemsUI(response.data);
        }
      });
    } catch (err) { /* ignore */ }
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


// --- Manual Scrape Removed ---


function updateUI(data) {
  const resultArea = document.getElementById('resultArea');
  if (!resultArea) return;

  if (data.catalogNumber || data.price) {
    resultArea.style.display = 'block';
    document.getElementById('catNum').textContent = data.catalogNumber || "--";
    document.getElementById('priceVal').textContent = data.price || "--";
  }
}

// --- Bulk Transfer UI Logic ---

let currentQuartzySelection = [];

function updateSelectedItemsUI(items) {
  currentQuartzySelection = items || [];
  const listEl = document.getElementById('selectedItemsList');
  const btn = document.getElementById('transferToFisherBtn');
  if (!listEl || !btn) return;

  if (currentQuartzySelection.length === 0) {
    listEl.innerHTML = "Check boxes in Quartzy to see items here.";
    btn.style.display = 'none';
    return;
  }

  listEl.innerHTML = currentQuartzySelection.map(item =>
    `<div style="display:flex; justify-content:space-between; border-bottom:1px solid #eee; padding-bottom: 4px; margin-bottom: 4px;">
      <span><strong>Cat #:</strong> ${item.catalogNumber}</span>
      <span><strong>Qty:</strong> ${item.quantity}</span>
    </div>`
  ).join('');

  btn.style.display = 'block';
  btn.innerText = `Transfer ${currentQuartzySelection.length} Item(s)`;
}

const transferBtnEl = document.getElementById('transferToFisherBtn');
if (transferBtnEl) {
  transferBtnEl.addEventListener('click', () => {
    const statusMsg = document.getElementById('transferStatus');
    if (currentQuartzySelection.length === 0) return;

    statusMsg.style.display = 'block';
    statusMsg.innerText = "Saving items to storage...";
    statusMsg.style.color = "#666";

    chrome.storage.local.set({ 'fisher_order_queue': currentQuartzySelection }, () => {
      statusMsg.innerText = "Opening Fisher Rapid Order...";
      chrome.tabs.create({ url: "https://www.fishersci.com/store1/rapidorder" }, () => {
        statusMsg.style.display = 'none';
      });
    });
  });
}