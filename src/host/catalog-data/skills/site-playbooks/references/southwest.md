# Southwest Airlines (www.southwest.com)

Covers: fares for a route and dates (dollars or points), and the cheapest-day calendar. Southwest fares are not on OTAs or meta-search.
Not covered: booking, check-in, changes, multi-city (do one-ways in sequence), children and lap infants (form-only, not URL params).

## Deep link

```
https://www.southwest.com/air/booking/select.html?originationAirportCode=DAL&destinationAirportCode=LAS
  &departureDate=2026-10-14&returnDate=2026-10-17&tripType=roundtrip
  &adultPassengersCount=1&seniorPassengersCount=0&passengerType=ADULT&fareType=USD
```

- `tripType=oneway` drops `returnDate`. Dates are local to the origin.
- Adults + seniors (65+) ≤ 8. `fareType` is `USD` or `POINTS` (not `DOLLARS`). `promoCode` optional; `int=` is tracking and can be dropped.
- What happens: 301 to `select-depart.html`, and the app then shows a pre-filled search form (URL `/air/booking/?…&validate=true`). Landing on the form is normal. Check it shows the right airports and dates, close any cookie banner, press "Search flights" once, and wait (up to ~10 s) for fare rows.

## Fare grid

Columns: Choice Extra, Choice Preferred, Choice, Basic — take the order from the header. "Wanna Get Away", "Anytime" and "Business Select" are gone; do not wait for them.

Per row: flight numbers (4 digits, `1234 / 5678` for connections), routing ("DAL → HOU → LAS"), local times, aircraft (737-700, 737-800, 737 MAX 8), duration, stops ("1 stop in HOU"), layover length, sometimes on-time %. Points cells show points plus a small cash amount (e.g. "+ $5.60"). "Unavailable" = sold out; a missing cell = fare not offered. For round trips, the return flights are under the Return tab.

## Low Fare Calendar

`https://www.southwest.com/air/low-fare-calendar/?originationAirportCode=DAL&destinationAirportCode=LAS&tripType=roundtrip&adultPassengersCount=1&fareType=USD&passengerType=ADULT` — keep the trailing slash (`low-fare-calendar.html` is a 404). No dates; it picks its own month. Each day shows the lowest outbound fare (round-trip prices assume a 3-night return). Use it when the grid stays empty.

## Airport codes

Station list lives in plain JavaScript at `https://www.southwest.com/swa-ui/bootstrap/air-booking-v2/1/data.js` (~720 KB, not base64). Grep records like `"cityServed":"Dallas","stationName":"Dallas (Love Field)","id":"DAL"`. Note: Dallas means DAL (Love Field) — DFW is not a Southwest airport; JFK is not served either. "We couldn't find any flights" on an unserved route is not a block — check both codes.

## Walls

- Akamai (`/akam/…` sensor, `ak_bmsc`, `bm_*` cookies). Signs: an "Access Denied" page whose reference starts `#18.`, or the page hydrating into a "There was a problem" message. Retry once, then report with the reference.
- A real block shows as the form not advancing after "Search flights", or results with no fare rows. Grid empty after one reload: try the Low Fare Calendar once; if that is empty too, say Southwest did not show fares. (Google Flights will not show Southwest fares, only competitors.)
- `/api/air-booking/v1/*` and `/api/content/v1/*` return 403 without the browser's cookies — do not replay from the shell.
- Do not press Continue or a fare's Select.
