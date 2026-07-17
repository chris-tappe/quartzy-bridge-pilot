/**
 * Injected on vendor Quick Order / Bulk Upload pages.
 * Receives a generated file payload and programmatically sets it on the
 * native <input type="file"> (DataTransfer), then optionally clicks Upload / Add.
 *
 * Message: { type: "QUARTZY_CART_STUFF", payload: CartStuffPayload }
 */
(function () {
  "use strict";

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
        'button:has-text("Add all to Cart")',
        'a:has-text("Add all to Cart")',
        'button[class*="add" i][class*="cart" i]',
        'input[type="button"][value*="Add" i][value*="Cart" i]',
        'button[id*="addToCart" i]'
      ]
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
   * @param {object} payload
   * @returns {Promise<object>}
   */
  async function stuffCart(payload) {
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
