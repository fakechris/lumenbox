# Craigslist ({city}.craigslist.org, sapi.craigslist.org)

Covers: searching postings by city, category and query.
Not covered: posting, replying, flagging.

## Use the JSON API, not the page

The site's UI reads a public JSON API. No login, no cookies, and no bot wall was seen (outside a box). Call it from `bash` with `curl`:

```
curl -fsS -H 'Referer: https://sfbay.craigslist.org/' \
 'https://sapi.craigslist.org/web/v8/postings/search/full?searchPath=sss&query=bicycle&sort=date&batch=1-0-360-1-0&lang=en&cc=us&postal=94103&search_distance=25'
```

- City codes: `sfbay`, `newyork`, `losangeles`, `seattle`, `chicago`, `boston`, …
- Categories (`searchPath`): `sss` all for-sale, `cta` cars and trucks, `apa` apartments, `ggg` by-owner, `jjj` jobs, `zip` free.
- Subarea: prefix it, e.g. `sfc/apa` (SF proper) or `eby/cta` (East Bay). Much smaller than region-wide (`apa` ≈ 9,800 across the Bay vs ≈ 253 for `sfc/apa`). Subarea codes appear in `data.decode.locations[i][2]`.
- `sort`: `date`, `rel`, `priceasc`, `pricedsc`.
- Filters: `min_price`, `max_price`, `min_bedrooms`, `max_bedrooms`, `min_bathrooms`, `hasPic=1`, `bundleDuplicates=1`, `availabilityMode=available`, `auto_make_model`, `min_auto_year`, `max_auto_year`, `min_auto_miles`, `max_auto_miles`, `postal`, `search_distance`. Unknown params vanish silently; `data.humanReadableParams` shows which ones took.

## Region trap

Without `postal`, results are located by the caller's IP, not by the `Referer`. Check `data.areas` names the metro you meant; if not, add `postal={any ZIP in that metro}&search_distance={miles}` (worked: `10001`/10 for NYC, `94103`/25 for the Bay).

## Paging

One call returns up to 360. The `/search/batch` endpoint for later pages needs a `cacheId` that `/full` no longer returns (400 "bad cacheId", seen 2026-09-10). So 360 is the ceiling: give `data.totalResultCount` and, if it is larger, tighten the subarea or filters.

## Decoding `data.items[]`

Each item is a positional array; several values are offsets into `data.decode`, which differs per response — decode against the same response.

| Slot | Meaning |
|---|---|
| `item[0]` | posting id offset → id = `data.decode.minPostingId + item[0]` (the raw offset 404s) |
| `item[1]` | seconds offset → posted epoch = `data.decode.minPostedDate + item[1]` |
| `item[2]` | category id; observed 5 fua, 68 bik, 93 spo, 101 foa, 122 pts, 197 bop |
| `item[3]` | price integer; 0, -1 or missing → report no price, not $0 |
| `item[4]` | `"locIdx:hoodDescIdx:hoodIdx~lat~lon"`; `data.decode.locations[locIdx]` = `[1, city, subarea]`, `data.decode.locationDescriptions[hoodDescIdx]` = display place |
| last plain string | title (apartment items put a `[5, beds, sqft]` block after it — scan backwards) |
| `[6, slug]` | URL slug |
| `[13, key]` | posting key used in the listing URL |
| `[10, "$1,350"]` | formatted price; `[4, …]` image ids |

Listing URL: `https://www.craigslist.org/view/d/{slug}/{key}`. The older `https://{city}.craigslist.org/{subarea}/{cat3}/d/{slug}/{postingId}.html` redirects there but 404s if `cat3` is wrong. `/search/{cat}?postingId=` no longer lands on the post.

Neighbourhood labels are inconsistent; for a neighbourhood search also filter by a lat/lon box from `item[4]`.

## Throttling

Keep to about one request per second. Short 403 replies mean you are being throttled: pause, retry once, then stop and report.
