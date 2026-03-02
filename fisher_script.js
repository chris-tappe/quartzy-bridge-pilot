console.log("[Quartzy Bridge] Fisher Target Script Loaded");

function init() {
    chrome.storage.local.get(['fisher_order_queue'], (result) => {
        const queue = result.fisher_order_queue;
        if (queue && queue.length > 0) {
            console.log("[Quartzy Bridge] Found queue in storage:", queue);
            fillRapidOrderForm(queue);
        } else {
            console.log("[Quartzy Bridge] No queue found.");
        }
    });
}

function fillRapidOrderForm(queue) {
    // Fisher Rapid Order inputs usually follow a grid pattern.
    // e.g. input[name="catalogNumber"] or similar.
    // We need to inspect the inputs.

    // Strategy:
    // 1. Find all catalog number inputs.
    // 2. Find all quantity inputs.
    // 3. Fill them sequentially.
    // 4. If we run out of inputs, click "Add Rows".

    const inputRows = document.querySelectorAll('.qc-row, tr.item-row'); // Hypothetical classes
    // A better generic approach for Fisher might be selecting by input name arrays if they use arrays.

    // Actually, usually it's inputs with names like 'orderItems[0].catalogNumber' or distinct IDs.
    // Let's try to find inputs that appear to be catalog numbers.

    // Heuristic: Search for inputs with 'catalog' or 'partNumber' in name/id
    // or checks placeholder text.

    updateInputs(queue);
}

function updateInputs(queue, startIndex = 0) {
    if (startIndex > 0) {
        console.log(`[Quartzy Bridge] Resuming from index ${startIndex}`);
    }

    const catalogSelectors = [
        'input[name="shoppingCartCatNum"]',
        'input[class*="qa_catNumber"]',
        'input[name*="shoppingCartCatNum"]',
        'input[id^="catalogNumber"]',
        '.qa_catNumber input'
    ];

    // Selectors for Quantity inputs
    const qtySelectors = [
        'input[name="shoppingCartQty"]',
        'input[class*="qa_item_qty_input"]',
        'input[name*="shoppingCartQty"]',
        'input[id^="quantity"]',
        '.qa_item_qty_input input'
    ];

    const catalogInputs = Array.from(document.querySelectorAll(catalogSelectors.join(',')));
    const qtyInputs = Array.from(document.querySelectorAll(qtySelectors.join(',')));

    console.log(`[Quartzy Bridge] Found ${catalogInputs.length} catalog inputs.`);

    if (catalogInputs.length === 0) {
        console.warn("[Quartzy Bridge] Could not find any inputs!");
        return;
    }

    // NEW: Check if form is already dirty (has values)
    // If we are starting from 0 (fresh load) and found values, we should probably clear them first.
    if (startIndex === 0) {
        console.log("[Quartzy Bridge] Checking for existing data to clear...");
        let dirty = false;
        catalogInputs.forEach((input, idx) => {
            if (input.value && input.value.trim() !== "") {
                console.log(`[Quartzy Bridge] Found existing value in Row ${idx}: ${input.value}. Clearing...`);
                setNativeValue(input, "");
                dirty = true;
            }
        });

        qtyInputs.forEach((input, idx) => {
            if (input.value && input.value !== "1" && input.value !== "") {
                // Reset quantity to 1 or empty
                setNativeValue(input, "");
                dirty = true;
            }
        });

        if (dirty) {
            console.log("[Quartzy Bridge] Existing items cleared. waiting a moment before filling...");
            // Give React a moment to process the clears
            setTimeout(() => updateInputs(queue, 0), 500);
            return;
        }
    }

    for (let i = startIndex; i < queue.length; i++) {
        const item = queue[i];

        // Critical Logic:
        // We must check if we have enough inputs for the current index `i`.
        // BUT, `i` is an index into `queue`, and `catalogInputs` is 0-indexed DOM list.
        // They should align 1:1.

        if (i >= catalogInputs.length) {
            console.log(`[Quartzy Bridge] Row index ${i} exceeds input count (${catalogInputs.length}). Adding rows...`);
            addMoreRows(() => {
                console.log(`[Quartzy Bridge] Resuming filling from index ${i}...`);
                updateInputs(queue, i);
            });
            return; // Halt this execution context
        }

        const catInput = catalogInputs[i];
        const qInput = qtyInputs[i];

        if (catInput) {
            console.log(`[Quartzy Bridge] Filling Row ${i}: Cat# ${item.catalogNumber}`);
            setNativeValue(catInput, item.catalogNumber);
        }

        if (qInput) {
            console.log(`[Quartzy Bridge] Filling Row ${i}: Qty ${item.quantity}`);
            setNativeValue(qInput, item.quantity);
        }
    }

    console.log("[Quartzy Bridge] All items filled. Clearing storage.");
    chrome.storage.local.remove('fisher_order_queue');
}

function setNativeValue(element, value) {
    if (!element) return;

    // Safety check: verify descriptors exist before accessing .set
    const descriptor = Object.getOwnPropertyDescriptor(element, 'value');
    const valueSetter = descriptor ? descriptor.set : null;

    const prototype = Object.getPrototypeOf(element);
    const prototypeDescriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, 'value') : null;
    const prototypeValueSetter = prototypeDescriptor ? prototypeDescriptor.set : null;

    if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
        prototypeValueSetter.call(element, value);
    } else if (valueSetter) {
        valueSetter.call(element, value);
    } else {
        element.value = value;
    }

    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new Event('blur', { bubbles: true }));
}


function addMoreRows(callback) {
    // Find the "Add Rows" button
    // Selector likely contains "Add" or "More"
    // Use XPath for text search or specific class

    // Example: Button with text "Add 5 Lines"
    const buttons = Array.from(document.querySelectorAll('button, a'));
    const addBtn = buttons.find(b => b.innerText.includes('Add') && b.innerText.includes('Lines'));

    if (addBtn) {
        console.log("[Quartzy Bridge] Clicking 'Add Lines' button...");
        addBtn.click();

        // Wait for DOM update
        setTimeout(callback, 1000);
    } else {
        console.warn("[Quartzy Bridge] Could not find 'Add Lines' button.");
    }
}

// Run init
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
