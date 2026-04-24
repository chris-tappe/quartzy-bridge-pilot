/**
 * Prepares sanitized product DOM text for LLM consumption (no live DOM mutation).
 */
(function (global) {
  "use strict";

  const REJECT = "script, style, svg, nav, footer, noscript";

  function pickContentRoot(doc) {
    if (!doc || !doc.querySelector) return null;
    return (
      doc.querySelector("#product-details") ||
      doc.querySelector("main") ||
      doc.body ||
      null
    );
  }

  /**
   * Injects a marker span immediately after each checked radio/checkbox in the (cloned) tree.
   * The marker is not display:none so innerText typically includes the hint for the model.
   * @param {Element} root
   */
  function injectUserSelectedMarkers(root) {
    if (!root || !root.querySelectorAll) return;
    const sel = 'input[type="radio"]:checked, input[type="checkbox"]:checked';
    const inputs = Array.from(root.querySelectorAll(sel));
    inputs.forEach((input) => {
      const span = (root.ownerDocument || document).createElement("span");
      span.setAttribute("data-quartzy-injected", "user-selected");
      span.textContent = "[USER_SELECTED_OPTION]";
      span.setAttribute("aria-hidden", "true");
      /* Keep text out of the visual view but in layout so innerText usually retains it. */
      span.style.cssText =
        "position:absolute;clip:rect(0,0,0,0);clip-path:inset(50%);height:1px;width:1px;overflow:hidden;white-space:nowrap;";
      const p = input.parentNode;
      if (p) {
        if (input.nextSibling) {
          p.insertBefore(span, input.nextSibling);
        } else {
          p.appendChild(span);
        }
      }
    });
  }

  function stripUnwanted(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll(REJECT).forEach((n) => {
      try {
        n.remove();
      } catch (e) {
        /* ignore */
      }
    });
  }

  /**
   * @param {Document} doc
   * @returns {string} Minimized innerText of the focused product region, with [USER_SELECTED_OPTION] markers.
   */
  function getProductContextText(doc) {
    const d = doc || (typeof document !== "undefined" ? document : null);
    if (!d) return "";
    const srcRoot = pickContentRoot(d);
    if (!srcRoot) return "";
    let text = "";
    try {
      const clone = srcRoot.cloneNode(true);
      injectUserSelectedMarkers(clone);
      stripUnwanted(clone);
      const raw = clone.innerText || "";
      text = String(raw)
        .replace(/\s+/g, " ")
        .trim();
    } catch (e) {
      console.log("[Quartzy Bridge] ContextService getProductContextText failed:", e && e.message);
      return "";
    }
    if (text && text.indexOf("[USER_SELECTED_OPTION]") === -1) {
      const hasChecked =
        d.querySelector(
          'input[type="radio"]:checked, input[type="checkbox"]:checked'
        ) != null;
      if (hasChecked) {
        text = (text ? text + " " : "") + "[USER_SELECTED_OPTION]";
      }
    }
    return text;
  }

  const ContextService = {
    getProductContextText,
    pickContentRoot
  };

  global.QuartzyContextService = ContextService;
})(typeof self !== "undefined" ? self : this);
