console.log("[Quartzy Bridge] Content Script Loaded");

/**
 * In-page state for the side panel. Shown value per field (highest to lowest):
 * 1) This-session magic wand (displayCaptureFields)
 * 2) Per-site saved DOM mapping (QuartzyDomFieldHints.applySavedHints)
 * 3) JSON-LD / UCP + h1 + generic unit (mergeProductFields, optional AI when USE_AI_EXTRACTION is true)
 * doCaptureRun computes (3), applies (2) over the merge, then the UI uses (1) on top. Set true to re-enable AI.
 */
const USE_AI_EXTRACTION = false;

const CAPTURE_FIELD_KEYS = ["itemName", "catalogNumber", "price", "unitSize"];
const userTouched = { itemName: false, catalogNumber: false, price: false, unitSize: false };
const userValues = { itemName: "", catalogNumber: "", price: "", unitSize: "" };
let captureAutomated = { itemName: "", catalogNumber: "", price: "", unitSize: "" };
let exFieldSources = { itemName: null, catalogNumber: null, price: null, unitSize: null };
let exAiRefined = { itemName: false, catalogNumber: false, price: false, unitSize: false };
/** For side panel debug: first pass (H1, generic unit, JSON-LD paths) before post-LD merge / saved DOM / wand. */
let lastHeuristicProvenance = { itemName: "—", catalogNumber: "—", price: "—", unitSize: "—" };
const WAND_FIELD_SET = { itemName: 1, catalogNumber: 1, price: 1, unitSize: 1 };

const RERUN_DEBOUNCE_MS = 400;
let captureRerunDebounceT = null;
/**
 * Re-run the capture pipeline (without resetCaptureState) so JSON-LD and saved DOM hints refresh on
 * variant changes, late JSON-LD, etc. Shared debounce for MutationObserver and UI listeners.
 */
function scheduleCaptureRerun() {
  if (captureRerunDebounceT) {
    clearTimeout(captureRerunDebounceT);
  }
  captureRerunDebounceT = setTimeout(function () {
    captureRerunDebounceT = null;
    void run();
  }, RERUN_DEBOUNCE_MS);
}

/**
 * Best-effort unit size from common PDP patterns (no vendor-specific sites).
 */
function extractUnitSize() {
  const unitString = document.querySelector(".unit_string, .packaging, .unit-size, [id*='unitSize']");
  if (unitString && unitString.innerText) {
    return unitString.innerText.trim().replace(/^\/\s*/, "");
  }
  const unitText = document.querySelector('span[itemprop="unitText"]');
  if (unitText && unitText.innerText) {
    return unitText.innerText.trim().replace(/^\/\s*/, "");
  }
  return "Each";
}

/**
 * Merge JSON-LD extraction with optional DOM title/unit hints.
 * @param {object|null} exResult - from QuartzyExtractionService.run()
 * @param {{ h1: string, unitFromDom: string, catalog: string, price: string, vendor: string }} o
 */
function mergeProductFields(exResult, o) {
  const exf = (exResult && exResult.fields) || {};
  const h1 = o.h1 || "";
  const clean = typeof QuartzyExtractionService !== "undefined" ? QuartzyExtractionService.cleanProductText.bind(QuartzyExtractionService) : function (t) { return t; };

  const itemName =
    (isNonEmptyTrim(exf.itemName) ? exf.itemName : "") ||
    (h1 ? clean(h1) : "") ||
    "";
  let unitSize = isNonEmptyTrim(exf.unitSize) ? exf.unitSize : "";
  if (!unitSize && o.unitFromDom != null && o.unitFromDom !== "") {
    unitSize = clean(String(o.unitFromDom));
  }
  if (!unitSize && o.unitFromDom) {
    unitSize = String(o.unitFromDom);
  }
  return {
    catalogNumber: o.catalog,
    price: o.price,
    itemName,
    unitSize,
    url: window.location.href,
    vendor: o.vendor
  };
}

function isNonEmptyTrim(s) {
  return typeof s === "string" && s.trim().length > 0;
}

/**
 * Explains the first pass (mergeProductFields) before post-LD merge, saved-DOM, or this-session wand.
 * @param {object} merged0
 * @param {object} ex
 * @param {string} h1
 * @param {string} uDom
 */
