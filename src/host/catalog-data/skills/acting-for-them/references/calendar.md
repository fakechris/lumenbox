# Their calendar

LumenBox has no calendar of its own. It reaches a calendar only through a connected service or through the browser.

| Calendar | Route |
|---|---|
| Google Calendar | The Google door's tools (`google__…`). They exist only when the operator has turned that door on. |
| Feishu calendar | `connector_request` with `feishu`. It acts as the Feishu app, so it reaches only the calendars the app has been given, not automatically the person's. |
| Anything else | The box's browser, if they are signed in there. Otherwise there is no route; say so. |

If none of these is open to you, say so in one sentence and offer what you can still do, such as drafting the invitation text. Never invent free time, an event or a link.

## Settle the meaning before you write

Every request leaves some of these open. Fill only the ones that are actually open.

- **Who**: the people on it, and whether each one is invited or only mentioned.
- **What kind**:
  - A note to self (a hold, focus time, a reminder) has no attendees, even if it names someone. "Put Lin's talk in my calendar" is one.
  - An invitation is something the other person expects to receive.
  - A proposal means a message goes out with times, and an event may follow later.
  - Naming a person, or saying "put it in my calendar", decides none of this on its own.
- **When**: the date, start, length and time zone. A vague window ("sometime next week") is enough to propose times, not to invite someone whose availability you have not seen.
- **Where**: a venue or a call, if that alters the setup.
- **Which calendar**, when they have more than one, and whether anyone gets notified.

Ground the answers in this conversation, in what you remember (`Recall`, for working hours or which calendar is for work), and in the calendar itself. An old thread or note tells you whom to ask and which times to suggest. It is not someone's agreement to a new time. Only a reply in the current exchange, or a live calendar or booking result, counts as that.

When a gap would change what the event means, ask one question with `AskUser`: real options you checked, and a default. When the gap is cosmetic (the title, the length, a reminder, a colour), choose something sensible and mention it. A 1:1 usually runs half an hour and a group meeting an hour, unless they say otherwise.

Write every time in the person's time zone and name the zone. When you turn "Friday" into a date, give both the weekday and the date.

## Before anything reaches other people

- Adding or moving an event only they attend goes ahead on a clear request.
- Sending invitations, or changing or cancelling an event others are on, notifies those people. Show it first: who will be told, and what changes. Then wait for a yes (see `send-on-behalf.md`).
- Changes that only affect their own view, such as a title tweak or a reminder, notify nobody.
- To add or remove one attendee, use that operation if the tool offers it, rather than rewriting the whole guest list.
- If the event belongs to someone else, ask before touching it.

## Appointments booked on a website

A calendar entry is not a reservation. A dentist, a class or a restaurant is booked on its own site.

1. Use a connected service for it if there is one. Otherwise open the site in the box's browser.
2. Sign in by `sign-in.md`.
3. Before the final reserve or confirm click, show the slot, the place and any charge, and wait for a yes.
4. A pay or order click stops for the person's consent. A card that is not in the vault means handing over the desktop with reason `payment`. The person finishes payment there, so afterwards read the confirmation page rather than clicking confirm again.
5. Once the site confirms, add the event to the calendar with the confirmation number in it.

## Something that should happen every week

A recurring nudge ("each Monday at 9, go over my week with me") is a routine, not an event. Write a skill file with a `schedule:` line in its frontmatter, for example `schedule: daily 08:30`. A missed window is skipped, not replayed.

## Reporting

Say when it is (in their zone), who will be there, that it is in place, and the link the tool returned. Do not read the title back to them. Where you assumed a preference, ask once whether to remember it, and keep it with `RememberFact` on a yes. Never make up a confirmation number or a link.
