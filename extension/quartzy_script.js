console.log("[Quartzy Bridge] Source Script Loaded");

// Listen for messages from the side panel to fetch selected items
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "GET_QUARTZY_SELECTION") {
        sendResponse({ success: true, data: getSelectedItems() });
    } else if (message.type === "POPULATE_QUARTZY_REQUEST") {
        console.log("[Quartzy Bridge] POPULATE_QUARTZY_REQUEST received:", message.data);
        populateQuartzyForm(message.data);
    }
});

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

    const lookupEnabled = isLookupPriceEnabled();
    const atvEnabled = isAddToVendorSiteEnabled();
    console.log("[Quartzy Bridge] Flags", {
        lookupPrice: lookupEnabled,
        addToVendorSite: atvEnabled,
        path: location.pathname
    });

    if (lookupEnabled || atvEnabled) {
        watchQuartzyDomAndRoute(function () {
            if (lookupEnabled && isAddRequestPage()) {
                ensureLookupPriceStyles();
                scanAndMountLookupPrice();
            }
            if (atvEnabled) {
                scanAndInjectAddToVendorControls();
            }
        }, 1500);
    }

    if (atvEnabled) {
        document.addEventListener(
            "click",
            function (e) {
                const t = e.target;
                if (!t || !t.closest) return;
                if (t.closest("#order-request-group-actions")) {
                    setTimeout(scanAndInjectAddToVendorControls, 50);
                    setTimeout(scanAndInjectAddToVendorControls, 250);
                }
            },
            true
        );
    }
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

    // 1. Vendor (Ember Power Select) — only when a label is provided
    const vendorToFill = (data.vendor && String(data.vendor).trim()) || "";
    if (vendorToFill) {
        const vendorFilled = await fillEmberDropdown("Vendor", vendorToFill);
        if (!vendorFilled) {
            console.warn(`[Quartzy Bridge] Could not find Vendor dropdown for: ${vendorToFill}.`);
        }
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
        // Part numbers: dashed numeric, alphanum SKUs, etc.
        const catalogRegex = /\b(?:\d{2}[-.]\d{3}[-.]\d{2,4}|[A-Z]{1,3}\d{3,}[A-Z0-9-]*)\b/i;
        const strictMatch = rowText.match(catalogRegex);

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

        // 3. Vendor (not reliably identifiable from all Quartzy table layouts)
        const vendor = "Unknown";

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

/* —— Lookup Price on Add Request form (gated by QUARTZY_FETCH_PRICE_TEST_ENABLED) —— */

const LOOKUP_PRICE_STYLE_ID = "qc-lookup-price-style";
const LOOKUP_PRICE_ROOT_ATTR = "data-qc-lookup-price";
/* Group ids may be numeric, "all", or UUID — do not require \\d+ only. */
const ADD_REQUEST_PATH_RE = /^\/groups\/[^/]+\/requests\/new\/?$/i;

/** @type {WeakMap<Element, { pageUrl: string, selectedCatalog: string, inFlight: boolean }>} */
const lookupPriceStateByForm = new WeakMap();

function isLookupPriceEnabled() {
    return typeof QUARTZY_FETCH_PRICE_TEST_ENABLED !== "undefined" && QUARTZY_FETCH_PRICE_TEST_ENABLED === true;
}

function isAddRequestPage() {
    try {
        return ADD_REQUEST_PATH_RE.test(location.pathname);
    } catch (e) {
        return false;
    }
}

function ensureLookupPriceStyles() {
    if (document.getElementById(LOOKUP_PRICE_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = LOOKUP_PRICE_STYLE_ID;
    style.textContent = `
.qc-lookup-price-column {
  display: flex;
  align-items: flex-start;
  margin: 8px 0 4px;
  overflow: visible;
  position: relative;
  width: 100%;
  max-width: 100%;
  flex: 1 1 auto;
}
.qc-lookup-price {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: flex-start;
  gap: 6px;
  min-width: 140px;
  max-width: 100%;
  margin: 0;
  padding: 0 0 2px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 12px;
  line-height: 1.35;
  color: #1f2937;
  position: relative;
  overflow: visible;
}
.qc-lookup-price-row {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.qc-lookup-price-btn {
  appearance: none;
  border: none;
  border-radius: 6px;
  padding: 6px 12px;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  color: #fff;
  background: #f75e2d;
  cursor: pointer;
  white-space: nowrap;
}
.qc-lookup-price-btn:hover:not(:disabled) { background: #e04f22; }
.qc-lookup-price-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.qc-lookup-price-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: #4b5563;
  cursor: pointer;
  user-select: none;
  font-size: 11px;
}
.qc-lookup-price-toggle input { margin: 0; }
.qc-lookup-price-status {
  margin: 0;
  color: #6b7280;
  font-size: 11px;
  max-width: 420px;
}
.qc-lookup-price-status.is-error { color: #b91c1c; }
.qc-lookup-price-status.is-warn { color: #92400e; }
.qc-lookup-price-status.is-loading { color: #6b7280; }
.qc-lookup-price-status[hidden],
.qc-lookup-price-panel[hidden] { display: none !important; }
.qc-lookup-price-panel {
  margin: 8px 0 0;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #fff;
  padding: 8px;
  max-width: min(520px, 90vw);
  width: max-content;
  position: relative;
  left: 0;
  top: 0;
  z-index: 40;
  box-shadow: 0 4px 14px rgba(15, 23, 42, 0.08);
}
.qc-lookup-price-single {
  margin: 0;
  font-weight: 600;
}
.qc-lookup-price-table-wrap { overflow-x: auto; }
.qc-lookup-price-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.qc-lookup-price-table th,
.qc-lookup-price-table td {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid #e5e7eb;
  vertical-align: top;
}
.qc-lookup-price-table th {
  font-weight: 600;
  color: #6b7280;
  background: #f3f4f6;
}
.qc-lookup-price-table tr.is-suggested { background: #fef3ec; }
.qc-lookup-price-table tr.is-clickable { cursor: pointer; }
.qc-lookup-price-table tr.is-clickable:hover { background: #eff6ff; }
.qc-lookup-price-table tr.is-clickable.is-suggested:hover { background: #fde8dc; }
.qc-lookup-price-hint {
  margin: 8px 0 0;
  color: #6b7280;
  font-size: 12px;
}
.qc-lookup-price-actions-cell {
  white-space: nowrap;
}
.qc-lookup-price-use-btn {
  appearance: none;
  border: 1px solid #bfdbfe;
  border-radius: 4px;
  padding: 3px 8px;
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  color: #1d4ed8;
  background: #eff6ff;
  cursor: pointer;
}
.qc-lookup-price-use-btn:hover { background: #dbeafe; }
`;
    document.documentElement.appendChild(style);
}

function readPowerSelectText(root) {
    if (!root) return "";
    const selected = root.querySelector(
        ".ember-power-select-selected-item, .ember-power-select-trigger, [aria-label]"
    );
    const text = (selected && (selected.textContent || selected.getAttribute("aria-label"))) || root.textContent || "";
    return String(text).replace(/\s+/g, " ").trim();
}

function readFormFieldContext(form) {
    const urlInput =
        form.querySelector('.form-column.url input, .url input, input[name="url"]') ||
        findInputByLabelTextIn(form, "URL");
    const catalogCol = form.querySelector(".form-column.catalog-number") || form;
    const vendorCol = form.querySelector(".form-column.company-name") || form;
    const catalogTrigger =
        catalogCol.querySelector('.ember-power-select-trigger[aria-label*="catalog" i]') ||
        catalogCol.querySelector(".ember-power-select-trigger");
    const vendorTrigger =
        vendorCol.querySelector('.ember-power-select-trigger[aria-label*="vendor" i]') ||
        vendorCol.querySelector(".ember-power-select-trigger");

    const catalogFromOption =
        (catalogTrigger &&
            catalogTrigger.querySelector(".list-option > .catalog-number, .option-text .catalog-number")) ||
        null;
    let catalogNumber = catalogFromOption
        ? String(catalogFromOption.textContent || "").trim()
        : readPowerSelectText(catalogTrigger);
    if (/^catalog number$/i.test(catalogNumber) || /^select/i.test(catalogNumber) || /^begin typing/i.test(catalogNumber)) {
        catalogNumber = "";
    }

    const vendorOfficial =
        (vendorTrigger && vendorTrigger.querySelector(".official, .option-text .official")) || null;
    let vendor = vendorOfficial
        ? String(vendorOfficial.textContent || "").trim()
        : readPowerSelectText(vendorTrigger);
    if (/^vendor$/i.test(vendor) || /^select/i.test(vendor) || /^begin typing/i.test(vendor)) {
        vendor = "";
    }

    const url = urlInput && urlInput.value ? String(urlInput.value).trim() : "";
    let keyword = "";
    try {
        keyword = new URLSearchParams(location.search).get("keyword") || "";
    } catch (e) {
        keyword = "";
    }

    return {
        url: url,
        catalogNumber: catalogNumber,
        vendor: vendor,
        keyword: String(keyword).trim()
    };
}

function findInputByLabelTextIn(root, labelText) {
    const labels = Array.from(root.querySelectorAll("label"));
    const label = labels.find((l) => (l.innerText || "").toLowerCase().includes(labelText.toLowerCase()));
    if (label) {
        const inputId = label.getAttribute("for");
        if (inputId) {
            const byId = document.getElementById(inputId);
            if (byId) return byId;
        }
        return (
            (label.nextElementSibling && label.nextElementSibling.querySelector("input")) ||
            (label.parentElement && label.parentElement.querySelector("input"))
        );
    }
    return null;
}

/**
 * Map vendor / keyword hints to a product PDP URL when the form URL field is empty.
 * @param {{ url: string, catalogNumber: string, vendor: string, keyword: string }} ctx
 * @returns {{ url: string, catalogNumber: string }|null}
 */
function resolveProductLookupTarget(ctx) {
    if (ctx.url && /^https?:\/\//i.test(ctx.url) && !/quartzy\.com/i.test(ctx.url)) {
        return { url: ctx.url, catalogNumber: ctx.catalogNumber || "" };
    }

    const keyword = ctx.keyword || "";
    const vendorText = (ctx.vendor || keyword).toLowerCase();
    let catalog = ctx.catalogNumber || "";

    if (!catalog && keyword) {
        const parts = keyword.trim().split(/\s+/);
        if (parts.length >= 2) {
            catalog = parts[parts.length - 1];
        } else if (/^[A-Z0-9][A-Z0-9._-]{2,40}$/i.test(keyword.trim())) {
            catalog = keyword.trim();
        }
    }

    if (!catalog) return null;

    if (/thermo|thermofisher|invitrogen|gibco|applied biosystems/i.test(vendorText) || /\bthermo\b/i.test(keyword)) {
        return {
            url: "https://www.thermofisher.com/order/catalog/product/" + encodeURIComponent(catalog),
            catalogNumber: catalog
        };
    }
    if (/fisher|fishersci/i.test(vendorText) || /\bfisher\b/i.test(keyword)) {
        return {
            url: "https://www.fishersci.com/shop/products/" + encodeURIComponent(catalog),
            catalogNumber: catalog
        };
    }
    if (/\bvwr\b|avantor/i.test(vendorText) || /\bvwr\b/i.test(keyword)) {
        return {
            url: "https://us.vwr.com/store/product/" + encodeURIComponent(catalog),
            catalogNumber: catalog
        };
    }
    if (/sigma|millipore|merck/i.test(vendorText) || /\bsigma\b/i.test(keyword)) {
        return {
            url: "https://www.sigmaaldrich.com/US/en/product/" + encodeURIComponent(catalog),
            catalogNumber: catalog
        };
    }

    return null;
}

function normalizePriceDecimal(raw) {
    if (raw == null) return "";
    const s = String(raw).replace(/[^0-9.]/g, "");
    if (!s) return "";
    const parts = s.split(".");
    if (parts.length === 1) return parts[0];
    return parts[0] + "." + parts.slice(1).join("");
}

function setNativeInputValue(input, value) {
    if (!input || input.disabled || input.readOnly) return false;
    if (value == null) return false;
    const text = String(value);
    if (!text) return false;

    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    nativeInputValueSetter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    input.blur();
    return true;
}

function setUnitPriceValue(input, priceRaw) {
    const decimal = normalizePriceDecimal(priceRaw);
    if (!decimal) return false;
    return setNativeInputValue(input, decimal);
}

function getUnitPriceInput(form) {
    return (
        form.querySelector(".unit-price input") ||
        form.querySelector(".unit-price .qz-input input") ||
        form.querySelector('input[name="price"]') ||
        findInputByLabelTextIn(form, "Unit Price")
    );
}

function getUnitSizeInput(form) {
    return (
        form.querySelector('input[name="unit"]') ||
        form.querySelector(".unit-size input") ||
        findInputByLabelTextIn(form, "Unit Size")
    );
}

function buildVariantProductUrl(baseUrl, fromCatalog, toCatalog, knownCatalogs) {
    if (!baseUrl || !toCatalog) return null;
    const to = String(toCatalog).trim();
    if (!to) return null;
    const from = fromCatalog != null ? String(fromCatalog).trim() : "";
    try {
        const u = new URL(baseUrl);
        const path = u.pathname;

        if (from && from.toLowerCase() !== to.toLowerCase()) {
            if (path.indexOf(from) !== -1) {
                u.pathname = path.split(from).join(to);
                return u.href;
            }
            const keys = ["sku", "catalog", "catalogNumber", "catalog_number", "productId", "product_id", "id"];
            for (let i = 0; i < keys.length; i++) {
                if (u.searchParams.has(keys[i]) && String(u.searchParams.get(keys[i])) === from) {
                    u.searchParams.set(keys[i], to);
                    return u.href;
                }
            }
        }

        const parts = path.split("/").filter(Boolean);
        if (parts.length) {
            const last = parts[parts.length - 1];
            const catalogs = Array.isArray(knownCatalogs) ? knownCatalogs : [];
            const lastIsKnown =
                catalogs.some(function (c) {
                    return c && String(c).toLowerCase() === String(last).toLowerCase();
                }) || /^[A-Z0-9][A-Z0-9._-]{2,40}$/i.test(last);
            if (lastIsKnown) {
                parts[parts.length - 1] = to;
                u.pathname = "/" + parts.join("/");
                return u.href;
            }
        }

        const productIdx = parts
            .map(function (p) {
                return p.toLowerCase();
            })
            .indexOf("product");
        if (productIdx >= 0 && productIdx < parts.length - 1) {
            parts[productIdx + 1] = to;
            u.pathname = "/" + parts.join("/");
            return u.href;
        }
    } catch (e) {
        return null;
    }
    return null;
}

function getLookupState(form) {
    let state = lookupPriceStateByForm.get(form);
    if (!state) {
        state = { pageUrl: "", selectedCatalog: "", inFlight: false };
        lookupPriceStateByForm.set(form, state);
    }
    return state;
}

function setLookupStatus(ui, text, kind) {
    if (!ui || !ui.status) return;
    if (!text) {
        ui.status.hidden = true;
        ui.status.textContent = "";
        ui.status.className = "qc-lookup-price-status";
        return;
    }
    ui.status.hidden = false;
    ui.status.textContent = text;
    ui.status.className =
        "qc-lookup-price-status" +
        (kind === "loading" ? " is-loading" : kind === "error" ? " is-error" : kind === "warn" ? " is-warn" : "");
}

function pickBestVariant(result) {
    const variants = (result && Array.isArray(result.variants) && result.variants) || [];
    for (let i = 0; i < variants.length; i++) {
        if (variants[i] && variants[i].isSuggestedMatch && variants[i].price) return variants[i];
    }
    for (let i = 0; i < variants.length; i++) {
        if (variants[i] && variants[i].isSelected && variants[i].price) return variants[i];
    }
    for (let i = 0; i < variants.length; i++) {
        if (variants[i] && variants[i].price) return variants[i];
    }
    if (result && result.baseline && result.baseline.price) {
        return {
            price: result.baseline.price,
            catalogNumber: result.baseline.catalogNumber,
            unitSize: result.baseline.unitSize,
            label: "Selected"
        };
    }
    return variants[0] || null;
}

function rememberLookupContext(form, result, requestUrl) {
    const state = getLookupState(form);
    const pageUrl =
        (result && (result.pageUrl || result.url)) ||
        requestUrl ||
        state.pageUrl ||
        "";
    if (pageUrl) state.pageUrl = String(pageUrl);

    const variants = (result && Array.isArray(result.variants) && result.variants) || [];
    let selected = "";
    for (let i = 0; i < variants.length; i++) {
        if (variants[i].isSelected || variants[i].isSuggestedMatch) {
            selected = variants[i].catalogNumber || "";
            if (selected) break;
        }
    }
    if (!selected && result && result.baseline && result.baseline.catalogNumber) {
        selected = result.baseline.catalogNumber;
    }
    state.selectedCatalog = selected ? String(selected) : state.selectedCatalog;
}

function applyPriceToForm(form, variant, ui, statusKind) {
    const input = getUnitPriceInput(form);
    if (!input) {
        setLookupStatus(ui, "Could not find the Unit Price field.", "error");
        return false;
    }
    if (input.disabled || input.readOnly) {
        setLookupStatus(ui, "Unit Price is locked for this item.", "warn");
        return false;
    }
    if (!variant || !variant.price) {
        setLookupStatus(ui, "No price available for that option.", "warn");
        return false;
    }
    const ok = setUnitPriceValue(input, variant.price);
    if (!ok) {
        setLookupStatus(ui, "Could not write Unit Price.", "error");
        return false;
    }

    let unitApplied = false;
    if (variant.unitSize) {
        const unitInput = getUnitSizeInput(form);
        if (unitInput && !unitInput.disabled && !unitInput.readOnly) {
            unitApplied = setNativeInputValue(unitInput, variant.unitSize);
        }
    }

    const unit = variant.unitSize ? " / " + variant.unitSize : "";
    const cat = variant.catalogNumber ? " · " + variant.catalogNumber : "";
    const where = unitApplied ? "Unit Price and Unit Size" : "Unit Price";
    setLookupStatus(ui, "Saved " + normalizePriceDecimal(variant.price) + unit + cat + " to " + where + ".", statusKind || "");
    return true;
}

function renderLookupResult(form, ui, result, requestUrl) {
    if (!ui || !ui.panel) return;
    ui.panel.textContent = "";
    rememberLookupContext(form, result, requestUrl);

    const variants = (result && Array.isArray(result.variants) && result.variants) || [];
    const mode = result && result.mode === "list" && variants.length > 1 ? "list" : "single";
    const showVariants = !!(ui.toggle && ui.toggle.checked);
    const best = pickBestVariant(result);

    if (result && result.loginState === "logged_out" && result.ok) {
        const warn = document.createElement("p");
        warn.className = "qc-lookup-price-status is-warn";
        warn.textContent = "Vendor session looks logged out; prices may be list/public only.";
        ui.panel.appendChild(warn);
    }

    if (mode === "single" || !showVariants) {
        if (best && best.price) {
            const p = document.createElement("p");
            p.className = "qc-lookup-price-single";
            const unit = best.unitSize ? " / " + best.unitSize : "";
            const cat = best.catalogNumber ? " · " + best.catalogNumber : "";
            p.textContent = normalizePriceDecimal(best.price) + unit + cat;
            ui.panel.appendChild(p);
        } else {
            const p = document.createElement("p");
            p.className = "qc-lookup-price-status is-warn";
            p.textContent = "No price found on the product page.";
            ui.panel.appendChild(p);
        }
        if (mode === "list" && !showVariants) {
            const hint = document.createElement("p");
            hint.className = "qc-lookup-price-hint";
            hint.textContent =
                "Found " + variants.length + " variants. Check “Show variants” to compare or pick another.";
            ui.panel.appendChild(hint);
        }
    }

    if (mode === "list" && showVariants) {
        const state = getLookupState(form);
        const knownCatalogs = variants
            .map(function (v) {
                return v && v.catalogNumber ? String(v.catalogNumber) : "";
            })
            .filter(Boolean);
        const wrap = document.createElement("div");
        wrap.className = "qc-lookup-price-table-wrap";
        const table = document.createElement("table");
        table.className = "qc-lookup-price-table";
        const thead = document.createElement("thead");
        const hr = document.createElement("tr");
        ["Label", "Catalog #", "Price", "Unit", ""].forEach(function (h) {
            const th = document.createElement("th");
            th.textContent = h;
            hr.appendChild(th);
        });
        thead.appendChild(hr);
        table.appendChild(thead);
        const tbody = document.createElement("tbody");

        variants.forEach(function (v) {
            const tr = document.createElement("tr");
            if (v && (v.isSuggestedMatch || v.isSelected)) tr.classList.add("is-suggested");
            const cat = v && v.catalogNumber ? String(v.catalogNumber).trim() : "";
            const siblingUrl = cat
                ? buildVariantProductUrl(state.pageUrl, state.selectedCatalog, cat, knownCatalogs)
                : null;

            const cells = [v.label || "", v.catalogNumber || "", v.price || "—", v.unitSize || ""];
            cells.forEach(function (c) {
                const td = document.createElement("td");
                td.textContent = c;
                tr.appendChild(td);
            });

            const actionTd = document.createElement("td");
            actionTd.className = "qc-lookup-price-actions-cell";
            if (v && v.price) {
                const useBtn = document.createElement("button");
                useBtn.type = "button";
                useBtn.className = "qc-lookup-price-use-btn";
                useBtn.textContent = "Use";
                useBtn.addEventListener("click", function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    applyPriceToForm(form, v, ui);
                });
                actionTd.appendChild(useBtn);
            } else if (siblingUrl && cat) {
                const fetchBtn = document.createElement("button");
                fetchBtn.type = "button";
                fetchBtn.className = "qc-lookup-price-use-btn";
                fetchBtn.textContent = "Fetch";
                fetchBtn.title = "Open this catalog #’s product page and fetch its price";
                fetchBtn.addEventListener("click", function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    runLookupPriceForForm(form, ui, { url: siblingUrl, catalogNumber: cat });
                });
                actionTd.appendChild(fetchBtn);
                tr.classList.add("is-clickable");
                tr.title = "Fetch price for " + cat;
                tr.addEventListener("click", function () {
                    const st = getLookupState(form);
                    if (st.inFlight) return;
                    runLookupPriceForForm(form, ui, { url: siblingUrl, catalogNumber: cat });
                });
            }
            tr.appendChild(actionTd);
            tbody.appendChild(tr);
        });

        table.appendChild(tbody);
        wrap.appendChild(table);
        ui.panel.appendChild(wrap);

        const hint = document.createElement("p");
        hint.className = "qc-lookup-price-hint";
        hint.textContent =
            "Use applies price to Unit Price and unit to Unit Size. Fetch opens that catalog #’s product URL when price is missing.";
        ui.panel.appendChild(hint);
    }

    ui.panel.hidden = false;
}

function runLookupPriceForForm(form, ui, overrideTarget) {
    const state = getLookupState(form);
    if (state.inFlight) return;

    const ctx = readFormFieldContext(form);
    const target = overrideTarget || resolveProductLookupTarget(ctx);
    if (!target || !target.url) {
        setLookupStatus(
            ui,
            "Need a product URL, or Vendor + Catalog # / keyword (e.g. thermo 11965092).",
            "error"
        );
        return;
    }

    state.inFlight = true;
    if (ui.btn) ui.btn.disabled = true;
    const loadingMsg = overrideTarget
        ? "Fetching " + (target.catalogNumber || "variant") + "…"
        : "Opening vendor page and fetching price…";
    setLookupStatus(ui, loadingMsg, "loading");
    if (ui.panel && !overrideTarget) {
        ui.panel.hidden = true;
        ui.panel.textContent = "";
    }
    state.pageUrl = target.url;

    chrome.runtime.sendMessage(
        {
            type: "FETCH_PRICE_REQUEST",
            url: target.url,
            catalogNumber: target.catalogNumber || undefined
        },
        function (response) {
            state.inFlight = false;
            if (ui.btn) ui.btn.disabled = false;

            if (chrome.runtime.lastError) {
                setLookupStatus(ui, chrome.runtime.lastError.message || "Extension message failed.", "error");
                return;
            }

            const result = response || {};
            ui._lastResult = result;
            ui._lastUrl = target.url;

            if (!result.ok) {
                const code = result.error || "error";
                const msg = result.errorMessage || "Fetch failed.";
                const kind = code === "login_wall" || code === "bot_check" ? "warn" : "error";
                setLookupStatus(ui, msg, kind);
                if (Array.isArray(result.variants) && result.variants.length) {
                    renderLookupResult(form, ui, result, target.url);
                }
                return;
            }

            const best = pickBestVariant(result);
            const listCount = Array.isArray(result.variants) ? result.variants.length : 0;
            if (result.mode === "list" && listCount > 1 && ui.toggle && !ui.toggle.checked) {
                /* Surface the variant table like the side panel when multiple options exist. */
                ui.toggle.checked = true;
            }
            const applied = best && best.price ? applyPriceToForm(form, best, ui) : false;
            if (!applied) {
                setLookupStatus(
                    ui,
                    result.mode === "list"
                        ? "Found " + listCount + " variants — pick one below."
                        : "No price found to save.",
                    "warn"
                );
            } else if (result.mode === "list" && listCount > 1) {
                setLookupStatus(
                    ui,
                    "Saved price. " + listCount + " variants listed — Use another row or Fetch a missing price.",
                    ""
                );
            }

            renderLookupResult(form, ui, result, target.url);
        }
    );
}

function createLookupPriceUi(form) {
    const root = document.createElement("div");
    root.className = "qc-lookup-price-column";
    root.setAttribute(LOOKUP_PRICE_ROOT_ATTR, "1");

    const inner = document.createElement("div");
    inner.className = "qc-lookup-price";

    const row = document.createElement("div");
    row.className = "qc-lookup-price-row";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "qc-lookup-price-btn";
    btn.textContent = "Lookup Price";

    const toggleLabel = document.createElement("label");
    toggleLabel.className = "qc-lookup-price-toggle";
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggleLabel.appendChild(toggle);
    toggleLabel.appendChild(document.createTextNode("Show variants"));

    row.appendChild(btn);
    row.appendChild(toggleLabel);

    const status = document.createElement("p");
    status.className = "qc-lookup-price-status";
    status.hidden = true;

    const panel = document.createElement("div");
    panel.className = "qc-lookup-price-panel";
    panel.hidden = true;

    inner.appendChild(row);
    inner.appendChild(status);
    inner.appendChild(panel);
    root.appendChild(inner);

    const ui = { root: root, btn: btn, toggle: toggle, status: status, panel: panel, _lastResult: null, _lastUrl: "" };

    btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        runLookupPriceForForm(form, ui);
    });

    toggle.addEventListener("change", function () {
        if (ui._lastResult) {
            renderLookupResult(form, ui, ui._lastResult, ui._lastUrl);
        }
    });

    return ui;
}

