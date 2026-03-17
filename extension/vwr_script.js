console.log("%c[VWR Bridge] Automation Script Loaded!", "color: #1e7e34; font-weight: bold; font-size: 14px;");

let isProcessing = false;

async function initVWR() {
    if (isProcessing) return;

    console.log("[VWR Bridge] Checking for pending order queue in storage...");

    const result = await chrome.storage.local.get(['vwr_order_queue']);
    const queue = result.vwr_order_queue;

    if (queue && queue.length > 0) {
        isProcessing = true;
        console.log(`[VWR Bridge] Found ${queue.length} items to transfer:`, queue);

        // Wait a bit more for the page to be fully interactive
        await new Promise(r => setTimeout(r, 2000));

        await processQueue(queue);

        // Clear queue after processing
        await chrome.storage.local.remove('vwr_order_queue');
        console.log("[VWR Bridge] Transfer complete and queue cleared.");
        isProcessing = false;
    } else {
        console.log("[VWR Bridge] No items in 'vwr_order_queue'. Check storage if you expected items.");
    }
}

async function processQueue(items) {
    for (const item of items) {
        if (!item.catalogNumber || item.catalogNumber === "Unknown") {
            console.warn("[VWR Bridge] Skipping item with unknown catalog number.");
            continue;
        }

        console.log(`[VWR Bridge] >>> Processing item: ${item.catalogNumber} (Qty: ${item.quantity})`);
        const success = await addProductToList(item.catalogNumber, item.quantity);

        if (!success) {
            console.error(`[VWR Bridge] Failed to add item: ${item.catalogNumber}. Stopping queue to prevent partial orders.`);
            break;
        }

        // Delay between items to allow for list updates
        await new Promise(r => setTimeout(r, 2000));
    }
}

async function addProductToList(catNum, qty) {
    // Try multiple selectors as fallbacks
    const inputSelectors = [
        "input[formcontrolname='product']",
        ".quick-order-form-input input",
        "input[placeholder='Enter a catalog number']",
        "input[aria-label='Search'][placeholder*='catalog']"
    ];

    let input = null;
    for (const sel of inputSelectors) {
        input = document.querySelector(sel);
        if (input) break;
    }

    if (!input) {
        console.error("[VWR Bridge] Catalog input not found. Trying to wait...");
        input = await waitForElement(inputSelectors[0], 20);
    }

    if (!input) {
        console.error("[VWR Bridge] Catalog input still not found. Giving up.");
        return false;
    }

    console.log("[VWR Bridge] Input field ready. Current value: '" + input.value + "'. Setting to: " + catNum);

    // 1. Enter catalog number
    input.focus();
    input.click();

    // Clear first
    setInputValue(input, "");

    // Try to "type" it
    setInputValue(input, catNum);

    // Trigger events
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));

    // 2. Wait for dropdown result
    console.log("[VWR Bridge] Waiting for dropdown results for " + catNum + "...");
    const dropdownSelector = "button.quick-order-results-product, .quick-order-results-product, .quick-order-results-container button";

    let dropdownItem = null;
    let attempts = 0;
    while (!dropdownItem && attempts < 20) {
        await new Promise(r => setTimeout(r, 500));
        dropdownItem = document.querySelector(dropdownSelector);
        attempts++;

        if (!dropdownItem && attempts % 4 === 0) {
            console.log("[VWR Bridge] Retrying input event...");
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    if (dropdownItem) {
        console.log("[VWR Bridge] Found dropdown result. Clicking selection...");
        dropdownItem.focus();
        dropdownItem.click();

        // 3. Wait for the item to be added to the dynamic list below
        console.log("[VWR Bridge] Item selected. Waiting for it to appear in order list...");
        await new Promise(r => setTimeout(r, 2000));

        const qtyInputs = document.querySelectorAll("input[aria-label='Quantity']");
        if (qtyInputs.length > 0) {
            const latestQtyInput = qtyInputs[qtyInputs.length - 1];
            console.log(`[VWR Bridge] Setting quantity to ${qty}.`);
            latestQtyInput.focus();
            setInputValue(latestQtyInput, qty.toString());
            latestQtyInput.dispatchEvent(new Event('input', { bubbles: true }));
            latestQtyInput.dispatchEvent(new Event('change', { bubbles: true }));
            await new Promise(r => setTimeout(r, 500));
            latestQtyInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        }

        // 4. Reset search box for next item
        const resetBtn = document.querySelector("button[aria-label='Reset'], .reset-button, button.close");
        if (resetBtn) {
            resetBtn.click();
        } else {
            setInputValue(input, "");
        }

        return true;
    } else {
        console.warn("[VWR Bridge] Dropdown result never appeared for " + catNum + ". Check if catalog number is correct.");
        return false;
    }
}

async function waitForElement(selector, maxAttempts = 10) {
    for (let i = 0; i < maxAttempts; i++) {
        const el = document.querySelector(selector);
        if (el) return el;
        await new Promise(r => setTimeout(r, 500));
    }
    return null;
}

function setInputValue(element, value) {
    if (!element) return;
    try {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        if (nativeInputValueSetter) {
            nativeInputValueSetter.call(element, value);
        } else {
            element.value = value;
        }
    } catch (e) {
        element.value = value;
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
}

// Start initialization
console.log("[VWR Bridge] Initializing VWR helper...");
if (document.readyState === 'complete') {
    initVWR();
} else {
    window.addEventListener('load', initVWR);
}

// Watch for DOM changes just in case it's a super late load
const observer = new MutationObserver((mutations) => {
    if (!isProcessing) {
        initVWR();
    }
});
observer.observe(document.documentElement, { childList: true, subtree: true });
