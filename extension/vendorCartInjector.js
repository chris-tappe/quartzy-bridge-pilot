/**
 * Injected on vendor Quick Order / Bulk Upload pages.
 *
 * Strategies:
 * - file (default for VWR / Sigma): assign a generated CSV/XLSX to <input type="file">
 * - form (default for Fisher): fill Rapid Order line rows
 *     #qa_catNumber_{0..} / #qa_item_qty_input_{0..} (Gemini's #catalogNumberN is wrong)
 *
 * Message: { type: "QUARTZY_CART_STUFF", payload: CartStuffPayload }
 */
(function () {
  "use strict";

  /* Allow re-inject after extension reload so selector fixes take effect on new tabs. */
  if (window.__quartzyVendorCartInjectorBound) return;
  window.__quartzyVendorCartInjectorBound = true;

  /**
   * Per-vendor DOM hooks. Override via payload.selectors when a site changes.
   * Prefer the most specific selector first; fallbacks are tried in order.
   */
  const DEFAULT_VENDOR_SELECTORS = {
    fisher: {
      fileInput: [
        'input[type="file"][accept*=".xls"]',
        'input[type="file"][accept*="excel"]',
        'input[type="file"][name*="upload" i]',
        'input[type="file"]'
      ],
      dropzone: [
        '[class*="upload" i][class*="drop" i]',
        '[class*="bulk-upload" i]',
        ".bulk-upload",
        '[data-testid*="upload" i]'
      ],
      submitButton: [
        'button[type="submit"]',
        'input[type="submit"][value*="Import" i]',
        'button:has-text("Import Items")',
        'a:has-text("Import Items")',
        'button:has-text("Upload")',
        'button[class*="import" i]',
        'button[id*="import" i]',
        'button[class*="upload" i]',
        'input[type="button"][value*="Import" i]',
        'input[type="button"][value*="Upload" i]'
      ],
      addToCartButton: [
        "#rapid_order_add_cart",
        "a#rapid_order_add_cart",
        "#addAllToCart",
        "button.add-to-cart-btn",
        'a:has-text("Add all to Cart")',
        'button:has-text("Add all to Cart")',
        'button[class*="add" i][class*="cart" i]',
        'button[id*="addToCart" i]',
        'button[id*="addAllToCart" i]'
      ],
      addRowsButton: [
        "a#ro_addrows",
        "#ro_addrows",
        "a.js-ut-add-more-rows",
        'a:has-text("Add 3 More Rows")',
        'button:has-text("Add 3 More Rows")',
        'a[id*="addRows" i]',
        'a[onclick*="addRows"]'
      ],
      lineEntryTab: [
        'a:has-text("Line by Line")',
        'button:has-text("Line by Line")',
        '[role="tab"]:has-text("Line by Line")',
        'a:has-text("Enter Catalog")',
        'button:has-text("Enter Catalog")'
      ],
      /* 0-based: qa_catNumber_0, qa_item_qty_input_0 */
      catalogIdPrefix: "qa_catNumber_",
      quantityIdPrefix: "qa_item_qty_input_",
      catalogName: "shoppingCartCatNum",
      quantityName: "shoppingCartQty"
    },
    vwr: {
      fileInput: [
        'input[type="file"][accept*=".csv"]',
        'input[type="file"][accept*="text"]',
        'input[type="file"][name*="upload" i]',
        'input[type="file"]'
      ],
      dropzone: [
        '[class*="upload" i]',
        '[data-testid*="upload" i]',
        ".file-upload"
      ],
      submitButton: [
        'button[type="submit"]',
        'button[class*="upload" i]',
        'button[id*="upload" i]',
        'input[type="submit"]',
        'button[class*="import" i]'
      ],
      addToCartButton: [
        'button[class*="basket" i]',
        'button[class*="add" i]',
        'button[id*="addToBasket" i]',
        'input[type="submit"][value*="Basket" i]',
        'button[class*="cart" i]'
      ]
    },
    sigma: {
      fileInput: [
        'input[type="file"][accept*=".csv"]',
        'input[type="file"][accept*="text"]',
        'input[type="file"]'
      ],
      dropzone: [
        '[class*="bulk" i][class*="upload" i]',
        '[class*="file-upload" i]',
        '[data-testid*="upload" i]'
      ],
      submitButton: [
        'button[type="submit"]',
        'button[class*="upload" i]',
        'button[id*="upload" i]',
        'button[class*="import" i]'
      ],
      addToCartButton: [
        'button[class*="add-to-cart" i]',
        'button[id*="addToCart" i]',
        'button[data-testid*="add-to-cart" i]',
        'button[class*="addToCart" i]'
      ]
    }
  };

  /**
   * :has-text() is not a real CSS selector — strip those entries and match by text.
   * @param {string} selector
   * @returns {{ css: string|null, text: string|null }}
   */
  function parseSelector(selector) {
    const s = String(selector || "").trim();
    const m = s.match(/^(.*?):has-text\(["'](.+?)["']\)$/i);
    if (m) {
      return { css: m[1].trim() || null, text: m[2] };
    }
    return { css: s || null, text: null };
  }

  /**
   * @param {string|string[]} selectors
   * @param {ParentNode} [root]
   * @returns {Element|null}
   */
  function queryFirst(selectors, root) {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    const scope = root || document;
    for (let i = 0; i < list.length; i++) {
      const parsed = parseSelector(list[i]);
      if (parsed.text) {
        const nodes = parsed.css
          ? scope.querySelectorAll(parsed.css)
          : scope.querySelectorAll("button, a, input[type='button'], input[type='submit'], [role='button']");
        for (let j = 0; j < nodes.length; j++) {
          const el = nodes[j];
          const label = String(
            el.getAttribute("value") || el.getAttribute("aria-label") || el.textContent || ""
          )
            .replace(/\s+/g, " ")
            .trim();
          if (label.toLowerCase().indexOf(parsed.text.toLowerCase()) !== -1) {
            return el;
          }
        }
        continue;
      }
      if (!parsed.css) continue;
      try {
        const el = scope.querySelector(parsed.css);
        if (el) return el;
      } catch (e) {
        /* invalid selector — skip */
      }
    }
    return null;
  }

  /**
   * @param {string} base64
   * @returns {Uint8Array}
   */
  function base64ToBytes(base64) {
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  /**
   * @param {{ body: string, encoding?: string, filename: string, mimeType: string }} filePayload
   * @returns {File}
   */
  function buildFile(filePayload) {
    const encoding = String(filePayload.encoding || "utf8").toLowerCase();
    const mime = filePayload.mimeType || "text/csv";
    const name = filePayload.filename || "quartzy_cart.csv";
    let parts;
    if (encoding === "base64") {
      parts = [base64ToBytes(filePayload.body)];
    } else {
      parts = [filePayload.body];
    }
    return new File(parts, name, { type: mime, lastModified: Date.now() });
  }

  /**
   * @param {HTMLInputElement} input
   * @param {File} file
   */
  function assignFileToInput(input, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;

    /* React / Angular / native listeners often key off these. */
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    try {
      const proto = window.HTMLInputElement && window.HTMLInputElement.prototype;
      const desc = proto && Object.getOwnPropertyDescriptor(proto, "files");
      if (desc && typeof desc.set === "function") {
        desc.set.call(input, dt.files);
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    } catch (e) {
      /* ignore — DataTransfer assignment above is enough on Chromium */
    }
  }

  /**
   * @param {Element} dropzone
   * @param {File} file
   */
  function dispatchDrop(dropzone, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    const opts = { bubbles: true, cancelable: true, dataTransfer: dt };
    ["dragenter", "dragover", "drop"].forEach(function (type) {
      try {
        dropzone.dispatchEvent(new DragEvent(type, opts));
      } catch (e) {
        const ev = new Event(type, { bubbles: true, cancelable: true });
        try {
          Object.defineProperty(ev, "dataTransfer", { value: dt });
        } catch (e2) {
          /* ignore */
        }
        dropzone.dispatchEvent(ev);
      }
    });
  }

  /**
   * @param {Element|null} el
   * @returns {boolean}
   */
  function clickEl(el) {
    if (!el || typeof el.click !== "function") return false;
    try {
      el.click();
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * @param {number} ms
   * @returns {Promise<void>}
   */
  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  /**
   * Wait briefly for SPA / lazy-rendered upload widgets.
   * @param {string|string[]} selectors
   * @param {number} timeoutMs
   * @returns {Promise<Element|null>}
   */
  async function waitFor(selectors, timeoutMs) {
    const start = Date.now();
    const limit = timeoutMs != null ? timeoutMs : 8000;
    let el = queryFirst(selectors);
    while (!el && Date.now() - start < limit) {
      await sleep(250);
      el = queryFirst(selectors);
    }
    return el;
  }

  /**
   * Set an input value the way Fisher (jQuery change handlers) / React expect.
   * @param {HTMLInputElement|HTMLTextAreaElement} input
   * @param {string} value
   * @param {{ triggerChange?: boolean }} [opts]
   */
  function setNativeInputValue(input, value, opts) {
    const str = String(value == null ? "" : value);
    const triggerChange = !opts || opts.triggerChange !== false;

    /* Prefer jQuery — Fisher Rapid Order binds on $(".js-json-typeahead").on("change", …). */
    if (typeof window.jQuery === "function") {
      try {
        const $el = window.jQuery(input);
        $el.val(str);
        if (triggerChange) {
          $el.trigger("input");
          $el.trigger("change");
        }
        return;
      } catch (eJq) {
        /* fall through to native */
      }
    }

    try {
      const proto =
        input instanceof HTMLTextAreaElement
          ? window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement && window.HTMLInputElement.prototype;
      const desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && typeof desc.set === "function") {
        desc.set.call(input, str);
      } else {
        input.value = str;
      }
    } catch (e) {
      input.value = str;
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    if (triggerChange) {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      try {
        input.dispatchEvent(new Event("blur", { bubbles: true }));
      } catch (e2) {
        /* ignore */
      }
    }
  }

  /**
   * @param {HTMLElement|null} el
   * @returns {HTMLInputElement|null}
   */
  function asTextInput(el) {
    if (!el || el.tagName !== "INPUT") return null;
    return /** @type {HTMLInputElement} */ (el);
  }

  /**
   * Fisher Rapid Order uses 0-based ids: qa_catNumber_0 / qa_item_qty_input_0.
   * Keep Gemini-style #catalogNumberN as a fallback.
   * @param {object} selectors
   * @param {number} rowNum 1-based
   * @returns {{ cat: HTMLInputElement|null, qty: HTMLInputElement|null }}
   */
  function getRowInputs(selectors, rowNum) {
    const idx = rowNum - 1;
    const catPrefix = String((selectors && selectors.catalogIdPrefix) || "qa_catNumber_");
    const qtyPrefix = String((selectors && selectors.quantityIdPrefix) || "qa_item_qty_input_");

    let cat =
      asTextInput(document.getElementById(catPrefix + idx)) ||
      asTextInput(document.getElementById("catalogNumber" + rowNum));
    let qty =
      asTextInput(document.getElementById(qtyPrefix + idx)) ||
      asTextInput(document.getElementById("quantity" + rowNum));

    /* Name-based fallback: all catalog inputs share name=shoppingCartCatNum */
    if (!cat || !qty) {
      const catName = (selectors && selectors.catalogName) || "shoppingCartCatNum";
      const qtyName = (selectors && selectors.quantityName) || "shoppingCartQty";
      const cats = document.querySelectorAll('input[name="' + catName + '"]');
      const qtys = document.querySelectorAll('input[name="' + qtyName + '"]');
      if (!cat && cats[idx]) cat = asTextInput(cats[idx]);
      if (!qty && qtys[idx]) qty = asTextInput(qtys[idx]);
    }

    return { cat: cat, qty: qty };
  }

  /**
   * @param {object} selectors
   * @param {number} rowNum
   * @param {number} timeoutMs
   * @returns {Promise<{ cat: HTMLInputElement|null, qty: HTMLInputElement|null }>}
   */
  async function ensureRow(selectors, rowNum, timeoutMs) {
    let row = getRowInputs(selectors, rowNum);
    if (row.cat && row.qty) return row;

    const deadline = Date.now() + (timeoutMs != null ? timeoutMs : 6000);
    let expandAttempts = 0;
    while (Date.now() < deadline) {
      row = getRowInputs(selectors, rowNum);
      if (row.cat && row.qty) return row;

      const addRowsBtn = queryFirst(selectors.addRowsButton);
      if (addRowsBtn && expandAttempts < 40) {
        clickEl(addRowsBtn);
        expandAttempts += 1;
        await sleep(400);
        continue;
      }
      await sleep(200);
    }
    return getRowInputs(selectors, rowNum);
  }

  /**
   * Snapshot of candidate form fields for debug when selectors miss.
   * @returns {object}
   */
  function diagnoseFormFields() {
    const cats = Array.prototype.slice
      .call(document.querySelectorAll('input[name="shoppingCartCatNum"], input[id^="qa_catNumber_"], input.roTextField--typeahead'))
      .slice(0, 8)
      .map(function (el) {
        return { id: el.id || "", name: el.getAttribute("name") || "", className: String(el.className || "").slice(0, 80) };
      });
    const qtys = Array.prototype.slice
      .call(document.querySelectorAll('input[name="shoppingCartQty"], input[id^="qa_item_qty_input_"], input.roTextField--qty'))
      .slice(0, 8)
      .map(function (el) {
        return { id: el.id || "", name: el.getAttribute("name") || "" };
      });
    return {
      url: location.href,
      hasQaCat0: !!document.getElementById("qa_catNumber_0"),
      hasCatalogNumber1: !!document.getElementById("catalogNumber1"),
      hasRoAddRows: !!document.getElementById("ro_addrows"),
      hasAddCart: !!document.getElementById("rapid_order_add_cart"),
      cats: cats,
      qtys: qtys
    };
  }

  /**
   * Normalize payload.items into { catalog, qty } rows.
   * @param {object} payload
   * @returns {Array<{ catalog: string, qty: string }>}
   */
  function normalizeFormItems(payload) {
    const raw = (payload && payload.items) || [];
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const it = raw[i] || {};
      const catalog = String(it.catalog || it.catalogNumber || it.sku || "").trim();
      if (!catalog) continue;
      const q = it.qty != null ? it.qty : it.quantity;
      const n = Number(q);
      const qty =
        Number.isFinite(n) && n > 0 ? String(Math.floor(n)) : String(q == null ? "1" : q).trim() || "1";
      out.push({ catalog: catalog, qty: qty });
    }
    return out;
  }

  /**
   * Wait until Add all to Cart is enabled (Fisher disables it until rows resolve).
   * @param {Element|null} atc
   * @param {number} timeoutMs
   * @returns {Promise<boolean>}
   */
  async function waitForAddToCartEnabled(atc, timeoutMs) {
    if (!atc) return false;
    const deadline = Date.now() + (timeoutMs != null ? timeoutMs : 8000);
    while (Date.now() < deadline) {
      const disabled =
        atc.classList.contains("disabled") ||
        atc.getAttribute("aria-disabled") === "true" ||
        /** @type {any} */ (atc).disabled === true;
      if (!disabled) return true;
      await sleep(250);
    }
    return !(
      atc.classList.contains("disabled") ||
      atc.getAttribute("aria-disabled") === "true" ||
      /** @type {any} */ (atc).disabled === true
    );
  }

  /**
   * Fisher Rapid Order line-by-line form fill.
   * @param {object} payload
   * @returns {Promise<object>}
   */
  async function stuffCartViaForm(payload) {
    const vendorId = String((payload && payload.vendorId) || "").toLowerCase();
    const defaults = DEFAULT_VENDOR_SELECTORS[vendorId] || DEFAULT_VENDOR_SELECTORS.fisher;
    const selectors = Object.assign({}, defaults, (payload && payload.selectors) || {});
    const clickAddToCart = payload && payload.clickAddToCart !== false;
    const items = normalizeFormItems(payload);

    if (!items.length) {
      return {
        ok: false,
        error: "missing_items",
        errorMessage: "No catalog items in form-fill cart-stuff payload.",
        vendorId: vendorId,
        url: location.href
      };
    }

    /* If the page is on Copy/Paste or bulk UI, try switching to Line by Line first. */
    let first = getRowInputs(selectors, 1);
    if (!first.cat) {
      const tab = queryFirst(selectors.lineEntryTab);
      if (tab) {
        clickEl(tab);
        await sleep(400);
      }
      first = getRowInputs(selectors, 1);
      if (!first.cat) {
        await waitFor(
          [
            "#qa_catNumber_0",
            'input[name="shoppingCartCatNum"]',
            "input.roTextField--typeahead",
            "#catalogNumber1",
            'input[id^="catalogNumber"]'
          ],
          payload.waitMs || 12000
        );
        first = getRowInputs(selectors, 1);
      }
    }

    if (!first.cat) {
      return {
        ok: false,
        error: "form_row_not_found",
        errorMessage:
          "Could not find Fisher Quick Order catalog fields (#qa_catNumber_0). Pass payload.selectors to override.",
        vendorId: vendorId,
        url: location.href,
        diagnose: diagnoseFormFields()
      };
    }

    /**
     * Write qty via jQuery change/blur — Fisher listens on .js-json-qty.
     * @param {HTMLInputElement} qtyInput
     * @param {string} qty
     */
    function writeQty(qtyInput, qty) {
      if (!qtyInput) return;
      setNativeInputValue(qtyInput, qty);
      if (typeof window.jQuery === "function") {
        try {
          window.jQuery(qtyInput).trigger("blur");
        } catch (eBlur) {
          /* ignore */
        }
      } else {
        qtyInput.dispatchEvent(new Event("blur", { bubbles: true }));
      }
    }

    /**
     * Wait until THIS row's product lookup finishes.
     * Do not use .js-json-item-desc — empty Rapid Order rows already contain that node.
     * @param {HTMLInputElement} catInput
     * @param {number} timeoutMs
     * @returns {Promise<boolean>}
     */
    async function waitForCatalogResolved(catInput, timeoutMs) {
      const tbody = catInput && catInput.closest("tbody");
      const deadline = Date.now() + (timeoutMs != null ? timeoutMs : 6000);
      while (Date.now() < deadline) {
        const hasValid = !!(tbody && tbody.getAttribute("data-hasvalidproduct") === "true");
        const hasError = catInput.getAttribute("data-haserrors") === "true";
        if (hasValid || hasError) return hasValid;
        await sleep(150);
      }
      return !!(tbody && tbody.getAttribute("data-hasvalidproduct") === "true");
    }

    /**
     * Apply quantities for every filled row. Returns how many still mismatch.
     * @param {Array<{ row: number, qty: string }>} rows
     * @returns {number}
     */
    function applyAllQuantities(rows) {
      let mismatches = 0;
      for (let i = 0; i < rows.length; i++) {
        const row = getRowInputs(selectors, rows[i].row);
        if (!row.qty) {
          mismatches += 1;
          continue;
        }
        writeQty(row.qty, rows[i].qty);
        rows[i].qtyWritten = String(row.qty.value || "");
        if (String(row.qty.value || "").trim() !== String(rows[i].qty)) {
          mismatches += 1;
        }
      }
      return mismatches;
    }

    const filled = [];
    const failed = [];
    const rowSettleMs = payload.rowFillDelayMs != null ? payload.rowFillDelayMs : 350;

    /*
     * Phase 1 — catalogs only.
     * Fisher's product AJAX for row N re-renders earlier rows and wipes their qty
     * if we write quantities interleaved with catalog lookups.
     */
    for (let i = 0; i < items.length; i++) {
      const rowNum = i + 1;
      const row = await ensureRow(selectors, rowNum, payload.rowWaitMs || 8000);
      if (!row.cat || !row.qty) {
        failed.push({ index: i, catalog: items[i].catalog, reason: "row_missing" });
        continue;
      }
      setNativeInputValue(row.cat, items[i].catalog);
      const resolved = await waitForCatalogResolved(row.cat, payload.catalogResolveMs || 6000);
      filled.push({
        index: i,
        row: rowNum,
        catalog: items[i].catalog,
        qty: items[i].qty,
        resolved: resolved,
        qtyWritten: "",
        catId: row.cat.id || "",
        qtyId: row.qty.id || ""
      });
      await sleep(rowSettleMs);
    }

    /* Phase 2 — wait for Fisher’s last product AJAX / default-qty write to finish. */
    await sleep(payload.qtyRewriteDelayMs != null ? payload.qtyRewriteDelayMs : 900);

    /* Phase 3 — write all quantities, then poll/rewrite until they stick. */
    applyAllQuantities(filled);
    const qtyPollMs = payload.qtyPollMs != null ? payload.qtyPollMs : 2500;
    const qtyPollDeadline = Date.now() + qtyPollMs;
    while (Date.now() < qtyPollDeadline) {
      await sleep(350);
      let needRewrite = false;
      for (let i = 0; i < filled.length; i++) {
        const row = getRowInputs(selectors, filled[i].row);
        const current = row.qty ? String(row.qty.value || "").trim() : "";
        const want = String(filled[i].qty);
        /* Fisher often leaves 0/empty after a re-render — treat that as wiped. */
        if (!row.qty || current !== want || current === "" || current === "0") {
          needRewrite = true;
          break;
        }
      }
      if (!needRewrite) break;
      applyAllQuantities(filled);
    }

    const result = {
      ok: filled.length > 0,
      strategy: "form",
      vendorId: vendorId,
      itemCount: items.length,
      filledCount: filled.length,
      failedCount: failed.length,
      filled: filled,
      failed: failed.length ? failed : undefined,
      addedToCart: false,
      url: location.href
    };

    if (!filled.length) {
      result.error = "form_fill_failed";
      result.errorMessage = "Could not populate any Quick Order rows.";
      result.diagnose = diagnoseFormFields();
      return result;
    }

    if (clickAddToCart) {
      /* One last qty pass right before ATC — late Fisher AJAX can still wipe fields. */
      applyAllQuantities(filled);
      await sleep(payload.addToCartDelayMs != null ? payload.addToCartDelayMs : 400);
      const atc = queryFirst(selectors.addToCartButton);
      result.addToCartSelector = atc ? describeEl(atc) : null;
      const enabled = await waitForAddToCartEnabled(atc, payload.atcEnableWaitMs || 10000);
      if (enabled) {
        applyAllQuantities(filled);
        result.addedToCart = clickEl(atc);
      } else {
        result.warning =
          "Rows filled, but Add all to Cart stayed disabled (product lookup may still be running, or sign-in / match selection required).";
      }
    }

    return result;
  }

  /**
   * @param {object} payload
   * @returns {Promise<object>}
   */
  async function stuffCartViaFile(payload) {
    const vendorId = String((payload && payload.vendorId) || "").toLowerCase();
    const defaults = DEFAULT_VENDOR_SELECTORS[vendorId] || DEFAULT_VENDOR_SELECTORS.vwr;
    const selectors = Object.assign({}, defaults, (payload && payload.selectors) || {});
    const autoSubmit = payload && payload.autoSubmit !== false;
    const clickAddToCart = !!(payload && payload.clickAddToCart);

    if (!payload || payload.body == null) {
      return { ok: false, error: "missing_file", errorMessage: "No file body in cart-stuff payload." };
    }

    const file = buildFile(payload);
    let fileInput = await waitFor(selectors.fileInput, payload.waitMs || 10000);

    if (!fileInput) {
      const dropzone = queryFirst(selectors.dropzone);
      if (dropzone) {
        dispatchDrop(dropzone, file);
        await sleep(400);
        fileInput = queryFirst(selectors.fileInput);
      }
    }

    if (!fileInput || fileInput.tagName !== "INPUT" || String(fileInput.type).toLowerCase() !== "file") {
      return {
        ok: false,
        error: "file_input_not_found",
        errorMessage:
          "Could not find a file input on this Quick Order page. Pass payload.selectors.fileInput to override.",
        vendorId: vendorId,
        url: location.href
      };
    }

    /* Some inputs are display:none inside a label — still assignable. */
    assignFileToInput(/** @type {HTMLInputElement} */ (fileInput), file);

    const result = {
      ok: true,
      strategy: "file",
      vendorId: vendorId,
      filename: file.name,
      mimeType: file.type,
      itemCount: payload.itemCount || null,
      fileInputSelector: describeEl(fileInput),
      submitted: false,
      addedToCart: false,
      url: location.href
    };

    if (autoSubmit) {
      await sleep(payload.submitDelayMs != null ? payload.submitDelayMs : 350);
      const submitBtn = queryFirst(selectors.submitButton);
      result.submitted = clickEl(submitBtn);
      result.submitSelector = submitBtn ? describeEl(submitBtn) : null;
    }

    if (clickAddToCart) {
      await sleep(payload.addToCartDelayMs != null ? payload.addToCartDelayMs : 1200);
      const atc = queryFirst(selectors.addToCartButton);
      result.addedToCart = clickEl(atc);
      result.addToCartSelector = atc ? describeEl(atc) : null;
    }

    return result;
  }

  /**
   * @param {object} payload
   * @returns {Promise<object>}
   */
  async function stuffCart(payload) {
    const strategy = String((payload && payload.strategy) || "file").toLowerCase();
    if (strategy === "form" || strategy === "line" || strategy === "line_fill") {
      return stuffCartViaForm(payload || {});
    }
    return stuffCartViaFile(payload || {});
  }

  /**
   * @param {Element} el
   * @returns {string}
   */
  function describeEl(el) {
    if (!el) return "";
    const id = el.id ? "#" + el.id : "";
    const name = el.getAttribute("name") ? '[name="' + el.getAttribute("name") + '"]' : "";
    const cls =
      el.className && typeof el.className === "string"
        ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
        : "";
    return (el.tagName || "").toLowerCase() + id + name + cls;
  }

  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (!message || message.type !== "QUARTZY_CART_STUFF") return;
    stuffCart(message.payload || {})
      .then(function (result) {
        sendResponse(result);
      })
      .catch(function (e) {
        sendResponse({
          ok: false,
          error: "inject_failed",
          errorMessage: (e && e.message) || "Cart stuffing injection failed."
        });
      });
    return true;
  });
})();
