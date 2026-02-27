console.log("[Quartzy Bridge] Source Script Loaded");

// Listen for messages from the side panel to fetch selected items
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "GET_QUARTZY_SELECTION") {
        sendResponse({ success: true, data: getSelectedItems() });
    }
});

function getSelectedItems() {
    const checkedBoxes = document.querySelectorAll('input[type="checkbox"]:checked');
    const itemsToTransfer = [];

    console.log(`[Quartzy Bridge] Found ${checkedBoxes.length} checked boxes.`);

    checkedBoxes.forEach((cb, index) => {
        const row = cb.closest('tr');
        // Skip header checkboxes like 'Select All'
        if (!row || cb.closest('thead') || row.closest('thead') || row.querySelector('th')) return;

        // Construct a broader text representation of the row, including input values
        let rowText = row.innerText.replace(/\s+/g, ' ').trim();
        const inputs = row.querySelectorAll('input[type="text"], input:not([type])');
        inputs.forEach(input => {
            if (input.value) rowText += " " + input.value;
        });

        console.log(`[Quartzy Bridge] Processing Row ${index + 1} Content:`, rowText);

        let catalogNumber = "Unknown";
        let quantity = 1;

        // 1. Attempt to find Catalog Number
        // Strict Regex: Matches typical Fisher formats like 00-000-000 or alphanumeric equivalents
        const fisherRegex = /\b(?:\d{2}[-.]\d{3}[-.]\d{2,4}|[A-Z]{1,3}\d{3,}[A-Z0-9-]*)\b/i;
        const strictMatch = rowText.match(fisherRegex);

        if (strictMatch) {
            catalogNumber = strictMatch[0];
            console.log(`   -> Found Cat# (Strict Match): ${catalogNumber}`);
        } else {
            // Fallback: Look for alphanumeric strings (min length 4) with at least one digit
            const fallbackRegex = /\b[A-Z0-9.-]{4,}\b/gi;
            const matchesArr = rowText.match(fallbackRegex);

            if (matchesArr) {
                const validFallback = matchesArr.find(m => /\d/.test(m) && !/^\d{1,3}$/.test(m));
                if (validFallback) {
                    catalogNumber = validFallback;
                    console.log(`   -> Found Cat# (Fallback Match): ${catalogNumber}`);
                } else {
                    console.warn(`   -> No Cat# with digits matched.`);
                }
            } else {
                console.warn(`   -> No Cat# pattern matched at all.`);
            }
        }

        // 2. Quantity
        const qtyInput = row.querySelector('input[type="number"], input[name*="quantity"], input[name*="qty"]');
        if (qtyInput && qtyInput.value) {
            quantity = parseInt(qtyInput.value, 10);
        }

        itemsToTransfer.push({
            catalogNumber: catalogNumber,
            quantity: quantity || 1
        });
    });

    return itemsToTransfer;
}

// Automatically send selection changes to side panel
document.addEventListener('change', (e) => {
    if (e.target.matches('input[type="checkbox"]')) {
        // Use a short delay to allow Quartzy's React state to toggle the other checkboxes in a bulk select
        setTimeout(() => {
            try {
                chrome.runtime.sendMessage({
                    type: "QUARTZY_SELECTION_UPDATED",
                    data: getSelectedItems()
                });
            } catch (err) {
                // background page inactive
            }
        }, 100);
    }
});
