console.log("[Quartzy Bridge] Content Script Loaded");
// Regex to extract Fisher Catalog Number from URL (matches vendors.json)
// Example: .../products/stripette.../07200574?crossRef... -> 07200574
const fisherUrlRegex = /products\/[^\/]+\/([^?#]+)/;
let vwrInterceptedData = null;
let vwrPriceDetailsData = null; // Logged-in contract prices from priceDetails API
let vwrAuthToken = null;

// VWR interceptor is injected at document_start via vwr_interceptor_injector.js
// Listen for intercepted data from the main world
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data && event.data.type === "VWR_INTERCEPTED_DATA") {
    console.log("[Quartzy Bridge] Received data from Interceptor:", event.data.data);
    vwrInterceptedData = event.data.data;
    scrapeVendorData(); // Trigger immediate update
  }
  if (event.data && event.data.type === "VWR_TOKEN_UPDATE") {
    vwrAuthToken = event.data.token;
    console.log("[Quartzy Bridge] VWR Auth Token Updated");
  }
  if (event.data && event.data.type === "VWR_PRICE_DETAILS_INTERCEPTED") {
    vwrPriceDetailsData = event.data.data;
    console.log("[Quartzy Bridge] Received priceDetails (logged-in) data:", event.data.data);
    scrapeVendorData();
  }
});

function extractUnitSize() {
  const url = window.location.href;
  const isVwr = url.includes("vwr.com") || url.includes("avantorsciences.com");

  if (isVwr) {
    // 1. Check for selected buttons (modern layout)
    const selectedBtn = document.querySelector('.option-button.selected');
    if (selectedBtn) return selectedBtn.innerText.trim();

    // 2. Check for UOM in the buy box/price area
    const uomEl = document.querySelector('.selection-wrapper .selected, .select-options .selected');
    if (uomEl) return uomEl.innerText.trim();

    // 3. Fallback to desktop description parsing (legacy layout)
    const desktopOnly = Array.from(document.querySelectorAll('.desktop-only, .font-bold.desktop-only, .unit-measure'));
    const unitEl = desktopOnly.find(el => {
      const txt = el.innerText.trim();
      return txt && !txt.includes('$') && txt.length > 0 && txt.length < 30;
    });
    if (unitEl) return unitEl.innerText.trim();
  }

  // Fisher Specific logic
  const unitString = document.querySelector('.unit_string');
  if (unitString && unitString.innerText) {
    return unitString.innerText.trim().replace(/^\/\s*/, '');
  }

  // 2. Try attribute button (common in some Fisher layouts)
  const quantityBtn = document.querySelector('.attributeButton.Quantity.selected');
  if (quantityBtn && quantityBtn.getAttribute('data-selector')) {
    return quantityBtn.getAttribute('data-selector').trim().replace(/^\/\s*/, '');
  }

  // 3. Try standard unitText itemprop
  const unitText = document.querySelector('span[itemprop="unitText"]');
  if (unitText && unitText.innerText) {
    return unitText.innerText.trim().replace(/^\/\s*/, '');
  }

  // 4. Try the webprice container (which often has the / prefix)
  const webPriceDesc = Array.from(document.querySelectorAll('.webprice-container span')).find(
    el => el.innerText && el.innerText.trim().startsWith('/')
  );
  if (webPriceDesc) {
    return webPriceDesc.innerText.trim().replace(/^\/\s*/, '');
  }

  // 5. General matching
  const packaging = document.querySelector('.packaging, .unit-size, [id*="unitSize"]');
  if (packaging && packaging.innerText) {
    return packaging.innerText.trim().replace(/^\/\s*/, '');
  }

  return "Each";
}

/**
 * Extract display price from Fisher API product object.
 * Priority: contractPrice (logged-in) → price → listPrice → totalPrice (fallback).
 */
function getFisherPrice(productData) {
  if (!productData) return null;
  const raw = productData.contractPrice ?? productData.price ?? productData.listPrice ?? productData.totalPrice;
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") return "$" + raw.toFixed(2);
  const s = String(raw).trim();
  return s || null;
}

function run() {
  const url = window.location.href;
  const isVwr = url.includes("vwr.com") || url.includes("avantorsciences.com");

  if (isVwr) {
    console.log("[Quartzy Bridge] Detected VWR/Avantor. Start polling...");
    startPolling();
    return;
  }

  const match = url.match(fisherUrlRegex);

  if (match && match[1]) {
    const catalogNumber = match[1];
    console.log(`[Quartzy Bridge] Found Catalog Number in URL: ${catalogNumber}. Attempting API Fetch...`);

    // Attempt API Fetch directly from Content Script
    fetchPriceFromApi(catalogNumber);
  } else {
    // Fallback to DOM Scraping
    console.log("[Quartzy Bridge] No Cat# in URL, falling back to DOM scrape.");
    startPolling();
  }
}



