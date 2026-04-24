/**
 * On-device (Prompt API) or proxy-backed (Gemini 3 / backend) product field extraction.
 */
(function (global) {
  "use strict";

  const SYS =
    "You are a lab procurement specialist. Extract product details from the provided text. " +
    "If a field has a label like [USER_SELECTED_OPTION], prioritize that specific price and unit size. " +
    "Return ONLY a single JSON object, no markdown fences, with keys: " +
    "item_name, catalog_number, price, unit_size, currency. " +
    "Use null for unknown strings, null for price if not found. " +
    "price must be a number (no currency symbol) when known; unit_size is a short string (e.g. 100/Case).";

  function isNonEmptyString(v) {
    return typeof v === "string" && v.trim().length > 0;
  }

  function tryParseJsonObject(s) {
    if (!isNonEmptyString(s)) return null;
    const t = String(s).trim();
    if (!t) return null;
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const raw = fence && fence[1] ? fence[1].trim() : t;
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    const slice = raw.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch (e) {
      return null;
    }
  }

  function numberOrNull(n) {
    if (n == null || n === "") return null;
    if (typeof n === "number" && !Number.isNaN(n)) return n;
    const t = String(n).replace(/,/g, "").replace(/[^0-9.+-]/g, "");
    if (!t) return null;
    const v = parseFloat(t);
    return Number.isNaN(v) ? null : v;
  }

  function normalizeFromSchema(obj) {
    if (!obj || typeof obj !== "object") return null;
    const priceNum = numberOrNull(obj.price);
    const c =
      (obj.currency != null && isNonEmptyString(String(obj.currency)))
        ? String(obj.currency).trim()
        : null;
    return {
      item_name: isNonEmptyString(obj.item_name) ? String(obj.item_name).trim() : null,
      catalog_number: isNonEmptyString(obj.catalog_number) ? String(obj.catalog_number).trim() : null,
      price: priceNum,
      unit_size: isNonEmptyString(obj.unit_size) ? String(obj.unit_size).trim() : null,
      currency: c
    };
  }

  function toAppShape(norm) {
    if (!norm) return null;
    if (
      !norm.item_name &&
      !norm.catalog_number &&
      norm.price == null &&
      !norm.unit_size
    ) {
      return null;
    }
    let priceStr = "";
    if (norm.price != null && !Number.isNaN(norm.price)) {
      const cur = (norm.currency && norm.currency.length === 3 ? norm.currency : "USD") || "USD";
      try {
        priceStr = new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(
          norm.price
        );
      } catch (e) {
        priceStr = String(norm.price);
      }
    }
    return {
      itemName: norm.item_name || "",
      catalogNumber: norm.catalog_number || "",
      price: priceStr,
      unitSize: norm.unit_size || "",
      _raw: norm
    };
  }

  function buildUserPayload(contextText) {
    return (
      "Page text (sanitized) follows. " +
        "If [USER_SELECTED_OPTION] appears, use the price and unit near that mark.\n\n" + String(
          contextText || ""
        )).trim();
  }

  async function tryWindowAi(contextText) {
    const userBlock = buildUserPayload(contextText);
    if (!isNonEmptyString(userBlock) || userBlock.length < 10) return null;
    const p = String(SYS) + "\n\n" + userBlock;

    const tryOne = async (getText) => {
      let text = null;
      try {
        text = await getText();
      } catch (e) {
        return null;
      }
      if (text == null) return null;
      const t = typeof text === "string" ? text : (text && text.toString && text.toString()) || "";
      const o = tryParseJsonObject(t);
      if (!o) return null;
      const n = normalizeFromSchema({
        item_name: o.item_name,
        catalog_number: o.catalog_number,
        price: o.price,
        unit_size: o.unit_size,
        currency: o.currency
      });
      return toAppShape(n);
    };

    const g = global;
    if (g.LanguageModel && typeof g.LanguageModel.create === "function") {
      const r = await tryOne(async () => {
        const m = await g.LanguageModel.create();
        if (m && typeof m.prompt === "function") return await m.prompt(p);
        if (m && typeof m.run === "function") return await m.run(p);
        return null;
      });
      if (r) return r;
    }
    if (self.LanguageModel && typeof self.LanguageModel.create === "function") {
      const r = await tryOne(async () => {
        const m = await self.LanguageModel.create();
        if (m && typeof m.prompt === "function") return await m.prompt(p);
        if (m && typeof m.run === "function") return await m.run(p);
        return null;
      });
      if (r) return r;
    }
    if (self.ai && self.ai.languageModel && typeof self.ai.languageModel.create === "function") {
      const r = await tryOne(async () => {
        const s = await self.ai.languageModel.create();
        if (s && typeof s.prompt === "function") return await s.prompt(p);
        if (s && typeof s.run === "function") return await s.run(p);
        return null;
      });
      if (r) return r;
    }
    return null;
  }

  function sendToBackground(message) {
    return new Promise((resolve) => {
      try {
        if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
          resolve({ ok: false, error: "no_runtime" });
          return;
        }
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message || "lastError" });
            return;
          }
          resolve(response && typeof response === "object" ? response : { ok: false, error: "no_response" });
        });
      } catch (e) {
        resolve({ ok: false, error: (e && e.message) || "send_failed" });
      }
    });
  }

  /**
   * @param {string} contextText
   * @returns {Promise<{itemName: string, catalogNumber: string, price: string, unitSize: string, _raw?: object}|null>}
   */
  async function extractWithProxy(contextText) {
    const userBlock = buildUserPayload(contextText);
    if (!isNonEmptyString(userBlock) || userBlock.length < 10) return null;
    const r = await sendToBackground({ type: "AI_EXTRACT", contextText: userBlock, systemPrompt: SYS });
    if (!r || !r.ok || !r.parsed) return null;
    const n = normalizeFromSchema(r.parsed);
    return toAppShape(n);
  }

  /**
   * Tries in order: `window` Prompt/Gemini Nano, then `AI_EXTRACT` in the service worker.
   * @param {string} contextText
   * @param {{ skipBuiltin?: boolean }} [opts]
   */
  async function extractProductFromContext(contextText, opts) {
    const skipBuiltin = opts && opts.skipBuiltin;
    if (!skipBuiltin) {
      try {
        const first = await tryWindowAi(contextText);
        if (first) {
          return first;
        }
      } catch (e) {
        console.log("[Quartzy Bridge] on-device AI extraction failed:", e && e.message);
      }
    }
    const second = await extractWithProxy(contextText);
    if (second) {
      return second;
    }
    return null;
  }

  const AIExtractionService = {
    extractProductFromContext
  };

  global.QuartzyAIExtractionService = AIExtractionService;
})(typeof self !== "undefined" ? self : this);
