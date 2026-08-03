try {
  importScripts("featureFlags.js");
} catch (e) {
  console.error("[Quartzy Connect] featureFlags import failed:", e);
}

try {
  importScripts("cartGenerator.js");
} catch (e) {
  console.error("[Quartzy Connect] cartGenerator import failed:", e);
}

try {
  importScripts("coaConfig.js");
} catch (e) {
  console.error("[Quartzy Connect] coaConfig import failed:", e);
}

// Open side panel when the user clicks the extension icon (Manifest V3 sidePanel + action).
try {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("[Quartzy Connect] setPanelBehavior:", err));
} catch (e) {
  console.error("[Quartzy Connect] sidePanel API:", e);
}

/**
 * Optional: POST to your server that calls Gemini 3 Flash (or equivalent) and returns
 * a JSON object with keys: item_name, catalog_number, price, unit_size, currency.
 * Add the origin to manifest `host_permissions` and set the URL in code or storage.
 */
const AI_EXTRACT_PROXY_URL = "";

/** Dev-only Fetch Price test tool. Keep false for customer builds (see featureFlags.js). */
const FETCH_PRICE_TEST_ENABLED =
  typeof QUARTZY_FETCH_PRICE_TEST_ENABLED !== "undefined" && QUARTZY_FETCH_PRICE_TEST_ENABLED === true;

/** Quick Order cart stuffing (Fisher/Bio-Rad line form; VWR/Sigma CSV/XLSX file drop). */
const CART_STUFFING_ENABLED =
  typeof QUARTZY_CART_STUFFING_ENABLED !== "undefined" && QUARTZY_CART_STUFFING_ENABLED === true;

/** Inventory Fetch CoA (vendor documents search → PDF → attach on Quartzy). */
const FETCH_COA_ENABLED =
  typeof QUARTZY_FETCH_COA_ENABLED !== "undefined" && QUARTZY_FETCH_COA_ENABLED === true;

const FETCH_COA_TAB_TIMEOUT_MS = 45000;
const FETCH_COA_PDF_TIMEOUT_MS = 30000;

/** Errors from vendorCartInjector that warrant a short retry while the SPA paints. */
const CART_STUFF_RETRYABLE_ERRORS = {
  file_input_not_found: true,
  form_row_not_found: true
};

const FETCH_PRICE_TIMEOUT_MS = 40000;
const CART_STUFF_TAB_TIMEOUT_MS = 45000;

/**
 * Known session-cookie name fragments per vendor hostname (extend over time).
 * Presence → tentative logged_in; absence of any known name → logged_out.
 * @type {Record<string, string[]>}
 */
const VENDOR_SESSION_COOKIE_NAMES = {
  "fishersci.com": ["JSESSIONID", "SESSION", "rememberMe", "FSID", "BIGipServer"],
  "thermofisher.com": ["JSESSIONID", "SESSION", "rememberMe", "TFSID"],
  "vwr.com": ["JSESSIONID", "SESSION", "remember-me", "AWSELB"],
  "us.vwr.com": ["JSESSIONID", "SESSION", "remember-me"],
  "sigmaaldrich.com": ["JSESSIONID", "SESSION", "rememberMe"],
  "milliporesigma.com": ["JSESSIONID", "SESSION", "rememberMe"],
  "abcam.com": ["session", "SESSION", "remember_user_token", "_abcam"],
  "thomasci.com": ["JSESSIONID", "SESSION"],
  "avantorsciences.com": ["JSESSIONID", "SESSION"],
  "bio-rad.com": ["JSESSIONID", "SESSION", "rememberMe", "BIGipServer"],
  "commerce.bio-rad.com": ["JSESSIONID", "SESSION", "rememberMe"]
};

/**
 * @typedef {{
 *   catalogNumber?: string,
 *   cookieLoginPromise: Promise<'logged_in'|'logged_out'|'unknown'>,
 *   requestUrl: string,
 *   resolve: Function,
 *   settled: boolean,
 *   scrapeStarted: boolean,
 *   timeoutId: ReturnType<typeof setTimeout>|null,
 *   debug: object
 * }} FetchPriceJob
 */
/** @type {Map<number, FetchPriceJob>} */
const fetchPriceJobs = new Map();

/**
 * @returns {{ t0: number, steps: Array<{ t: number, step: string, detail?: object }> }}
 */
function createBgDebugLog() {
  return { t0: Date.now(), steps: [] };
}

/**
 * @param {object} log
 * @param {string} step
 * @param {object} [detail]
 */
function bgDebug(log, step, detail) {
  if (!log) return;
  const entry = { t: Date.now() - (log.t0 || Date.now()), step: step };
  if (detail != null) {
    entry.detail = detail;
  }
  log.steps.push(entry);
  try {
    console.log("[Quartzy FetchPrice:bg]", step, detail != null ? detail : "");
  } catch (e) {
    /* ignore */
  }
}

/**
 * Cookie check that also returns which names matched (for debug; values never logged).
 * @param {string} url
 * @returns {Promise<{ state: 'logged_in'|'logged_out'|'unknown', host: string, namesChecked: string[], matchedNames: string[], cookieCount: number }>}
 */
async function checkLoginFromCookiesDetailed(url) {
  const host = hostnameOf(url);
  const empty = {
    state: /** @type {'unknown'} */ ("unknown"),
    host: host,
    namesChecked: [],
    matchedNames: [],
    cookieCount: 0
  };
  if (!host || !chrome.cookies || typeof chrome.cookies.getAll !== "function") {
    return empty;
  }
  const names = sessionCookieNamesForHost(host);
  empty.namesChecked = names.slice();
  if (!names.length) {
    return empty;
  }
  try {
    let cookies = await chrome.cookies.getAll({ domain: host });
    let domainUsed = host;
    if (!cookies || !cookies.length) {
      const parts = host.split(".");
      if (parts.length > 2) {
        const parent = parts.slice(-2).join(".");
        cookies = await chrome.cookies.getAll({ domain: parent });
        domainUsed = parent;
      }
    }
    const list = cookies || [];
    const matched = [];
    const lowerNames = names.map((n) => String(n).toLowerCase());
    for (let i = 0; i < list.length; i++) {
      const cn = String(list[i].name || "").toLowerCase();
      for (let j = 0; j < lowerNames.length; j++) {
        const needle = lowerNames[j];
        /* Exact match always; substring only for distinctive names (avoid "session" → Hotjar _hjSession*). */
        const nameHit =
          cn === needle ||
          ((needle.length >= 8 || needle.indexOf("-") !== -1 || needle.indexOf("_") !== -1) &&
            cn.indexOf(needle) !== -1);
        if (nameHit && list[i].value != null && String(list[i].value).length > 0) {
          matched.push(list[i].name);
          break;
        }
      }
    }
    return {
      state: matched.length ? "logged_in" : "logged_out",
      host: domainUsed,
      namesChecked: names.slice(),
      matchedNames: matched,
      cookieCount: list.length
    };
  } catch (e) {
    console.log("[Quartzy Connect] cookie login check failed:", e && e.message);
    return Object.assign(empty, { state: "unknown", error: (e && e.message) || "cookie_error" });
  }
}

function parseJsonFromString(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t) return null;
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch (e) {
    return null;
  }
}

/**
 * @param {string} url
 * @returns {string}
 */
function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch (e) {
    return "";
  }
}

/**
 * @param {string} host
 * @returns {string[]}
 */
function sessionCookieNamesForHost(host) {
  if (!host) return [];
  if (VENDOR_SESSION_COOKIE_NAMES[host]) {
    return VENDOR_SESSION_COOKIE_NAMES[host];
  }
  const keys = Object.keys(VENDOR_SESSION_COOKIE_NAMES);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (host === k || host.endsWith("." + k)) {
      return VENDOR_SESSION_COOKIE_NAMES[k];
    }
  }
  return ["JSESSIONID", "SESSION", "session", "rememberMe", "remember_me", "auth_token", "sid"];
}

/**
 * Cookie-based login check (parallel with tab load). Does not prove an active price-eligible session.
 * @param {string} url
 * @returns {Promise<'logged_in'|'logged_out'|'unknown'>}
 */
async function checkLoginFromCookies(url) {
  const d = await checkLoginFromCookiesDetailed(url);
  return d.state;
}

/**
 * DOM heuristic wins when confident; else cookie; else unknown.
 * @param {'logged_in'|'logged_out'|'unknown'|undefined} fromDom
 * @param {'logged_in'|'logged_out'|'unknown'|undefined} fromCookies
 * @returns {'logged_in'|'logged_out'|'unknown'}
 */
function resolveLoginState(fromDom, fromCookies) {
  if (fromDom === "logged_in" || fromDom === "logged_out") {
    return fromDom;
  }
  if (fromCookies === "logged_in" || fromCookies === "logged_out") {
    return fromCookies;
  }
  return "unknown";
}

/**
 * Merge background + content debug into one pasteable object.
 * @param {object} jobDebug
 * @param {object|null|undefined} contentDebug
 * @param {object} outcome
 * @returns {object}
 */
function buildFetchPriceDebugBundle(jobDebug, contentDebug, outcome) {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    request: (jobDebug && jobDebug.request) || null,
    background: {
      steps: (jobDebug && jobDebug.steps) || [],
      durationMs: jobDebug && jobDebug.t0 != null ? Date.now() - jobDebug.t0 : null,
      cookieCheck: (jobDebug && jobDebug.cookieCheck) || null,
      tabId: (jobDebug && jobDebug.tabId) != null ? jobDebug.tabId : null
    },
    content: contentDebug || null,
    outcome: outcome
  };
}

/**
 * @param {number} tabId
 */
function removeFetchPriceTab(tabId) {
  if (tabId == null) return;
  try {
    chrome.tabs.remove(tabId).catch(function () {
      /* already closed */
    });
  } catch (e) {
    /* ignore */
  }
}

/**
 * @param {number} tabId
 * @param {object} payload
 */
function finishFetchPriceJob(tabId, payload) {
  const job = fetchPriceJobs.get(tabId);
  if (!job || job.settled) {
    removeFetchPriceTab(tabId);
    return;
  }
  job.settled = true;
  if (job.timeoutId != null) {
    clearTimeout(job.timeoutId);
    job.timeoutId = null;
  }
  fetchPriceJobs.delete(tabId);
  removeFetchPriceTab(tabId);
  try {
    job.resolve(payload);
  } catch (e) {
    /* ignore */
  }
}

/**
 * @param {string} url
 * @param {string|undefined} catalogNumber
 * @returns {Promise<object>}
 */