/**
 * Prefer a dedicated slot after the qty/price form-row so Ember flex layout
 * does not clip the control. Fall back to Total column / row children.
 * Never return our own injected node — that would remount-loop via MutationObserver.
 * @param {Element} form
 * @returns {{ anchor: Element, placement: "afterend"|"beforeend" }|null}
 */
function findLookupPriceMountTarget(form) {
    const priceInput = getUnitPriceInput(form);
    if (!priceInput) return null;

    const priceRow = priceInput.closest(".form-row");
    if (priceRow && priceRow.parentNode) {
        return { anchor: priceRow, placement: "afterend" };
    }

    const totalCol = form.querySelector(".form-column.total-column");
    if (totalCol && totalCol.parentNode) {
        return { anchor: totalCol, placement: "afterend" };
    }

    const unitPrice = form.querySelector(".unit-price");
    if (unitPrice && unitPrice.parentNode) {
        return { anchor: unitPrice, placement: "afterend" };
    }

    return { anchor: form, placement: "beforeend" };
}

function mountLookupPriceOnForm(form) {
    if (!form) return;
    if (!getUnitPriceInput(form)) return;

    const target = findLookupPriceMountTarget(form);
    if (!target || !target.anchor || !target.anchor.parentNode) return;

    const existing = form.querySelector("[" + LOOKUP_PRICE_ROOT_ATTR + "]");
    if (existing) {
        const correctlyPlaced =
            (target.placement === "afterend" && existing.previousElementSibling === target.anchor) ||
            (target.placement === "beforeend" && existing.parentNode === target.anchor);
        if (correctlyPlaced || existing.contains(target.anchor) || existing === target.anchor) {
            return;
        }
        if (target.placement === "afterend") {
            target.anchor.insertAdjacentElement("afterend", existing);
        } else {
            target.anchor.appendChild(existing);
        }
        return;
    }

    ensureLookupPriceStyles();
    const ui = createLookupPriceUi(form);
    if (target.placement === "afterend") {
        target.anchor.insertAdjacentElement("afterend", ui.root);
    } else {
        target.anchor.appendChild(ui.root);
    }
    console.log("[Quartzy Bridge] Lookup Price mounted on add-request form");
}

