// 1. On load, updateViewMode (called below) will refresh for the active tab

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

async function refreshForActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const result = await chrome.storage.local.get([`data_${tab.id}`]);
  const savedData = result[`data_${tab.id}`];
  if (savedData) {
    updateUI(savedData);
    chrome.action.setBadgeText({ tabId: tab.id, text: "" });
  } else {
    // No saved data for this tab - show empty vendor state
    const isVendor = tab.url && (tab.url.includes("fishersci.com") || tab.url.includes("vwr.com") || tab.url.includes("avantorsciences.com"));
    if (isVendor) {
      showEmptyVendorState(tab);
    }
  }
}

function showEmptyVendorState(tab) {
  const resultArea = document.getElementById('resultArea');
  if (!resultArea) return;
  const isVwr = tab.url.includes("vwr.com") || tab.url.includes("avantorsciences.com");
  resultArea.style.display = 'block';
  document.getElementById('fisherResult').style.display = !isVwr ? 'block' : 'none';
  document.getElementById('vwrResult').style.display = isVwr ? 'block' : 'none';
  document.getElementById('fisherPriceContent').style.display = 'none';
  document.getElementById('fisherNoTab').style.display = 'none';
  document.getElementById('fisherNoPrice').style.display = !isVwr ? 'block' : 'none';
  document.getElementById('fisherLoading').style.display = 'none';
  document.getElementById('vwrPriceContent').style.display = 'none';
  document.getElementById('vwrNoTab').style.display = 'none';
  document.getElementById('vwrNoPrice').style.display = isVwr ? 'block' : 'none';
  document.getElementById('vwrLoading').style.display = 'none';
  document.getElementById('extraDataFields').style.display = 'none';
}

