console.log("[Quartzy Bridge] Content Script Loaded");
// Regex to extract Fisher Catalog Number from URL (matches vendors.json)
// Example: .../products/stripette.../07200574?crossRef... -> 07200574
const fisherUrlRegex = /products\/[^\/]+\/([^?#]+)/;

function run() {
  const url = window.location.href;
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

      if (productData && productData.totalPrice) {
        const price = productData.totalPrice;
        console.log(`[Quartzy Bridge] API Price Found: ${price}`);

        chrome.runtime.sendMessage({
          type: "FISHER_DATA_FOUND",
          data: { catalogNumber: catalogNumber, price: price }
        });
      } else {
        console.warn(`[Quartzy Bridge] Price path unclear in API response.`, data);
        scrapeFisherFallback();
      }
    })
    .catch(err => {
      console.warn("[Quartzy Bridge] API POST Failed. Switching to Poll.", err);
      scrapeFisherFallback();
    });
}


// Fallback Scraper with Expanded Selectors
function scrapeFisherFallback() {
  // Expanded selectors based on common Fisher templates
  const catNumSelectors = [
    '[itemprop="sku"]',
    '.product-catalog-number',
    '.cat-num',
    '#catalogNumber',
    '.catalog-number',
    'span.product-id' // Common in new layouts
  ];
  const priceSelectors = [
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
    if (el && el.innerText.trim()) catNum = el.innerText.replace('Catalog No. ', '').trim();
  });

  priceSelectors.forEach(sel => {
    const el = document.querySelector(sel);
    if (el && el.innerText.trim() && el.innerText.includes('$')) price = el.innerText.trim();
  });

  if (catNum && price && price !== "$0.00") {
    chrome.runtime.sendMessage({
      type: "FISHER_DATA_FOUND",
      data: { catalogNumber: catNum, price: price }
    });
  }
}

function startPolling() {
  const observer = new MutationObserver(() => scrapeFisherFallback());
  observer.observe(document.body, { childList: true, subtree: true });

  let attempts = 0;
  const interval = setInterval(() => {
    scrapeFisherFallback();
    if (attempts++ > 5) clearInterval(interval);
  }, 1000);
}

// Listen for Re-Scrape triggers (from Background navigation) or Bridge Requests
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "TRIGGER_SCRAPE") {
    console.log("[Quartzy Bridge] Re-scrape triggered by navigation.");
    run(); // Restart the main logic
  }

  if (message.type === "FETCH_PRICE_ON_DEMAND") {
    console.log(`[Quartzy Bridge] Bridge Request received for: ${message.catalogNumber}`);

    // We reuse the existing logic but need to handle the promise for sendResponse
    // Note: fetchPriceFromApi is currently void. We need to adapt it slightly 
    // OR just duplicate the fetch for the bridge to keep it simple.
    // Let's use the exact same POST logic.

    const catalogNumber = message.catalogNumber;
    const apiUrl = "https://www.fishersci.com/shop/products/service/pricing";
    const body = new URLSearchParams();
    body.append('partNumber', catalogNumber); // The API handles inputs like "07-200-571" fine usually, or we strip it.
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
        console.log("[Quartzy Bridge] Bridge API Response:", data);
        // Response parsing logic (same as main function)
        let productDataArray = data[catalogNumber] || data;

        // Handle hyphen mismatch keying (e.g. key is "07200571" but input was "07-200-571")
        if (!productDataArray) {
          // Try stripping hyphens from key lookup
          const cleanKey = catalogNumber.replace(/[^a-zA-Z0-9]/g, '');
          productDataArray = data[cleanKey];
        }

        if (!Array.isArray(productDataArray) && data.priceAndAvailability) {
          productDataArray = data.priceAndAvailability[catalogNumber] || data.priceAndAvailability[catalogNumber.replace(/[^a-zA-Z0-9]/g, '')];
        }

        const productData = Array.isArray(productDataArray) ? productDataArray[0] : null;

        if (productData && productData.totalPrice) {
          sendResponse({ success: true, data: { catalogNumber: catalogNumber, price: productData.totalPrice } });
        } else {
          sendResponse({ success: false, error: "Price not found in API response" });
        }
      })
      .catch(err => {
        console.error("Bridge Fetch Error:", err);
        sendResponse({ success: false, error: err.message });
      });

    return true; // Keep message channel open for async response
  }
});

// Initial Run
run();