function scanAndMountLookupPrice() {
    if (!isLookupPriceEnabled() || !isAddRequestPage()) return;
    const forms = document.querySelectorAll(".request-form");
    if (!forms.length) return;
    forms.forEach(function (form) {
        if (getUnitPriceInput(form)) {
            mountLookupPriceOnForm(form);
        }
    });
}

/**
 * Ember SPA navigations do not always reload the document. Observe history + DOM.
 * @param {() => void} onChange
 * @param {number} [intervalMs]
 */
function watchQuartzyDomAndRoute(onChange, intervalMs) {
    let scheduled = false;
    const tick = function () {
        scheduled = false;
        onChange();
    };
    const schedule = function () {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(tick);
    };

    tick();
    const obs = new MutationObserver(schedule);
    if (document.documentElement) {
        obs.observe(document.documentElement, { childList: true, subtree: true });
    }
    setInterval(tick, intervalMs || 1500);

    try {
        const wrapHistory = function (method) {
            const orig = history[method];
            if (typeof orig !== "function") return;
            history[method] = function () {
                const ret = orig.apply(this, arguments);
                schedule();
                return ret;
            };
        };
        wrapHistory("pushState");
        wrapHistory("replaceState");
        window.addEventListener("popstate", schedule);
    } catch (e) {
        /* ignore */
    }
}

