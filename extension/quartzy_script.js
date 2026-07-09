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

    initLookupPriceOnAddRequest();
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
const ADD_REQUEST_PATH_RE = /^\/groups\/\d+\/requests\/new\/?$/i;

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
    let style = document.getElementById(LOOKUP_PRICE_STYLE_ID);
    if (!style) {
        style = document.createElement("style");
        style.id = LOOKUP_PRICE_STYLE_ID;
        document.documentElement.appendChild(style);
    }
    style.textContent = `
.qc-lookup-price-column {
  flex: 0 0 auto;
  display: flex;
  align-items: flex-end;
  margin-left: 4px;
  overflow: visible;
  position: relative;
}
.qc-lookup-price {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: flex-start;
  gap: 6px;
  min-width: 140px;
  max-width: 280px;
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
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
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
  max-width: 260px;
}
.qc-lookup-price-status.is-error { color: #b91c1c; }
.qc-lookup-price-status.is-warn { color: #92400e; }
.qc-lookup-price-status.is-loading { color: #6b7280; }
.qc-lookup-price-status[hidden],
.qc-lookup-price-panel[hidden] { display: none !important; }
.qc-lookup-price-panel {
  margin: 0;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #fff;
  padding: 8px;
  max-width: min(520px, 42vw);
  width: max-content;
  position: absolute;
  left: calc(100% + 12px);
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
    root.className = "form-column qc-lookup-price-column";
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
 * Prefer the empty space to the right of Total in the qty/price row.
 * @param {Element} form
 * @returns {Element|null} insertion anchor (insert after this node)
 */
function findLookupPriceMountAnchor(form) {
    const totalCol = form.querySelector(".form-column.total-column");
    if (totalCol) return totalCol;

    const priceInput = getUnitPriceInput(form);
    if (!priceInput) return null;
    const row = priceInput.closest(".form-row");
    if (row) return row.lastElementChild;
    return (
        form.querySelector(".unit-price") ||
        priceInput.closest(".unit-price, .form-group, .field") ||
        priceInput.parentElement
    );
}

function mountLookupPriceOnForm(form) {
    if (!form) return;
    if (!getUnitPriceInput(form)) return;

    const anchor = findLookupPriceMountAnchor(form);
    if (!anchor || !anchor.parentNode) return;

    const existing = form.querySelector("[" + LOOKUP_PRICE_ROOT_ATTR + "]");
    if (existing) {
        /* Move a previously misplaced mount into the Total column gap. */
        if (existing.previousElementSibling !== anchor) {
            anchor.insertAdjacentElement("afterend", existing);
        }
        return;
    }

    ensureLookupPriceStyles();
    const ui = createLookupPriceUi(form);
    anchor.insertAdjacentElement("afterend", ui.root);
}

function scanAndMountLookupPrice() {
    if (!isLookupPriceEnabled() || !isAddRequestPage()) return;
    const forms = document.querySelectorAll(".request-form");
    forms.forEach(function (form) {
        if (getUnitPriceInput(form)) {
            mountLookupPriceOnForm(form);
        }
    });
}

function initLookupPriceOnAddRequest() {
    if (!isLookupPriceEnabled()) return;

    let lastPath = location.pathname;
    const tick = function () {
        const onPage = isAddRequestPage();
        if (location.pathname !== lastPath) {
            lastPath = location.pathname;
        }
        if (onPage) {
            ensureLookupPriceStyles();
            scanAndMountLookupPrice();
        }
    };

    tick();
    const obs = new MutationObserver(function () {
        tick();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setInterval(tick, 1500);
}