function computeHeuristicProvenance(merged0, ex, h1, uDom) {
  const p = { itemName: "—", catalogNumber: "—", price: "—", unitSize: "—" };
  const clean =
    typeof QuartzyExtractionService !== "undefined"
      ? QuartzyExtractionService.cleanProductText.bind(QuartzyExtractionService)
      : function (t) {
          return t;
        };
  const ef = (ex && ex.fields) || {};
  const fs = (ex && ex.fieldSources) || { itemName: null, catalogNumber: null, price: null, unitSize: null };
  const h1c = h1 ? clean(String(h1).trim()) : "";

  if (isNonEmptyTrim(ef.itemName)) {
    p.itemName = fs.itemName ? "JSON-LD / UCP: " + fs.itemName : "JSON-LD / UCP: product name";
  } else if (isNonEmptyTrim(merged0.itemName)) {
    p.itemName =
      h1c && clean(String(merged0.itemName)) === h1c
        ? "Page: first <h1> or <title> segment (before |), if JSON-LD has no name"
        : "Page: document title segment (e.g. before | in <title>)";
  }

  if (isNonEmptyTrim(ef.catalogNumber)) {
    p.catalogNumber = fs.catalogNumber
      ? "JSON-LD / UCP: " + fs.catalogNumber
      : "JSON-LD / UCP: SKU, catalog #, or GTIN";
  }

  if (isNonEmptyTrim(ef.price)) {
    p.price = fs.price ? "JSON-LD / UCP: " + fs.price : "JSON-LD / UCP: price / offer";
  }

  if (isNonEmptyTrim(ef.unitSize)) {
    p.unitSize = fs.unitSize ? "JSON-LD / UCP: " + fs.unitSize : "JSON-LD / UCP: unit or pack size";
  } else if (isNonEmptyTrim(merged0.unitSize) && (uDom != null && uDom !== "")) {
    p.unitSize =
      uDom && String(uDom).toLowerCase() !== "each"
        ? "Generic: DOM (classes like .unit_string, [itemprop=unitText], etc.)"
        : "Default: 'Each' and generic size hints (no unit in JSON-LD)";
  }

  return p;
}

function vendorLabel() {
  const h = (window.location.hostname || "").toLowerCase();
  if (!h) return "Unknown vendor";
  return h.replace(/^www\./, "");
}

/**
 * "Big four" are missing in the first-pass merged capture (JSON-LD + h1 + simple DOM).
 */
function hasBigFourGap(merged) {
  return CAPTURE_FIELD_KEYS.some((k) => !isNonEmptyTrim(merged[k]));
}

function hasProductVariantInScope() {
  const d = document;
  const root = d.querySelector("main, #product-details, body") || d.body;
  if (!root) return false;
  return (
    root.querySelector(
      'input[type="radio"]:checked, input[type="checkbox"]:checked'
    ) != null
  );
}

/**
 * After mergeProductFields: when `ai` is null, pass-through of merged + JSON-LD field sources.
 * When AI is enabled, JSON-LD (ef) is still the source of truth for name and catalog when set; AI fills gaps
 * and can prefer price/unit when contextText contains [USER_SELECTED_OPTION] (from ContextService).
 * @param {object} merged - first pass from mergeProductFields
 * @param {object} fieldSources
 * @param {object} ex - full extraction result
 * @param {object|null} ai - { itemName, catalogNumber, price, unitSize }
 * @param {string} contextText
 */
