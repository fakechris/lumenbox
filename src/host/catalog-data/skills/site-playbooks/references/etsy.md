# Etsy (www.etsy.com)

Covers: searching listings with filters and telling ads from organic results.
Not covered: cart, favourites, signing in, seller tools. The Open API v3 is partner-only.

## How to get in

Do not deep-link straight to search. Open `https://www.etsy.com/`, wait several seconds, type the query into the search box (`input[name="search_query"]`) and submit. Then refine by editing the URL in the same tab. A cold `/search?q=` link drew the captcha far more often (outside a box), and `curl` of `/search` gets a 403 — no shell route.

## Filters on `https://www.etsy.com/search?q={query}`

| Want | Add |
|---|---|
| Sort | `order=most_relevant` (default), `most_recent`, `price_asc`, `price_desc`, `highest_reviews` |
| Price | `min=25&max=50` (whole dollars) |
| Kind | `is_handmade=true`, `is_vintage=true`, `is_supply=true` |
| Digital | `instant_download=true` (plain searches add `=false`) |
| Shipping / sale | `free_shipping=true`, `is_discounted=true`, `ship_to=US` |
| Custom | `customizable=true`, `is_personalizable=true` |
| Colour | `attr_1={id}`; copy the id from a left-rail colour link |
| Category | path like `/c/home-and-living/home-decor/candles` |
| Page | `page=2` (~64 per page) |

Material, occasion, style and similar facets differ per category; copy their links from the left rail.

Example: `https://www.etsy.com/search?q=hand+poured+soy+candle&order=highest_reviews&min=25&max=50&is_handmade=true&free_shipping=true`

## Reading cards

- No listing JSON is embedded (no `__INITIAL_STATE__`, no JSON-LD listings). Read the rendered cards.
- Card: `div.v2-listing-card` with `data-listing-id` and `data-shop-id`. The same id repeats on nested nodes (~6×) — dedupe by id.
- Title is the image link's `aria-label`; link up to the `?` is the listing URL.
- Price: currency symbol + value; "Original Price" appears only when discounted.
- Rating: "N star rating with M reviews" (counts abbreviated, e.g. 3.8k).
- Ads: a hidden "Ad from shop {name}" label. Roughly 23 of ~59 first-page cards were ads; position tells you nothing.
- Badges: "Bestseller" (link also carries `&bes=1`), "Free shipping".
- Each card has a hidden cart form with `listing_id` and `listing_url` inputs — a stable fallback for id and URL.
- Image `il_300x300…jpg` can be swapped to `640xN` for a bigger one.
- The total result count is no longer shown as a number.

## Wall

DataDome (`Server: DataDome`, `geo.captcha-delivery.com`). Signs: an iframe from `captcha-delivery.com`, or a title that is just `etsy.com`. One variant clears itself after a few seconds of JS; the iframe captcha does not. Box runs have mostly not hit it. Do not keep reloading; if the captcha stays, stop and offer the person a handover.
