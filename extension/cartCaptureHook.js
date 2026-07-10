/**
 * Page-world hook for Cart API mapping mode.
 * Injected via <script src=chrome-extension://…> so it can wrap window.fetch / XHR.
 * Communicates with the isolated content script via window.postMessage.
 */
(function () {
  "use strict";

  if (window.__quartzyCartHookInstalled === "v2") return;
  window.__quartzyCartHookInstalled = "v2";

  var SOURCE = "quartzy-cart-hook";
  var active = false;
  var seq = 0;
  var origFetch = window.fetch;
  var OrigXHR = window.XMLHttpRequest;

  var MUTATING = { POST: 1, PUT: 1, PATCH: 1, DELETE: 1 };
  var HINT_RE =
    /cart|basket|bag|order|checkout|add[-_]?to[-_]?cart|additem|line[-_]?item|commerce|purchase|addtocart/i;

  function headersToObject(headers) {
    var out = {};
    if (!headers) return out;
    try {
      if (typeof Headers !== "undefined" && headers instanceof Headers) {
        headers.forEach(function (v, k) {
          out[String(k)] = String(v);
        });
        return out;
      }
    } catch (e) {
      /* ignore */
    }
    if (Array.isArray(headers)) {
      for (var i = 0; i < headers.length; i++) {
        var pair = headers[i];
        if (pair && pair.length >= 2) out[String(pair[0])] = String(pair[1]);
      }
      return out;
    }
    if (typeof headers === "object") {
      for (var k in headers) {
        if (Object.prototype.hasOwnProperty.call(headers, k)) {
          out[String(k)] = String(headers[k]);
        }
      }
    }
    return out;
  }

  function bodyToPreview(body) {
    if (body == null || body === "") return { kind: "empty", text: "", truncated: false };
    if (typeof body === "string") {
      var s = body.length > 8000 ? body.slice(0, 8000) : body;
      return { kind: "text", text: s, truncated: body.length > 8000 };
    }
    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
      var us = body.toString();
      return {
        kind: "form",
        text: us.length > 8000 ? us.slice(0, 8000) : us,
        truncated: us.length > 8000
      };
    }
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      var parts = [];
      try {
        body.forEach(function (v, key) {
          if (typeof v === "string") parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(v));
          else parts.push(encodeURIComponent(key) + "=[blob]");
        });
      } catch (e) {
        return { kind: "formdata", text: "[FormData]", truncated: false };
      }
      var joined = parts.join("&");
      return {
        kind: "formdata",
        text: joined.length > 8000 ? joined.slice(0, 8000) : joined,
        truncated: joined.length > 8000
      };
    }
    if (typeof Blob !== "undefined" && body instanceof Blob) {
      return { kind: "blob", text: "[Blob " + (body.type || "unknown") + " " + body.size + "b]", truncated: false };
    }
    try {
      var json = JSON.stringify(body);
      if (typeof json === "string") {
        return {
          kind: "json",
          text: json.length > 8000 ? json.slice(0, 8000) : json,
          truncated: json.length > 8000
        };
      }
    } catch (e2) {
      /* ignore */
    }
    return { kind: "unknown", text: String(body).slice(0, 500), truncated: true };
  }

  function scoreRequest(method, url, bodyText) {
    var m = String(method || "GET").toUpperCase();
    var u = String(url || "");
    var b = String(bodyText || "");
    var score = 0;
    if (MUTATING[m]) score += 40;
    if (HINT_RE.test(u)) score += 50;
    if (HINT_RE.test(b)) score += 30;
    if (/\/api\//i.test(u) || /\.json(\?|$)/i.test(u)) score += 10;
    if (m === "GET") score -= 20;
    return score;
  }

  function emitCapture(payload) {
    try {
      window.postMessage(
        {
          source: SOURCE,
          type: "QUARTZY_CART_HOOK_CAPTURE",
          payload: payload
        },
        "*"
      );
    } catch (e) {
      /* ignore */
    }
  }

  function captureAsync(meta, responsePromise) {
    var id = "c" + ++seq + "_" + Date.now();
    var startedAt = Date.now();
    var bodyPrev = bodyToPreview(meta.body);
    var score = scoreRequest(meta.method, meta.url, bodyPrev.text);
    if (score < 30 && !MUTATING[String(meta.method || "").toUpperCase()]) {
      return;
    }
    var base = {
      id: id,
      capturedAt: startedAt,
      method: String(meta.method || "GET").toUpperCase(),
      url: String(meta.url || ""),
      requestHeaders: meta.headers || {},
      requestBody: bodyPrev,
      score: score,
      transport: meta.transport || "fetch"
    };
    Promise.resolve(responsePromise)
      .then(function (info) {
        emitCapture(
          Object.assign({}, base, {
            status: info && info.status != null ? info.status : null,
            responsePreview:
              info && info.responsePreview != null
                ? String(info.responsePreview).slice(0, 2000)
                : "",
            durationMs: Date.now() - startedAt
          })
        );
      })
      .catch(function () {
        emitCapture(
          Object.assign({}, base, {
            status: null,
            responsePreview: "",
            durationMs: Date.now() - startedAt,
            error: true
          })
        );
      });
  }

  function resolveUrl(input) {
    try {
      if (typeof input === "string") return new URL(input, location.href).href;
      if (input && typeof input.url === "string") return new URL(input.url, location.href).href;
    } catch (e) {
      /* ignore */
    }
    return String(input || "");
  }

  function wrapFetch() {
    if (typeof origFetch !== "function") return;
    window.fetch = function (input, init) {
      init = init || {};
      var method = (init.method || (input && input.method) || "GET").toUpperCase();
      var url = resolveUrl(input);
      var headers = headersToObject(init.headers || (input && input.headers));
      var body = init.body != null ? init.body : null;
      var p = origFetch.apply(this, arguments);
      if (active) {
        captureAsync(
          { method: method, url: url, headers: headers, body: body, transport: "fetch" },
          p
            .then(function (res) {
              return res
                .clone()
                .text()
                .then(function (t) {
                  return { status: res.status, responsePreview: t };
                })
                .catch(function () {
                  return { status: res.status, responsePreview: "" };
                });
            })
            .catch(function () {
              return { status: null, responsePreview: "" };
            })
        );
      }
      return p;
    };
  }

  function wrapXHR() {
    if (typeof OrigXHR !== "function") return;
    function PatchedXHR() {
      var xhr = new OrigXHR();
      var _method = "GET";
      var _url = "";
      var _headers = {};
      var _body = null;
      var _async = true;

      var origOpen = xhr.open;
      xhr.open = function (method, url, async) {
        _method = String(method || "GET").toUpperCase();
        _url = resolveUrl(url);
        _async = async !== false;
        return origOpen.apply(xhr, arguments);
      };

      var origSetHeader = xhr.setRequestHeader;
      xhr.setRequestHeader = function (name, value) {
        _headers[String(name)] = String(value);
        return origSetHeader.apply(xhr, arguments);
      };

      var origSend = xhr.send;
      xhr.send = function (body) {
        _body = body;
        if (active) {
          var done = new Promise(function (resolve) {
            function finish() {
              resolve({
                status: xhr.status,
                responsePreview: typeof xhr.responseText === "string" ? xhr.responseText : ""
              });
            }
            xhr.addEventListener("loadend", finish, { once: true });
            xhr.addEventListener("error", finish, { once: true });
            xhr.addEventListener("abort", finish, { once: true });
          });
          captureAsync(
            {
              method: _method,
              url: _url,
              headers: Object.assign({}, _headers),
              body: _body,
              transport: "xhr"
            },
            done
          );
        }
        return origSend.apply(xhr, arguments);
      };

      return xhr;
    }
    PatchedXHR.prototype = OrigXHR.prototype;
    PatchedXHR.UNSENT = OrigXHR.UNSENT;
    PatchedXHR.OPENED = OrigXHR.OPENED;
    PatchedXHR.HEADERS_RECEIVED = OrigXHR.HEADERS_RECEIVED;
    PatchedXHR.LOADING = OrigXHR.LOADING;
    PatchedXHR.DONE = OrigXHR.DONE;
    window.XMLHttpRequest = PatchedXHR;
  }

  wrapFetch();
  wrapXHR();

  function reply(type, requestId, payload) {
    try {
      window.postMessage(
        {
          source: SOURCE,
          type: type,
          requestId: requestId,
          payload: payload || {}
        },
        "*"
      );
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * Same-origin fetch from the page world (Akamai sensor cookies + real Referer).
   * @param {object} req
   */
  function handlePageFetch(req) {
    var requestId = req && req.requestId;
    var method = String((req && req.method) || "POST").toUpperCase();
    var url = String((req && req.url) || "");
    var headers = (req && req.headers) || {};
    var body = req && req.body != null ? req.body : null;
    if (!url) {
      reply("QUARTZY_CART_PAGE_FETCH_RESULT", requestId, {
        ok: false,
        error: "missing_url",
        errorMessage: "Missing cart URL."
      });
      return;
    }
    /* Let the browser set Origin/Referer from this document. */
    var safeHeaders = {};
    Object.keys(headers).forEach(function (k) {
      if (/^(origin|referer|cookie|host|content-length)$/i.test(k)) return;
      safeHeaders[k] = headers[k];
    });
    var init = {
      method: method,
      headers: safeHeaders,
      credentials: "include",
      redirect: "follow"
    };
    if (method !== "GET" && method !== "HEAD" && body != null) {
      init.body = body;
    }
    origFetch
      .call(window, url, init)
      .then(function (res) {
        return res.text().then(function (text) {
          var responseHeaders = {};
          try {
            res.headers.forEach(function (v, k) {
              responseHeaders[k] = v;
            });
          } catch (eH) {
            /* ignore */
          }
          reply("QUARTZY_CART_PAGE_FETCH_RESULT", requestId, {
            ok: res.ok,
            status: res.status,
            responseHeaders: responseHeaders,
            responseBody: String(text || "").slice(0, 50000),
            pageUrl: location.href
          });
        });
      })
      .catch(function (e) {
        reply("QUARTZY_CART_PAGE_FETCH_RESULT", requestId, {
          ok: false,
          error: "network",
          errorMessage: (e && e.message) || "Page fetch failed.",
          pageUrl: location.href
        });
      });
  }

  function findAddToCartButton() {
    var selectors = [
      "button[data-testid*='add-to-cart' i]",
      "button[id*='addToCart' i]",
      "button[id*='add-to-cart' i]",
      "button[class*='add-to-cart' i]",
      "button[class*='addToCart' i]",
      "input[type='submit'][value*='Add to Cart' i]",
      "a[id*='addToCart' i]",
      "[data-action*='add-to-cart' i]",
      "button[name*='addToCart' i]"
    ];
    for (var i = 0; i < selectors.length; i++) {
      try {
        var el = document.querySelector(selectors[i]);
        if (el && el.offsetParent !== null) return el;
      } catch (e) {
        /* invalid selector in older engines — ignore */
      }
    }
    var candidates = document.querySelectorAll("button, a[role='button'], input[type='button'], input[type='submit']");
    for (var j = 0; j < candidates.length; j++) {
      var node = candidates[j];
      var label = (
        (node.innerText || node.textContent || node.value || node.getAttribute("aria-label") || "") +
        " " +
        (node.className || "") +
        " " +
        (node.id || "")
      )
        .replace(/\s+/g, " ")
        .trim();
      if (/add\s*to\s*cart|add\s*to\s*bag|add\s*item/i.test(label) && !/login|sign\s*in/i.test(label)) {
        if (node.offsetParent !== null || node.getClientRects().length) return node;
      }
    }
    return null;
  }

  function setQtyOnPage(qty) {
    var q = String(qty || "1");
    var inputs = document.querySelectorAll(
      "input[name*='qty' i], input[id*='qty' i], input[name*='quantity' i], input[id*='quantity' i], input[aria-label*='quantity' i]"
    );
    for (var i = 0; i < inputs.length; i++) {
      var input = inputs[i];
      if (!input || input.disabled || input.type === "hidden") continue;
      try {
        input.focus();
        input.value = q;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      } catch (e) {
        /* ignore */
      }
    }
    return false;
  }

  function handleClickAtc(req) {
    var requestId = req && req.requestId;
    var qty = (req && req.qty) || "1";
    setQtyOnPage(qty);
    var btn = findAddToCartButton();
    if (!btn) {
      reply("QUARTZY_CART_CLICK_RESULT", requestId, {
        ok: false,
        error: "no_button",
        errorMessage: "Could not find an Add to cart button on this page.",
        pageUrl: location.href
      });
      return;
    }
    try {
      btn.click();
      reply("QUARTZY_CART_CLICK_RESULT", requestId, {
        ok: true,
        method: "dom_click",
        buttonText: String(btn.innerText || btn.value || btn.id || "add-to-cart")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 120),
        pageUrl: location.href,
        qtySet: true
      });
    } catch (e) {
      reply("QUARTZY_CART_CLICK_RESULT", requestId, {
        ok: false,
        error: "click_failed",
        errorMessage: (e && e.message) || "Click failed.",
        pageUrl: location.href
      });
    }
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.source !== SOURCE) return;
    if (data.type === "QUARTZY_CART_HOOK_CMD") {
      active = !!(data.payload && data.payload.active);
      try {
        window.postMessage(
          {
            source: SOURCE,
            type: "QUARTZY_CART_HOOK_ACK",
            payload: { active: active }
          },
          "*"
        );
      } catch (e) {
        /* ignore */
      }
      return;
    }
    if (data.type === "QUARTZY_CART_PAGE_FETCH") {
      handlePageFetch(data.payload || data);
      return;
    }
    if (data.type === "QUARTZY_CART_CLICK_ATC") {
      handleClickAtc(data.payload || data);
    }
  });
})();
