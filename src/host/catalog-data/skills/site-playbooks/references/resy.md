# Resy (resy.com, api.resy.com)

Covers: open slots for a party size on a date or across a window of up to 30 days; booking a slot the person confirmed (needs their signed-in session).
Not covered: Notify/waitlist sign-ups, payment.

## API first (shell)

The web app reads a JSON API at `https://api.resy.com`. Every call needs:
- `Authorization: ResyAPI api_key="{key}"` — the key is the web app's own public key. Get it by fetching `https://resy.com/`, then the `modules/app.{hash}.js` bundle that page references, and matching `apiKey:"([A-Za-z0-9]{30,36})"`. It rotates; a 419 JSON "Unauthorized" means fetch it again.
- `Origin: https://resy.com`, `Referer: https://resy.com/`, and a desktop Chrome user agent.

Steps:
1. **Venue from a URL** `https://resy.com/cities/{city}/venues/{slug}`: `GET /3/venue?url_slug={slug}&location={code}`. Use the short city code rather than the slug in the URL (`new-york-ny` becomes `ny`). Codes: ny, la, sf, chi, mia, dc, bos, lv, sea, phl, atl, aus, hou, dal, tor, lon, nas, den. Read `id.resy`, `location.latitude/longitude`, `max_party_size`.
2. **Venue by name**: send a POST to `/3/venuesearch/search`, body `{"query": "{name}", "geo": {"latitude": …, "longitude": …}}` for the intended city. Take the hit whose `name` matches case-insensitively: `id.resy`, `url_slug`, `_geoloc.lat/lng`. If the name exists in more than one city and none was named, ask which.
3. **One day**: `GET /4/find?lat=…&long=…&day=YYYY-MM-DD&party_size=N&venue_id={id}`.
4. **Several days (up to 30)**: `GET /4/venue/calendar?venue_id={id}&num_seats=N&start_date=…&end_date=…`, then step 3 for each `scheduled[]` day whose `inventory.reservation` is `available`.

## Reading

`/4/find` → `results.venues[0].slots[]`: `date.start` (venue local time), `config.type` (seating), `payment.amount` + `payment.currency`.
- Empty slots on a 200 = no online table for that day/party; the calendar explains why.
- Calendar `sold-out` = sold out. `closed` = not bookable online (closed that day or not released yet) — not "sold out".
- A `notify` block = waitlist.
- Party above `max_party_size` gets nothing.
- Link for the person: `https://resy.com/cities/{city}/venues/{slug}?date=YYYY-MM-DD&seats=N`.

## When the API misbehaves

- `/4/find` 500: one retry. After that, rerun the venue search including `"slot_filter": {"day": "YYYY-MM-DD", "party_size": N}, "availability": true` in the body; the hit's `availability.slots[]` lists times (without prices). Then fall back to the page.
- 419 HTML (Imperva) = CDN block: wait ~30 s, retry once, then use the page.
- 403 from `/4/find` = invite-only venue; there is no signed-out route.

## Page fallback

Open the venue link above. Date and party come from the URL; use the page's controls only if it shows something else, once. Times load after the page — wait once, then read. No times: report what is shown instead (sold out, Notify). Blank/crashed tab without an error: reopen once. Access Denied or a bot check does not clear on reload. If the calendar said available but the page shows no times, say they could not be read — not sold out. Do not click a time or Notify while checking.

## Booking

Only after the person confirmed a specific slot. Open the venue link with `&time=HHMM` added in the box browser (it must be signed in to Resy). A password, code or card request → hand the desktop to the person.
