# Expedia (www.expedia.com)

Covers: building a shortlist of stays (hotels and Vrbo together) or round-trip/one-way flights.
Not covered: booking, member/One Key prices, signing in.

## Stays

```
https://www.expedia.com/Hotel-Search?destination=Seattle%2C%20WA%2C%20United%20States
  &regionId=3121            (optional; pins the market)
  &startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
  &adults=2&rooms=1         (&children=8,11 — ages)
  &sort=PRICE_LOW_TO_HIGH   (RECOMMENDED | PRICE_LOW_TO_HIGH | REVIEW | DISTANCE | PROPERTY_CLASS)
  &price=0,350              (min,max of the WHOLE stay, not per night)
```

- Unknown `regionId`: type the city into "Where to?" and read the link it resolves to, or take it from a result's detail URL.
- A taxes-and-fees dialog appears first ("Got it"). Results load as you scroll.
- Skip the "VIP Access properties (N)" strip and any sponsored blocks; their prices are separate. The real list starts below the "Search results" heading, one card per "Photo gallery for {name}".
- Per card: guest rating ("9.4 out of 10" + review count), "$NNN nightly", "$NNN total", optional struck-through price, "Fully refundable", "Reserve now, pay later", badges (VIP Access, Member Prices).
- Detail URL `/{City}-Hotels-{Name}.h{HOTELID}.Hotel-Information?…`; `h{HOTELID}` is the stable id.
- Separate hotels from Vrbo rentals with the "Property type" filter.

## Flights

```
https://www.expedia.com/Flights-Search?trip=roundtrip&mode=search&passengers=adults:1
  &leg1=from:Seattle%20(SEA),to:New%20York%20(JFK),departure:MM/DD/YYYYTANYT
  &leg2=from:New%20York%20(JFK),to:Seattle%20(SEA),departure:MM/DD/YYYYTANYT
```
(`trip=oneway` with only `leg1`.)

- Each option: airline, times, duration, stops, and the round-trip total.
- A 7-day flexible-date strip ("Fri, Jun 12 $416") is on the page — use it to answer "are other days cheaper" without searching again.

## Other products

Cars, packages, activities and cruises work the same way from the top nav (`/Cars`, `/Vacation-Packages`, `/Activities`, `/Cruises`) or `/carsearch`, `/things-to-do/search`.

## Traps

- Results come from `https://www.expedia.com/graphql` after load; there is no public or cookie-free route, so no curl. Do not POST to it (persisted hashes, client headers, bot cookies).
- Akamai Bot Manager on every route (`ak_bmsc`, `bm_*` cookies, `X-Akamai-Reference-Id`). Datacenter IPs are prone to challenges on the search routes; a clean home page proves nothing about them.
- Member prices need sign-in; give public prices and note that a member-price sign-in offer was shown.
- Do not press Reserve, Select or Continue.
