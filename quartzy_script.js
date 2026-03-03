console.log("[Quartzy Bridge] Source Script Loaded");

// Listen for messages from the side panel to fetch selected items
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "GET_QUARTZY_SELECTION") {
        sendResponse({ success: true, data: getSelectedItems() });
    } else if (message.type === "POPULATE_QUARTZY_REQUEST") {
        console.log("[Quartzy Bridge] POPULATE_QUARTZY_REQUEST received:", message.data);
        populateQuartzyForm(message.data);
    } else if (message.type === "PARSE_FISHER_HTML") {
        const html = message.html;
        if (!html || typeof html !== "string") {
            sendResponse({ success: false, error: "no html" });
            return;
        }
        try {
            const doc = new DOMParser().parseFromString(html, "text/html");
            const catalogNumber = parseFirstFisherCatalogFromDoc(doc);
            if (catalogNumber) {
                sendResponse({ success: true, catalogNumber });
            } else {
                sendResponse({ success: false, error: "no_match" });
            }
        } catch (err) {
            console.log("[Quartzy Bridge] PARSE_FISHER_HTML error:", err);
            sendResponse({ success: false, error: err?.message || "parse_error" });
        }
    }
});

/**
 * Find the first search result's catalog number in a Fisher search results document.
 * Looks for .qa-part-number or text matching Fisher catalog format (e.g. XX-XXX-XXX).
 */
function parseFirstFisherCatalogFromDoc(doc) {
    const fisherCatalogPattern = /^\d{2}-\d{3}-\d{3,}$|^[A-Z0-9]{5,}$|^p-\d+$/i;
    const byQaPart = doc.querySelector(".qa-part-number");
    if (byQaPart) {
        const text = (byQaPart.textContent || "").trim();
        if (text) return text;
    }
    const partNumbers = doc.querySelectorAll("[class*='part-number'], [class*='partNumber'], [data-part-number]");
    for (const el of partNumbers) {
        const text = (el.textContent || el.getAttribute("data-part-number") || "").trim();
        if (text && fisherCatalogPattern.test(text)) return text;
    }
    const links = doc.querySelectorAll('a[href*="/shop/products/"], a[href*="/catalog/search/products/"]');
    for (const a of links) {
        const href = a.getAttribute("href") || "";
        const segment = href.split("/").filter(Boolean).pop();
        const catalog = segment ? segment.replace(/\.html$/, "").split("?")[0] : null;
        if (catalog && catalog !== "products" && fisherCatalogPattern.test(catalog)) return catalog;
    }
    const bodyText = doc.body ? doc.body.innerText : "";
    const match = bodyText.match(/\b(\d{2}-\d{3}-\d{3,})\b/) || bodyText.match(/\b([A-Z]{2}\d{5,})\b/) || bodyText.match(/\b(p-\d+)\b/i);
    return match ? match[1] : null;
}

async function initQuartzy() {
    console.log("[Quartzy Bridge] Initializing Quartzy script...");

    // Check for pending requests from a redirection
    chrome.storage.local.get(['pending_quartzy_request'], (result) => {
        if (result.pending_quartzy_request) {
            console.log("[Quartzy Bridge] Found pending request, populating now...", result.pending_quartzy_request);
            populateQuartzyForm(result.pending_quartzy_request);
            chrome.storage.local.remove('pending_quartzy_request');
        }
    });
}

// Start initialization
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initQuartzy);
} else {
    initQuartzy();
}

function setInputValue(element, value) {
    if (!element || value == null) return;

    // Support for React/Ember/Vue by triggering native setters
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    nativeInputValueSetter.call(element, value);

    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
}

function findInputByLabelText(labelText) {
    const labels = Array.from(document.querySelectorAll('label'));
    const label = labels.find(l => l.innerText.toLowerCase().includes(labelText.toLowerCase()));
    if (label) {
        const inputId = label.getAttribute('for');
        if (inputId) {
            return document.getElementById(inputId);
        }
        return label.nextElementSibling?.querySelector('input') || label.parentElement.querySelector('input');
    }
    // Fallback: placeholder
    return document.querySelector(`input[placeholder*="${labelText}" i]`);
}

