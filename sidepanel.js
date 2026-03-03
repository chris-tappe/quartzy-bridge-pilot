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
    const isFisher = tab && tab.url.includes("fishersci.com");
    const isVwr = tab && (tab.url.includes("vwr.com") || tab.url.includes("avantorsciences.com"));
    if (isFisher || isVwr) {
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

  if (tab.url.includes("fishersci.com") || tab.url.includes("vwr.com") || tab.url.includes("avantorsciences.com")) {
    const isVwr = tab.url.includes("vwr.com") || tab.url.includes("avantorsciences.com");
    fisherView.style.display = 'block';
    quartzyView.style.display = 'none';
    if (bulkTransfer) bulkTransfer.style.display = 'none';
    statusPill.innerHTML = `&bull; ACTIVE (${isVwr ? 'VWR' : 'Fisher Scientific'})`;
    statusPill.style.color = '#1e7e34'; // Green
  } else if (tab.url.includes("quartzy.com")) {
    fisherView.style.display = 'none';
    quartzyView.style.display = 'block';
    if (resultArea) resultArea.style.display = 'none';
    // Let updateSelectedItemsUI handle bulkTransfer visibility
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

const openVendorTabBtn = document.getElementById('openVendorTabBtn');
const retryVendorSearchBtn = document.getElementById('retryVendorSearchBtn');
let lastVendorSearch = null; // { catalogNumber, vendor }

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
  document.getElementById('resultArea').style.display = 'none';
  document.getElementById('fisherResult').style.display = 'none';
  document.getElementById('vwrResult').style.display = 'none';
  document.getElementById('extraDataFields').style.display = 'none';
  if (openVendorTabBtn) openVendorTabBtn.style.display = 'none';
  if (retryVendorSearchBtn) retryVendorSearchBtn.style.display = 'none';

  statusMsg.style.display = 'block';
  statusMsg.innerText = "Querying vendors...";
  statusMsg.style.color = "#666";

  // 1. Find all relevant tabs and check if we are currently on Quartzy
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isQuartzy = activeTab && activeTab.url.includes("quartzy.com");

  const fisherTabs = await chrome.tabs.query({ url: "*://*.fishersci.com/*" });
  const vwrTabs = await chrome.tabs.query({ url: ["*://*.vwr.com/*", "*://*.avantorsciences.com/*"] });

  let resultsFound = 0;
  let sharedExtras = null;

  const handleResponse = (response) => {
    if (response && response.success) {
      resultsFound++;
      if (response.vendor === "Fisher Scientific") {
        const el = document.getElementById('fisherPriceVal');
        if (el) el.textContent = response.data.price;
        document.getElementById('fisherResult').style.display = 'block';
        const addBtn = document.getElementById('addFisherToListBtn');
        if (addBtn) {
          addBtn.style.display = isQuartzy ? 'none' : 'block';
          addBtn.onclick = () => saveVendorItem(response.data, "Fisher Scientific");
        }
      } else if (response.vendor === "VWR") {
        const listEl = document.getElementById('vwrPriceList');
        if (listEl) {
          listEl.innerHTML = ''; // Clear
          if (response.data.prices && response.data.prices.length > 0) {
            response.data.prices.forEach(p => {
              const div = document.createElement('div');
              div.className = 'data-value';
              div.style.color = '#1e7e34';
              div.style.marginBottom = '4px';
              div.textContent = `${p.price} (${p.unitSize})`;
              listEl.appendChild(div);
            });
          } else {
            const div = document.createElement('div');
            div.className = 'data-value';
            div.style.color = '#1e7e34';
            div.textContent = response.data.price;
            listEl.appendChild(div);
          }
        }

        document.getElementById('vwrResult').style.display = 'block';

        // On Quartzy, if multiple prices, hide the 'Add to Request List' button
        const addBtn = document.getElementById('addVwrToListBtn');
        if (addBtn) {
          // If on Quartzy, always hide. If on VWR, hide only if multiple variants.
          if (isQuartzy || (response.data.prices && response.data.prices.length > 1)) {
            addBtn.style.display = 'none';
          } else {
            addBtn.style.display = 'block';
            addBtn.onclick = () => saveVendorItem(response.data, "VWR");
          }
        }

        // Capture name/size for extras if not already present
        if (!sharedExtras && response.data.itemName) {
          sharedExtras = {
            itemName: response.data.itemName,
            unitSize: response.data.unitSize
          };
        }
      }

      if (resultsFound > 0) {
        document.getElementById('resultArea').style.display = 'block';
        document.getElementById('catNum').textContent = catNum;
        statusMsg.style.display = 'none';

        if (sharedExtras) {
          document.getElementById('extraDataFields').style.display = 'block';
          document.getElementById('itemNameVal').textContent = sharedExtras.itemName;
          const unitSection = document.getElementById('unitSizeSection');
          if (unitSection) unitSection.style.display = isQuartzy ? 'none' : 'block';
          document.getElementById('unitSizeVal').textContent = sharedExtras.unitSize;

          const addBtn = document.getElementById('addToListBtn');
          if (addBtn) addBtn.style.display = isQuartzy ? 'none' : 'block';
        }
      }
    }
  };

  // 2. Route based on hyphen count: exactly ONE hyphen = VWR, else Fisher
  const hyphenCount = (catNum.match(/-/g) || []).length;
  const isVwrFormat = hyphenCount === 1;

  if (isVwrFormat) {
    if (vwrTabs.length > 0) {
      lastVendorSearch = { catalogNumber: catNum, vendor: "VWR" };
      statusMsg.innerText = "Querying VWR...";
      chrome.tabs.sendMessage(vwrTabs[0].id, { type: "FETCH_PRICE_ON_DEMAND", catalogNumber: catNum }, handleResponse);
    } else {
      lastVendorSearch = { catalogNumber: catNum, vendor: "VWR" };
      statusMsg.innerText = "No VWR tab open.";
      statusMsg.style.color = "#b91c1c";
      if (openVendorTabBtn && retryVendorSearchBtn) {
        openVendorTabBtn.textContent = "Open VWR to search";
        openVendorTabBtn.style.display = 'block';
        retryVendorSearchBtn.style.display = 'block';
      }
    }
  } else {
    if (fisherTabs.length > 0) {
      lastVendorSearch = { catalogNumber: catNum, vendor: "Fisher Scientific" };
      statusMsg.innerText = "Querying Fisher Scientific...";
      chrome.tabs.sendMessage(fisherTabs[0].id, { type: "FETCH_PRICE_ON_DEMAND", catalogNumber: catNum }, handleResponse);
    } else {
      lastVendorSearch = { catalogNumber: catNum, vendor: "Fisher Scientific" };
      statusMsg.innerText = "No Fisher Scientific tab open.";
      statusMsg.style.color = "#b91c1c";
      if (openVendorTabBtn && retryVendorSearchBtn) {
        openVendorTabBtn.textContent = "Open Fisher Scientific to search";
        openVendorTabBtn.style.display = 'block';
        retryVendorSearchBtn.style.display = 'block';
      }
    }
  }

  // Timeout if no results
  setTimeout(() => {
    if (resultsFound === 0 && statusMsg.style.display !== 'none') {
      statusMsg.innerText = "No prices found for this catalog number.";
      statusMsg.style.color = "orange";
    }
  }, 5000);
});

