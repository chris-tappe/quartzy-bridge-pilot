console.log("[Quartzy Bridge] Source Script Loaded");

function injectTransferButton() {
    // Create a container for the button
    const container = document.createElement('div');
    container.id = 'quartzy-fisher-bridge-container';
    container.style.position = 'fixed';
    container.style.bottom = '20px';
    container.style.right = '20px';
    container.style.zIndex = '9999';

    // Create Shadow DOM to isolate styles
    const shadow = container.attachShadow({ mode: 'open' });

    // Button Styles
    const style = document.createElement('style');
    style.textContent = `
    .transfer-btn {
      background-color: #0055a4; /* Fisher Blueish */
      color: white;
      border: none;
      padding: 10px 20px;
      font-size: 16px;
      font-weight: bold;
      border-radius: 5px;
      cursor: pointer;
      box-shadow: 0 2px 5px rgba(0,0,0,0.2);
      transition: background-color 0.2s;
    }
    .transfer-btn:hover {
      background-color: #004488;
    }
  `;

    const btn = document.createElement('button');
    btn.className = 'transfer-btn';
    btn.textContent = 'Transfer to Fisher';
    btn.addEventListener('click', handleTransferClick);

    shadow.appendChild(style);
    shadow.appendChild(btn);

    document.body.appendChild(container);
}

function handleTransferClick() {
    console.log("[Quartzy Bridge] Transfer initiated...");

    const checkedBoxes = document.querySelectorAll('input[type="checkbox"]:checked');
    const itemsToTransfer = [];

    console.log(`[Quartzy Bridge] Found ${checkedBoxes.length} checked boxes.`);

    checkedBoxes.forEach((cb, index) => {
        const row = cb.closest('tr');
        if (!row) return;

        // Construct a broader text representation of the row, including input values
        let rowText = row.innerText.replace(/\s+/g, ' ').trim();

        // Append values from all text inputs in the row
        const inputs = row.querySelectorAll('input[type="text"], input:not([type])');
        inputs.forEach(input => {
            if (input.value) rowText += " " + input.value;
        });

        console.log(`[Quartzy Bridge] Processing Row ${index + 1} Content:`, rowText);

        let catalogNumber = null;
        let quantity = 1;

        // 1. Attempt to find Catalog Number
        // Regex: Matches 00-000-000, 00.000.000, or alphanumeric sequences usually found in catalogs
        // Added stricter boundaries to avoid short words.
        const fisherRegex = /\b(?:\d{2}[-.]\d{3}[-.]\d{2,4}|[A-Z]{1,3}\d{3,}[A-Z0-9-]*)\b/i;

        const matches = rowText.match(fisherRegex);
        if (matches) {
            catalogNumber = matches[0];
            console.log(`   -> Found potential Cat#: ${catalogNumber}`);
        } else {
            // Fallback: Look for any "longish" alphanumeric string that contains at least one number
            const fallbackRegex = /\b[A-Z0-9-]{6,}\b/i;
            const fallbackMatch = rowText.match(fallbackRegex);
            if (fallbackMatch && /\d/.test(fallbackMatch[0])) {
                catalogNumber = fallbackMatch[0];
                console.log(`   -> Found fallback Cat#: ${catalogNumber}`);
            } else {
                console.warn(`   -> No Cat# pattern matched in this row.`);
            }
        }

        // 2. Quantity
        const qtyInput = row.querySelector('input[type="number"], input[name*="quantity"], input[name*="qty"]');
        if (qtyInput && qtyInput.value) {
            quantity = parseInt(qtyInput.value, 10);
        } else {
            // Check for a cell specifically labeled with quantity often has a small integer?
            // Heuristic (fragile): Look for a standalone number like " 1 " or " 2 "
        }

        if (catalogNumber) {
            itemsToTransfer.push({
                catalogNumber: catalogNumber,
                quantity: quantity || 1
            });
        }
    });

    if (itemsToTransfer.length === 0) {
        alert("No Fisher-compatible items found in selected rows.\n\n" +
            "Please check the Console (F12) to see what text was scanned.\n" +
            "Ensure the Catalog # is visible in the row.");
        return;
    }

    console.log("[Quartzy Bridge] Items to transfer:", itemsToTransfer);

    // Save to storage
    chrome.storage.local.set({ 'fisher_order_queue': itemsToTransfer }, () => {
        console.log("[Quartzy Bridge] Saved to storage. Opening Fisher...");
        window.open('https://www.fishersci.com/store1/rapidorder', '_blank');
    });
}

// Wait for page to load then inject
window.addEventListener('load', () => {
    // Add a small delay to ensure Quartzy app initiates
    setTimeout(injectTransferButton, 2000);
});
