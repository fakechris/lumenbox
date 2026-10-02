# Target (www.target.com, redsky.target.com)

Covers: Target's best match for a product name (price, rating, TCIN, link); pickup, in-store and shipping availability for a TCIN at a store or near a ZIP.
Not covered: cart, checkout, sign-in.

## The redsky API

The site is a front end over JSON at `redsky.target.com/redsky_aggregations/v1/web/…`. It needs a `key` — a static public token in Target's own pages: look in the search page's HTML for `"apiKey":"{40 hex chars}"` near `redsky_aggregations`. Send `Accept: application/json` and print the status (`curl -sS -w '\nHTTP %{http_code}'`).

## Product search

`GET …/plp_search_v2?key={key}&channel=WEB&keyword={q}&page=%2Fs%2F{q}&visitor_id={any string}&pricing_store_id=2885&default_purchasability_filter=true&count=24`

- Missing any of `key`, `channel`, `keyword`, `page` (must start `/s/`), `visitor_id`, `pricing_store_id` → bare 400.
- `pricing_store_id=2885` is the web default (nationwide pricing). Optional: `offset` (0, 24, 48 — `page_number` does nothing), `store_ids={id}` (in stock there), `category`, `platform`, `sort_by` = `relevance`, `Featured`, `PriceLow`, `PriceHigh`, `RatingHigh`, `bestselling`, `newest`.
- **This call is usually blocked from a box**: HTTP 435 with `{"appId":"PXGWPp4wUS","blockScript":…}` (PerimeterX). Treat that as blocked — do not repeat, swap keys or add headers; go to the browser. A 403 with `captchaAbsoluteURL` is a captcha wall. Other 4xx probably means the key changed; fetch it again.

Read under `data.search.search_response` first:
- No or empty `facet_list` = no real match. Target then fills `products[]` with ~200 unrelated bestsellers (and pads `metadata.total_results`). Never report the first filler as the answer.
- `metadata.auto_corrected_keyword` set = results are for the corrected spelling; say so.

Top hit `data.search.products[0]`: `tcin`; title at `item.product_description.title` (contains entities such as `&#38;`, `&#8482;` — unescape); `item.primary_brand.name` (null for store brands/grocery); current price `price.formatted_current_price` — either an amount or "See price in cart" (a MAP item; `price.current_retail` sometimes has the number); `price.formatted_comparison_price` (was-price); `ratings_and_reviews.statistics.rating.average` / `.count`; `item.enrichment.buy_url`; `item.enrichment.image_info.primary_image.url`; `desirability_cues[].display`. Skipping entries whose `__typename` isn't `ProductSummary` avoids sponsored slots.

Browser fallback: `https://www.target.com/s?searchTerm={q}`. A Health Data Consent modal hides the grid until "Continue shopping". Product links contain `/-/A-{tcin}`. The site loads HUMAN/PerimeterX (`client.px-cloud.net/PXGWPp4wUS/main.min.js`); plain sessions were challenged within 5–10 requests outside a box.

Product URL: `https://www.target.com/p/{slug}/-/A-{tcin}`; `/-/A-{tcin}` alone redirects to it.

## Pickup and stock for a TCIN

These two endpoints answered (with either known key) even while search returned 435.

1. ZIP → stores (skip if you have a store id): `…/nearby_stores_v1?key={key}&limit=5&within=50&place={ZIP}&channel=WEB&visitor_id={any}` → `data.nearby_stores.stores[]` with `store_id`, `location_name`, `distance`, `status`.
2. Per store (max five): `…/product_fulfillment_v1?key={key}&tcin={tcin}&store_id={id}` (`zip`, `channel`, `visitor_id` optional). Without `store_id` you only get shipping.

Under `data.product.fulfillment`:

| Field | Meaning |
|---|---|
| `store_options[0].order_pickup.availability_status` | `IN_STOCK` / `UNAVAILABLE` |
| `store_options[0].in_store_only.availability_status` | `IN_STOCK` / `NOT_SOLD_IN_STORE` |
| `store_options[0].location_available_to_promise_quantity` | float; 0.0 + UNAVAILABLE = none at that store |
| `shipping_options.availability_status`, `services[].min_delivery_date` | shipping; quantity 10.0 means "10 or more" |
| `sold_out`, `is_out_of_stock_in_all_store_locations` | all-store flags; with NOT_SOLD_IN_STORE = online-only |

- `data.product.tcin` can differ from what you asked; report both.
- 404 "No product found" = unknown TCIN (check the `/-/A-` part of the person's link). 206 = a digital store id like 3991 — use the ZIP route.
- Store 2885 is a real New Jersey store; never present it as the person's store.
- If blocked (435): open `https://www.target.com/p/-/A-{tcin}`, pass the consent modal, read the pickup/delivery/shipping text; quantity is not shown there.
