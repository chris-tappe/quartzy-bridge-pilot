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
    "1. SIZE PRIORITY: If ANY node is marked `selected: true`, `checked: true`, or an `ACTIVE_SELECTION:` / `HIGHLIGHTED_VARIANT:` line is present, return ONLY that one selected/active variant as a single-element JSON array. Do not list other sizes. If nothing is marked selected/active/highlighted, then extract all available variants.\n" +
    "2. PRICE PRIORITY: If multiple prices exist for an item (e.g., 'List Price' vs 'Your Price', 'Institutional Price', 'Contract Price', or 'Member Discount'), ALWAYS extract the user-specific/discounted price as the `unit_price`, ignoring the higher list price.\n" +
    "3. FIELDS TO EXTRACT: `item_name`, `catalog_number`, `unit_size`, and `unit_price`.\n" +
    "4. PRICE FORMAT: `unit_price` MUST always be a USD string like \"$56.80\" or \"$1,407.00\" — leading \"$\", thousands separators when needed, exactly two decimal places. Never use \"USD 529\", \"529 USD\", bare numbers, or missing cents.\n" +
    "5. CATALOG NUMBER DISAMBIGUATION: Size rows often contain several ID-like values (vendor catalog code, internal product id, line/goods id, raw price). Prefer, in order:\n" +
    "   (a) a `CATALOG_CANDIDATE:` / shared product-code hint if present;\n" +
    "   (b) values whose input `name`/`id`/`attrs` suggest catalog/sku/productcode/itemno (not goods_id, product_id, price, qty);\n" +
    "   (c) an alphanumeric seller catalog code that mixes letters+digits (e.g. S0899, 12-340-030) over pure numeric internal ids;\n" +
    "   (d) a code that is shared across all size rows for the same product.\n" +
    "   Never use search-box values from page chrome, country selectors, prices, quantities, CAS numbers, or PMID/citation ids as catalog_number.\n\n" +
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
        const m = text.match(/\b([A-Z0-9][A-Z0-9._/-]{3,})\b/);
        // Prefer SKU-looking tokens near a price
        const skuPrice = text.match(
          /\b([A-Z0-9][A-Z0-9._/-]{4,})\b[^$]{0,40}\$\s*[\d,]+(?:\.\d{2})?/i
        );
        const hit = (skuPrice && skuPrice[1]) || "";
        if (hit && hit.length > best.length) best = hit;
      }
      return best;
    }

    const highlightedRows = findVisuallyHighlightedRows();
    const highlightedSet = new Set(highlightedRows);
    const activeSku = inferActiveSkuFromBuyBox();

    const preamble = [];
    if (highlightedRows.length) {
      highlightedRows.slice(0, 3).forEach(function (tr) {
        const t = (tr.textContent || "").replace(/\s+/g, " ").trim().slice(0, 220);
        if (t) preamble.push("HIGHLIGHTED_VARIANT: " + t);
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
      const rowSelected =
        role === "row" &&
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