/* —— Add to vendor site (Order Requests IDP + Group Actions) —— */

const ATV_STYLE_ID = "qc-add-to-vendor-style";
const ATV_IDP_BTN_ID = "order-request-add-to-vendor-site";
const ATV_GROUP_BTN_ID = "order-request-group-action-add-to-vendor-site";
const ATV_METHOD_MENU_ID = "qc-atv-method-menu";
const ATV_TOAST_ID = "qc-atv-toast";
const REQUESTS_PATH_RE = /^\/groups\/[^/]+\/requests(?:\/|$)/i;
/** Vendors with Quick Order / Bulk Upload file templates in cartGenerator.js */
const ATV_BULK_UPLOAD_VENDORS = { fisher: true, vwr: true, sigma: true };

function isAddToVendorSiteEnabled() {
    return typeof QUARTZY_ADD_TO_VENDOR_SITE_ENABLED !== "undefined" && QUARTZY_ADD_TO_VENDOR_SITE_ENABLED === true;
}

function isCartStuffingEnabled() {
    return typeof QUARTZY_CART_STUFFING_ENABLED !== "undefined" && QUARTZY_CART_STUFFING_ENABLED === true;
}

function isOrderRequestsPage() {
    try {
        return REQUESTS_PATH_RE.test(location.pathname);
    } catch (e) {
        return false;
    }
}

