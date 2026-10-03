# Best Buy (www.bestbuy.com)

Covers: turning a product name into a shortlist of SKUs; price, shipping ETA and nearby-store pickup for a known SKU.
Not covered: adding to cart, buying, protection plans, member-only prices.

## Location first

Stock and pickup are scoped to a ZIP. With none set, the site uses its headquarters ZIP `55423` (store 7, Richfield MN). Ask the person for their ZIP when pickup matters, then on the home page use "Update location" in the header before searching. Anything read under 55423 is not their availability.

## Search by name

URL: `https://www.bestbuy.com/site/searchpage.jsp?st=65+inch+oled+tv` (spaces as `+`).

- SKU is seven digits. Find it in each card's link: the `skuId=` value, or the digits before `.p` in `/site/…{sku}.p`. Some cards link to `/product/{slug}/{bsin}` instead, where the bsin is a 10-character id; that URL works for the stock check too.
- The availability button on a card is A/B tested. Report it as the card's label, not as stock.
- Skip "related products" rows and cards of a different product type.
- Distinguish "nothing matched" (the page says so) from "cards I could not read".

## Stock for one SKU

URLs:
- `https://www.bestbuy.com/site/{sku}.p?skuId={sku}` — redirects (301) to the canonical one.
- `https://www.bestbuy.com/product/{slug}/{bsin}` — canonical.

What the product page HTML holds:
- `<script id="product-schema">` JSON-LD `Product`: `name`, `sku`, `model`, `brand.name`, `aggregateRating`, `additionalProperty[]` (specs), `offers[]`. For inactive items `offers` may be empty or refurbished only.
- Inline Apollo cache scripts (containing `ApolloSSRDataTransport`) with `productBySkuId`. One of them carries `price.customerPrice` and `fulfillmentOptions`:
  - `buttonStates[].buttonState`: `SOLD_OUT`; `ADD_TO_CART` or `BUY_NOW` = available; `COMING_SOON` (see `releaseDateDisplayValue`); `NOT_AVAILABLE`; `CHECK_STORES` = not online, maybe pickup. Trust this over the visible button text.
  - `shippingDetails[]`: `destinationZipCode` (must equal the person's ZIP, else reset location and reload), `shippingEligible`, ETA under `shippingAvailability[].customerLOSGroup`. The rendered "Get it by …" text is also on the page.
  - `ispuDetails[].nearbyLocations[]`: `store.{displayName, city, zip, distance}` and `availability.{pickupEligible, minPickupInHours, quantity, maxDate}`. Eligible with ≤ 24 h means today; more means tomorrow or `maxDate`. Radius is fixed server-side at about 25 miles / ~10 stores; filter by `distance` yourself for a smaller radius.
- Check that the page's `skuId` matches the SKU you asked for.
- `dotComDisplayStatus: "inactive"` with nothing shippable or pickable is a discontinued item, not an error.
- "Limit N per customer" appears only as page text.
- Price shown logged-out is the non-member price; member tiers need a signed-in session.

You cannot run page scripts; read the rendered price and fulfillment panel with `browser_read` / `browser_snapshot`.

## Traps and limits

- Akamai Bot Manager fronts every page. `curl` from a shell gets reset, so there is no shell route. A plain browser has received 403 "Access Denied" or a never-ending interstitial on first load (seen outside a box).
- On a wall: stop, do not reload, give the person the URL, or move to another retailer.
- `api.bestbuy.com` needs a developer key and has no store-level stock. `POST /gateway/graphql` is the site's own source but is expected to be bot-gated; do not try it.
- Read-only: never Add to Cart, Pick up at Store, Sign In, Add Protection.