async function runFetchPriceRequest(url, catalogNumber) {
  const debug = createBgDebugLog();
  debug.request = {
    url: url != null ? String(url) : "",
    catalogNumber: catalogNumber != null ? String(catalogNumber) : "",
    timeoutMs: FETCH_PRICE_TIMEOUT_MS
  };
  bgDebug(debug, "request_received", debug.request);

  if (!FETCH_PRICE_TEST_ENABLED) {
    return {
      type: "FETCH_PRICE_DONE",
      ok: false,
      error: "feature_disabled",
      errorMessage: "Fetch Price test tool is disabled.",
      loginState: "unknown",
      mode: "single",
      variants: [],
      debug: buildFetchPriceDebugBundle(debug, null, { ok: false, error: "feature_disabled" })
    };
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(String(url).trim());
  } catch (e) {
    bgDebug(debug, "invalid_url", { message: (e && e.message) || "parse_error" });
    return {
      type: "FETCH_PRICE_DONE",
      ok: false,
      error: "invalid_url",
      errorMessage: "Enter a valid http(s) product URL.",
      loginState: "unknown",
      mode: "single",
      variants: [],
      debug: buildFetchPriceDebugBundle(debug, null, { ok: false, error: "invalid_url" })
    };
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    bgDebug(debug, "invalid_url", { protocol: parsedUrl.protocol });
    return {
      type: "FETCH_PRICE_DONE",
      ok: false,
      error: "invalid_url",
      errorMessage: "URL must be http or https.",
      loginState: "unknown",
      mode: "single",
      variants: [],
      debug: buildFetchPriceDebugBundle(debug, null, { ok: false, error: "invalid_url" })
    };
  }

  debug.request.url = parsedUrl.href;
  debug.request.host = hostnameOf(parsedUrl.href);

  const cookieDetailPromise = checkLoginFromCookiesDetailed(parsedUrl.href);
  const cookieLoginPromise = cookieDetailPromise.then(function (d) {
    debug.cookieCheck = {
      state: d.state,
      host: d.host,
      namesChecked: d.namesChecked,
      matchedNames: d.matchedNames,
      cookieCount: d.cookieCount
    };
    bgDebug(debug, "cookie_login_check", debug.cookieCheck);
    return d.state;
  });

  let tab;
  try {
    tab = await chrome.tabs.create({ url: parsedUrl.href, active: false });
    bgDebug(debug, "tab_created", { tabId: tab && tab.id, active: false, url: parsedUrl.href });
  } catch (e) {
    bgDebug(debug, "tab_create_failed", { message: (e && e.message) || String(e) });
    return {
      type: "FETCH_PRICE_DONE",
      ok: false,
      error: "tab_create_failed",
      errorMessage: (e && e.message) || "Could not open background tab.",
      loginState: await cookieLoginPromise,
      mode: "single",
      variants: [],
      debug: buildFetchPriceDebugBundle(debug, null, { ok: false, error: "tab_create_failed" })
    };
  }
  const tabId = tab.id;
  if (tabId == null) {
    bgDebug(debug, "tab_create_failed", { reason: "no_tab_id" });
    return {
      type: "FETCH_PRICE_DONE",
      ok: false,
      error: "tab_create_failed",
      errorMessage: "No tab id from chrome.tabs.create.",
      loginState: await cookieLoginPromise,
      mode: "single",
      variants: [],
      debug: buildFetchPriceDebugBundle(debug, null, { ok: false, error: "tab_create_failed" })
    };
  }
  debug.tabId = tabId;

  return new Promise(function (resolve) {
    const job = {
      catalogNumber: catalogNumber,
      cookieLoginPromise: cookieLoginPromise,
      requestUrl: parsedUrl.href,
      resolve: resolve,
      settled: false,
      scrapeStarted: false,
      timeoutId: null,
      debug: debug
    };
    fetchPriceJobs.set(tabId, job);
    job.timeoutId = setTimeout(function () {
      void (async function () {
        const cookieLogin = await cookieLoginPromise;
        bgDebug(debug, "timeout", { timeoutMs: FETCH_PRICE_TIMEOUT_MS, scrapeStarted: job.scrapeStarted });
        finishFetchPriceJob(tabId, {
          type: "FETCH_PRICE_DONE",
          ok: false,
          error: "timeout",
          errorMessage: "Timed out waiting for the page to load and scrape (18s).",
          loginState: resolveLoginState("unknown", cookieLogin),
          mode: "single",
          variants: [],
          url: parsedUrl.href,
          debug: buildFetchPriceDebugBundle(debug, null, {
            ok: false,
            error: "timeout",
            loginState: resolveLoginState("unknown", cookieLogin)
          })
        });
      })();
    }, FETCH_PRICE_TIMEOUT_MS);

    /* If the tab was already complete (rare), scrape immediately. */
    chrome.tabs.get(tabId).then(function (t) {
      if (t && t.status === "complete" && fetchPriceJobs.has(tabId)) {
        bgDebug(debug, "tab_already_complete", { tabUrl: t.url || null });
        void scrapeFetchPriceTab(tabId);
      }
    }).catch(function () {
      /* ignore */
    });
  });
}

/**
 * @param {object|null|undefined} response
 * @returns {boolean}
 */
function fetchPriceResponseHasUsablePrice(response) {
  if (!response) {
    return false;
  }
  if (response.baseline && String(response.baseline.price || "").trim()) {
    return true;
  }
  const variants = response.variants;
  if (!Array.isArray(variants)) {
    return false;
  }
  for (let i = 0; i < variants.length; i++) {
    if (variants[i] && String(variants[i].price || "").trim()) {
      return true;
    }
  }
  return false;
}

/**
 * @param {number} tabId
 */
async function scrapeFetchPriceTab(tabId) {
  const job = fetchPriceJobs.get(tabId);
  if (!job || job.settled || job.scrapeStarted) {
    return;
  }
  job.scrapeStarted = true;
  const requestUrl = job.requestUrl;
  const catalogNumber = job.catalogNumber;
  const debug = job.debug || createBgDebugLog();
  bgDebug(debug, "tab_complete_scrape_start", { tabId: tabId, requestUrl: requestUrl });

  let tabMeta = null;
  try {
    const t = await chrome.tabs.get(tabId);
    tabMeta = { status: t.status, url: t.url || null, title: t.title || null };
    bgDebug(debug, "tab_meta", tabMeta);
  } catch (e) {
    bgDebug(debug, "tab_meta_error", { message: (e && e.message) || String(e) });
  }

  let cookieLogin = "unknown";
  try {
    cookieLogin = await job.cookieLoginPromise;
  } catch (e) {
    cookieLogin = "unknown";
  }

  let response = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (!fetchPriceJobs.has(tabId) || (fetchPriceJobs.get(tabId) && fetchPriceJobs.get(tabId).settled)) {
      return;
    }
    bgDebug(debug, "send_FETCH_PRICE_SCRAPE", { attempt: attempt + 1, catalogNumber: catalogNumber || "" });
    try {
      response = await chrome.tabs.sendMessage(tabId, {
        type: "FETCH_PRICE_SCRAPE",
        catalogNumber: catalogNumber || ""
      });
      if (response) {
        const hasPrice = fetchPriceResponseHasUsablePrice(response);
        bgDebug(debug, "content_response", {
          ok: response.ok,
          error: response.error || null,
          mode: response.mode,
          variantCount: Array.isArray(response.variants) ? response.variants.length : 0,
          hasPrice: hasPrice,
          loginStateDom: response.loginState,
          pageUrl: response.pageUrl || null
        });
        /* Content script already waits for SPA hydration; only re-send if still empty and no blocker. */
        if (hasPrice || response.error || attempt >= 2) {
          break;
        }
        bgDebug(debug, "empty_price_bg_retry", { attempt: attempt + 1, waitMs: 1500 });
        await new Promise(function (r) {
          setTimeout(r, 1500);
        });
        continue;
      }
    } catch (e) {
      lastErr = e;
      bgDebug(debug, "content_message_error", {
        attempt: attempt + 1,
        message: (e && e.message) || String(e)
      });
      await new Promise(function (r) {
        setTimeout(r, 400);
      });
    }
  }

  if (!response) {
    const loginState = resolveLoginState("unknown", cookieLogin);
    finishFetchPriceJob(tabId, {
      type: "FETCH_PRICE_DONE",
      ok: false,
      error: "page_load_failed",
      errorMessage:
        (lastErr && lastErr.message) ||
        "Content script did not respond. The page may have failed to load or blocked the extension.",
      loginState: loginState,
      mode: "single",
      variants: [],
      url: requestUrl,
      debug: buildFetchPriceDebugBundle(debug, null, {
        ok: false,
        error: "page_load_failed",
        loginState: loginState,
        tabMeta: tabMeta
      })
    });
    return;
  }

  const loginState = resolveLoginState(response.loginState, cookieLogin);
  bgDebug(debug, "login_resolved", {
    fromDom: response.loginState,
    fromCookies: cookieLogin,
    resolved: loginState
  });
  const outcome = {
    ok: response.ok !== false && !response.error,
    error: response.error || null,
    mode: response.mode || "single",
    variantCount: Array.isArray(response.variants) ? response.variants.length : 0,
    loginState: loginState,
    pageUrl: response.pageUrl || requestUrl,
    pageTitle: response.pageTitle || "",
    variants: Array.isArray(response.variants)
      ? response.variants.map(function (v) {
          return {
            label: v.label,
            catalogNumber: v.catalogNumber,
            price: v.price,
            unitSize: v.unitSize,
            priceSource: v.priceSource || null,
            isSuggestedMatch: !!v.isSuggestedMatch
          };
        })
      : [],
    baseline: response.baseline
      ? {
          price: response.baseline.price,
          catalogNumber: response.baseline.catalogNumber,
          unitSize: response.baseline.unitSize,
          fieldSources: response.baseline.fieldSources
        }
      : null
  };
  bgDebug(debug, "done", outcome);

  finishFetchPriceJob(tabId, {
    type: "FETCH_PRICE_DONE",
    ok: outcome.ok,
    error: response.error || null,
    errorMessage: response.errorMessage || mapFetchPriceErrorMessage(response.error),
    mode: response.mode || "single",
    variants: Array.isArray(response.variants) ? response.variants : [],
    baseline: response.baseline || null,
    loginState: loginState,
    pageUrl: response.pageUrl || requestUrl,
    pageTitle: response.pageTitle || "",
    url: requestUrl,
    debug: buildFetchPriceDebugBundle(debug, response.debug || null, outcome)
  });
}

/**
 * @param {string|null|undefined} code
 * @returns {string}
 */
function mapFetchPriceErrorMessage(code) {
  if (code === "bot_check") {
    return "Page looks like a bot-check or interstitial. Complete it in a normal tab, then retry.";
  }
  if (code === "login_wall") {
    return "Page redirected to a login wall. Sign in to the vendor in your browser, then retry.";
  }
  if (code === "scrape_failed") {
    return "Scrape failed on the page.";
  }
  if (code === "timeout") {
    return "Timed out waiting for the page.";
  }
  if (code === "page_load_failed") {
    return "Page failed to load or content script was unavailable.";
  }
  return code ? String(code) : "";
}

const CART_CONFIGS_STORAGE_KEY = "vendorCartConfigs";
const ADD_TO_VENDOR_SITE_ENABLED =
  typeof QUARTZY_ADD_TO_VENDOR_SITE_ENABLED !== "undefined" && QUARTZY_ADD_TO_VENDOR_SITE_ENABLED === true;

/**
 * @param {unknown} value
 * @param {string} sku
 * @param {string} qty
 * @returns {unknown}
 */
function substituteCartPlaceholders(value, sku, qty) {
  if (value == null) return value;
  if (typeof value === "string") {
    return value.split("{{SKU}}").join(sku).split("{{QTY}}").join(qty);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.map(function (v) {
      return substituteCartPlaceholders(v, sku, qty);
    });
  }
  if (typeof value === "object") {
    const out = {};
    Object.keys(value).forEach(function (k) {
      out[k] = substituteCartPlaceholders(value[k], sku, qty);
    });
    return out;
  }
  return value;
}

