/**
 * The shared stylesheet for the sections loaded beside the page (docs/92, INV-1548).
 *
 * Type and space tokens, a dropdown that looks the same everywhere, and the few layout classes
 * the settings sections need, so their scripts set classes instead of writing styles inline. It
 * is injected by the same bundle that carries those sections (`/app/supervision.js`), after the
 * page's own stylesheet, so a rule here wins where both speak.
 */

const chevron = (colour: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'><path d='M1 1.5l5 5 5-5' fill='none' stroke='${colour}' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/></svg>`)}")`;

export const UI_CSS = `
:root {
  --fs-xs: 11px; --fs-sm: 12px; --fs-md: 13px; --fs-body: 15px; --fs-lg: 18px; --fs-xl: 22px;
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 24px; --sp-6: 32px;
}
.field select {
  appearance: none; -webkit-appearance: none; padding-right: 36px;
  background-image: ${chevron("#71675d")}; background-repeat: no-repeat; background-position: right 14px center; background-size: 12px 8px;
}
[data-theme="dark"] .field select { background-image: ${chevron("#7d8aa0")}; }
.ui-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
.ui-row + .ui-row, .ui-row + .fieldnote, .fieldnote + .ui-row { margin-top: var(--sp-2); }
.ui-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin-top: var(--sp-3); }
.ui-push { margin-left: auto; }
.ui-gap { margin-top: var(--sp-2); }
.ui-panel .btn + .fieldnote, .ui-panel .ui-row + .fieldnote { margin-top: var(--sp-1); }
.ui-panel { border: 1px solid var(--border); border-radius: var(--radius-md); padding: var(--sp-4); margin-top: var(--sp-2); }
.ui-step { font-size: var(--fs-xs); color: var(--muted); }
.ui-title { font-size: var(--fs-body); font-weight: 600; margin: var(--sp-1) 0 var(--sp-2); }
.ui-log {
  font-family: var(--font-mono); font-size: var(--fs-xs); line-height: 1.5; white-space: pre-wrap; overflow: auto; max-height: 220px;
  margin: var(--sp-2) 0 0; padding: var(--sp-2) var(--sp-3); background: var(--code-bg); color: var(--code-text); border-radius: var(--radius-input);
}
.ui-list-row { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); padding: var(--sp-1) 0; border-bottom: 1px solid var(--border); }
.ui-list-row .ui-grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ui-stack { display: flex; flex-direction: column; gap: var(--sp-1); }
.ui-link { color: var(--accent-2); font-size: var(--fs-md); cursor: pointer; text-decoration: none; background: none; border: 0; padding: 0; font-family: inherit; }
.ui-link:hover { text-decoration: underline; }
.ui-link.danger { color: var(--danger); }
.ui-link.block { display: block; margin: var(--sp-1) 0; font-size: var(--fs-sm); }
.ui-badge { margin-left: var(--sp-1); font-size: var(--fs-xs); }
.ui-small { font-size: var(--fs-sm); }
.ui-tiny { font-size: var(--fs-xs); }
.ui-pre { white-space: pre-wrap; }
.ui-w-xs { width: 64px; flex: none; } .ui-w-sm { width: 96px; flex: none; } .ui-w-md { width: 200px; } .ui-w-lg { width: 320px; max-width: 100%; } .ui-w-full { width: 100%; }
.ui-ask {
  position: fixed; z-index: 9999; max-width: 420px; padding: var(--sp-3); background: var(--surface);
  border: 1px solid var(--border-strong); border-radius: var(--radius-md); box-shadow: var(--shadow-pop); font-size: var(--fs-md);
}
.ui-ask .ui-pre { margin-bottom: var(--sp-2); }
.ui-ask input {
  width: 100%; box-sizing: border-box; margin-bottom: var(--sp-2); height: 36px; padding: 0 var(--sp-3);
  border: 1px solid var(--border-strong); border-radius: var(--radius-input); background: var(--bg); color: var(--text); font: inherit;
}
.ui-ask .ui-actions { justify-content: flex-end; margin-top: 0; }
`;

/** Injects the sheet once, at the end of <head>, so it follows the page's own. */
export const UI_STYLE_JS = `(function () {
  if (document.getElementById("lumen-ui-style")) return;
  var sheet = document.createElement("style");
  sheet.id = "lumen-ui-style";
  sheet.textContent = ${JSON.stringify(UI_CSS)};
  document.head.appendChild(sheet);
})();
`;
