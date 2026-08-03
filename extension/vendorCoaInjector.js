/**
 * Injected on vendor CoA / documents pages to locate a Certificate of Analysis
 * download URL for a given lot (+ optional catalog number).
 *
 * Message: { type: "QUARTZY_FETCH_COA", payload: { vendorId, lotNumber, catalogNumber, strategy } }
 * Response: { ok, downloadUrl, filename, error, errorMessage }
 */
(function () {
  "use strict";

  if (window.__quartzyVendorCoaInjectorBound) return;
  window.__quartzyVendorCoaInjectorBound = true;

  const DEFAULT_SELECTORS = {
    sigma: {
      form: ['form[data-testid="COA-form"]', 'form[action="#"]'],
      lotInput: [
        "#autocomplete-cofa_lot_number-input",
        'input[name="lotNumber"]',
        'input[id*="lot_number" i]',
        'input[placeholder*="023J5431"]'
      ],
      productInput: [
        "#cofa_product_number",
        'input[name="productNumber"]',
        'input[id*="product_number" i]',
        'input[placeholder*="T1503"]'
      ],
      submitButton: [
        "#COA-submit",
        'button[data-testid="COA-submit"]',
        'form[data-testid="COA-form"] button[type="submit"]'
      ],
      cookieAccept: [
        'button:has-text("Enable All Cookies")',
        "#onetrust-accept-btn-handler",
        'button:has-text("Accept All")'
      ],
      documentLotLink: ['a[class*="documentLink"]', 'a[rel="nofollow"]'],
      resultPdfLink: ['a[href*="/certificates/coa/"]', 'a[href*=".pdf" i]']
    }
  };

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
   * @param {string[]} selectors
   * @param {Element} [root]
   * @returns {Element|null}
   */
  function queryFirst(selectors, root) {
    const scope = root || document;
    const list = Array.isArray(selectors) ? selectors : [];
    for (let i = 0; i < list.length; i++) {
      const sel = list[i];
      if (!sel || typeof sel !== "string") continue;
      if (sel.indexOf(":has-text(") !== -1) {
        const m = sel.match(/^([a-zA-Z0-9#.\[\]="*_-\s]+):has-text\("([^"]+)"\)$/);
        if (m) {
          const tagSel = m[1].trim() || "*";
          const needle = m[2].toLowerCase();
          const nodes = Array.from(scope.querySelectorAll(tagSel));
          for (let j = 0; j < nodes.length; j++) {
            if (String(nodes[j].textContent || "").trim().toLowerCase().indexOf(needle) !== -1) {
              return nodes[j];
            }
          }
        }
        continue;
      }
      try {
        const el = scope.querySelector(sel);
        if (el) return el;
      } catch (e) {
        /* invalid selector */
      }
    }
    return null;
  }

  /**
   * @param {HTMLInputElement} input
   * @param {string} value
   */
  function setNativeInputValue(input, value) {
    if (!input) return;
    const proto =
      input.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement && window.HTMLInputElement.prototype;
    const desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && typeof desc.set === "function") {
      desc.set.call(input, value);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    try {
      input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "a" }));
    } catch (e) {
      /* ignore */
    }
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

  function dismissCookieBanners(selectors) {
    const btn = queryFirst(selectors && selectors.cookieAccept);
    if (btn) clickEl(btn);
    const ot = document.getElementById("onetrust-accept-btn-handler");
    if (ot) clickEl(ot);
    const enable = Array.from(document.querySelectorAll("button")).find(function (b) {
      return /Enable All Cookies|Accept All Cookies|Accept All/i.test(String(b.textContent || ""));
    });
    if (enable) clickEl(enable);
  }

  /**
   * Capture the next window.open / location navigation to a PDF-ish URL.
   * @param {number} timeoutMs
   * @returns {{ promise: Promise<string|null>, restore: () => void }}
   */
  function captureNavigationUrl(timeoutMs) {
    let settled = false;
    let resolveFn = null;
    const promise = new Promise(function (resolve) {
      resolveFn = resolve;
    });
    const finish = function (url) {
      if (settled) return;
      settled = true;
      restore();
      resolveFn(url || null);
    };
    const timer = setTimeout(function () {
      finish(null);
    }, timeoutMs || 15000);

    const origOpen = window.open;
    window.open = function (url) {
      const u = url != null ? String(url) : "";
      if (u && /coa|\.pdf|certificate/i.test(u)) {
        finish(u);
        /* Return a stub window so the vendor page does not treat this as a
           blocked popup (returning null often surfaces "popup blocked"). */
        return {
          closed: false,
          location: { href: u, replace: function () {}, assign: function () {} },
          close: function () {
            this.closed = true;
          },
          focus: function () {},
          blur: function () {},
          postMessage: function () {},
          opener: null
        };
      }
      try {
        return origOpen.apply(window, arguments);
      } catch (e) {
        return null;
      }
    };

    const onClickCapture = function (e) {
      const a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
      if (!a) return;
      const href = String(a.href || a.getAttribute("href") || "");
      if (href && /coa|\.pdf|certificate/i.test(href)) {
        e.preventDefault();
        e.stopPropagation();
        finish(href);
      }
    };
    document.addEventListener("click", onClickCapture, true);

    function restore() {
      clearTimeout(timer);
      window.open = origOpen;
      document.removeEventListener("click", onClickCapture, true);
    }

    return { promise: promise, restore: restore, finish: finish };
  }

  /**
   * @param {object} selectors
   * @param {string} lotNumber
   * @param {string} catalogNumber
   * @returns {Promise<{ ok: boolean, downloadUrl?: string, filename?: string, error?: string, errorMessage?: string }>}
   */
  async function runDocumentsSearch(selectors, lotNumber, catalogNumber) {
    dismissCookieBanners(selectors);
    await sleep(400);

    const lotInput = queryFirst(selectors.lotInput);
    if (!lotInput) {
      return {
        ok: false,
        error: "lot_input_not_found",
        errorMessage: "Could not find the Lot/Batch Number field on the CoA search page."
      };
    }

    setNativeInputValue(lotInput, lotNumber);
    await sleep(150);

    if (catalogNumber) {
      const productInput = queryFirst(selectors.productInput);
      if (productInput) {
        setNativeInputValue(productInput, catalogNumber);
        await sleep(100);
      }
    }

    const nav = captureNavigationUrl(20000);
    const submit = queryFirst(selectors.submitButton);
    if (!submit) {
      nav.restore();
      return {
        ok: false,
        error: "submit_not_found",
        errorMessage: "Could not find the CoA Search submit button."
      };
    }

    clickEl(submit);

    /* Some SPAs open the PDF via XHR then window.open shortly after submit. */
    let downloadUrl = await nav.promise;

    if (!downloadUrl) {
      /* Fallback: look for a result link on the page. */
      for (let attempt = 0; attempt < 10 && !downloadUrl; attempt++) {
        await sleep(500);
        const link = queryFirst(selectors.resultPdfLink);
        if (link && link.href) {
          downloadUrl = String(link.href);
          break;
        }
        const anyPdf = Array.from(document.querySelectorAll("a[href]")).find(function (a) {
          return /\/certificates\/coa\/|\.pdf/i.test(a.href || "");
        });
        if (anyPdf) {
          downloadUrl = String(anyPdf.href);
          break;
        }
      }
    }

    if (!downloadUrl) {
      return {
        ok: false,
        error: "coa_not_found",
        errorMessage:
          "No CoA download was found for lot " +
          lotNumber +
          (catalogNumber ? " / catalog " + catalogNumber : "") +
          "."
      };
    }

    return {
      ok: true,
      downloadUrl: downloadUrl,
      filename: filenameFromUrl(downloadUrl, lotNumber, catalogNumber)
    };
  }

  /**
   * Find a lot document link on a product documentation panel and click it.
   * @param {object} selectors
   * @param {string} lotNumber
   * @param {string} catalogNumber
   */
  async function runProductPage(selectors, lotNumber, catalogNumber) {
    dismissCookieBanners(selectors);
    await sleep(500);

    const lotNorm = String(lotNumber || "")
      .trim()
      .toLowerCase();
    const links = Array.from(document.querySelectorAll((selectors.documentLotLink || []).join(",") || "a"));
    let match = null;
    for (let i = 0; i < links.length; i++) {
      const t = String(links[i].textContent || "")
        .trim()
        .toLowerCase();
      if (t === lotNorm || t.indexOf(lotNorm) !== -1) {
        match = links[i];
        break;
      }
    }

    if (!match) {
      /* Fallback: any element text matching the lot that is clickable. */
      const all = Array.from(document.querySelectorAll("a, button, [role='link']"));
      match =
        all.find(function (el) {
          return String(el.textContent || "").trim().toLowerCase() === lotNorm;
        }) || null;
    }

    if (!match) {
      return {
        ok: false,
        error: "lot_link_not_found",
        errorMessage: "Lot " + lotNumber + " was not listed on the product CoA panel."
      };
    }

    const href = String(match.href || match.getAttribute("href") || "");
    if (href && /^https?:/i.test(href) && /coa|\.pdf/i.test(href)) {
      return {
        ok: true,
        downloadUrl: href,
        filename: filenameFromUrl(href, lotNumber, catalogNumber)
      };
    }

    const nav = captureNavigationUrl(20000);
    try {
      match.scrollIntoView({ block: "center", behavior: "instant" });
    } catch (e) {
      /* ignore */
    }
    clickEl(match);
    const downloadUrl = await nav.promise;
    if (!downloadUrl) {
      return {
        ok: false,
        error: "coa_not_found",
        errorMessage: "Clicked lot " + lotNumber + " but no CoA PDF URL was captured.",
        /* Signal background to watch for a new tab opened by this click. */
        watchNewTab: true
      };
    }
    return {
      ok: true,
      downloadUrl: downloadUrl,
      filename: filenameFromUrl(downloadUrl, lotNumber, catalogNumber)
    };
  }

  /**
   * @param {string} url
   * @param {string} lotNumber
   * @param {string} catalogNumber
   * @returns {string}
   */
  function filenameFromUrl(url, lotNumber, catalogNumber) {
    try {
      const path = new URL(url).pathname;
      const base = path.split("/").pop() || "";
      const clean = base.replace(/[?#].*$/, "");
      if (clean && /\.pdf$/i.test(clean)) return clean;
    } catch (e) {
      /* ignore */
    }
    const sku = String(catalogNumber || "coa").replace(/[^\w.-]+/g, "_");
    const lot = String(lotNumber || "lot").replace(/[^\w.-]+/g, "_");
    return sku + "_" + lot + "_CoA.pdf";
  }

  /**
   * Download the PDF in-page (session cookies) and return base64.
   * @param {string} downloadUrl
   * @param {string} filename
   * @returns {Promise<object>}
   */
  async function downloadPdfPayload(downloadUrl, filename) {
    let res;
    try {
      res = await fetch(downloadUrl, {
        method: "GET",
        credentials: "include",
        redirect: "follow"
      });
    } catch (e) {
      return {
        ok: false,
        error: "fetch_failed",
        errorMessage: (e && e.message) || "Could not download the CoA PDF.",
        downloadUrl: downloadUrl,
        filename: filename
      };
    }
    if (!res || !res.ok) {
      return {
        ok: false,
        error: "http_" + (res && res.status),
        errorMessage: "CoA download failed with HTTP " + (res && res.status) + ".",
        downloadUrl: downloadUrl,
        filename: filename
      };
    }
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    if (!bytes.length) {
      return {
        ok: false,
        error: "empty_file",
        errorMessage: "The CoA download was empty.",
        downloadUrl: downloadUrl,
        filename: filename
      };
    }
    const head = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3] || 0);
    if (head !== "%PDF") {
      return {
        ok: false,
        error: "not_pdf",
        errorMessage: "The download did not look like a PDF.",
        downloadUrl: downloadUrl,
        filename: filename
      };
    }
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return {
      ok: true,
      downloadUrl: downloadUrl,
      filename: filename,
      mimeType: "application/pdf",
      encoding: "base64",
      body: btoa(binary),
      byteLength: bytes.length
    };
  }

  /**
   * @param {object} locateResult
   * @param {string} lotNumber
   * @param {string} catalogNumber
   */
  async function withDownloadedFile(locateResult, lotNumber, catalogNumber) {
    if (!locateResult || !locateResult.ok || !locateResult.downloadUrl) {
      return locateResult;
    }
    const filename =
      locateResult.filename ||
      filenameFromUrl(locateResult.downloadUrl, lotNumber, catalogNumber);
    const file = await downloadPdfPayload(locateResult.downloadUrl, filename);
    if (!file.ok) {
      /* Still return the URL so the background can retry the download. */
      return Object.assign({}, locateResult, {
        ok: true,
        filename: filename,
        downloadOnly: true,
        downloadError: file.error,
        downloadErrorMessage: file.errorMessage
      });
    }
    return Object.assign({}, locateResult, file);
  }

  /**
   * @param {object} payload
   */
  async function handleFetchCoa(payload) {
    const vendorId = String((payload && payload.vendorId) || "").toLowerCase();
    const lotNumber = String((payload && payload.lotNumber) || "").trim();
    const catalogNumber = String((payload && payload.catalogNumber) || "").trim();
    const strategy = String((payload && payload.strategy) || "documents_search").toLowerCase();

    if (!lotNumber) {
      return {
        ok: false,
        error: "missing_lot",
        errorMessage: "A lot number is required to fetch a CoA."
      };
    }

    const selectors = Object.assign(
      {},
      DEFAULT_SELECTORS[vendorId] || DEFAULT_SELECTORS.sigma,
      (payload && payload.selectors) || {}
    );

    const located =
      strategy === "product_page"
        ? await runProductPage(selectors, lotNumber, catalogNumber)
        : await runDocumentsSearch(selectors, lotNumber, catalogNumber);

    return withDownloadedFile(located, lotNumber, catalogNumber);
  }

  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (!message || message.type !== "QUARTZY_FETCH_COA") return;
    handleFetchCoa(message.payload || {})
      .then(function (result) {
        sendResponse(result);
      })
      .catch(function (e) {
        sendResponse({
          ok: false,
          error: "unexpected",
          errorMessage: (e && e.message) || "CoA fetch failed on the vendor page."
        });
      });
    return true;
  });
})();