function ensureAddToVendorStyles() {
    let style = document.getElementById(ATV_STYLE_ID);
    if (!style) {
        style = document.createElement("style");
        style.id = ATV_STYLE_ID;
        document.documentElement.appendChild(style);
    }
    /* Always rewrite so extension reloads pick up CSS fixes without a hard cache. */
    style.textContent = `
/* IDP action row: center with Request Again / More (Quartzy .menu is display:flex) */
.main-panel-header .menu:has(#${ATV_IDP_BTN_ID}),
.details-panel-header .menu:has(#${ATV_IDP_BTN_ID}),
.details-panel .menu:has(#${ATV_IDP_BTN_ID}) {
  align-items: center !important;
}
#${ATV_IDP_BTN_ID} {
  appearance: none !important;
  -webkit-appearance: none !important;
  box-sizing: border-box !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  align-self: center !important;
  flex: 0 0 auto !important;
  width: auto !important;
  max-width: none !important;
  min-width: 0 !important;
  height: auto !important;
  min-height: 0 !important;
  /* margin-top is set in JS to match Request Again; do not !important it */
  margin-right: 1rem !important;
  margin-bottom: 0 !important;
  margin-left: 0 !important;
  padding: 1px 8px !important;
  border: 1px solid #f75e2d !important;
  border-radius: 3px !important;
  background: #fff !important;
  color: #f75e2d !important;
  font-size: 0.875rem !important;
  font-weight: 600 !important;
  font-family: inherit !important;
  line-height: 1.25 !important;
  letter-spacing: normal !important;
  text-align: center !important;
  vertical-align: middle !important;
  cursor: pointer !important;
  white-space: nowrap !important;
  position: relative !important;
}
#${ATV_IDP_BTN_ID}:hover:not(:disabled) {
  background: #fff7f3 !important;
}
#${ATV_IDP_BTN_ID}:disabled {
  opacity: 0.55 !important;
  cursor: not-allowed !important;
}
/* Fallback only — prefer cloned Quartzy status-button classes when present */
#${ATV_GROUP_BTN_ID}:not([class]) {
  display: block;
  width: 100%;
  text-align: left;
  padding: 1rem 1.5rem;
  border: none;
  background: #fff;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
#${ATV_GROUP_BTN_ID}:not([class]):hover:not(:disabled),
#${ATV_GROUP_BTN_ID}:not([class]):focus:not(:disabled) {
  background: #f7f7f7;
}
#${ATV_GROUP_BTN_ID}:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
#${ATV_TOAST_ID} {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 2147483646;
  max-width: 360px;
  padding: 10px 14px;
  border-radius: 8px;
  background: #111827;
  color: #f9fafb;
  font-size: 13px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  box-shadow: 0 8px 24px rgba(0,0,0,0.25);
  opacity: 0;
  transform: translateY(8px);
  transition: opacity 0.2s, transform 0.2s;
  pointer-events: none;
}
#${ATV_TOAST_ID}.is-show {
  opacity: 1;
  transform: translateY(0);
}
#${ATV_TOAST_ID}.is-error {
  background: #7f1d1d;
}
#${ATV_TOAST_ID}.is-ok {
  background: #14532d;
}
#${ATV_METHOD_MENU_ID} {
  position: fixed;
  z-index: 2147483647;
  min-width: 220px;
  max-width: 300px;
  padding: 6px;
  border-radius: 8px;
  background: #fff;
  border: 1px solid #e5e7eb;
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.18);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
#${ATV_METHOD_MENU_ID}[hidden] { display: none !important; }
#${ATV_METHOD_MENU_ID} .qc-atv-method-title {
  margin: 0 8px 4px;
  padding-top: 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: #6b7280;
}
#${ATV_METHOD_MENU_ID} button.qc-atv-method-opt {
  display: block;
  width: 100%;
  text-align: left;
  appearance: none;
  border: none;
  background: transparent;
  border-radius: 6px;
  padding: 8px 10px;
  cursor: pointer;
  color: #111827;
  font: inherit;
}
#${ATV_METHOD_MENU_ID} button.qc-atv-method-opt:hover:not(:disabled),
#${ATV_METHOD_MENU_ID} button.qc-atv-method-opt:focus-visible:not(:disabled) {
  background: #fff7f3;
  color: #c2410c;
  outline: none;
}
#${ATV_METHOD_MENU_ID} button.qc-atv-method-opt:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
#${ATV_METHOD_MENU_ID} .qc-atv-method-label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.3;
}
#${ATV_METHOD_MENU_ID} .qc-atv-method-sub {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  font-weight: 400;
  color: #6b7280;
  line-height: 1.35;
}
`;
}

/**
 * Quartzy’s .cta button { width:100% } + flex stretch can leave our outline
 * button sitting on the top edge of the action row. Nudge it so its vertical
 * center matches Request Again (or More).
 */
function alignIdpAddToVendorButton() {
    const btn = document.getElementById(ATV_IDP_BTN_ID);
    if (!btn || !btn.parentElement) return;
    const menu = btn.parentElement;
    const peer =
        menu.querySelector(".re-request-link") ||
        menu.querySelector(".more-dropdown .idp-actions-dropdown-button") ||
        menu.querySelector(".more-dropdown button");
    if (!peer) return;

    btn.style.setProperty("margin-top", "0px");
    const btnRect = btn.getBoundingClientRect();
    const peerRect = peer.getBoundingClientRect();
    if (!btnRect.height || !peerRect.height) return;

    const delta =
        peerRect.top + peerRect.height / 2 - (btnRect.top + btnRect.height / 2);
    if (Math.abs(delta) >= 0.5) {
        btn.style.setProperty("margin-top", Math.round(delta) + "px");
    }
}

let atvToastTimer = null;
function showAtvToast(message, kind) {
    let el = document.getElementById(ATV_TOAST_ID);
    if (!el) {
        el = document.createElement("div");
        el.id = ATV_TOAST_ID;
        el.setAttribute("role", "status");
        document.body.appendChild(el);
    }
    el.textContent = message;
    el.className = "is-show" + (kind === "error" ? " is-error" : kind === "ok" ? " is-ok" : "");
    if (atvToastTimer) clearTimeout(atvToastTimer);
    atvToastTimer = setTimeout(function () {
        el.classList.remove("is-show");
    }, 4500);
}

/**
 * Map Quartzy vendor display name (or URL host) → vendorCartConfigs key.
 * @param {string} vendorName
 * @param {string} [productUrl]
 * @returns {string}
 */
