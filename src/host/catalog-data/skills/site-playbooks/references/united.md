# United Airlines (www.united.com)

Covers: United's own cash prices and flight times for one route on one date; a look at MileagePlus award pricing (usually needs the person's sign-in).
Not covered: booking, existing trips, upgrades, check-in, multi-city. For comparing airlines or many dates, use Google Flights.

## Cash fares — results deep link

```
https://www.united.com/en/us/fsr/choose-flights?f=SFO&t=JFK&d=2026-07-15&r=2026-07-22&tt=1&sc=7&px=1&taxng=1&clm=7&st=bestmatches
```

| Param | Meaning |
|---|---|
| `f`, `t` | origin, destination — IATA codes only (city names produce "no flights") |
| `d`, `r` | depart / return `YYYY-MM-DD`; drop `r` for one-way. Not past, within ~11 months |
| `tt` | 0 one-way, 1 return (2 is multi-city with another param layout; not covered) |
| `sc=7` | cash search; keep it |
| `px` | passengers 1–9 |
| `taxng=1` | prices include taxes |
| `clm` | cabin — first=3, business=4, premium economy=6, economy=7 |
| `st` | `bestmatches`, `priceasc`, `departtime`, `arrivetime`, `duration` |
| `newDateOverride=true` | safer date handling across months (optional) |
| `noflex=true` | hides the flexible-date strip (optional) |

There is no airport lookup API (`/api/airports/lookup/search` is 404); resolve cities to codes yourself.

The page is a React app with no flight data in its HTML — it must render in the browser. Give it a few seconds; if no cards yet, wait once more.

Per card: depart and arrive (local; "+1d" = next day), duration, "Nonstop"/"N stops", flight numbers ("UA 232, UA 7411"), one price per fare column (Basic Economy through First). A `*` after a price means the fare is saver-class or mixes cabins.

Round-trip pages show outbound flights only; returns appear after choosing an outbound, which you must not do. For return prices, run a one-way search reversed on the return date.

Signals: "No flights available for the dates you selected" = genuinely empty; date picker pops open = date rejected; wrong city in the header = code not recognised; cards replaced by a red error notice saying it was "unable to complete your request" = site error — do not reload the same link repeatedly; check the route on Google Flights instead.

## Awards

Award prices are on a different page: `https://www.united.com/ual/en/us/flight-search/book-a-flight/results`. Open it with no parameters (do not invent award parameters).
- A MileagePlus sign-in is the usual first result for a logged-out browser. Do not type credentials; hand the desktop over if the person wants award prices, or give cash fares and say awards need their sign-in.
- If a search form appears, fill route, dates, passengers, choose the miles/award option, submit once. Read miles and cash copay per cabin, flight numbers, stops, saver/waitlist marks. Say prices are for the signed-in account.
- A pasted award results URL can be opened as-is.

## Walls

- Akamai on every path (`_abck`, `bm_*`, `akacd_NS_AB` cookies). A datacenter IP was challenged on its second navigation in testing. Tells: "verify you are a human" or an Akamai 403.
- curl is reset on every united.com path. `/api/flight/recentSearch` (405) and `searchFsr` (anti-tamper headers + session) are not usable — do not reverse-engineer.
- Do not press Select, Continue or a fare price.
