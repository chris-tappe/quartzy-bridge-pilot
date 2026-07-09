try {
  importScripts("featureFlags.js");
} catch (e) {
  console.error("[Quartzy Connect] featureFlags import failed:", e);
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

const FETCH_PRICE_TIMEOUT_MS = 18000;

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
  "avantorsciences.com": ["JSESSIONID", "SESSION"]
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
        if (
          (cn === lowerNames[j] || cn.indexOf(lowerNames[j]) !== -1) &&
          list[i].value != null &&
          String(list[i].value).length > 0
        ) {
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
        bgDebug(debug, "content_response", {
          ok: response.ok,
          error: response.error || null,
          mode: response.mode,
          variantCount: Array.isArray(response.variants) ? response.variants.length : 0,
          loginStateDom: response.loginState,
          pageUrl: response.pageUrl || null
        });
        break;
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