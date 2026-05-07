/**
 * Magic Wand: selection cursor, document ::selection, mouseup → getSelection, cancel pill.
 */
(function (global) {
  "use strict";

  const SELECTION_STYLE_ID = "quartzy-connect-selection-style";
  const PROMPT_ID = "quartzy-connect-selection-prompt";

  const fieldLabels = {
    itemName: "Item Name",
    catalogNumber: "Catalog #",
    price: "Price",
    unitSize: "Unit Size"
  };

  function ensureSelectionStyle() {
    if (document.getElementById(SELECTION_STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = SELECTION_STYLE_ID;
    /* Force user-select: text so drag-select works inside custom widgets that disable selection
     * (e.g. <label> wrappers around hidden radios for variant pickers). */
    s.textContent = [
      "::-moz-selection { background: rgba(247, 94, 45, 0.3) !important; color: inherit; }",
      "::selection { background: rgba(247, 94, 45, 0.3) !important; color: inherit; }",
      "html.quartzy-connect-selection-active, html.quartzy-connect-selection-active * {",
      "  -webkit-user-select: text !important;",
      "  -moz-user-select: text !important;",
      "  -ms-user-select: text !important;",
      "  user-select: text !important;",
      "}"
    ].join("\n");
    (document.head || document.documentElement).appendChild(s);
  }

  const BUTTON_LIKE_SELECTOR =
    "label, button, [role=button], [role=option], [role=radio], [role=tab], [role=checkbox]";

  /**
   * Fallback when drag-select produced no text — common on custom widgets like a
   * <label> wrapping a hidden <input type="radio"> with a visible <span>.
   * Returns the text + a synthetic Range so DomFieldHints can still build a CSS path.
   * @param {EventTarget|null} target
   * @returns {{ text: string, range: Range|null }|null}
   */
  function grabFallbackFromTarget(target) {
    if (!target || target.nodeType !== 1) return null;
    let el = target;
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      el = (typeof el.closest === "function" && el.closest(BUTTON_LIKE_SELECTOR))
        || el.parentElement
        || el;
    }
    const buttonEl = (typeof el.closest === "function" && el.closest(BUTTON_LIKE_SELECTOR)) || null;
    if (!buttonEl) return null;
    const raw = buttonEl.innerText != null ? buttonEl.innerText : (buttonEl.textContent || "");
    const txt = String(raw).replace(/\s+/g, " ").trim();
    if (!txt || txt.length > 200) return null;
    let range = null;
    try {
      range = document.createRange();
      range.selectNodeContents(buttonEl);
    } catch (e) {
      range = null;
    }
    return { text: txt, range: range };
  }

  function removeSelectionStyle() {
    const el = document.getElementById(SELECTION_STYLE_ID);
    if (el) el.remove();
  }

  function ensurePromptBar(text, onCancel) {
    const existing = document.getElementById(PROMPT_ID);
    if (existing) existing.remove();
    const bar = document.createElement("div");
    bar.id = PROMPT_ID;
    bar.setAttribute("data-quartzy-connect", "selection-prompt");
    Object.assign(bar.style, {
      position: "fixed",
      left: "50%",
      bottom: "24px",
      transform: "translateX(-50%)",
      zIndex: "2147483647",
      background: "#111827",
      color: "#f9fafb",
      fontFamily: "Inter, system-ui, sans-serif",
      fontSize: "13px",
      padding: "10px 18px",
      borderRadius: "9999px",
      display: "flex",
      alignItems: "center",
      gap: "10px",
      boxShadow: "0 4px 24px rgba(0,0,0,0.35)"
    });
    const msg = document.createElement("span");
    msg.textContent = text;
    const link = document.createElement("button");
    link.type = "button";
    link.textContent = "CANCEL";
    Object.assign(link.style, {
      border: "none",
      background: "transparent",
      color: "#f75e2d",
      fontWeight: "700",
      fontSize: "12px",
      letterSpacing: "0.04em",
      cursor: "pointer"
    });
    link.addEventListener("click", onCancel);
    bar.appendChild(msg);
    bar.appendChild(link);
    document.documentElement.appendChild(bar);
  }

  function removePromptBar() {
    const bar = document.getElementById(PROMPT_ID);
    if (bar) bar.remove();
  }

  const SelectionMode = {
    _active: false,
    _onEnd: null,

    isActive() {
      return this._active;
    },

    start(field, handlers) {
      if (this._active) this.stop();
      this._active = true;
      const h = handlers || {};
      const self = this;
      ensureSelectionStyle();
      if (document.documentElement) {
        document.documentElement.classList.add("quartzy-connect-selection-active");
      }
      if (document.body) document.body.style.cursor = "cell";

      const end = (reason) => {
        if (!self._active) return;
        self._active = false;
        if (document.body) document.body.style.cursor = "";
        if (document.documentElement) {
          document.documentElement.classList.remove("quartzy-connect-selection-active");
        }
        removeSelectionStyle();
        removePromptBar();
        document.removeEventListener("mouseup", onMouseUp, true);
        if (typeof h.onEnd === "function") h.onEnd(reason);
      };
      this._onEnd = end;

      const label = "Highlight the " + (fieldLabels[field] || String(field)) + " on the page...";
      const onMouseUp = (e) => {
        if (!self._active) return;
        const sel = window.getSelection();
        let text = sel && sel.toString ? sel.toString().trim() : "";
        let range = (sel && sel.rangeCount > 0 && !sel.isCollapsed)
          ? sel.getRangeAt(0).cloneRange()
          : null;
        if (!text) {
          /* Click-without-drag on a button/label/role widget — grab its visible text. */
          const fb = grabFallbackFromTarget(e && e.target);
          if (fb) {
            text = fb.text;
            range = fb.range;
          }
        }
        if (text) {
          end("captured");
          h.onCapture(text, range);
        }
      };
      const onCancel = () => {
        end("cancel");
        if (h.onCancel) h.onCancel();
      };
      ensurePromptBar(label, onCancel);
      document.addEventListener("mouseup", onMouseUp, true);
    },

    stop() {
      if (this._onEnd) this._onEnd("stop");
    }
  };

  global.QuartzySelectionMode = SelectionMode;
})(typeof self !== "undefined" ? self : this);