function fetchPriceFromApi(catalogNumber) {
  const apiUrl = "https://www.fishersci.com/shop/products/service/pricing";
  console.log(`[Quartzy Bridge] Fetching price via POST: ${apiUrl} for Cat# ${catalogNumber}`);

  // Create form body form data
  const body = new URLSearchParams();
  body.append('partNumber', catalogNumber);
  body.append('callerId', 'products-ui-single-page');

  fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Accept': 'application/json, text/javascript, */*; q=0.01'
    },
    body: body
  })
    .then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then(data => {
      console.log("[Quartzy Bridge] API Response:", data);

      // Response format: { "07200571": [ { "totalPrice": "$619.00", ... } ] }
      // or sometimes just an array if only one item requested

      let productDataArray = data[catalogNumber] || data;
      if (!Array.isArray(productDataArray) && data.priceAndAvailability) {
        productDataArray = data.priceAndAvailability[catalogNumber];
      }

      const productData = Array.isArray(productDataArray) ? productDataArray[0] : null;
      const price = getFisherPrice(productData);

      if (price) {
        console.log(`[Quartzy Bridge] API Price Found: ${price}`);

        const extras = {
          itemName: document.querySelector('h1')?.innerText?.trim() || document.title.split('|')[0].trim(),
          unitSize: extractUnitSize(),
          url: window.location.href,
          vendor: "Fisher Scientific"
        };

        chrome.runtime.sendMessage({
          type: "FISHER_DATA_FOUND",
          data: { catalogNumber: catalogNumber, price: price, ...extras }
        });
      } else {
        console.warn(`[Quartzy Bridge] Price path unclear in API response.`, data);
        scrapeVendorData();
      }
    })
    .catch(err => {
      console.warn("[Quartzy Bridge] API POST Failed. Switching to Poll.", err);
      scrapeVendorData();
    });
}


// Fallback Scraper with Expanded Selectors
function scrapeVendorData() {
  const url = window.location.href;
  const isVwr = url.includes("vwr.com") || url.includes("avantorsciences.com");

  // Expanded selectors based on common vendor templates
  const catNumSelectors = isVwr ? ['.product-catalog-no', '.product-vendor-catalog-no', '#chemical-catlog-no'] : [
    '#qa_prod_code_labl',
    '[itemprop="sku"]',
    '.product-catalog-number',
    '.cat-num',
    '#catalogNumber',
    '.catalog-number',
    'span.product-id'
  ];
  const priceSelectors = isVwr ? ['.price', '.font-bold.desktop-only'] : [
    '#totalPrice',
    '.pdp-price',
    '.full-price',
    '[id^="price_"]',
    '.price',
    '.product-price',
    'span.price-value'
  ];

  let catNum = "";
  let price = "";

  catNumSelectors.forEach(sel => {
    const el = document.querySelector(sel);
    if (el && el.innerText.trim()) {
      // Use regex to strip common prefixes
      catNum = el.innerText.replace(/Catalog\s*(?:No\.?|#)\s*/i, '').trim();
    }
  });

  priceSelectors.forEach(sel => {
    // For VWR, we might find multiple prices in a table, we want the first valid one
    const elements = document.querySelectorAll(sel);
    for (const el of elements) {
      const txt = el.innerText.trim();
      // Look for a price that isn't $0.00
      if (txt && txt.includes('$') && !txt.includes('$0.00')) {
        price = txt;
        break;
      }
    }
    // Fallback: if we only found $0.00 and nothing else, but we have ANY price element
    if (!price) {
      for (const el of elements) {
        const txt = el.innerText.trim();
        if (txt && txt.includes('$')) {
          price = txt;
          break;
        }
      }
    }
  });

  // Prefer logged-in priceDetails (contract price) over ordertable (list price)
  if (vwrPriceDetailsData && isVwr) {
    catNum = vwrPriceDetailsData.catalogNumber || catNum;
    price = vwrPriceDetailsData.price || price;
  } else if (vwrInterceptedData && isVwr) {
    catNum = vwrInterceptedData.catalogNumber || catNum;
    price = vwrInterceptedData.price || price;
  }

  if (catNum && price && price !== "$0.00") {
    const extras = {
      itemName: (vwrPriceDetailsData?.itemName || vwrInterceptedData?.itemName) || document.querySelector(isVwr ? '#pdp-product-heading, .product-name-title, .desc-header' : 'h1')?.innerText?.trim() || document.title.split('|')[0].trim(),
      unitSize: (vwrPriceDetailsData?.unitSize || vwrInterceptedData?.unitSize) || extractUnitSize(),
      url: window.location.href,
      vendor: isVwr ? "VWR" : "Fisher Scientific"
    };

    chrome.runtime.sendMessage({
      type: "FISHER_DATA_FOUND", // Message type remains for compatibility
      data: { catalogNumber: catNum, price: price, ...extras }
    });
  }
}

