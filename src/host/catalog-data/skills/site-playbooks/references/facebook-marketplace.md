# Facebook Marketplace (www.facebook.com/marketplace)

Covers: searching or browsing listings in a metro (items, vehicles, rentals); reading one item.
Not covered: messaging sellers, offers, saving, sharing, reporting. No public API; `/api/graphql/` needs session-bound tokens (`fb_dtsg`, `lsd`, `jazoest`), so no curl.

## Needs a Facebook session

Without one, the first page is usually a logged-out splash. Check whether the box browser is already signed in. If not, hand the desktop to the person to sign in (the login then persists), or use other classifieds instead. Do not keep retrying logged out.

## Search URL

`https://www.facebook.com/marketplace/{slug}/search/?query={q}`

- Slugs known to work: `nyc`, `la`, `sanfrancisco`, `chicago`, `austin`, `boston`, `seattle`, `atlanta`, `miami`, `portland`. Look-alikes (`newyork`, `bayarea`, `sf`, `new-york`), ZIPs and numeric ids redirect to `/marketplace/category/search/`, which loses the location and falls back to the IP's area. For another metro, open `/marketplace/`, use the location picker and copy the slug from the resulting URL.
- Category browse: `?category={name}` or `/marketplace/{slug}/{category}`.

| Filter | Param and values |
|---|---|
| Price | `minPrice`, `maxPrice` (integers, local currency) |
| Freshness | `daysSinceListed` 1, 7, 30 |
| Condition | `itemCondition` = comma list of `new`, `used_like_new`, `used_good`, `used_fair` |
| Stock | `availability` = `in stock` (default), `out of stock`, `all` |
| Delivery | `deliveryMethod` = `local_pick_up` or `shipping` |
| Radius | `radius` 1, 2, 5, 10, 20, 40 (default), 60, 80, 100, 250, 500 |
| Sort | `sortBy` = `creation_time_descend`, `distance_ascend`, `price_ascend`, `price_descend` |
| Exact | `exact=true` |
| Category | `vehicles`, `propertyrentals`, `apparel`, `electronics`, `family`, `free`, `garden`, `hobbies`, `home`, `homeimprovement`, `musicalinstruments`, `officesupplies`, `petsupplies`, `sportinggoods`, `toys`, `bookmoviesmusic` |
| Vehicles | `make`, `model`, `carType` (sedan, coupe, hatchback, suv, truck, van, convertible, wagon, minivan, other), `transmissionType`, `minYear`/`maxYear`, `minMileage`/`maxMileage`, `vehicleExteriorColors`/`vehicleInteriorColors`, `titleStatus` (clean, salvage, rebuilt, other) |
| Rentals | `minBedrooms`/`maxBedrooms`, `minBathrooms`/`maxBathrooms` (.5 ok), `minAreaSize`/`maxAreaSize` (sqft), `propertyType` (apartment_condo, house, room, townhouse, mobile_manufactured, other), `privateRoomBathroomType` (attached, not_attached, shared) |

Leave commas in multi-value params unencoded. Unknown params disappear silently; the HTML's `"params":{…}` echo shows what took, including `location_id` (should be your slug) and the radius unit (`filter_radius_km` has echoed both 32 and 20 for `radius=20` — read it, do not assume).

Example: `https://www.facebook.com/marketplace/austin/search/?query=peloton&maxPrice=500&daysSinceListed=7&radius=20&sortBy=creation_time_descend`

## What the page holds

- First page (≈15–24 listings) is embedded as JSON in the HTML under `"marketplace_search":{"feed_units":{"edges":[…]}}`. Each edge's `node.listing` has `id` (→ `https://www.facebook.com/marketplace/item/{id}/`), `marketplace_listing_title`, `listing_price.formatted_amount`, `strikethrough_price`, `location.reverse_geocode.city`/`.state`, `primary_listing_photo.image.uri`, `delivery_types` (IN_PERSON, DOOR_PICKUP, SHIPPING — may omit shipping), `is_sold`, `is_pending`, and for vehicles a subtitle like "19K miles". Leave out `node.tracking`.
- More results: scroll; cards are `role="article"` with item links.
- Search results lack description, seller, coordinates, condition and posted time. The item page adds them (`marketplace_listing_renderable`: description, photos, seller name/id, `creation_time`, coordinates, condition, and vehicle/apparel/rental attributes) — this shape was inferred, not fully confirmed.
- Photo URLs on `scontent-*.fbcdn.net` are signed and expire (`oe=`).

## Walls and states

- After 5–10 scrolls logged out, "Log in or sign up for Facebook…" / "Log in to see more" appears. Stop there and return what you have, marked partial. The string `login_form` appears even on normal logged-out pages, so it is not a tell.
- Zero edges plus that text on page one = logged-out splash.
- Redirect to `/marketplace/ineligible/` or "Pages cannot use Marketplace": the session is acting as a Page; ask the person to switch to their personal profile.
- "Marketplace isn't available": unsupported region.
