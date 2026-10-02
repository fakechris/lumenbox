# OpenTable (www.opentable.com)

Covers: available times for N people on a date, at a named restaurant or across a neighbourhood search; booking a slot the person has confirmed.
Not covered: calling OpenTable's JSON endpoints (bot-walled — do not use the shell).

## Start from a URL that already has party and time

- Named restaurant: find its page with WebSearch ("{name} {city} OpenTable") — usually `https://www.opentable.com/r/{slug}`. Open `https://www.opentable.com/r/{slug}?covers={N}&dateTime=YYYY-MM-DDTHH:MM:00`.
- Cuisine or area: `https://www.opentable.com/s?covers={N}&dateTime=YYYY-MM-DDTHH:MM:00&term={cuisine neighbourhood city}`.

Do not invent other OpenTable URL shapes.

## Reading

- The URL sets party and time; read the times shown. Touch the date/time/party controls only if the page shows something else, and only once.
- Hidden labels on time buttons can mention a different party size — believe the party control.
- A neighbourhood in the search term does not narrow results to it — the whole city comes back. Filter by the area shown on each card.
- All times are local to the restaurant. Slots tagged with a symbol or an experience title are special seatings and are often paid in advance.
- "No online availability" or a notify option means nothing bookable online then. If the asked time is gone, give the nearest open ones; an adjacent day or the restaurant's phone are other options.
- If times are still loading, wait once (`browser_wait_for`) and read again; do not loop.
- A blank or crashed tab without an error is a slow page — reopen the same URL once. That is not a block.

## Do not click a time while only checking

Clicking a time holds the table.

## Booking

Only after the person said yes to a specific slot. OpenTable may already have a login in the box's browser — try first, ask later. Open the restaurant page carrying the agreed date, time and party size; on the details page check the party size matches before completing; use only guest details you actually have. Read back the confirmation number. A password, one-time code or card number request: hand the desktop to the person.

## Walls

Reloading will not lift "Access Denied", a challenge, or any other block. Stop and give the person the restaurant page URL.
