# Realtor.com (www.realtor.com)

Covers: listing search by area and filters (sale, rent, sold, new, foreclosure, pending); one listing's record; school ratings and catchment for a school or an address.
Not covered: contacting agents, saving, tours, pre-approval, sign-in. The `api.realtor.com/graphql` / `api-prod.realtor.com/graphql` endpoints are partner-only — do not probe.

Note: Realtor.com's robots.txt says scraping needs permission from Move Sales, Inc. Mention that if the request is large or commercial.

## Step 1 — resolve the place (shell)

```
curl -fsS 'https://parser-external.geo.moveaws.com/suggest?input=Austin%2C%20TX&client_id=rdc-x'
```

Rows in `.autocomplete[]`: `area_type` (city, neighborhood, postal_code, county, school, university, address, street), `slug_id` (`Austin_TX`, `94110`, `Downtown-Austin_Austin_TX`), `geo_id`, `centroid`, `state_code`, `city`, `postal_code`, `_score`. Pick the best-scoring row of the right type. Names repeat across states (`Brooklyn Heights` → OH, MO; the NYC one is `Brooklyn-Heights_Brooklyn_NY`) — without a state, show the top three. Allowed geocoder params: `input`, `client_id`, `area_types`, `limit`, `include`. Anything extra → 400 `whitelistValidation`.

For a street address add `&area_types=address&limit=5`: the top row has `line`, `postal_code`, `prop_status` (`for_rent`, `off_market`) and no `slug_id`. Search that ZIP (recently-sold for off-market) and find the result whose address line matches; none means the address is not listed.

## Step 2 — search URL (browser)

`https://www.realtor.com/{base}/{slug_id}/{filters…}/{sort}/{page}`

Bases: `realestateandhomes-search` (sale), `apartments` (rent; only place for pet/furnished filters); sale base + `/show-recently-sold`, `/show-newconstruction`, `/show-foreclosure`, `/show-pending`.

Filter segments — put them in alphabetical order, then `sort-…`, then `pg-…` (other orders get a 301):

| Filter | Segment |
|---|---|
| Price | `price-{min}-{max}` (`na` = open end) |
| Beds / baths min | `beds-3`, `baths-2` (or `baths-1.5`) |
| Size | `sqft-{min}-{max}`, `lotsqft-{min}-{max}` or `lot-{n}-acres` |
| Year built | `yearbuilt-{min}-{max}` |
| On market | `dom-` 1, 7, 14, 30, 90 |
| HOA ceiling | `hoa-{monthly max}` |
| Type | `type-` single-family-home, condo, townhouse, multi-family-home, mobile, land, farms-ranches, coop |
| Features | `feat-pool`, `feat-garage` / `garage-{n}`, `feat-basement`, `feat-waterfront`, `feat-central-air`, `feat-fireplace`, `feat-view`, `feat-hardwood-floors`, `feat-updated-kitchen`, `feat-single-story` |
| Rentals | `feat-cats`, `feat-dogs`, `feat-no-pets`, `feat-furnished` |
| Other | `reduced`, `open-house` (+ `dt-YYYY-MM-DD`), `tour`, `schools-{elementary\|middle\|high}-{1..10}` |
| Sort | `sort-newest`, `price-h-l`, `price-l-h`, `sqft-h-l`, `lot-h-l`, `photo-h-l`, `reduced-date` |
| Page | `pg-2` |
| Map box | `?bbox=west,south,east,north` |

Example: `https://www.realtor.com/realestateandhomes-search/Austin_TX/baths-2/beds-3/price-400000-800000/type-single-family-home/sort-newest`

## What the pages contain

