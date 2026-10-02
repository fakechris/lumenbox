# Food delivery and pickup

Order through DoorDash, Uber Eats, Grubhub or a regional service (Deliveroo, Wolt, iFood, Just Eat) in the browser. Their account holds past orders, saved addresses and payment; your memory holds their preferences.

Two checks on every order:
- Delivery: confirm the address with them each time, even when the site has one saved; they may be elsewhere tonight. Pickup: confirm the store and the pickup time instead, and do not ask for an address.
- The cart is read back before placing, and a yes places exactly that cart.

## Kinds of request

- "Sort dinner out": the meal is your call.
- "Same as last Friday": the platform's order history.
- Items, place and time given ("two margheritas from Roberta's, pickup at 7").
- A pasted restaurant or menu link: open it.

## Settle first

- Which app: `Recall` and the conversation; otherwise the one that covers their area best, and say which. Use a connector if one is listed.
- `Recall` diet, dislikes, spice level, favourite places, tipping rule. Past orders are read on the platform.
- Delivery or pickup, now or scheduled; scheduled times in their zone.
- A stated budget is a limit. Without one, size to what similar past orders cost.
- Open-ended "somewhere good": use `restaurant-picks.md`, then confirm on the app that each place is open, delivers to them, and its ETA and fee.

## Steps

1. Go for the menu in the browser straight away rather than trying fetches first. Sources in order: the link they gave or the restaurant's page on their app (on DoorDash, the `/store/` URL); next, the restaurant's online ordering page if it has one. Leave out a restaurant site that showed hours but no prices; it will not have the menu. On the app's page also note: open now, delivers to the saved address, ETA, fee, and recent orders when reordering. The cart must be built on the app's own restaurant page; if the menu came from elsewhere, find that page first. Playbooks: `doordash`, `instacart`, `costco`.
2. Open-ended request: present options and get a choice before building a cart.
3. Build the cart: exact items as the menu names them, sizes, options, quantities, their notes on the item. Only what they asked for. If a later message narrows it ("just the pizza"), the latest wins. Decline upsells, round-ups and trials.
4. At checkout, note everything listed: the items, subtotal, each fee, tax, the preselected tip, total, and the ETA and address shown (pickup: store address and ready time). Leave the default tip unless a rule says otherwise, and mention it.
5. Read back with `AskUser`, address and total in the question ("Order for $41.75 to 88 Pine St, arriving in 30–40 min?"), options to place, change the address, or change the cart. For pickup, name store and time instead. Ask about a promo code only if checkout has a field for one.
6. A code or change that moves the total by more than the discount gets a fresh read-back. A change that arrives after you asked cancels that yes: rebuild and ask again.
7. Pay per SKILL.md, place the order, dismiss rating and add-more prompts, read the confirmation.
8. Report order number, ETA, total charged, address.

## Presenting

- Open-ended: three to five places with cuisine, one quality sign, ETA, fee, and any memory fit ("you've reordered here twice"), then ask.
- A dish with no place: the strongest pairings of place and dish, each with its price and ETA; do not just take the top-rated or fastest.
- Exact place or reorder: no options, but still confirm cart, address or time, and total.
- "The usual" when the history holds several candidates: show two or three and ask.
- Refinements give a new set and a new question; never switch restaurants on your own.
- Small decisions (a default side, a sauce) are yours; mention them in the read-back.

## Watch for

- Building a cart before checking the place is open and delivers there.
- Quoting the menu's subtotal when the charge is the checkout figure. If the total moves after the yes (substitution, surge), stop and ask again.
- A companion's item in a group order is not the person's taste.
- Saving an address or diet they did not state.