const CART_SKU_KEY_RE =
  /^(sku|catalog|catalognumber|catalog_number|productcode|product_code|productid|product_id|itemnumber|item_number|partnumber|part_number|material|matnr|code)$/i;
const CART_QTY_KEY_RE = /^(qty|quantity|qtyordered|orderqty|amount|count)$/i;

/**
 * Innermost field name from a JSON path or flat form key.
 * e.g. itemList[0][partNumber] → partNumber
 * @param {string} path
 * @returns {string}
 */
function bareCartFieldName(path) {
  const key = String(path || "").split(".").pop() || "";
  const segments = key.split(/[\[\]]+/).filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    if (!/^\d+$/.test(segments[i])) return segments[i];
  }
  return key.replace(/\[\d+\]/g, "");
}

/**
 * @param {string} sku
 * @returns {string}
 */
function stripSkuNonAlnum(sku) {
  return String(sku || "").replace(/[^a-zA-Z0-9]/g, "");
}

/**
 * Compare catalog numbers ignoring hyphens/spaces/case (Fisher 12-340-030 vs 12340030).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function skuTokensMatch(a, b) {
  const na = stripSkuNonAlnum(a).toLowerCase();
  const nb = stripSkuNonAlnum(b).toLowerCase();
  return !!(na && nb && na === nb);
}

/**
 * Apply captured sku_transform (e.g. Fisher undashed partNumber).
 * @param {string} sku
 * @param {object} atc
 * @returns {string}
 */
function transformSkuForCart(sku, atc) {
  const raw = String(sku || "").trim();
  if (!raw) return raw;
  const meta = (atc && atc._meta) || {};
  const transform =
    (atc && atc.sku_transform) || meta.sku_transform || meta.skuTransform || null;
  const sample = meta.sampleSku != null ? String(meta.sampleSku) : "";
  if (
    transform === "strip_non_alnum" ||
    transform === "strip_hyphens" ||
    (!transform && sample && /^[a-zA-Z0-9]+$/.test(sample))
  ) {
    return stripSkuNonAlnum(raw);
  }
  return raw;
}

/**
 * Repair legacy cart payloads that still hardcode the captured part number
 * (form keys like itemList[0][partNumber] were not recognized as {{SKU}}).
 * @param {unknown} value
 * @param {string} path
 * @param {{sku?: string, qty?: string, repaired: boolean}} out
 * @returns {unknown}
 */
function repairCartPayloadPlaceholders(value, path, out) {
  if (value == null) return value;
  if (Array.isArray(value)) {
    return value.map(function (v, i) {
      return repairCartPayloadPlaceholders(v, path + "[" + i + "]", out);
    });
  }
  if (typeof value === "object") {
    const next = {};
    Object.keys(value).forEach(function (k) {
      next[k] = repairCartPayloadPlaceholders(value[k], path ? path + "." + k : k, out);
    });
    return next;
  }
  if (typeof value === "string" || typeof value === "number") {
    const bare = bareCartFieldName(path);
    const str = String(value);
    if (str === "{{SKU}}" || str === "{{QTY}}") return value;
    if (CART_SKU_KEY_RE.test(bare) && !out.sku) {
      out.sku = str;
      out.repaired = true;
      return "{{SKU}}";
    }
    if (CART_QTY_KEY_RE.test(bare) && !out.qty) {
      out.qty = str;
      out.repaired = true;
      return "{{QTY}}";
    }
  }
  return value;
}

/**
 * Ensure payload_template uses {{SKU}}/{{QTY}} and infer sku_transform from sample.
 * @param {object} atc
 * @returns {object} mutated atc (same reference)
 */
function prepareCartPayloadTemplate(atc) {
  if (!atc || atc.payload_template == null) return atc;
  const serialized = JSON.stringify(atc.payload_template);
  const needsRepair = serialized.indexOf("{{SKU}}") === -1;
  const meta = atc._meta || (atc._meta = {});
  if (needsRepair) {
    const out = { repaired: false };
    atc.payload_template = repairCartPayloadPlaceholders(atc.payload_template, "", out);
    if (out.sku && !meta.sampleSku) meta.sampleSku = out.sku;
    if (out.qty && !meta.sampleQty) meta.sampleQty = out.qty;
  }
  if (!atc.sku_transform && !meta.sku_transform && !meta.skuTransform) {
    const sample = meta.sampleSku != null ? String(meta.sampleSku) : "";
    if (sample && /^[a-zA-Z0-9]+$/.test(sample)) {
      atc.sku_transform = "strip_non_alnum";
      meta.skuTransform = "strip_non_alnum";
    }
  }
  return atc;
}

/**
 * Confirm the cart response references the requested SKU (not a stale hardcoded part).
 * @param {string} responseText
 * @param {string} sku
 * @returns {{ matched: boolean|null, seen: string[] }}
 */
function responseSkuMatch(responseText, sku) {
  const text = String(responseText || "").trim();
  if (!text || !sku) return { matched: null, seen: [] };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { matched: null, seen: [] };
  }
  const seen = [];
  function pushPart(p) {
    if (p == null || p === "") return;
    const s = String(p);
    if (seen.indexOf(s) === -1) seen.push(s);
  }
  if (Array.isArray(parsed.cartItemsPartNumbers)) {
    parsed.cartItemsPartNumbers.forEach(pushPart);
  }
  const lists = [parsed.cartletItems, parsed.cartletItemsForAnalytics, parsed.items, parsed.cartItems];
  for (let i = 0; i < lists.length; i++) {
    const list = lists[i];
    if (!Array.isArray(list)) continue;
    for (let j = 0; j < list.length; j++) {
      const row = list[j];
      if (!row || typeof row !== "object") continue;
      pushPart(row.partNumber || row.sku || row.catalogNumber || row.productCode);
    }
  }
  if (!seen.length) return { matched: null, seen: seen };
  for (let k = 0; k < seen.length; k++) {
    if (skuTokensMatch(seen[k], sku)) return { matched: true, seen: seen };
  }
  return { matched: false, seen: seen };
}

/**
 * @param {string} cookieName
 * @param {string} url
 * @returns {Promise<string|null>}
 */
async function readCookieValueForUrl(cookieName, url) {
  if (!cookieName || !url || !chrome.cookies || typeof chrome.cookies.get !== "function") {
    return null;
  }
  try {
    const direct = await chrome.cookies.get({ url: url, name: cookieName });
    if (direct && direct.value) return String(direct.value);
  } catch (e) {
    /* ignore */
  }
  try {
    const host = hostnameOf(url);
    let cookies = await chrome.cookies.getAll({ domain: host });
    if (!cookies || !cookies.length) {
      const parts = host.split(".");
      if (parts.length > 2) {
        cookies = await chrome.cookies.getAll({ domain: parts.slice(-2).join(".") });
      }
    }
    const list = cookies || [];
    for (let i = 0; i < list.length; i++) {
      if (list[i].name === cookieName && list[i].value) {
        return String(list[i].value);
      }
    }
  } catch (e2) {
    /* ignore */
  }
  return null;
}

/**
 * @param {object} tokenExtraction
 * @param {string} requestUrl
 * @returns {Promise<{ name: string, value: string, cookieName: string }|null>}
 */
async function resolveCartTokenHeader(tokenExtraction, requestUrl) {
  if (!tokenExtraction) return null;
  const headerName = tokenExtraction.header_name || tokenExtraction.headerName || "X-XSRF-TOKEN";
  const source = String(tokenExtraction.source || "COOKIE").toUpperCase();
  if (source !== "COOKIE") return null;

  const locators = [];
  const keys = tokenExtraction.locator_keys || tokenExtraction.locatorKeys;
  if (Array.isArray(keys)) {
    for (let i = 0; i < keys.length; i++) {
      if (keys[i]) locators.push(String(keys[i]));
    }
  }
  const primary = tokenExtraction.locator_key || tokenExtraction.locatorKey;
  if (primary) locators.unshift(String(primary));
  /* Always try common CSRF cookie names as fallback. */
  const fallbacks = [
    "XSRF-TOKEN",
    "xsrf-token",
    "CSRF-TOKEN",
    "csrf-token",
    "_csrf",
    "CSRFToken",
    "__RequestVerificationToken"
  ];
  for (let f = 0; f < fallbacks.length; f++) {
    if (locators.indexOf(fallbacks[f]) === -1) locators.push(fallbacks[f]);
  }

  for (let i = 0; i < locators.length; i++) {
    let value = await readCookieValueForUrl(locators[i], requestUrl);
    if (value == null) continue;
    try {
      value = decodeURIComponent(value);
    } catch (e) {
      /* keep raw */
    }
    return { name: String(headerName), value: value, cookieName: locators[i] };
  }
  return null;
}

/**
 * Strip stale CSRF header values from a saved config before replay.
 * @param {Record<string,string>} headers
 * @returns {Record<string,string>}
 */
function scrubStaleCartHeaders(headers) {
  const out = {};
  const h = headers || {};
  const drop =
    /^(cookie|authorization|x-csrf-token|x-xsrf-token|x-request-verification-token|requestverificationtoken|anti-forgery|x-anti-forgery)$/i;
  Object.keys(h).forEach(function (k) {
    if (drop.test(k)) return;
    out[k] = h[k];
  });
  return out;
}

/**
 * @param {string} url
 * @param {string} [pageUrl] Prefer product-page Referer when available.
 * @returns {{ origin: string, referer: string }}
 */
function vendorOriginReferer(url, pageUrl) {
  try {
    if (pageUrl) {
      const p = new URL(pageUrl);
      return { origin: p.origin, referer: p.href };
    }
  } catch (e0) {
    /* fall through */
  }
  try {
    const u = new URL(url);
    return { origin: u.origin, referer: u.origin + "/" };
  } catch (e) {
    return { origin: "", referer: "" };
  }
}

/**
 * @param {unknown} template
 * @param {Record<string,string>} headers
 * @returns {{ body: string|null, contentType: string|null }}
 */
function serializeCartPayload(template, headers) {
  if (template == null) return { body: null, contentType: null };
  const ct =
    (headers && (headers["Content-Type"] || headers["content-type"])) || "application/json";
  if (typeof template === "string") {
    return { body: template, contentType: ct };
  }
  if (String(ct).toLowerCase().indexOf("application/x-www-form-urlencoded") !== -1) {
    const params = new URLSearchParams();
    Object.keys(template).forEach(function (k) {
      const v = template[k];
      if (v != null && typeof v !== "object") params.append(k, String(v));
    });
    return { body: params.toString(), contentType: ct };
  }
  return { body: JSON.stringify(template), contentType: ct || "application/json" };
}

/**
 * @param {string} responseText
 * @param {Record<string,string>|null|undefined} responseHeaders
 * @returns {boolean}
 */
function looksLikeAkamaiBlock(responseText, responseHeaders) {
  const body = String(responseText || "");
  const server =
    (responseHeaders && (responseHeaders.server || responseHeaders.Server)) || "";
  if (/akamai/i.test(server)) return true;
  if (/Access Denied/i.test(body) && /edgesuite\.net|AkamaiGHost|Reference\s*#/i.test(body)) {
    return true;
  }
  return false;
}

