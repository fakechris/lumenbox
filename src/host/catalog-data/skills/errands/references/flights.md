# Flights

Search, compare and book flights, then check in and fetch boarding passes. Every fare and schedule you quote comes from a site or service you name.

## Kinds of request

- Destination and date only ("to Chicago next Thursday"): fill in the rest.
- Fixed route with a rule ("cheapest nonstop LAX–JFK on the 12th").
- Flexible dates ("Lisbon sometime in May"): the price calendar matters more than one fare.
- A forwarded confirmation or deal email: look that trip up, check in or rebook. It is not a new search.

## Settle first

- Origin, destination, dates, passengers, cabin, and hard limits: must land before a meeting, avoid red-eyes, stay within one alliance. Default to one adult in economy and say so.
- `Recall` the home airport, airline and seat preferences, loyalty and known-traveller numbers, passport expiry.
- A city name can mean several airports. Washington is DCA, IAD and BWI: search all and label each option with its airport unless one is ruled out.

## Search

1. Use a flights or travel connector if one is listed. Otherwise open Google Flights or the airline's site with route, dates, passengers and cabin already in the URL. Playbooks: `google-flights`, `united`, `southwest`, `expedia`.
2. Capture for each flight: airline and number, departure and arrival times, duration, stops and where, fare name, total, bag rules if shown.
3. "Nonstop only", "after lunch", "not Newark", "cheaper" are filters. Apply them; do not ask again.
4. Each time is the clock at its airport. For "arrive before 23:00", check the local arrival date as well as the hour. Across zones, write "leaves SFO 08:15, lands JFK 16:45" and convert only when you say so.
5. Do not declare a route unserved from one empty search. Check with `WebSearch` and the airline's own site.

## Present

Three to five options that differ in a way the person cares about, each with: flight number, departure and arrival with airport codes, stops, journey time, fare type, bag or change limits, and the total for everyone. For flexible dates, summarise the two or three best date pairs from the calendar and ask which to search. If they gave an exact rule and one flight clearly wins, you may choose it, but still read it back before paying.

## Book

- Book where they prefer; with no preference, on the airline's site. If a travel site passes payment to the airline, warn that it means a second sign-in.
- Legal names, birth dates and contact details from what you know; ask for the rest. Passport numbers stay out of chat (see SKILL.md). Long passenger forms: one page at a time.
- Seats, bags and paid extras are listed, not bought.
- Read the whole itinerary, passenger names, fare and total back, then pay per SKILL.md. Report the booking reference, itinerary and total.

## Check-in and boarding passes

- Use the airline's own site to check in, with the booking code and the passenger's last name. Find the reference in the itinerary, memory, or the confirmation email (a connected mail service via `connector_request`, or their webmail in the browser) before asking.
- Save the boarding pass under `/home/box/work/`, one file per leg, named by flight and route, and give the path in your reply.
- Seat changes and upgrades offered at check-in: list them, do not buy.

## Watch for

- Fares move between search and checkout; flag any rise before payment.
- Basic and light fares often leave out bags and block changes; warn when the fare's name suggests that.
- International trips need passport and sometimes visa answers; collect them early.
- Multi-leg and open-jaw trips: review each segment before the read-back.
- Changes, refunds and credits depend on fare, channel, time to departure and current rules; read the airline's current policy before advising.