function startPolling() {
  const observer = new MutationObserver(() => scrapeVendorData());
  observer.observe(document.body, { childList: true, subtree: true });

  let attempts = 0;
  const interval = setInterval(() => {
    scrapeVendorData();
    if (attempts++ > 5) clearInterval(interval);
  }, 1000);
}

/**
 * Fetch Fisher search results page HTML and parse the first result's product name.
 * Used when we have price from API but no item name (e.g. when Bridge request comes from Quartzy).
 */
function fetchFisherItemNameFromSearch(catalogNumber) {
  const searchUrl = `https://www.fishersci.com/us/en/catalog/search/products?keyword=${encodeURIComponent(catalogNumber)}`;
  return fetch(searchUrl, { credentials: 'same-origin', redirect: 'follow' })
    .then(r => r.text())
    .then(html => {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const titleLink = doc.querySelector('.result_title a, .search_result_item .result_title a, [data-testid="ResultTitleLink"]');
      let name = titleLink?.innerText?.trim() || titleLink?.textContent?.trim() || null;
      if (!name) {
        const h1 = doc.querySelector('h1');
        name = h1?.innerText?.trim() || h1?.textContent?.trim() || doc.querySelector('title')?.textContent?.split('|')[0]?.trim() || null;
      }
      if (name) console.log('[Quartzy Bridge] Fisher item name from search/product page:', name);
      return name;
    })
    .catch(err => {
      console.warn('[Quartzy Bridge] Fisher search page fetch for name failed:', err?.message);
      return null;
    });
}