/**
 * Hostnames that match a vendor cart config (domain_matchers or known vendor ids).
 * @param {object} cfg
 * @param {string} vendorId
 * @returns {string[]}
 */
function vendorHostHints(cfg, vendorId) {
  const hints = [];
  const matchers = (cfg && cfg.domain_matchers) || [];
  for (let i = 0; i < matchers.length; i++) {
    const m = String(matchers[i] || "");
    const host = m
      .replace(/^\*:\/\//, "")
      .replace(/\/\*$/, "")
      .replace(/^\*\./, "")
      .replace(/^\./, "");
    if (host && hints.indexOf(host) === -1) hints.push(host);
  }
  const known = {
    fisher: ["fishersci.com"],
    thermo: ["thermofisher.com", "fishersci.com"],
    biorad: ["commerce.bio-rad.com", "bio-rad.com"],
    vwr: ["vwr.com", "us.vwr.com", "avantorsciences.com"],
    sigma: ["sigmaaldrich.com", "milliporesigma.com"],
    abcam: ["abcam.com"],
    thomas: ["thomasci.com"]
  };
  const extra = known[vendorId] || [];
  for (let j = 0; j < extra.length; j++) {
    if (hints.indexOf(extra[j]) === -1) hints.push(extra[j]);
  }
  return hints;
}

/**
 * @param {string} host
 * @param {string[]} hints
 * @returns {boolean}
 */
function hostMatchesVendorHints(host, hints) {
  const h = String(host || "")
    .toLowerCase()
    .replace(/^www\./, "");
  if (!h) return false;
  for (let i = 0; i < hints.length; i++) {
    const hint = String(hints[i] || "")
      .toLowerCase()
      .replace(/^www\./, "");
    if (!hint) continue;
    if (h === hint || h.endsWith("." + hint)) return true;
  }
  return false;
}

/**
 * Build a best-effort product URL for click-to-cart.
 * @param {object} opts
 * @returns {string}
 */
function vendorProductUrlForSku(opts) {
  const productUrl = String((opts && opts.productUrl) || "").trim();
  if (productUrl) return productUrl;
  const sku = String((opts && opts.sku) || "").trim();
  const hints = ((opts && opts.hints) || []).join(" ");
  if (sku && /fishersci|fisher/i.test(hints)) {
    return "https://www.fishersci.com/shop/products/" + encodeURIComponent(sku);
  }
  return "";
}

/**
 * Before DOM click, ensure the tab is on a product page for this SKU.
 * @param {object} opts
 * @returns {Promise<{ tabId: number, pageUrl: string, created: boolean, reused: boolean }|null>}
 */
async function ensureVendorProductTabForClick(opts) {
  const tabInfo = opts.tabInfo;
  const sku = String(opts.sku || "").trim();
  const productUrl = vendorProductUrlForSku(opts);
  if (!tabInfo || tabInfo.tabId == null) {
    if (!productUrl) return null;
    return findOrOpenVendorCartTab({
      hints: opts.hints || [],
      productUrl: productUrl,
      apiUrl: opts.apiUrl || "",
      sku: sku
    });
  }
  const pageUrl = String(tabInfo.pageUrl || "");
  const looksLikePdp =
    /\/shop\/products\//i.test(pageUrl) ||
    /\/product\//i.test(pageUrl) ||
    (sku && pageUrl.toLowerCase().indexOf(sku.toLowerCase()) !== -1);
  if (looksLikePdp) return tabInfo;
  if (!productUrl) return tabInfo;
  try {
    await chrome.tabs.update(tabInfo.tabId, { url: productUrl });
    await waitForTabComplete(tabInfo.tabId, 25000);
    await new Promise(function (r) {
      setTimeout(r, 1500);
    });
    let nextUrl = productUrl;
    try {
      const t = await chrome.tabs.get(tabInfo.tabId);
      if (t && t.url) nextUrl = t.url;
    } catch (e) {
      /* ignore */
    }
    return {
      tabId: tabInfo.tabId,
      pageUrl: nextUrl,
      created: !!tabInfo.created,
      reused: !!tabInfo.reused
    };
  } catch (e2) {
    return tabInfo;
  }
}

/**
 * Prefer an existing open vendor tab; otherwise open a product/home tab.
 * @param {object} opts
 * @returns {Promise<{ tabId: number, pageUrl: string, created: boolean, reused: boolean }|null>}
 */
async function findOrOpenVendorCartTab(opts) {
  const hints = opts.hints || [];
  const productUrl = String(opts.productUrl || "").trim();
  const apiUrl = String(opts.apiUrl || "").trim();
  let origin = "";
  try {
    origin = new URL(apiUrl || productUrl).origin;
  } catch (e) {
    origin = "";
  }

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (e2) {
    tabs = [];
  }

  let best = null;
  for (let i = 0; i < tabs.length; i++) {
    const t = tabs[i];
    if (!t || t.id == null || !t.url) continue;
    let host = "";
    try {
      host = new URL(t.url).hostname;
    } catch (e3) {
      continue;
    }
    if (!hostMatchesVendorHints(host, hints)) continue;
    const score =
      (productUrl && t.url.indexOf(encodeURIComponent(opts.sku || "")) !== -1 ? 30 : 0) +
      (/\/shop\/products\//i.test(t.url) || /\/product\//i.test(t.url) ? 20 : 0) +
      (t.active ? 5 : 0) +
      (t.status === "complete" ? 2 : 0);
    if (!best || score > best.score) {
      best = { tabId: t.id, pageUrl: t.url, score: score, created: false, reused: true };
    }
  }
  if (best) return best;

  let openUrl = productUrl;
  if (!openUrl && opts.sku && /fishersci|fisher/i.test(hints.join(" "))) {
    openUrl = "https://www.fishersci.com/shop/products/" + encodeURIComponent(opts.sku);
  }
  if (!openUrl && origin) {
    openUrl = origin + "/";
  }
  if (!openUrl) return null;

  try {
    const tab = await chrome.tabs.create({ url: openUrl, active: false });
    if (!tab || tab.id == null) return null;
    await waitForTabComplete(tab.id, 25000);
    /* Give Akamai sensor JS a moment to mint cookies. */
    await new Promise(function (r) {
      setTimeout(r, 1500);
    });
    let pageUrl = openUrl;
    try {
      const t2 = await chrome.tabs.get(tab.id);
      if (t2 && t2.url) pageUrl = t2.url;
    } catch (e4) {
      /* ignore */
    }
    return { tabId: tab.id, pageUrl: pageUrl, created: true, reused: false };
  } catch (e5) {
    return null;
  }
}

/**
 * @param {number} tabId
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
function waitForTabComplete(tabId, timeoutMs) {
  return new Promise(function (resolve) {
    let done = false;
    const finish = function () {
      if (done) return;
      done = true;
      try {
        chrome.tabs.onUpdated.removeListener(onUpdated);
      } catch (e) {
        /* ignore */
      }
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs || 20000);
    function onUpdated(id, info) {
      if (id !== tabId) return;
      if (info && info.status === "complete") {
        clearTimeout(timer);
        finish();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then(function (t) {
      if (t && t.status === "complete") {
        clearTimeout(timer);
        finish();
      }
    }).catch(function () {
      /* wait for event / timeout */
    });
  });
}

/**
 * @param {number} tabId
 * @param {object} message
 * @param {number} [attempts]
 * @returns {Promise<object|null>}
 */
async function sendMessageToTabWithRetry(tabId, message, attempts) {
  const max = attempts != null ? attempts : 5;
  let lastErr = null;
  for (let i = 0; i < max; i++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message);
      if (response) return response;
    } catch (e) {
      lastErr = e;
    }
    await new Promise(function (r) {
      setTimeout(r, 400);
    });
  }
  return {
    ok: false,
    error: "content_unavailable",
    errorMessage:
      (lastErr && lastErr.message) ||
      "Vendor page content script unavailable. Reload the vendor tab and retry."
  };
}

/**
 * Evaluate success_indicator against an HTTP response.
 * @param {object} atc
 * @param {number} status
 * @param {string} responseText
 * @returns {{ ok: boolean, jsonPathOk: boolean }}
 */
function evaluateCartSuccess(atc, status, responseText) {
  const success = (atc && atc.success_indicator) || {};
  const expectedStatus = success.status_code != null ? Number(success.status_code) : null;
  let ok = status >= 200 && status < 300;
  if (expectedStatus != null) {
    ok =
      status === expectedStatus ||
      (expectedStatus >= 200 && expectedStatus < 300 && status >= 200 && status < 300);
  }
  let jsonPathOk = true;
  const jsonPath = success.json_path;
  if (jsonPath && String(jsonPath).trim()) {
    try {
      const parsed = JSON.parse(responseText);
      const path = String(jsonPath)
        .replace(/^\$\.?/, "")
        .split(".");
      let cur = parsed;
      for (let i = 0; i < path.length; i++) {
        if (cur == null) break;
        cur = cur[path[i]];
      }
      if (Object.prototype.hasOwnProperty.call(success, "expected_value")) {
        jsonPathOk = cur === success.expected_value;
      } else {
        jsonPathOk = !!cur;
      }
      ok = ok && jsonPathOk;
    } catch (e3) {
      jsonPathOk = false;
      ok = false;
    }
  }
  return { ok: ok, jsonPathOk: jsonPathOk };
}

/**
 * @param {object} opts
 * @returns {object}
 */
