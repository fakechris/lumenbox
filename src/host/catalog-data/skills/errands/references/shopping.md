# Shopping

Buy products on Amazon or any other store. You search, compare, fill the cart and the forms; the person chooses the product and approves the total.

## Kinds of request

- Reorder ("more of the coffee filters I get"): start from order history, not a search.
- Compare then buy with a budget ("65-inch TV under $800, good reviews").
- Browsing ("a good travel stroller"): the result is a shortlist; nothing goes in a cart yet.
- A pasted product link: go to that page.

## Settle first

- What, how many, and hard limits: budget, brand, deliver-by date, size. Assume harmless defaults and say so.
- `Recall` preferred store, memberships, default address, sizes, brand rules, views on upsells and delivery speed. Memberships (Prime, Walmart+, store cards) change prices and dates from the guest view; say which view you see.
- Use a connector if one is listed for the store. Otherwise open the store's search URL directly, e.g. `https://www.amazon.com/s?k=coffee+filters`. Playbooks: `bestbuy`, `target`, `costco`, `ebay`, `etsy`, `craigslist`, `facebook-marketplace`.

## Steps

1. For each strong candidate note its own product URL, name, price, rating and review count, delivery date, seller, key specs.
2. Compare on price, rating, delivery and the specs they care about.
3. If their criteria were precise and one product plainly comes out ahead, pick it and say why; still show it before checkout.
4. Variants (size, colour, pack count, subscription versus one-off) change the price. Ask when unspecified and the options truly differ; if not, go with the default and mention it.
5. Add to cart; for several items repeat, then review the cart once: each product, quantity, unit price, seller. Name third-party sellers on marketplaces.
6. Address: use the saved one when memory or the page confirms it; otherwise ask. Confirm the address before going on.
7. If checkout has a promo field and they have not mentioned a code, ask.
8. On the final review page compare subtotal, tax, shipping and the final figure with what you showed. Multi-page checkouts only reveal the real total at the end.
9. Read back product, quantity, address, delivery date and exact total; pay per SKILL.md; place the order.
10. Report order number, total charged, delivery estimate.

## Presenting

Three to five distinct candidates, one per line: `- [Name](product-url), $25.60, what sets it apart` (rating and count, delivery date, seller, or a spec they asked about). State trade-offs in money ("$40 more for the battery indicator"). No near-duplicates.

## Watch for

- Out of stock, long ship times, or delivery after their deadline: raise before checkout.
- Bundles, protection plans and subscribe-and-save: skip unless asked.
- A poorly rated or slow marketplace seller deserves a sentence even at the best price.