// Listen for Re-Scrape triggers (from Background navigation) or Bridge Requests
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "TRIGGER_SCRAPE") {
    console.log("[Quartzy Bridge] Re-scrape triggered by navigation.");
    run(); // Restart the main logic
  }

  if (message.type === "FETCH_PRICE_ON_DEMAND") {
    const catalogNumber = message.catalogNumber;
    const isVwr = window.location.href.includes("vwr.com") || window.location.href.includes("avantorsciences.com");
    console.log(`[Quartzy Bridge] Bridge Request received for: ${catalogNumber} on ${isVwr ? 'VWR' : 'Fisher Scientific'}`);

    if (isVwr) {
      // VWR Pricing Logic
      fetchVwrPrice(catalogNumber).then(result => {
        sendResponse(result);
      }).catch(err => {
        sendResponse({ success: false, error: err.message });
      });
      return true; // Keep channel open
    } else {
      // Fisher Pricing Logic
      const apiUrl = "https://www.fishersci.com/shop/products/service/pricing";
      const body = new URLSearchParams();
      body.append('partNumber', catalogNumber);
      body.append('callerId', 'products-ui-single-page');

      fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Accept': 'application/json, text/javascript, */*; q=0.01'
        },
        body: body
      })
        .then(r => r.json())
        .then(data => {
          let productDataArray = data[catalogNumber] || data;
          if (!productDataArray) {
            const cleanKey = catalogNumber.replace(/[^a-zA-Z0-9]/g, '');
            productDataArray = data[cleanKey];
          }
          if (!Array.isArray(productDataArray) && data.priceAndAvailability) {
            productDataArray = data.priceAndAvailability[catalogNumber] || data.priceAndAvailability[catalogNumber.replace(/[^a-zA-Z0-9]/g, '')];
          }
          const productData = Array.isArray(productDataArray) ? productDataArray[0] : null;
          const price = getFisherPrice(productData);

          if (productData && price) {
            let itemName = productData.productName || productData.name || productData.description || productData.title || productData.partDescription || null;
            if (!itemName) {
              const urlMatch = window.location.href.match(fisherUrlRegex);
              const urlCatalog = urlMatch && urlMatch[1] ? urlMatch[1].replace(/[^a-zA-Z0-9]/g, '') : '';
              const reqCatalog = (catalogNumber || '').replace(/[^a-zA-Z0-9]/g, '');
              if (urlCatalog && reqCatalog && urlCatalog === reqCatalog) {
                itemName = document.querySelector('h1')?.innerText?.trim() || document.title.split('|')[0].trim() || null;
              }
              if (!itemName && (window.location.href.includes('/catalog/search') || window.location.href.includes('/shop/products/search'))) {
                const firstResultTitle = document.querySelector('.result_title a, .search_result_item .result_title a, [data-testid="ResultTitleLink"]');
                if (firstResultTitle) itemName = firstResultTitle.innerText?.trim() || null;
              }
            }
            if (!itemName) {
              return fetchFisherItemNameFromSearch(catalogNumber).then(nameFromSearch => {
                itemName = nameFromSearch || itemName;
                sendResponse({
                  success: true,
                  vendor: "Fisher Scientific",
                  data: {
                    catalogNumber: catalogNumber,
                    price: price,
                    itemName: itemName || undefined
                  }
                });
              });
            }
            sendResponse({
              success: true,
              vendor: "Fisher Scientific",
              data: {
                catalogNumber: catalogNumber,
                price: price,
                itemName: itemName || undefined
              }
            });
          } else {
            sendResponse({ success: false, error: "Price not found in Fisher API response" });
          }
        })
        .catch(err => {
          sendResponse({ success: false, error: err.message });
        });
      return true;
    }
  }
});

/**
 * Try logged-in priceDetails API first. Returns contract price when user is logged in.
 * Uses session cookies (credentials: include) and/or Bearer token. Falls back to null when not logged in.
 * Response shape: { articles: [{ catalogNumber, uomSpecificPrices: [{ value, formattedDisplayPrice, uomID }] }] }
 */
async function fetchVwrPriceDetails(catNum) {
  const baseUrl = "https://occapi.avantorsciences.com/occ/v2/us.vwr.com/users/current/priceDetails?lang=en_US&curr=USD&newStorefront=true";
  const headers = { "Content-Type": "application/json" };
  if (vwrAuthToken) headers["Authorization"] = vwrAuthToken;

  let res = await fetch(baseUrl, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify({ productCodes: [catNum] })
  });
  if (!res.ok && (res.status === 400 || res.status === 404 || res.status === 405)) {
    res = await fetch(`${baseUrl}&productCodes=${encodeURIComponent(catNum)}`, {
      method: "GET",
      headers,
      credentials: "include"
    });
  }
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data?.articles?.length) return null;

  const article = data.articles.find(a =>
    (a.catalogNumber || "").replace(/[^a-zA-Z0-9]/g, "") === (catNum || "").replace(/[^a-zA-Z0-9]/g, "")
  ) || data.articles[0];
  const prices = article.uomSpecificPrices || [];
  if (prices.length === 0) return null;

  // Prefer EA (Each), then first available
  const priceObj = prices.find(p => (p.uomID || "").toUpperCase() === "EA") || prices[0];
  const uomMap = { EA: "Each", CS: "Case", PK: "Pack", BX: "Box" };
  const unitSize = uomMap[(priceObj.uomID || "").toUpperCase()] || priceObj.uomID || "Each";

  return {
    catalogNumber: article.catalogNumber || catNum,
    price: priceObj.formattedDisplayPrice || (priceObj.value != null ? `$${priceObj.value.toFixed(2)}` : null),
    unitSize,
    prices: prices.map(p => ({
      price: p.formattedDisplayPrice || (p.value != null ? `$${p.value.toFixed(2)}` : null),
      unitSize: uomMap[(p.uomID || "").toUpperCase()] || p.uomID || "Each"
    }))
  };
}