async function fillEmberDropdown(ariaLabel, value, commitViaTab = false) {
    if (!value) return false;
    console.log(`[Quartzy Bridge] Attempting to fill Ember dropdown '${ariaLabel}' with '${value}'`);

    // Broaden the search for the trigger
    const selectors = [
        `[aria-label="${ariaLabel}"][role="button"]`,
        `[aria-label="${ariaLabel.toLowerCase()}"][role="button"]`,
        `.ember-power-select-trigger[aria-label*="${ariaLabel}" i]`,
        `.ember-power-select-trigger` // Last resort fallback
    ];

    let trigger = null;
    if (ariaLabel === "Vendor" || ariaLabel === "catalog number") {
        // Search specifically for the one with the label if possible
        for (const sel of selectors) {
            const found = Array.from(document.querySelectorAll(sel)).find(el =>
                el.getAttribute('aria-label')?.toLowerCase().includes(ariaLabel.toLowerCase())
            );
            if (found) {
                trigger = found;
                break;
            }
        }
    }

    if (!trigger) trigger = document.querySelector(selectors[0]);

    if (trigger) {
        console.log(`[Quartzy Bridge] Found trigger for '${ariaLabel}'. Opening...`);

        // Simulation of a full click cycle
        trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        trigger.click();
        trigger.focus();

        await new Promise(r => setTimeout(r, 600));

        let searchInput = document.querySelector('.ember-power-select-search-input');

        // Sometimes the search input is the trigger itself or closely related
        if (!searchInput && trigger.tagName === 'INPUT') searchInput = trigger;

        if (searchInput) {
            console.log(`[Quartzy Bridge] Found search input. Setting value...`);
            searchInput.focus();
            setInputValue(searchInput, value);

            // Trigger some keyboard events to help Ember realize something changed
            searchInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));

            await new Promise(r => setTimeout(r, 1000));

            if (commitViaTab) {
                console.log(`[Quartzy Bridge] Committing '${value}' via Tab key...`);
                // Sometimes 'Tab' requires a keydown dispatch to the window or a specific handler
                searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', keyCode: 9, bubbles: true }));
                searchInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', code: 'Tab', keyCode: 9, bubbles: true }));
                searchInput.blur();
                await new Promise(r => setTimeout(r, 500));
            } else {
                const options = Array.from(document.querySelectorAll('.ember-power-select-option'));
                console.log(`[Quartzy Bridge] Found ${options.length} options for '${value}'`);

                // Try matching exact, then partial, then first
                const matchOption = options.find(opt => opt.innerText.trim().toLowerCase() === value.trim().toLowerCase()) ||
                    options.find(opt => opt.innerText.toLowerCase().includes(value.toLowerCase())) ||
                    options[0];

                if (matchOption) {
                    console.log(`[Quartzy Bridge] Selecting option: ${matchOption.innerText.trim()}`);
                    matchOption.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                    matchOption.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                    matchOption.click();
                    await new Promise(r => setTimeout(r, 200));
                } else {
                    console.warn(`[Quartzy Bridge] No options appeared in dropdown for '${value}'`);
                }
            }
        } else {
            console.warn(`[Quartzy Bridge] Could not find search input for '${ariaLabel}'`);
        }
        return true;
    } else {
        console.warn(`[Quartzy Bridge] Could not find trigger for '${ariaLabel}'`);
    }
    return false;
}

async function populateQuartzyForm(data) {
    if (!data) return;

    console.log("[Quartzy Bridge] Populating form with:", data);

    // 1. Vendor (Ember Power Select)
    const vendorToFill = data.vendor || "Fisher Scientific";
    const vendorFilled = await fillEmberDropdown("Vendor", vendorToFill);
    if (!vendorFilled) {
        console.warn(`[Quartzy Bridge] Could not find Vendor dropdown trigger for ${vendorToFill}.`);
    }

    // 2. Catalog Number (Ember Power Select)
    // Using Tab instead of Enter keeps the current text without selecting the first dropdown match
    const catalogFilled = await fillEmberDropdown("catalog number", data.catalogNumber, true);
    if (!catalogFilled) {
        console.warn("[Quartzy Bridge] Could not find Catalog Number dropdown trigger.");
    }

    // 3. Map other fields to standard inputs
    const fieldMapping = {
        "Item Name": data.itemName,
        "URL": data.url,
        "Unit Size": data.unitSize,
        "Unit Price": data.price ? data.price.replace(/[^0-9.]/g, '') : null // Remove '$' sign if present
    };

    for (const [labelText, val] of Object.entries(fieldMapping)) {
        if (!val) continue;

        let input = findInputByLabelText(labelText);

        // Fallbacks for common names if labels aren't found
        if (!input) {
            if (labelText === "Item Name") input = document.querySelector('input[name="name"]');
            if (labelText === "URL") input = document.querySelector('input[name="url"]');
            if (labelText === "Unit Size") input = document.querySelector('input[name="unit"]');
            if (labelText === "Unit Price") input = document.querySelector('input[name="price"]');
        }

        if (input) {
            setInputValue(input, val);
        } else {
            console.warn(`[Quartzy Bridge] Could not find input for: ${labelText}`);
        }
    }
}

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
        const qtyEl = row.querySelector('.quantity, .quantity-input, input[type="number"], input[name*="quantity"], input[name*="qty"]');
        if (qtyEl) {
            if (qtyEl.tagName === 'INPUT') {
                quantity = parseInt(qtyEl.value, 10);
            } else {
                quantity = parseInt(qtyEl.innerText.trim(), 10);
            }
        } else {
            // Fallback: Look for a cell that likely contains quantity (often a small number next to units)
            const cells = Array.from(row.querySelectorAll('td'));
            const qtyCell = cells.find(td => {
                const text = td.innerText.trim();
                return /^\d+$/.test(text) && parseInt(text, 10) < 1000; // Heuristic for quantity
            });
            if (qtyCell) {
                quantity = parseInt(qtyCell.innerText.trim(), 10);
                console.log(`   -> Found Qty (Cell Text): ${quantity}`);
            }
        }

        // 3. Vendor
        let vendor = "Unknown";
        if (rowText.toLowerCase().includes("fisher")) {
            vendor = "Fisher Scientific";
        } else if (rowText.toLowerCase().includes("vwr")) {
            vendor = "VWR";
        } else {
            // Try to find in columns
            const cells = Array.from(row.querySelectorAll('td'));
            const vendorCell = cells.find(td =>
                td.innerText.toLowerCase().includes("fisher") ||
                td.innerText.toLowerCase().includes("vwr")
            );
            if (vendorCell) {
                const text = vendorCell.innerText.toLowerCase();
                if (text.includes("fisher")) vendor = "Fisher Scientific";
                else if (text.includes("vwr")) vendor = "VWR";
            }
        }

        itemsToTransfer.push({
            catalogNumber: catalogNumber.trim(),
            quantity: Math.max(1, quantity || 1),
            vendor: vendor
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
