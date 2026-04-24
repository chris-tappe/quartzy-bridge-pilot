/**
 * JSON-LD / UCP structured extraction with display-safe product text and unit size
 * (including eligibleQuantity.unitText, e.g. "Case of 100").
 */
(function (global) {
  "use strict";

  const FIELDS = ["itemName", "catalogNumber", "price", "unitSize"];

  function isNonEmptyString(v) {
    return typeof v === "string" && v.trim().length > 0;
  }

  /**
   * Decodes HTML entities; repeat until stable (handles &amp;trade; style double encoding in JSON).
   * @param {string} str
   */
  function decodeHtmlEntitiesToText(str) {
    let s = String(str);
    if (typeof document === "undefined") return s;
    const ta = document.createElement("textarea");
    for (let i = 0; i < 8; i++) {
      ta.innerHTML = s;
      const next = ta.value;
      if (next === s) break;
      s = next;
    }
    return s;
  }

  /**
   * Strips display-only symbols and normalizes space after entity decode.
   * e.g. Corning&amp;trade;&amp;nbsp;Stripette&amp;trade; ... => Corning Stripette ...
   * @param {string} str
   * @param {{ light?: boolean }} [opts] light: only decode + whitespace (keep ± etc.)
   */
  function cleanProductText(str, opts) {
    if (str == null) return "";
    const light = opts && opts.light;
    let s = decodeHtmlEntitiesToText(String(str));
    if (!light) {
      s = s
        .replace(/[\u2122\u00AE\u00A9\u200B-\u200D\uFEFF\u00AD]/g, "")
        .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
    }
    s = s.replace(/\s+/g, " ").trim();
    return s;
  }

  function normalizePrice(input) {
    if (input == null) return "";
    if (typeof input === "number" && !Number.isNaN(input)) {
      return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(input);
    }
    const s0 = String(input).trim();
    if (!s0) return "";
    const t = cleanProductText(s0, { light: true });
    if (t.startsWith("$") || t.startsWith("€") || t.startsWith("£")) return t;
    const n = parseFloat(t.replace(/[^0-9.]/g, ""));
    if (!Number.isNaN(n)) {
      return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
    }
    return t;
  }

  function visitJsonLdNode(node, out, src) {
    if (node == null) return;
    if (Array.isArray(node)) {
      node.forEach((n) => visitJsonLdNode(n, out, src));
      return;
    }
    if (typeof node !== "object") return;

    const type = node["@type"];
    const types = Array.isArray(type) ? type : type ? [type] : [];
    const isProduct = types.some(
      (t) => typeof t === "string" && (t === "Product" || t.endsWith("/Product") || t.includes("Product"))
    );
    const isOffer = types.some(
      (t) =>
        typeof t === "string" &&
        (t === "Offer" || t === "AggregateOffer" || t.endsWith("/Offer") || t.includes("Offer"))
    );

    if (isProduct) {
      if (!isNonEmptyString(out.itemName)) {
        const name = node.name || node.title;
        if (isNonEmptyString(name)) {
          out.itemName = cleanProductText(String(name).trim());
          if (!src.itemName) src.itemName = "json-ld:Product";
        }
      }
      if (!isNonEmptyString(out.catalogNumber)) {
        const sku = node.sku || node.productID || (node.mpn && String(node.mpn));
        if (isNonEmptyString(sku)) {
          out.catalogNumber = cleanProductText(String(sku).trim());
          if (!src.catalogNumber) src.catalogNumber = "json-ld:Product.sku|productID";
        }
        const gtin = node.gtin || node.gtin13 || node.gtin8 || node.gtin12 || node.gtin14;
        if (!isNonEmptyString(out.catalogNumber) && isNonEmptyString(gtin)) {
          out.catalogNumber = cleanProductText(String(gtin).trim());
          if (!src.catalogNumber) src.catalogNumber = "json-ld:Product.gtin";
        }
      }
      if (!isNonEmptyString(out.itemName) && isNonEmptyString(node.description)) {
        const d = cleanProductText(String(node.description).replace(/\s+/g, " ").trim());
        if (d.length > 3 && d.length < 500) {
          out.itemName = d;
          if (!src.itemName) src.itemName = "json-ld:Product.description";
        }
      }
      if (!isNonEmptyString(out.unitSize)) {
        const props = node.additionalProperty;
        const arr = Array.isArray(props) ? props : props ? [props] : [];
        for (const p of arr) {
          const n = p && (p.name || p.propertyID);
          const v = p && p.value;
          if (
            v &&
            typeof n === "string" &&
            /uom|unit|pack|size|case|each|per|quantity/i.test(n) &&
            isNonEmptyString(v)
          ) {
            out.unitSize = cleanProductText(String(v).trim());
            if (!src.unitSize) src.unitSize = "json-ld:Product.additionalProperty";
            break;
          }
        }
      }
    }

    if (isOffer && isProduct === false) {
      if (!isNonEmptyString(out.price)) {
        const price = node.price != null ? node.price : node.lowPrice != null ? node.lowPrice : node.highPrice;
        const np = normalizePrice(price);
        if (np) {
          out.price = np;
          if (!src.price) src.price = "json-ld:Offer.price";
        }
      }
    }

    if (isProduct && node.offers != null) {
      const offers = node.offers;
      const olist = Array.isArray(offers) ? offers : [offers];
      for (const o of olist) {
        if (!o || typeof o !== "object") continue;
        visitJsonLdNode(o, out, src);
        if (!isNonEmptyString(out.price) && o.price != null) {
          const np = normalizePrice(o.price);
          if (np) {
            out.price = np;
            if (!src.price) src.price = "json-ld:Product.offers";
          }
        }
        if (!isNonEmptyString(out.unitSize) && o.eligibleQuantity != null) {
          const eli = o.eligibleQuantity;
          if (typeof eli === "object" && isNonEmptyString(eli.unitText)) {
            out.unitSize = cleanProductText(String(eli.unitText).trim());
            if (!src.unitSize) src.unitSize = "json-ld:eligibleQuantity.unitText";
          } else if (typeof eli === "object" && eli.value != null && !isNonEmptyString(out.unitSize)) {
            out.unitSize = cleanProductText("Qty " + String(eli.value).trim());
            if (!src.unitSize) src.unitSize = "json-ld:Offer.eligibleQuantity.value";
          }
        }
        if (!isNonEmptyString(out.unitSize) && o.priceSpecification && typeof o.priceSpecification === "object") {
          const u = o.priceSpecification.unitText || (o.priceSpecification.eligibleQuantity && o.priceSpecification.eligibleQuantity.unitText);
          if (isNonEmptyString(u)) {
            out.unitSize = cleanProductText(String(u).trim());
            if (!src.unitSize) src.unitSize = "json-ld:priceSpecification.unitText";
          }
        }
      }
    }

    for (const key of Object.keys(node)) {
      if (key === "@context" || key === "@id") continue;
      visitJsonLdNode(node[key], out, src);
    }
  }

  function parseJsonLdFromDocument(doc) {
    const out = { itemName: "", catalogNumber: "", price: "", unitSize: "" };
    const src = { itemName: null, catalogNumber: null, price: null, unitSize: null };
    const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
    scripts.forEach((script) => {
      const raw = script.textContent && script.textContent.trim();
      if (!raw) return;
      try {
        const data = JSON.parse(raw);
        visitJsonLdNode(data, out, src);
      } catch (e) {
        console.log("[Quartzy Connect] JSON-LD parse failed:", e && e.message);
      }
    });
    FIELDS.forEach((f) => {
      if (isNonEmptyString(out[f]) && f !== "price") {
        if (f === "catalogNumber") {
          out[f] = cleanProductText(String(out[f]).trim(), { light: true });
        } else {
          out[f] = cleanProductText(String(out[f]).trim());
        }
      } else if (f === "price" && isNonEmptyString(out[f])) {
        out[f] = normalizePrice(out[f]);
      }
    });
    return { fields: out, fieldSources: src };
  }

  function collectUcpMetaFromDocument(doc) {
    const ucp = {};
    doc.querySelectorAll("meta").forEach((m) => {
      const name = m.getAttribute("name") || "";
      const property = m.getAttribute("property") || "";
      const key = name || property;
      if (!key || !/^ucp[:\-]/i.test(key)) return;
      const c = m.getAttribute("content");
      if (c && c.trim()) ucp[key] = c.trim();
    });
    return ucp;
  }

  function applyUcpMeta(ucp, out, src) {
    Object.keys(ucp).forEach((k) => {
      const v = ucp[k];
      const low = k.toLowerCase();
      if (!isNonEmptyString(v)) return;
      if (!isNonEmptyString(out.itemName) && /title|name|product|description/i.test(low)) {
        out.itemName = cleanProductText(String(v).trim());
        if (!src.itemName) src.itemName = "ucp:" + k;
      }
      if (!isNonEmptyString(out.catalogNumber) && /sku|id|mpn|gtin|part/i.test(low)) {
        out.catalogNumber = cleanProductText(String(v).trim());
        if (!src.catalogNumber) src.catalogNumber = "ucp:" + k;
      }
      if (!isNonEmptyString(out.price) && /price|amount|cost/i.test(low)) {
        const np = normalizePrice(v);
        if (np) {
          out.price = np;
          if (!src.price) src.price = "ucp:" + k;
        }
      }
      if (!isNonEmptyString(out.unitSize) && /uom|unit|pack|size|case|quantity/i.test(low)) {
        out.unitSize = cleanProductText(String(v).trim());
        if (!src.unitSize) src.unitSize = "ucp:" + k;
      }
    });
  }

  function applyUcpWellKnownJson(ucpJson, out, src) {
    if (!ucpJson || typeof ucpJson !== "object") return;
    const o = ucpJson;
    const product = o.product || o.currentProduct || o.item || o.catalog;
    if (product && typeof product === "object") {
      if (!isNonEmptyString(out.itemName) && isNonEmptyString(product.name)) {
        out.itemName = cleanProductText(String(product.name).trim());
        if (!src.itemName) src.itemName = "ucp-well-known";
      }
      if (!isNonEmptyString(out.catalogNumber) && (product.sku != null || product.id != null)) {
        out.catalogNumber = cleanProductText(String(product.sku != null ? product.sku : product.id).trim());
        if (!src.catalogNumber) src.catalogNumber = "ucp-well-known";
      }
      if (!isNonEmptyString(out.price) && (product.price != null || product.listPrice != null)) {
        const raw = product.price != null ? product.price : product.listPrice;
        const p2 = normalizePrice(raw);
        if (p2) {
          out.price = p2;
          if (!src.price) src.price = "ucp-well-known";
        }
      }
    }
  }

  function mergePreferExisting(base, add, baseSrc, addSrc) {
    FIELDS.forEach((f) => {
      if (!isNonEmptyString(base[f]) && isNonEmptyString(add[f])) {
        base[f] = add[f];
        if (!baseSrc[f] && addSrc[f]) baseSrc[f] = addSrc[f];
      }
    });
  }

  function extractFromDocument(doc) {
    const a = parseJsonLdFromDocument(doc);
    const ucpMeta = collectUcpMetaFromDocument(doc);
    if (Object.keys(ucpMeta).length) {
      const ucpOut = { ...a.fields };
      const ucpSrc = { ...a.fieldSources };
      applyUcpMeta(ucpMeta, ucpOut, ucpSrc);
      mergePreferExisting(a.fields, ucpOut, a.fieldSources, ucpSrc);
    }
    return { fields: a.fields, fieldSources: a.fieldSources };
  }

  async function mergeUcpWellKnownInto(acc) {
    const base = typeof location !== "undefined" ? location.origin : "";
    if (!base) return;
    const url = base.replace(/\/$/, "") + "/.well-known/ucp";
    let res;
    try {
      res = await fetch(url, { credentials: "same-origin", mode: "cors" });
    } catch (e) {
      return;
    }
    if (!res || !res.ok) return;
    const ct = res.headers.get("content-type") || "";
    if (!/json/i.test(ct) && res.status !== 200) return;
    try {
      const json = await res.json();
      const next = { fields: { ...acc.fields }, fieldSources: { ...acc.fieldSources } };
      applyUcpWellKnownJson(json, next.fields, next.fieldSources);
      mergePreferExisting(acc.fields, next.fields, acc.fieldSources, next.fieldSources);
    } catch (e) {
      console.log("[Quartzy Connect] .well-known/ucp not JSON or parse error");
    }
  }

  const ExtractionService = {
    FIELDS,
    cleanProductText,
    extractFromDocument,
    async run(doc) {
      const d = doc || (typeof document !== "undefined" ? document : null);
      if (!d) {
        return {
          fields: { itemName: "", catalogNumber: "", price: "", unitSize: "" },
          fieldSources: { itemName: null, catalogNumber: null, price: null, unitSize: null }
        };
      }
      const acc = extractFromDocument(d);
      try {
        await mergeUcpWellKnownInto(acc);
      } catch (e) {
        /* ignore */
      }
      return acc;
    }
  };

  global.QuartzyExtractionService = ExtractionService;
})(typeof self !== "undefined" ? self : this);
