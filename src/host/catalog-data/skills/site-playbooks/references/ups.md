# UPS (www.ups.com)

Covers: tracking — status, expected or actual delivery, time window, who signed, last scan, event history.
Not covered: My Choice, delivery changes, driver release, holds.

## Tracking page

`https://www.ups.com/track?loc=en_US&tracknum={TN}&requester=ST/` (e.g. `tracknum=1Z6Y34W90305161551`). The `requester=ST/` part (with its slash) is what UPS's own emails use and keeps the My Choice and login pop-ups away. The page is an Angular app; wait a few seconds for it to fill.

Accepted numbers: the usual `1Z…` (18 characters in all), or the 12 digits printed on an InfoNotice door tag (InfoNotice shows status and next attempt only, never a signature).

Outcome by heading:

| Heading | Read next |
|---|---|
| Delivered | "Delivered On", "Signed by:" (Proof of Delivery panel; usually a surname) |
| Out For Delivery | time window |
| On the Way / In Transit | "Estimated Delivery Date" |
| Label Created, Delivery Attempted, Returned to Sender | status as is |
| "We could not locate the information" | not found |
| "Please enter a valid tracking number" | invalid |

Details:
- Expected date reads like "Friday, May 22" without a year — infer it, rolling into next year if it would otherwise be more than two weeks in the past. Window reads like "by 7:00 P.M.".
- Activity list (`data-spec="activity-list"`): each scan has a time, a location ("City, ST ZIP, Country"; blank for "Origin Scan" / "Order Processed") and a description. The first entry is the last known location. Times are local to each scan's place — keep them with their location rather than re-sorting.
- Multi-piece shipments list child packages.
- Other markers if you need them: `data-spec="header-status-text"`, `"delivery-date-text"`, `"delivery-time-text"`. Stable through 2024–2026 but verify on the page.

## Developer API (only with the person's credentials)

`POST https://onlinetools.ups.com/security/v1/oauth/token` for a bearer token (client id/secret from `developer.ups.com`; free tier ~250 calls/day — ask with AskSecret, do not register on their behalf), then `GET https://onlinetools.ups.com/api/track/v1/details/{TN}?locale=en_US&returnSignature=true` → `trackResponse.shipment[].package[].activity[]`.

## Walls

- Akamai guards `www.ups.com/track`, `wwwapps.ups.com/WebTracking/track` and `m.ups.com/mobile/track/details`. Challenge page: "Powered and protected by Akamai" (`sec-if-cpt-container`); or "Access Denied" with an Edgesuite reference. The box hits this often. Wait several more seconds; if still there, open `https://www.ups.com/us/en/home`, then the tracking link once more; then stop and give the person the tracking link.
- A red "Tracking Error" banner on an otherwise normal page is a UPS lookup failure — not invalid, not a bot wall. Same single retry via the home page.
- A reCAPTCHA means the session is flagged; stop.
- Do not curl `webapis.pkginfo.ups.com/track` (500 without cookies and CSRF), `…/track/api/Track/GetStatus` (error page or app shell), or `/track/client/main.*.js` (403).
