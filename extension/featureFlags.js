/**
 * Dev-only feature gates. Keep these false for customer builds.
 *
 * FETCH_PRICE_TEST_ENABLED — side-panel Fetch Price tool + Add Request “Lookup Price”
 *   (opens background vendor tabs on demand; needs host/cookie permissions).
 *
 * CART_MAPPING_ENABLED — side-panel Cart API mapping mode (hooks fetch/XHR on the
 *   vendor page while you click Add to cart; saves add_to_cart config locally).
 *
 * ADD_TO_VENDOR_SITE_ENABLED — inject “Add to vendor site” on Quartzy Order Requests
 *   (IDP + Group Actions) using saved vendorCartConfigs.
 *
 * CART_STUFFING_ENABLED — open vendor Quick Order and stuff the cart:
 *   Fisher fills the line-by-line form; VWR / Sigma drop a generated CSV/XLSX.
 */
var QUARTZY_FETCH_PRICE_TEST_ENABLED = true;
var QUARTZY_CART_MAPPING_ENABLED = true;
var QUARTZY_ADD_TO_VENDOR_SITE_ENABLED = true;
var QUARTZY_CART_STUFFING_ENABLED = true;