function buildCartOutcome(opts) {
  const status = opts.status != null ? Number(opts.status) : null;
  const responseFull = String(opts.responseText || "");
  const responseHeaders = opts.responseHeaders || {};
  const token = opts.token || null;
  const success = (opts.atc && opts.atc.success_indicator) || {};
  const evaluated = evaluateCartSuccess(opts.atc, status != null ? status : 0, responseFull);
  let ok = opts.forceOk === true ? true : evaluated.ok;
  if (opts.forceOk === false) ok = false;

  const skuCheck = responseSkuMatch(responseFull, opts.sku);
  const skuMatched = skuCheck.matched;
  if (skuMatched === false && opts.forceOk !== true) {
    ok = false;
  }

  const akamai = looksLikeAkamaiBlock(responseFull, responseHeaders);
  let errorMessage = opts.errorMessage || null;
  let error = opts.error || null;
  if (!ok && !errorMessage) {
    if (skuMatched === false) {
      error = "sku_mismatch";
      errorMessage =
        "Vendor accepted the cart request but the response part number(s) [" +
        (skuCheck.seen || []).join(", ") +
        "] do not match requested SKU " +
        opts.sku +
        ". Re-map Add to cart on that product (legacy configs often hardcode the captured part number)." +
        (opts.requestSku && opts.requestSku !== opts.sku
          ? " Request sent partNumber=" + opts.requestSku + "."
          : "");
    } else if (akamai || status === 403) {
      error = akamai ? "akamai_blocked" : "forbidden";
      errorMessage = akamai
        ? "Akamai blocked the cart request (edge Access Denied). Retrying via the vendor page / Add to cart click when possible."
        : "Vendor cart API returned HTTP 403 (forbidden). Usually a stale/missing CSRF token or logged-out session — open the vendor site logged in, re-run Cart mapping if needed, then retry." +
          (token ? " (refreshed token from cookie " + token.cookieName + ")" : " (no CSRF cookie found)");
    } else if (status != null) {
      error = "cart_rejected";
      errorMessage =
        "Vendor cart API returned HTTP " +
        status +
        (evaluated.jsonPathOk ? "" : " (success path mismatch)") +
        ".";
    }
  }

  return {
    ok: ok,
    vendorId: opts.vendorId,
    sku: opts.sku,
    qty: opts.qty,
    url: opts.url,
    method: opts.method,
    status: status,
    tokenCookie: token ? token.cookieName : null,
    responsePreview: responseFull.slice(0, 800),
    responseBody: responseFull.slice(0, 50000),
    error: ok ? null : error || "cart_rejected",
    errorMessage: ok ? null : errorMessage,
    execution: opts.execution || null,
    debug: {
      version: 1,
      generatedAt: new Date().toISOString(),
      request: {
        vendorId: opts.vendorId,
        sku: opts.sku,
        requestSku: opts.requestSku || opts.sku,
        qty: opts.qty,
        method: opts.method,
        url: opts.url,
        headers: opts.debugRequestHeaders || {},
        bodyPreview: opts.bodyPreview != null ? String(opts.bodyPreview).slice(0, 4000) : null,
        pageUrl: opts.pageUrl || null
      },
      token: token
        ? { found: true, cookieName: token.cookieName, headerName: token.name }
        : {
            found: false,
            required: !!(opts.atc && opts.atc.token_extraction && opts.atc.token_extraction.required)
          },
      response: {
        status: status,
        ok: status >= 200 && status < 300,
        headers: responseHeaders,
        body: responseFull.slice(0, 50000)
      },
      successIndicator: success,
      jsonPathOk: evaluated.jsonPathOk,
      skuMatch: skuMatched,
      responsePartNumbers: skuCheck.seen,
      akamaiBlocked: akamai,
      execution: opts.execution || null,
      attempts: opts.attempts || null
    }
  };
}

/**
 * Execute a saved vendorCartConfigs add_to_cart mapping.
 * Prefers page-context fetch on a vendor tab (bypasses Akamai SW blocks), then DOM click.
 * @param {object} message
 * @returns {Promise<object>}
 */
async function runAddToVendorCart(message) {
  if (!ADD_TO_VENDOR_SITE_ENABLED) {
    return {
      ok: false,
      error: "feature_disabled",
      errorMessage: "Add to vendor site is disabled."
    };
  }
  const sku = String((message && message.sku) || "").trim();
  const qty = String((message && message.qty) || "1").trim() || "1";
  const vendorId = String((message && message.vendorId) || "")
    .trim()
    .toLowerCase();
  const productUrlHint = String((message && message.productUrl) || "").trim();
  if (!sku) {
    return { ok: false, error: "missing_sku", errorMessage: "Catalog / SKU is required." };
  }
  if (!vendorId) {
    return { ok: false, error: "missing_vendor", errorMessage: "Could not resolve vendor." };
  }

  const stored = await chrome.storage.local.get([CART_CONFIGS_STORAGE_KEY]);
  const all = (stored && stored[CART_CONFIGS_STORAGE_KEY]) || {};
  let cfg = all[vendorId] || null;
  if (!cfg && message && message.config) {
    cfg = message.config;
  }
  if (!cfg || !cfg.add_to_cart || cfg.add_to_cart.enabled === false) {
    return {
      ok: false,
      error: "no_config",
      errorMessage:
        'No saved cart mapping for vendor "' +
        vendorId +
        '". Map Add to cart on that vendor site first.',
      vendorId: vendorId
    };
  }

  const atc = prepareCartPayloadTemplate(cfg.add_to_cart);
  /* Persist repaired {{SKU}} placeholders / sku_transform for next run. */
  try {
    all[vendorId] = cfg;
    await chrome.storage.local.set({ [CART_CONFIGS_STORAGE_KEY]: all });
  } catch (persistErr) {
    /* non-fatal */
  }
  const method = String(atc.method || "POST").toUpperCase();
  const urlTemplate = String(atc.url_template || "");
  if (!urlTemplate) {
    return { ok: false, error: "bad_config", errorMessage: "Cart config is missing url_template." };
  }
  const requestSku = transformSkuForCart(sku, atc);
  const url = String(substituteCartPlaceholders(urlTemplate, requestSku, qty));
  const headers = scrubStaleCartHeaders(Object.assign({}, atc.headers || {}));
  if (!headers["X-Requested-With"] && !headers["x-requested-with"]) {
    headers["X-Requested-With"] = "XMLHttpRequest";
  }

  const token = await resolveCartTokenHeader(atc.token_extraction, url);
  if (token) {
    headers[token.name] = token.value;
    const lower = token.name.toLowerCase();
    if (lower === "x-xsrf-token" && !headers["X-CSRF-TOKEN"] && !headers["x-csrf-token"]) {
      headers["X-CSRF-TOKEN"] = token.value;
    }
    if (lower === "x-csrf-token" && !headers["X-XSRF-TOKEN"] && !headers["x-xsrf-token"]) {
      headers["X-XSRF-TOKEN"] = token.value;
    }
  }
  if (atc.token_extraction && atc.token_extraction.required && !token) {
    return {
      ok: false,
      error: "token_missing",
      errorMessage:
        "Could not read CSRF/session token cookie. Open the vendor site while logged in, then try again.",
      vendorId: vendorId,
      url: url,
      debug: {
        version: 1,
        generatedAt: new Date().toISOString(),
        request: {
          vendorId: vendorId,
          sku: sku,
          requestSku: requestSku,
          qty: qty,
          method: method,
          url: url
        },
        token: { found: false, required: true },
        config: { hasAddToCart: true, urlTemplate: urlTemplate }
      }
    };
  }

  const payloadTemplate = substituteCartPlaceholders(atc.payload_template || {}, requestSku, qty);
  const serialized = serializeCartPayload(payloadTemplate, headers);
  if (serialized.contentType) {
    headers["Content-Type"] = serialized.contentType;
  }

  const debugRequestHeaders = {};
  Object.keys(headers).forEach(function (k) {
    const lower = String(k).toLowerCase();
    if (/csrf|xsrf|verification|anti-forgery|authorization|cookie/i.test(lower)) {
      debugRequestHeaders[k] = headers[k] ? "[redacted " + String(headers[k]).length + " chars]" : "";
    } else {
      debugRequestHeaders[k] = headers[k];
    }
  });

  const hints = vendorHostHints(cfg, vendorId);
  const tabInfo = await findOrOpenVendorCartTab({
    hints: hints,
    productUrl: productUrlHint,
    apiUrl: url,
    sku: sku
  });

  const attempts = [];
  let createdTabId = tabInfo && tabInfo.created ? tabInfo.tabId : null;

  try {
    /* 1) Page-context fetch (real document Referer + Akamai cookies). */
    if (tabInfo && tabInfo.tabId != null) {
      const pageHeaders = Object.assign({}, headers);
      delete pageHeaders.Origin;
      delete pageHeaders.origin;
      delete pageHeaders.Referer;
      delete pageHeaders.referer;

      const pageResult = await sendMessageToTabWithRetry(tabInfo.tabId, {
        type: "VENDOR_CART_PAGE_FETCH",
        method: method,
        url: url,
        headers: pageHeaders,
        body: serialized.body
      });
      attempts.push({
        mode: "page_fetch",
        tabId: tabInfo.tabId,
        pageUrl: (pageResult && pageResult.pageUrl) || tabInfo.pageUrl,
        status: pageResult && pageResult.status,
        error: pageResult && pageResult.error
      });

      if (pageResult && pageResult.error !== "content_unavailable" && pageResult.status != null) {
        const outcome = buildCartOutcome({
          atc: atc,
          vendorId: vendorId,
          sku: sku,
          requestSku: requestSku,
          qty: qty,
          url: url,
          method: method,
          status: pageResult.status,
          responseText: pageResult.responseBody || "",
          responseHeaders: pageResult.responseHeaders || {},
          token: token,
          debugRequestHeaders: debugRequestHeaders,
          bodyPreview: serialized.body,
          pageUrl: pageResult.pageUrl || tabInfo.pageUrl,
          execution: "page_fetch",
          attempts: attempts
        });
        if (outcome.ok) return outcome;

        /* 2) DOM click fallback when Akamai blocks or API added the wrong SKU. */
        if (
          (outcome.debug && outcome.debug.akamaiBlocked) ||
          outcome.error === "sku_mismatch"
        ) {
          const clickTab = await ensureVendorProductTabForClick({
            tabInfo: tabInfo,
            productUrl: productUrlHint,
            sku: sku,
            hints: hints,
            apiUrl: url
          });
          if (clickTab && clickTab.created) {
            createdTabId = clickTab.tabId;
          }
          const clickTarget = clickTab || tabInfo;
          const clickResult = await sendMessageToTabWithRetry(clickTarget.tabId, {
            type: "VENDOR_CART_CLICK_ATC",
            sku: sku,
            qty: qty
          });
          attempts.push({
            mode: "dom_click",
            tabId: clickTarget.tabId,
            pageUrl: (clickResult && clickResult.pageUrl) || clickTarget.pageUrl,
            ok: !!(clickResult && clickResult.ok),
            error: clickResult && clickResult.error,
            buttonText: clickResult && clickResult.buttonText
          });
          if (clickResult && clickResult.ok) {
            return {
              ok: true,
              vendorId: vendorId,
              sku: sku,
              qty: qty,
              url: url,
              method: "DOM_CLICK",
              status: 200,
              tokenCookie: token ? token.cookieName : null,
              responsePreview: "Clicked Add to cart on vendor page.",
              responseBody: "",
              error: null,
              errorMessage: null,
              execution: "dom_click",
              debug: {
                version: 1,
                generatedAt: new Date().toISOString(),
                request: {
                  vendorId: vendorId,
                  sku: sku,
                  qty: qty,
                  method: "DOM_CLICK",
                  url: url,
                  pageUrl: clickResult.pageUrl || clickTarget.pageUrl,
                  buttonText: clickResult.buttonText || null
                },
                token: token
                  ? { found: true, cookieName: token.cookieName, headerName: token.name }
                  : { found: false, required: !!(atc.token_extraction && atc.token_extraction.required) },
                pageFetchBlocked: outcome,
                attempts: attempts,
                execution: "dom_click"
              }
            };
          }
          outcome.error = "akamai_blocked";
          outcome.errorMessage =
            "Akamai blocked the cart API, and clicking Add to cart on the vendor page also failed" +
            (clickResult && clickResult.errorMessage ? ": " + clickResult.errorMessage : ".") +
            " Open the product page logged in and retry.";
          outcome.execution = "page_fetch_then_dom_click";
          outcome.debug.attempts = attempts;
          outcome.debug.domClick = clickResult || null;
          return outcome;
        }
        return outcome;
      }
    }

    /* 3) Service-worker fetch fallback (vendors without Akamai). */
    const site = vendorOriginReferer(url, tabInfo && tabInfo.pageUrl);
    if (site.origin && !headers.Origin && !headers.origin) headers.Origin = site.origin;
    if (site.referer && !headers.Referer && !headers.referer) headers.Referer = site.referer;

    let res;
    try {
      const init = {
        method: method,
        headers: headers,
        credentials: "include",
        redirect: "follow"
      };
      if (method !== "GET" && method !== "HEAD" && serialized.body != null) {
        init.body = serialized.body;
      }
      res = await fetch(url, init);
    } catch (e) {
      attempts.push({ mode: "service_worker_fetch", error: (e && e.message) || "fetch_failed" });
      return {
        ok: false,
        error: "network",
        errorMessage: (e && e.message) || "Network error calling vendor cart API.",
        vendorId: vendorId,
        url: url,
        execution: "service_worker_fetch",
        debug: {
          version: 1,
          generatedAt: new Date().toISOString(),
          request: {
            vendorId: vendorId,
            sku: sku,
            qty: qty,
            method: method,
            url: url,
            headers: debugRequestHeaders,
            bodyPreview: serialized.body != null ? String(serialized.body).slice(0, 2000) : null
          },
          token: token
            ? { found: true, cookieName: token.cookieName, headerName: token.name }
            : { found: false },
          networkError: (e && e.message) || "fetch_failed",
          attempts: attempts
        }
      };
    }

    const responseHeaders = {};
    try {
      res.headers.forEach(function (v, k) {
        responseHeaders[k] = v;
      });
    } catch (eHdr) {
      /* ignore */
    }
    let responseText = "";
    try {
      responseText = await res.text();
    } catch (e2) {
      responseText = "";
    }
    attempts.push({ mode: "service_worker_fetch", status: res.status });
    return buildCartOutcome({
      atc: atc,
      vendorId: vendorId,
      sku: sku,
      requestSku: requestSku,
      qty: qty,
      url: url,
      method: method,
      status: res.status,
      responseText: responseText,
      responseHeaders: responseHeaders,
      token: token,
      debugRequestHeaders: debugRequestHeaders,
      bodyPreview: serialized.body,
      pageUrl: tabInfo && tabInfo.pageUrl,
      execution: "service_worker_fetch",
      attempts: attempts
    });
  } finally {
    if (createdTabId != null) {
      const tabToClose = createdTabId;
      /* After a DOM click, give the page a moment to finish its own ATC XHR. */
      setTimeout(function () {
        try {
          chrome.tabs.remove(tabToClose);
        } catch (eClose) {
          /* ignore */
        }
      }, 2500);
    }
  }
}