function resolveVendorIdFromQuartzy(vendorName, productUrl) {
    const name = String(vendorName || "").toLowerCase();
    const url = String(productUrl || "").toLowerCase();
    const hay = name + " " + url;
    if (/fisher\s*scientific|fishersci/.test(hay)) return "fisher";
    if (/thermo\s*fisher|thermofisher/.test(hay)) return "thermo";
    if (/\bvwr\b|avantor/.test(hay)) return "vwr";
    if (/sigma|millipore/.test(hay)) return "sigma";
    if (/abcam/.test(hay)) return "abcam";
    if (/thomas\s*(scientific|ci)/.test(hay)) return "thomas";
    try {
        if (productUrl && /^https?:/i.test(productUrl)) {
            const host = new URL(productUrl).hostname.toLowerCase().replace(/^www\./, "");
            if (host.indexOf("fishersci") !== -1) return "fisher";
            if (host.indexOf("thermofisher") !== -1) return "thermo";
            if (host.indexOf("vwr") !== -1 || host.indexOf("avantor") !== -1) return "vwr";
            if (host.indexOf("sigma") !== -1 || host.indexOf("millipore") !== -1) return "sigma";
            if (host.indexOf("abcam") !== -1) return "abcam";
            const parts = host.split(".");
            if (parts.length >= 2) return parts[parts.length - 2];
        }
    } catch (e) {
        /* ignore */
    }
    const cleaned = name
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .split(/\s+/)[0];
    return cleaned || "";
}

function readInputValue(el) {
    if (!el) return "";
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
        return String(el.value != null ? el.value : "").trim();
    }
    return String(el.textContent || "").trim();
}

/**
 * @param {Element} root
 * @returns {{ sku: string, qty: string, vendorName: string, productUrl: string }}
 */
function scrapeIdpLine(root) {
    const panel = root || document.querySelector(".details-panel");
    const empty = { sku: "", qty: "1", vendorName: "", productUrl: "" };
    if (!panel) return empty;

    const catalog =
        panel.querySelector("input.catalog-number") ||
        panel.querySelector('input[name*="catalog" i]') ||
        panel.querySelector(".catalog-number input");
    const qtyEl =
        panel.querySelector("input.quantity-input") ||
        panel.querySelector(".quantity input") ||
        panel.querySelector('input[name*="quantity" i]');

    let vendorName = "";
    const vendorSelect = panel.querySelector(".vendor-select");
    if (vendorSelect) {
        vendorName =
            readInputValue(vendorSelect.querySelector("input")) ||
            String(
                (vendorSelect.querySelector(".ember-power-select-selected-item") ||
                    vendorSelect.querySelector("[aria-current]") ||
                    vendorSelect).textContent || ""
            ).trim();
    }
    if (!vendorName) {
        const company = panel.querySelector(".company-name");
        if (company) vendorName = String(company.textContent || "").trim();
    }

    let productUrl = "";
    const urlAnchor =
        panel.querySelector('[data-analytics-id="order-request.item.product-url"]') ||
        panel.querySelector('a[href*="http"][target="_blank"]');
    if (urlAnchor && urlAnchor.getAttribute) {
        productUrl = String(urlAnchor.getAttribute("href") || "").trim();
    }

    return {
        sku: readInputValue(catalog),
        qty: readInputValue(qtyEl) || "1",
        vendorName: vendorName,
        productUrl: productUrl
    };
}

/**
 * @param {Element} row
 * @returns {{ sku: string, qty: string, vendorName: string, productUrl: string }}
 */
function scrapeTableRow(row) {
    const empty = { sku: "", qty: "1", vendorName: "", productUrl: "" };
    if (!row) return empty;
    const vendorEl = row.querySelector(".column.vendor .company-name") || row.querySelector(".company-name");
    const catalogEl =
        row.querySelector(".catalog-number") ||
        row.querySelector(".catalog-number-line") ||
        row.querySelector(".column.catalog-number");
    const qtyEl =
        row.querySelector(".column.quantity") ||
        row.querySelector(".quantity") ||
        row.querySelector('td[data-column="quantity"]');
    const urlEl =
        row.querySelector('[data-analytics-id="order-request.item.product-url"]') ||
        row.querySelector('a[href^="http"]');

    let sku = "";
    if (catalogEl) {
        const input = catalogEl.querySelector && catalogEl.querySelector("input");
        sku = input ? readInputValue(input) : String(catalogEl.textContent || "").trim();
    }
    let qty = "1";
    if (qtyEl) {
        const input = qtyEl.querySelector && qtyEl.querySelector("input");
        qty = input ? readInputValue(input) : String(qtyEl.textContent || "").replace(/[^\d.]/g, "").trim() || "1";
    }

    return {
        sku: sku,
        qty: qty,
        vendorName: vendorEl ? String(vendorEl.textContent || "").trim() : "",
        productUrl: urlEl && urlEl.getAttribute ? String(urlEl.getAttribute("href") || "").trim() : ""
    };
}

/**
 * @returns {Array<{ sku: string, qty: string, vendorName: string, productUrl: string }>}
 */
function scrapeSelectedRequestRows() {
    const rows = Array.from(document.querySelectorAll("tr.item-row"));
    const selected = [];
    rows.forEach(function (row) {
        const cb =
            row.querySelector(".is-selected-checkbox input[type='checkbox']") ||
            row.querySelector("td.column.checkbox input[type='checkbox']") ||
            row.querySelector('input[type="checkbox"]');
        if (cb && cb.checked) {
            selected.push(scrapeTableRow(row));
        }
    });
    return selected;
}

/**
 * @param {object} message
 * @returns {Promise<object>}
 */
function sendRuntimeMessage(message) {
    return new Promise(function (resolve) {
        try {
            chrome.runtime.sendMessage(message, function (response) {
                if (chrome.runtime.lastError) {
                    resolve({
                        ok: false,
                        error: "extension",
                        errorMessage: chrome.runtime.lastError.message || "Extension messaging failed."
                    });
                    return;
                }
                resolve(response || { ok: false, error: "empty", errorMessage: "No response from extension." });
            });
        } catch (e) {
            resolve({
                ok: false,
                error: "extension",
                errorMessage: (e && e.message) || "Extension messaging failed."
            });
        }
    });
}

/**
 * @param {{ sku: string, qty: string, vendorName: string, productUrl: string }} line
 * @returns {Promise<object>}
 */
function sendAddToVendorCart(line) {
    const vendorId = resolveVendorIdFromQuartzy(line.vendorName, line.productUrl);
    return sendRuntimeMessage({
        type: "ADD_TO_VENDOR_CART",
        vendorId: vendorId,
        sku: line.sku,
        qty: line.qty || "1",
        vendorName: line.vendorName,
        productUrl: line.productUrl
    });
}

/**
 * @param {Array<{ sku: string, qty: string, vendorName: string, productUrl: string }>} lines
 * @param {string} vendorId
 * @returns {Promise<object>}
 */
function sendPushCartToVendor(lines, vendorId) {
    const items = (lines || []).map(function (line) {
        return {
            catalogNumber: String(line.sku || "").trim(),
            quantity: line.qty || "1",
            vendor: vendorId
        };
    });
    return sendRuntimeMessage({
        type: "PUSH_CART_TO_VENDOR",
        vendorName: vendorId,
        items: items,
        autoSubmit: true,
        clickAddToCart: false
    });
}

/**
 * @param {Array<{ sku: string, qty: string, vendorName: string, productUrl: string }>} lines
 * @returns {boolean}
 */
function linesSupportBulkUpload(lines) {
    if (!isCartStuffingEnabled()) return false;
    const usable = (lines || []).filter(function (l) {
        return l && String(l.sku || "").trim();
    });
    if (!usable.length) return false;
    return usable.some(function (line) {
        const id = resolveVendorIdFromQuartzy(line.vendorName, line.productUrl);
        return !!(id && ATV_BULK_UPLOAD_VENDORS[id]);
    });
}

