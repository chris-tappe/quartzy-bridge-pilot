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
      const r = refineWandSelection(field, String(text), range);
      if (!r || !isNonEmptyTrim(r.value)) {
        return;
      }
      const all = readStore();
      if (!all.hosts[h]) all.hosts[h] = { fields: {} };
      all.hosts[h].fields[field] = {
        selector: r.selector,
        valueSample: String(r.value).trim().slice(0, 200),
        updatedAt: Date.now(),
        extract: r.extract || null
      };
      writeStore(all);
      return r.value;
    };
  }

  function isNonEmptyTrim(s) {
    return typeof s === "string" && s.trim().length > 0;
  }

  function normalizeWandText(s) {
    return String(s == null ? "" : s)
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Locates the selected string in a normalized full string (case-insensitive fallback).
   * @param {string} full
   * @param {string} needle
   * @returns {{ start: number, end: number }|null}
   */
  function findSelectionBoundsInFull(full, needle) {
    if (!isNonEmptyTrim(full) || !isNonEmptyTrim(needle)) {
      return null;
    }
    const f = normalizeWandText(full);
    const n = normalizeWandText(needle);
    let start = f.indexOf(n);
    if (start < 0) {
      start = f.toLowerCase().indexOf(n.toLowerCase());
    }
    if (start < 0) {
      return null;
    }
    return { start: start, end: start + n.length };
  }

  /**
   * When the user’s highlight is a prefix of the first “clause” (e.g. before a comma) in
   * a pack-size line, expand to the full clause (e.g. "Pkg" → "Pkg of 1").
   * @param {string} field
   * @param {string} fullNorm
   * @param {string} selNorm
   * @returns {{ expanded: string, extract: object }|null}
   */
  function tryExpandUnitSizeToFirstClause(fullNorm, selNorm) {
    const f = fullNorm;
    const s = selNorm;
    const com = f.indexOf(",");
    if (com < 0 || !s) {
      return null;
    }
    const firstClause = f.slice(0, com).trim();
    if (!firstClause) {
      return null;
    }
    if (s === firstClause) {
      return {
        expanded: firstClause,
        extract: { type: "toFirstDelimiter", delimiter: "," }
      };
    }
    if (firstClause.length > s.length && firstClause.indexOf(s) === 0) {
      return {
        expanded: firstClause,
        extract: { type: "toFirstDelimiter", delimiter: "," }
      };
    }
    return null;
  }

  /**
   * Chooses a saved extraction rule and the value to use right after the user releases the mouse.
   * @param {string} field
   * @param {string} rawText
   * @param {Range|null} range
   * @returns {{ value: string, extract: object|null, selector: string, el: Element|null }|null}
   */
  function refineWandSelection(field, rawText, range) {
    if (FIELDS.indexOf(field) === -1) {
      return null;
    }
    if (!isNonEmptyTrim(rawText)) {
      return null;
    }
    const el = anchorElementFromRange(range);
    if (!el) {
      return null;
    }
    const sel = buildCssPath(el);
    if (!sel) {
      return null;
    }
    const fullRaw = el.innerText != null ? el.innerText : el.textContent || "";
    const full = normalizeWandText(fullRaw);
    const nSel = normalizeWandText(rawText);
    if (!nSel) {
      return null;
    }

    if (full === nSel) {
      return {
        value: full,
        extract: { type: "entire" },
        selector: sel,
        el: el
      };
    }

    if (field === "unitSize") {
      const u = tryExpandUnitSizeToFirstClause(full, nSel);
      if (u) {
        return {
          value: u.expanded,
          extract: u.extract,
          selector: sel,
          el: el
        };
      }
    }

    const bounds = findSelectionBoundsInFull(full, nSel);
    if (bounds) {
      if (bounds.start === 0 && bounds.end === full.length) {
        return {
          value: full,
          extract: { type: "entire" },
          selector: sel,
          el: el
        };
      }
      return {
        value: nSel,
        extract: {
          type: "slice",
          start: bounds.start,
          end: bounds.end,
          sample: nSel.slice(0, 200)
        },
        selector: sel,
        el: el
      };
    }

    /* Selection doesn’t match innerText 1:1 (e.g. multiple nodes) — still save literal + selector. */
    return {
      value: nSel,
      extract: { type: "literal", sample: nSel.slice(0, 200) },
      selector: sel,
      el: el
    };
  }

  /**
   * Applies a stored extraction rule to the current text of the saved anchor node.
   * @param {string} field
   * @param {object} ent
   * @param {string} fullNorm
   * @returns {string}
   */
  function applyExtractToReadText(field, ent, fullNorm) {
    const f = fullNorm;
    const ex = ent && ent.extract;
    if (!ex || ex.type == null) {
      return f;
    }
    if (ex.type === "entire") {
      return f;
    }
    if (ex.type === "toFirstDelimiter" && (ex.delimiter === "," || ex.delimiter === ";")) {
      const d = ex.delimiter;
      const i = f.indexOf(d);
      if (i < 0) {
        return f;
      }
      return f.slice(0, i).trim();
    }
    if (ex.type === "slice" && ex.start != null) {
      const a = ex.start;
      const b = ex.end != null ? ex.end : f.length;
      if (a < 0 || a > f.length) {
        return f;
      }
      const s = f.slice(a, Math.min(b, f.length));
      if (isNonEmptyTrim(s)) {
        return s.trim();
      }
      const sample = (ex && ex.sample) || (ent && ent.valueSample) || "";
      if (isNonEmptyTrim(sample) && f.indexOf(sample) >= 0) {
        const again = findSelectionBoundsInFull(f, sample);
        if (again) {
          return f.slice(again.start, again.end).trim();
        }
      }
      return f;
    }
    if (ex.type === "literal" && isNonEmptyTrim(ex.sample)) {
      const p = f.indexOf(ex.sample);
      if (p >= 0) {
        return ex.sample;
      }
    }
    return f;
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
      const fullNorm = normalizeWandText(raw);
      return applyExtractToReadText(field, ent, fullNorm);
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

  /**
   * @returns {Record<string, { selector: string, valueSample?: string, updatedAt?: number, extract?: object }|null>}
   */
  function getStoredHintsForDebug() {
    const out = { itemName: null, catalogNumber: null, price: null, unitSize: null };
    const h = hostKey();
    if (!h) return out;
    const all = readStore();
    const rec = (all.hosts && all.hosts[h] && all.hosts[h].fields) || {};
    FIELDS.forEach((f) => {
      const e = rec[f];
      if (e && isNonEmptyTrim(e.selector)) {
        out[f] = { selector: e.selector, valueSample: e.valueSample, updatedAt: e.updatedAt, extract: e.extract || null };
      }
    });
    return out;
  }

  const DomFieldHints = {
    FIELDS,
    hostKey,
    buildCssPath,
    saveWandTarget,
    readTextForField,
    applySavedHints,
    getStoredHintsForDebug,
    refineWandSelection
  };

  global.QuartzyDomFieldHints = DomFieldHints;
})(typeof self !== "undefined" ? self : this);
