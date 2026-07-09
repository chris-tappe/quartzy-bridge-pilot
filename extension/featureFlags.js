/**
 * Dev-only feature gates. Keep these false for customer builds.
 *
 * FETCH_PRICE_TEST_ENABLED — side-panel Fetch Price tool + Add Request “Lookup Price”
 *   (opens background vendor tabs on demand; needs host/cookie permissions).
 *
 * CART_MAPPING_ENABLED — side-panel Cart API mapping mode (hooks fetch/XHR on the
 *   vendor page while you click Add to cart; saves add_to_cart config locally).
 */
var QUARTZY_FETCH_PRICE_TEST_ENABLED = true;
var QUARTZY_CART_MAPPING_ENABLED = true;
