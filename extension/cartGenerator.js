/**
 * Vendor Quick-Order / Bulk-Upload file generators.
 *
 * Templates (from vendor downloads):
 * - Fisher: Part Number | UOM (optional) | Quantity ordered  → .xlsx (site requires Excel)
 * - VWR:    Catalog Number,UOM,Quantity                     → .csv
 * - Sigma:  SKU,Quantity,Promo Code,Reference Number       → .csv (UTF-8 BOM)
 * - Bio-Rad: #Catalog Number,Quantity (1 to 999)           → .csv (form fill preferred)
 *
 * Usable from the service worker via importScripts, or any content/page script.
 */
(function (root) {
  "use strict";

  /**
   * @typedef {{
   *   catalogNumber?: string,
   *   sku?: string,
   *   quantity?: number|string,
   *   qty?: number|string,
   *   vendor?: string,
   *   uom?: string,
   *   unitOfMeasure?: string,
   *   promoCode?: string,
   *   referenceNumber?: string
   * }} CartItem
   */

  /**
   * @typedef {{
   *   vendorId: string,
   *   quickOrderUrl: string,
   *   filename: string,
   *   mimeType: string,
   *   encoding: 'utf8'|'base64',
   *   body: string,
   *   itemCount: number,
   *   csvPreview?: string
   * }} GeneratedCartFile
   */

  /** @type {Record<string, { id: string, aliases: string[], quickOrderUrl: string, filename: string, mimeType: string }>} */
  const VENDOR_QUICK_ORDER = {
    fisher: {
      id: "fisher",
      aliases: ["fisher", "fishersci", "fisher scientific", "thermo fisher", "thermofisher"],
      quickOrderUrl: "https://www.fishersci.com/store1/rapidorder",
      filename: "bulk_upload.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    },
    vwr: {
      id: "vwr",
      aliases: ["vwr", "avantor"],
      quickOrderUrl: "https://www.vwr.com/us/en/my-account/quick-order",
      filename: "order_entry_template.csv",
      mimeType: "text/csv"
    },
    sigma: {
      id: "sigma",
      aliases: ["sigma", "sigma-aldrich", "sigmaaldrich", "millipore", "milliporesigma"],
      quickOrderUrl: "https://www.sigmaaldrich.com/US/en/quick-order",
      filename: "quick_order_template.csv",
      mimeType: "text/csv"
    },
    biorad: {
      id: "biorad",
      aliases: ["biorad", "bio-rad", "bio rad", "bio rad laboratories"],
      quickOrderUrl: "https://commerce.bio-rad.com/bc/en-us/quick-order",
      filename: "BioRad_QuickOrder_Upload_Template.csv",
      mimeType: "text/csv"
    }
  };

  /**
   * @param {string} vendorName
   * @returns {string}
   */
  function normalizeVendorId(vendorName) {
    const raw = String(vendorName || "")
      .trim()
      .toLowerCase()
      .replace(/[_]+/g, " ");
    if (!raw) return "";
    const keys = Object.keys(VENDOR_QUICK_ORDER);
    for (let i = 0; i < keys.length; i++) {
      const cfg = VENDOR_QUICK_ORDER[keys[i]];
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
   * @returns {{ id: string, aliases: string[], quickOrderUrl: string, filename: string, mimeType: string }|null}
   */
  function getVendorQuickOrderConfig(vendorName) {
    const id = normalizeVendorId(vendorName);
    return VENDOR_QUICK_ORDER[id] || null;
  }

  /**
   * @param {CartItem[]} items
   * @param {string} vendorName
   * @returns {CartItem[]}
   */
  function filterItemsForVendor(items, vendorName) {
    const list = Array.isArray(items) ? items : [];
    const vendorId = normalizeVendorId(vendorName);
    if (!vendorId) return list.slice();
    return list.filter(function (item) {
      if (!item || item.vendor == null || String(item.vendor).trim() === "") return true;
      return normalizeVendorId(item.vendor) === vendorId;
    });
  }

  /**
   * @param {CartItem} item
   * @returns {string}
   */
  function itemSku(item) {
    return String((item && (item.catalogNumber || item.sku)) || "").trim();
  }

  /**
   * @param {CartItem} item
   * @returns {string}
   */
  function itemQty(item) {
    const q = item && (item.quantity != null ? item.quantity : item.qty);
    const n = Number(q);
    if (Number.isFinite(n) && n > 0) return String(Math.floor(n));
    const s = String(q == null ? "1" : q).trim();
    return s || "1";
  }

  /**
   * @param {CartItem} item
   * @returns {string}
   */
  function itemUom(item) {
    return String((item && (item.uom || item.unitOfMeasure)) || "").trim();
  }

  /**
   * @param {string} value
   * @returns {string}
   */
  function csvEscape(value) {
    const s = String(value == null ? "" : value);
    if (/[",\r\n]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  /**
   * @param {string[]} row
   * @returns {string}
   */
  function csvRow(row) {
    return row.map(csvEscape).join(",");
  }

  /**
   * Fisher Scientific Rapid Order bulk upload.
   * Official template columns: Part Number | UOM (optional) | Quantity ordered
   * Site accepts .xlsx / .xls only — CSV string is returned for preview/debug;
   * {@link generateCartFile} emits a real .xlsx for upload.
   *
   * @param {CartItem[]} items
   * @returns {string}
   */
  function generateFisherCsv(items) {
    const lines = ["Part Number,UOM (optional),Quantity ordered"];
    const list = Array.isArray(items) ? items : [];
    for (let i = 0; i < list.length; i++) {
      const sku = itemSku(list[i]);
      if (!sku) continue;
      lines.push(csvRow([sku, itemUom(list[i]), itemQty(list[i])]));
    }
    return lines.join("\r\n") + (lines.length > 1 ? "\r\n" : "");
  }

  /**
   * VWR / Avantor Order Entry upload.
   * Template: Catalog Number,UOM,Quantity
   *
   * @param {CartItem[]} items
   * @returns {string}
   */
  function generateVwrCsv(items) {
    const lines = ["Catalog Number,UOM,Quantity"];
    const list = Array.isArray(items) ? items : [];
    for (let i = 0; i < list.length; i++) {
      const sku = itemSku(list[i]);
      if (!sku) continue;
      lines.push(csvRow([sku, itemUom(list[i]), itemQty(list[i])]));
    }
    return lines.join("\r\n") + (lines.length > 1 ? "\r\n" : "");
  }

  /**
   * Sigma-Aldrich Quick Order bulk upload.
   * Template: SKU,Quantity,Promo Code,Reference Number (UTF-8 BOM)
   *
   * @param {CartItem[]} items
   * @returns {string}
   */
  function generateSigmaCsv(items) {
    const lines = ["SKU,Quantity,Promo Code,Reference Number"];
    const list = Array.isArray(items) ? items : [];
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      const sku = itemSku(item);
      if (!sku) continue;
      lines.push(
        csvRow([
          sku,
          itemQty(item),
          String((item && item.promoCode) || "").trim(),
          String((item && item.referenceNumber) || "").trim()
        ])
      );
    }
    return "\uFEFF" + lines.join("\r\n") + (lines.length > 1 ? "\r\n" : "");
  }

  /**
   * Bio-Rad Quick Order bulk upload template.
   * Prefer Manual entry form fill; CSV is available as a fallback.
   *
   * @param {CartItem[]} items
   * @returns {string}
   */
  function generateBioradCsv(items) {
    const lines = ["#Catalog Number,Quantity (1 to 999),,,"];
    const list = Array.isArray(items) ? items : [];
    for (let i = 0; i < list.length; i++) {
      const sku = itemSku(list[i]);
      if (!sku) continue;
      lines.push(csvRow([sku, itemQty(list[i]), "", "", ""]));
    }
    return lines.join("\r\n") + (lines.length > 1 ? "\r\n" : "");
  }

  /**
   * @param {CartItem[]} items
   * @param {string} vendorName
   * @returns {string}
   */
  function generateCartCsv(items, vendorName) {
    const vendorId = normalizeVendorId(vendorName);
    const filtered = filterItemsForVendor(items, vendorId);
    if (vendorId === "fisher") return generateFisherCsv(filtered);
    if (vendorId === "vwr") return generateVwrCsv(filtered);
    if (vendorId === "sigma") return generateSigmaCsv(filtered);
    if (vendorId === "biorad") return generateBioradCsv(filtered);
    throw new Error('Unsupported vendor for cart CSV: "' + vendorName + '"');
  }

  /* —— Minimal XLSX (OOXML, store-only ZIP) for Fisher —— */

  /**
   * @param {string} s
   * @returns {string}
   */
  function xmlEscape(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /**
   * @param {string} str
   * @returns {Uint8Array}
   */
  function utf8Bytes(str) {
    if (typeof TextEncoder !== "undefined") {
      return new TextEncoder().encode(str);
    }
    const out = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        const c2 = str.charCodeAt(++i);
        const cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
        out.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f),
          0x80 | (cp & 0x3f)
        );
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return new Uint8Array(out);
  }

  /** CRC-32 for ZIP local headers. */
  const CRC_TABLE = (function () {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  /**
   * @param {Uint8Array} buf
   * @returns {number}
   */
  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  /**
   * @param {Array<{ name: string, data: Uint8Array }>} files
   * @returns {Uint8Array}
   */
  function zipStore(files) {
    const parts = [];
    const central = [];
    let offset = 0;

    function u16(n) {
      return new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
    }
    function u32(n) {
      return new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);
    }

    for (let i = 0; i < files.length; i++) {
      const nameBytes = utf8Bytes(files[i].name);
      const data = files[i].data;
      const crc = crc32(data);
      const local = new Uint8Array(
        30 + nameBytes.length + data.length
      );
      let p = 0;
      const write = function (arr) {
        local.set(arr, p);
        p += arr.length;
      };
      write(u32(0x04034b50));
      write(u16(20));
      write(u16(0));
      write(u16(0));
      write(u16(0));
      write(u16(0));
      write(u32(crc));
      write(u32(data.length));
      write(u32(data.length));
      write(u16(nameBytes.length));
      write(u16(0));
      local.set(nameBytes, p);
      p += nameBytes.length;
      local.set(data, p);

      const localHeaderSize = 30 + nameBytes.length;
      parts.push(local);

      const cen = new Uint8Array(46 + nameBytes.length);
      p = 0;
      const writeC = function (arr) {
        cen.set(arr, p);
        p += arr.length;
      };
      writeC(u32(0x02014b50));
      writeC(u16(20));
      writeC(u16(20));
      writeC(u16(0));
      writeC(u16(0));
      writeC(u16(0));
      writeC(u16(0));
      writeC(u32(crc));
      writeC(u32(data.length));
      writeC(u32(data.length));
      writeC(u16(nameBytes.length));
      writeC(u16(0));
      writeC(u16(0));
      writeC(u16(0));
      writeC(u16(0));
      writeC(u32(0));
      writeC(u32(offset));
      cen.set(nameBytes, p);
      central.push(cen);

      offset += localHeaderSize + data.length;
    }

    let centralSize = 0;
    for (let j = 0; j < central.length; j++) centralSize += central[j].length;
    const end = new Uint8Array(22);
    let ep = 0;
    const writeE = function (arr) {
      end.set(arr, ep);
      ep += arr.length;
    };
    writeE(u32(0x06054b50));
    writeE(u16(0));
    writeE(u16(0));
    writeE(u16(files.length));
    writeE(u16(files.length));
    writeE(u32(centralSize));
    writeE(u32(offset));
    writeE(u16(0));

    let total = end.length + centralSize;
    for (let k = 0; k < parts.length; k++) total += parts[k].length;
    const out = new Uint8Array(total);
    let o = 0;
    for (let a = 0; a < parts.length; a++) {
      out.set(parts[a], o);
      o += parts[a].length;
    }
    for (let b = 0; b < central.length; b++) {
      out.set(central[b], o);
      o += central[b].length;
    }
    out.set(end, o);
    return out;
  }

  /**
   * @param {Uint8Array} bytes
   * @returns {string}
   */
  function bytesToBase64(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(
        null,
        Array.prototype.slice.call(bytes.subarray(i, i + chunk))
      );
    }
    return btoa(binary);
  }

  /**
   * Build a minimal .xlsx matching Fisher's bulk_upload_template columns.
   *
   * @param {CartItem[]} items
   * @returns {Uint8Array}
   */
  function generateFisherXlsxBytes(items) {
    const rows = [["Part Number", "UOM (optional)", "Quantity ordered"]];
    const list = Array.isArray(items) ? items : [];
    for (let i = 0; i < list.length; i++) {
      const sku = itemSku(list[i]);
      if (!sku) continue;
      rows.push([sku, itemUom(list[i]), itemQty(list[i])]);
    }

    let sheetXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      "<sheetData>";
    for (let r = 0; r < rows.length; r++) {
      sheetXml += '<row r="' + (r + 1) + '">';
      for (let c = 0; c < rows[r].length; c++) {
        const col = String.fromCharCode(65 + c);
        const ref = col + (r + 1);
        sheetXml +=
          '<c r="' +
          ref +
          '" t="inlineStr"><is><t>' +
          xmlEscape(rows[r][c]) +
          "</t></is></c>";
      }
      sheetXml += "</row>";
    }
    sheetXml += "</sheetData></worksheet>";

    const contentTypes =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      "</Types>";

    const rels =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      "</Relationships>";

    const workbook =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      "<sheets><sheet name=\"Sheet1\" sheetId=\"1\" r:id=\"rId1\"/></sheets>" +
      "</workbook>";

    const workbookRels =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      "</Relationships>";

    return zipStore([
      { name: "[Content_Types].xml", data: utf8Bytes(contentTypes) },
      { name: "_rels/.rels", data: utf8Bytes(rels) },
      { name: "xl/workbook.xml", data: utf8Bytes(workbook) },
      { name: "xl/_rels/workbook.xml.rels", data: utf8Bytes(workbookRels) },
      { name: "xl/worksheets/sheet1.xml", data: utf8Bytes(sheetXml) }
    ]);
  }

  /**
   * Build the uploadable file payload for a vendor.
   *
   * @param {CartItem[]} items
   * @param {string} vendorName
   * @returns {GeneratedCartFile}
   */
  function generateCartFile(items, vendorName) {
    const cfg = getVendorQuickOrderConfig(vendorName);
    if (!cfg) {
      throw new Error('Unsupported vendor for cart stuffing: "' + vendorName + '"');
    }
    const filtered = filterItemsForVendor(items, cfg.id);
    const withSku = filtered.filter(function (it) {
      return !!itemSku(it);
    });
    if (!withSku.length) {
      throw new Error('No cart items with catalog numbers for vendor "' + cfg.id + '".');
    }

    if (cfg.id === "fisher") {
      const bytes = generateFisherXlsxBytes(withSku);
      return {
        vendorId: cfg.id,
        quickOrderUrl: cfg.quickOrderUrl,
        filename: cfg.filename,
        mimeType: cfg.mimeType,
        encoding: "base64",
        body: bytesToBase64(bytes),
        itemCount: withSku.length,
        csvPreview: generateFisherCsv(withSku)
      };
    }

    const csv =
      cfg.id === "vwr"
        ? generateVwrCsv(withSku)
        : cfg.id === "biorad"
          ? generateBioradCsv(withSku)
          : generateSigmaCsv(withSku);
    return {
      vendorId: cfg.id,
      quickOrderUrl: cfg.quickOrderUrl,
      filename: cfg.filename,
      mimeType: cfg.mimeType,
      encoding: "utf8",
      body: csv,
      itemCount: withSku.length,
      csvPreview: csv
    };
  }

  const api = {
    VENDOR_QUICK_ORDER: VENDOR_QUICK_ORDER,
    normalizeVendorId: normalizeVendorId,
    getVendorQuickOrderConfig: getVendorQuickOrderConfig,
    filterItemsForVendor: filterItemsForVendor,
    generateFisherCsv: generateFisherCsv,
    generateVwrCsv: generateVwrCsv,
    generateSigmaCsv: generateSigmaCsv,
    generateBioradCsv: generateBioradCsv,
    generateCartCsv: generateCartCsv,
    generateFisherXlsxBytes: generateFisherXlsxBytes,
    generateCartFile: generateCartFile
  };

  if (typeof root !== "undefined" && root) {
    root.QuartzyCartGenerator = api;
    const keys = Object.keys(api);
    for (let i = 0; i < keys.length; i++) {
      root[keys[i]] = api[keys[i]];
    }
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof self !== "undefined" ? self : typeof globalThis !== "undefined" ? globalThis : this);