function hideAtvMethodMenu() {
    const menu = document.getElementById(ATV_METHOD_MENU_ID);
    if (menu) menu.hidden = true;
    if (window.__qcAtvMethodOutsideClose) {
        document.removeEventListener("mousedown", window.__qcAtvMethodOutsideClose, true);
        window.__qcAtvMethodOutsideClose = null;
    }
    if (window.__qcAtvMethodEscClose) {
        document.removeEventListener("keydown", window.__qcAtvMethodEscClose, true);
        window.__qcAtvMethodEscClose = null;
    }
}

/**
 * Popover: Mapped cart API vs Quick Order CSV/XLS upload.
 * @param {HTMLElement} anchorEl
 * @param {Array<{ sku: string, qty: string, vendorName: string, productUrl: string }>} lines
 * @param {{ onBusy?: function(boolean): void }} [opts]
 */
function showAtvMethodMenu(anchorEl, lines, opts) {
    opts = opts || {};
    hideAtvMethodMenu();
    ensureAddToVendorStyles();

    let menu = document.getElementById(ATV_METHOD_MENU_ID);
    if (!menu) {
        menu = document.createElement("div");
        menu.id = ATV_METHOD_MENU_ID;
        menu.setAttribute("role", "menu");
        document.body.appendChild(menu);
    }

    const bulkOk = linesSupportBulkUpload(lines);
    menu.innerHTML = "";
    const title = document.createElement("p");
    title.className = "qc-atv-method-title";
    title.textContent = "Add to vendor site";
    menu.appendChild(title);

    function addOption(label, sub, disabled, onPick) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "qc-atv-method-opt";
        btn.setAttribute("role", "menuitem");
        btn.disabled = !!disabled;
        const lab = document.createElement("span");
        lab.className = "qc-atv-method-label";
        lab.textContent = label;
        const subEl = document.createElement("span");
        subEl.className = "qc-atv-method-sub";
        subEl.textContent = sub;
        btn.appendChild(lab);
        btn.appendChild(subEl);
        btn.addEventListener("click", function (e) {
            e.preventDefault();
            e.stopPropagation();
            if (btn.disabled) return;
            hideAtvMethodMenu();
            if (typeof opts.onBusy === "function") opts.onBusy(true);
            Promise.resolve(onPick())
                .catch(function () {
                    /* run* helpers toast their own errors */
                })
                .finally(function () {
                    if (typeof opts.onBusy === "function") opts.onBusy(false);
                });
        });
        menu.appendChild(btn);
    }

    addOption(
        "Mapped cart API",
        "Uses your saved vendorCartConfigs add_to_cart mapping",
        false,
        function () {
            return runAddToVendorForLines(lines, "api");
        }
    );
    addOption(
        "Quick Order upload (CSV / XLS)",
        bulkOk
            ? "Opens Fisher / VWR / Sigma Quick Order and drops a generated file"
            : isCartStuffingEnabled()
              ? "Only Fisher, VWR, and Sigma support file upload right now"
              : "Cart stuffing is disabled in featureFlags.js",
        !bulkOk,
        function () {
            return runAddToVendorForLines(lines, "bulk");
        }
    );

    menu.hidden = false;
    const rect = anchorEl.getBoundingClientRect();
    const menuWidth = Math.max(220, menu.offsetWidth || 220);
    let left = rect.left;
    if (left + menuWidth > window.innerWidth - 8) {
        left = Math.max(8, window.innerWidth - menuWidth - 8);
    }
    let top = rect.bottom + 6;
    menu.style.left = Math.round(left) + "px";
    menu.style.top = Math.round(top) + "px";
    requestAnimationFrame(function () {
        const h = menu.offsetHeight || 0;
        if (top + h > window.innerHeight - 8) {
            top = Math.max(8, rect.top - h - 6);
            menu.style.top = Math.round(top) + "px";
        }
    });

    window.__qcAtvMethodOutsideClose = function (ev) {
        if (!menu.contains(ev.target) && ev.target !== anchorEl && !anchorEl.contains(ev.target)) {
            hideAtvMethodMenu();
        }
    };
    window.__qcAtvMethodEscClose = function (ev) {
        if (ev.key === "Escape") hideAtvMethodMenu();
    };
    setTimeout(function () {
        document.addEventListener("mousedown", window.__qcAtvMethodOutsideClose, true);
        document.addEventListener("keydown", window.__qcAtvMethodEscClose, true);
    }, 0);
}

/**
 * @param {Array<{ sku: string, qty: string, vendorName: string, productUrl: string }>} lines
 */
async function runAddToVendorViaApi(lines) {
    const usable = (lines || []).filter(function (l) {
        return l && String(l.sku || "").trim();
    });
    if (!usable.length) {
        showAtvToast("No catalog # found on the selected request(s).", "error");
        return;
    }
    showAtvToast(
        usable.length === 1 ? "Adding via mapped cart API…" : "Adding " + usable.length + " items via mapped cart API…",
        ""
    );
    let okCount = 0;
    const errors = [];
    for (let i = 0; i < usable.length; i++) {
        const line = usable[i];
        const vendorId = resolveVendorIdFromQuartzy(line.vendorName, line.productUrl);
        if (!vendorId) {
            errors.push((line.sku || "?") + ": unknown vendor");
            continue;
        }
        const result = await sendAddToVendorCart(line);
        if (result && result.ok) {
            okCount += 1;
        } else {
            let detail = (result && result.errorMessage) || (result && result.error) || "failed";
            if (result && result.responsePreview) {
                const snippet = String(result.responsePreview)
                    .replace(/\s+/g, " ")
                    .trim()
                    .slice(0, 120);
                if (snippet) detail += " — " + snippet;
            }
            errors.push((line.sku || "?") + ": " + detail);
        }
        if (i < usable.length - 1) {
            await new Promise(function (r) {
                setTimeout(r, 400);
            });
        }
    }
    if (okCount && !errors.length) {
        showAtvToast(
            okCount === 1 ? "Added to vendor cart." : "Added " + okCount + " items to vendor carts.",
            "ok"
        );
    } else if (okCount && errors.length) {
        showAtvToast(okCount + " ok, " + errors.length + " failed. " + errors[0], "error");
    } else {
        showAtvToast(errors[0] || "Could not add to vendor cart.", "error");
    }
}

/**
 * Group lines by vendor and open Quick Order with a generated CSV/XLS per vendor.
 * @param {Array<{ sku: string, qty: string, vendorName: string, productUrl: string }>} lines
 */
async function runAddToVendorViaBulkUpload(lines) {
    if (!isCartStuffingEnabled()) {
        showAtvToast("Cart stuffing is disabled in featureFlags.js.", "error");
        return;
    }
    const usable = (lines || []).filter(function (l) {
        return l && String(l.sku || "").trim();
    });
    if (!usable.length) {
        showAtvToast("No catalog # found on the selected request(s).", "error");
        return;
    }

    /** @type {Record<string, Array<{ sku: string, qty: string, vendorName: string, productUrl: string }>>} */
    const byVendor = {};
    const skipped = [];
    usable.forEach(function (line) {
        const vendorId = resolveVendorIdFromQuartzy(line.vendorName, line.productUrl);
        if (!vendorId) {
            skipped.push((line.sku || "?") + ": unknown vendor");
            return;
        }
        if (!ATV_BULK_UPLOAD_VENDORS[vendorId]) {
            skipped.push((line.sku || "?") + ": " + vendorId + " has no Quick Order upload yet");
            return;
        }
        if (!byVendor[vendorId]) byVendor[vendorId] = [];
        byVendor[vendorId].push(line);
    });

    const vendorIds = Object.keys(byVendor);
    if (!vendorIds.length) {
        showAtvToast(skipped[0] || "No Fisher / VWR / Sigma items to upload.", "error");
        return;
    }

    showAtvToast(
        vendorIds.length === 1
            ? "Opening " + vendorIds[0] + " Quick Order…"
            : "Opening Quick Order for " + vendorIds.length + " vendors…",
        ""
    );

    let okCount = 0;
    const errors = skipped.slice();
    for (let i = 0; i < vendorIds.length; i++) {
        const vendorId = vendorIds[i];
        const group = byVendor[vendorId];
        const result = await sendPushCartToVendor(group, vendorId);
        if (result && result.ok) {
            okCount += 1;
        } else {
            errors.push(
                vendorId +
                    ": " +
                    ((result && result.errorMessage) || (result && result.error) || "upload failed")
            );
        }
        if (i < vendorIds.length - 1) {
            await new Promise(function (r) {
                setTimeout(r, 600);
            });
        }
    }

    if (okCount && !errors.length) {
        showAtvToast(
            okCount === 1
                ? "Opened Quick Order and attached the upload file."
                : "Opened Quick Order uploads for " + okCount + " vendors.",
            "ok"
        );
    } else if (okCount && errors.length) {
        showAtvToast(okCount + " opened, " + errors.length + " issue(s). " + errors[0], "error");
    } else {
        showAtvToast(errors[0] || "Could not open Quick Order upload.", "error");
    }
}

