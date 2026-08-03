/**
 * Per-vendor Certificate of Analysis (CoA) fetch configuration.
 *
 * Mirrors VENDOR_QUICK_ORDER in cartGenerator.js: hardcoded allowlist + aliases
 * until the remote vendor JSON engine lands.
 *
 * Usable from the service worker via importScripts.
 */
(function (root) {
  "use strict";

  /**
   * @typedef {{
   *   id: string,
   *   aliases: string[],
   *   strategy: 'documents_search'|'product_page',
   *   documentsSearchUrl: string,
   *   regionPath?: string
   * }} VendorCoaConfig
   */

  /** @type {Record<string, VendorCoaConfig>} */
  const VENDOR_COA = {
    sigma: {
      id: "sigma",
      aliases: [
        "sigma",
        "sigma-aldrich",
        "sigmaaldrich",
        "sigma aldrich",
        "millipore",
        "milliporesigma",
        "millipore sigma",
        "merck"
      ],
      strategy: "documents_search",
      documentsSearchUrl: "https://www.sigmaaldrich.com/US/en/documents-search?tab=coa",
      regionPath: "/US/en"
    }
  };

  /**
   * @param {string} vendorName
   * @returns {string}
   */
  function normalizeCoaVendorId(vendorName) {
    const raw = String(vendorName || "")
      .trim()
      .toLowerCase()
      .replace(/[_]+/g, " ");
    if (!raw) return "";
    const keys = Object.keys(VENDOR_COA);
    for (let i = 0; i < keys.length; i++) {
      const cfg = VENDOR_COA[keys[i]];
      if (cfg.id === raw) return cfg.id;
      for (let j = 0; j < cfg.aliases.length; j++) {
        if (raw === cfg.aliases[j] || raw.indexOf(cfg.aliases[j]) !== -1) {
          return cfg.id;
        }
      }
    }
    return raw.replace(/\s+/g, "");
  }

  /**
   * @param {string} vendorName
   * @returns {VendorCoaConfig|null}
   */
  function getVendorCoaConfig(vendorName) {
    const id = normalizeCoaVendorId(vendorName);
    return VENDOR_COA[id] || null;
  }

  /**
   * Build the documents-search URL, optionally pre-filling product number.
   * @param {VendorCoaConfig} cfg
   * @param {{ catalogNumber?: string, lotNumber?: string }} [opts]
   * @returns {string}
   */
  function buildCoaSearchUrl(cfg, opts) {
    opts = opts || {};
    if (!cfg || !cfg.documentsSearchUrl) return "";
    try {
      const u = new URL(cfg.documentsSearchUrl);
      u.searchParams.set("tab", "coa");
      const sku = String(opts.catalogNumber || "").trim();
      if (sku) u.searchParams.set("productNumber", sku);
      return u.toString();
    } catch (e) {
      return String(cfg.documentsSearchUrl);
    }
  }

  /**
   * Extract a catalog / product number from a Sigma (or similar) product URL.
   * @param {string} productUrl
   * @returns {string}
   */
  function catalogNumberFromProductUrl(productUrl) {
    const url = String(productUrl || "").trim();
    if (!url) return "";
    try {
      const path = new URL(url).pathname;
      /* /US/en/product/sial/322415 or /catalog/product/sial/322415 */
      let m = path.match(/\/product\/[^/]+\/([^/?#]+)/i);
      if (m && m[1]) return decodeURIComponent(m[1]);
      m = path.match(/\/catalog\/product\/[^/]+\/([^/?#]+)/i);
      if (m && m[1]) return decodeURIComponent(m[1]);
    } catch (e) {
      /* ignore */
    }
    return "";
  }

  const api = {
    VENDOR_COA: VENDOR_COA,
    normalizeCoaVendorId: normalizeCoaVendorId,
    getVendorCoaConfig: getVendorCoaConfig,
    buildCoaSearchUrl: buildCoaSearchUrl,
    catalogNumberFromProductUrl: catalogNumberFromProductUrl
  };

  if (typeof root !== "undefined" && root) {
    Object.keys(api).forEach(function (k) {
      root[k] = api[k];
    });
  }
  if (typeof self !== "undefined" && self && self !== root) {
    Object.keys(api).forEach(function (k) {
      self[k] = api[k];
    });
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
