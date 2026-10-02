# FedEx (www.fedex.com)

Covers: tracking a package — status, location, delivery window, service, who signed, scan history.
Not covered: labels, holds, redirects, delivery changes, proof-of-delivery documents, refunds.

## Tracking page

`https://www.fedex.com/fedextrack/?trknbr={NUMBER}` — e.g. `?trknbr=394002115586`.
- Use `trknbr`, not `trackingnumber` (that one can bounce to the landing page).
- One number per URL. Comma-joined lists can land on a system-error page; do several numbers one after another.
- The page is a JS app that fills in a second or more after load — wait for the status before reading.

Where you end up tells you the outcome:

| Path | Meaning |
|---|---|
| `/detailedtracking` | one shipment |
| `/multitrkidsummary` | several shipments |
| `/multitrkidnotfound`, `/no-results-found` | not found |
| `/duplicate-results` | number is ambiguous; needs a qualifier |
| `/guestAuthentication`, `/howtoproceed` | private shipment — stop |
| `/system-error` | wait a few seconds, try once more, then stop |

Read: status heading (Delivered / On the way / Pending), service line, scheduled or actual delivery, "Signed for by:". Open "Travel history" for every scan (time, place, description; newest first).

## Number formats

Standard: 12, 15 or 22 digits. A 16-character code is a Delivery Manager confirmation and leads to another flow.

## Official API (only if the person has FedEx developer credentials)

Token: `POST https://apis.fedex.com/oauth/token`, form body with client id, client secret and `grant_type=client_credentials` (ask for them with AskSecret; never in chat). Then call the tracking endpoint (`apis.fedex.com/track/v1/trackingnumbers`, POST) with the Bearer token, header `X-locale: en_US`, body `{"includeDetailedScans": true, "trackingInfo": [{"trackingNumberInfo": {"trackingNumber": "…"}}]}`.

Response under `output.completeTrackResults[].trackResults[]`:
- `latestStatusDetail.code`: OC label created, PU picked up, IT in transit, OD out for delivery, DL delivered, SE exception, CA cancelled; `scanLocation` city/state/country.
- Delivery: `estimatedDeliveryTimeWindow.window.begins/ends`, else `standardTransitTimeWindow.window.ends`, or `dateAndTimes[]` typed `ESTIMATED_DELIVERY` / `ACTUAL_DELIVERY`.
- `serviceDetail.type`, e.g. PRIORITY_OVERNIGHT, FEDEX_EXPRESS_SAVER, FEDEX_GROUND, GROUND_HOME_DELIVERY, GROUND_ECONOMY (the old SMART_POST), INTERNATIONAL_PRIORITY.
- `deliveryDetails.receivedByName` + `signatureType` (DIRECT, INDIRECT, ADULT, NO_SIGNATURE_REQUIRED → no name).
- `scanEvents[]`: date, type, description, location, exception code/description, `delayDetail`.
- `output.alerts[]` with `TRACKING.DATA.NOTFOUND.404` = not found; `TRACKING.AUTHORIZATION.ERROR` / `TRACKING.AUTHENTICATEDDELIVERY.ERROR` = private. History is purged after about 18 months.

## Traps

- Akamai on all of fedex.com (`_abck`, `ak_bmsc`, `bm_*`, `fdx_*` cookies). Outside a box a plain browser got "Access Denied"; if you get that or an empty shell after waiting, stop.
- The page's own `/trackingCal/track` call is tied to those cookies and 403s from a shell — do not curl it.
- A freshly created label shows not found or system-error until the first carrier scan. If the shipper's email shows no scan yet, say the label is not scanned yet (not "not found") and use the dates in that email.
- A sign-in or ZIP check is the private-shipment wall; stop and tell the person.