/**
 * Inject vendorCartInjector.js into a tab (idempotent — injector self-guards).
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function injectVendorCartInjector(tabId) {
  if (!chrome.scripting || typeof chrome.scripting.executeScript !== "function") {
    throw new Error("chrome.scripting is unavailable; add the scripting permission.");
  }
  await chrome.scripting.executeScript({
    target: { tabId: tabId },
    files: ["vendorCartInjector.js"]
  });
}

/**
 * Inject vendorCoaInjector.js into a tab (idempotent — injector self-guards).
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function injectVendorCoaInjector(tabId) {
  if (!chrome.scripting || typeof chrome.scripting.executeScript !== "function") {
    throw new Error("chrome.scripting is unavailable; add the scripting permission.");
  }
  await chrome.scripting.executeScript({
    target: { tabId: tabId },
    files: ["vendorCoaInjector.js"]
  });
}

/**
 * Watch for a PDF tab opened from openerTabId (Sigma opens CoA PDFs in a new tab).
 * @param {number} openerTabId
 * @param {number} [timeoutMs]
 * @returns {Promise<{ tabId: number, url: string }|null>}
 */
function waitForPdfTabFromOpener(openerTabId, timeoutMs) {
  return new Promise(function (resolve) {
    let done = false;
    const finish = function (value) {
      if (done) return;
      done = true;
      try {
        chrome.tabs.onCreated.removeListener(onCreated);
        chrome.tabs.onUpdated.removeListener(onUpdated);
      } catch (e) {
        /* ignore */
      }
      resolve(value || null);
    };
    const timer = setTimeout(function () {
      finish(null);
    }, timeoutMs || FETCH_COA_PDF_TIMEOUT_MS);

    /** @type {Set<number>} */
    const candidateIds = new Set();

    function consider(tab) {
      if (!tab || tab.id == null) return;
      if (tab.openerTabId != null && tab.openerTabId !== openerTabId) return;
      if (tab.openerTabId == null && !candidateIds.has(tab.id)) return;
      const url = String(tab.url || tab.pendingUrl || "");
      if (url && /\/certificates\/coa\/|\.pdf($|\?)/i.test(url)) {
        clearTimeout(timer);
        finish({ tabId: tab.id, url: url });
      }
    }

    function onCreated(tab) {
      if (!tab || tab.id == null) return;
      if (tab.openerTabId === openerTabId) {
        candidateIds.add(tab.id);
        consider(tab);
      }
    }

    function onUpdated(tabId, _info, tab) {
      if (candidateIds.has(tabId) || (tab && tab.openerTabId === openerTabId)) {
        candidateIds.add(tabId);
        consider(tab);
      }
    }

    chrome.tabs.onCreated.addListener(onCreated);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

/**
 * @param {string} url
 * @returns {Promise<{ ok: boolean, body?: string, mimeType?: string, filename?: string, error?: string, errorMessage?: string, byteLength?: number }>}
 */
async function fetchPdfAsBase64(url) {
  const downloadUrl = String(url || "").trim();
  if (!downloadUrl || !/^https?:/i.test(downloadUrl)) {
    return {
      ok: false,
      error: "invalid_url",
      errorMessage: "CoA download URL is missing or invalid."
    };
  }
  let res;
  try {
    res = await fetch(downloadUrl, {
      method: "GET",
      credentials: "include",
      redirect: "follow"
    });
  } catch (e) {
    return {
      ok: false,
      error: "fetch_failed",
      errorMessage: (e && e.message) || "Could not download the CoA PDF."
    };
  }
  if (!res || !res.ok) {
    return {
      ok: false,
      error: "http_" + (res && res.status),
      errorMessage: "CoA download failed with HTTP " + (res && res.status) + "."
    };
  }
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (!bytes.length) {
    return {
      ok: false,
      error: "empty_file",
      errorMessage: "The CoA download was empty."
    };
  }
  /* Validate PDF magic when content-type is unreliable. */
  const head = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3] || 0);
  const contentType = String(res.headers.get("content-type") || "").toLowerCase();
  if (head !== "%PDF" && contentType.indexOf("pdf") === -1) {
    return {
      ok: false,
      error: "not_pdf",
      errorMessage: "The download did not look like a PDF (content-type: " + contentType + ")."
    };
  }

  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  let filename = "CoA.pdf";
  try {
    const path = new URL(downloadUrl).pathname;
    const base = path.split("/").pop() || "";
    if (base) filename = decodeURIComponent(base.replace(/[?#].*$/, ""));
  } catch (e) {
    /* keep default */
  }
  const cd = res.headers.get("content-disposition") || "";
  const cdMatch = cd.match(/filename\*?=(?:UTF-8''|")?([^\";]+)/i);
  if (cdMatch && cdMatch[1]) {
    try {
      filename = decodeURIComponent(cdMatch[1].replace(/"/g, "").trim());
    } catch (e) {
      filename = cdMatch[1].replace(/"/g, "").trim();
    }
  }

  return {
    ok: true,
    encoding: "base64",
    body: btoa(binary),
    mimeType: "application/pdf",
    filename: filename,
    byteLength: bytes.length,
    downloadUrl: downloadUrl
  };
}

/**
 * Open the vendor CoA page, locate the PDF for lot/catalog, download bytes.
 *
 * Message: { type: "FETCH_COA", vendorName|vendorId, lotNumber, catalogNumber?, productUrl? }
 *
 * @param {object} message
 * @returns {Promise<object>}
 */
async function fetchCoa(message) {
  message = message || {};
  if (!FETCH_COA_ENABLED) {
    return {
      ok: false,
      error: "feature_disabled",
      errorMessage: "Fetch CoA is disabled."
    };
  }

  const vendorName = message.vendorName || message.vendorId || message.vendor || "";
  const cfg =
    typeof getVendorCoaConfig === "function" ? getVendorCoaConfig(vendorName) : null;
  if (!cfg) {
    return {
      ok: false,
      error: "unsupported_vendor",
      errorMessage:
        'Fetch CoA is not mapped for vendor "' +
        String(vendorName || "").trim() +
        '" yet. Supported: Sigma-Aldrich / MilliporeSigma.'
    };
  }

  const lotNumber = String(message.lotNumber || message.lot || "").trim();
  if (!lotNumber) {
    return {
      ok: false,
      error: "missing_lot",
      errorMessage: "A lot number is required to fetch a CoA."
    };
  }

  let catalogNumber = String(message.catalogNumber || message.sku || message.catalog || "").trim();
  const productUrl = String(message.productUrl || message.url || "").trim();
  if (!catalogNumber && productUrl && typeof catalogNumberFromProductUrl === "function") {
    catalogNumber = catalogNumberFromProductUrl(productUrl);
  }

  const forcedStrategy = String(message.strategy || "").toLowerCase();
  const closeTab = message.closeTab !== false;

  /** @type {Array<{ strategy: string, openUrl: string }>} */
  const attemptPlans = [];
  if (forcedStrategy === "product_page" || forcedStrategy === "documents_search") {
    if (forcedStrategy === "product_page" && productUrl && /^https?:/i.test(productUrl)) {
      attemptPlans.push({ strategy: "product_page", openUrl: productUrl });
    } else if (typeof buildCoaSearchUrl === "function") {
      attemptPlans.push({
        strategy: "documents_search",
        openUrl: buildCoaSearchUrl(cfg, { catalogNumber: catalogNumber, lotNumber: lotNumber })
      });
    } else if (cfg.documentsSearchUrl) {
      attemptPlans.push({ strategy: "documents_search", openUrl: cfg.documentsSearchUrl });
    }
  } else {
    if (productUrl && /^https?:/i.test(productUrl)) {
      attemptPlans.push({ strategy: "product_page", openUrl: productUrl });
    }
    if (typeof buildCoaSearchUrl === "function") {
      attemptPlans.push({
        strategy: "documents_search",
        openUrl: buildCoaSearchUrl(cfg, { catalogNumber: catalogNumber, lotNumber: lotNumber })
      });
    } else if (cfg.documentsSearchUrl) {
      attemptPlans.push({ strategy: "documents_search", openUrl: cfg.documentsSearchUrl });
    }
  }

  if (!attemptPlans.length) {
    return {
      ok: false,
      error: "missing_url",
      errorMessage: "No CoA URL configured for vendor " + cfg.id
    };
  }

  /** @type {object|null} */
  let lastFailure = null;
  for (let pi = 0; pi < attemptPlans.length; pi++) {
    const plan = attemptPlans[pi];
    const result = await runCoaFetchAttempt({
      cfg: cfg,
      strategy: plan.strategy,
      openUrl: plan.openUrl,
      lotNumber: lotNumber,
      catalogNumber: catalogNumber,
      productUrl: productUrl,
      active: message.active !== false,
      closeTab: closeTab,
      timeoutMs: message.timeoutMs,
      settleMs: message.settleMs,
      injectAttempts: message.injectAttempts
    });
    if (result && result.ok && result.body) return result;
    lastFailure = result;
  }

  return (
    lastFailure || {
      ok: false,
      error: "coa_not_found",
      errorMessage: "Could not find a CoA for lot " + lotNumber + ".",
      vendorId: cfg.id,
      lotNumber: lotNumber,
      catalogNumber: catalogNumber
    }
  );
}

/**
 * One open-tab → inject → download attempt for Fetch CoA.
 * @param {object} opts
 * @returns {Promise<object>}
 */
async function runCoaFetchAttempt(opts) {
  opts = opts || {};
  const cfg = opts.cfg;
  const strategy = opts.strategy;
  const openUrl = opts.openUrl;
  const lotNumber = opts.lotNumber;
  const catalogNumber = opts.catalogNumber;
  const productUrl = opts.productUrl;
  const closeTab = opts.closeTab !== false;

  let tab;
  try {
    tab = await chrome.tabs.create({ url: openUrl, active: opts.active !== false });
  } catch (eCreate) {
    return {
      ok: false,
      error: "tab_create_failed",
      errorMessage: (eCreate && eCreate.message) || "Could not open the vendor CoA page.",
      vendorId: cfg.id,
      strategy: strategy
    };
  }
  if (!tab || tab.id == null) {
    return {
      ok: false,
      error: "tab_create_failed",
      errorMessage: "No tab id from chrome.tabs.create.",
      vendorId: cfg.id,
      strategy: strategy
    };
  }

  const tabId = tab.id;

  try {
    await waitForTabComplete(tabId, opts.timeoutMs || FETCH_COA_TAB_TIMEOUT_MS);
    await new Promise(function (r) {
      setTimeout(r, opts.settleMs != null ? opts.settleMs : 1500);
    });

    await injectVendorCoaInjector(tabId);

    const pdfTabWait = waitForPdfTabFromOpener(tabId, FETCH_COA_PDF_TIMEOUT_MS);

    let injectResult = null;
    const maxAttempts = opts.injectAttempts != null ? opts.injectAttempts : 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        injectResult = await chrome.tabs.sendMessage(tabId, {
          type: "QUARTZY_FETCH_COA",
          payload: {
            vendorId: cfg.id,
            lotNumber: lotNumber,
            catalogNumber: catalogNumber,
            strategy: strategy,
            productUrl: productUrl
          }
        });
        if (injectResult && (injectResult.ok || injectResult.downloadUrl || injectResult.body)) {
          break;
        }
        if (
          injectResult &&
          (injectResult.error === "lot_input_not_found" ||
            injectResult.error === "submit_not_found" ||
            injectResult.error === "lot_link_not_found") &&
          attempt < maxAttempts - 1
        ) {
          await new Promise(function (r) {
            setTimeout(r, 800);
          });
          continue;
        }
        break;
      } catch (eMsg) {
        if (attempt === 0) {
          await injectVendorCoaInjector(tabId);
        }
        await new Promise(function (r) {
          setTimeout(r, 500);
        });
        if (attempt === maxAttempts - 1) {
          if (closeTab) {
            try {
              chrome.tabs.remove(tabId);
            } catch (e) {
              /* ignore */
            }
          }
          return {
            ok: false,
            error: "inject_message_failed",
            errorMessage:
              (eMsg && eMsg.message) || "Could not reach vendorCoaInjector on the CoA tab.",
            vendorId: cfg.id,
            strategy: strategy,
            tabId: tabId,
            openUrl: openUrl
          };
        }
      }
    }

    let downloadUrl = injectResult && injectResult.downloadUrl ? String(injectResult.downloadUrl) : "";
    let filename = injectResult && injectResult.filename ? String(injectResult.filename) : "";
    let body = injectResult && injectResult.body ? String(injectResult.body) : "";
    let mimeType =
      injectResult && injectResult.mimeType ? String(injectResult.mimeType) : "application/pdf";
    let byteLength = injectResult && injectResult.byteLength != null ? injectResult.byteLength : null;

    if (!downloadUrl || !body) {
      const pdfTab = await pdfTabWait;
      if (pdfTab && pdfTab.url) {
        if (!downloadUrl) downloadUrl = pdfTab.url;
        if (closeTab) {
          try {
            chrome.tabs.remove(pdfTab.tabId);
          } catch (e) {
            /* ignore */
          }
        }
      }
    } else {
      pdfTabWait.then(function (pdfTab) {
        if (pdfTab && pdfTab.tabId != null && closeTab) {
          try {
            chrome.tabs.remove(pdfTab.tabId);
          } catch (e) {
            /* ignore */
          }
        }
      });
    }

    if (!body && downloadUrl) {
      const file = await fetchPdfAsBase64(downloadUrl);
      if (file.ok) {
        body = file.body;
        mimeType = file.mimeType || mimeType;
        filename = filename || file.filename;
        byteLength = file.byteLength;
      }
    }

    if (closeTab) {
      try {
        chrome.tabs.remove(tabId);
      } catch (e) {
        /* ignore */
      }
    }

    if (!body) {
      return {
        ok: false,
        error: (injectResult && injectResult.error) || "coa_not_found",
        errorMessage:
          (injectResult && injectResult.errorMessage) ||
          "Could not find a CoA for lot " + lotNumber + ".",
        vendorId: cfg.id,
        strategy: strategy,
        lotNumber: lotNumber,
        catalogNumber: catalogNumber,
        openUrl: openUrl
      };
    }

    return {
      ok: true,
      vendorId: cfg.id,
      strategy: strategy,
      lotNumber: lotNumber,
      catalogNumber: catalogNumber,
      downloadUrl: downloadUrl,
      openUrl: openUrl,
      filename: filename || "CoA.pdf",
      mimeType: mimeType,
      encoding: "base64",
      body: body,
      byteLength: byteLength
    };
  } catch (eRun) {
    if (closeTab) {
      try {
        chrome.tabs.remove(tabId);
      } catch (e) {
        /* ignore */
      }
    }
    return {
      ok: false,
      error: "unexpected",
      errorMessage: (eRun && eRun.message) || "Fetch CoA failed.",
      vendorId: cfg.id,
      strategy: strategy,
      tabId: tabId,
      openUrl: openUrl
    };
  }
}

/**
 * Normalize PUSH_CART_TO_VENDOR items for the form-fill injector.
 * @param {Array<object>} items
 * @param {string} vendorId
 * @returns {Array<{ catalogNumber: string, quantity: string, catalog: string, qty: string }>}
 */
function normalizeCartStuffFormItems(items, vendorId) {
  const list =
    typeof filterItemsForVendor === "function" ? filterItemsForVendor(items, vendorId) : items || [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const it = list[i] || {};
    const catalog = String(it.catalogNumber || it.catalog || it.sku || "").trim();
    if (!catalog) continue;
    const q = it.quantity != null ? it.quantity : it.qty;
    const n = Number(q);
    const quantity =
      Number.isFinite(n) && n > 0 ? String(Math.floor(n)) : String(q == null ? "1" : q).trim() || "1";
    out.push({
      catalogNumber: catalog,
      quantity: quantity,
      catalog: catalog,
      qty: quantity
    });
  }
  return out;
}

/** Vendors that use Quick Order line-entry form fill (vs CSV/XLSX file drop). */
const CART_STUFF_FORM_VENDORS = { fisher: true, biorad: true };

/**
 * Open the vendor Quick Order page and stuff the cart.
 * Fisher / Bio-Rad default to line-by-line form fill; VWR/Sigma use CSV/XLSX file drop.
 * Pass opts.strategy = "file" | "form" to override.
 *
 * Call via runtime message:
 *   { type: "PUSH_CART_TO_VENDOR", items: [...], vendorName: "fisher" }
 *
 * @param {Array<object>} items
 * @param {string} vendorName
 * @param {object} [opts]
 * @returns {Promise<object>}
 */
async function pushCartToVendor(items, vendorName, opts) {
  opts = opts || {};
  if (!CART_STUFFING_ENABLED) {
    return {
      ok: false,
      error: "feature_disabled",
      errorMessage: "Cart stuffing is disabled."
    };
  }

  const vendorId =
    typeof normalizeVendorId === "function"
      ? normalizeVendorId(vendorName)
      : String(vendorName || "")
          .trim()
          .toLowerCase();
  if (!vendorId) {
    return { ok: false, error: "missing_vendor", errorMessage: "vendorName is required." };
  }

  const defaultStrategy = CART_STUFF_FORM_VENDORS[vendorId] ? "form" : "file";
  const strategyRaw = String(opts.strategy || defaultStrategy).toLowerCase();
  const strategy =
    strategyRaw === "form" || strategyRaw === "line" || strategyRaw === "line_fill" ? "form" : "file";

  /** @type {object|null} */
  let file = null;
  /** @type {Array<object>} */
  let formItems = [];
  let openUrl = String(opts.quickOrderUrl || "").trim();
  let itemCount = 0;

  if (strategy === "form") {
    const cfg =
      typeof getVendorQuickOrderConfig === "function" ? getVendorQuickOrderConfig(vendorId) : null;
    if (!openUrl) {
      openUrl = cfg && cfg.quickOrderUrl ? String(cfg.quickOrderUrl) : "";
    }
    formItems = normalizeCartStuffFormItems(items, vendorId);
    itemCount = formItems.length;
    if (!itemCount) {
      return {
        ok: false,
        error: "missing_items",
        errorMessage: 'No cart items with catalog numbers for vendor "' + vendorId + '".',
        vendorId: vendorId,
        strategy: strategy
      };
    }
  } else {
    if (typeof generateCartFile !== "function") {
      return {
        ok: false,
        error: "generator_missing",
        errorMessage: "cartGenerator.js failed to load in the service worker."
      };
    }
    try {
      file = generateCartFile(items, vendorId);
    } catch (e) {
      return {
        ok: false,
        error: "generate_failed",
        errorMessage: (e && e.message) || "Could not generate vendor cart file.",
        vendorId: vendorId,
        strategy: strategy
      };
    }
    if (!openUrl) openUrl = String(file.quickOrderUrl || "").trim();
    itemCount = file.itemCount;
  }

  if (!openUrl) {
    return {
      ok: false,
      error: "missing_url",
      errorMessage: "No Quick Order URL for vendor " + vendorId,
      vendorId: vendorId,
      strategy: strategy
    };
  }

  let tab;
  try {
    tab = await chrome.tabs.create({ url: openUrl, active: opts.active !== false });
  } catch (eCreate) {
    return {
      ok: false,
      error: "tab_create_failed",
      errorMessage: (eCreate && eCreate.message) || "Could not open vendor Quick Order tab.",
      vendorId: vendorId,
      strategy: strategy
    };
  }
  if (!tab || tab.id == null) {
    return {
      ok: false,
      error: "tab_create_failed",
      errorMessage: "No tab id from chrome.tabs.create.",
      vendorId: vendorId,
      strategy: strategy
    };
  }

  const tabId = tab.id;
  try {
    await waitForTabComplete(tabId, opts.timeoutMs || CART_STUFF_TAB_TIMEOUT_MS);
    /* SPA shells often paint after status=complete — form Quick Order UIs need a bit longer. */
    const defaultSettle = strategy === "form" ? 2000 : 1200;
    await new Promise(function (r) {
      setTimeout(r, opts.settleMs != null ? opts.settleMs : defaultSettle);
    });

    await injectVendorCartInjector(tabId);

    const clickAddToCart =
      opts.clickAddToCart != null ? !!opts.clickAddToCart : strategy === "form";

    /** @type {object} */
    const payload =
      strategy === "form"
        ? {
            vendorId: vendorId,
            strategy: "form",
            items: formItems,
            itemCount: itemCount,
            clickAddToCart: clickAddToCart,
            selectors: opts.selectors || null,
            waitMs: opts.waitMs,
            rowWaitMs: opts.rowWaitMs,
            rowFillDelayMs: opts.rowFillDelayMs,
            addToCartDelayMs: opts.addToCartDelayMs
          }
        : {
            vendorId: file.vendorId,
            strategy: "file",
            filename: file.filename,
            mimeType: file.mimeType,
            encoding: file.encoding,
            body: file.body,
            itemCount: file.itemCount,
            autoSubmit: opts.autoSubmit !== false,
            clickAddToCart: !!opts.clickAddToCart,
            selectors: opts.selectors || null,
            waitMs: opts.waitMs,
            submitDelayMs: opts.submitDelayMs,
            addToCartDelayMs: opts.addToCartDelayMs
          };

    let injectResult = null;
    const maxAttempts = opts.injectAttempts != null ? opts.injectAttempts : 4;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        injectResult = await chrome.tabs.sendMessage(tabId, {
          type: "QUARTZY_CART_STUFF",
          payload: payload
        });
        if (injectResult && injectResult.ok) break;
        if (
          injectResult &&
          CART_STUFF_RETRYABLE_ERRORS[injectResult.error] &&
          attempt < maxAttempts - 1
        ) {
          await new Promise(function (r) {
            setTimeout(r, 800);
          });
          continue;
        }
        if (injectResult) break;
      } catch (eMsg) {
        if (attempt === 0) {
          await injectVendorCartInjector(tabId);
        }
        await new Promise(function (r) {
          setTimeout(r, 500);
        });
        if (attempt === maxAttempts - 1) {
          return {
            ok: false,
            error: "inject_message_failed",
            errorMessage:
              (eMsg && eMsg.message) ||
              "Could not reach vendorCartInjector on the Quick Order tab.",
            vendorId: vendorId,
            strategy: strategy,
            tabId: tabId,
            quickOrderUrl: openUrl,
            filename: file ? file.filename : null,
            itemCount: itemCount
          };
        }
      }
    }

    return {
      ok: !!(injectResult && injectResult.ok),
      vendorId: vendorId,
      strategy: strategy,
      tabId: tabId,
      quickOrderUrl: openUrl,
      filename: file ? file.filename : null,
      mimeType: file ? file.mimeType : null,
      itemCount: itemCount,
      csvPreview: file ? file.csvPreview : null,
      inject: injectResult || null,
      error: injectResult && !injectResult.ok ? injectResult.error : null,
      errorMessage:
        injectResult && !injectResult.ok
          ? injectResult.errorMessage || "Cart stuffing did not succeed."
          : null
    };
  } catch (eRun) {
    return {
      ok: false,
      error: "unexpected",
      errorMessage: (eRun && eRun.message) || "Cart stuffing failed.",
      vendorId: vendorId,
      strategy: strategy,
      tabId: tabId,
      quickOrderUrl: openUrl
    };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PRODUCT_CAPTURE" && sender.tab && sender.tab.id != null) {
    if (fetchPriceJobs.has(sender.tab.id)) {
      return;
    }
    saveAndNotify(sender.tab.id, message.data);
  }

  if (message.type === "FETCH_PRICE_REQUEST") {
    if (!FETCH_PRICE_TEST_ENABLED) {
      sendResponse({
        type: "FETCH_PRICE_DONE",
        ok: false,
        error: "feature_disabled",
        errorMessage: "Fetch Price test tool is disabled.",
        loginState: "unknown",
        mode: "single",
        variants: []
      });
      return;
    }
    runFetchPriceRequest(message.url, message.catalogNumber)
      .then(function (result) {
        sendResponse(result);
      })
      .catch(function (e) {
        sendResponse({
          type: "FETCH_PRICE_DONE",
          ok: false,
          error: "unexpected",
          errorMessage: (e && e.message) || "Unexpected error.",
          loginState: "unknown",
          mode: "single",
          variants: []
        });
      });
    return true;
  }

  if (message.type === "AI_EXTRACT") {
    const doFetch = async () => {
      const base = (message && message.proxyUrl) || AI_EXTRACT_PROXY_URL;
      if (!base || !String(base).trim()) {
        sendResponse({ ok: false, error: "no_proxy" });
        return;
      }
      const url = String(base).trim();
      const systemPrompt = message.systemPrompt != null ? String(message.systemPrompt) : "";
      const body = {
        systemPrompt: systemPrompt,
        context: message.contextText,
        /* Proxy may map this to Google Gemini 3 / 2.5 / Flash, etc. */
        model: (message && message.model) || "gemini-2.0-flash"
      };
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          mode: "cors"
        });
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) || "fetch_error" });
        return;
      }
      if (!res || !res.ok) {
        sendResponse({ ok: false, error: "http_" + (res && res.status) });
        return;
      }
      const raw = await res.text();
      let parsed = parseJsonFromString(raw);
      if (!parsed) {
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          parsed = null;
        }
      }
      if (!parsed) {
        sendResponse({ ok: false, error: "parse" });
        return;
      }
      const o = parsed;
      if (o.item_name == null && o.itemName) {
        o.item_name = o.itemName;
      }
      if (o.catalog_number == null && o.catalogNumber) o.catalog_number = o.catalogNumber;
      if (o.unit_size == null && o.unitSize) o.unit_size = o.unitSize;
      sendResponse({ ok: true, parsed: o });
    };
    doFetch();
    return true;
  }

  if (message.type === "ADD_TO_VENDOR_CART") {
    runAddToVendorCart(message)
      .then(function (result) {
        sendResponse(result);
      })
      .catch(function (e) {
        sendResponse({
          ok: false,
          error: "unexpected",
          errorMessage: (e && e.message) || "Unexpected error."
        });
      });
    return true;
  }

  if (message.type === "PUSH_CART_TO_VENDOR" || message.type === "pushCartToVendor") {
    pushCartToVendor(message.items, message.vendorName || message.vendorId || message.vendor, message)
      .then(function (result) {
        sendResponse(result);
      })
      .catch(function (e) {
        sendResponse({
          ok: false,
          error: "unexpected",
          errorMessage: (e && e.message) || "Unexpected error."
        });
      });
    return true;
  }

  if (message.type === "FETCH_COA" || message.type === "fetchCoa") {
    if (!FETCH_COA_ENABLED) {
      sendResponse({
        ok: false,
        error: "feature_disabled",
        errorMessage: "Fetch CoA is disabled in featureFlags.js."
      });
      return;
    }
    fetchCoa(message)
      .then(function (result) {
        sendResponse(result);
      })
      .catch(function (e) {
        sendResponse({
          ok: false,
          error: "unexpected",
          errorMessage: (e && e.message) || "Unexpected error."
        });
      });
    return true;
  }
});