function mergeExtractionWithPostLd(merged, fieldSources, ex, ai, contextText) {
  const exSrc = (ex && ex.fieldSources) || { itemName: null, catalogNumber: null, price: null, unitSize: null };
  const ef = (ex && ex.fields) || { itemName: "", catalogNumber: "", price: "", unitSize: "" };
  const hasMarker = (contextText || "").indexOf("[USER_SELECTED_OPTION]") >= 0;
  const m = { ...merged };
  const src = { ...fieldSources };
  const aiR = { itemName: false, catalogNumber: false, price: false, unitSize: false };
  if (!ai) {
    return { merged: m, fieldSources: src, aiRefined: aiR };
  }

  if (isNonEmptyTrim(ef.itemName)) {
    m.itemName = ef.itemName;
    if (exSrc.itemName) {
      src.itemName = exSrc.itemName;
    }
  } else if (isNonEmptyTrim(ai.itemName) && !isNonEmptyTrim(merged.itemName)) {
    m.itemName = ai.itemName;
    src.itemName = "ai-fallback";
    aiR.itemName = true;
  }

  if (isNonEmptyTrim(ef.catalogNumber)) {
    m.catalogNumber = ef.catalogNumber;
    if (exSrc.catalogNumber) {
      src.catalogNumber = exSrc.catalogNumber;
    }
  } else if (isNonEmptyTrim(ai.catalogNumber) && !isNonEmptyTrim(merged.catalogNumber)) {
    m.catalogNumber = ai.catalogNumber;
    src.catalogNumber = "ai-fallback";
    aiR.catalogNumber = true;
  }

  if (hasMarker) {
    if (isNonEmptyTrim(ai.price)) {
      m.price = ai.price;
      src.price = "ai-fallback";
      aiR.price = true;
    }
    if (isNonEmptyTrim(ai.unitSize)) {
      m.unitSize = ai.unitSize;
      src.unitSize = "ai-fallback";
      aiR.unitSize = true;
    }
  } else {
    if (!isNonEmptyTrim(ef.price) && isNonEmptyTrim(ai.price)) {
      m.price = ai.price;
      src.price = "ai-fallback";
      aiR.price = true;
    }
    const onlyGenericUnit = merged.unitSize === "Each" && !isNonEmptyTrim(ef.unitSize);
    if (!isNonEmptyTrim(ef.unitSize) && isNonEmptyTrim(ai.unitSize) && (!isNonEmptyTrim(merged.unitSize) || onlyGenericUnit)) {
      m.unitSize = ai.unitSize;
      src.unitSize = "ai-fallback";
      aiR.unitSize = true;
    }
  }
  return { merged: m, fieldSources: src, aiRefined: aiR };
}

function displayCaptureFields() {
  const o = { ...captureAutomated };
  CAPTURE_FIELD_KEYS.forEach((k) => {
    if (userTouched[k] && isNonEmptyTrim(userValues[k])) o[k] = userValues[k];
  });
  return o;
}

function fieldSourcesForUi() {
  const s = { ...exFieldSources };
  CAPTURE_FIELD_KEYS.forEach((k) => {
    if (userTouched[k]) s[k] = "magic-wand";
  });
  return s;
}

function aiRefinedForUi() {
  const a = { ...exAiRefined };
  CAPTURE_FIELD_KEYS.forEach((k) => {
    if (userTouched[k]) a[k] = false;
  });
  return a;
}

function applyExtractionSnapshot(merged, fieldSources, aiRefined) {
  captureAutomated = {
    itemName: (merged && merged.itemName) || "",
    catalogNumber: (merged && merged.catalogNumber) || "",
    price: (merged && merged.price) || "",
    unitSize: (merged && merged.unitSize) || ""
  };
  exFieldSources = fieldSources
    ? { ...fieldSources }
    : { itemName: null, catalogNumber: null, price: null, unitSize: null };
  exAiRefined = aiRefined
    ? { ...aiRefined }
    : { itemName: false, catalogNumber: false, price: false, unitSize: false };
}

function resetCaptureState() {
  CAPTURE_FIELD_KEYS.forEach((k) => {
    userTouched[k] = false;
    userValues[k] = "";
  });
  captureAutomated = { itemName: "", catalogNumber: "", price: "", unitSize: "" };
  exFieldSources = { itemName: null, catalogNumber: null, price: null, unitSize: null };
  exAiRefined = { itemName: false, catalogNumber: false, price: false, unitSize: false };
  lastHeuristicProvenance = { itemName: "—", catalogNumber: "—", price: "—", unitSize: "—" };
}

function normalizeWandValue(field, raw) {
  const t = (raw || "").trim();
  if (!t) return "";
  if (field === "price") {
    if (/\$|€|£/.test(t) || /USD/i.test(t)) return t;
    const n = parseFloat(t.replace(/[^0-9.]/g, ""));
    if (!Number.isNaN(n)) {
      return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
    }
  }
  if (typeof QuartzyExtractionService !== "undefined") {
    return QuartzyExtractionService.cleanProductText(t);
  }
  return t;
}

function enrichCaptureDataForDebug(data) {
  data.heuristicProvenance = { ...lastHeuristicProvenance };
  if (typeof QuartzyDomFieldHints !== "undefined" && typeof QuartzyDomFieldHints.getStoredHintsForDebug === "function") {
    data.domHintSelectors = QuartzyDomFieldHints.getStoredHintsForDebug();
  } else {
    data.domHintSelectors = { itemName: null, catalogNumber: null, price: null, unitSize: null };
  }
  return data;
}

