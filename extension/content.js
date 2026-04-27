console.log("[Quartzy Bridge] Content Script Loaded");

/** In-page state for the side panel only. JSON-LD / generic extraction, wand overrides, and user highlights. */
const CAPTURE_FIELD_KEYS = ["itemName", "catalogNumber", "price", "unitSize"];
const userTouched = { itemName: false, catalogNumber: false, price: false, unitSize: false };
const userValues = { itemName: "", catalogNumber: "", price: "", unitSize: "" };
let captureAutomated = { itemName: "", catalogNumber: "", price: "", unitSize: "" };
let exFieldSources = { itemName: null, catalogNumber: null, price: null, unitSize: null };
let exAiRefined = { itemName: false, catalogNumber: false, price: false, unitSize: false };
/** For side panel debug tab: first merge layer (H1, generic unit, JSON-LD paths) before AI / saved DOM / wand. */
let lastHeuristicProvenance = { itemName: "—", catalogNumber: "—", price: "—", unitSize: "—" };
const WAND_FIELD_SET = { itemName: 1, catalogNumber: 1, price: 1, unitSize: 1 };

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
 * Explains the first pass (mergeProductFields) before AI, saved-DOM, or this-session wand.
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
 * JSON-LD (ef) is the source of truth for name and catalog when set.
 * If the context string contains [USER_SELECTED_OPTION], prefer AI price and unit when provided;
 * otherwise fill only gaps, including replacing generic "Each" unit when UCP/LD has no unit.
 * @param {object} merged - first pass from mergeProductFields
 * @param {object} fieldSources
 * @param {object} ex - full extraction result
 * @param {object|null} ai - { itemName, catalogNumber, price, unitSize }
 * @param {string} contextText
 */
function mergeExtractionWithAi(merged, fieldSources, ex, ai, contextText) {
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
    statusMessage: "Done. Use a wand to map any field that still needs text from the page (wait until the status shows this message)."
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
      statusMessage: "Reading JSON-LD, UCP meta, and .well-known data…"
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
    const needAi = hasBigFourGap(merged0) || hasProductVariantInScope();
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
    const mres = mergeExtractionWithAi(merged0, fieldSources, ex, ai, ctx);
    let merged = mres.merged;
    fieldSources = mres.fieldSources;
    let aiR = mres.aiRefined;
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
  var debounceT = null;
  var obs = new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var m = muts[i];
      for (var j = 0; j < m.addedNodes.length; j++) {
        if (qzcNodeMayAddJsonLd(m.addedNodes[j])) {
          if (debounceT) clearTimeout(debounceT);
          debounceT = setTimeout(function () {
            debounceT = null;
            void run();
          }, 450);
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
