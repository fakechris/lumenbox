/**
 * The basic-catalog functions a card may call on the page (INV-1280): formatting, checks and
 * logic, which run as expressions in the renderer. `openUrl` is left out — a card does not
 * open links by itself; the person does (docs/79). Shared by the host's validator and the
 * page's catalog so they agree by construction.
 */
export const SHOW_UI_FUNCTIONS: readonly string[] = [
  "required", "regex", "length", "numeric", "email",
  "formatString", "formatNumber", "formatCurrency", "formatDate", "pluralize",
  "and", "or", "not",
];
