# USPS (tools.usps.com)

Covers: tracking — status, expected delivery, last location, origin/destination, history.
Not covered: pickups, Hold Mail, Informed Delivery, address changes, redelivery, Tracking Plus.

## Tracking page

`https://tools.usps.com/go/TrackConfirmAction?tLabels={digits}` (e.g. `tLabels=9400111899223197428490`). Digits only. Allow a few seconds for the bot check and render.

- Status heading is free text, e.g. "Delivered, Front Door/Porch", "In Transit to Next Facility". Quote it, and also sort it into a bucket:

| Bucket | Heading contains |
|---|---|
| delivered | Delivered (any variant) |
| out for delivery | Out for Delivery |
| in transit | In Transit, Arrived at, Departed, Accepted, USPS in possession (also the default) |
| pre-shipment | Shipping Label Created, Pre-Shipment, Awaiting Item |
| pickup | Available for Pickup, Held at Post Office |
| alert | Delivery Exception, No Access, Return to Sender, Forwarded |
| attempted | Delivery Attempted, Notice Left |

- "Expected Delivery" ending in `*` is an estimate.
- Full history sits behind the "Tracking History" button.
- Not yet in the system: the page says "A status update is not yet available…" and asks you to check back.
- No tracking heading after ~8 s = blocked; stop and give the person the link.

## REST API (only with the person's credentials)

Token: `POST https://apis.usps.com/oauth2/v3/token` (client-credentials grant; id and secret from `https://gateway.usps.com/`, `scope=tracking`) — ask with AskSecret. Then `GET https://apis.usps.com/tracking/v3/tracking/{number}?expand=DETAIL` (events need `expand=DETAIL`). Fields: `status`, `statusCategory`, `expectedDeliveryDate`, origin/destination city and state, `trackingEvents[]` (`eventTimestamp`, `eventType`, `eventCode`, `eventDescription`, `eventCity`, `eventState`, `eventZIP`, `eventCountry`).

## Walls and dead ends

- Akamai on `tools.usps.com/go/TrackConfirmAction*` and `m.usps.com/m/TrackConfirmAction*`. curl gets a 200 that is ~220 KB of challenge script, not tracking data. Whether a box browser clears it is unconfirmed.
- `TrackConfirmAjaxAction.action` → 404. The legacy TrackV2 XML API (`secure.shippingapis.com/ShippingAPI.dll`) wants a registered USERID and is on its way out. Do not probe them.