function pushCaptureProgress(overrides) {
  const o = Object.assign(
    {
      capturePhase: "working",
      statusMessage: "Processing…"
    },
    overrides || {}
  );
  const data = {
    ...displayCaptureFields(),
    url: window.location.href,
    vendor: vendorLabel(),
    fieldSources: fieldSourcesForUi(),
    aiRefined: aiRefinedForUi(),
    isLoading: true,
    capturePhase: o.capturePhase,
    statusMessage: o.statusMessage
  };
  enrichCaptureDataForDebug(data);
  chrome.runtime.sendMessage({ type: "PRODUCT_CAPTURE", data });
}

function broadcastCurrentCapture(overrides) {
  const data = {
    ...displayCaptureFields(),
    url: window.location.href,
    vendor: vendorLabel(),
    fieldSources: fieldSourcesForUi(),
    aiRefined: aiRefinedForUi(),
    isLoading: false,
    capturePhase: "complete",
    statusMessage:
      "Done. Changing radios, table options, or the URL re-reads JSON-LD and per-site wands. Use a wand to map any field that still needs text (wait for this message and spinner off)."
  };
  if (overrides) {
    Object.assign(data, overrides);
  }
  if (overrides && "isLoading" in overrides) {
    data.isLoading = overrides.isLoading;
  } else {
    data.isLoading = false;
  }
  enrichCaptureDataForDebug(data);
  chrome.runtime.sendMessage({ type: "PRODUCT_CAPTURE", data });
}

function applyAndBroadcastProduct(merged, fieldSources, aiRefined) {
  applyExtractionSnapshot(merged, fieldSources, aiRefined);
  broadcastCurrentCapture();
}

function startWandForField(key) {
  if (!WAND_FIELD_SET[key]) return false;
  if (typeof QuartzySelectionMode === "undefined" || !QuartzySelectionMode.start) {
    return false;
  }
  if (typeof QuartzySelectionMode.isActive === "function" && QuartzySelectionMode.isActive()) {
    return false;
  }
  QuartzySelectionMode.start(key, {
    onCapture: (text, range) => {
      const v = normalizeWandValue(key, text);
      if (!v) return;
      if (typeof QuartzyDomFieldHints !== "undefined" && typeof QuartzyDomFieldHints.saveWandTarget === "function") {
        try {
          QuartzyDomFieldHints.saveWandTarget(key)(v, range);
        } catch (e) {
          /* ignore */
        }
      }
      userTouched[key] = true;
      userValues[key] = v;
      exAiRefined[key] = false;
      captureAutomated = { ...captureAutomated, [key]: v };
      broadcastCurrentCapture();
    }
  });
  return true;
}

function emitBlankCapture() {
  let merged = { itemName: "", catalogNumber: "", price: "", unitSize: "" };
  let fieldSources = { itemName: null, catalogNumber: null, price: null, unitSize: null };
  let aiR = { itemName: false, catalogNumber: false, price: false, unitSize: false };
  lastHeuristicProvenance = {
    itemName: "No structured pass (extraction module missing or failed).",
    catalogNumber: "No structured pass (extraction module missing or failed).",
    price: "No structured pass (extraction module missing or failed).",
    unitSize: "No structured pass (extraction module missing or failed)."
  };
  if (typeof QuartzyDomFieldHints !== "undefined" && typeof QuartzyDomFieldHints.applySavedHints === "function") {
    const w = QuartzyDomFieldHints.applySavedHints(merged, fieldSources, normalizeWandValue);
    merged = w.merged;
    fieldSources = w.fieldSources;
    CAPTURE_FIELD_KEYS.forEach((f) => {
      if (fieldSources[f] === "dom-hint") aiR[f] = false;
    });
  }
  applyExtractionSnapshot(merged, fieldSources, aiR);
  const hasAny = CAPTURE_FIELD_KEYS.some((k) => isNonEmptyTrim(merged[k]));
  broadcastCurrentCapture({
    statusMessage: hasAny
      ? "No JSON-LD on this page, but saved wands for this site filled some fields from the page."
      : "No structured data was found. Use a wand to select the text for each field you need on the product page."
  });
}

/**
 * @param {string} raw
 * @returns {string}
 */
function normalizePriceForPanel(raw) {
  if (raw == null) return "";
  if (typeof QuartzyExtractionService !== "undefined") {
    return QuartzyExtractionService.normalizePrice(raw);
  }
  const t = String(raw).trim();
  if (!t) return "";
  if (/\$|€|£/.test(t)) return t;
  const n = parseFloat(t.replace(/[^0-9.]/g, ""));
  if (!Number.isNaN(n)) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
  }
  return t;
}

/**
 * Reads price / pack line from the DOM around the selected radio (JSON-LD often stays on a default offer).
 * @returns {{ price?: string, unitSize?: string }|null}
 */
