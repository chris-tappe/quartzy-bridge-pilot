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
    s.textContent = [
      "::-moz-selection { background: rgba(239, 68, 68, 0.3) !important; color: inherit; }",
      "::selection { background: rgba(239, 68, 68, 0.3) !important; color: inherit; }"
    ].join("\n");
    (document.head || document.documentElement).appendChild(s);
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
      color: "#f87171",
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
      if (document.body) document.body.style.cursor = "cell";

      const end = (reason) => {
        if (!self._active) return;
        self._active = false;
        if (document.body) document.body.style.cursor = "";
        removeSelectionStyle();
        removePromptBar();
        document.removeEventListener("mouseup", onMouseUp, true);
        if (typeof h.onEnd === "function") h.onEnd(reason);
      };
      this._onEnd = end;

      const label = "Highlight the " + (fieldLabels[field] || String(field)) + " on the page...";
      const onMouseUp = () => {
        if (!self._active) return;
        const sel = window.getSelection();
        const text = sel && sel.toString ? sel.toString().trim() : "";
        if (text) {
          end("captured");
          h.onCapture(text);
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