if (openVendorTabBtn) {
  openVendorTabBtn.addEventListener('click', () => {
    const statusMsg = document.getElementById('bridgeStatus');
    if (!lastVendorSearch) return;

    const vendor = lastVendorSearch.vendor;
    statusMsg.style.display = 'block';
    statusMsg.innerText = `Opening ${vendor} tab...`;
    statusMsg.style.color = "#666";

    chrome.runtime.sendMessage({ type: "OPEN_VENDOR_TAB", vendor }, (response) => {
      if (response && response.success) {
        statusMsg.innerText = `Switched to ${vendor}. Once you're signed in, click "Retry search".`;
        statusMsg.style.color = "#15803d";
      } else {
        statusMsg.innerText = `Unable to open ${vendor} tab.`;
        statusMsg.style.color = "#b91c1c";
      }
    });
  });
}

if (retryVendorSearchBtn) {
  retryVendorSearchBtn.addEventListener('click', () => {
    if (!lastVendorSearch) return;
    const input = document.getElementById('quartzyInput');
    input.value = lastVendorSearch.catalogNumber;
    document.getElementById('fetchBridgeBtn').click();
  });
}

function saveVendorItem(itemData, vendorName) {
  const fullData = {
    ...itemData,
    vendor: vendorName,
    url: vendorName === "VWR" ? `https://us.vwr.com/store/search?label=${itemData.catalogNumber}` : `https://www.fishersci.com/shop/products/search?keyword=${itemData.catalogNumber}`
  };

  // Check if we have extras on the page
  const nameEl = document.getElementById('itemNameVal');
  if (nameEl && nameEl.textContent !== "--") fullData.itemName = nameEl.textContent;
  const sizeEl = document.getElementById('unitSizeVal');
  if (sizeEl && sizeEl.textContent !== "--") fullData.unitSize = sizeEl.textContent;

  chrome.storage.local.get(['saved_requests'], (result) => {
    const list = result.saved_requests || [];
    list.push(fullData);
    chrome.storage.local.set({ saved_requests: list }, () => {
      const statusMsg = document.getElementById('bridgeStatus');
      statusMsg.style.display = 'block';
      statusMsg.innerText = `Added ${vendorName} item to list!`;
      statusMsg.style.color = "#1e7e34";
      setTimeout(() => statusMsg.style.display = 'none', 2000);
    });
  });
}