/**
 * @param {Array<{ sku: string, qty: string, vendorName: string, productUrl: string }>} lines
 * @param {'api'|'bulk'|undefined} [method]
 */
async function runAddToVendorForLines(lines, method) {
    if (method === "bulk") {
        return runAddToVendorViaBulkUpload(lines);
    }
    if (method === "api") {
        return runAddToVendorViaApi(lines);
    }
    /* Legacy / direct calls default to mapped API. */
    return runAddToVendorViaApi(lines);
}

function injectIdpAddToVendorButton() {
    const panel = document.querySelector(".details-panel");
    if (!panel) {
        const orphan = document.getElementById(ATV_IDP_BTN_ID);
        if (orphan) orphan.remove();
        return;
    }
    const existing = document.getElementById(ATV_IDP_BTN_ID);
    if (existing) {
        alignIdpAddToVendorButton();
        return;
    }

    const menu =
        panel.querySelector(".main-panel-header .right-column .cta .menu") ||
        panel.querySelector(".cta .menu") ||
        panel.querySelector(".main-panel-header .menu") ||
        panel.querySelector(".main-panel-header .cta") ||
        panel.querySelector(".main-panel-header .right-column") ||
        panel.querySelector(".main-panel-header");
    if (!menu) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = ATV_IDP_BTN_ID;
    btn.textContent = "Add to vendor site";
    btn.setAttribute(
        "aria-label",
        "Add this request’s catalog # to the vendor site (mapped API or Quick Order upload)"
    );
    btn.setAttribute("aria-haspopup", "menu");
    btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (btn.disabled) return;
        const existing = document.getElementById(ATV_METHOD_MENU_ID);
        if (existing && !existing.hidden) {
            hideAtvMethodMenu();
            return;
        }
        const line = scrapeIdpLine(panel);
        showAtvMethodMenu(btn, [line], {
            onBusy: function (busy) {
                btn.disabled = !!busy;
            }
        });
    });

    const more = menu.querySelector(".more-dropdown");
    if (more && more.parentNode === menu) {
        menu.insertBefore(btn, more);
    } else {
        const reRequest = menu.querySelector(".re-request-link");
        if (reRequest && reRequest.nextSibling) {
            menu.insertBefore(btn, reRequest.nextSibling);
        } else {
            menu.appendChild(btn);
        }
    }
    console.log("[Quartzy Bridge] Add to vendor site (IDP) mounted");
    requestAnimationFrame(function () {
        alignIdpAddToVendorButton();
        requestAnimationFrame(alignIdpAddToVendorButton);
    });
    setTimeout(alignIdpAddToVendorButton, 50);
    setTimeout(alignIdpAddToVendorButton, 250);
}

function findGroupActionsMenuList() {
    const trigger = document.getElementById("order-request-group-actions");
    if (!trigger) return null;
    /* Ember dropdown content may be portaled; prefer open list near trigger, else any status-button list. */
    const openMenu =
        document.querySelector('[aria-labelledby="order-request-group-actions"]') ||
        document.querySelector("#order-request-group-actions + * ul") ||
        document.querySelector(".ember-basic-dropdown-content ul");
    if (openMenu && openMenu.querySelector) {
        const withStatus = openMenu.querySelector("button") ? openMenu : null;
        if (withStatus) {
            if (openMenu.tagName === "UL") return openMenu;
            const ul = openMenu.querySelector("ul");
            if (ul) return ul;
            return openMenu;
        }
    }
    const buttons = Array.from(document.querySelectorAll("button"));
    for (let i = 0; i < buttons.length; i++) {
        const t = String(buttons[i].textContent || "").trim();
        if (/^request again$/i.test(t) || /^order with qbot$/i.test(t)) {
            const li = buttons[i].closest("li");
            const ul = li && li.parentElement;
            if (ul && (ul.tagName === "UL" || ul.getAttribute("role") === "menu")) {
                return ul;
            }
        }
    }
    return null;
}

/**
 * Copy CSS-module class hashes from a native Group Actions row so our item
 * matches Mark Ordered / Request Again / Export styling exactly.
 * @param {Element} list
 * @returns {{ liClass: string, btnClass: string }}
 */
function getGroupActionsSampleClasses(list) {
    const sampleBtn =
        list.querySelector("#order-request-group-action-request-again") ||
        list.querySelector("#order-request-create-po") ||
        Array.from(list.querySelectorAll("li button")).find(function (b) {
            const t = String(b.textContent || "").trim();
            return /^(request again|create po|export)/i.test(t);
        });
    const sampleLi = sampleBtn && sampleBtn.closest("li");
    return {
        liClass: sampleLi && sampleLi.className ? String(sampleLi.className) : "",
        btnClass: sampleBtn && sampleBtn.className ? String(sampleBtn.className) : ""
    };
}

function injectGroupAddToVendorButton() {
    if (document.getElementById(ATV_GROUP_BTN_ID)) return;
    const list = findGroupActionsMenuList();
    if (!list) return;

    const sample = getGroupActionsSampleClasses(list);
    const li = document.createElement("li");
    li.setAttribute("data-qc-atv-group-item", "1");
    if (sample.liClass) li.className = sample.liClass;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = ATV_GROUP_BTN_ID;
    if (sample.btnClass) btn.className = sample.btnClass;
    btn.textContent = "Add to Vendor Site";
    btn.setAttribute("aria-label", "Add selected requests to vendor sites (mapped API or Quick Order upload)");
    btn.setAttribute("aria-haspopup", "menu");
    btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (btn.disabled) return;
        const existing = document.getElementById(ATV_METHOD_MENU_ID);
        if (existing && !existing.hidden) {
            hideAtvMethodMenu();
            return;
        }
        const lines = scrapeSelectedRequestRows();
        if (!lines.length) {
            showAtvToast("Select one or more requests first.", "error");
            return;
        }
        showAtvMethodMenu(btn, lines, {
            onBusy: function (busy) {
                btn.disabled = !!busy;
            }
        });
    });
    li.appendChild(btn);

    const kids = Array.from(list.children);
    let insertBefore = null;
    for (let i = 0; i < kids.length; i++) {
        const label = String(kids[i].textContent || "").trim();
        if (/^export/i.test(label) || /^cancel/i.test(label) || /^delete/i.test(label)) {
            insertBefore = kids[i];
            break;
        }
    }
    if (insertBefore) {
        list.insertBefore(li, insertBefore);
    } else {
        list.appendChild(li);
    }
    console.log("[Quartzy Bridge] Add to vendor site (Group Actions) mounted");
}

function scanAndInjectAddToVendorControls() {
    if (!isAddToVendorSiteEnabled() || !isOrderRequestsPage()) return;
    ensureAddToVendorStyles();
    injectIdpAddToVendorButton();
    injectGroupAddToVendorButton();
}

