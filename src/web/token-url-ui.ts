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

/**
 * A 401 from the API means this page's sign-in ended while it was open: the member was removed or
 * the session expired (INV-2081). The server answers the page itself with a recovery page that says
 * which, so the page reloads into it instead of toasting "This UI needs a token". Once: the flag
 * stops a burst of 401s reloading twice, and the stamp in sessionStorage stops a reload that comes
 * straight back to a 401 from reloading again — then the caller's own error shows, as before. A
 * response that will be replaced by the reload never arrives, so nothing toasts on the way out.
 * Installed before either page's first request; both pages call fetch, so one wrapper covers both.
 */
export const SIGN_IN_AGAIN_JS = `
var signInReloading = false;
function signInAgain(status) {
  if (status !== 401) return false;
  if (signInReloading) return true;
  try {
    var last = Number(sessionStorage.getItem("lumenbox.signInReload")) || 0;
    if (Date.now() - last < 30000) return false;
    sessionStorage.setItem("lumenbox.signInReload", String(Date.now()));
  } catch (error) {
    return false; // no storage, no loop guard across reloads: keep the error on screen instead
  }
  signInReloading = true;
  location.reload();
  return true;
}
function watchSignIn(fetchImpl) {
  return function (input, init) {
    return fetchImpl(input, init).then(function (res) {
      var api = new URL(res.url || "/", location.href).pathname.indexOf("/api/") === 0;
      return api && signInAgain(res.status) ? new Promise(function () {}) : res;
    });
  };
}
if (window.fetch) window.fetch = watchSignIn(window.fetch.bind(window));
`;