async function fetchVwrPrice(catNum) {
  try {
    console.log(`[Quartzy Bridge] Refining VWR lookup for: ${catNum}`);

    // Try logged-in priceDetails API first (contract prices)
    const priceDetailsResult = await fetchVwrPriceDetails(catNum);
    if (priceDetailsResult && priceDetailsResult.price) {
      console.log("[Quartzy Bridge] Using logged-in priceDetails:", priceDetailsResult.price);
      let itemName = document.querySelector("#pdp-product-heading, .product-name-title, .desc-header")?.innerText?.trim() || document.querySelector("h1")?.innerText?.trim();
      if (!itemName) {
        try {
          const searchUrl = `https://occapi.avantorsciences.com/occ/v2/us.vwr.com/products/keywordSearch?query=${encodeURIComponent(catNum)}&pageSize=1&fields=BASIC&lang=en_US&curr=USD&newStorefront=true`;
          const searchRes = await fetch(searchUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(vwrAuthToken && { Authorization: vwrAuthToken }) },
            body: JSON.stringify({ viewType: "EASY_VIEW" }),
            credentials: "include"
          });
          const searchData = await searchRes.json();
          const product = searchData?.products?.[0];
          if (product) itemName = product.name || product.description;
        } catch (_) { /* ignore */ }
      }
      return {
        success: true,
        vendor: "VWR",
        data: {
          catalogNumber: priceDetailsResult.catalogNumber,
          price: priceDetailsResult.price,
          unitSize: priceDetailsResult.unitSize,
          prices: priceDetailsResult.prices || [{ price: priceDetailsResult.price, unitSize: priceDetailsResult.unitSize }],
          itemName: itemName || undefined
        }
      };
    }

    // Fallback: ordertable (guest/list prices)
    if (!vwrAuthToken) {
      console.log("[Quartzy Bridge] No session token found. Fetching guest token...");
      const tokenRes = await fetch("https://occapi.avantorsciences.com/authorizationserver/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "client_id=VVjdGUHAb3ETZLEVTWtFy3BmhFhXSdBB&client_secret=iYg25p8rt-0-YlZGJNUrm4f6wuNRBZpAuX6TXCAwj1phfX2GOXXSskBW_paF0Jvk&grant_type=client_credentials"
      });
      const tokenData = await tokenRes.json();
      if (tokenData.access_token) {
        vwrAuthToken = `Bearer ${tokenData.access_token}`;
        console.log("[Quartzy Bridge] Guest token acquired.");
      }
    }

    // 1. Resolve Catalog Number to internal "Code" (e.g. NA1286493)
    // KeywordSearch requires POST + JSON body + Bearer token
    const searchUrl = `https://occapi.avantorsciences.com/occ/v2/us.vwr.com/products/keywordSearch?query=${encodeURIComponent(catNum)}&pageSize=5&fields=BASIC&lang=en_US&curr=USD&newStorefront=true`;

    const searchRes = await fetch(searchUrl, {
      method: "POST",
      headers: {
        "Authorization": vwrAuthToken,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ "viewType": "EASY_VIEW" })
    });
    const searchData = await searchRes.json();

    const product = searchData.products && searchData.products[0];
    if (!product) {
      throw new Error(`Could not resolve VWR product for ${catNum} via KeywordSearch`);
    }

    // Ordertable API expects numeric productId (e.g. 22675708); keywordSearch may return code (e.g. NA4852050)
    const productId = product.uid ?? product.productId ?? product.id ?? product.code;
    const vwrCode = product.code;

    console.log(`[Quartzy Bridge] Resolved productId: ${productId}. Fetching ordertable...`);

    // 2. Hit the ordertable API using productId (numeric preferred) or code
    const apiUrl = `https://occapi.avantorsciences.com/occ/v2/us.vwr.com/api/product/ordertable?productId=${encodeURIComponent(productId)}&lang=en_US&curr=USD&user=anonymous&newStorefront=true`;

    const response = await fetch(apiUrl, {
      headers: vwrAuthToken ? { "Authorization": vwrAuthToken } : {}
    });
    if (!response.ok) {
      throw new Error(`Ordertable API HTTP ${response.status}`);
    }
    const data = await response.json();

    if (data.errors || data.error) {
      throw new Error(data.errors?.[0]?.message || data.error?.message || "Ordertable API error");
    }
    if (data.productRows && data.productRows.length > 0) {
      // Find the specific variant row (match catalogNumber, skuId, or code)
      const norm = (s) => (s || "").replace(/[^a-zA-Z0-9]/g, "");
      let row = data.productRows.find(r =>
        r.catalogNumber === catNum ||
        norm(r.catalogNumber) === norm(catNum) ||
        r.code === catNum ||
        (r.prices && r.prices.some(p => p.skuId === catNum || norm(p.skuId) === norm(catNum)))
      );

      // Fallback: take the first one
      if (!row) row = data.productRows[0];

      if (row && row.prices && row.prices.length > 0) {
        const priceObj = row.prices[0];
        return {
          success: true,
          vendor: "VWR",
          data: {
            catalogNumber: priceObj.skuId || row.catalogNumber || catNum,
            vwrCode: row.code || vwrCode,
            itemName: data.description || row.name,
            // Return all available prices
            prices: row.prices.map(p => ({
              price: p.formattedDisplayPrice,
              unitSize: p.uomDescription || "Each"
            })),
            // Maintain single price/unitSize for backward compatibility or simple UI
            price: priceObj.formattedDisplayPrice,
            unitSize: priceObj.uomDescription || "Each"
          }
        };
      }
    }
    throw new Error("No pricing data found in ordertable for " + catNum);
  } catch (err) {
    console.error("[Quartzy Bridge] VWR Refined Fetch Error:", err);
    throw err;
  }
}

// Initial Run
run();