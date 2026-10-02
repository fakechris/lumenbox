# Luma (luma.com, lu.ma, api.luma.com)

Covers: listing events in a city or a category near a place; reading one event and its registration state; pressing Register once for a free, open event.
Not covered: paying, approving, unlock codes, host/calendar tools, keyword search (none exists anonymously).

## Public JSON API

`api.luma.com` is open: no key, cookie or custom header. Location comes from the parameters, not your IP. Use `curl` from `bash`. (`api.lu.ma` answers but returns "Not found." for these paths.)

### Discover

```
curl -s "https://api.luma.com/discover/get-paginated-events?slug=sf&pagination_limit=20"
curl -s "https://api.luma.com/discover/get-paginated-events?slug=tech&latitude=37.7749&longitude=-122.4194&pagination_limit=20"
```

- Place slugs (`sf`, `nyc`, `london`, `singapore`, `la`, `berlin`, `tokyo`) scope themselves; coordinates are ignored.
- Category slugs (`tech`, `ai`, `crypto`, `food`, `arts`, `climate`, `fitness`, `wellness`) need `latitude` and `longitude`, else you get `{"entries": [], "has_more": false}` — empty, not an error.
- Response: `entries`, `has_more`, `next_cursor`. Continue with `pagination_cursor={next_cursor}` and the other params unchanged. Limit tops out around 20–25.
- Slugs and coordinates for all places/categories: fetch `https://luma.com/discover`, take `<script id="__NEXT_DATA__">`, read `props.pageProps.initialData` → `places[]` (`place.slug`, `place.coordinate`, `event_count`), `categories[]` (`category.slug`, `event_count`), `featured_place.events[]`. (That page may be challenged; see below.)
- No "parties" category and no free-text search (`/search/get-results` → 401, `/discover/search` → 404). For nightlife, pull the city (or `food`) and filter names, calendars and hosts yourself — and say you did.

Per entry: `event.name`, `event.start_at` (UTC; show it in `event.timezone`), `event.url` → `https://luma.com/{event.url}` (a short slug, not the `evt-…` id), `event.location_type` (offline/online), `geo_address_info.city_state` / `.full_address` (missing for online or hidden addresses), `hosts[].name` (can repeat — dedupe), `calendar.name`, `ticket_info` (`is_free`, `price`, `is_sold_out`, `spots_remaining`, `is_near_capacity`, `require_approval`), `guest_count`.

### One event

`lu.ma/{slug}` redirects (301) to `luma.com/{slug}`. The slug is the last path segment, without query.

```
curl -s "https://api.luma.com/url?url={slug}"
```

200 → `{"kind": "event", "data": {…}}`; 404 → wrong slug (check for a stray path or query first). Same object sits in the event page's `__NEXT_DATA__` under `props.pageProps.initialData` if the API is blocked.

Useful: name, start/end in timezone, location type, address (`geo_address_visibility: guests-only` = shown only after registering), hosts, calendar, guest count, description (text nodes under `description_mirror`), `ticket_types[]` (name, type, cents, currency, spots_remaining), `registration_questions[]` (label, required), `name_requirement`, `phone_number_requirement`.

Registration state — first that applies:
1. sold out — `ticket_info.is_sold_out` or top-level `sold_out` set (+ waitlist if `waitlist_active`)
2. `show_unlock_code_option` → needs an unlock code
3. any `ticket_types[].cents` > 0, or `ticket_info.is_free` false → paid
4. otherwise → open and free

Add "needs approval" if `ticket_info.require_approval` or any ticket type's `require_approval` is true.

## Registering

Only when the person asked and the state is open and free. Open `https://luma.com/{slug}`, press the register control once, and stop at whatever comes next — a form, sign-in, code, payment, approval notice or unlock-code prompt. Report what appeared. Do not fill fields without the person's details, do not fetch codes from their mailbox, do not pay.

## Walls

The `luma.com` pages sit behind Cloudflare and Shape, so the browser or curl may be challenged from a box. In testing the API itself was never challenged. If the API itself is challenged, fall back to the page; if both are, stop.