function scrapeSelectedRadioGroupVariant() {
  const r = document.querySelector(
    'main input[type="radio"]:checked, #content input[type="radio"]:checked, #product-details input[type="radio"]:checked, [class*="product"] input[type="radio"]:checked, body input[type="radio"]:checked'
  );
  if (!r) {
    return null;
  }
  let el = r;
  for (let depth = 0; depth < 10 && el; depth++) {
    const text = (el.innerText || "").replace(/\s+/g, " ").trim();
    if (text.length > 8 && text.length < 4000) {
      const pricePart = text.match(/\$[\d,]+(?:\.\d{2})?/);
      if (pricePart) {
        const unitM =
          text.match(
            /Case of \d+[\s\u00A0]*EA|Case of \d+(?:\s*each)?|(?:(?:\d+|\d+\s*\/\s*\d+))\s*tests?|\b\d{1,4}[\s\u00A0]+(?:mL|L|mG|G|g|ug|μL|uL)\b|\bEach\b|\/\s*Each|\/\s*Case|pack of \d+/i
          ) || text.match(/(?:(?:Bottle|Vial|Case|Box|Unit|cs|pk|ea)\b[^.]{0,24})/i);
        return {
          price: pricePart[0],
          unitSize: unitM ? String(unitM[0]).replace(/\s+/g, " ").trim() : ""
        };
      }
    }
    el = el.parentElement;
  }
  return null;
}

/**
 * @param {string} h
 * @returns {"price"|"catalog"|"size"|"product"|"quantity"|"ignore"}
 */