// --- Manual Scrape Removed ---


let currentFisherData = null;

async function updateUI(data) {
  const resultArea = document.getElementById('resultArea');
  if (!resultArea) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isQuartzy = tab && tab.url.includes("quartzy.com");
  const isVwrOnTab = tab && (tab.url.includes("vwr.com") || tab.url.includes("avantorsciences.com"));
  const isFisherOnTab = tab && tab.url.includes("fishersci.com");

  if (data.catalogNumber || data.price) {
    currentFisherData = data;
    resultArea.style.display = 'block';

    // Reset vendor specific sections
    // In vendor site view, only show the relevant vendor
    document.getElementById('fisherResult').style.display = isFisherOnTab ? 'block' : 'none';
    document.getElementById('vwrResult').style.display = isVwrOnTab ? 'block' : 'none';

    // Hide specialized add buttons when on vendor site (the main addToListBtn is used)
    document.getElementById('addFisherToListBtn').style.display = 'none';
    document.getElementById('addVwrToListBtn').style.display = 'none';

    // Update generic cat num
    const catSection = document.getElementById('catNumSection');
    if (catSection) catSection.style.display = isQuartzy ? 'none' : 'block';
    document.getElementById('catNum').textContent = data.catalogNumber || "--";

    if (isVwrOnTab) {
      const listEl = document.getElementById('vwrPriceList');
      if (listEl) {
        listEl.innerHTML = `<div class="data-value" style="color: #1e7e34;">${data.price || "--"}</div>`;
      }
    } else {
      document.getElementById('fisherPriceVal').textContent = data.price || "--";
    }

    const extraFields = document.getElementById('extraDataFields');
    if (extraFields) {
      if (data.itemName) {
        extraFields.style.display = 'block';
        const itemNameEl = document.getElementById('itemNameVal');
        if (itemNameEl) itemNameEl.textContent = data.itemName || "--";

        const unitSection = document.getElementById('unitSizeSection');
        if (unitSection) unitSection.style.display = isQuartzy ? 'none' : 'block';

        const unitSizeEl = document.getElementById('unitSizeVal');
        if (unitSizeEl) unitSizeEl.textContent = data.unitSize || "--";

        const addBtn = document.getElementById('addToListBtn');
        if (addBtn) addBtn.style.display = isQuartzy ? 'none' : 'block';
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
      container.innerHTML = '<div class="request-list-empty">No items added yet. Search a vendor and click "Add to Request List".</div>';
      if (clearBtn) clearBtn.style.display = 'none';
      return;
    }

    if (clearBtn) clearBtn.style.display = 'block';

    const COPY_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="pointer-events: none;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;

    container.innerHTML = list.map((item, index) => `
      <div class="request-item">
        <div class="request-item-header">
          <span class="request-item-name" title="${item.itemName || ''}">${item.itemName || 'Unknown'}</span>
          <button class="icon-btn remove-item-btn" data-index="${index}" title="Remove">
            &times;
          </button>
        </div>

        <div class="request-item-meta" style="margin-top:2px;">
          <span><strong>Vendor:</strong> ${item.vendor || 'Unknown'}</span>
          <span class="request-item-price">${item.price}</span>
        </div>

        <div class="request-item-meta" style="margin-top:2px; justify-content:space-between;">
          <span>
            <strong>Cat #:</strong>
            <span style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;">
              ${item.catalogNumber}
            </span>
          </span>
          <button class="icon-btn copy-item" data-val="${item.catalogNumber}" title="Copy catalog number">
            ${COPY_SVG}
          </button>
        </div>

        <div class="request-item-meta" style="margin-top:2px;">
          <span><strong>Size:</strong> ${item.unitSize || '--'}</span>
        </div>

        ${item.url ? `
        <div class="request-item-footer">
           <a href="${item.url}" target="_blank" class="request-item-link">
             View item page
           </a>
           <button class="icon-btn copy-item" data-val="${item.url}" title="Copy link">
             ${COPY_SVG}
           </button>
        </div>
        ` : ''}

        <button class="btn-primary populate-item-btn" data-index="${index}" style="margin-top: 8px;">
          Populate Request
        </button>
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
          const activeTab = tabs[0];
          const isQuartzyNewRequest = activeTab.url.includes("quartzy.com") && activeTab.url.includes("/requests/new");

          if (isQuartzyNewRequest) {
            console.log("[Quartzy Bridge] Sending POPULATE_QUARTZY_REQUEST to tab:", activeTab.id, item);
            chrome.tabs.sendMessage(activeTab.id, {
              type: "POPULATE_QUARTZY_REQUEST",
              data: item
            });
          } else {
            // Save to storage and navigate
            console.log("[Quartzy Bridge] Not on Quartzy. Saving pending request and navigating...");
            chrome.storage.local.set({ 'pending_quartzy_request': item }, () => {
              // Group ID is 242804 as provided by user
              const quartzyUrl = "https://app.quartzy.com/groups/242804/requests/new?lookup=false";
              chrome.tabs.update(activeTab.id, { url: quartzyUrl });
            });
          }
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
  const fisherBtn = document.getElementById('transferToFisherBtn');
  const vwrBtn = document.getElementById('transferToVwrBtn');
  const bulkCard = document.getElementById('bulkTransferCard');
  if (!listEl || !fisherBtn || !vwrBtn) return;

  if (currentQuartzySelection.length === 0) {
    listEl.innerHTML = "Check boxes in Quartzy to see items here.";
    fisherBtn.style.display = 'none';
    vwrBtn.style.display = 'none';
    if (bulkCard) bulkCard.style.display = 'none';
    return;
  }

  // Show the card if we have items
  if (bulkCard) bulkCard.style.display = 'block';

  listEl.innerHTML = currentQuartzySelection.map(item =>
    `<div style="display:flex; flex-direction: column; border-bottom:1px solid #eee; padding-bottom: 4px; margin-bottom: 4px;">
      <div style="display:flex; justify-content:space-between;">
        <span><strong>Cat #:</strong> ${item.catalogNumber}</span>
        <span><strong>Qty:</strong> ${item.quantity}</span>
      </div>
      <div style="font-size: 10px; color: #888;">Vendor: ${item.vendor}</div>
    </div>`
  ).join('');

  // Determine button visibility
  const allFisher = currentQuartzySelection.every(item => item.vendor === "Fisher Scientific");
  const allVwr = currentQuartzySelection.every(item => item.vendor === "VWR");

  fisherBtn.style.display = allFisher ? 'block' : 'none';
  vwrBtn.style.display = allVwr ? 'block' : 'none';

  if (allFisher) {
    fisherBtn.innerText = `Transfer ${currentQuartzySelection.length} to Fisher`;
  } else if (allVwr) {
    vwrBtn.innerText = `Transfer ${currentQuartzySelection.length} to VWR`;
  } else {
    // Mixed or Unknown
    fisherBtn.style.display = 'none';
    vwrBtn.style.display = 'none';
    listEl.innerHTML += `<div style="color: red; font-size: 11px; margin-top: 5px;">Mixed vendors selected. Please select only Fisher or only VWR items.</div>`;
  }
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

const vwrTransferBtnEl = document.getElementById('transferToVwrBtn');
if (vwrTransferBtnEl) {
  vwrTransferBtnEl.addEventListener('click', () => {
    const statusMsg = document.getElementById('transferStatus');
    if (currentQuartzySelection.length === 0) return;

    statusMsg.style.display = 'block';
    statusMsg.innerText = "Saving items to storage...";
    statusMsg.style.color = "#666";

    chrome.storage.local.set({ 'vwr_order_queue': currentQuartzySelection }, () => {
      statusMsg.innerText = "Opening VWR Quick Order...";
      chrome.tabs.create({ url: "https://www.avantorsciences.com/us/en/my-account/quick-order" }, () => {
        statusMsg.style.display = 'none';
      });
    });
  });
}