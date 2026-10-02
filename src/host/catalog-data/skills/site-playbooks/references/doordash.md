# DoorDash (www.doordash.com)

Covers: finding stores for a dish/cuisine/name near an address; reading a menu; building a pickup or delivery cart up to the checkout summary; placing it once the person has approved that exact cart.
Not covered: tips, promos, upsells, adding a payment method, saving addresses to the account.

## Two kinds of URL

| URL | Means | Use for |
|---|---|---|
| `/store/{slug}-{storeId}/` | one physical location | per-store prices, carts, independents |
| `/business/{slug}-{businessId}/` | a brand (chain) | template menu only — never a cart |

Add `?pickup=true` to a store URL for pickup. Locale prefixes (`/en-CA/`, `/en-AU/`, `/en-NZ/`, `/en-GB/`, `/fr-CA/`) switch currency.

## Finding a store

`https://www.doordash.com/search/store/{term}/` (e.g. `/search/store/tacos/`). Browser only — curl gets a 403 page. A "Just a moment..." check usually clears itself in ~6 s; then "Results for {term}" shows with an address control and store cards. If the page is not a list, search from the home page instead.
- Set the address in the modal (`input[placeholder='Address']`, pick the first suggestion, Save) or via the header. ETA and fee belong to whatever address the page shows — read it before quoting.
- Each card links to its `/store/` URL. Closed stores still have menus; keep them, marked closed.
- Nothing found: try a broader term once (cuisine instead of dish), then report none at that address.

## Reading a menu

Chain, template prices are fine: `curl -sL -m 10 https://www.doordash.com/business/{slug}-{businessId}/menu` (example id: `chipotle-mexican-grill-115`). This worked in May 2026 but on a box in Sept 2026 returned no usable menu and WebFetch timed out — give it one quick try while you also open the store in the browser, and do not wait on it.
- Find a businessId in the sitemaps: `https://www.doordash.com/sitemap-business_menu-doordash-index.xml` (shards on `cdn.doordash.com/sitemaps/`, e.g. `sitemap-doordash-0-business-menu.xml`); grep for `/business/{slug}-[0-9]+/menu`. No business page means an independent — use its `/store/` URL.
- Same server HTML is also available at `https://page-service.doordash.com/en-US/store/{slug}-{id}/`.

Where the menu sits in the HTML, best first:
1. JSON-LD `Restaurant`/`Menu`: `hasMenuSection[]` → `hasMenuItem[]` with `name`, `description`, `offers.price`, `offers.priceCurrency`.
2. `__NEXT_DATA__`: `props.pageProps…menu.categories[].items[]` — parse loosely, it changes.
3. Markup: category `<h2>` inside `data-anchor-id="StoreMenuList"`, items `data-anchor-id="MenuItem-{itemId}"`, price `data-anchor-id="MenuItem-Price"`.

In the browser, scroll the store page several times so lazy sections load, then read. `aria-disabled="true"` on an item = sold out; list it as unavailable rather than dropping it.
Price suffixes: `$13.65*` = starting price with required choices, `$13.65+` = base before optional add-ons. Keep the string, mark it as a base price.

## Building a cart

Only with a `/store/` URL in hand (the person's link, a search result, or the store page a `/business/` page lands on after setting location). Do not go hunting through order history.
1. Open the store URL; handle the address modal if it appears.
2. For each item: open it, set options and quantity, add. If a required option was not specified, take the preselected default and say which.
3. Open the cart once, check lines, go to checkout and read it back: lines, subtotal, fees, tax, preselected tip, total, pickup time or delivery address and ETA.
4. Stop there. Do not touch tip, promo, upsell or the place-order control.

## Placing

Only after the person approved that exact cart and nothing changed since; any change needs a new read-back and approval. Before clicking, compare the checkout lines to what they approved; if they differ, stop. Click place once. Dismiss post-order prompts without accepting anything. Read the order number, time/ETA and total. No confirmation after ~20 s: report what the page shows — never click place a second time.

## Walls

- Cloudflare guards all `/store/` pages with a managed challenge; tells are the title "Just a moment..." and `__cf_chl_tk` in the URL. Only a real browser clears it; afterwards the `__cf_bm` cookie (~30 min) covers other store pages. `/business/…/menu` can get the same challenge.
- A 403 on DoorDash's own error page ("We're having trouble loading the page you requested.", plus a Ray ID) is a hard block; waiting will not clear it.
- Navigation timeouts or `ERR_CONNECTION_CLOSED` on a store URL are not the challenge and did not improve with retries.
- `consumer-mobile-bff.doordash.com` store/menu endpoints return 401 without a user token; `m.doordash.com` gives 500. Leave both alone.
- Sign-in, 2FA, captcha or a new card: hand the desktop to the person.
