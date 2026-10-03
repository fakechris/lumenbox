# Costco (www.costco.com and sameday.costco.com)

Two different storefronts. Use the one that matches the request.

Covers: price and stock for one costco.com product; filling a Costco Same-Day grocery cart from a list.
Not covered: checkout, payment, buying a membership, signing in on the person's behalf.

## costco.com — one product (read-only)

URLs:
- Product: `https://www.costco.com/p/-/{slug}/{itemId}`. Old `{slug}.product.{itemId}.html` links redirect here.
- Search: `https://www.costco.com/s?keyword={name}`. Search results are drawn client-side (the raw HTML lacks them), so look names up in the browser.

Shell route for price: product pages are server-rendered, so a single `curl -sL -m 15` of the product URL may return HTML containing `<script id="ProductSchema">` JSON-LD:
- `offers.price` / `offers.priceCurrency` = online price; `name`; `sku` (internal); the item number is the last segment of `url`.
- Do not take stock from `offers.availability` — it can say `OutOfStock` while a price is listed.
- The edge is Kasada: HEAD requests get 429 and GETs sometimes do. A 429 in the shell means switch to the browser, not retry curl.

From the rendered page:
- Title and item number, price and its label: "Online Price" (delivered) vs "Warehouse Price".
- Stock: "Out of Stock", "Low Stock", or an Add to Cart control.
- Fulfillment card (`data-testid="fulfillment-zipCode-and-warehouse-selector"`) shows ZIP and warehouse. If the person gave a ZIP and the card shows another, change it once through that card and read again.
- "Sign In for Price" = member price hidden. Do not sign in; ask the person whether they want to.
- Wording like "Warehouse pricing may vary" or "Item may be available in your local warehouse" promises nothing; call warehouse stock unverified.
- A 429 or blank page in the browser: one reload after ~5 s, then stop and report.

## sameday.costco.com — grocery cart

This one writes (a cart), so only do it when asked, and stop at the cart.

1. Open `https://sameday.costco.com/`. Choose "Browse as a guest" (or "Sign in via Costco.com" only if the person wants their account). Load takes around 10 s. You arrive at `/store/costco/storefront`; the cart count shows in the header ("View Cart. Items in cart: N").
2. Optional: `https://sameday.costco.com/store/costco/buy_it_again` lists past purchases when signed in; prefer those for matching items. "Reordering is a breeze" means no history.
3. Search by URL, one per item: `https://sameday.costco.com/store/costco/s?k=organic%20milk`. Wait a few seconds for results.
4. Pick the first real match (Kirkland Signature preferred), press its "Add 1 ct {name}" button, and check the cart count rose by one.

Facts:
- Storefront and `buy_it_again` redirect to `/?next=…` until guest-or-sign-in has been chosen in that session.
- Outlines are big (hundreds of refs). Look for "Add 1 ct", "Current price", "Items in cart".
- Delivery ZIP sits in the header "Delivery {ZIP}" button, defaulted from the box's IP. Prices and availability depend on it; set it there if the person gave one, and always report the ZIP used.
- No bot wall was seen on storefront, search or add (outside a box). The backend is Instacart, gated by a session token, so the rendered site is the only route.
- "Sign in via Costco.com" goes to Costco's own login. If a password page shows, hand the desktop over rather than typing anything.
- Never check out.
