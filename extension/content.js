console.log("[Quartzy Bridge] Content Script Loaded");

/** In-page state for the side panel only. JSON-LD / generic extraction, wand overrides, and user highlights. */
const CAPTURE_FIELD_KEYS = ["itemName", "catalogNumber", "price", "unitSize"];
const userTouched = { itemName: false, catalogNumber: false, price: false, unitSize: false };
const userValues = { itemName: "", catalogNumber: "", price: "", unitSize: "" };
let captureAutomated = { itemName: "", catalogNumber: "", price: "", unitSize: "" };
let exFieldSources = { itemName: null, catalogNumber: null, price: null, unitSize: null };
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

function vendorLabel() {
  const h = (window.location.hostname || "").toLowerCase();
  if (!h) return "Unknown vendor";
  return h.replace(/^www\./, "");
}

function extractionHasAnyField(ex) {
  if (!ex || !ex.fields) return false;
  const f = ex.fields;
  return CAPTURE_FIELD_KEYS.some((k) => isNonEmptyTrim(f[k]));
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

function applyExtractionSnapshot(merged, fieldSources) {
  captureAutomated = {
    itemName: (merged && merged.itemName) || "",
    catalogNumber: (merged && merged.catalogNumber) || "",
    price: (merged && merged.price) || "",
    unitSize: (merged && merged.unitSize) || ""
  };
  exFieldSources = fieldSources
    ? { ...fieldSources }
    : { itemName: null, catalogNumber: null, price: null, unitSize: null };
}

function resetCaptureState() {
  CAPTURE_FIELD_KEYS.forEach((k) => {
    userTouched[k] = false;
    userValues[k] = "";
  });
  captureAutomated = { itemName: "", catalogNumber: "", price: "", unitSize: "" };
  exFieldSources = { itemName: null, catalogNumber: null, price: null, unitSize: null };
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

function broadcastCurrentCapture() {
  const data = {
    ...displayCaptureFields(),
    url: window.location.href,
    vendor: vendorLabel(),
    fieldSources: fieldSourcesForUi()
  };
  chrome.runtime.sendMessage({ type: "PRODUCT_CAPTURE", data });
}

function applyAndBroadcastProduct(merged, fieldSources) {
  applyExtractionSnapshot(merged, fieldSources);
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
    onCapture: (text) => {
      const v = normalizeWandValue(key, text);
      if (!v) return;
      userTouched[key] = true;
      userValues[key] = v;
      captureAutomated = { ...captureAutomated, [key]: v };
      broadcastCurrentCapture();
    }
  });
  return true;
}

function emitBlankCapture() {
  applyExtractionSnapshot(
    { itemName: "", catalogNumber: "", price: "", unitSize: "" },
    { itemName: null, catalogNumber: null, price: null, unitSize: null }
  );
  broadcastCurrentCapture();
}

function run() {
  if (typeof QuartzyExtractionService === "undefined") {
    emitBlankCapture();
    return;
  }
  QuartzyExtractionService.run(document)
    .then((ex) => {
      if (!extractionHasAnyField(ex)) {
        emitBlankCapture();
        return;
      }
      const h1 = document.querySelector("h1")?.innerText?.trim() || document.title.split("|")[0].trim() || "";
      const ef = ex.fields || {};
      const catalogFromEx = isNonEmptyTrim(ef.catalogNumber) ? ef.catalogNumber : "";
      const priceFromEx = isNonEmptyTrim(ef.price) ? ef.price : "";
      const uDom = extractUnitSize();
      const merged = mergeProductFields(ex, {
        h1,
        unitFromDom: uDom,
        catalog: catalogFromEx,
        price: priceFromEx,
        vendor: vendorLabel()
      });
      applyAndBroadcastProduct(merged, ex && ex.fieldSources);
    })
    .catch((err) => {
      console.warn("[Quartzy Bridge] Extraction on page failed:", err && err.message);
      emitBlankCapture();
    });
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

// Initial run
run();
