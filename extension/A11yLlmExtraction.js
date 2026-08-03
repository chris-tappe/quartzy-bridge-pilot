/**
 * Prototype: serialize the active tab's accessibility tree and extract products
 * via the Gemini REST API. Loaded in the service worker (importScripts).
 *
 * Primary path: chrome.automation.getTree (requires "automation" permission;
 * may be unavailable on stock desktop Chrome). Fallback: DOM/ARIA walk via
 * chrome.scripting.executeScript producing the same compact text format.
 */
(function (global) {
  "use strict";

  const GEMINI_URL =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent";

  const SYSTEM_INSTRUCTION =
    "You are an expert scientific supply data extractor. Analyze this accessibility tree and extract the product details into a JSON array of objects.\n\n" +
    "CRITICAL EXTRACTION PRIORITY RULES:\n" +
    "1. SIZE PRIORITY: If ANY node is marked `selected: true`, `checked: true`, or an `ACTIVE_SELECTION:` / `HIGHLIGHTED_VARIANT:` line is present, return ONLY that one selected/active variant as a single-element JSON array. Do not list other sizes. Prefer `PRODUCT_FACT` values from the purchase/order card over page SEO titles or stale JSON-LD defaults when they conflict. If nothing is marked selected/active/highlighted, then extract all available variants.\n" +
    "2. PRICE PRIORITY: If multiple prices exist for an item (e.g., 'List Price' vs 'Your Price', 'Institutional Price', 'Contract Price', or 'Member Discount'), ALWAYS extract the user-specific/discounted price as the `unit_price`, ignoring the higher list price.\n" +
    "3. FIELDS TO EXTRACT: `item_name`, `catalog_number`, `unit_size`, and `unit_price`.\n" +
    "4. PRICE FORMAT: `unit_price` MUST always be a USD string like \"$56.80\" or \"$1,407.00\" — leading \"$\", thousands separators when needed, exactly two decimal places. Never use \"USD 529\", \"529 USD\", bare numbers, or missing cents.\n" +
    "5. CATALOG NUMBER DISAMBIGUATION: Size rows often contain several ID-like values (vendor catalog code, internal product id, line/goods id, raw price). Prefer, in order:\n" +
    "   (a) a `PRODUCT_FACT: catalog_number:` or `CATALOG_CANDIDATE:` hint if present;\n" +
    "   (b) values whose input `name`/`id`/`attrs` suggest catalog/sku/productcode/itemno (not goods_id, product_id, price, qty);\n" +
    "   (c) an alphanumeric seller catalog code that mixes letters+digits (e.g. S0899, 12-340-030, 95041-464) over pure numeric internal ids;\n" +
    "   (d) a code that is shared across all size rows for the same product.\n" +
    "   Never use search-box values from page chrome, country selectors, prices, quantities, CAS numbers, or PMID/citation ids as catalog_number.\n" +
    "6. PRODUCT_FACT LINES: When `PRODUCT_FACT:` lines are present, treat them as high-confidence extractions for missing a11y nodes (common when catalog/price are plain text). Prefer `PRODUCT_FACT: unit_price` over list/reg prices. Also honor `Cat no. / ID.` style labels as catalog_number.\n" +
    "7. If a `PAGE_SNIPPET:` is present because catalog was missing from the a11y tree, extract catalog_number / unit_price / unit_size from that snippet.\n" +
    "8. IGNORE chrome noise: cookie consent, OneTrust, feedback surveys, skip-links, country pickers, and mega-menu navigation. Do not treat product-family comparison tables (Features / Applications matrices) as selected purchase variants.\n\n" +
    "Output MUST be a valid JSON array of objects with exactly those 4 keys. Use null for unknown values.";

  const KEEP_ROLES = {
    heading: true,
    status: true,
    cell: true,
    row: true,
    link: true,
    staticText: true,
    button: true,
    grid: true,
    table: true,
    listitem: true,
    combobox: true,
    option: true,
    listBox: true,
    listbox: true,
    radioButton: true,
    radio: true,
    checkBox: true,
    checkbox: true,
    menuItem: true,
    menuitem: true,
    tab: true,
    textField: true,
    textbox: true,
    columnHeader: true,
    rowHeader: true
  };

  const MAX_SUMMARY_CHARS = 90000;
  const MAX_NODES = 2500;

  /**
   * @param {unknown} v
   * @returns {boolean}
   */
  function isTruthyState(v) {
    if (v === true || v === "true") return true;
    if (typeof v === "string" && /^(true|checked|selected|mixed)$/i.test(v)) return true;
    return false;
  }

  /**
   * @param {object} node - chrome.automation AutomationNode-like
   * @returns {string|null}
   */
  function formatAutomationNode(node) {
    if (!node || typeof node !== "object") return null;
    const role = node.role != null ? String(node.role) : "";
    if (!role || !KEEP_ROLES[role]) return null;

    const name = (node.name != null && String(node.name).trim()) || "";
    const value = (node.value != null && String(node.value).trim()) || "";
    if (!name && !value && role !== "table" && role !== "grid" && role !== "row") {
      return null;
    }

    const flags = [];
    const st = node.state && typeof node.state === "object" ? node.state : {};
    if (isTruthyState(node.selected) || isTruthyState(st.selected)) flags.push("selected: true");
    if (isTruthyState(node.checked) || isTruthyState(st.checked)) flags.push("checked: true");
    if (isTruthyState(node.focused) || isTruthyState(st.focused)) flags.push("focused: true");
    if (isTruthyState(node.expanded) || isTruthyState(st.expanded)) flags.push("expanded: true");
    if (isTruthyState(st.collapsed)) flags.push("collapsed: true");

    let head = "[role: " + role;
    if (flags.length) head += ", " + flags.join(", ");
    head += "]";

    const parts = [head];
    if (name) parts.push("Name: " + name.replace(/\s+/g, " ").trim());
    if (value && value !== name) parts.push("Value: " + value.replace(/\s+/g, " ").trim());
    return parts.join(" ");
  }

  /**
   * @param {object} root
   * @returns {string}
   */
  function serializeAutomationTree(root) {
    const lines = [];
    let count = 0;

    function walk(node) {
      if (!node || count >= MAX_NODES) return;
      const line = formatAutomationNode(node);
      if (line) {
        lines.push(line);
        count++;
      }
      const kids = node.children;
      if (!kids || !kids.length) return;
      for (let i = 0; i < kids.length; i++) {
        if (count >= MAX_NODES) break;
        walk(kids[i]);
      }
    }

    walk(root);
    let out = lines.join("\n");
    if (out.length > MAX_SUMMARY_CHARS) {
      out = out.slice(0, MAX_SUMMARY_CHARS) + "\n…[truncated]";
    }
    return out;
  }

  /**
   * @param {number} tabId
   * @returns {Promise<object>}
   */
  function getAutomationRoot(tabId) {
    return new Promise(function (resolve, reject) {
      if (!global.chrome || !chrome.automation || typeof chrome.automation.getTree !== "function") {
        reject(new Error("automation_unavailable"));
        return;
      }
      try {
        chrome.automation.getTree(tabId, function (rootNode) {
          if (chrome.runtime && chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || "automation_error"));
            return;
          }
          if (!rootNode) {
            reject(new Error("automation_no_root"));
            return;
          }
          let settled = false;
          function finish(node) {
            if (settled) return;
            settled = true;
            resolve(node || rootNode);
          }
          const kids = rootNode.children;
          if ((kids && kids.length) || rootNode.docLoaded || rootNode.name) {
            finish(rootNode);
            return;
          }
          try {
            if (typeof rootNode.addEventListener === "function") {
              rootNode.addEventListener("loadComplete", function onLoad() {
                try {
                  rootNode.removeEventListener("loadComplete", onLoad);
                } catch (e) {
                  /* ignore */
                }
                finish(rootNode);
              });
            }
          } catch (e) {
            finish(rootNode);
            return;
          }
          setTimeout(function () {
            finish(rootNode);
          }, 2500);
        });
      } catch (e) {
        reject(new Error((e && e.message) || "automation_throw"));
      }
    });
  }

  /**
   * Injected into the page: builds the same compact a11y summary from DOM/ARIA.
   * Must be self-contained (no closure over extension code).
   * @returns {string}
   */
  function collectDomA11ySummaryInPage() {
    const KEEP = {
      heading: true,
      status: true,
      cell: true,
      row: true,
      link: true,
      statictext: true,
      button: true,
      grid: true,
      table: true,
      listitem: true,
      combobox: true,
      option: true,
      listbox: true,
      radio: true,
      checkbox: true,
      menuitem: true,
      tab: true,
      textbox: true,
      columnheader: true,
      rowheader: true
    };
    const MAX_NODES = 2500;
    const MAX_CHARS = 90000;
    const SELECT_CLASS_RE =
      /(^|[\s_-])(selected|is-selected|active|is-active|current|is-current|chosen|highlighted|highlight|checked|is-checked|on)([\s_-]|$)/i;

    function implicitRole(el) {
      const tag = (el.tagName || "").toLowerCase();
      if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6") {
        return "heading";
      }
      if (tag === "a" && el.hasAttribute("href")) return "link";
      if (tag === "button") return "button";
      if (tag === "table") return "table";
      if (tag === "tr") return "row";
      if (tag === "td") return "cell";
      if (tag === "th") return "columnheader";
      if (tag === "li") return "listitem";
      if (tag === "option") return "option";
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";
      if (tag === "input") {
        const t = (el.getAttribute("type") || "text").toLowerCase();
        if (t === "radio") return "radio";
        if (t === "checkbox") return "checkbox";
        if (t === "button" || t === "submit" || t === "reset") return "button";
        return "textbox";
      }
      if (tag === "output") return "status";
      return "";
    }

    function accessibleName(el) {
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const parts = labelledBy.split(/\s+/).map(function (id) {
          const n = document.getElementById(id);
          return n ? (n.textContent || "").replace(/\s+/g, " ").trim() : "";
        });
        const joined = parts.filter(Boolean).join(" ");
        if (joined) return joined;
      }
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
      if (el.tagName && el.tagName.toLowerCase() === "img") {
        return (el.getAttribute("alt") || "").trim();
      }
      if (el.tagName && el.tagName.toLowerCase() === "input") {
        if (el.labels && el.labels.length) {
          return (el.labels[0].textContent || "").replace(/\s+/g, " ").trim();
        }
        const ph = (el.getAttribute("placeholder") || "").trim();
        if (ph) return ph;
        // Do not treat raw value as the accessible name — keep Value separate.
        return "";
      }
      if (el.tagName && el.tagName.toLowerCase() === "option") {
        return (el.textContent || el.value || "").replace(/\s+/g, " ").trim();
      }
      if (el.tagName && el.tagName.toLowerCase() === "tr") {
        const full = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (full.length <= 220) return full;
        return full.slice(0, 220) + "…";
      }
      const own = [];
      for (let i = 0; i < el.childNodes.length; i++) {
        const c = el.childNodes[i];
        if (c.nodeType === 3) {
          const t = (c.textContent || "").replace(/\s+/g, " ").trim();
          if (t) own.push(t);
        }
      }
      if (own.length) return own.join(" ");
      const full = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (full.length <= 160) return full;
      return full.slice(0, 160) + "…";
    }

    function classLooksSelected(el) {
      if (!el || !el.className) return false;
      const cn = typeof el.className === "string" ? el.className : String(el.className.baseVal || "");
      return SELECT_CLASS_RE.test(cn);
    }

    function parseRgb(bg) {
      if (!bg || bg === "transparent" || bg === "rgba(0, 0, 0, 0)") return null;
      const m = String(bg).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      if (!m) return null;
      return { r: +m[1], g: +m[2], b: +m[3] };
    }

    function colorDistance(a, b) {
      return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
    }

    /** Rows whose background clearly differs from sibling rows (e.g. Sigma blue highlight). */
    function findVisuallyHighlightedRows() {
      const out = [];
      const tables = document.querySelectorAll("table, [role='table'], [role='grid']");
      for (let t = 0; t < tables.length; t++) {
        const rows = Array.prototype.slice.call(tables[t].querySelectorAll("tr")).filter(function (tr) {
          return tr.querySelectorAll("td").length > 0;
        });
        if (rows.length < 2) continue;

        const colors = rows.map(function (tr) {
          try {
            const cs = window.getComputedStyle(tr);
            let c = parseRgb(cs.backgroundColor);
            // Some sites color a child/cell instead of the <tr>.
            if (!c) {
              const cell = tr.querySelector("td");
              if (cell) c = parseRgb(window.getComputedStyle(cell).backgroundColor);
            }
            return c;
          } catch (e) {
            return null;
          }
        });

        const coloredIdxs = [];
        const counts = {};
        colors.forEach(function (c, idx) {
          if (!c) return;
          // Near-white backgrounds are treated as unhighlighted.
          if (c.r > 245 && c.g > 245 && c.b > 245) return;
          coloredIdxs.push(idx);
          const key = c.r + "," + c.g + "," + c.b;
          if (!counts[key]) counts[key] = { n: 0, idxs: [], rgb: c };
          counts[key].n++;
          counts[key].idxs.push(idx);
        });

        // Common case: most rows transparent/white, one tinted highlight row.
        if (coloredIdxs.length > 0 && coloredIdxs.length <= Math.max(1, Math.floor(rows.length / 3))) {
          coloredIdxs.forEach(function (idx) {
            out.push(rows[idx]);
          });
          continue;
        }

        const keys = Object.keys(counts);
        if (!keys.length) continue;
        keys.sort(function (a, b) {
          return counts[b].n - counts[a].n;
        });
        const majority = keys[0];
        const majRgb = counts[majority].rgb;
        for (let i = 0; i < keys.length; i++) {
          if (keys[i] === majority) continue;
          const minority = counts[keys[i]];
          if (minority.n > Math.max(1, Math.floor(rows.length / 3))) continue;
          if (colorDistance(majRgb, minority.rgb) < 40) continue;
          minority.idxs.forEach(function (idx) {
            out.push(rows[idx]);
          });
        }
      }
      return out;
    }

    const STOP_SKU_WORDS = {
      CUSTOMER: true,
      PRICE: true,
      ORDER: true,
      CART: true,
      STOCK: true,
      MEASURE: true,
      UNIT: true,
      CASE: true,
      BOTTLE: true,
      ADD: true,
      RETURN: true,
      POLICY: true,
      NEW: true,
      REG: true,
      REGULAR: true,
      SALE: true,
      YOUR: true,
      LIST: true,
      MEMBER: true,
      CONTRACT: true,
      INSTITUTIONAL: true,
      SHIPPING: true,
      FREE: true,
      LOGIN: true,
      SEARCH: true,
      HOME: true,
      ABOUT: true,
      DETAILS: true,
      DOCUMENTS: true,
      CERTIFICATES: true
    };

    function looksLikeCatalogSku(token, opts) {
      if (!token) return false;
      const t = String(token).trim();
      if (t.length < 3 || t.length > 40) return false;
      if (STOP_SKU_WORDS[t.toUpperCase()]) return false;
      if (!/\d/.test(t)) return false; // must include a digit
      if (/^(USD|EUR|GBP|CAS|UN|ADR|MDL)$/i.test(t)) return false;
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(t)) return false;
      // Unlabeled guesses: reject bare prices / tiny ids. Labeled "Cat no." may be numeric (e.g. 217684).
      if (!opts || !opts.labeled) {
        if (/^\d+\.\d{2}$/.test(t)) return false;
        if (/^\d+$/.test(t) && t.length < 5) return false;
      } else if (/^\d+\.\d{2}$/.test(t)) {
        return false;
      }
      return true;
    }

    /**
     * Infer active SKU from buy-box / summary panels (common on Sigma, Fisher, etc.).
     * @returns {string}
     */
    function inferActiveSkuFromBuyBox() {
      const needles = /add to cart|one time order|your price|list price|buy box|purchase/i;
      const candidates = document.querySelectorAll(
        "[class*='cart'],[class*='Cart'],[class*='buy'],[class*='Buy'],[class*='order'],[class*='Order'],[class*='summary'],[class*='Summary'],[data-testid],[id*='cart'],[id*='buy']"
      );
      let best = "";
      for (let i = 0; i < candidates.length; i++) {
        const el = candidates[i];
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!text || text.length > 800) continue;
        if (!needles.test(text) && !el.querySelector("button, [type='submit'], input[type='radio']")) {
          continue;
        }
        // Prefer SKU-looking tokens near a price (require digit; reject words like CUSTOMER).
        const skuPrice = text.match(
          /\b([A-Za-z0-9][A-Za-z0-9._/-]{3,})\b[^$]{0,40}\$\s*[\d,]+(?:\.\d{2})?/
        );
        const hit = skuPrice && skuPrice[1] ? skuPrice[1] : "";
        if (looksLikeCatalogSku(hit) && hit.length > best.length) best = hit;
      }
      return best;
    }

    /**
     * Supplement a11y gaps: many PDPs put catalog/price in plain spans/divs with no role.
     * Prefer the visible purchase/order card (selected variant) over page-level JSON-LD.
     * @returns {string[]}
     */
    function collectProductFactLines() {
      const facts = [];
      const extras = []; // ACTIVE_SELECTION / PAGE_SNIPPET (not PRODUCT_FACT)
      const root =
        document.querySelector("main, [role='main'], #main, #content, .product, [class*='product']") ||
        document.body;

      function hasFact(label) {
        const prefix = "PRODUCT_FACT: " + label + ":";
        for (let i = 0; i < facts.length; i++) {
          if (facts[i].indexOf(prefix) === 0) return true;
        }
        return false;
      }

      function normalizeFactPrice(raw) {
        const s = String(raw == null ? "" : raw).trim();
        if (!s) return "";
        const n = parseFloat(s.replace(/[$,\s]/g, "").replace(/USD/gi, ""));
        if (Number.isNaN(n)) return s;
        try {
          return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
        } catch (e) {
          return "$" + n.toFixed(2);
        }
      }

      /** Fix textContent glue ("217661For") and trailing prose after labeled catalogs. */
      function sanitizeCatalogToken(raw) {
        let v = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
        v = v.replace(/^[:./\s]+/, "");
        // Digits glued to a capitalized word: 217661For → 217661
        const glued = v.match(/^(\d{3,12})([A-Z][a-zA-Z]{1,20})\b/);
        if (glued) v = glued[1];
        // First catalog-shaped token only
        const token = v.match(/^([A-Za-z]{0,8}\d[A-Za-z0-9._-]{0,30})/);
        if (token) v = token[1];
        v = v.replace(/(?:For|Kit|Pack|Case|With|And|The|From|Preps?|Well)$/i, "");
        return v.trim();
      }

      function pushFact(label, value) {
        if (!value || hasFact(label)) return;
        let v = String(value).replace(/\s+/g, " ").trim();
        if (!v) return;
        if (label === "unit_price") v = normalizeFactPrice(v);
        if (label === "catalog_number") {
          v = sanitizeCatalogToken(v);
          if (!looksLikeCatalogSku(v, { labeled: true })) return;
        }
        facts.push("PRODUCT_FACT: " + label + ": " + v);
      }

      // Capture group stops at first catalog token (no trailing "For…").
      const catalogMatchers = [
        /Cat\s*no\.?\s*\/\s*ID\.?\s*:?\s*([A-Za-z]*\d+[A-Za-z0-9._-]*)/i,
        /Cat\.?\s*no\.?\s*\/\s*ID\.?\s*:?\s*([A-Za-z]*\d+[A-Za-z0-9._-]*)/i,
        /Catalog\s*#\s*:?\s*([A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*)/i,
        /Catalog\s*Number\s*:?\s*([A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*)/i,
        /Cat(?:alog)?\.?\s*(?:No|Num|#)\.?\s*(?:\/\s*ID\.?)?\s*:?\s*([A-Za-z]*\d+[A-Za-z0-9._-]*)/i,
        /Item\s*(?:#|No\.?|Number)\s*:?\s*([A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*)/i,
        /SKU\s*:?\s*([A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*)/i
      ];

      function extractCatalogFromText(text) {
        if (!text) return "";
        for (let c = 0; c < catalogMatchers.length; c++) {
          const m = text.match(catalogMatchers[c]);
          if (!m) continue;
          const cleaned = sanitizeCatalogToken(m[1]);
          if (looksLikeCatalogSku(cleaned, { labeled: true })) return cleaned;
        }
        return "";
      }

      function extractPricesFromText(text) {
        if (!text) return [];
        const out = [];
        const re = /\$\s*([\d,]+\.\d{2})/g;
        let m;
        while ((m = re.exec(text)) != null) {
          out.push(m[1]);
        }
        return out;
      }

      /** BD: "Unit: EA (1 Each)"; VWR UOM; Case/Pack of N; etc. */
      function extractUnitSizeFromText(text) {
        if (!text) return "";
        const matchers = [
          /\bUnit\s*:\s*([A-Za-z0-9][A-Za-z0-9 .()\/_-]{1,60})/i,
          /\bUOM\s*:\s*([A-Za-z0-9][A-Za-z0-9 .()\/_-]{1,60})/i,
          /Unit of Measure\s*:?\s*([A-Za-z0-9][A-Za-z0-9 .()\/_-]{2,80})/i,
          /\b(Case of \d+[^\n.]{0,40})/i,
          /\b(Pack of \d+[^\n.]{0,40})/i,
          /\bFor\s+(\d+\s*preps?)\b/i
        ];
        for (let i = 0; i < matchers.length; i++) {
          const m = text.match(matchers[i]);
          if (!m || !m[1]) continue;
          let v = m[1].replace(/\s+/g, " ").trim();
          // Stop before following labels on the same line.
          v = v.split(/\s{2,}|\s+(?:Price|Qty|Quantity|Availability|Add to|SKU|Cat)\b/i)[0].trim();
          if (v.length >= 1 && v.length <= 80) return v;
        }
        return "";
      }

      function isSelectedControl(el) {
        if (!el) return false;
        if (el.getAttribute("aria-pressed") === "true") return true;
        if (el.getAttribute("aria-selected") === "true") return true;
        if (el.getAttribute("aria-checked") === "true") return true;
        if (el.getAttribute("aria-current") === "true") return true;
        if (el.checked === true) return true;
        return classLooksSelected(el);
      }

      /** Purchase card around Add to cart — highest-confidence source for selected variant. */
      function findPurchaseScope() {
        const buttons = Array.prototype.slice.call(
          document.querySelectorAll("button, a, input[type='submit']")
        );
        let addBtn = null;
        for (let i = 0; i < buttons.length; i++) {
          const t = (buttons[i].textContent || buttons[i].value || "").replace(/\s+/g, " ").trim();
          if (/^add to cart$/i.test(t) || /^add to cart\b/i.test(t)) {
            // Prefer the first in main content, skip "frequently purchased" carousels later by scope size.
            addBtn = buttons[i];
            break;
          }
        }
        if (!addBtn) {
          addBtn = document.querySelector(
            "[class*='add-to-cart'],[class*='AddToCart'],[data-testid*='add-to-cart']"
          );
        }
        if (!addBtn) return null;
        let scope =
          addBtn.closest(
            "form, article, section, [class*=' ord'],[class*='Order'],[class*='purchase'],[class*='Purchase'],[class*='product-detail'],[class*='ProductDetail'],[class*='buy'],[class*='Buy']"
          ) || addBtn.parentElement;
        // Walk up until the scope contains a catalog label or a $ price.
        for (let up = 0; up < 6 && scope && scope !== document.body; up++) {
          const t = (scope.textContent || "").replace(/\s+/g, " ");
          if (/Cat\s*no|Catalog\s*#|SKU/i.test(t) && /\$\s*[\d,]+\.\d{2}/.test(t)) break;
          if (scope.parentElement) scope = scope.parentElement;
        }
        return scope;
      }

      function collectFromPurchaseScope(scope) {
        if (!scope) return;
        const text = (scope.textContent || "").replace(/\s+/g, " ").trim();

        // Selected variant chips (Micro / Mini / 96 well) — often missing from role tree.
        function variantLabel(el) {
          const label = (el.getAttribute("aria-label") || el.textContent || "")
            .replace(/\s+/g, " ")
            .trim();
          if (!label || label.length > 32) return "";
          if (
            /^(product|product details|resources|publications|faq|add to cart|log in|copy|check availability)$/i.test(
              label
            )
          ) {
            return "";
          }
          if (
            !/^(micro|mini|96\s*well|.*\bwell\b|plate|column|pack|case|bottle)\b/i.test(label) &&
            !/^\d+(\s*(ml|µl|ul|l|mg|ug|µg|preps?))?$/i.test(label)
          ) {
            return "";
          }
          return label;
        }

        const controls = scope.querySelectorAll(
          "button, [role='button'], [role='radio'], [role='tab'], input[type='radio'], a, label"
        );
        const selectedLabels = [];
        for (let i = 0; i < controls.length; i++) {
          const el = controls[i];
          if (!isSelectedControl(el)) continue;
          const label = variantLabel(el);
          if (label && selectedLabels.indexOf(label) === -1) selectedLabels.push(label);
        }

        // Visual toggle group: siblings Micro/Mini/96 well where one has a stronger border.
        if (!selectedLabels.length) {
          const candidates = [];
          for (let i = 0; i < controls.length; i++) {
            const label = variantLabel(controls[i]);
            if (label) candidates.push({ el: controls[i], label: label });
          }
          if (candidates.length >= 2 && candidates.length <= 8) {
            let best = null;
            let bestScore = -1;
            candidates.forEach(function (c) {
              try {
                const cs = window.getComputedStyle(c.el);
                const bw =
                  (parseFloat(cs.borderTopWidth) || 0) +
                  (parseFloat(cs.borderBottomWidth) || 0) +
                  (parseFloat(cs.borderLeftWidth) || 0) +
                  (parseFloat(cs.borderRightWidth) || 0);
                const color = parseRgb(cs.borderTopColor) || parseRgb(cs.color);
                // Blue-ish selected chips score higher.
                const blue =
                  color && color.b > color.r + 20 && color.b > color.g ? 30 : 0;
                const score = bw * 10 + blue;
                if (score > bestScore) {
                  bestScore = score;
                  best = c.label;
                }
              } catch (e) {
                /* ignore */
              }
            });
            if (best && bestScore >= 20) selectedLabels.push(best);
          }
        }

        if (selectedLabels.length) {
          extras.push(
            "ACTIVE_SELECTION: variant option(s): " + selectedLabels.slice(0, 3).join(" | ")
          );
        }

        // Prefer the product title nearest the catalog line (not the page H1 SEO title).
        const headings = scope.querySelectorAll("h1, h2, h3, h4");
        for (let h = 0; h < headings.length; h++) {
          let name = (headings[h].textContent || "").replace(/\s+/g, " ").trim();
          name = name.replace(/\s*icon_[\w-]+/g, "").trim();
          if (!name || name.length > 180) continue;
          // Skip marketing H1 if a more specific kit title exists later in the card.
          if (/microRNA Isolation|phenol-free purification/i.test(name) && headings.length > 1) {
            continue;
          }
          pushFact("item_name", name);
          break;
        }

        const cat = extractCatalogFromText(text);
        if (cat) pushFact("catalog_number", cat);

        const prices = extractPricesFromText(text);
        if (prices.length) {
          // Order card sell price is the first $X.XX (QIAGEN: $1,944.00).
          pushFact("unit_price", prices[0]);
        }

        const unitFromCard = extractUnitSizeFromText(text);
        if (unitFromCard) pushFact("unit_size", unitFromCard);
        const kitParen = text.match(
          /(?:Kit|Pack|Plate)\s*\((\d+)\)|\((\d+)\s*(?:preps?|reactions?|rxns?)\)/i
        );
        if (!hasFact("unit_size") && kitParen) {
          pushFact("unit_size", kitParen[1] || kitParen[2]);
        }
      }

      // 1) Visible purchase card first (selected Micro/Mini/96 well + live price).
      collectFromPurchaseScope(findPurchaseScope());

      // 2) Page-wide labeled facts only for fields still missing (VWR Catalog #, etc.).
      const blob = (root.textContent || "").replace(/\s+/g, " ").trim();
      if (!hasFact("catalog_number")) {
        const cat = extractCatalogFromText(blob);
        if (cat) pushFact("catalog_number", cat);
      }
      if (!hasFact("unit_price")) {
        const priceMatchers = [
          /(?:NEW\s+)?CUSTOMER\s+PRICE\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
          /(?:Your|Contract|Member|Institutional)\s*Price\s*:?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
          /\$\s*([\d,]+\.\d{2})\s*(?:reg\.|regular|list)/i,
          /\$\s*([\d,]+\.\d{2})/
        ];
        for (let p = 0; p < priceMatchers.length; p++) {
          const m = blob.match(priceMatchers[p]);
          if (m && m[1]) {
            pushFact("unit_price", m[1]);
            break;
          }
        }
      }
      if (!hasFact("unit_size")) {
        const unit = extractUnitSizeFromText(blob);
        if (unit) pushFact("unit_size", unit);
      }

      const labeled = root.querySelectorAll("span, div, p, dd, dt, li, strong, b");
      for (let i = 0; i < labeled.length && (!hasFact("catalog_number") || !hasFact("unit_price")); i++) {
        const el = labeled[i];
        if (el.closest("#onetrust-consent-sdk, .onetrust-pc-dark-filter, [id*='cookie']")) continue;
        const t = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!t || t.length > 160) continue;
        if (!hasFact("catalog_number")) {
          const cat = extractCatalogFromText(t);
          if (cat) pushFact("catalog_number", cat);
        }
        if (!hasFact("unit_price") && /^\$\s*[\d,]+\.\d{2}$/.test(t)) pushFact("unit_price", t);
      }

      // 3) JSON-LD only fills gaps — never overrides live buy-box price/name/catalog.
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (let i = 0; i < scripts.length; i++) {
        let data;
        try {
          data = JSON.parse(scripts[i].textContent || "");
        } catch (e) {
          continue;
        }
        const nodes = Array.isArray(data) ? data : data && data["@graph"] ? data["@graph"] : [data];
        for (let n = 0; n < nodes.length; n++) {
          const obj = nodes[n];
          if (!obj || typeof obj !== "object") continue;
          const typ = obj["@type"];
          const isProduct =
            typ === "Product" || (Array.isArray(typ) && typ.indexOf("Product") !== -1);
          if (!isProduct) continue;
          if (!hasFact("item_name") && obj.name) pushFact("item_name", obj.name);
          if (!hasFact("catalog_number")) {
            if (obj.sku) pushFact("catalog_number", obj.sku);
            else if (obj.mpn) pushFact("catalog_number", obj.mpn);
            else if (obj.productID) pushFact("catalog_number", obj.productID);
          }
          if (!hasFact("unit_price")) {
            const offers = obj.offers
              ? Array.isArray(obj.offers)
                ? obj.offers[0]
                : obj.offers
              : null;
            if (offers && (offers.price != null || offers.lowPrice != null)) {
              pushFact("unit_price", String(offers.price != null ? offers.price : offers.lowPrice));
            }
          }
        }
      }

      if (!hasFact("catalog_number")) {
        const snippet = blob.slice(0, 700);
        if (snippet) extras.push("PAGE_SNIPPET: " + snippet + (blob.length > 700 ? "…" : ""));
      }

      return facts.concat(extras).slice(0, 18);
    }

    const highlightedRows = findVisuallyHighlightedRows();
    const highlightedSet = new Set(highlightedRows);
    const activeSku = inferActiveSkuFromBuyBox();
    const productFacts = collectProductFactLines();

    const preamble = productFacts.slice();
    if (highlightedRows.length) {
      highlightedRows.slice(0, 3).forEach(function (tr) {
        const t = (tr.textContent || "").replace(/\s+/g, " ").trim().slice(0, 220);
        // Skip comparison / feature matrices that aren't size-price selectors.
        if (!t || !/(\$\s*[\d,]|\bUSD\b|\bSKU\b|\bCat(?:alog)?\b|\bPrice\b|\bmL\b|\bmg\b|\bL\b)/i.test(t)) {
          return;
        }
        if (/^Features\b/i.test(t) && !/\$\s*[\d,]/.test(t)) return;
        preamble.push("HIGHLIGHTED_VARIANT: " + t);
      });
    }
    if (activeSku) {
      preamble.push("ACTIVE_SELECTION: catalog/SKU " + activeSku + " (from purchase/summary panel)");
    }

    /**
     * Shared alphanumeric codes across pricing-table rows → strong catalog hint (e.g. S0899).
     */
    function inferSharedCatalogCandidate() {
      const codeCounts = {};
      const tables = document.querySelectorAll("table");
      for (let t = 0; t < tables.length; t++) {
        const tableText = (tables[t].textContent || "").toLowerCase();
        if (!/(price|usd|\$|size|qty|stock|cart)/i.test(tableText)) continue;
        const rows = tables[t].querySelectorAll("tr");
        for (let r = 0; r < rows.length; r++) {
          const tr = rows[r];
          if (!tr.querySelector("td")) continue;
          const inputs = tr.querySelectorAll("input");
          if (!inputs.length) continue;
          const seenInRow = {};
          for (let j = 0; j < inputs.length; j++) {
            const v = String(inputs[j].value || "").trim();
            if (!/^[A-Za-z]{1,5}\d{2,}[A-Za-z0-9_-]*$/.test(v)) continue;
            if (seenInRow[v]) continue;
            seenInRow[v] = true;
            codeCounts[v] = (codeCounts[v] || 0) + 1;
          }
        }
      }
      let best = "";
      let bestN = 0;
      Object.keys(codeCounts).forEach(function (code) {
        if (codeCounts[code] > bestN) {
          best = code;
          bestN = codeCounts[code];
        }
      });
      return bestN >= 2 ? best : "";
    }

    const sharedCatalog = inferSharedCatalogCandidate();
    if (sharedCatalog) {
      preamble.push(
        "CATALOG_CANDIDATE: " +
          sharedCatalog +
          " (alphanumeric code shared across multiple size/price rows — prefer as catalog_number)"
      );
    }

    const lines = preamble.slice();
    let count = 0;
    const all = document.querySelectorAll(
      "h1,h2,h3,h4,h5,h6,a[href],button,table,tr,td,th,li,select,option,textarea,input," +
        "output,[role],[aria-selected],[aria-checked],[aria-current]"
    );

    function isChromeNoise(el) {
      if (!el) return true;
      if (el.closest("script,style,noscript,svg,template")) return true;
      if (
        el.closest(
          "#onetrust-consent-sdk, #onetrust-banner-sdk, .onetrust-pc-dark-filter, #ot-sdk-btn, " +
            "[class*='onetrust'], [id*='cookie'], [id*='Cookie'], " +
            "[class*='feedback'], [id*='feedback'], [class*='survey']"
        )
      ) {
        return true;
      }
      if (el.closest("nav, header, footer, [role='navigation'], [role='banner'], [role='contentinfo']")) {
        // Keep product-ish controls that sometimes live in header (search is still noise for catalog).
        const role = (el.getAttribute("role") || "").toLowerCase() || implicitRole(el);
        if (role === "textbox" || role === "button" || role === "link" || role === "listitem") {
          return true;
        }
      }
      return false;
    }

    for (let i = 0; i < all.length && count < MAX_NODES; i++) {
      const el = all[i];
      if (isChromeNoise(el)) continue;
      const roleAttr = (el.getAttribute("role") || "").toLowerCase();
      const role = roleAttr || implicitRole(el);
      if (!role || !KEEP[role]) continue;

      const tag = (el.tagName || "").toLowerCase();
      const isField = tag === "input" || tag === "textarea";
      const name = accessibleName(el);
      const value = isField ? String(el.value || "").trim() : "";
      if (!name && !value && role !== "table" && role !== "grid" && role !== "row") continue;

      const flags = [];
      const rowText = role === "row" ? name || "" : "";
      const rowLooksPurchasable =
        !!rowText &&
        /(\$\s*[\d,]|\bUSD\b|\bSKU\b|\bCat(?:alog)?\b|\bmL\b|\bmg\b)/i.test(rowText) &&
        !/^Features\b/i.test(rowText);
      const rowSelected =
        role === "row" &&
        rowLooksPurchasable &&
        (highlightedSet.has(el) ||
          classLooksSelected(el) ||
          (activeSku && name && name.indexOf(activeSku) !== -1));
      if (
        rowSelected ||
        el.selected === true ||
        el.getAttribute("aria-selected") === "true" ||
        el.getAttribute("aria-current") === "true" ||
        el.getAttribute("aria-current") === "page" ||
        classLooksSelected(el) ||
        (el.parentElement && classLooksSelected(el.parentElement))
      ) {
        flags.push("selected: true");
      }
      if (
        el.checked === true ||
        el.getAttribute("aria-checked") === "true" ||
        el.getAttribute("aria-checked") === "mixed"
      ) {
        flags.push("checked: true");
      }
      if (document.activeElement === el) flags.push("focused: true");
      if (el.getAttribute("aria-expanded") === "true") flags.push("expanded: true");

      const meta = [];
      if (isField) {
        const inputType = (el.getAttribute("type") || (tag === "textarea" ? "textarea" : "text")).toLowerCase();
        meta.push("type: " + inputType);
        const fieldName = (el.getAttribute("name") || "").trim();
        const fieldId = (el.getAttribute("id") || "").trim();
        if (fieldName) meta.push("name: " + fieldName);
        if (fieldId && fieldId !== fieldName) meta.push("id: " + fieldId);
      }

      let head = "[role: " + role;
      if (flags.length) head += ", " + flags.join(", ");
      if (meta.length) head += ", " + meta.join(", ");
      head += "]";
      const parts = [head];
      if (name) parts.push("Name: " + name);
      if (value) parts.push("Value: " + value);
      lines.push(parts.join(" "));
      count++;
    }

    let out = lines.join("\n");
    if (out.length > MAX_CHARS) out = out.slice(0, MAX_CHARS) + "\n…[truncated]";
    return out;
  }

  /**
   * @param {number} tabId
   * @returns {Promise<{ summary: string, source: string }>}
   */
  async function buildA11ySummary(tabId) {
    try {
      const root = await getAutomationRoot(tabId);
      const summary = serializeAutomationTree(root);
      if (summary && summary.trim()) {
        return { summary: summary, source: "chrome.automation" };
      }
    } catch (e) {
      /* fall through to DOM walk */
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: collectDomA11ySummaryInPage
    });
    const summary =
      results && results[0] && typeof results[0].result === "string" ? results[0].result : "";
    if (!summary || !summary.trim()) {
      throw new Error("a11y_empty");
    }
    return { summary: summary, source: "dom_aria_fallback" };
  }

  /**
   * @param {string} raw
   * @returns {unknown}
   */
  function parseJsonLoose(raw) {
    if (raw == null) return null;
    const t = String(raw).trim();
    if (!t) return null;
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fence && fence[1] ? fence[1].trim() : t;
    try {
      return JSON.parse(body);
    } catch (e) {
      /* try array or object slice */
    }
    const a0 = body.indexOf("[");
    const a1 = body.lastIndexOf("]");
    if (a0 !== -1 && a1 > a0) {
      try {
        return JSON.parse(body.slice(a0, a1 + 1));
      } catch (e2) {
        /* continue */
      }
    }
    const o0 = body.indexOf("{");
    const o1 = body.lastIndexOf("}");
    if (o0 !== -1 && o1 > o0) {
      try {
        return JSON.parse(body.slice(o0, o1 + 1));
      } catch (e3) {
        return null;
      }
    }
    return null;
  }

  /**
   * Normalize any price-like value to "$X,XXX.XX". Returns null if unparsable.
   * @param {unknown} raw
   * @returns {string|null}
   */
  function formatUnitPrice(raw) {
    if (raw == null || raw === "") return null;
    if (typeof raw === "number" && !Number.isNaN(raw)) {
      try {
        return new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD"
        }).format(raw);
      } catch (e) {
        return "$" + raw.toFixed(2);
      }
    }
    const s = String(raw).trim();
    if (!s) return null;
    const cleaned = s
      .replace(/USD|US\$|\$/gi, "")
      .replace(/,/g, "")
      .replace(/[^\d.+-]/g, "")
      .trim();
    if (!cleaned) return null;
    const n = parseFloat(cleaned);
    if (Number.isNaN(n)) return null;
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD"
      }).format(n);
    } catch (e2) {
      return "$" + n.toFixed(2);
    }
  }

  /**
   * @param {unknown} data
   * @returns {Array<{item_name: *, catalog_number: *, unit_size: *, unit_price: *}>}
   */
  function normalizeProductArray(data) {
    let arr = data;
    if (arr && typeof arr === "object" && !Array.isArray(arr)) {
      if (Array.isArray(arr.products)) arr = arr.products;
      else if (Array.isArray(arr.items)) arr = arr.items;
      else if (Array.isArray(arr.data)) arr = arr.data;
      else arr = [arr];
    }
    if (!Array.isArray(arr)) return [];
    return arr.map(function (row) {
      if (!row || typeof row !== "object") {
        return { item_name: null, catalog_number: null, unit_size: null, unit_price: null };
      }
      const rawPrice =
        row.unit_price != null
          ? row.unit_price
          : row.unitPrice != null
            ? row.unitPrice
            : row.price != null
              ? row.price
              : null;
      return {
        item_name: row.item_name != null ? row.item_name : row.itemName != null ? row.itemName : null,
        catalog_number:
          row.catalog_number != null
            ? row.catalog_number
            : row.catalogNumber != null
              ? row.catalogNumber
              : null,
        unit_size: row.unit_size != null ? row.unit_size : row.unitSize != null ? row.unitSize : null,
        unit_price: formatUnitPrice(rawPrice)
      };
    });
  }

  /**
   * @param {string} apiKey
   * @param {string} a11ySummary
   * @returns {Promise<Array<object>>}
   */
  async function callGemini(apiKey, a11ySummary) {
    const key = String(apiKey || "").trim();
    if (!key) throw new Error("missing_api_key");

    const url = GEMINI_URL + "?key=" + encodeURIComponent(key);
    const body = {
      system_instruction: {
        parts: [{ text: SYSTEM_INSTRUCTION }]
      },
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                "Accessibility tree summary for the active product page:\n\n" + String(a11ySummary || "")
            }
          ]
        }
      ],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.1
      }
    };

    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch (e) {
      throw new Error((e && e.message) || "gemini_fetch_failed");
    }

    const rawText = await res.text();
    if (!res.ok) {
      let detail = "http_" + res.status;
      try {
        const errObj = JSON.parse(rawText);
        if (errObj && errObj.error && errObj.error.message) {
          detail = errObj.error.message;
        }
      } catch (e2) {
        /* keep status */
      }
      throw new Error(detail);
    }

    let envelope;
    try {
      envelope = JSON.parse(rawText);
    } catch (e3) {
      throw new Error("gemini_bad_envelope");
    }

    const parts =
      envelope &&
      envelope.candidates &&
      envelope.candidates[0] &&
      envelope.candidates[0].content &&
      envelope.candidates[0].content.parts;
    const textPart =
      Array.isArray(parts) && parts.length
        ? parts
            .map(function (p) {
              return p && p.text != null ? String(p.text) : "";
            })
            .join("")
        : "";

    const parsed = parseJsonLoose(textPart);
    if (parsed == null) throw new Error("gemini_parse");
    return normalizeProductArray(parsed);
  }

  /**
   * Extract only the filtered a11y summary for the active tab (no Gemini call).
   * @param {{ tabId: number }} opts
   * @returns {Promise<{ ok: boolean, summary?: string, source?: string, summaryChars?: number, error?: string, errorMessage?: string }>}
   */
  async function getA11ySummaryForTab(opts) {
    const tabId = opts && opts.tabId;
    if (tabId == null || typeof tabId !== "number") {
      return { ok: false, error: "no_tab", errorMessage: "No active tab id." };
    }
    try {
      const built = await buildA11ySummary(tabId);
      return {
        ok: true,
        summary: built.summary,
        source: built.source,
        summaryChars: built.summary.length
      };
    } catch (e) {
      const code = (e && e.message) || "a11y_failed";
      return {
        ok: false,
        error: code,
        errorMessage:
          code === "a11y_empty"
            ? "Could not read an accessibility summary from this tab."
            : "Accessibility tree extraction failed: " + code
      };
    }
  }

  /**
   * @param {{ tabId: number, apiKey: string }} opts
   * @returns {Promise<{ ok: boolean, products?: Array<object>, source?: string, summaryChars?: number, error?: string, errorMessage?: string }>}
   */
  async function runA11yLlmExtraction(opts) {
    const tabId = opts && opts.tabId;
    const apiKey = opts && opts.apiKey;
    if (tabId == null || typeof tabId !== "number") {
      return { ok: false, error: "no_tab", errorMessage: "No active tab id." };
    }
    if (!apiKey || !String(apiKey).trim()) {
      return { ok: false, error: "missing_api_key", errorMessage: "Enter a Gemini API key first." };
    }

    let built;
    try {
      built = await buildA11ySummary(tabId);
    } catch (e) {
      const code = (e && e.message) || "a11y_failed";
      return {
        ok: false,
        error: code,
        errorMessage:
          code === "a11y_empty"
            ? "Could not read an accessibility summary from this tab."
            : "Accessibility tree extraction failed: " + code
      };
    }

    try {
      const products = await callGemini(apiKey, built.summary);
      return {
        ok: true,
        products: products,
        source: built.source,
        summaryChars: built.summary.length
      };
    } catch (e2) {
      return {
        ok: false,
        error: "gemini_failed",
        errorMessage: (e2 && e2.message) || "Gemini request failed.",
        source: built.source,
        summaryChars: built.summary.length
      };
    }
  }

  global.QuartzyA11yLlmExtraction = {
    runA11yLlmExtraction: runA11yLlmExtraction,
    getA11ySummaryForTab: getA11ySummaryForTab,
    SYSTEM_INSTRUCTION: SYSTEM_INSTRUCTION
  };
})(typeof self !== "undefined" ? self : this);