Search and detail pages embed `__NEXT_DATA__`; under `props.pageProps`, `searchResults.home_search` has `total`, `count` and `results[]` (42 per page for sale, 25 for rent); detail pages have `propertyDetails`. You cannot run page scripts and curl is blocked (below), so in practice read the rendered cards and detail page. Fields worth reporting: address, list price (or a min–max range), price cuts, type, beds, baths, sqft, lot, year built, days on market, HOA, open houses (may be virtual), flags (new, pending, contingent, foreclosure, coming soon), MLS number (`source.listing_id`), agent branding, nearby schools with GreatSchools 1–10 rating, tax history. Listing URL: `https://www.realtor.com/realestateandhomes-detail/{permalink}`. The long description is only on the detail page.

## Kasada wall (frequent)

Every search and detail URL returns 429 with a challenge to curl. In the browser it often stays too. Tells: 429; `KP_UIDz` cookies; `X-Kpsdk-*` headers; `window.KPSDK` in the body; a script at `/{uuid}/{uuid}/ips.js`. Give a challenge a few seconds, retry once with a full wait, then stop on that URL. If several areas were asked for, still try each other area once.

Alternatives once blocked:
- Redfin: `https://www.redfin.com/zipcode/{zip}` or `/city/{id}/{ST}/{City}`, filters as one segment like `/filter/max-price=900k,min-beds=2,property-type=condo`. Cards `.bp-Homecard` (address in `title`, price, beds, baths, sqft, `/home/{id}` link). A plain fetch works at first; after a few requests the reply turns into an empty 202 carrying `x-amzn-waf-action: challenge` — switch to the browser for the same URL. One shell fetch at most.
- Zillow: shell fetches get a 403 from PerimeterX. Do not use it from the shell.
- Valuations/comps: the county assessor or GIS portal (search by address or parcel; assessed value, last sale, lot and building size). Name the county and portal.

## Schools

School pages were not challenged in testing, so the shell works.

1. `curl -fsS 'https://parser-external.geo.moveaws.com/suggest?input={name city state}&client_id=rdc-search-default&area_types=school&limit=10'` — best row with `area_type` "school" gives `slug_id`, `school_id`, address, `centroid`, `has_catchment`. Empty → retry without `area_types` → else not found.
2. `curl -fsS https://www.realtor.com/local/schools/{slug_id} -o /home/box/work/school.html` (`slug_id` = Name-With-Dashes-{Realtor id}, e.g. `Sylvia-Mendez-Elementary-078571861`). A good page is ~250–430 KB; under 2 KB with `KPSDK` / "reference ID" is the wall — retry once, then read in the browser.
3. Extract the JSON in `<script id="__NEXT_DATA__" type="application/json">`, e.g.:
   `python3 -c 'import json,re,sys; s=open(sys.argv[1]).read(); m=re.search(r"__NEXT_DATA__\" type=\"application/json\">(.+?)</script>", s, re.S); print(json.dumps(json.loads(m.group(1))["props"]["pageProps"]["school"], indent=1))' /home/box/work/school.html`

Under `props.pageProps.school`: `rating` (GreatSchools 1–10; null for private), `parent_rating` (1–5) and `review_count`, `grades` (list; "PK" for pre-K — write "K-5" only if contiguous), `education_levels`, `student_count`, `student_teacher_ratio`, `district.name`, `location`, `nces_code` (12 or 8 digits), `greatschools_id`, `funding_type` (public/private/charter), `boundary` (GeoJSON MultiPolygon for public schools with catchment). Private schools: rating, ratio, district and boundary are null — that is expected. `school.assigned` is always null; `nearbySchools` is not a school list.

Assigned schools for an address: geocode the address (`area_types=address`) for its centroid; for each level search `"elementary {city}"`, `"middle {city}"`, `"high {city}"` with `area_types=school&limit=20`; keep same-state rows with `has_catchment: true`; fetch each page and test whether the point lies in `boundary` (Shapely if present, else a ray-casting check). Expect 5–10 fetches.

Dead ends: `/local/schools/search?searchTerm=` (error page), `/api/v1/schools/search`, `/api/v1/rdc_search/schools` (404), `/api/v1/hulk` (403), geocoder paths `/schools`, `/schools_search`, `/locality`, `/reverse_geocode` (404).
