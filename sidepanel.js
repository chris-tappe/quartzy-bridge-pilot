// 1. On load, check if we have saved data for this tab
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tabId = tabs[0]?.id;
  if (tabId) {
    chrome.storage.local.get([`data_${tabId}`], (result) => {
      const savedData = result[`data_${tabId}`];
      if (savedData) {
        updateUI(savedData);
        chrome.action.setBadgeText({ tabId: tabId, text: "" });
      }
    });
  }
});

// Re-render the request list when storage changes
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.saved_requests) {
    renderSavedRequestsList();
  }
});

// Listen for automated updates (live)
chrome.runtime.onMessage.addListener(async (message) => {
  if (message.type === "UPDATE_SIDE_PANEL") {
    // Only auto-update if we are actually viewing a Fisher tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url.includes("fishersci.com")) {
      updateUI(message.data);
    }
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
  const resultArea = document.getElementById('resultArea');
  const bulkTransfer = document.getElementById('bulkTransferCard');
  const statusPill = document.querySelector('.status-pill');

  if (tab.url.includes("fishersci.com")) {
    fisherView.style.display = 'block';
    quartzyView.style.display = 'none';
    if (bulkTransfer) bulkTransfer.style.display = 'none';
    // Result area will show up via updateUI if scraping works
    statusPill.innerHTML = '&bull; ACTIVE (Fisher)';
    statusPill.style.color = '#1e7e34'; // Green
  } else if (tab.url.includes("quartzy.com")) {
    fisherView.style.display = 'none';
    quartzyView.style.display = 'block';
    if (resultArea) resultArea.style.display = 'none';
    if (bulkTransfer) bulkTransfer.style.display = 'none';
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
    if (resultArea) resultArea.style.display = 'none';
    if (bulkTransfer) bulkTransfer.style.display = 'none';
    statusPill.innerHTML = '&bull; IDLE';
    statusPill.style.color = '#666';
  }
}

// Update view on load and tab change triggers
updateViewMode();
chrome.tabs.onActivated.addListener(updateViewMode);
chrome.tabs.onUpdated.addListener(updateViewMode);

renderSavedRequestsList();


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


let currentFisherData = null;

function updateUI(data) {
  const resultArea = document.getElementById('resultArea');
  if (!resultArea) return;

  if (data.catalogNumber || data.price) {
    currentFisherData = data;
    resultArea.style.display = 'block';
    document.getElementById('catNum').textContent = data.catalogNumber || "--";
    document.getElementById('priceVal').textContent = data.price || "--";

    const extraFields = document.getElementById('extraDataFields');
    if (extraFields) {
      if (data.itemName) {
        extraFields.style.display = 'block';
        const itemNameEl = document.getElementById('itemNameVal');
        if (itemNameEl) itemNameEl.textContent = data.itemName || "--";

        const unitSizeEl = document.getElementById('unitSizeVal');
        if (unitSizeEl) unitSizeEl.textContent = data.unitSize || "--";
      } else {
        extraFields.style.display = 'none';
      }
    }
  }
}

// --- List Building Logic ---
document.getElementById('addToListBtn')?.addEventListener('click', () => {
  if (!currentFisherData) return;

  chrome.storage.local.get(['saved_requests'], (result) => {
    const list = result.saved_requests || [];
    list.push(currentFisherData);

    chrome.storage.local.set({ saved_requests: list }, () => {
      const status = document.getElementById('addToListStatus');
      status.style.display = 'block';
      setTimeout(() => status.style.display = 'none', 2000);
    });
  });
});

function renderSavedRequestsList() {
  const container = document.getElementById('savedRequestsList');
  const clearBtn = document.getElementById('clearListBtn');
  if (!container) return;

  chrome.storage.local.get(['saved_requests'], (result) => {
    const list = result.saved_requests || [];

    if (list.length === 0) {
      container.innerHTML = 'No items added yet. Search Fisher and click "Add to Request List".';
      if (clearBtn) clearBtn.style.display = 'none';
      return;
    }

    if (clearBtn) clearBtn.style.display = 'block';

    const COPY_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="pointer-events: none;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;

    container.innerHTML = list.map((item, index) => `
      <div style="border: 1px solid #ddd; background: #fff; border-radius: 4px; padding: 8px; margin-bottom: 8px;">
        <div style="font-weight: bold; margin-bottom: 4px; display: flex; justify-content: space-between; align-items: flex-start;">
           <span style="display:flex; align-items:flex-start;">
             <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 160px; display: inline-block;" title="${item.itemName}">${item.itemName || 'Unknown'}</span>
             <button class="copy-btn copy-item" data-val="${item.itemName || ''}" title="Copy Name">${COPY_SVG}</button>
           </span>
           <button class="remove-item-btn" data-index="${index}" style="background: transparent; color: #cc0000; border: none; padding: 0; cursor: pointer; font-size: 14px; width: auto; margin-left: 8px;" title="Remove">&times;</button>
        </div>
        <div style="display: flex; align-items: center; justify-content: flex-start; margin-bottom: 2px;">
          <strong>Cat #:</strong> <span style="display:flex; align-items:center; margin-left:4px;">${item.catalogNumber} <button class="copy-btn copy-item" data-val="${item.catalogNumber}" title="Copy">${COPY_SVG}</button></span>
        </div>
        <div style="display: flex; align-items: center; justify-content: flex-start; margin-bottom: 2px;">
          <strong>Price:</strong> <span style="display:flex; align-items:center; margin-left:4px;">${item.price} <button class="copy-btn copy-item" data-val="${item.price}" title="Copy">${COPY_SVG}</button></span>
        </div>
        <div style="display: flex; align-items: center; justify-content: flex-start; margin-bottom: 2px;">
          <strong>Size:</strong> <span style="display:flex; align-items:center; margin-left:4px;">${item.unitSize || '--'} <button class="copy-btn copy-item" data-val="${item.unitSize || ''}" title="Copy">${COPY_SVG}</button></span>
        </div>
        ${item.url ? `
        <div style="display: flex; align-items: center; justify-content: flex-start; margin-top: 4px; border-top: 1px solid #eee; padding-top: 4px;">
           <a href="${item.url}" target="_blank" style="color: #0055a4; text-decoration: none;">View on Fisher</a>
           <button class="copy-btn copy-item" data-val="${item.url}" title="Copy Link">${COPY_SVG}</button>
        </div>
        ` : ''}
        <button class="populate-item-btn" data-index="${index}" style="margin-top: 8px; width: 100%; padding: 4px; font-weight: bold; background-color: #f1662a; color: white; border: none; border-radius: 4px; cursor: pointer;">Populate Request</button>
      </div>
    `).join('');

    // Attach copy listeners
    document.querySelectorAll('.copy-item').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const val = e.currentTarget.getAttribute('data-val');
        navigator.clipboard.writeText(val).then(() => {
          const originalHTML = e.currentTarget.innerHTML;
          e.currentTarget.innerHTML = `<span style="color:#1e7e34; font-weight:bold;">&check;</span>`;
          setTimeout(() => e.currentTarget.innerHTML = originalHTML, 1000);
        });
      });
    });

    // Attach remove listeners
    document.querySelectorAll('.remove-item-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const index = parseInt(e.target.getAttribute('data-index'), 10);
        list.splice(index, 1);
        chrome.storage.local.set({ saved_requests: list });
      });
    });

    // Attach populate listeners
    document.querySelectorAll('.populate-item-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const index = parseInt(e.target.getAttribute('data-index'), 10);
        const item = list[index];

        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs.length === 0) return;
          console.log("[Quartzy Bridge] Sending POPULATE_QUARTZY_REQUEST to tab:", tabs[0].id, item);
          chrome.tabs.sendMessage(tabs[0].id, {
            type: "POPULATE_QUARTZY_REQUEST",
            data: item
          });
        });
      });
    });
  });
}

document.getElementById('clearListBtn')?.addEventListener('click', () => {
  chrome.storage.local.set({ saved_requests: [] });
});

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