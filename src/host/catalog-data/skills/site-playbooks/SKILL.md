---
name: site-playbooks
description: "Use before shopping, tracking or booking on: Airbnb BestBuy Costco Craigslist DoorDash eBay Etsy Expedia FB-Marketplace FedEx GoogleFlights Instacart LinkedIn Luma OpenTable Realtor Resy Southwest Target United UPS USPS."
description_zh: "22 个常用消费网站的操作手册：URL、过滤参数、数据位置、反爬墙与禁区"
description_en: "Playbooks for 22 consumer sites: URLs, filters, where the data sits, bot walls, no-go actions"
version: 1.0.0
provenance: "Written for LumenBox from a study of Grok Bot 0.63's managed skills (2026-10-02). Facts restated; no text copied."
---

# Site playbooks

Per-site notes for 22 busy consumer sites: the URL to open, the filters it takes, where the data sits (public API, JSON in the page, or only the rendered page), the bot wall to expect, and what not to touch. Read the site's reference before the first request, not after a failure. Facts are from 2026, mostly gathered outside a box; the live page wins over these notes.

Buying, booking or ordering for someone: also open `errands`. Logins and codes: `acting-for-them`.

## Rules for every site

1. **Read-only unless asked.** Carts, RSVPs and bookings only on request; anything that spends money or commits the person needs their yes to that exact thing. Never press "place order" twice.
2. **Cheapest route first.** A public JSON endpoint via `curl` in `bash` beats the browser; WebFetch beats `browser_open` for a page you only read. Skip the dead ends each reference lists.
3. **Verify on the page.** Check the page shows what you asked for (route, dates, ZIP, party, store). Pages fill in after load: `browser_wait_for` text you expect, then `browser_read` or `browser_snapshot`. A skeleton is not an empty result; "nothing matched" differs from "could not read".
4. **Blocked? Stop early.** Challenge, Access Denied, 403/429, captcha: one patient retry at most — more makes most walls worse. Never solve or bypass. Give the person the URL, use another source the reference names, or for a login/captcha/payment only they can do, HandOverDesktop and resume after WaitForControl.
5. **Credentials.** Never type a password, code or card with `browser_act`; use `browser_fill_secret`, AskSecret, or a handover.
6. **Site changed?** Work it out from the live page and say what differed from the reference.
7. **Leave a note.** Call NoteSiteLearning with one or two sentences on what worked or failed (`worked` true/false): a moved control, a dead param, a wall seen from this box. No credentials, no coordinates.

Work files go in `/home/box/work`.

## Sites (references/<file>.md)

| Site | Host | File | Covers | Not covered |
|---|---|---|---|---|
| Airbnb | airbnb.com | airbnb | stay search, one listing | hosting, reserving |
| Best Buy | bestbuy.com | bestbuy | name→SKU, price, ship/pickup | cart, member prices |
| Costco | costco.com, sameday.costco.com | costco | product price/stock; Same-Day cart | checkout |
| Craigslist | sapi.craigslist.org | craigslist | listing search (JSON) | posting, replying |
| DoorDash | doordash.com | doordash | stores, menus, cart, approved order | tips, promos |
| eBay | ebay.com | ebay | live/sold search, one item | bids, buying |
| Etsy | etsy.com | etsy | search, ads vs organic | cart, sellers |
| Expedia | expedia.com | expedia | stays, flights shortlist | booking |
| FB Marketplace | facebook.com/marketplace | facebook-marketplace | metro search, one item | messaging |
| FedEx | fedex.com | fedex | tracking | delivery changes |
| Google Flights | google.com/travel/flights | google-flights | cheapest fixed-date fares | booking |
| Instacart | instacart.com | instacart | search, guest cart | login, checkout |
| LinkedIn | linkedin.com/jobs | linkedin | recent job postings | applying, profiles |
| Luma | luma.com, api.luma.com | luma | events, one event, free RSVP | paid tickets |
| OpenTable | opentable.com | opentable | open times, confirmed booking | its JSON API |
| Realtor.com | realtor.com | realtor | listings, school ratings | agents, tours |
| Resy | resy.com, api.resy.com | resy | slots, confirmed booking | Notify, payment |
| Southwest | southwest.com | southwest | fares, low-fare calendar | booking, check-in |
| Target | target.com, redsky.target.com | target | best match, store stock | cart |
| United | united.com | united | cash fares, award view | booking, upgrades |
| UPS | ups.com | ups | tracking | My Choice |
| USPS | tools.usps.com | usps | tracking | holds, redelivery |