async function updateViewMode() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  const fisherView = document.getElementById('fisher-view');
  const quartzyView = document.getElementById('quartzy-view');
  const resultArea = document.getElementById('resultArea');
  const bulkTransfer = document.getElementById('bulkTransferCard');
  const statusPill = document.querySelector('.status-pill');

  if (tab.url && (tab.url.includes("fishersci.com") || tab.url.includes("vwr.com") || tab.url.includes("avantorsciences.com"))) {
    const isVwr = tab.url.includes("vwr.com") || tab.url.includes("avantorsciences.com");
    fisherView.style.display = 'block';
    quartzyView.style.display = 'none';
    if (bulkTransfer) bulkTransfer.style.display = 'none';
    statusPill.innerHTML = `&bull; ACTIVE (${isVwr ? 'VWR' : 'Fisher Scientific'})`;
    statusPill.style.color = '#1e7e34'; // Green
    await refreshForActiveTab();
  } else if (tab.url && tab.url.includes("quartzy.com")) {
    fisherView.style.display = 'none';
    quartzyView.style.display = 'block';
    // Do not hide resultArea on Quartzy so "Fetch Price" result card stays visible after opening a vendor tab
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
let lastVendorSearch = null; // { catalogNumber, vendor? }

// --- Quartzy Bridge Logic ---

document.getElementById('fetchBridgeBtn').addEventListener('click', async () => {
  const input = document.getElementById('quartzyInput');
  const statusMsg = document.getElementById('bridgeStatus');
  const catNum = input.value.trim();

  if (!catNum) {
    alert("Please enter a catalog number.");
    return;
  }

  // Reset UI: show result card and both vendor sections; we'll set each section to loading / no-tab / price
  const resultArea = document.getElementById('resultArea');
  const fisherPriceContent = document.getElementById('fisherPriceContent');
  const fisherNoTab = document.getElementById('fisherNoTab');
  const fisherNoPrice = document.getElementById('fisherNoPrice');
  const fisherLoading = document.getElementById('fisherLoading');
  const vwrPriceContent = document.getElementById('vwrPriceContent');
  const vwrNoTab = document.getElementById('vwrNoTab');
  const vwrNoPrice = document.getElementById('vwrNoPrice');
  const vwrLoading = document.getElementById('vwrLoading');

  resultArea.style.display = 'block';
  document.getElementById('extraDataFields').style.display = 'none';
  document.getElementById('addToListBtn').style.display = 'none';
  if (openVendorTabBtn) openVendorTabBtn.style.display = 'none';

  // Always show both vendor sections; each will show one of: price, no-tab prompt, or no price found
  const fisherBlock = document.getElementById('fisherResult');
  const vwrBlock = document.getElementById('vwrResult');
  if (fisherBlock) fisherBlock.style.display = 'block';
  if (vwrBlock) vwrBlock.style.display = 'block';

  fisherPriceContent.style.display = 'none';
  fisherNoTab.style.display = 'none';
  fisherNoPrice.style.display = 'none';
  fisherLoading.style.display = 'none';
  vwrPriceContent.style.display = 'none';
  vwrNoTab.style.display = 'none';
  vwrNoPrice.style.display = 'none';
  vwrLoading.style.display = 'none';

  statusMsg.style.display = 'none';

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isQuartzy = activeTab && activeTab.url.includes("quartzy.com");
  const fisherTabs = await chrome.tabs.query({ url: "*://*.fishersci.com/*" });
  const vwrTabs = await chrome.tabs.query({ url: ["*://*.vwr.com/*", "*://*.avantorsciences.com/*"] });

  let sharedExtras = null;
  let pending = (fisherTabs.length ? 1 : 0) + (vwrTabs.length ? 1 : 0);
  let fisherSettled = false;
  let vwrSettled = false;

  function checkDone() {
    if (pending > 0) return;
    statusMsg.style.display = 'none';
  }

  function applyFisherResult(response) {
    if (fisherSettled) return;
    fisherSettled = true;
    fisherLoading.style.display = 'none';
    pending--;
    if (response && response.success && response.vendor === "Fisher Scientific") {
      const el = document.getElementById('fisherPriceVal');
      if (el) el.textContent = response.data.price || "--";
      fisherPriceContent.style.display = 'block';
      const catalogEl = document.getElementById('fisherCatalogNum');
      if (catalogEl) {
        const cn = response.data.catalogNumber || catNum;
        if (cn) {
          catalogEl.textContent = `Catalog: ${cn}`;
          catalogEl.style.display = 'block';
        } else {
          catalogEl.style.display = 'none';
        }
      }
      const nameEl = document.getElementById('fisherItemName');
      if (nameEl) {
        if (response.data.itemName) {
          nameEl.textContent = response.data.itemName;
          nameEl.style.display = 'block';
        } else {
          nameEl.style.display = 'none';
        }
      }
      const addBtn = document.getElementById('addFisherToListBtn');
      if (addBtn) {
        addBtn.style.display = isQuartzy ? 'none' : 'block';
        addBtn.onclick = () => saveVendorItem(response.data, "Fisher Scientific");
      }
      const openBtn = document.getElementById('fisherOpenInTabBtn');
      if (openBtn && fisherTabs.length > 0) {
        openBtn.style.display = 'block';
        const catalogNumber = response.data.catalogNumber || catNum;
        const tabId = fisherTabs[0].id;
        openBtn.onclick = () => {
          openBtn.style.display = 'none';
          const url = `https://www.fishersci.com/us/en/catalog/search/products?keyword=${encodeURIComponent(catNum)}`;
          chrome.tabs.update(tabId, { url, active: true });
          const onTabUpdated = (tid, changeInfo) => {
            if (tid !== tabId || changeInfo.status !== 'complete') return;
            chrome.tabs.onUpdated.removeListener(onTabUpdated);
            function updateFisherUI(res) {
              if (!res?.data) return;
              const el = document.getElementById('fisherPriceVal');
              if (el) el.textContent = res.data.price || '--';
              const catalogEl = document.getElementById('fisherCatalogNum');
              if (catalogEl && res.data.catalogNumber) {
                catalogEl.textContent = `Catalog: ${res.data.catalogNumber}`;
                catalogEl.style.display = 'block';
              }
              const nameEl = document.getElementById('fisherItemName');
              if (nameEl && res.data.itemName) {
                nameEl.textContent = res.data.itemName;
                nameEl.style.display = 'block';
              }
            }
            chrome.tabs.sendMessage(tabId, { type: "FETCH_PRICE_ON_DEMAND", catalogNumber: catNum }, (response) => {
              if (chrome.runtime.lastError) response = null;
              if (fisherDirectSucceeded(response)) {
                updateFisherUI(response);
                return;
              }
              chrome.runtime.sendMessage(
                { type: "RESOLVE_FISHER_CATALOG_NUMBER", query: catNum, tabId: activeTab?.id },
                (resolveResponse) => {
                  const resolved = (resolveResponse && resolveResponse.success && resolveResponse.catalogNumber)
                    ? resolveResponse.catalogNumber
                    : catNum;
                  chrome.tabs.sendMessage(tabId, { type: "FETCH_PRICE_ON_DEMAND", catalogNumber: resolved }, (fallbackResponse) => {
                    if (chrome.runtime.lastError) fallbackResponse = null;
                    updateFisherUI(fallbackResponse || { data: {} });
                  });
                }
              );
            });
          };
          chrome.tabs.onUpdated.addListener(onTabUpdated);
        };
      }
      if (!sharedExtras && response.data.unitSize) {
        sharedExtras = { unitSize: response.data.unitSize };
        maybeShowExtras();
      }
    } else {
      fisherNoPrice.style.display = 'block';
    }
    checkDone();
  }

  function applyVwrResult(response) {
    if (vwrSettled) return;
    vwrSettled = true;
    vwrLoading.style.display = 'none';
    pending--;
    if (response && response.success && response.vendor === "VWR") {
      const listEl = document.getElementById('vwrPriceList');
      if (listEl) {
        listEl.innerHTML = '';
        if (response.data.prices && response.data.prices.length > 0) {
          response.data.prices.forEach(p => {
            const div = document.createElement('div');
            div.className = 'price-primary';
            div.textContent = `${p.price} (${p.unitSize})`;
            listEl.appendChild(div);
          });
        } else {
          const div = document.createElement('div');
          div.className = 'price-primary';
          div.textContent = response.data.price || "--";
          listEl.appendChild(div);
        }
      }
      vwrPriceContent.style.display = 'block';
      const catalogEl = document.getElementById('vwrCatalogNum');
      if (catalogEl) {
        const cn = response.data.catalogNumber || catNum;
        if (cn) {
          catalogEl.textContent = `Catalog: ${cn}`;
          catalogEl.style.display = 'block';
        } else {
          catalogEl.style.display = 'none';
        }
      }
      const nameEl = document.getElementById('vwrItemName');
      if (nameEl) {
        if (response.data.itemName) {
          nameEl.textContent = response.data.itemName;
          nameEl.style.display = 'block';
        } else {
          nameEl.style.display = 'none';
        }
      }
      const addBtn = document.getElementById('addVwrToListBtn');
      if (addBtn) {
        addBtn.style.display = isQuartzy ? 'none' : 'block';
        addBtn.onclick = () => saveVendorItem(response.data, "VWR");
      }
      const openBtn = document.getElementById('vwrOpenInTabBtn');
      if (openBtn && vwrTabs.length > 0) {
        openBtn.style.display = 'block';
        const catalogNumber = response.data.catalogNumber || catNum;
        const tabId = vwrTabs[0].id;
        openBtn.onclick = () => {
          openBtn.style.display = 'none';
          const url = `https://www.avantorsciences.com/us/en/search/${encodeURIComponent(catNum)}`;
          chrome.tabs.update(tabId, { url, active: true });
          const onTabUpdated = (tid, changeInfo) => {
            if (tid !== tabId || changeInfo.status !== 'complete') return;
            chrome.tabs.onUpdated.removeListener(onTabUpdated);
            function updateVwrUI(res) {
              if (!res?.data) return;
              const listEl = document.getElementById('vwrPriceList');
              if (listEl) {
                listEl.innerHTML = '';
                if (res.data.prices?.length) {
                  res.data.prices.forEach(p => {
                    const div = document.createElement('div');
                    div.className = 'price-primary';
                    div.textContent = `${p.price} (${p.unitSize})`;
                    listEl.appendChild(div);
                  });
                } else {
                  const div = document.createElement('div');
                  div.className = 'price-primary';
                  div.textContent = res.data.price || '--';
                  listEl.appendChild(div);
                }
              }
              const catalogEl = document.getElementById('vwrCatalogNum');
              if (catalogEl && res.data.catalogNumber) {
                catalogEl.textContent = `Catalog: ${res.data.catalogNumber}`;
                catalogEl.style.display = 'block';
              }
              const nameEl = document.getElementById('vwrItemName');
              if (nameEl && res.data.itemName) {
                nameEl.textContent = res.data.itemName;
                nameEl.style.display = 'block';
              }
            }
            chrome.tabs.sendMessage(tabId, { type: "FETCH_PRICE_ON_DEMAND", catalogNumber: catNum }, (response) => {
              if (chrome.runtime.lastError) response = null;
              if (vwrDirectSucceeded(response)) {
                updateVwrUI(response);
                return;
              }
              chrome.runtime.sendMessage({ type: "RESOLVE_VWR_CATALOG_NUMBER", query: catNum }, (resolveResponse) => {
                const resolved = (resolveResponse && resolveResponse.success && resolveResponse.vwrCatalogNumber)
                  ? resolveResponse.vwrCatalogNumber
                  : catNum;
                chrome.tabs.sendMessage(tabId, { type: "FETCH_PRICE_ON_DEMAND", catalogNumber: resolved }, (fallbackResponse) => {
                  if (chrome.runtime.lastError) fallbackResponse = null;
                  updateVwrUI(fallbackResponse || { data: {} });
                });
              });
            });
          };
          chrome.tabs.onUpdated.addListener(onTabUpdated);
        };
      }
      if (!sharedExtras && response.data.unitSize) {
        sharedExtras = { unitSize: response.data.unitSize };
        maybeShowExtras();
      }
    } else {
      vwrNoPrice.style.display = 'block';
    }
    checkDone();
  }

  // Strict logic pipeline: raw query, direct API in parallel per vendor; on fail or 0 results, run fallback then retry direct.

  function fisherDirectSucceeded(response) {
    return response && response.success && response.vendor === "Fisher Scientific" && response.data?.price;
  }
  function vwrDirectSucceeded(response) {
    if (!response || !response.success || response.vendor !== "VWR") return false;
    const d = response.data;
    return !!(d?.price || (d?.prices && d.prices.length > 0));
  }

  if (fisherTabs.length > 0) {
    fisherLoading.style.display = 'block';
    chrome.tabs.sendMessage(fisherTabs[0].id, { type: "FETCH_PRICE_ON_DEMAND", catalogNumber: catNum }, (response) => {
      if (chrome.runtime.lastError) response = null;
      try {
        if (fisherDirectSucceeded(response)) {
          applyFisherResult(response);
          return;
        }
      } catch (_) { /* ignore */ }
      chrome.runtime.sendMessage(
        { type: "RESOLVE_FISHER_CATALOG_NUMBER", query: catNum, tabId: activeTab?.id },
        (resolveResponse) => {
          try {
            const resolved = (resolveResponse && resolveResponse.success && resolveResponse.catalogNumber)
              ? resolveResponse.catalogNumber
              : catNum;
            chrome.tabs.sendMessage(fisherTabs[0].id, { type: "FETCH_PRICE_ON_DEMAND", catalogNumber: resolved }, (fallbackResponse) => {
              if (chrome.runtime.lastError) fallbackResponse = null;
              try {
                applyFisherResult(fallbackResponse);
              } catch (e) {
                applyFisherResult(null);
              }
            });
          } catch (e) {
            applyFisherResult(null);
          }
        }
      );
    });
  } else {
    fisherNoTab.style.display = 'block';
    pending--;
    checkDone();
  }

  if (vwrTabs.length > 0) {
    vwrLoading.style.display = 'block';
    chrome.tabs.sendMessage(vwrTabs[0].id, { type: "FETCH_PRICE_ON_DEMAND", catalogNumber: catNum }, (response) => {
      if (chrome.runtime.lastError) response = null;
      try {
        if (vwrDirectSucceeded(response)) {
          applyVwrResult(response);
          return;
        }
      } catch (_) { /* ignore */ }
      chrome.runtime.sendMessage({ type: "RESOLVE_VWR_CATALOG_NUMBER", query: catNum }, (resolveResponse) => {
        try {
          const resolved = (resolveResponse && resolveResponse.success && resolveResponse.vwrCatalogNumber)
            ? resolveResponse.vwrCatalogNumber
            : catNum;
          chrome.tabs.sendMessage(vwrTabs[0].id, { type: "FETCH_PRICE_ON_DEMAND", catalogNumber: resolved }, (fallbackResponse) => {
            if (chrome.runtime.lastError) fallbackResponse = null;
            try {
              applyVwrResult(fallbackResponse);
            } catch (e) {
              applyVwrResult(null);
            }
          });
        } catch (e) {
          applyVwrResult(null);
        }
      });
    });
  } else {
    vwrNoTab.style.display = 'block';
    pending--;
    checkDone();
  }

  lastVendorSearch = { catalogNumber: catNum };
  if (pending === 0) checkDone();

  // Show shared unit size when we have it from either vendor (item names are shown per-vendor)
  function maybeShowExtras() {
    if (!sharedExtras) return;
    document.getElementById('extraDataFields').style.display = 'block';
    const unitSection = document.getElementById('unitSizeSection');
    if (unitSection) unitSection.style.display = isQuartzy ? 'none' : 'block';
    document.getElementById('unitSizeVal').textContent = sharedExtras.unitSize || "--";
  }

  // Timeout: if a pipeline never settles (primary + fallback both hung), show no price and settle once
  setTimeout(() => {
    if (!fisherSettled && fisherLoading.style.display === 'block') {
      fisherSettled = true;
      fisherLoading.style.display = 'none';
      fisherNoPrice.style.display = 'block';
      pending--;
      checkDone();
    }
    if (!vwrSettled && vwrLoading.style.display === 'block') {
      vwrSettled = true;
      vwrLoading.style.display = 'none';
      vwrNoPrice.style.display = 'block';
      pending--;
      checkDone();
    }
    if (statusMsg.style.display !== 'none') statusMsg.style.display = 'none';
  }, 8000);
});

function applyFisherResultFromOpenTab(response, catNum) {
  const fisherPriceContent = document.getElementById('fisherPriceContent');
  const fisherNoPrice = document.getElementById('fisherNoPrice');
  const fisherLoading = document.getElementById('fisherLoading');
  fisherLoading.style.display = 'none';
  if (response && response.success && response.vendor === "Fisher Scientific" && response.data?.price) {
    const el = document.getElementById('fisherPriceVal');
    if (el) el.textContent = response.data.price || "--";
    fisherPriceContent.style.display = 'block';
    const catalogEl = document.getElementById('fisherCatalogNum');
    if (catalogEl) {
      const cn = response.data.catalogNumber || catNum;
      catalogEl.textContent = cn ? `Catalog: ${cn}` : "";
      catalogEl.style.display = cn ? 'block' : 'none';
    }
    const nameEl = document.getElementById('fisherItemName');
    if (nameEl && response.data.itemName) {
      nameEl.textContent = response.data.itemName;
      nameEl.style.display = 'block';
    }
    const addBtn = document.getElementById('addFisherToListBtn');
    if (addBtn) {
      addBtn.style.display = 'none';
      addBtn.onclick = () => saveVendorItem(response.data, "Fisher Scientific");
    }
    if (response.data.unitSize) {
      const extraFields = document.getElementById('extraDataFields');
      if (extraFields) {
        extraFields.style.display = 'block';
        const unitEl = document.getElementById('unitSizeVal');
        if (unitEl) unitEl.textContent = response.data.unitSize;
      }
    }
  } else {
    fisherNoPrice.style.display = 'block';
  }
}

function applyVwrResultFromOpenTab(response, catNum) {
  const vwrPriceContent = document.getElementById('vwrPriceContent');
  const vwrNoPrice = document.getElementById('vwrNoPrice');
  const vwrLoading = document.getElementById('vwrLoading');
  vwrLoading.style.display = 'none';
  if (response && response.success && response.vendor === "VWR" && (response.data?.price || response.data?.prices?.length)) {
    const listEl = document.getElementById('vwrPriceList');
    if (listEl) {
      listEl.innerHTML = '';
      if (response.data.prices?.length) {
        response.data.prices.forEach(p => {
          const div = document.createElement('div');
          div.className = 'price-primary';
          div.textContent = `${p.price} (${p.unitSize})`;
          listEl.appendChild(div);
        });
      } else {
        const div = document.createElement('div');
        div.className = 'price-primary';
        div.textContent = response.data.price || "--";
        listEl.appendChild(div);
      }
    }
    vwrPriceContent.style.display = 'block';
    const catalogEl = document.getElementById('vwrCatalogNum');
    if (catalogEl) {
      const cn = response.data.catalogNumber || catNum;
      catalogEl.textContent = cn ? `Catalog: ${cn}` : "";
      catalogEl.style.display = cn ? 'block' : 'none';
    }
    const nameEl = document.getElementById('vwrItemName');
    if (nameEl && response.data.itemName) {
      nameEl.textContent = response.data.itemName;
      nameEl.style.display = 'block';
    }
    const addBtn = document.getElementById('addVwrToListBtn');
    if (addBtn) {
      addBtn.style.display = 'none';
      addBtn.onclick = () => saveVendorItem(response.data, "VWR");
    }
    if (response.data.unitSize) {
      const extraFields = document.getElementById('extraDataFields');
      if (extraFields) {
        extraFields.style.display = 'block';
        const unitEl = document.getElementById('unitSizeVal');
        if (unitEl) unitEl.textContent = response.data.unitSize;
      }
    }
  } else {
    vwrNoPrice.style.display = 'block';
  }
}

function runFetchAfterTabReady(vendor, tabId, catalogNumber, created, statusMsg, onComplete) {
  const isFisher = vendor === "Fisher Scientific";
  const fisherLoading = document.getElementById('fisherLoading');
  const vwrLoading = document.getElementById('vwrLoading');
  if (isFisher) {
    fisherLoading.style.display = 'block';
  } else {
    vwrLoading.style.display = 'block';
  }
  statusMsg.innerText = created ? `Opening ${vendor} tab, fetching price...` : `Fetching price from ${vendor}...`;

  function doFetch() {
    statusMsg.style.display = 'none';
    if (isFisher) {
      chrome.tabs.sendMessage(tabId, { type: "FETCH_PRICE_ON_DEMAND", catalogNumber }, (response) => {
        if (chrome.runtime.lastError) response = null;
        if (response && response.success && response.vendor === "Fisher Scientific" && response.data?.price) {
          onComplete(response);
          return;
        }
        chrome.tabs.query({ active: true, currentWindow: true }, ([activeTab]) => {
          chrome.runtime.sendMessage(
            { type: "RESOLVE_FISHER_CATALOG_NUMBER", query: catalogNumber, tabId: activeTab?.id },
            (resolveResponse) => {
              const resolved = (resolveResponse?.success && resolveResponse.catalogNumber) ? resolveResponse.catalogNumber : catalogNumber;
              chrome.tabs.sendMessage(tabId, { type: "FETCH_PRICE_ON_DEMAND", catalogNumber: resolved }, (fallbackResponse) => {
                if (chrome.runtime.lastError) fallbackResponse = null;
                onComplete(fallbackResponse || { data: {} });
              });
            }
          );
        });
      });
    } else {
      chrome.tabs.sendMessage(tabId, { type: "FETCH_PRICE_ON_DEMAND", catalogNumber }, (response) => {
        if (chrome.runtime.lastError) response = null;
        if (response && response.success && response.vendor === "VWR" && (response.data?.price || response.data?.prices?.length)) {
          onComplete(response);
          return;
        }
        chrome.runtime.sendMessage({ type: "RESOLVE_VWR_CATALOG_NUMBER", query: catalogNumber }, (resolveResponse) => {
          const resolved = (resolveResponse?.success && resolveResponse.vwrCatalogNumber) ? resolveResponse.vwrCatalogNumber : catalogNumber;
          chrome.tabs.sendMessage(tabId, { type: "FETCH_PRICE_ON_DEMAND", catalogNumber: resolved }, (fallbackResponse) => {
            if (chrome.runtime.lastError) fallbackResponse = null;
            onComplete(fallbackResponse || { data: {} });
          });
        });
      });
    }
  }

  if (created) {
    let done = false;
    const runFetch = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onTabUpdated);
      doFetch();
    };
    const onTabUpdated = (tid, changeInfo) => {
      if (tid !== tabId || changeInfo.status !== 'complete') return;
      runFetch();
    };
    chrome.tabs.onUpdated.addListener(onTabUpdated);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') runFetch();
    }).catch(() => {});
    setTimeout(() => runFetch(), 15000);
  } else {
    doFetch();
  }
}