function classifyTableHeaderText(h) {
  const s = h.replace(/\s+/g, " ").trim().toLowerCase();
  if (!s) {
    return "ignore";
  }
  if (/\b(save|haz|lot|shelf|ship|view|conjugate|formulation|add to cart|availability|check|delete)\b/i.test(s)) {
    return "ignore";
  }
  if (
    s === "price" ||
    s.indexOf("price/") === 0 ||
    s.indexOf("list") === 0 ||
    s.indexOf("u.p.") === 0 ||
    /^ea\.?$|each$/i.test(s)
  ) {
    return "price";
  }
  if (/\b(cat(alog)?( #| num| number)?|mfr( #| number)?|sku|item #|part( #| number)?|#)\b/i.test(s) && !/name|title|desc|product name/i.test(s)) {
    return "catalog";
  }
  if (/\b(size|uom|pack(?!ing)|format|content|container|unit size|volume|amount)\b/i.test(s)) {
    return "size";
  }
  if (/\b(product|name|item|description|title)\b/i.test(s) && !/shelf|haz/i.test(s)) {
    return "product";
  }
  if (/^qty$|^qtd$|quantity|order\s*qty|^\#$/i.test(s)) {
    return "quantity";
  }
  return "ignore";
}

/**
 * @param {HTMLTableElement} table
 * @returns {string[]|null} lowercased header labels per column, or null
 */
function getTableHeaderLabelStrings(table) {
  let row = null;
  if (table.tHead && table.tHead.rows[0]) {
    row = table.tHead.rows[0];
  } else {
    row = table.querySelector("thead tr");
  }
  if (!row) {
    const r0 = table.rows[0];
    if (r0 && r0.getElementsByTagName("th").length) {
      row = r0;
    }
  }
  if (!row) {
    return null;
  }
  return Array.prototype.map
    .call(row.querySelectorAll("th, td"), function (c) {
      return (c.innerText || c.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
    })
    .filter(function (_, i) {
      return i < 20;
    });
}

/**
 * @param {HTMLTableRowElement} tr
 * @returns {object} partial { itemName?, catalogNumber?, price?, unitSize? }
 */
function extractFromTableRow(tr) {
  const out = { itemName: "", catalogNumber: "", price: "", unitSize: "" };
  if (!tr || tr.closest("thead")) {
    return out;
  }
  if (!tr.querySelector("td")) {
    return out;
  }
  const table = tr.closest("table");
  if (!table) {
    return out;
  }
  const headerLabels = getTableHeaderLabelStrings(table);
  const cells = tr.querySelectorAll("td");
  if (!cells.length) {
    return out;
  }

  const byCol = function () {
    if (!headerLabels || headerLabels.length < 1) {
      return false;
    }
  const n = Math.min(cells.length, headerLabels.length);
  let got = 0;
  for (let i = 0; i < n; i++) {
    const h = headerLabels[i];
    const colKind = classifyTableHeaderText(h);
    if (colKind === "ignore" || colKind === "quantity") {
      continue;
    }
    const cellText = (cells[i].innerText || cells[i].textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!isNonEmptyTrim(cellText) || (isNonEmptyTrim(cellText) && cellText.length > 500)) {
      continue;
    }
    if (colKind === "price" && /[\$€£]/.test(cellText)) {
      out.price = normalizePriceForPanel(cellText.split(/\s/)[0].match(/[\$€£][\d,]+(?:\.\d{2})?/) ? cellText.match(/[\$€£][\d,]+(?:\.\d{2})?/)[0] : cellText);
        got += 1;
    } else if (colKind === "catalog" && /[0-9A-Za-z-]{3,}/.test(cellText)) {
        const line = cellText.split(/\n/)[0].trim();
        const sku = line.match(/[A-Z0-9][A-Z0-9._/-]{2,32}/i);
        out.catalogNumber = sku ? sku[0] : line.slice(0, 40);
        got += 1;
    } else if (colKind === "size" || colKind === "product") {
        const t = cellText.split(/\n/).map(function (x) { return x.trim(); }).filter(Boolean).join(" · ");
        if (colKind === "size") {
          out.unitSize = t;
        } else {
          out.itemName = t;
        }
        if (t) got += 1;
      }
    }
  return got > 0;
  };

  const heur = function (full) {
  const p = full.match(/[\$€£][\d,]+(?:\.\d{2})?/);
  if (p) {
    out.price = normalizePriceForPanel(p[0]);
  }
  const sizeLike = full.match(
    /(?:\d+|\d+\s*\/\s*\d+)\s*(?:mL|L|G|g|ug|μg|mg|tests?)\b|Case of \d+[^.\n]{0,18}|^Each$|\d+\s*x\s*\d+|\b\d+[\s\u00A0]*L\b|Cubitainer|bottle|vial/i
  );
  if (sizeLike) {
    out.unitSize = sizeLike[0].replace(/\s+/g, " ").trim();
  }
  const numWords = full.split(/[\s\n,|]+/).filter(function (w) { return w.length; });
  for (let w = 0; w < Math.min(numWords.length, 4); w++) {
    if (/^\d{3,}$|^[A-Z0-9][A-Z0-9._-]{2,20}$/i.test(numWords[w]) && !/^\$/.test(numWords[w])) {
      if (!isNonEmptyTrim(out.catalogNumber)) {
        out.catalogNumber = numWords[w];
      }
      break;
    }
  }
  };

  if (!byCol()) {
    const full = tr.innerText.replace(/\s+/g, " ").trim();
    if (full.length < 3 || full.length > 5000) {
      return out;
    }
    heur(full);
  } else {
    const full2 = tr.innerText.replace(/\s+/g, " ").trim();
    if (
      !isNonEmptyTrim(out.price) ||
      !isNonEmptyTrim(out.unitSize) ||
      !isNonEmptyTrim(out.catalogNumber)
    ) {
      heur(full2);
    }
  }
  if (isNonEmptyTrim(out.price) && !/[\$€£]/.test(String(out.price))) {
    out.price = normalizePriceForPanel(out.price);
  }
  return out;
}

function tableRowExtractionIsUseful(partial) {
  const hasPrice = isNonEmptyTrim(partial.price);
  const hasCat = isNonEmptyTrim(partial.catalogNumber);
  const hasSize = isNonEmptyTrim(partial.unitSize);
  const hasName = isNonEmptyTrim(partial.itemName);
  const score = (hasPrice ? 2 : 0) + (hasCat ? 1 : 0) + (hasSize ? 1 : 0) + (hasName ? 1 : 0);
  return score >= 2 || (hasPrice && (hasSize || hasCat)) || (hasCat && hasSize);
}

/**
 * Merges a clicked table row into the live capture. Clears per-field session wand for overridden keys.
 * @param {object} partial
 */
function applyTableRowVariantToCapture(partial) {
  const m = { ...captureAutomated };
  const src = { ...exFieldSources };
  const ar = { ...exAiRefined };
  const keys = ["itemName", "catalogNumber", "price", "unitSize"];
  keys.forEach((k) => {
    if (isNonEmptyTrim(partial[k])) {
      m[k] = k === "price" ? normalizePriceForPanel(partial[k]) : String(partial[k]).trim();
      if (k === "price" && !isNonEmptyTrim(m[k])) {
        m[k] = String(partial[k]).trim();
      }
      src[k] = "table-row";
      ar[k] = false;
      userTouched[k] = false;
      userValues[k] = "";
    }
  });
  exFieldSources = src;
  exAiRefined = ar;
  captureAutomated = m;
  console.log("[Quartzy Bridge] Table row selection applied to capture");
  broadcastCurrentCapture();
}

/**
 * @param {HTMLTableRowElement} tr
 * @param {EventTarget} target
 * @returns {boolean} true if this click was treated as a variant row (skip debounced re-run)
 */
function tryApplyTableRowAsVariant(tr, target) {
  if (!tr || !tr.querySelector("td") || tr.closest("thead")) {
    return false;
  }
  if (target && target.nodeName && String(target.nodeName).toLowerCase() === "a" && isLikelyOffPageLink(target)) {
    return false;
  }
  const partial = extractFromTableRow(tr);
  if (!tableRowExtractionIsUseful(partial)) {
    return false;
  }
  applyTableRowVariantToCapture(partial);
  return true;
}

/**
 * @param {object} merged
 * @param {object} fieldSources
 * @param {object} aiR
 */
function mergeSelectedRadioVariantInto(merged, fieldSources, aiR) {
  const v = scrapeSelectedRadioGroupVariant();
  if (!v) {
    return;
  }
  if (isNonEmptyTrim(v.price)) {
    merged.price = normalizePriceForPanel(v.price);
    fieldSources.price = "variant-dom";
    if (aiR) aiR.price = false;
  }
  if (isNonEmptyTrim(v.unitSize)) {
    merged.unitSize = v.unitSize;
    fieldSources.unitSize = "variant-dom";
    if (aiR) aiR.unitSize = false;
  }
}

let qzRunChain = Promise.resolve();
function run() {
  if (typeof QuartzyExtractionService === "undefined") {
    emitBlankCapture();
    return;
  }
  qzRunChain = qzRunChain
    .then(function () {
      return doCaptureRun();
    })
    .catch(function (e) {
      console.warn("[Quartzy Bridge] Capture chain error:", e && e.message);
    });
}
async function doCaptureRun() {
  try {
    lastHeuristicProvenance = { itemName: "—", catalogNumber: "—", price: "—", unitSize: "—" };
    pushCaptureProgress({
      capturePhase: "json-ld",
      statusMessage: "Reading JSON-LD, UCP, .well-known, and generic DOM hints. Saved per-site wands are applied after this pass."
    });
    const ex = await QuartzyExtractionService.run(document);
    const h1 = document.querySelector("h1")?.innerText?.trim() || document.title.split("|")[0].trim() || "";
    const ef = (ex && ex.fields) || {};
    const catalogFromEx = isNonEmptyTrim(ef.catalogNumber) ? ef.catalogNumber : "";
    const priceFromEx = isNonEmptyTrim(ef.price) ? ef.price : "";
    const uDom = extractUnitSize();
    const merged0 = mergeProductFields(ex, {
      h1,
      unitFromDom: uDom,
      catalog: catalogFromEx,
      price: priceFromEx,
      vendor: vendorLabel()
    });
    lastHeuristicProvenance = computeHeuristicProvenance(merged0, ex, h1, uDom);
    let fieldSources = { ...((ex && ex.fieldSources) || { itemName: null, catalogNumber: null, price: null, unitSize: null }) };
    const needAi =
      USE_AI_EXTRACTION && (hasBigFourGap(merged0) || hasProductVariantInScope());
    let ctx = "";
    let ai = null;
    if (needAi && typeof QuartzyContextService !== "undefined" && typeof QuartzyAIExtractionService !== "undefined") {
      ctx = QuartzyContextService.getProductContextText(document) || "";
      if (ctx.length >= 10) {
        try {
          pushCaptureProgress({
            capturePhase: "ai",
            statusMessage: "AI fallback: reading page (selected variant, prices, and missing fields)…"
          });
          ai = await QuartzyAIExtractionService.extractProductFromContext(ctx);
        } catch (e) {
          console.log("[Quartzy Bridge] AI extraction failed:", e && e.message);
        }
      }
    }
    const mres = mergeExtractionWithPostLd(merged0, fieldSources, ex, ai, ctx);
    let merged = mres.merged;
    fieldSources = mres.fieldSources;
    let aiR = mres.aiRefined;
    mergeSelectedRadioVariantInto(merged, fieldSources, aiR);
    /* Per-site saved wand selectors override merged fields; session wand is applied in displayCaptureFields. */
    if (typeof QuartzyDomFieldHints !== "undefined" && typeof QuartzyDomFieldHints.applySavedHints === "function") {
      const withHints = QuartzyDomFieldHints.applySavedHints(merged, fieldSources, normalizeWandValue);
      merged = withHints.merged;
      fieldSources = withHints.fieldSources;
      CAPTURE_FIELD_KEYS.forEach((f) => {
        if (fieldSources[f] === "dom-hint") {
          aiR[f] = false;
        }
      });
    }
    applyAndBroadcastProduct(merged, fieldSources, aiR);
  } catch (err) {
    console.warn("[Quartzy Bridge] Extraction on page failed:", err && err.message);
    emitBlankCapture();
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "TRIGGER_SCRAPE") {
    console.log("[Quartzy Bridge] Re-scrape triggered by navigation.");
    resetCaptureState();
    run();
  }

  if (message.type === "WAND_START" && message.field) {
    const started = startWandForField(String(message.field));
    sendResponse({ success: started });
    return;
  }
});

run();

/**
 * Clicks on links that leave the page (or new tab) should not trigger a variant re-capture.
 * @param {EventTarget|null} t
 * @returns {boolean}
 */
function isLikelyOffPageLink(t) {
  if (!t || !t.closest) {
    return false;
  }
  const a = t.closest("a[href]");
  if (!a) {
    return false;
  }
  if (a.target === "_blank" || a.download) {
    return true;
  }
  const href = a.getAttribute("href");
  if (!href || !String(href).trim() || href.charAt(0) === "#") {
    return false;
  }
  try {
    const u = new URL(a.href, location.href);
    if (u.origin !== location.origin) {
      return true;
    }
  } catch (e) {
    /* ignore */
  }
  return false;
}

/**
 * @param {Event} e
 */
function onDocumentChangeForVariantOrOption(e) {
  const t = e.target;
  if (!t || t.nodeName === "TEXTAREA") {
    return;
  }
  if (t.nodeName === "SELECT") {
    scheduleCaptureRerun();
    return;
  }
  if (t.nodeName === "INPUT") {
    const type = (t.type || "").toLowerCase();
    if (type === "radio" || type === "checkbox") {
      scheduleCaptureRerun();
    }
  }
}

/**
 * Table rows, ARIA options, and tabs that are not native inputs.
 * @param {Event} e
 */
function onDocumentClickMaybeVariantOrOption(e) {
  if (e.button !== 0) {
    return;
  }
  if (isLikelyOffPageLink(e.target)) {
    return;
  }
  const t = e.target;
  if (!t || !t.closest) {
    return;
  }
  const tr = t.closest("tr");
  if (tr) {
    const table = tr.closest("table");
    if (table && !tr.closest("thead")) {
      if (tryApplyTableRowAsVariant(tr, t)) {
        return;
      }
    }
  }
  if (t.closest("tr, [role='row'], [role='radio'], [role='option'], [role='tab']")) {
    scheduleCaptureRerun();
  }
}

document.addEventListener("change", onDocumentChangeForVariantOrOption, true);
window.addEventListener("popstate", function () {
  scheduleCaptureRerun();
}, false);
window.addEventListener("hashchange", function () {
  scheduleCaptureRerun();
}, false);
document.addEventListener("click", onDocumentClickMaybeVariantOrOption, true);

/* Fisher and similar sites often insert application/ld+json in a follow-up pass; re-run once and watch for that script. */
(function scheduleJsonLdFollowups() {
  if (document.readyState === "complete") {
    setTimeout(function () {
      void run();
    }, 2500);
  } else {
    window.addEventListener("load", function onLoad() {
      window.removeEventListener("load", onLoad);
      setTimeout(function () {
        void run();
      }, 2500);
    });
  }
  if (typeof MutationObserver === "undefined" || !document.documentElement) {
    return;
  }
  const obs = new MutationObserver(function (muts) {
    for (let i = 0; i < muts.length; i++) {
      const m = muts[i];
      for (let j = 0; j < m.addedNodes.length; j++) {
        if (qzcNodeMayAddJsonLd(m.addedNodes[j])) {
          scheduleCaptureRerun();
          return;
        }
      }
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
})();

function qzcNodeMayAddJsonLd(n) {
  if (!n || n.nodeType !== 1) {
    return false;
  }
  if (n.nodeName === "SCRIPT" && n.getAttribute && n.getAttribute("type") === "application/ld+json") {
    return true;
  }
  if (n.querySelector) {
    return n.querySelector('script[type="application/ld+json"]') != null;
  }
  return false;
}
