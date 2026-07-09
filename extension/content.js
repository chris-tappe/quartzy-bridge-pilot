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

/**
 * Last good {@link extractFromTableRow} result. Re-applied at the end of {@link doCaptureRun} so a
 * debounced JSON-LD pass does not overwrite row-driven price / unit (e.g. 25ul vs 0.1 ml option rows)
 * with global heuristics like a single page-wide "1 ml".
 * Cleared in {@link resetCaptureState} (e.g. navigation).
 * @type {{ itemName: string, catalogNumber: string, price: string, unitSize: string }|null}
 */
let lastTableRowExtract = null;

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
  lastTableRowExtract = null;
  captureAutomated = { itemName: "", catalogNumber: "", price: "", unitSize: "" };
  exFieldSources = { itemName: null, catalogNumber: null, price: null, unitSize: null };
  exAiRefined = { itemName: false, catalogNumber: false, price: false, unitSize: false };
  lastHeuristicProvenance = { itemName: "—", catalogNumber: "—", price: "—", unitSize: "—" };
}

function normalizeWandValue(field, raw) {
  let t = (raw || "").trim();
  if (!t) return "";
  if (field === "catalogNumber") {
    t = t.replace(/^#+\s*/, "");
  }
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
  /* Allow re-arming for a different field (e.g. Mapping Mode advancing through fields). */
  if (typeof QuartzySelectionMode.isActive === "function" && QuartzySelectionMode.isActive()) {
    if (typeof QuartzySelectionMode.stop === "function") {
      QuartzySelectionMode.stop();
    }
  }
  QuartzySelectionMode.start(key, {
    onCapture: (text, range) => {
      let toNormalize = (text || "").trim();
      if (typeof QuartzyDomFieldHints !== "undefined" && typeof QuartzyDomFieldHints.saveWandTarget === "function") {
        try {
          const expanded = QuartzyDomFieldHints.saveWandTarget(key)(text, range);
          if (isNonEmptyTrim(expanded)) {
            toNormalize = String(expanded).trim();
          }
        } catch (e) {
          /* ignore */
        }
      }
      const v = normalizeWandValue(key, toNormalize);
      if (!v) return;
      userTouched[key] = true;
      userValues[key] = v;
      exAiRefined[key] = false;
      captureAutomated = { ...captureAutomated, [key]: v };
      broadcastCurrentCapture();
      try {
        chrome.runtime.sendMessage({ type: "WAND_CAPTURED", field: key, value: v });
      } catch (e) {
        /* side panel may be closed; non-fatal */
      }
    }
  });
  return true;
}

function stopActiveWand() {
  if (typeof QuartzySelectionMode === "undefined") return false;
  if (typeof QuartzySelectionMode.isActive === "function" && !QuartzySelectionMode.isActive()) {
    return false;
  }
  if (typeof QuartzySelectionMode.stop === "function") {
    QuartzySelectionMode.stop();
    return true;
  }
  return false;
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
 * Smallest row-like container for one radio option. Walking the whole &lt;ul&gt; or buy box
 * merges every option’s price — we need only the checked control’s line (e.g. one &lt;li&gt; or &lt;tr&gt;).
 * @param {HTMLInputElement} r
 * @returns {Element|null}
 */
function getRadioVariantRowScope(r) {
  if (!r || r.nodeName !== "INPUT" || (r.type || "").toLowerCase() !== "radio") {
    return null;
  }
  return (
    r.closest("li") ||
    r.closest("tr, [role=row]") ||
    (r.labels && r.labels[0] ? r.labels[0] : null) ||
    r.closest("label")
  ) || (function notUlParent() {
    const p = r.parentElement;
    if (p && p.nodeName && String(p.nodeName).toLowerCase() === "ul") {
      return null;
    }
    return p;
  })();
}

/**
 * Fisher promo UI: .webprice-container has a strikethrough list price then .kmd-text-display-5 for the sale line.
 * Schema.org b[itemprop=price] may be missing or may refer to the old price, so we prefer the display-5 number.
 * @param {Element} inEl
 * @returns {string} normalized display price
 */
function readWebpriceContainerSalePriceInScope(inEl) {
  if (!inEl || !inEl.querySelector) {
    return "";
  }
  const wpc = inEl.querySelector(".webprice-container");
  if (!wpc) {
    return "";
  }
  const saleEls = wpc.querySelectorAll(
    "span.kmd-text-display-5, [class*=\"kmd-text-display-\"], span.kmd-text--display-5"
  );
  for (let s = 0; s < saleEls.length; s++) {
    const el = saleEls[s];
    if (!el || !el.closest) {
      continue;
    }
    if (el.closest(".kmd-text-line-through, .kmd-line-through, [class*=\"line-through\"]")) {
      continue;
    }
    const raw = (el.textContent || "").trim();
    if (raw && /[$€£]/.test(raw)) {
      return normalizePriceForPanel(raw);
    }
  }
  return "";
}

/**
 * @param {Element} scope
 * @param {Element|null} [anchorInput] - if the buy box is wide, use the li/tr for this input only
 * @returns {string} normalized display price
 */
function readItempropPriceInScope(scope, anchorInput) {
  if (!scope || !scope.querySelector) {
    return "";
  }
  const row = anchorInput && anchorInput.closest ? anchorInput.closest("li, tr, [role=row]") : null;
  const inEl = row && (scope === row || scope.contains(row)) ? row : scope;
  const saleFromWpc = readWebpriceContainerSalePriceInScope(inEl);
  if (isNonEmptyTrim(saleFromWpc)) {
    return saleFromWpc;
  }
  const pEl = inEl.querySelector(
    'meta[itemprop="price"][content], b[itemprop="price"], [itemprop="price"]'
  );
  if (!pEl) {
    return "";
  }
  const c = pEl.getAttribute && pEl.getAttribute("content");
  if (c != null && String(c).replace(/\s/g, "") !== "") {
    const n = parseFloat(String(c).replace(/,/g, "").replace(/^\$*/, ""));
    if (!Number.isNaN(n)) {
      try {
        return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
      } catch (e) {
        return String(c);
      }
    }
  }
  const raw = (pEl.textContent || pEl.getAttribute("content") || "").trim();
  if (!raw) {
    return "";
  }
  return normalizePriceForPanel(raw);
}

/**
 * @param {Element} scope
 * @param {Element|null} [anchorInput]
 * @returns {string} unit or pack string
 */
/**
 * UOM in Fisher’s web price block: span.kmd-text-p with leading "/" (e.g. "/ Each", "/ Case of 96 EA").
 * Skip green discount lines like "34% Off" (kmd-text-green-50, or contains %).
 * @param {Element} inEl
 * @returns {string}
 */
function readWebpriceContainerUnitInScope(inEl) {
  if (!inEl || !inEl.querySelector) {
    return "";
  }
  const wpc = inEl.querySelector(".webprice-container");
  if (!wpc) {
    return "";
  }
  const ps = wpc.querySelectorAll("span.kmd-text-p, p.kmd-text-p");
  for (let i = 0; i < ps.length; i++) {
    const el = ps[i];
    if (el && el.classList && (el.classList.contains("kmd-text-green-50") || /Off\s*$/i.test((el.textContent || "").trim()))) {
      continue;
    }
    const t = (el && el.textContent ? el.textContent : "")
      .replace(/\s+/g, " ")
      .trim();
    if (!t) {
      continue;
    }
    if (/^\/\s*/.test(t) && !/^\s*\/\s*%/i.test(t) && t.indexOf("%") < 0) {
      return t.replace(/^\s*\/\s*/, "").trim();
    }
  }
  return "";
}

function readItempropUnitTextInScope(scope, anchorInput) {
  if (!scope || !scope.querySelector) {
    return "";
  }
  const row =
    anchorInput && anchorInput.closest ? anchorInput.closest("li, tr, [role=row]") : null;
  const inEl = row && (scope === row || scope.contains(row)) ? row : scope;
  const fromWpc = readWebpriceContainerUnitInScope(inEl);
  if (isNonEmptyTrim(fromWpc)) {
    return fromWpc;
  }
  const uEl = inEl.querySelector('span[itemprop="unitText"], [itemprop="unitText"]');
  if (!uEl) {
    return "";
  }
  return (uEl.textContent || "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Magento / STEMCELL-style swatches may have multiple checked super_attribute radios
 * (e.g. Platform + Size). Prefer the option that looks like pack size / UOM.
 * @returns {HTMLInputElement|null}
 */
function pickBestCheckedSwatchRadio() {
  const all = document.querySelectorAll(
    ".swatch-attribute input[type=radio]:checked, input[name^='super_attribute'][type=radio]:checked"
  );
  if (!all.length) {
    return null;
  }
  if (all.length === 1) {
    return all[0];
  }
  for (let i = 0; i < all.length; i++) {
    const r = all[i];
    let label = r.labels && r.labels[0];
    if (!label && r.id) {
      label = document.querySelector('label[for="' + r.id + '"]');
    }
    const t = ((label && label.textContent) || "").toLowerCase();
    if (/cells|\^|ml|mg|ug|μg|pack|size|each|test|\bvial\b|\bbottle\b/i.test(t)) {
      return r;
    }
  }
  return all[all.length - 1];
}

/**
 * Picks the checked UOM/variant by searching inside likely PDP **containers** first so we do
 * not return the first random :checked radio in the page (e.g. filters) when many groups exist.
 * @returns {HTMLInputElement|null}
 */
function queryCheckedUomRadio() {
  const strictUom = function (root) {
    if (!root || !root.querySelector) {
      return null;
    }
    return (
      root.querySelector("input.uom-input[type=radio]:checked") ||
      root.querySelector("ul.radio_list input[type=radio]:checked, ul.radio-list input[type=radio]:checked")
    );
  };
  const narrow = [
    document.getElementById("pricing_container"),
    document.getElementById("Pricing"),
    document.querySelector(".pricing_container"),
    document.querySelector(".product_add_to_cart"),
    document.querySelector("form[action*=\"cart\"]"),
    document.querySelector("variant-picker"),
    document.querySelector("fieldset.option-selector"),
    document.querySelector(".product-options-wrapper"),
    document.querySelector(".product-options-bottom")
  ];
  for (let i = 0; i < narrow.length; i++) {
    const c = strictUom(narrow[i]);
    if (c) {
      return c;
    }
    if (narrow[i] && narrow[i].querySelector) {
      const shopify =
        narrow[i].querySelector("input[type=radio].opt-btn:checked") ||
        narrow[i].querySelector("fieldset input[type=radio]:checked") ||
        narrow[i].querySelector("input[type=radio]:checked");
      if (shopify) {
        return shopify;
      }
    }
  }
  const uls = document.querySelectorAll("ul.radio_list, ul.radio-list");
  for (let u = 0; u < uls.length; u++) {
    const c = uls[u].querySelector("input[type=radio]:checked");
    if (c) {
      return c;
    }
  }
  const main = document.querySelector("main");
  if (main) {
    const c =
      strictUom(main) ||
      main.querySelector(
        "form[action*=\"cart\"] input[type=radio]:checked, " +
          "[itemtype*=\"Product\"] input[type=radio]:checked, " +
          "[itemscope] input.uom-input[type=radio]:checked, " +
          "[class*=\"pric\" i] input[type=radio]:checked, " +
          "[id*=\"pric\" i] input[type=radio]:checked, " +
          "[class*=\"uom\" i] input[type=radio]:checked"
      );
    if (c) {
      return c;
    }
  }
  return (
    pickBestCheckedSwatchRadio() ||
    document.querySelector("input.uom-input[type=radio]:checked") ||
    document.querySelector("form[action*=\"cart\"] input[type=radio]:checked") ||
    document.querySelector("variant-picker input[type=radio]:checked") ||
    document.querySelector("fieldset.option-selector input[type=radio]:checked") ||
    document.querySelector("fieldset input[type=radio].opt-btn:checked")
  );
}

/**
 * Reads price and unit for the *checked* radio only, using a per-option row scope
 * (e.g. one &lt;li&gt;) plus schema.org Offer fields when present — not the whole &lt;ul&gt;.
 * @returns {{ price?: string, unitSize?: string }|null}
 */
function scrapeSelectedAttributeButtonVariant() {
  const selected = document.querySelector(".attributeButton.selected");
  if (!selected) {
    return null;
  }
  const unitSize = (selected.innerText || selected.textContent || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!isNonEmptyTrim(unitSize)) {
    return null;
  }
  return { price: "", unitSize: unitSize };
}

function scrapeSelectedRadioGroupVariant() {
  const attr = scrapeSelectedAttributeButtonVariant();
  if (attr) {
    return attr;
  }
  const r = queryCheckedUomRadio();
  if (!r) {
    return null;
  }
  const scope = getRadioVariantRowScope(r);
  if (!scope) {
    return null;
  }
  const text = (scope.innerText || scope.textContent || "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < 2) {
    return null;
  }

  let price = readItempropPriceInScope(scope, r);
  let unitSize = readItempropUnitTextInScope(scope, r);

  if (!isNonEmptyTrim(unitSize)) {
    const optVal = scope.querySelector(".opt-value, [class*='opt-value']");
    if (optVal) {
      unitSize = (optVal.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
    }
  }
  if (!isNonEmptyTrim(unitSize)) {
    const swatchLbl = scope.querySelector("span.label, .label");
    if (swatchLbl) {
      unitSize = (swatchLbl.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
    }
  }
  if (!isNonEmptyTrim(unitSize) && scope.matches && scope.matches("label.radio_swatch, label.swatch-option")) {
    unitSize = text;
  }

  if (!isNonEmptyTrim(price)) {
    const s = String(text);
    const re = /[$€£][\d,]+(?:\.\d{2})?/g;
    let m;
    let pick = null;
    while ((m = re.exec(s)) !== null) {
      const before = s.slice(0, m.index);
      if (/\bSave\s*$/i.test(before)) {
        continue; /* e.g. "Save $9.20" in promo badge — not the SKU line price */
      }
      pick = m[0];
    }
    if (pick) {
      price = normalizePriceForPanel(pick);
    }
  }
  if (!isNonEmptyTrim(unitSize)) {
    const u =
      text.match(
        /Case of \d+[\s\u00A0]+EA|Case of \d+(?:\s*EA|\s*each)?|(?:(?:\d+|\d+\s*\/\s*\d+))\s*tests?|\b\d+\s*x\s*10[\^⁰¹²³⁴⁵⁶⁷⁸⁹\d]+\s*cells?\b|\b\d{1,4}[\s\u00A0]+(?:mL|L|mG|G|g|ug|μg|mg|μL|uL)\b|(?:(?:^|[^A-Za-z]))Each\b|\/\s*Each|\/\s*Case of[^%\n]+|pack of \d+/i
      ) || text.match(/[A-Za-z-]{2,}[\s/]+(?:Bottle|Vial|Cubitainer|box|cs|ea)\b/i);
    if (u) {
      unitSize = u[0].replace(/\s+/g, " ").replace(/^\/\s*/, "").trim();
    }
  }
  if (!isNonEmptyTrim(unitSize)) {
    if (/\bEach\b/i.test(text) && !/Case/i.test(text)) {
      unitSize = "Each";
    }
  }

  if (!isNonEmptyTrim(price) && !isNonEmptyTrim(unitSize)) {
    return null;
  }
  if (isNonEmptyTrim(price)) {
    return { price, unitSize: isNonEmptyTrim(unitSize) ? unitSize : "" };
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
  /* e.g. "Case Qty", "Pack/Case" — keep explicit; a lone "Pack" header must not become a "size" column. */
  if (/\bcase\s*qty|case\s*quant|cs\s*qty|pack\/\s*case|pack\s*size|units?\s*per(?:\s*case|\/pack)?|inner(?:\s*|\/)case|outer(?:\s*|\/)pack/i.test(s) && !/name|title|description|add\s*to/i.test(s)) {
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
 * Native &lt;table&gt; and ARIA grids (e.g. div[role=table]).
 * @param {Element} tableRoot
 * @returns {string[]|null}
 */
function getTableHeaderLabelStringsForGridRoot(tableRoot) {
  if (!tableRoot) {
    return null;
  }
  if (tableRoot.nodeName === "TABLE") {
    return getTableHeaderLabelStrings(tableRoot);
  }
  const hRow =
    tableRoot.querySelector("thead tr") ||
    tableRoot.querySelector("thead [role=row]") ||
    tableRoot.querySelector("[role=rowgroup] [role=row]") ||
    tableRoot.querySelector("[role=row]");
  if (!hRow) {
    return null;
  }
  return Array.prototype.map
    .call(
      hRow.querySelectorAll("th, [role=columnheader], [role=cell]"),
      function (c) {
        return (c.innerText || c.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
      }
    )
    .filter(function (_, i) {
      return i < 24;
    });
}

/**
 * @param {HTMLTableRowElement|Element} tr
 * @returns {object} partial { itemName?, catalogNumber?, price?, unitSize? }
 */
function extractFromTableRow(tr) {
  const out = { itemName: "", catalogNumber: "", price: "", unitSize: "" };
  if (!tr) {
    return out;
  }
  if (tr.closest("thead")) {
    return out;
  }
  if (tr.getAttribute("role") === "columnheader") {
    return out;
  }
  if (!tr.querySelector("td, [role=cell]")) {
    return out;
  }
  const tableRoot = tr.closest("table, [role=table]") || tr.closest("table");
  const cells = tr.querySelectorAll("td, [role=cell]");

  const heur = function (full) {
    const p = full.match(/[\$€£][\d,]+(?:\.\d{2})?/);
    if (p) {
      out.price = normalizePriceForPanel(p[0]);
    }
    if (!isNonEmptyTrim(out.unitSize)) {
      const sizeLike = full.match(
        /(?:\d+|\d+\s*\/\s*\d+)\s*(?:mL|L|G|g|ug|μg|mg|tests?)\b|Case of \d+[^.\n]{0,22}|^Each$|\d+\s*x\s*\d+|\b\d+[\s\u00A0]*L\b|Cubitainer|bottle|vial|tests?\b/i
      );
      if (sizeLike) {
        out.unitSize = sizeLike[0].replace(/\s+/g, " ").trim();
      }
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

  if (!tableRoot) {
    heur(tr.innerText.replace(/\s+/g, " ").trim());
  } else {
    const headerLabels = getTableHeaderLabelStringsForGridRoot(tableRoot);
    if (!headerLabels || headerLabels.length < 1) {
      heur(tr.innerText.replace(/\s+/g, " ").trim());
    } else {
      const n = Math.min(cells.length, headerLabels.length);
      let got = 0;
      for (let i = 0; i < n; i++) {
        const h = headerLabels[i];
        const colKind = classifyTableHeaderText(h);
        const cellText = (cells[i].innerText || cells[i].textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        if (colKind === "ignore") {
          continue;
        }
        /* Fisher-style option grids label pack size as "Quantity" (e.g. "10 x 500 mL"). */
        if (colKind === "quantity") {
          if (/\d+\s*x\s*\d+|\b(mL|L|G|g|ug|μg|mg|μL|uL|tests?)\b/i.test(cellText)) {
            out.unitSize = cellText;
            got += 1;
          }
          continue;
        }
        if (!isNonEmptyTrim(cellText) || (isNonEmptyTrim(cellText) && cellText.length > 500)) {
          continue;
        }
        if (colKind === "price" && /[\$€£]/.test(cellText)) {
          const m = cellText.match(/[\$€£][\d,]+(?:\.\d{2})?/);
          if (m) {
            out.price = normalizePriceForPanel(m[0]);
          }
          got += 1;
        } else if (colKind === "catalog" && /[0-9A-Za-z-]{3,}/.test(cellText)) {
          const line = cellText.split("\n")[0].trim();
          const sku = line.match(/[A-Z0-9][A-Z0-9._/-]{2,32}/i);
          out.catalogNumber = sku ? sku[0] : line.slice(0, 40);
          got += 1;
        } else if (colKind === "size" || colKind === "product") {
          const t = cellText
            .split("\n")
            .map(function (x) { return x.trim(); })
            .filter(Boolean)
            .join(" · ");
          if (colKind === "size") {
            out.unitSize = t;
          } else {
            out.itemName = t;
          }
          if (t) {
            got += 1;
          }
        }
      }
      if (!isNonEmptyTrim(out.price) || !isNonEmptyTrim(out.unitSize) || !isNonEmptyTrim(out.catalogNumber)) {
        heur(tr.innerText.replace(/\s+/g, " ").trim());
      }
    }
  }
  if (isNonEmptyTrim(out.price) && !/[\$€£]/.test(String(out.price))) {
    out.price = normalizePriceForPanel(out.price);
  }
  const atcSizeEl = tr.querySelector && tr.querySelector(".atc_size, [class*='atc_size']");
  if (atcSizeEl) {
    const tAtc = (atcSizeEl.textContent || "").replace(/\s+/g, " ").trim();
    if (isNonEmptyTrim(tAtc) && tAtc.length < 200) {
      out.unitSize = tAtc;
    }
  }
  return out;
}

function tableRowExtractionIsUseful(partial) {
  const hasPrice = isNonEmptyTrim(partial.price);
  const hasCat = isNonEmptyTrim(partial.catalogNumber);
  const hasSize = isNonEmptyTrim(partial.unitSize);
  const hasName = isNonEmptyTrim(partial.itemName);
  if (hasPrice) {
    return true;
  }
  const score = (hasCat ? 1 : 0) + (hasSize ? 1 : 0) + (hasName ? 1 : 0);
  return score >= 2 || (hasCat && hasSize) || (hasName && (hasCat || hasSize));
}

/**
 * Merges a clicked table row into the live capture. Clears per-field session wand for overridden keys
 * (unless the user has already set that field with the magic wand in this session — then keep the wand).
 * @param {object} partial
 */
function applyTableRowVariantToCapture(partial) {
  const m = { ...captureAutomated };
  const src = { ...exFieldSources };
  const ar = { ...exAiRefined };
  const keys = ["itemName", "catalogNumber", "price", "unitSize"];
  keys.forEach((k) => {
    if (!isNonEmptyTrim(partial[k])) {
      return;
    }
    if (userTouched[k] && isNonEmptyTrim(userValues[k])) {
      return; /* e.g. unit from description vs Case Qty: don’t clobber a wand on re-clicking the same row */
    }
    m[k] = k === "price" ? normalizePriceForPanel(partial[k]) : String(partial[k]).trim();
    if (k === "price" && !isNonEmptyTrim(m[k])) {
      m[k] = String(partial[k]).trim();
    }
    src[k] = "table-row";
    ar[k] = false;
    userTouched[k] = false;
    userValues[k] = "";
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
  if (!tr) {
    return false;
  }
  if (tr.closest("thead")) {
    return false;
  }
  if (!tr.querySelector("td, [role=cell]")) {
    return false;
  }
  if (target && target.nodeName && String(target.nodeName).toLowerCase() === "a" && isLikelyOffPageLink(target)) {
    return false;
  }
  if (!tr.closest("table, [role=table]")) {
    return false;
  }
  const partial = extractFromTableRow(tr);
  if (!tableRowExtractionIsUseful(partial)) {
    return false;
  }
  lastTableRowExtract = {
    itemName: partial.itemName || "",
    catalogNumber: partial.catalogNumber || "",
    price: partial.price || "",
    unitSize: partial.unitSize || ""
  };
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

/**
 * After JSON-LD / wands / Fisher radio, restore the most recently clicked product-table row
 * so a debounced scrape does not replace row-specific price/unit with a global heuristic.
 * @param {object} merged
 * @param {object} fieldSources
 * @param {object|null} aiR
 */
function applyLastTableRowExtractToMerge(merged, fieldSources, aiR) {
  if (!lastTableRowExtract) {
    return;
  }
  const varU = scrapeSelectedRadioGroupVariant();
  const keys = ["itemName", "catalogNumber", "price", "unitSize"];
  keys.forEach(function (k) {
    if (userTouched[k] && isNonEmptyTrim(userValues[k])) {
      return;
    }
    const raw = lastTableRowExtract[k];
    if (!isNonEmptyTrim(raw)) {
      return;
    }
    if (k === "unitSize" && varU && isNonEmptyTrim(varU.unitSize)) {
      return; /* UOM / Fisher radio for price box */
    }
    if (k === "price" && varU && isNonEmptyTrim(varU.price)) {
      return;
    }
    merged[k] = k === "price" ? normalizePriceForPanel(raw) : String(raw).trim();
    if (k === "price" && !isNonEmptyTrim(merged[k])) {
      merged[k] = String(raw).trim();
    }
    fieldSources[k] = "table-row";
    if (aiR) {
      aiR[k] = false;
    }
  });
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
    /* Per-site saved wand selectors override JSON-LD; then the *visible* selected UOM/radio wins price & unit. */
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
    mergeSelectedRadioVariantInto(merged, fieldSources, aiR);
    applyLastTableRowExtractToMerge(merged, fieldSources, aiR);
    applyAndBroadcastProduct(merged, fieldSources, aiR);
  } catch (err) {
    console.warn("[Quartzy Bridge] Extraction on page failed:", err && err.message);
    emitBlankCapture();
  }
}

/**
 * @returns {{ t: number, steps: Array<{ t: number, step: string, detail?: object }>, notes: string[] }}
 */
function createFetchPriceDebugLog() {
  return { t0: Date.now(), steps: [], notes: [] };
}

/**
 * @param {ReturnType<typeof createFetchPriceDebugLog>} log
 * @param {string} step
 * @param {object} [detail]
 */
function fpDebug(log, step, detail) {
  if (!log) return;
  const entry = { t: Date.now() - (log.t0 || Date.now()), step: step };
  if (detail != null) {
    entry.detail = detail;
  }
  log.steps.push(entry);
  try {
    console.log("[Quartzy FetchPrice]", step, detail != null ? detail : "");
  } catch (e) {
    /* ignore */
  }
}

/**
 * @param {Element|null|undefined} el
 * @returns {string}
 */
function describeEl(el) {
  if (!el || !el.tagName) {
    return "";
  }
  let s = String(el.tagName).toLowerCase();
  if (el.id) {
    s += "#" + el.id;
  }
  if (el.className && typeof el.className === "string") {
    const cls = el.className.trim().split(/\s+/).slice(0, 4).join(".");
    if (cls) {
      s += "." + cls;
    }
  }
  return s;
}

/**
 * Snapshot of what the content script sees on the loaded tab (for debug paste-back).
 * @returns {object}
 */
function captureFetchPricePageSnapshot() {
  const containers = getPricingContainers();
  const radios = queryAllUomRadios();
  const shared = findSharedPriceWidget();
  const checked = queryCheckedUomRadio();
  const bodyText = ((document.body && document.body.innerText) || "").replace(/\s+/g, " ").trim();
  const jsonLdCount = document.querySelectorAll('script[type="application/ld+json"]').length;
  const priceEls = document.querySelectorAll(
    "app-avtr-add-to-cart, .webprice-container, [itemprop=\"price\"], meta[itemprop=\"price\"], " +
      ".price-final_price, [data-price-type]"
  );
  const priceSamples = [];
  for (let i = 0; i < Math.min(priceEls.length, 8); i++) {
    const el = priceEls[i];
    const raw =
      (el.getAttribute && el.getAttribute("content")) ||
      (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
    priceSamples.push({ el: describeEl(el), text: raw });
  }
  return {
    href: location.href,
    title: document.title || "",
    readyState: document.readyState,
    hostname: location.hostname,
    jsonLdScriptCount: jsonLdCount,
    pricingContainers: containers.map(describeEl),
    uomRadioCount: radios.length,
    uomRadioNames: radios.slice(0, 12).map(function (r) {
      return { name: r.name || "", value: String(r.value || "").slice(0, 40), checked: !!r.checked };
    }),
    checkedUomRadio: checked
      ? { name: checked.name || "", value: String(checked.value || "").slice(0, 40), scope: describeEl(getRadioVariantRowScope(checked)) }
      : null,
    sharedPriceWidget: describeEl(shared) || null,
    priceElementSamples: priceSamples,
    bodyTextLength: bodyText.length,
    bodyTextHead: bodyText.slice(0, 600),
    bodyTextPriceRegion: (function () {
      const near =
        document.querySelector(".webprice-container, #pricing_container, .product_add_to_cart") ||
        document.body;
      return ((near && near.innerText) || "").replace(/\s+/g, " ").trim().slice(0, 500);
    })(),
    hasSignInLink: !!document.querySelector('a[href*="login" i], a[href*="signin" i], a[href*="sign-in" i]'),
    hasSignOutLink: !!document.querySelector('a[href*="logout" i], a[href*="signout" i], a[href*="sign-out" i]')
  };
}

/**
 * Pricing / buy-box roots used by {@link queryCheckedUomRadio} — reused for variant enumeration.
 * @returns {Element[]}
 */
function getPricingContainers() {
  const candidates = [
    document.getElementById("pricing_container"),
    document.getElementById("Pricing"),
    document.querySelector(".pricing_container"),
    document.querySelector(".product_add_to_cart"),
    document.querySelector("form[action*=\"cart\"]"),
    document.querySelector("variant-picker"),
    document.querySelector("fieldset.option-selector"),
    document.querySelector(".product-options-wrapper"),
    document.querySelector(".product-options-bottom"),
    document.querySelector("ul.radio_list"),
    document.querySelector("ul.radio-list")
  ];
  const out = [];
  const seen = new Set();
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (c && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function catalogNumbersMatch(a, b) {
  if (!isNonEmptyTrim(a) || !isNonEmptyTrim(b)) {
    return false;
  }
  const na = String(a).replace(/[\s#-]+/g, "").toLowerCase();
  const nb = String(b).replace(/[\s#-]+/g, "").toLowerCase();
  return na.length > 0 && na === nb;
}

/**
 * @param {Element} scope
 * @param {HTMLInputElement|null} radio
 * @returns {string}
 */
function readVariantLabelFromScope(scope, radio) {
  if (!scope) {
    return "";
  }
  const optVal = scope.querySelector(".opt-value, [class*='opt-value'], span.label, .label");
  if (optVal) {
    const t = (optVal.textContent || "").replace(/\s+/g, " ").trim();
    if (t && t.length < 120) {
      return t;
    }
  }
  if (radio) {
    let label = radio.labels && radio.labels[0];
    if (!label && radio.id) {
      label = document.querySelector('label[for="' + CSS.escape(radio.id) + '"]');
    }
    if (label) {
      const t = (label.textContent || "").replace(/\s+/g, " ").trim();
      if (t && t.length < 120) {
        return t;
      }
    }
    const v = radio.value;
    if (v && String(v).length < 80) {
      return String(v);
    }
  }
  const unit = readItempropUnitTextInScope(scope, radio);
  if (isNonEmptyTrim(unit)) {
    return unit;
  }
  return "";
}

/**
 * @param {Element} scope
 * @returns {string}
 */
function readCatalogFromScopeText(scope) {
  if (!scope) {
    return "";
  }
  const text = (scope.innerText || scope.textContent || "").replace(/\s+/g, " ").trim();
  const m =
    text.match(/\b(?:Cat(?:alog)?\.?\s*#?|SKU|Item\s*#|Mfr\.?\s*#)\s*[:#]?\s*([A-Z0-9][A-Z0-9._/-]{2,32})\b/i) ||
    text.match(/\b([A-Z]{1,5}\d{3,}[A-Z0-9._/-]*)\b/);
  return m ? m[1] : "";
}

/**
 * @returns {Element|null}
 */
function findSharedPriceWidget() {
  return (
    document.querySelector(".webprice-container") ||
    document.querySelector("#pricing_container .price, .product_add_to_cart [itemprop=\"price\"]") ||
    document.querySelector("[data-price-type=\"finalPrice\"], .price-final_price, .product-info-price")
  );
}

/**
 * @param {Element} watchRoot
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
function waitForPriceUpdate(watchRoot, timeoutMs) {
  const ms = timeoutMs != null ? timeoutMs : 800;
  return new Promise(function (resolve) {
    if (!watchRoot || typeof MutationObserver === "undefined") {
      setTimeout(resolve, Math.min(ms, 200));
      return;
    }
    let done = false;
    const finish = function () {
      if (done) {
        return;
      }
      done = true;
      try {
        obs.disconnect();
      } catch (e) {
        /* ignore */
      }
      resolve();
    };
    const obs = new MutationObserver(function () {
      finish();
    });
    try {
      obs.observe(watchRoot, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true
      });
    } catch (e) {
      setTimeout(finish, Math.min(ms, 200));
      return;
    }
    setTimeout(finish, ms);
  });
}

/**
 * @param {HTMLInputElement} radio
 */
function activateVariantRadio(radio) {
  if (!radio) {
    return;
  }
  try {
    radio.focus({ preventScroll: true });
  } catch (e) {
    try {
      radio.focus();
    } catch (e2) {
      /* ignore */
    }
  }
  if (!radio.checked) {
    radio.checked = true;
  }
  try {
    radio.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  } catch (e) {
    try {
      radio.click();
    } catch (e2) {
      /* ignore */
    }
  }
  try {
    radio.dispatchEvent(new Event("change", { bubbles: true }));
    radio.dispatchEvent(new Event("input", { bubbles: true }));
  } catch (e) {
    /* ignore */
  }
}

/**
 * @param {HTMLInputElement[]} radios
 * @returns {HTMLInputElement[]}
 */
function uniqueRadiosByNameGroup(radios) {
  if (!radios || !radios.length) {
    return [];
  }
  const byName = {};
  for (let i = 0; i < radios.length; i++) {
    const r = radios[i];
    const name = r.name || "__anon_" + i;
    if (!byName[name]) {
      byName[name] = [];
    }
    byName[name].push(r);
  }
  let best = [];
  Object.keys(byName).forEach(function (k) {
    if (byName[k].length > best.length) {
      best = byName[k];
    }
  });
  return best;
}

/**
 * Collect UOM/variant radios inside pricing containers (all options, not only checked).
 * @returns {HTMLInputElement[]}
 */
function queryAllUomRadios() {
  const containers = getPricingContainers();
  const found = [];
  const seen = new Set();
  const pushAll = function (root, sel) {
    if (!root || !root.querySelectorAll) {
      return;
    }
    const list = root.querySelectorAll(sel);
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (r && !seen.has(r)) {
        seen.add(r);
        found.push(r);
      }
    }
  };
  for (let c = 0; c < containers.length; c++) {
    pushAll(containers[c], "input.uom-input[type=radio]");
    pushAll(containers[c], "ul.radio_list input[type=radio], ul.radio-list input[type=radio]");
    pushAll(containers[c], "input[type=radio].opt-btn, fieldset input[type=radio]");
  }
  if (!found.length) {
    pushAll(document, "ul.radio_list input[type=radio], ul.radio-list input[type=radio], input.uom-input[type=radio]");
  }
  if (!found.length) {
    const sw = document.querySelectorAll(
      ".swatch-attribute input[type=radio], input[name^='super_attribute'][type=radio]"
    );
    for (let i = 0; i < sw.length; i++) {
      if (!seen.has(sw[i])) {
        seen.add(sw[i]);
        found.push(sw[i]);
      }
    }
  }
  return uniqueRadiosByNameGroup(found);
}

/**
 * @param {Element} row
 * @returns {boolean}
 */
function rowLooksLikeVariantGridRow(row) {
  if (!row || !row.querySelector) {
    return false;
  }
  if (row.closest("thead")) {
    return false;
  }
  const partial = extractFromTableRow(row);
  if (tableRowExtractionIsUseful(partial) && isNonEmptyTrim(partial.price)) {
    return true;
  }
  const scopePrice = readItempropPriceInScope(row, row.querySelector("input[type=radio]"));
  return isNonEmptyTrim(scopePrice);
}

/**
 * @param {Element} tr
 * @returns {boolean}
 */
function rowLooksSelectedInSelectorTable(tr) {
  if (!tr || !tr.classList) {
    return false;
  }
  if (tr.getAttribute && (tr.getAttribute("aria-selected") === "true" || tr.getAttribute("aria-current") === "true")) {
    return true;
  }
  const cls = String(tr.className || "").toLowerCase();
  if (
    /\b(active|selected|current|is-active|is-selected|is-current)\b/.test(cls) ||
    cls.indexOf("active-row") !== -1 ||
    cls.indexOf("selected-row") !== -1
  ) {
    return true;
  }
  if (tr.querySelector && tr.querySelector("input[type=radio]:checked, input[type=checkbox]:checked")) {
    return true;
  }
  return false;
}

/**
 * Catalog + size/quantity selector tables (e.g. Thermo Fisher PDP) where each row is a SKU
 * but price lives only on the currently selected product (JSON-LD / buy box), not per row.
 * @param {ReturnType<typeof createFetchPriceDebugLog>|null} [log]
 * @returns {Array<{ label: string, catalogNumber: string, price: string, unitSize: string, isSelected: boolean }>|null}
 */
function scrapeSelectorTableVariants(log) {
  const tables = document.querySelectorAll(
    ".pdp-table-product-selector table, .pdp-product-selector table, table"
  );
  let best = null;
  let bestScore = 0;

  for (let t = 0; t < tables.length; t++) {
    const table = tables[t];
    if (!table || table.closest("thead")) {
      continue;
    }
    const headers = getTableHeaderLabelStringsForGridRoot(table);
    if (!headers || headers.length < 2) {
      continue;
    }
    const kinds = headers.map(classifyTableHeaderText);
    const hasCatalog = kinds.indexOf("catalog") !== -1;
    const hasSizeOrQty = kinds.indexOf("size") !== -1 || kinds.indexOf("quantity") !== -1;
    if (!hasCatalog || !hasSizeOrQty) {
      continue;
    }
    /* Prefer true selector tables (no price column). Priced grids are handled elsewhere. */
    const hasPriceCol = kinds.indexOf("price") !== -1;

    const bodyRows = table.querySelectorAll("tbody tr, tr");
    const variants = [];
    let selectedCount = 0;
    for (let i = 0; i < bodyRows.length; i++) {
      const tr = bodyRows[i];
      if (!tr || tr.closest("thead") || (tr.getAttribute && tr.getAttribute("role") === "columnheader")) {
        continue;
      }
      if (!tr.querySelector("td, [role=cell]")) {
        continue;
      }
      const partial = extractFromTableRow(tr);
      if (!isNonEmptyTrim(partial.catalogNumber)) {
        continue;
      }
      /* Need a pack/size signal — quantity column mapped to unitSize, or size column. */
      if (!isNonEmptyTrim(partial.unitSize) && !isNonEmptyTrim(partial.itemName)) {
        continue;
      }
      const isSelected = rowLooksSelectedInSelectorTable(tr);
      if (isSelected) {
        selectedCount += 1;
      }
      const unitSize = partial.unitSize || "";
      const label = unitSize || partial.itemName || partial.catalogNumber;
      variants.push({
        label: label,
        catalogNumber: partial.catalogNumber,
        price: partial.price || "",
        unitSize: unitSize,
        isSelected: isSelected,
        _priceSource: isNonEmptyTrim(partial.price) ? "table-row" : ""
      });
    }
    if (variants.length < 2) {
      continue;
    }
    let score = variants.length * 10 + selectedCount * 5;
    if (table.closest(".pdp-product-selector, .pdp-table-product-selector, [class*='product-selector']")) {
      score += 50;
    }
    if (!hasPriceCol) {
      score += 20;
    }
    if (score > bestScore) {
      bestScore = score;
      best = variants;
    }
  }

  if (!best) {
    fpDebug(log, "selector_table_scan", { found: false });
    return null;
  }
  fpDebug(log, "selector_table_scan", {
    found: true,
    count: best.length,
    selectedCount: best.filter(function (v) {
      return v.isSelected;
    }).length,
    sample: best.slice(0, 8).map(function (v) {
      return {
        label: v.label,
        catalogNumber: v.catalogNumber,
        unitSize: v.unitSize,
        isSelected: v.isSelected,
        price: v.price || ""
      };
    })
  });
  return best;
}

/**
 * Grid pattern: each row already has its own price in the DOM.
 * @param {ReturnType<typeof createFetchPriceDebugLog>|null} [log]
 * @returns {Array<{ label: string, catalogNumber: string, price: string, unitSize: string, isSelected: boolean }>|null}
 */
function scrapeGridVariantRows(log) {
  const containers = getPricingContainers();
  const roots = containers.length ? containers : [document];
  const rows = [];
  const seen = new Set();
  let candidateCount = 0;
  let skippedNoPrice = 0;

  for (let r = 0; r < roots.length; r++) {
    const root = roots[r];
    if (!root || !root.querySelectorAll) {
      continue;
    }
    const candidates = root.querySelectorAll(
      "table tbody tr, [role=table] [role=row], ul.radio_list > li, ul.radio-list > li, li.single_page_price_list"
    );
    candidateCount += candidates.length;
    for (let i = 0; i < candidates.length; i++) {
      const row = candidates[i];
      if (!row || seen.has(row)) {
        continue;
      }
      if (row.getAttribute && row.getAttribute("role") === "columnheader") {
        continue;
      }
      if (!rowLooksLikeVariantGridRow(row) && !row.querySelector("input[type=radio]")) {
        continue;
      }
      const radio = row.querySelector("input[type=radio]");
      let label = "";
      let catalogNumber = "";
      let price = "";
      let unitSize = "";
      let isSelected = !!(radio && radio.checked);
      let priceSource = "";

      if (row.matches && (row.matches("tr, [role=row]") || row.closest("table, [role=table]"))) {
        const partial = extractFromTableRow(row);
        if (tableRowExtractionIsUseful(partial)) {
          label = partial.itemName || partial.unitSize || "";
          catalogNumber = partial.catalogNumber || "";
          price = partial.price || "";
          unitSize = partial.unitSize || "";
          if (isNonEmptyTrim(price)) {
            priceSource = "table-row";
          }
        }
      }
      if (!isNonEmptyTrim(price)) {
        price = readItempropPriceInScope(row, radio);
        if (isNonEmptyTrim(price)) {
          priceSource = "itemprop/webprice-in-row";
        }
      }
      if (!isNonEmptyTrim(unitSize)) {
        unitSize = readItempropUnitTextInScope(row, radio);
      }
      if (!isNonEmptyTrim(label)) {
        label = readVariantLabelFromScope(row, radio) || unitSize;
      }
      if (!isNonEmptyTrim(catalogNumber)) {
        catalogNumber = readCatalogFromScopeText(row);
      }
      if (!isNonEmptyTrim(price) && !isNonEmptyTrim(unitSize) && !isNonEmptyTrim(catalogNumber)) {
        continue;
      }
      /* Grid: require an in-row price so we don't treat shared-widget radios as a grid. */
      if (!isNonEmptyTrim(price)) {
        skippedNoPrice += 1;
        continue;
      }
      seen.add(row);
      rows.push({
        label: label || unitSize || catalogNumber || "Option",
        catalogNumber: catalogNumber || "",
        price: price || "",
        unitSize: unitSize || "",
        isSelected: isSelected,
        _priceSource: priceSource
      });
    }
    if (rows.length) {
      break;
    }
  }
  fpDebug(log, "grid_scan", {
    rootCount: roots.length,
    candidateCount: candidateCount,
    kept: rows.length,
    skippedNoPrice: skippedNoPrice,
    sample: rows.slice(0, 5).map(function (v) {
      return { label: v.label, catalogNumber: v.catalogNumber, price: v.price, priceSource: v._priceSource };
    })
  });
  return rows.length ? rows : null;
}

/**
 * Shared-widget pattern: one price node updates when each radio is selected.
 * @param {ReturnType<typeof createFetchPriceDebugLog>|null} [log]
 * @returns {Promise<Array<{ label: string, catalogNumber: string, price: string, unitSize: string, isSelected: boolean }>|null>}
 */
async function scrapeSharedWidgetVariants(log) {
  const radios = queryAllUomRadios();
  if (radios.length < 2) {
    fpDebug(log, "shared_widget_skip", { reason: "fewer_than_2_radios", count: radios.length });
    return null;
  }
  /* If every radio row already has its own price, prefer grid path (caller checks grid first). */
  let rowsWithOwnPrice = 0;
  for (let i = 0; i < radios.length; i++) {
    const scope = getRadioVariantRowScope(radios[i]);
    if (scope && isNonEmptyTrim(readItempropPriceInScope(scope, radios[i]))) {
      rowsWithOwnPrice += 1;
    }
  }
  if (rowsWithOwnPrice >= radios.length) {
    fpDebug(log, "shared_widget_skip", {
      reason: "all_rows_have_own_price",
      radioCount: radios.length,
      rowsWithOwnPrice: rowsWithOwnPrice
    });
    return null;
  }

  const watchRoot =
    findSharedPriceWidget() ||
    document.getElementById("pricing_container") ||
    document.querySelector(".product_add_to_cart") ||
    document.body;
  fpDebug(log, "shared_widget_start", {
    radioCount: radios.length,
    rowsWithOwnPrice: rowsWithOwnPrice,
    watchRoot: describeEl(watchRoot)
  });
  const variants = [];

  for (let i = 0; i < radios.length; i++) {
    const radio = radios[i];
    const tClick = Date.now();
    activateVariantRadio(radio);
    await waitForPriceUpdate(watchRoot, 800);
    const waitMs = Date.now() - tClick;
    const scope = getRadioVariantRowScope(radio) || watchRoot;
    let price = readItempropPriceInScope(watchRoot, radio);
    let priceSource = isNonEmptyTrim(price) ? "watchRoot_itemprop/webprice" : "";
    if (!isNonEmptyTrim(price)) {
      price = readItempropPriceInScope(scope, radio);
      if (isNonEmptyTrim(price)) {
        priceSource = "row_scope_itemprop/webprice";
      }
    }
    if (!isNonEmptyTrim(price)) {
      const v = scrapeSelectedRadioGroupVariant();
      if (v && isNonEmptyTrim(v.price)) {
        price = v.price;
        priceSource = "scrapeSelectedRadioGroupVariant";
      }
    }
    let unitSize = readItempropUnitTextInScope(scope, radio);
    if (!isNonEmptyTrim(unitSize)) {
      const v2 = scrapeSelectedRadioGroupVariant();
      if (v2 && isNonEmptyTrim(v2.unitSize)) {
        unitSize = v2.unitSize;
      }
    }
    const label = readVariantLabelFromScope(scope, radio) || unitSize || radio.value || "Option " + (i + 1);
    const catalogNumber = readCatalogFromScopeText(scope);
    variants.push({
      label: label,
      catalogNumber: catalogNumber || "",
      price: price || "",
      unitSize: unitSize || "",
      isSelected: true,
      _priceSource: priceSource || "none"
    });
    fpDebug(log, "shared_widget_option", {
      index: i,
      value: String(radio.value || "").slice(0, 40),
      waitMs: waitMs,
      price: price || "",
      priceSource: priceSource || "none",
      unitSize: unitSize || "",
      label: label
    });
  }
  return variants.length ? variants : null;
}

/**
 * Attach page-level (baseline) price to the selected selector-table row when rows lack prices.
 * Other rows stay price-empty — navigating to that SKU would be needed for their contract price.
 * @param {Array<object>} variants
 * @param {object|null} baseline
 * @param {ReturnType<typeof createFetchPriceDebugLog>|null} [log]
 * @returns {Array<object>}
 */
function attachBaselinePriceToSelectedVariant(variants, baseline, log) {
  if (!variants || !variants.length || !baseline) {
    return variants;
  }
  const basePrice = isNonEmptyTrim(baseline.price) ? baseline.price : "";
  const baseCat = isNonEmptyTrim(baseline.catalogNumber) ? baseline.catalogNumber : "";
  if (!basePrice) {
    return variants;
  }

  let selectedIdx = -1;
  for (let i = 0; i < variants.length; i++) {
    if (variants[i].isSelected) {
      selectedIdx = i;
      break;
    }
  }
  if (selectedIdx < 0 && baseCat) {
    for (let i = 0; i < variants.length; i++) {
      if (catalogNumbersMatch(variants[i].catalogNumber, baseCat)) {
        selectedIdx = i;
        variants[i].isSelected = true;
        break;
      }
    }
  }
  if (selectedIdx < 0) {
    fpDebug(log, "selector_price_attach", { attached: false, reason: "no_selected_row" });
    return variants;
  }

  const v = variants[selectedIdx];
  if (!isNonEmptyTrim(v.price)) {
    v.price = basePrice;
    v._priceSource = (baseline.fieldSources && baseline.fieldSources.price) || "baseline_selected";
  }
  /* Prefer baseline unit/catalog when selected row matches that SKU. */
  if (baseCat && catalogNumbersMatch(v.catalogNumber, baseCat)) {
    if (isNonEmptyTrim(baseline.unitSize) && !isNonEmptyTrim(v.unitSize)) {
      v.unitSize = baseline.unitSize;
    }
  }
  fpDebug(log, "selector_price_attach", {
    attached: true,
    index: selectedIdx,
    catalogNumber: v.catalogNumber,
    price: v.price,
    priceSource: v._priceSource || null
  });
  return variants;
}

/**
 * Enumerate all variant prices on the page (grid, selector table, or shared-widget).
 * @param {ReturnType<typeof createFetchPriceDebugLog>|null} [log]
 * @param {object|null} [baseline] - used to stamp price onto the selected selector-table row
 * @returns {Promise<{ mode: 'single'|'list', variants: Array<object>, pattern: string }>}
 */
async function scrapeAllVariants(log, baseline) {
  let variants = scrapeGridVariantRows(log);
  let pattern = "grid";
  if (!variants) {
    variants = scrapeSelectorTableVariants(log);
    if (variants) {
      pattern = "selector_table";
      variants = attachBaselinePriceToSelectedVariant(variants, baseline || null, log);
    }
  }
  if (!variants) {
    variants = await scrapeSharedWidgetVariants(log);
    pattern = variants ? "shared_widget" : "none";
  }
  if (!variants || !variants.length) {
    fpDebug(log, "enumerate_result", { pattern: "none", mode: "single", count: 0 });
    return { mode: "single", variants: [], pattern: "none" };
  }
  if (variants.length === 1) {
    fpDebug(log, "enumerate_result", { pattern: pattern, mode: "single", count: 1 });
    return { mode: "single", variants: variants, pattern: pattern };
  }
  fpDebug(log, "enumerate_result", { pattern: pattern, mode: "list", count: variants.length });
  return { mode: "list", variants: variants, pattern: pattern };
}

/**
 * DOM login heuristic: 'logged_in' | 'logged_out' | 'unknown'
 * @param {ReturnType<typeof createFetchPriceDebugLog>|null} [log]
 * @returns {'logged_in'|'logged_out'|'unknown'}
 */
function detectLoginStateFromDom(log) {
  const bodyText = ((document.body && document.body.innerText) || "").slice(0, 20000);
  const priceNear =
    document.querySelector(".webprice-container, #pricing_container, .product_add_to_cart, [itemprop=\"price\"]") ||
    document.body;
  const nearText = ((priceNear && priceNear.innerText) || "").slice(0, 4000);

  if (
    /sign\s*in\s*to\s*see\s*your\s*price|log\s*in\s*(for|to\s*see)\s*(your\s*)?pric|login\s*for\s*pric|sign\s*in\s*for\s*(contract\s*)?pric/i.test(
      nearText
    ) ||
    /sign\s*in\s*to\s*see\s*your\s*price|log\s*in\s*(for|to\s*see)\s*(your\s*)?pric|login\s*for\s*pric/i.test(bodyText)
  ) {
    fpDebug(log, "login_dom", { result: "logged_out", reason: "sign_in_to_see_price_text" });
    return "logged_out";
  }

  const hasSignOut =
    !!document.querySelector(
      'a[href*="logout" i], a[href*="signout" i], a[href*="sign-out" i], button[href*="logout" i]'
    ) || /\b(sign\s*out|log\s*out|my\s*account|welcome,?\s)/i.test(bodyText.slice(0, 8000));
  const hasSignInCta = !!document.querySelector(
    'a[href*="login" i], a[href*="signin" i], a[href*="sign-in" i], button[data-action*="login" i]'
  );
  const signInVisible =
    hasSignInCta ||
    (/\b(sign\s*in|log\s*in)\b/i.test(bodyText.slice(0, 6000)) &&
      !/\b(sign\s*out|log\s*out|my\s*account)\b/i.test(bodyText.slice(0, 6000)));

  let result = "unknown";
  let reason = "no_confident_markers";
  if (hasSignOut && !signInVisible) {
    result = "logged_in";
    reason = "sign_out_or_account_without_sign_in";
  } else if (signInVisible && !hasSignOut) {
    result = "logged_out";
    reason = "sign_in_cta_without_sign_out";
  } else if (hasSignOut) {
    result = "logged_in";
    reason = "sign_out_present";
  }
  fpDebug(log, "login_dom", { result: result, reason: reason, hasSignOut: hasSignOut, signInVisible: signInVisible });
  return result;
}

/**
 * Bot-check / login-wall / load failure heuristics for the fetch-price debug tool.
 * @param {ReturnType<typeof createFetchPriceDebugLog>|null} [log]
 * @returns {string|null} error code or null if page looks usable
 */
function detectFetchPricePageBlocker(log) {
  const title = (document.title || "").toLowerCase();
  const href = String(location.href || "").toLowerCase();
  const text = ((document.body && document.body.innerText) || "").slice(0, 12000).toLowerCase();

  if (
    /captcha|are you a human|verify you are|cloudflare|attention required|access denied|bot detection|perimeterx|datadome/i.test(
      title + " " + text.slice(0, 2000)
    )
  ) {
    fpDebug(log, "blocker", { code: "bot_check", title: document.title });
    return "bot_check";
  }
  if (
    /\/login|\/signin|\/sign-in|\/sso\b|\/auth\b/.test(href) &&
    !/product|catalog|pdp|sku/i.test(href)
  ) {
    fpDebug(log, "blocker", { code: "login_wall", reason: "auth_url", href: location.href });
    return "login_wall";
  }
  if (
    (/\b(sign\s*in|log\s*in)\b/.test(text.slice(0, 3000)) &&
      /password|email|username/.test(text.slice(0, 3000)) &&
      !document.querySelector("#pricing_container, .webprice-container, [itemprop=\"price\"], ul.radio_list"))
  ) {
    fpDebug(log, "blocker", { code: "login_wall", reason: "login_form_no_pricing" });
    return "login_wall";
  }
  fpDebug(log, "blocker", { code: null });
  return null;
}

/**
 * Baseline capture used by FETCH_PRICE_SCRAPE (same merge path as navigation scrape).
 * @param {ReturnType<typeof createFetchPriceDebugLog>|null} [log]
 * @returns {Promise<object>}
 */
async function runBaselineCaptureForFetchPrice(log) {
  if (typeof QuartzyExtractionService === "undefined") {
    fpDebug(log, "baseline", { error: "ExtractionService_missing" });
    return {
      itemName: "",
      catalogNumber: "",
      price: "",
      unitSize: "",
      url: location.href,
      vendor: vendorLabel(),
      fieldSources: { itemName: null, catalogNumber: null, price: null, unitSize: null }
    };
  }
  const ex = await QuartzyExtractionService.run(document);
  const h1 = document.querySelector("h1")?.innerText?.trim() || document.title.split("|")[0].trim() || "";
  const ef = (ex && ex.fields) || {};
  const catalogFromEx = isNonEmptyTrim(ef.catalogNumber) ? ef.catalogNumber : "";
  const priceFromEx = isNonEmptyTrim(ef.price) ? ef.price : "";
  const uDom = extractUnitSize();
  fpDebug(log, "baseline_jsonld", {
    h1: (h1 || "").slice(0, 120),
    extractionFields: {
      itemName: (ef.itemName || "").slice(0, 80),
      catalogNumber: catalogFromEx,
      price: priceFromEx,
      unitSize: (ef.unitSize || "").slice(0, 80)
    },
    fieldSources: (ex && ex.fieldSources) || null,
    unitFromDom: uDom
  });
  const merged0 = mergeProductFields(ex, {
    h1: h1,
    unitFromDom: uDom,
    catalog: catalogFromEx,
    price: priceFromEx,
    vendor: vendorLabel()
  });
  let fieldSources = {
    ...((ex && ex.fieldSources) || { itemName: null, catalogNumber: null, price: null, unitSize: null })
  };
  const mres = mergeExtractionWithPostLd(merged0, fieldSources, ex, null, "");
  let merged = mres.merged;
  fieldSources = mres.fieldSources;
  let aiR = mres.aiRefined;
  const beforeHints = { price: merged.price, unitSize: merged.unitSize, catalogNumber: merged.catalogNumber };
  if (typeof QuartzyDomFieldHints !== "undefined" && typeof QuartzyDomFieldHints.applySavedHints === "function") {
    const withHints = QuartzyDomFieldHints.applySavedHints(merged, fieldSources, normalizeWandValue);
    merged = withHints.merged;
    fieldSources = withHints.fieldSources;
  }
  const beforeVariant = { price: merged.price, unitSize: merged.unitSize };
  mergeSelectedRadioVariantInto(merged, fieldSources, aiR);
  applyLastTableRowExtractToMerge(merged, fieldSources, aiR);
  fpDebug(log, "baseline_merged", {
    beforeHints: beforeHints,
    afterHintsAndVariant: {
      itemName: (merged.itemName || "").slice(0, 80),
      catalogNumber: merged.catalogNumber || "",
      price: merged.price || "",
      unitSize: merged.unitSize || ""
    },
    beforeVariant: beforeVariant,
    fieldSources: fieldSources
  });
  return {
    itemName: merged.itemName || "",
    catalogNumber: merged.catalogNumber || "",
    price: merged.price || "",
    unitSize: merged.unitSize || "",
    url: location.href,
    vendor: vendorLabel(),
    fieldSources: fieldSources
  };
}

/**
 * SPA shells (e.g. VWR Spartacus) often report document.readyState complete while body is still empty.
 * Cookie banners inflate bodyText early — require product chrome, not just any text.
 * @returns {boolean}
 */
function fetchPricePageLooksHydrated() {
  const h1 = document.querySelector("h1");
  if (h1 && String(h1.innerText || "").trim()) {
    return true;
  }
  if (
    document.querySelector(
      "app-avtr-product-name, app-avtr-add-to-cart, #pricing_container, .pricing_container, " +
        ".product_add_to_cart, .webprice-container, [itemprop=\"price\"]"
    )
  ) {
    return true;
  }
  const bodyText = ((document.body && document.body.innerText) || "").replace(/\s+/g, " ").trim();
  /* Avoid treating cookie/consent chrome as hydration; need a price-looking token. */
  if (bodyText.length >= 400 && /\$\s*\d/.test(bodyText)) {
    return true;
  }
  return false;
}

/**
 * Buy-box / ATC widget with a visible money amount (contract price usually lands here after auth).
 * JSON-LD alone is not enough — VWR injects guest Offer.price before the logged-in widget updates.
 * @returns {boolean}
 */
function fetchPriceHasPricingWidget() {
  const widgets = document.querySelectorAll(
    "app-avtr-add-to-cart, .webprice-container, #pricing_container, .pricing_container, " +
      ".product_add_to_cart, [data-price-type], .price-final_price"
  );
  for (let i = 0; i < widgets.length; i++) {
    const text = String(widgets[i].innerText || widgets[i].textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    if (/\$\s*\d/.test(text) || /\b\d+\.\d{2}\b/.test(text)) {
      return true;
    }
  }
  const meta = document.querySelector('meta[itemprop="price"][content]');
  if (meta && String(meta.getAttribute("content") || "").trim()) {
    return true;
  }
  return false;
}

/**
 * Weaker fallback when no dedicated widget appears (still prefer widget when present).
 * @returns {boolean}
 */
function fetchPriceHasPriceSignal() {
  if (fetchPriceHasPricingWidget()) {
    return true;
  }
  const bodyText = ((document.body && document.body.innerText) || "").slice(0, 20000);
  return /\$\s*\d/.test(bodyText) || /\bUSD\s*\d/i.test(bodyText);
}

/**
 * Best-effort visible price sample from the buy box (for settle detection).
 * @returns {string}
 */
function readFetchPriceDomPriceSample() {
  const roots = document.querySelectorAll(
    "app-avtr-add-to-cart, .webprice-container, #pricing_container, .pricing_container, .product_add_to_cart"
  );
  for (let i = 0; i < roots.length; i++) {
    const text = String(roots[i].innerText || "").replace(/\s+/g, " ");
    const m = text.match(/\$\s*[\d,]+(?:\.\d{2})?/);
    if (m) {
      return m[0].replace(/\s+/g, "");
    }
  }
  if (typeof QuartzyDomFieldHints !== "undefined" && typeof QuartzyDomFieldHints.applySavedHints === "function") {
    try {
      const probe = { price: "", catalogNumber: "", itemName: "", unitSize: "" };
      const sources = { price: null, catalogNumber: null, itemName: null, unitSize: null };
      const withHints = QuartzyDomFieldHints.applySavedHints(probe, sources, normalizeWandValue);
      if (withHints && withHints.merged && isNonEmptyTrim(withHints.merged.price)) {
        return String(withHints.merged.price).replace(/\s+/g, "");
      }
    } catch (e) {
      /* ignore */
    }
  }
  return "";
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function fetchPriceSleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

/**
 * Wait until the PDP shell has real content (or timeout). Uses MutationObserver + poll.
 * @param {ReturnType<typeof createFetchPriceDebugLog>|null} log
 * @param {number} timeoutMs
 * @param {function(): boolean} predicate
 * @param {string} stepName
 * @returns {Promise<boolean>}
 */
function waitForFetchPricePredicate(log, timeoutMs, predicate, stepName) {
  const ms = timeoutMs != null ? timeoutMs : 12000;
  return new Promise(function (resolve) {
    if (predicate()) {
      fpDebug(log, stepName, { waitedMs: 0, ok: true, reason: "already" });
      resolve(true);
      return;
    }
    const t0 = Date.now();
    let done = false;
    let obs = null;
    let poll = null;
    const finish = function (ok, reason) {
      if (done) {
        return;
      }
      done = true;
      if (poll) {
        clearInterval(poll);
      }
      try {
        if (obs) {
          obs.disconnect();
        }
      } catch (e) {
        /* ignore */
      }
      fpDebug(log, stepName, { waitedMs: Date.now() - t0, ok: ok, reason: reason });
      resolve(ok);
    };
    const check = function () {
      if (predicate()) {
        finish(true, "content");
      }
    };
    if (typeof MutationObserver !== "undefined" && document.documentElement) {
      try {
        obs = new MutationObserver(check);
        obs.observe(document.documentElement, {
          childList: true,
          subtree: true,
          characterData: true
        });
      } catch (e) {
        obs = null;
      }
    }
    poll = setInterval(check, 250);
    setTimeout(function () {
      finish(false, "timeout");
    }, ms);
  });
}

/**
 * Guest/list price often paints first; wait until the buy-box amount stops changing.
 * @param {ReturnType<typeof createFetchPriceDebugLog>|null} log
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
async function waitForFetchPriceStabilize(log, timeoutMs) {
  const ms = timeoutMs != null ? timeoutMs : 6000;
  const STABLE_MS = 1200;
  const t0 = Date.now();
  let last = readFetchPriceDomPriceSample();
  let stableSince = Date.now();
  let changes = 0;
  while (Date.now() - t0 < ms) {
    await fetchPriceSleep(300);
    const cur = readFetchPriceDomPriceSample();
    if (cur && cur !== last) {
      changes += 1;
      last = cur;
      stableSince = Date.now();
      fpDebug(log, "price_change", { price: cur, changes: changes });
      continue;
    }
    if (cur && Date.now() - stableSince >= STABLE_MS) {
      fpDebug(log, "price_settle", {
        waitedMs: Date.now() - t0,
        price: cur,
        changes: changes,
        ok: true
      });
      return;
    }
  }
  fpDebug(log, "price_settle", {
    waitedMs: Date.now() - t0,
    price: last || null,
    changes: changes,
    ok: !!last,
    reason: "timeout"
  });
}

/**
 * @param {ReturnType<typeof createFetchPriceDebugLog>|null} log
 * @returns {Promise<void>}
 */
async function waitForFetchPricePageReady(log) {
  await waitForFetchPricePredicate(log, 12000, fetchPricePageLooksHydrated, "hydration_wait");
  /* Prefer the live buy box over early JSON-LD guest Offer.price. */
  const widgetOk = await waitForFetchPricePredicate(
    log,
    12000,
    fetchPriceHasPricingWidget,
    "pricing_widget_wait"
  );
  if (!widgetOk && !fetchPriceHasPriceSignal()) {
    await waitForFetchPricePredicate(log, 4000, fetchPriceHasPriceSignal, "price_signal_wait");
  }
  if (fetchPriceHasPricingWidget() || readFetchPriceDomPriceSample()) {
    await waitForFetchPriceStabilize(log, 7000);
  } else {
    await fetchPriceSleep(400);
  }
}

/**
 * @param {object} baseline
 * @param {object[]} variants
 * @returns {boolean}
 */
function fetchPriceScrapeHasPrice(baseline, variants) {
  if (baseline && isNonEmptyTrim(baseline.price)) {
    return true;
  }
  if (!Array.isArray(variants)) {
    return false;
  }
  for (let i = 0; i < variants.length; i++) {
    if (variants[i] && isNonEmptyTrim(variants[i].price)) {
      return true;
    }
  }
  return false;
}

/**
 * JSON-LD Offer.price is often the public/list price before auth refreshes the widget.
 * @param {object} baseline
 * @returns {boolean}
 */
function fetchPriceIsJsonLdOnlyPrice(baseline) {
  if (!baseline || !isNonEmptyTrim(baseline.price)) {
    return false;
  }
  const src = baseline.fieldSources && baseline.fieldSources.price;
  if (!src || String(src).indexOf("json-ld") !== 0) {
    return false;
  }
  return !fetchPriceHasPricingWidget();
}

/**
 * @param {string} s
 * @returns {string}
 */
function fetchPriceMoneyKey(s) {
  const m = String(s || "").replace(/,/g, "").match(/(\d+(?:\.\d{1,2})?)/);
  return m ? m[1] : "";
}

/**
 * When the buy box shows a different amount than JSON-LD guest Offer.price, prefer the widget.
 * @param {object} baseline
 * @param {ReturnType<typeof createFetchPriceDebugLog>|null} log
 */
function preferFetchPriceDomOverJsonLd(baseline, log) {
  if (!baseline || !baseline.fieldSources) {
    return;
  }
  const src = baseline.fieldSources.price;
  if (!src || String(src).indexOf("json-ld") !== 0) {
    return;
  }
  const dom = readFetchPriceDomPriceSample();
  if (!dom) {
    return;
  }
  const a = fetchPriceMoneyKey(baseline.price);
  const b = fetchPriceMoneyKey(dom);
  if (!b || a === b) {
    return;
  }
  const formatted = dom.indexOf("$") !== -1 ? dom : "$" + b;
  fpDebug(log, "prefer_dom_over_jsonld", { from: baseline.price || "", to: formatted });
  baseline.price = formatted;
  baseline.fieldSources.price = "dom-pricing-widget";
}

/**
 * @param {string|undefined} catalogNumberHint
 * @returns {Promise<object>}
 */
async function handleFetchPriceScrape(catalogNumberHint) {
  const log = createFetchPriceDebugLog();
  fpDebug(log, "scrape_start", {
    catalogNumberHint: catalogNumberHint != null ? String(catalogNumberHint) : "",
    href: location.href
  });

  await waitForFetchPricePageReady(log);

  let pageSnapshot = null;
  let blocker = null;
  let loginDom = "unknown";
  let baseline = {
    itemName: "",
    catalogNumber: "",
    price: "",
    unitSize: "",
    url: location.href,
    vendor: "",
    fieldSources: { itemName: null, catalogNumber: null, price: null, unitSize: null }
  };
  let mode = "single";
  let variants = [];
  let outcomeSource = "none";

  for (let pass = 0; pass < 4; pass++) {
    try {
      pageSnapshot = captureFetchPricePageSnapshot();
      fpDebug(log, "page_snapshot", {
        pass: pass + 1,
        title: pageSnapshot.title,
        href: pageSnapshot.href,
        bodyTextLength: pageSnapshot.bodyTextLength,
        pricingContainers: pageSnapshot.pricingContainers,
        uomRadioCount: pageSnapshot.uomRadioCount,
        sharedPriceWidget: pageSnapshot.sharedPriceWidget,
        jsonLdScriptCount: pageSnapshot.jsonLdScriptCount,
        priceElementSamples: pageSnapshot.priceElementSamples,
        pricingWidget: fetchPriceHasPricingWidget(),
        domPriceSample: readFetchPriceDomPriceSample() || null
      });
    } catch (e) {
      fpDebug(log, "page_snapshot_error", { message: (e && e.message) || String(e), pass: pass + 1 });
    }

    blocker = detectFetchPricePageBlocker(log);
    loginDom = detectLoginStateFromDom(log);
    baseline = await runBaselineCaptureForFetchPrice(log);
    preferFetchPriceDomOverJsonLd(baseline, log);
    const enumerated = await scrapeAllVariants(log, baseline);
    mode = enumerated.mode;
    variants = enumerated.variants || [];
    outcomeSource = enumerated.pattern || "none";

    if (!variants.length) {
      mode = "single";
      outcomeSource = "baseline_fallback";
      variants = [
        {
          label: baseline.unitSize || baseline.itemName || "Product",
          catalogNumber: baseline.catalogNumber || "",
          price: baseline.price || "",
          unitSize: baseline.unitSize || "",
          isSelected: true,
          _priceSource: (baseline.fieldSources && baseline.fieldSources.price) || "baseline"
        }
      ];
      fpDebug(log, "fallback_baseline", {
        pass: pass + 1,
        price: baseline.price || "",
        catalogNumber: baseline.catalogNumber || "",
        fieldSources: baseline.fieldSources || null
      });
    } else if (variants.length === 1) {
      mode = "single";
    }

    if (blocker) {
      break;
    }

    const hasPrice = fetchPriceScrapeHasPrice(baseline, variants);
    const jsonLdOnly = fetchPriceIsJsonLdOnlyPrice(baseline);
    if (hasPrice && jsonLdOnly && pass < 3) {
      fpDebug(log, "jsonld_guest_price_retry", {
        pass: pass + 1,
        price: baseline.price || "",
        reason: "wait_for_pricing_widget"
      });
      await waitForFetchPricePredicate(log, 10000, fetchPriceHasPricingWidget, "pricing_widget_wait");
      await waitForFetchPriceStabilize(log, 7000);
      continue;
    }

    const domSample = readFetchPriceDomPriceSample();
    if (
      hasPrice &&
      domSample &&
      fetchPriceMoneyKey(domSample) !== fetchPriceMoneyKey(baseline.price) &&
      pass < 3
    ) {
      fpDebug(log, "dom_price_mismatch_retry", {
        pass: pass + 1,
        baselinePrice: baseline.price || "",
        domPrice: domSample
      });
      await waitForFetchPriceStabilize(log, 4000);
      continue;
    }

    if (hasPrice) {
      break;
    }
    if (pass < 3) {
      fpDebug(log, "empty_price_retry", { pass: pass + 1, nextWaitMs: 1200 });
      await fetchPriceSleep(1200);
    }
  }

  const hint = catalogNumberHint != null ? String(catalogNumberHint).trim() : "";
  let suggestedCount = 0;
  variants = variants.map(function (v) {
    const matchHint = hint ? catalogNumbersMatch(v.catalogNumber, hint) : false;
    if (matchHint) suggestedCount += 1;
    /* Highlight catalog hint if provided; otherwise highlight the page's selected SKU. */
    const highlight = matchHint || (!hint && !!v.isSelected);
    return Object.assign({}, v, {
      isSuggestedMatch: highlight
    });
  });

  const cleanVariants = variants.map(function (v) {
    const o = {
      label: v.label || "",
      catalogNumber: v.catalogNumber || "",
      price: v.price || "",
      unitSize: v.unitSize || "",
      isSelected: !!v.isSelected,
      isSuggestedMatch: !!v.isSuggestedMatch
    };
    if (v._priceSource) {
      o.priceSource = v._priceSource;
    }
    return o;
  });

  fpDebug(log, "scrape_done", {
    ok: !blocker,
    error: blocker || null,
    mode: mode,
    outcomeSource: outcomeSource,
    variantCount: cleanVariants.length,
    suggestedMatchCount: suggestedCount,
    loginState: loginDom,
    prices: cleanVariants.map(function (v) {
      return { price: v.price, catalogNumber: v.catalogNumber, priceSource: v.priceSource || null };
    })
  });

  return {
    ok: !blocker,
    error: blocker || null,
    mode: mode,
    variants: cleanVariants,
    baseline: baseline,
    loginState: loginDom,
    pageUrl: location.href,
    pageTitle: document.title || "",
    debug: {
      version: 1,
      outcomeSource: outcomeSource,
      page: pageSnapshot,
      steps: log.steps,
      durationMs: Date.now() - log.t0
    }
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "TRIGGER_SCRAPE") {
    console.log("[Quartzy Bridge] Re-scrape triggered by navigation.");
    resetCaptureState();
    run();
  }

  if (message.type === "FETCH_PRICE_SCRAPE") {
    const hint = message.catalogNumber;
    handleFetchPriceScrape(hint)
      .then(function (result) {
        sendResponse({ type: "FETCH_PRICE_RESULT", ...result });
      })
      .catch(function (e) {
        sendResponse({
          type: "FETCH_PRICE_RESULT",
          ok: false,
          error: "scrape_failed",
          errorMessage: (e && e.message) || "scrape_failed",
          mode: "single",
          variants: [],
          loginState: "unknown",
          pageUrl: location.href,
          pageTitle: document.title || "",
          debug: {
            version: 1,
            error: (e && e.message) || "scrape_failed",
            stack: (e && e.stack) || null,
            href: location.href
          }
        });
      });
    return true;
  }

  if (message.type === "WAND_START" && message.field) {
    const started = startWandForField(String(message.field));
    sendResponse({ success: started });
    return;
  }

  if (message.type === "WAND_STOP") {
    const stopped = stopActiveWand();
    sendResponse({ success: stopped });
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
 * Fisher (and similar) price rows put the UOM &lt;input type=radio&gt; before a &lt;label&gt; that has
 * no `for=…`, so clicking the price / "Each" / "Case" text does not select that option. Delegating
 * a click to the real radio in that row fixes selection without stopping normal behavior on links.
 * @param {MouseEvent} e
 */
function delegateUomRadioListLabelClick(e) {
  if (e.button !== 0 || e.defaultPrevented) {
    return;
  }
  const t = e.target;
  if (!t || !t.closest) {
    return;
  }
  if (t.nodeName === "INPUT" && (t.type || "").toLowerCase() === "radio") {
    return;
  }
  if (t.closest("label[for]")) {
    return;
  }
  if (t.closest("a, button, select, textarea, [contenteditable]")) {
    return;
  }
  const li = t.closest("ul.radio_list li, ul.radio-list li");
  if (!li) {
    return;
  }
  const inp = li.querySelector("input.uom-input[type=radio], input[type=radio].uom-input");
  if (!inp) {
    return;
  }
  inp.click();
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
  const tr = t.closest("tr, [role=row]");
  if (tr) {
    if (tryApplyTableRowAsVariant(tr, t)) {
      return;
    }
  }
  if (
    t.closest(
      "tr, [role='row'], [role='radio'], [role='option'], [role='tab'], " +
        "ul.radio_list, ul.radio-list, li.single_page_price_list, " +
        "label.radio_swatch, label.swatch-option, .swatch-attribute, .swatch-option"
    )
  ) {
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
document.addEventListener("click", delegateUomRadioListLabelClick, false);

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

/* —— Cart API mapping: page-world fetch/XHR hook bridge —— */
const QZC_CART_HOOK_SOURCE = "quartzy-cart-hook";
const QZC_CART_HOOK_SCRIPT_ID = "quartzy-cart-capture-hook";
let qzcCartHookInjected = false;
let qzcCartMappingActive = false;

function qzcEnsureCartCaptureHook(onReady) {
  if (document.getElementById(QZC_CART_HOOK_SCRIPT_ID)) {
    qzcCartHookInjected = true;
    if (typeof onReady === "function") onReady();
    return true;
  }
  try {
    const s = document.createElement("script");
    s.id = QZC_CART_HOOK_SCRIPT_ID;
    s.src = chrome.runtime.getURL("cartCaptureHook.js");
    s.async = false;
    s.onload = function () {
      qzcCartHookInjected = true;
      if (typeof onReady === "function") onReady();
    };
    s.onerror = function () {
      console.log("[Quartzy Connect] cart hook script failed to load");
      if (typeof onReady === "function") onReady(false);
    };
    (document.documentElement || document.head || document.body).appendChild(s);
    return true;
  } catch (e) {
    console.log("[Quartzy Connect] cart hook inject failed:", e && e.message);
    if (typeof onReady === "function") onReady(false);
    return false;
  }
}

function qzcSetCartMappingActive(on) {
  qzcCartMappingActive = !!on;
  function sendCmd() {
    try {
      window.postMessage(
        {
          source: QZC_CART_HOOK_SOURCE,
          type: "QUARTZY_CART_HOOK_CMD",
          payload: { active: qzcCartMappingActive }
        },
        "*"
      );
    } catch (e) {
      /* ignore */
    }
  }
  if (qzcCartHookInjected || document.getElementById(QZC_CART_HOOK_SCRIPT_ID)) {
    qzcCartHookInjected = true;
    sendCmd();
  } else {
    qzcEnsureCartCaptureHook(function () {
      sendCmd();
      /* Re-send shortly in case the page hook registered after first postMessage. */
      setTimeout(sendCmd, 50);
    });
  }
  return qzcCartMappingActive;
}

window.addEventListener("message", function (event) {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== QZC_CART_HOOK_SOURCE) return;
  if (data.type === "QUARTZY_CART_HOOK_CAPTURE" && data.payload && qzcCartMappingActive) {
    try {
      chrome.runtime.sendMessage({
        type: "CART_MAPPING_CAPTURE",
        payload: data.payload,
        pageUrl: location.href,
        pageHost: location.hostname
      });
    } catch (e) {
      /* ignore */
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CART_MAPPING_START") {
    const ok = qzcSetCartMappingActive(true);
    sendResponse({ success: ok, active: qzcCartMappingActive });
    return;
  }
  if (message.type === "CART_MAPPING_STOP") {
    qzcSetCartMappingActive(false);
    sendResponse({ success: true, active: false });
    return;
  }
});