/** Matches which tabs run `content.js` in manifest (no chrome pages; Quartzy app is excluded). */
function isProductCapturePageUrl(url) {
  if (!url || typeof url !== "string") return false;
  if (!/^https?:\/\//i.test(url)) return false;
  if (/(^chrome-|^edge-|^brave-|^about:|^moz-extension:)/i.test(url) || /:\/\/chrome\.google\./i.test(url)) {
    return false;
  }
  try {
    const h = new URL(url).hostname.toLowerCase();
    if (h === "quartzy.com" || h.endsWith(".quartzy.com")) {
      return false;
    }
  } catch (e) {
    return false;
  }
  return true;
}

/**
 * Resets a tab’s saved capture and shows a loading state so the side panel does not show the previous page’s data.
 */
function resetTabDataForNewNavigation(tab) {
  if (!tab || tab.id == null || !tab.url) return;
  if (!isProductCapturePageUrl(tab.url)) return;
  const u = String(tab.url);
  let vendor = "Unknown";
  try {
    vendor = new URL(u).hostname.replace(/^www\./, "");
  } catch (e) {
    /* use default */
  }
  const data = {
    itemName: "",
    catalogNumber: "",
    price: "",
    unitSize: "",
    url: u,
    vendor,
    fieldSources: { itemName: null, catalogNumber: null, price: null, unitSize: null },
    aiRefined: { itemName: false, catalogNumber: false, price: false, unitSize: false },
    isLoading: true,
    capturePhase: "page-load",
    statusMessage: "Loading page…"
  };
  saveAndNotify(tab.id, data);
}

function saveAndNotify(tabId, data) {
  chrome.storage.local.set({ [`data_${tabId}`]: data }, () => {
    console.log("[Quartzy Connect] Data saved for tab", tabId, data);
  });
  chrome.action.setBadgeText({ tabId: tabId, text: "" });
  try {
    chrome.runtime.sendMessage({
      type: "UPDATE_SIDE_PANEL",
      tabId: tabId,
      data: data
    });
  } catch (e) {
    /* no receiver if side panel closed */
  }
}



// Clean up storage when a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove(`data_${tabId}`);
  const job = fetchPriceJobs.get(tabId);
  if (job && !job.settled) {
    job.settled = true;
    if (job.timeoutId != null) {
      clearTimeout(job.timeoutId);
    }
    if (job.debug) {
      bgDebug(job.debug, "tab_removed_early", { tabId: tabId });
    }
    fetchPriceJobs.delete(tabId);
    try {
      job.resolve({
        type: "FETCH_PRICE_DONE",
        ok: false,
        error: "tab_closed",
        errorMessage: "Background tab closed before scrape finished.",
        loginState: "unknown",
        mode: "single",
        variants: [],
        debug: buildFetchPriceDebugBundle(job.debug || createBgDebugLog(), null, {
          ok: false,
          error: "tab_closed"
        })
      });
    } catch (e) {
      /* ignore */
    }
  }
});

// When navigation starts, clear the prior capture for this tab so the side panel does not show stale data.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const isFetchPriceTab = fetchPriceJobs.has(tabId);

  if (changeInfo.status === "loading" && tab && !isFetchPriceTab) {
    const u = (changeInfo.url != null ? changeInfo.url : null) || tab.url;
    if (u) {
      resetTabDataForNewNavigation({ id: tab.id, url: u });
    }
  }
  if (changeInfo.status === "complete" && tab.url && /^https?:/i.test(tab.url)) {
    if (isFetchPriceTab) {
      const job = fetchPriceJobs.get(tabId);
      if (job && job.debug) {
        bgDebug(job.debug, "tabs_onUpdated_complete", { tabId: tabId, url: tab.url });
      }
      void scrapeFetchPriceTab(tabId);
      return;
    }
    if (!isProductCapturePageUrl(tab.url)) {
      return;
    }
    console.log(`[Background] Navigation complete on tab ${tabId}: ${tab.url}`);

    chrome.tabs.sendMessage(tabId, { type: "TRIGGER_SCRAPE" })
      .catch((err) => console.log("[Quartzy Connect] Content script not ready:", err && err.message));
  }
});