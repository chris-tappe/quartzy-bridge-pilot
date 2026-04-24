/**
 * Per-vendor (hostname) saved wand targets: CSS selector in page localStorage so the next
 * visit can re-read the same field from the DOM and override bad or missing JSON-LD.
 */
(function (global) {
  "use strict";

  const STORAGE_KEY = "quartzyConnect.domFieldHints.v1";
  const FIELDS = ["itemName", "catalogNumber", "price", "unitSize"];

  function hostKey() {
    return String(location && location.hostname ? location.hostname : "")
      .toLowerCase()
      .replace(/^www\./, "");
  }

  function readStore() {
    if (typeof localStorage === "undefined") return { version: 1, hosts: {} };
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { version: 1, hosts: {} };
      const o = JSON.parse(raw);
      if (!o || typeof o !== "object" || o.version !== 1) return { version: 1, hosts: {} };
      if (!o.hosts || typeof o.hosts !== "object") o.hosts = {};
      return o;
    } catch (e) {
      return { version: 1, hosts: {} };
    }
  }

  function writeStore(data) {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.log("[Quartzy Bridge] DomFieldHints: could not write localStorage:", e && e.message);
    }
  }

  /**
   * @param {Element} el
   * @returns {string|null}
   */
  function buildCssPath(el) {
    if (!el || el.nodeType !== 1 || el === document.documentElement) {
      if (el === document.documentElement) {
        return "html";
      }
      return null;
    }
    const parts = [];
    let n = el;
    for (let depth = 0; n && n.nodeType === 1 && depth < 32; n = n.parentElement, depth++) {
      if (n === document.body) {
        parts.unshift("body");
        break;
      }
      if (n === document.documentElement) {
        parts.unshift("html");
        break;
      }
      if (n.id && typeof n.id === "string" && /^[a-zA-Z][-a-zA-Z0-9_.:]*$/.test(n.id)) {
        const idSel = n.tagName.toLowerCase() + "#" + CSS.escape(n.id);
        parts.unshift(idSel);
        break;
      }
      const tag = n.tagName.toLowerCase();
      const par = n.parentElement;
      if (!par) break;
      const same = Array.prototype.filter.call(par.children, (c) => c.tagName === n.tagName);
      if (same.length > 1) {
        const idx = same.indexOf(n) + 1;
        parts.unshift(tag + ":nth-of-type(" + idx + ")");
      } else {
        parts.unshift(tag);
      }
    }
    if (!parts.length) return null;
    return parts.join(" > ");
  }

  /**
   * @param {Range} range
   * @returns {Element|null}
   */
  function anchorElementFromRange(range) {
    if (!range) return null;
    try {
      let n = range.commonAncestorContainer;
      if (n && n.nodeType === 3) {
        n = n.parentElement;
      }
      if (n && n.nodeType === 1) {
        return n;
      }
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  /**
   * @param {string} field
   * @param {string} text
   * @param {Range|null} range
   */
  function saveWandTarget(field) {
    return function (text, range) {
      if (FIELDS.indexOf(field) === -1) return;
      if (!isNonEmptyTrim(text)) return;
      const h = hostKey();
      if (!h) return;
      const el = anchorElementFromRange(range);
      const sel = el ? buildCssPath(el) : null;
      if (!sel) {
        return;
      }
      const all = readStore();
      if (!all.hosts[h]) all.hosts[h] = { fields: {} };
      all.hosts[h].fields[field] = {
        selector: sel,
        valueSample: String(text).trim().slice(0, 200),
        updatedAt: Date.now()
      };
      writeStore(all);
    };
  }

  function isNonEmptyTrim(s) {
    return typeof s === "string" && s.trim().length > 0;
  }

  /**
   * Returns raw text from the first matching node for a saved hint.
   * @param {string} field
   * @returns {string} trimmed text or ""
   */
  function readTextForField(field) {
    if (FIELDS.indexOf(field) === -1) return "";
    const h = hostKey();
    if (!h) return "";
    const all = readStore();
    const rec = (all.hosts && all.hosts[h] && all.hosts[h].fields) || null;
    const ent = rec && rec[field];
    if (!ent || !isNonEmptyTrim(ent.selector)) return "";
    try {
      const n = document.querySelector(ent.selector);
      if (!n) return "";
      const raw = n.innerText != null ? n.innerText : n.textContent || "";
      return String(raw).replace(/\s+/g, " ").trim();
    } catch (e) {
      return "";
    }
  }

  /**
   * Merges saved per-field DOM hints: user-trained selectors override prior extraction for that field.
   * @param {object} merged
   * @param {object} fieldSources
   * @param {(f: string, raw: string) => string} normalizeWandValue
   */
  function applySavedHints(merged, fieldSources, normalizeWandValue) {
    const m = { ...merged };
    const src = { ...fieldSources };
    FIELDS.forEach((f) => {
      const raw = readTextForField(f);
      if (!raw) return;
      const v = normalizeWandValue(f, raw);
      if (!v) return;
      m[f] = v;
      src[f] = "dom-hint";
    });
    return { merged: m, fieldSources: src };
  }

  const DomFieldHints = {
    FIELDS,
    hostKey,
    buildCssPath,
    saveWandTarget,
    readTextForField,
    applySavedHints
  };

  global.QuartzyDomFieldHints = DomFieldHints;
})(typeof self !== "undefined" ? self : this);
