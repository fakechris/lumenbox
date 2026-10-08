# Instacart (www.instacart.com)

Covers: searching groceries across nearby retailers or in one store, and adding a listed set of items to a guest cart to get prices and a subtotal.
Not covered: logging in on your own, entering an address or payment, checkout. No public guest-cart API — browser only.

Adding to a cart is a change; do it only for items the person listed.

## URLs

| Want | URL |
|---|---|
| Search all nearby retailers | `https://www.instacart.com/store/s?k={query}` |
| Search in one retailer | `https://www.instacart.com/store/{retailer}/s?k={query}` |
| That retailer's home | `https://www.instacart.com/store/{retailer}/storefront` |

Retailer slugs look like `safeway`, `costco`, `kroger`, `7-eleven`, `grocery-outlet`. `/store/{retailer}/search/{query}` is a 404. Retailer carousels take a few seconds to appear.

## Location

The ZIP comes from the box's IP; `?zip_code=` is ignored. Which retailers you see depends on it. Change it only with the ZIP button in the header, and report the ZIP the cart says.

## Adding

- Each product has a button "Add 1 ct {name}"; after a successful add it turns into "Decrement quantity of {name}". Use that change as your check (`browser_act` with `expect`).
- After the first add a "$0 delivery fee on your first 3 orders" dialog appears and cannot be dismissed. It can make clicks look successful while the counter does not move. The known workaround was a scripted DOM click, which these tools do not have; if adds stop landing, report which items did not go in rather than looping.
- Some storefronts have no guest cart: the first add opens a sign-in modal and the button never changes. This is the login barrier; the fee pop-up looks different. Stop, tell the person this retailer needs their account, and if they agree hand the desktop over so they sign in; then repeat the same steps.

## Reading the cart

Open the cart from the header button (its text mentions the delivery fee or "View Cart"). The cart is a dialog whose title names the retailer and ZIP ("Personal {Retailer} Cart, Shopping in {ZIP}") — pick dialogs by that text, never by order, since the fee dialog is also open. It lists each item's name, size, price, struck-through original and deal label, plus "Item subtotal", a "$X Min. to checkout" (usually $10), and fee progress.

## Walls

Bot-protection edge plus invisible reCAPTCHA on every page. Outside a box a plain browser saw empty retailer lists or a captcha. Tells: search page still empty after a few seconds, or repeated 403s on background requests. Stop and report.
