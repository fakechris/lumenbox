# eBay (www.ebay.com)

Covers: searching listings (live or sold, for price comps); reading one item page.
Not covered: bidding, buying, offers, watchlist, cart, selling.

## Search URL

Base `https://www.ebay.com/sch/i.html`; only `_nkw` is required.

| Param | Values |
|---|---|
| `_nkw` | keywords, `+` for spaces |
| `_sacat` | category leaf id (e.g. 183454 CCG individual cards, 9355 cell phones) |
| `LH_ItemCondition` | 1000 New, 1500 New other, 1750 New with defects, 2000 Manufacturer refurb, 2010 Certified refurb, 2020/2030 Excellent/Very Good refurb, 2500 Seller refurb, 3000 Used, 4000/5000/6000 Very Good/Good/Acceptable (media), 7000 For parts. Combine with `\|` |
| Format | `LH_BIN=1` buy-now, `LH_Auction=1`, `LH_BO=1` best offer |
| `LH_Sold=1&LH_Complete=1` | sold listings — always send both |
| `LH_FS=1` | free shipping |
| `LH_PrefLoc` | 1 US, 2 North America, 3 worldwide, 4 Europe, 5 Asia |
| `LH_TopRatedPlus=1`, `LH_TitleDesc=1` | top-rated sellers; also search descriptions |
| `_udlo` / `_udhi` | price floor / ceiling, whole dollars |
| `_stpos={ZIP}&_dmd={miles}` | distance from ZIP; otherwise eBay guesses the ZIP from the IP and prices shipping to it |
| `_sasl={seller}&_saslop=1` | one seller |
| `_ipg` | 60, 120 or 240 only (anything else → 60); `_pgn` page |
| `_sop` | 12 best match, 1 ending soonest, 10 newest, 2/3 price low/high, 15/16 price+ship low/high, 7 nearest |

Example (sold comps): `https://www.ebay.com/sch/i.html?_nkw=iphone+12&LH_Sold=1&LH_Complete=1&_ipg=60`

## Reading results

- Cards are `li.s-card` now (old `.s-item__*` classes are gone). Take the item id from the card link (`/itm/` followed by 8+ digits); `data-listingid` is a tracking id, not the item id.
- One "Shop on eBay" placeholder card (id 123456) is junk.
- Price text glues sale and was-price together: `$92.92$109.32`. Ranges read `$0.99 to $3.00`.
- Subtitle is `condition · specifics…`; the first part is condition.
- Attribute rows mix: "N bids", "Buy It Now"/"or Best Offer"/"Best offer accepted", shipping ("+$…", "Free delivery"), "Located in …", "Free returns", "N watchers", "N sold", coupons, and a seller line `name 99.5% positive (34.3K)`.
- "Sponsored" is disguised with invisible characters (U+2060–2064, zero-width chars) and decoy letters; strip them before deciding a card is an ad.
- Result count heading reads "776 results for …"; "18,000+" is approximate.
- In sold mode the price is the sold price and the bid count is final. Per-card sold dates have no reliable spot; the item page shows "Sold on {date}".
- "Authenticity Guarantee" rows appear only in certain categories (sneakers 15709, watches 14324, handbags 169291, cards over $250).

## One item

`https://www.ebay.com/itm/{itemId}` (pasted URLs with slugs or tracking work too). Read title, price, bid count (present = auction, absent = buy-now), time left plus `<meta itemprop="endDate">`, condition, seller and feedback, shipping, item specifics table. An ended item shows "Sold on {date}". Give back the `<link rel="canonical">` URL, not the tracked one. No title and no wall = item not found.

## Walls (frequent)

- Akamai. Tells: `/splashui/challenge` showing "Pardon Our Interruption..."; a page titled exactly "Access Denied" carrying a Reference # and a link to `errors.edgesuite.net`; a 403 titled "Error Page | eBay" with "SORRY". Covers search, item pages, home, `m.ebay.com` and `&_rss=1`. HEAD answers 200 with nothing in it, which tells you nothing. No curl or WebFetch route.
- Outside a box, roughly half of new cloud sessions hit the wall on the very first page; the cure was a new IP, which a box cannot get. Expect it.
- After the first challenge, stop searching in that session — more searches deepen the block. Do not retry, narrow, or warm up via the home page.
- Next steps, in order: hand the desktop to the person for one verification and then reopen the same URL; or ask them for the `/itm/` link and read that; or use other sources. Never present prices from a page that did not render.
- Sold searches usually work signed out but are sometimes challenged; if so, offer a handover so the person signs in.
- eBay's Browse API (`api.ebay.com/buy/browse/v1/item_summary/search`) only works with an approved developer account.
