# Airbnb (www.airbnb.com)

Covers: searching stays for a place and dates; reading one listing for given dates.
Not covered: anything a host does, reserving, saving to wishlists, signing in.

## Search

URL shape: `https://www.airbnb.com/s/{slug}/homes?{filters}`
- Slug examples: `Paris--France`, `Joshua-Tree--CA--United-States`. Airbnb tolerates loose slugs and rewrites them.
- Keep the trailing `/homes`. Without it the URL may redirect to `/{city}/stays`, which has shown a "Stay tuned · Error 503" page.
- A pasted Airbnb search URL can be reused; extra query params are merged in.
- Map-only search: `https://www.airbnb.com/s/homes?ne_lat=…&ne_lng=…&sw_lat=…&sw_lng=…&search_by_map=true` plus dates and guests.

Query params (unknown ones are ignored without warning):

| Purpose | Params |
|---|---|
| Dates | `checkin`, `checkout` (needed for real prices); `flexible_trip_lengths[]=weekend\|week\|month`; `flexible_date_search_filter_type` 0 exact, 1 ±1 day, 2 ±3, 3 ±7 |
| Guests | `adults`, `children` (2–12), `infants` (<2), `pets` |
| Size | `min_bedrooms`, `min_beds`, `min_bathrooms` |
| Price | `price_min`, `price_max` (store currency, nightly incl. fees), `display_currency=USD` etc. |
| Type | `room_types[]=Entire%20home%2Fapt` (also `Private room`, `Shared room`, `Hotel room`), `property_type_id[]=N` |
| Features | `superhost=true`; `allows_pets=true`; `self_check_in=true`; free cancellation `fc=true`; instant booking `ib=true`; `amenities[]=N` (Wi-Fi is 4, Kitchen is 8); `accessibility_features[]=N`; `host_languages[]=xx`; `category_tag=Tag:8536` (Amazing views) |
| Paging | `items_offset` in steps of 18 |

To learn an enum value you do not know, toggle it once in the Filters dialog and read what it adds to the URL.

Example: `https://www.airbnb.com/s/Paris--France/homes?checkin=2026-06-15&checkout=2026-06-20&adults=2&min_bedrooms=2&price_max=500&room_types%5B%5D=Entire%20home%2Fapt&ib=true`

What the page holds:
- The server-rendered HTML carries the results as JSON in `<script id="data-deferred-state-0">` (several hundred KB), under `niobeClientData[0][1].data.presentation.staysSearch.results.searchResults`. `niobeClientData[0][0]` is a cache key that echoes every filter Airbnb actually applied — check it when a filter matters.
- Useful fields per result: `demandStayListing.id` (base64; decode and drop the `DemandStayListing:` prefix to get the room id), `title` (type + area), `subtitle` (host's listing name), `structuredContent.primaryLine` (beds/baths text), `structuredDisplayPrice.primaryLine` (`price`, or `discountedPrice` + `originalPrice` when discounted, plus `qualifier` like "for 5 nights"), `avgRatingLocalized` ("4.85 (132)"), `badges[].loggingContext.badgeType`, `demandStayListing.location.coordinate` (blurred by roughly 150 m).
- Max guests and host name are not in search results; open the listing.
- The headline count is exact only up to roughly 270, then becomes "Over 1,000". A map-bounded search gives a precise count; split the box into quarters for big sweeps.
- Without page scripting, read the cards with `browser_read`, or fetch the HTML in `bash` and parse that script tag with python — whichever the site lets through.

Listing link: `https://www.airbnb.com/rooms/{id}`.

## One listing

URL: `https://www.airbnb.com/rooms/{id}?check_in=YYYY-MM-DD&check_out=YYYY-MM-DD&adults=N&display_currency=USD`

- Same script tag, different schema (`StaysPdpSections`), at `niobeClientData[0][1].data.presentation.stayProductDetailPage.sections`. `metadata.sharingConfig` has title, property type, capacity, rating, review count; `metadata.loggingContext.eventDataLogging` has listing id, lat/lng, room type, superhost flag and sub-ratings. The cache key's `dateRange` shows which dates were priced.
- Nightly price, fees, total, amenities, house rules and cancellation policy are filled in client-side — read them from the rendered booking panel. If the panel shows no price for those dates, say so; never borrow the price from a search card.
- Do one listing at a time with a pause between; several in a row trips the rate limit.
- A "one price for your trip" dialog may appear; dismiss or ignore it.

## Traps and limits

- Read-only: do not press Reserve, Save or Sign in.
- No public API. `/api/v3/StaysSearch` uses rotating query hashes and fingerprinting — do not call it.
- Bot wall (PerimeterX): the tell is HTML with no `data-deferred-state-0` script. Seen outside a box; not confirmed from one.
- Rate limiting shows up as 429, or as the "Stay tuned" 503 even with `/homes` present. It cleared after about 45 s. Wait, try once more, then stop and give the person the search URL to open themselves.