function openVendorAndPrompt(vendor, statusMsg, catalogNumber) {
  statusMsg.style.display = 'block';
  statusMsg.innerText = `Opening ${vendor} tab...`;
  statusMsg.style.color = "#666";
  chrome.runtime.sendMessage({ type: "OPEN_VENDOR_TAB", vendor }, (response) => {
    if (response && response.success) {
      if (catalogNumber) {
        const isFisher = vendor === "Fisher Scientific";
        const onComplete = isFisher ? (r) => applyFisherResultFromOpenTab(r, catalogNumber) : (r) => applyVwrResultFromOpenTab(r, catalogNumber);
        runFetchAfterTabReady(vendor, response.tabId, catalogNumber, response.created, statusMsg, onComplete);
      } else {
        statusMsg.style.display = 'none';
      }
    } else {
      statusMsg.innerText = `Unable to open ${vendor} tab.`;
      statusMsg.style.color = "#b91c1c";
    }
  });
}

const openFisherTabBtn = document.getElementById('openFisherTabBtn');
const openVwrTabBtn = document.getElementById('openVwrTabBtn');
if (openFisherTabBtn) {
  openFisherTabBtn.addEventListener('click', () => {
    const fisherNoTab = document.getElementById('fisherNoTab');
    if (fisherNoTab) fisherNoTab.style.display = 'none';
    const statusMsg = document.getElementById('bridgeStatus');
    const catalogNumber = lastVendorSearch?.catalogNumber || document.getElementById('quartzyInput')?.value?.trim();
    openVendorAndPrompt("Fisher Scientific", statusMsg, catalogNumber);
  });
}
if (openVwrTabBtn) {
  openVwrTabBtn.addEventListener('click', () => {
    const vwrNoTab = document.getElementById('vwrNoTab');
    if (vwrNoTab) vwrNoTab.style.display = 'none';
    const statusMsg = document.getElementById('bridgeStatus');
    const catalogNumber = lastVendorSearch?.catalogNumber || document.getElementById('quartzyInput')?.value?.trim();
    openVendorAndPrompt("VWR", statusMsg, catalogNumber);
  });
}

