export const STRIP_TOKEN_JS = `
// Only if the page loaded, which means the cookie was set, strip the bootstrap
// token so it does not survive in browser history or in a copied link.
(function stripToken() {
  try {
    var url = new URL(window.location.href);
    if (!url.searchParams.has("token")) return;
    url.searchParams.delete("token");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  } catch (error) {
    // A browser without history.replaceState still works; it keeps the token visible.
  }
})();
`;