if (openVendorTabBtn) {
  openVendorTabBtn.addEventListener('click', () => {
    const statusMsg = document.getElementById('bridgeStatus');
    if (!lastVendorSearch || !lastVendorSearch.vendor) return;
    openVendorAndPrompt(lastVendorSearch.vendor, statusMsg, lastVendorSearch.catalogNumber);
  });
}

function saveVendorItem(itemData, vendorName) {
  const fullData = {
    ...itemData,
    vendor: vendorName,
    url: vendorName === "VWR" ? `https://www.avantorsciences.com/us/en/search/${encodeURIComponent(itemData.catalogNumber)}` : `https://www.fishersci.com/us/en/catalog/search/products?keyword=${encodeURIComponent(itemData.catalogNumber)}`
  };

  // Use item name from the vendor result we're saving (already in itemData)
  if (itemData.itemName) fullData.itemName = itemData.itemName;
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

    // In vendor site view, only show the relevant vendor block and its price content
    const fisherResult = document.getElementById('fisherResult');
    const vwrResult = document.getElementById('vwrResult');
    fisherResult.style.display = isFisherOnTab ? 'block' : 'none';
    vwrResult.style.display = isVwrOnTab ? 'block' : 'none';

    document.getElementById('fisherPriceContent').style.display = isFisherOnTab ? 'block' : 'none';
    document.getElementById('fisherNoTab').style.display = 'none';
    document.getElementById('fisherNoPrice').style.display = 'none';
    document.getElementById('fisherLoading').style.display = 'none';
    document.getElementById('vwrPriceContent').style.display = isVwrOnTab ? 'block' : 'none';
    document.getElementById('vwrNoTab').style.display = 'none';
    document.getElementById('vwrNoPrice').style.display = 'none';
    document.getElementById('vwrLoading').style.display = 'none';

    document.getElementById('addFisherToListBtn').style.display = 'none';
    document.getElementById('addVwrToListBtn').style.display = 'none';

    const cn = data.catalogNumber || "--";
    const fisherCatEl = document.getElementById('fisherCatalogNum');
    const vwrCatEl = document.getElementById('vwrCatalogNum');
    if (fisherCatEl) {
      if (isFisherOnTab && cn !== "--") {
        fisherCatEl.textContent = `Catalog: ${cn}`;
        fisherCatEl.style.display = 'block';
      } else {
        fisherCatEl.style.display = 'none';
      }
    }
    if (vwrCatEl) {
      if (isVwrOnTab && cn !== "--") {
        vwrCatEl.textContent = `Catalog: ${cn}`;
        vwrCatEl.style.display = 'block';
      } else {
        vwrCatEl.style.display = 'none';
      }
    }

    if (isVwrOnTab) {
      const listEl = document.getElementById('vwrPriceList');
      if (listEl) listEl.innerHTML = `<div class="price-primary">${data.price || "--"}</div>`;
    } else {
      document.getElementById('fisherPriceVal').textContent = data.price || "--";
    }

    const extraFields = document.getElementById('extraDataFields');
    if (extraFields) {
      if (data.itemName || data.unitSize) {
        extraFields.style.display = 'block';
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
    // Per-vendor item name (when viewing side panel on a vendor tab)
    const fisherNameEl = document.getElementById('fisherItemName');
    const vwrNameEl = document.getElementById('vwrItemName');
    if (fisherNameEl) {
      if (isFisherOnTab && data.itemName) {
        fisherNameEl.textContent = data.itemName;
        fisherNameEl.style.display = 'block';
      } else {
        fisherNameEl.style.display = 'none';
      }
    }
    if (vwrNameEl) {
      if (isVwrOnTab && data.itemName) {
        vwrNameEl.textContent = data.itemName;
        vwrNameEl.style.display = 'block';
      } else {
        vwrNameEl.style.display = 'none';
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