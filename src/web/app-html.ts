/**
 * The web UI, as a single inlined document.
 *
 * Inlined rather than served from disk so the CLI stays one esbuild bundle with no
 * asset paths to resolve, and vanilla JS on purpose: this is an acceptance-testing
 * surface, and a build step for it would be a liability rather than a feature.
 * The two exceptions that do live on disk — the markdown renderer and the woff2
 * fonts — degrade gracefully when absent: plain text, system fonts.
 *
 * The look is the Lumen design system: two equal themes ("Atelier" warm light,
 * "Vault" dark) switched by data-theme on <html>, IBM Plex for UI and mono, a
 * reading serif for the agents' prose, 1px hairlines instead of elevation, and
 * status as a colored dot plus a word. The tokens below are copied from the design
 * sheet rather than referenced, for the same reason everything else is inline.
 *
 * The embedded script uses string concatenation instead of template literals
 * throughout. It has to: this file is itself a template literal, so an inner
 * "${...}" would be evaluated here rather than shipped to the browser. The one
 * deliberate interpolation is the Markdown options, which belong next to the tests
 * that assert what they guarantee.
 */

import { MARKDOWN_OPTIONS } from "./markdown.ts";

export const APP_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LumenBox</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128'%3E%3Crect x='4' y='4' width='120' height='120' rx='30' fill='%23231a13'/%3E%3Cpath d='M64 32 96 49 64 66 32 49Z' fill='%23d9634a'/%3E%3Cpath d='M32 49 64 66v32L32 81Z' fill='%23d9634a' fill-opacity='.62'/%3E%3Cpath d='M96 49 64 66v32l32-17Z' fill='%23d9634a' fill-opacity='.34'/%3E%3C/svg%3E">
<script>
// The theme, before first paint: reading it after the stylesheet applies flashes the
// wrong colors on every load for everyone on the non-default theme.
(function () {
  var theme;
  try { theme = localStorage.getItem("lumen-theme"); } catch (error) {}
  if (theme !== "light" && theme !== "dark") {
    theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark" : "light";
  }
  document.documentElement.setAttribute("data-theme", theme);
})();
</script>
<style>
  /* ── Lumen tokens ─────────────────────────────────────────────────────────── */
  @font-face { font-family: "IBM Plex Sans"; font-style: normal; font-weight: 400; font-display: swap;
    src: url("/assets/fonts/IBMPlexSans-Regular.woff2") format("woff2"); }
  @font-face { font-family: "IBM Plex Sans"; font-style: normal; font-weight: 500; font-display: swap;
    src: url("/assets/fonts/IBMPlexSans-Medium.woff2") format("woff2"); }
  @font-face { font-family: "IBM Plex Sans"; font-style: normal; font-weight: 600; font-display: swap;
    src: url("/assets/fonts/IBMPlexSans-SemiBold.woff2") format("woff2"); }
  @font-face { font-family: "IBM Plex Sans"; font-style: normal; font-weight: 700; font-display: swap;
    src: url("/assets/fonts/IBMPlexSans-Bold.woff2") format("woff2"); }
  @font-face { font-family: "IBM Plex Mono"; font-style: normal; font-weight: 400; font-display: swap;
    src: url("/assets/fonts/IBMPlexMono-Regular.woff2") format("woff2"); }
  @font-face { font-family: "IBM Plex Mono"; font-style: normal; font-weight: 500; font-display: swap;
    src: url("/assets/fonts/IBMPlexMono-Medium.woff2") format("woff2"); }
  @font-face { font-family: "IBM Plex Mono"; font-style: normal; font-weight: 600; font-display: swap;
    src: url("/assets/fonts/IBMPlexMono-SemiBold.woff2") format("woff2"); }

  :root, [data-theme="light"] {
    color-scheme: light;
    --bg: #f7f6f2; --bg-deep: #efece5; --surface: #fffdfa; --surface-2: #fbf7f0;
    --border: #e7e1d8; --border-strong: #cdc4b6;
    --text: #1f1a17; --text-soft: #443a32; --muted: #71675d;
    --accent: #9f4f24; --accent-soft: #f4dfd2; --accent-strong: #843c15;
    --accent-2: #2563bb; --accent-2-soft: #dbe7f7; --on-accent: #fffdfa;
    --success: #2f7d52; --success-soft: #e4f0e8;
    --warn: #a85e10; --warn-soft: #fff8ec; --warn-border: #d48a2f;
    --danger: #b04545; --danger-soft: #fbe9e7;
    --code-bg: #f4f1ea; --code-text: #1f1a17;
    --c-1: #9f4f24; --c-2: #2563bb; --c-3: #2f7d52; --c-4: #b8862e;
    --c-5: #6c4dab; --c-6: #b04545; --c-7: #2d6e87; --c-8: #645a52;
    --sidebar: #efece5; --surface-hover: #f2ede4;
    --shadow-shell: 0 12px 36px rgba(31,26,23,0.06);
    --shadow-pop: 0 16px 48px rgba(31,26,23,0.12);
  }
  [data-theme="dark"] {
    color-scheme: dark;
    --bg: #0a0e16; --bg-deep: #05080d; --surface: #11161f; --surface-2: #161c27;
    --border: #1f2937; --border-strong: #2c3a4f;
    --text: #e6edf5; --text-soft: #c2cfde; --muted: #7d8aa0;
    --accent: #3b82f6; --accent-soft: rgba(59,130,246,0.16); --accent-strong: #5b98f8;
    --accent-2: #06b6d4; --accent-2-soft: rgba(6,182,212,0.16); --on-accent: #081120;
    --success: #22c55e; --success-soft: rgba(34,197,94,0.15);
    --warn: #fbbf24; --warn-soft: rgba(245,158,11,0.12); --warn-border: #f59e0b;
    --danger: #f472b6; --danger-soft: rgba(244,114,182,0.14);
    --code-bg: #0e1420; --code-text: #e6edf5;
    --c-1: #3b82f6; --c-2: #06b6d4; --c-3: #22c55e; --c-4: #eab308;
    --c-5: #a78bfa; --c-6: #f472b6; --c-7: #14b8a6; --c-8: #94a3b8;
    --sidebar: #0c1119; --surface-hover: #1c2432;
    --shadow-shell: 0 12px 36px rgba(0,0,0,0.55);
    --shadow-pop: 0 18px 52px rgba(0,0,0,0.7);
  }
  :root {
    --font-sans: "IBM Plex Sans", "IBM Plex Sans SC", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --font-serif: "Iowan Old Style", "Songti SC", "Source Han Serif SC", Georgia, "Times New Roman", serif;
    --radius-input: 10px; --radius-md: 12px; --radius-card: 16px; --radius-pill: 999px;
    --dur: 150ms; --ease: cubic-bezier(0.4, 0, 0.2, 1);
  }

  /* ── shell ────────────────────────────────────────────────────────────────── */
  * { box-sizing: border-box; }
  html { font-size: 15px; }
  /*
   * Nothing scrolls the document. Each column scrolls inside itself, so reading
   * back through one agent's conversation never moves the desktop out of view.
   *
   * min-height: 0 on the panes and their scrollers is what makes that work: a flex
   * item defaults to min-height auto, so a long conversation or a busy activity
   * feed grows its column past the viewport, the body scrolls instead, and all
   * three columns move together.
   */
  html, body { height: 100%; }
  body {
    margin: 0; overflow: hidden; display: flex; flex-direction: column;
    font-family: var(--font-sans); font-size: 0.92rem; line-height: 1.55;
    background: var(--bg); color: var(--text);
    font-synthesis: none; -webkit-font-smoothing: antialiased;
  }
  ::selection { background: var(--accent-soft); color: var(--text); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  a { color: var(--accent-2); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .dim { color: var(--muted); }
  .mono { font-family: var(--font-mono); }

  #topbar {
    flex: none; height: 40px; display: flex; align-items: center; gap: 12px;
    padding: 0 14px; background: var(--surface-2); border-bottom: 1px solid var(--border);
  }
  #topbar .brand { display: flex; align-items: center; gap: 9px; font-weight: 600; font-size: 0.92rem; }
  #topbar .brand svg { border-radius: 5px; display: block; }
  #topbar .mid {
    flex: 1; display: flex; justify-content: center; align-items: center; gap: 10px;
    font-family: var(--font-mono); font-size: 12px; color: var(--muted);
    overflow: hidden; white-space: nowrap;
  }
  #topbar .mid b { color: var(--text-soft); font-weight: 500; }
  #theme, #settingsbtn {
    border: 0; background: none; color: var(--muted); cursor: pointer; padding: 4px;
    border-radius: var(--radius-input); display: flex; transition: color var(--dur) var(--ease);
  }
  #theme:hover, #settingsbtn:hover { color: var(--text); }

  /* Inside the desktop shell the top bar doubles as the window title bar: the whole
     strip drags, the controls opt out, and on macOS the traffic lights need room. */
  body.electron #topbar { -webkit-app-region: drag; }
  body.electron #topbar button, body.electron #topbar a { -webkit-app-region: no-drag; }
  body.electron-mac #topbar { padding-left: 84px; }

  /* ── the admin view ───────────────────────────────────────────────────────── */
  #spendwrap .modal { width: 860px; }
  /* The body scrolls and the caveat does not: "this is a lower bound" and "no rate for X"
     are the two things a reader most needs and the two a long table pushes off screen. */
  #spendbody { max-height: 46vh; overflow-y: auto; }
  #spendtoday { cursor: pointer; }
  #spendtoday:hover { color: var(--text); }
  .spendgrid { display: grid; grid-template-columns: 150px 1fr; gap: 16px; align-items: start; }
  .daylist { display: flex; flex-direction: column; gap: 1px; max-height: 320px; overflow-y: auto; }
  .daylist a {
    display: flex; justify-content: space-between; gap: 8px; padding: 4px 6px;
    font-size: 12px; text-decoration: none; color: var(--text-soft); border-radius: 4px;
  }
  .daylist a:hover { background: var(--surface-2); color: var(--text); }
  .daylist a.on { background: var(--surface-2); color: var(--text); font-weight: 600; }
  table.spend { width: 100%; border-collapse: collapse; font-size: 12px; }
  table.spend th {
    text-align: left; font-weight: 500; color: var(--muted); font-size: 10.5px;
    letter-spacing: 0.06em; text-transform: uppercase; padding: 3px 6px;
    border-bottom: 1px solid var(--border);
  }
  table.spend td { padding: 3px 6px; border-bottom: 1px solid var(--border); }
  table.spend td.num { text-align: right; font-family: var(--font-mono); }
  /* A cost that is not on file is not a small cost. Rendered as a word rather than a
     number so a column of figures cannot be read as if this row were cheap. */
  table.spend td.unknown {
    color: var(--muted); font-style: italic; text-align: right; white-space: nowrap;
  }
  /* The task title is the only thing here allowed to be long. Everything else is a
     figure, and a figure that wraps turns one row into three. */
  table.spend td:not(:first-child) { white-space: nowrap; }
  /* …except the note, which is the whole point of the history table. */
  table.spend td:last-child { white-space: normal; }
  table.spend tr.pick:hover td { background: var(--surface-2); }
  table.spend a { color: var(--accent, inherit); text-decoration: none; font-weight: 600; }
  table.spend a:hover { text-decoration: underline; }
  .caveat { font-size: 11.5px; color: var(--muted); line-height: 1.5; }

  /* ── settings ─────────────────────────────────────────────────────────────── */
  #spendwrap, #settingswrap, #agentwrap {
    position: fixed; inset: 0; z-index: 20; display: flex;
    align-items: center; justify-content: center; background: rgba(0,0,0,0.3);
  }
  .modal {
    width: 520px; max-width: calc(100vw - 40px); max-height: calc(100vh - 80px); overflow-y: auto;
    background: var(--surface); border: 1px solid var(--border-strong);
    border-radius: var(--radius-card); box-shadow: var(--shadow-pop);
    padding: 22px; display: flex; flex-direction: column; gap: 14px;
  }
  .modal h3 { margin: 0; font-size: 1.15rem; font-weight: 600; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field > label { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
  .radio { display: flex; gap: 8px; align-items: baseline; font-size: 13px; color: var(--text-soft); cursor: pointer; }
  .btn.danger { background: var(--danger); border-color: var(--danger); color: #fff; }
  .field input, .field select {
    height: 38px; padding: 0 12px; border-radius: var(--radius-input);
    border: 1px solid var(--border-strong); background: var(--bg); color: var(--text); font: inherit;
  }
  .field input { font-family: var(--font-mono); font-size: 13px; }
  .field textarea {
    min-height: 84px; padding: 10px 12px; border-radius: var(--radius-input); resize: vertical;
    border: 1px solid var(--border-strong); background: var(--bg); color: var(--text);
    font: inherit; line-height: 1.55;
  }
  .field input:focus, .field select:focus, .field textarea:focus { outline: 0; border-color: var(--accent); }
  /* Tool grants as toggle pills: filled means offered, outline means withheld —
     withheld tools are not in the agent's prompt at all. */
  .toolchips { display: flex; flex-wrap: wrap; gap: 8px; }
  .toolchip {
    font-family: var(--font-mono); font-size: 12px; padding: 5px 10px; cursor: pointer;
    border-radius: var(--radius-pill); border: 1px solid var(--border); color: var(--muted);
    transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
  }
  .toolchip.on { background: var(--accent-soft); color: var(--accent); border-color: transparent; }
  .fieldnote { font-size: 12px; color: var(--muted); line-height: 1.6; }
  .fieldnote:empty { display: none; }
  .modal .actions { display: flex; gap: 10px; padding-top: 2px; }

  #shell { flex: 1; min-height: 0; display: flex; }
  /* The box bar: one tab per box, above everything, because switching a box switches the
     whole page (docs/39 §1). Hidden with one box — a bar of one tab says nothing. */
  .settab-off { display: none !important; }
  #boxbar { display: none; align-items: center; gap: 6px; padding: 6px 14px; border-bottom: 1px solid var(--border); background: var(--surface); }
  #boxbar.many { display: flex; }
  #boxbar .tab { display: inline-flex; align-items: center; gap: 6px; }
  #boxbar .tab .dot { width: 7px; height: 7px; border-radius: 50%; }
  #boxbar .kind { font-size: 10px; color: var(--muted); text-transform: none; }
  .pane { min-width: 0; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
  .scroll { overflow-y: auto; flex: 1; min-height: 0; }

  /* Left 224px fixed, right 480px fixed, middle flexes — the desktop never scrolls
     out of view and each pane answers one question. */
  #sidebar { width: 224px; flex: 0 0 224px; background: var(--sidebar); border-right: 1px solid var(--border); }
  #rightpane { width: 480px; flex: 0 0 480px; border-left: 1px solid var(--border); }
  @media (max-width: 1240px) { #rightpane { width: 380px; flex: 0 0 380px; } }

  .eyebrow {
    font-size: 11px; letter-spacing: 0.13em; text-transform: uppercase; color: var(--muted);
  }
  .eyebrow-row {
    flex: none; display: flex; align-items: center; justify-content: space-between;
    padding: 14px 16px 8px;
  }

  /* ── buttons ──────────────────────────────────────────────────────────────── */
  .btn {
    font: inherit; font-size: 0.92rem; cursor: pointer; border-radius: var(--radius-input);
    border: 1px solid var(--border-strong); background: var(--surface); color: var(--text);
    padding: 7px 16px; transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease);
  }
  .btn:hover:not(:disabled) { background: var(--surface-hover); }
  .btn:disabled { opacity: 0.45; cursor: default; }
  .btn.accent { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
  .btn.accent:hover:not(:disabled) { background: var(--accent-strong); border-color: var(--accent-strong); }
  .btn.ghost { border-color: transparent; background: none; color: var(--text-soft); }
  .btn.ghost:hover:not(:disabled) { background: var(--surface-hover); }
  .btn.sm { padding: 4px 12px; font-size: 12px; }

  /* ── sidebar: who is working ──────────────────────────────────────────────── */
  .agent {
    margin: 0 8px 2px; padding: 9px 10px; cursor: pointer; border-radius: var(--radius-input);
    display: flex; gap: 10px; align-items: center;
    transition: background var(--dur) var(--ease);
  }
  .agent:hover { background: var(--surface-hover); }
  .agent.on { background: var(--accent-soft); }
  .agent.on .nm, .agent.on .ttl, .agent.on .dnum { color: var(--accent); }
  /* The dot beside an agent carries its identity color (--c-1…8, stable by roster
     position); state is the word next to it, and the pulse while a turn runs. */
  .dot { width: 7px; height: 7px; border-radius: var(--radius-pill); background: var(--muted); flex: none; }
  .dot.busy { animation: pulse 1.2s infinite; }
  .dot.ok { background: var(--success); }
  .dot.bad { background: var(--danger); }
  @keyframes pulse { 50% { opacity: 0.3; } }
  .agent .cols { flex: 1; min-width: 0; }
  .agent .nm { font-weight: 600; font-size: 0.92rem; }
  .agent .ttl {
    color: var(--muted); font-size: 11px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .agent .dnum { font-family: var(--font-mono); font-size: 11px; color: var(--muted); }
  #sidefoot {
    flex: none; margin-top: auto; padding: 10px 16px 12px; border-top: 1px solid var(--border);
    display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted);
  }
  #sidefoot .footrow { display: flex; align-items: center; gap: 9px; }
  #sidefoot .footrow span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Which build is running, for reading a bug report against the right code. */
  #buildinfo { font-family: var(--font-mono); font-size: 11px; }

  /* ── pane headers ─────────────────────────────────────────────────────────── */
  .paneheader {
    flex: none; height: 52px; border-bottom: 1px solid var(--border);
    display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 0 18px;
  }
  .paneheader .lead { display: flex; align-items: center; gap: 10px; min-width: 0; }
  /* Right pane only: a crowded lead clips inside its own box instead of painting
     under the actions — the badge shrinks first (it repeats what the notice banner
     says in full), the tabs never do. NOT the left pane's lead: the conversation
     dropdown is absolutely positioned inside it, and overflow:hidden beheads it. */
  #rightpane .paneheader .lead { overflow: hidden; }
  #title { font-weight: 600; font-size: 1rem; }
  .roundpill {
    display: flex; align-items: center; gap: 7px; font-family: var(--font-mono); font-size: 12px;
    color: var(--accent); background: var(--accent-soft); padding: 4px 10px; border-radius: var(--radius-pill);
    white-space: nowrap;
  }
  .roundpill:empty { display: none; }
  .headactions { display: flex; align-items: center; gap: 10px; flex: none; }

  /* ── consent, before the conversation: an agent waiting on a person has stopped
        working, and scrolling to find that out is the interface keeping them waiting. */
  #approvals { flex: none; display: flex; flex-direction: column; gap: 8px; padding: 12px 18px 0; }
  .consent {
    border: 1px solid var(--warn-border); background: var(--warn-soft);
    border-radius: var(--radius-card); padding: 14px 16px;
    display: flex; flex-direction: column; gap: 10px;
  }
  .consent .chead { display: flex; align-items: center; gap: 9px; font-weight: 600; font-size: 0.92rem; }
  .consent .chead .dot { background: var(--warn); }
  .consent code {
    font-family: var(--font-mono); font-size: 12px; line-height: 1.6; color: var(--text-soft);
    white-space: pre-wrap; word-break: break-word;
  }
  .consent .note { font-size: 12px; color: var(--text-soft); }
  .consent .cactions { display: flex; gap: 8px; }

  #progress { flex: none; margin: 12px 18px 0; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); padding: 10px 14px; font-size: 12px; }
  #progresshead { color: var(--text-soft); }
  #progresshead b { font-weight: 600; color: var(--text); }
  #progresslist { color: var(--muted); margin-top: 2px; }

  /* ── the conversation ─────────────────────────────────────────────────────── */
  #chat { padding: 18px 18px 8px; display: flex; flex-direction: column; gap: 4px; }
  /* A flex column whose content overflows shrinks its items to fit — and an item with
     overflow: hidden (the tool rows) may shrink to nothing, which is exactly what
     happened: every tool call rendered as a 2px hairline. The scroller scrolls;
     nothing inside it gets compressed. */
  #chat > * { flex-shrink: 0; }
  .msg { padding: 6px 0; word-break: break-word; position: relative; }
  /* The message toolbar (docs/41 §1): under the message, never over it. Faint until hovered. */
  .msg .mtools { display: flex; gap: 2px; margin-top: 4px; opacity: 0.3; transition: opacity var(--dur) var(--ease); }
  .msg:hover .mtools, .msg .mtools:focus-within { opacity: 1; }
  .msg.user .mtools { justify-content: flex-end; }
  /* A teammate speaking here (docs/41 §1): a bubble with its own colour, sans, labelled. */
  .msg.peer .body { font-family: var(--font-sans); font-size: 0.92rem; line-height: 1.6; background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--peer-colour, var(--border-strong)); border-radius: var(--radius-card); padding: 10px 14px; }
  .msg.peer .who .chip { text-transform: none; letter-spacing: 0; font-weight: 400; }
  .sentfoot { text-align: right; font-size: 11px; color: var(--muted); margin: -2px 0 6px; }
  .sentfoot .peerdot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; vertical-align: middle; margin-right: 4px; }
  .sentfoot details { display: inline; }
  .sentfoot summary { display: inline; cursor: pointer; list-style: none; }
  .sentfoot .det { text-align: left; margin-top: 4px; white-space: pre-wrap; color: var(--text-soft); font-size: 12px; }
  .peerfold { font-size: 11px; color: var(--muted); cursor: pointer; padding: 4px 0; }
  .peerfold.shut + .peerrun { display: none; }
  /* The plan card folds itself when everything is done; a person can open it again. */
  #progress details > summary { cursor: pointer; list-style: none; }
  #progress details > summary::-webkit-details-marker { display: none; }
  .mtools button { border: 1px solid var(--border); background: var(--surface); color: var(--muted); font-size: 11px; padding: 1px 7px; border-radius: 6px; cursor: pointer; }
  .mtools button:hover { color: var(--text); border-color: var(--border-strong); }
  .msg.copied .mtools button[data-act="copy"] { color: var(--ok, #3fb950); }
  /* Code blocks copy (docs/40 §3). */
  .msg .body pre { position: relative; }
  .msg .body pre .precopy { position: absolute; top: 6px; right: 6px; font-size: 11px; padding: 1px 7px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--muted); cursor: pointer; opacity: 0.35; }
  .msg .body pre:hover .precopy { opacity: 1; }
  /* The work fold (docs/41 §1): one line, the calls inside. Prose never lives in here. */
  details.work { margin: 4px 0 8px; max-width: 700px; }
  details.work > summary { cursor: pointer; list-style: none; font-size: 12px; color: var(--muted); padding: 4px 0; display: flex; align-items: center; gap: 8px; }
  details.work > summary::-webkit-details-marker { display: none; }
  details.work > summary::before { content: "\25b8"; color: var(--muted); }
  details.work[open] > summary::before { content: "\25be"; }
  details.work > summary:hover { color: var(--text); }
  details.work > .calls { padding: 2px 0 2px 16px; border-left: 2px solid var(--border); margin-left: 4px; }
  details.work details.tool { font-size: 11.5px; }
  /* Dividers (docs/40 §4). */
  .divider { display: flex; align-items: center; gap: 10px; margin: 10px 0 4px; font-size: 11px; color: var(--muted); letter-spacing: 0.08em; text-transform: uppercase; }
  /* The agent is on it, before its first word (docs/41 §3). Three dots, one row, gone the
     moment prose or a call arrives. */
  .working { display: flex; align-items: center; gap: 8px; margin: 8px 0; color: var(--muted); font-size: 12px; }
  .working .dots span { display: inline-block; width: 5px; height: 5px; margin-right: 3px; border-radius: 50%; background: var(--muted); animation: blink 1.2s infinite; }
  .working .dots span:nth-child(2) { animation-delay: 0.2s; }
  .working .dots span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes blink { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }
  /* A question is a card with the answers as buttons (docs/41 §4): tap one, or type. Kept
     in place with the answer once given, so the thread reads as the exchange it was. */
  .question { border: 1px solid var(--border-strong); background: var(--surface-2, var(--surface)); border-radius: var(--radius-card); padding: 14px 16px; margin: 10px 0; display: flex; flex-direction: column; gap: 10px; }
  .question .qtitle { font-weight: 600; font-size: 0.95rem; }
  .question .qopt { display: flex; align-items: center; gap: 10px; text-align: left; width: 100%; padding: 9px 12px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); color: var(--text); font: inherit; cursor: pointer; }
  .question .qopt:hover:not(:disabled) { border-color: var(--border-strong); background: var(--surface-2, var(--surface)); }
  .question .qopt:disabled { cursor: default; opacity: 0.6; }
  .question .qopt.chosen { border-color: var(--accent); opacity: 1; }
  .question .qkey { flex: none; width: 22px; height: 22px; border-radius: 6px; background: var(--border); display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; color: var(--text-soft); }
  .question .qfree { display: flex; gap: 8px; }
  .question .qfree input { flex: 1; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); color: var(--text); font: inherit; }
  .question .qdone { font-size: 12px; color: var(--text-soft); }
  .divider::before, .divider::after { content: "\200b"; flex: 1; border-top: 1px solid var(--border); }
  .divider.new { color: var(--accent); }
  .divider.new::before, .divider.new::after { border-color: var(--accent-soft); }
  #jumplatest { position: absolute; bottom: 110px; left: 50%; transform: translateX(-50%); display: none; z-index: 5; }
  #middle { position: relative; }
  #sharemenu { position: absolute; right: 0; top: 26px; background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-md); box-shadow: var(--shadow-pop); padding: 4px; display: none; z-index: 20; min-width: 180px; }
  #sharemenu a { display: block; padding: 6px 10px; font-size: 12px; text-decoration: none; color: var(--text); border-radius: 6px; }
  #sharemenu a:hover { background: var(--surface-hover); }
  .msg .who {
    font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted);
    margin-bottom: 5px;
  }
  /* The agent's prose reads in the serif; everything operational stays in sans/mono. */
  .msg .body { max-width: 680px; font-family: var(--font-serif); font-size: 1rem; line-height: 1.68; color: var(--text); }
  .msg.user { align-self: flex-end; max-width: 560px; }
  .msg.user .who { text-align: right; }
  .msg.user .body {
    font-family: var(--font-sans); font-size: 0.92rem; line-height: 1.6;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-card); padding: 12px 15px;
  }
  /* The trace as a tree.
     A round is a node: what the agent said it was about to do, with the calls it made
     nested under it. The nesting is drawn, not implied — children are indented and hang
     off a guide line, so six fetches visibly belong to the sentence above them. Folding
     the node takes its children with it, which is what folding means in a tree and is
     what the previous version failed to do. The answer is not a node: no indent, no
     rule, full serif, so one scan down the left edge finds it. */
  details.step {
    margin: 3px 0; border-left: 2px solid var(--border); padding-left: 0;
    max-width: 700px;
  }
  details.step > summary {
    cursor: pointer; list-style: none; padding: 4px 9px 4px 6px; margin-left: -2px;
    border-left: 2px solid transparent; border-radius: 0 var(--radius-input) var(--radius-input) 0;
    font-family: var(--font-sans); font-size: 12px; line-height: 1.45;
    color: var(--text-soft); user-select: none;
    display: flex; align-items: baseline; gap: 6px;
  }
  details.step > summary::-webkit-details-marker { display: none; }
  /* The chevron sits in its own tinted well, so the row reads as a control rather than
     as a line of text that happens to be grey. Without it nobody guessed it could fold. */
  details.step > summary::before {
    content: "\25b8"; flex: none; width: 14px; height: 14px; line-height: 14px;
    text-align: center; font-size: 8px; color: var(--muted);
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: 3px; transition: transform 0.12s ease;
  }
  details.step[open] > summary::before { content: "\25be"; }
  details.step > summary:hover {
    color: var(--text); background: var(--surface-hover); border-left-color: var(--accent);
  }
  details.step > summary:hover::before { color: var(--text); border-color: var(--border-strong); }
  /* How many calls are inside, so a folded step still says how much it did. */
  details.step > summary .cnt { flex: none; margin-left: auto; color: var(--muted); font-size: 10px; }
  details.step > summary .lbl { font-weight: 500; }
  /* The children. The left padding is the indent; the parent's border is the guide. */
  details.step > .kids { padding: 1px 0 3px 18px; }
  /* Whatever the agent said beyond the one line in the summary. */
  /* Same size as a reply, muted only: this text was a reply until a tool call revealed it
     as narration, and shrinking it at that moment read as the page changing its mind. */
  details.step .saidfull {
    font-family: var(--font-sans); line-height: 1.5;
    color: var(--muted); margin: 0 0 5px;
  }
  details.step .saidfull p { margin: 0 0 4px; }
  /* Tool rows inside a round are quieter than they are on their own, because the round
     already says what this group of them was for. */
  details.step details.tool { font-size: 11.5px; }
  /* The group: one turn's steps, with one control over all of them. */
  .steps {
    margin: 6px 0; padding: 5px 0 4px; max-width: 700px;
    border-top: 1px solid var(--border);
  }
  .steps > .foldgroup {
    display: inline-block; margin-bottom: 2px;
    font-family: var(--font-sans); font-size: 10.5px; letter-spacing: 0.04em;
    color: var(--muted); text-decoration: none; cursor: pointer;
  }
  .steps > .foldgroup:hover { color: var(--text); }
  /* A shut group is one line, not eleven collapsed ones. The control said "hide 11
     steps" while leaving eleven rows on screen, which is the kind of label that makes
     a reader distrust the rest of the page. */
  .steps.shut > details.step { display: none; }
  .steps.shut { border-bottom: 1px solid var(--border); }
  #foldall {
    font-size: 11px; letter-spacing: 0.04em; color: var(--muted);
    cursor: pointer; text-decoration: none; flex: none;
  }
  #foldall:hover { color: var(--text); }
  .msg .body > :first-child { margin-top: 0; }
  .msg .body > :last-child { margin-bottom: 0; }
  .msg .body p { margin: 0 0 8px; }
  .msg .body h1, .msg .body h2, .msg .body h3,
  .msg .body h4, .msg .body h5, .msg .body h6 {
    margin: 14px 0 6px; font-size: 1rem; line-height: 1.3; font-family: var(--font-sans); font-weight: 600;
  }
  .msg .body h1 { font-size: 1.15rem; }
  .msg .body h2 { font-size: 1.05rem; }
  .msg .body ul, .msg .body ol { margin: 4px 0 8px; padding-left: 22px; }
  .msg .body li { margin: 2px 0; }
  .msg .body a { color: var(--accent-2); }
  .msg .body code {
    font-family: var(--font-mono); font-size: 12.5px; line-height: 1.5;
    background: var(--code-bg); color: var(--code-text);
    border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px;
  }
  .msg .body pre {
    margin: 8px 0; padding: 11px 13px; background: var(--code-bg); border: 1px solid var(--border);
    /* Scroll long lines rather than wrapping them: wrapped code misreads. */
    border-radius: var(--radius-md); overflow-x: auto; word-break: normal;
    font-family: var(--font-mono);
  }
  .msg .body pre code { background: none; border: 0; padding: 0; }
  .msg .body blockquote {
    margin: 6px 0; padding: 2px 0 2px 12px; border-left: 2px solid var(--border-strong); color: var(--muted);
  }
  .msg .body hr { border: 0; border-top: 1px solid var(--border); margin: 12px 0; }
  /* Full width and wrapping cells, rather than a scrolling block: these tables are
     mostly long prose in two columns, and wrapping keeps all of it on screen. */
  .msg .body table {
    border-collapse: collapse; margin: 8px 0; width: 100%;
    font-family: var(--font-sans); font-size: 13px;
  }
  .msg .body th, .msg .body td {
    border: 1px solid var(--border); padding: 5px 8px; text-align: left; vertical-align: top;
  }
  .msg .body th { background: var(--surface-2); font-weight: 600; }

  /* Tool calls collapse to one line: tool name · argument summary. A turn can make
     dozens, each result can be pages long, and shown in full the conversation becomes
     a log with the reasoning buried in it. The rest is one click in. */
  details.tool {
    max-width: 680px; margin: 2px 0; border: 1px solid var(--border); border-radius: var(--radius-input);
    background: var(--surface); overflow: hidden;
    font-family: var(--font-mono); font-size: 12px; color: var(--text-soft);
  }
  details.tool > summary {
    cursor: pointer; list-style: none; padding: 8px 12px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    transition: background var(--dur) var(--ease);
  }
  details.tool > summary::-webkit-details-marker { display: none; }
  details.tool > summary::before { content: "\25b8"; color: var(--muted); margin-right: 8px; }
  details.tool[open] > summary::before { content: "\25be"; }
  details.tool > summary:hover { background: var(--surface-hover); }
  details.tool .nm { color: var(--accent-2); }
  details.tool .det {
    white-space: pre-wrap; word-break: break-word; color: var(--code-text);
    background: var(--code-bg); border-top: 1px solid var(--border);
    padding: 10px 13px; line-height: 1.6;
  }
  details.tool.err { border-color: var(--danger); }
  details.tool.err > summary, details.tool.err .det { color: var(--danger); }
  details.tool .shot {
    display: block; max-width: 100%; margin: 0;
    border-top: 1px solid var(--border);
  }
  /* A teammate message is a notification with a hairline, not a bubble: who and which
     direction on the line, the text itself one click in. */
  details.note {
    max-width: 680px; margin: 6px 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
    font-size: 0.92rem; color: var(--text-soft);
  }
  details.note > summary { cursor: pointer; list-style: none; padding: 8px 2px; }
  details.note > summary::-webkit-details-marker { display: none; }
  details.note .peerdot {
    display: inline-block; width: 6px; height: 6px; border-radius: var(--radius-pill);
    margin-right: 9px; vertical-align: middle; background: var(--muted);
  }
  details.note .chip { font-weight: 600; color: var(--text); }
  details.note .det {
    white-space: pre-wrap; word-break: break-word; color: var(--text-soft);
    font-size: 13px; padding: 0 2px 10px 15px;
  }

  /* ── composer ─────────────────────────────────────────────────────────────── */
  #form { flex: none; display: flex; flex-direction: column; gap: 8px; padding: 12px 18px 14px; border-top: 1px solid var(--border); position: relative; }
  #form .inputrow { display: flex; gap: 10px; align-items: flex-end; }
  textarea {
    flex: 1; resize: none; height: 58px; padding: 11px 13px; border-radius: var(--radius-input);
    border: 1px solid var(--border-strong); background: var(--surface); color: var(--text); font: inherit;
    transition: border-color var(--dur) var(--ease);
  }
  textarea::placeholder { color: var(--muted); }
  textarea:focus { outline: 0; border-color: var(--accent); }
  .hintrow { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); }
  .hintrow .mono { font-size: 11px; }
  #slashmenu {
    position: absolute; bottom: 100%; left: 18px; right: 18px; margin-bottom: 4px;
    background: var(--surface); border: 1px solid var(--border-strong);
    border-radius: var(--radius-md); box-shadow: var(--shadow-pop);
    max-height: 200px; overflow: auto; z-index: 5;
  }
  #slashmenu .row { padding: 7px 11px; cursor: pointer; }
  #slashmenu .row:hover, #slashmenu .row.on { background: var(--accent-soft); }
  #slashmenu b { font-size: 0.92rem; }

  /* The thread panel: a list, because a native select cannot paginate, filter, or
     survive fifty threads. Anchored under its button in the pane header. */
  #convpanel {
    position: absolute; top: 100%; left: 0; margin-top: 4px; width: 360px;
    background: var(--surface); border: 1px solid var(--border-strong);
    border-radius: var(--radius-md); box-shadow: var(--shadow-pop);
    z-index: 6; padding: 6px;
  }
  #convfilter {
    width: 100%; box-sizing: border-box; height: 28px; margin-bottom: 6px;
    border: 1px solid var(--border-strong); border-radius: var(--radius-input);
    background: var(--bg); color: var(--text); font: inherit; font-size: 12px; padding: 0 8px;
  }
  #convfilter:focus { outline: 0; border-color: var(--accent); }
  #convlist { max-height: 300px; overflow: auto; }
  #convpanel .row { padding: 6px 8px; cursor: pointer; border-radius: var(--radius-input); font-size: 12px; display: block; text-decoration: none; color: var(--text); }
  #convpanel .row:hover { background: var(--accent-soft); }
  #convpanel .row.on { background: var(--accent-soft); }
  #convpanel .row .who { font-weight: 600; }
  #convpanel .row .when { color: var(--muted); float: right; }
  #convpanel .row .what { color: var(--text); display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* ── right pane: what is happening now ────────────────────────────────────── */
  .tab {
    padding: 4px 12px; border-radius: var(--radius-pill); text-decoration: none;
    font-size: 12px; color: var(--muted); transition: background var(--dur) var(--ease);
  }
  .tab:hover { text-decoration: none; background: var(--surface-hover); }
  .tab.on { background: var(--accent-soft); color: var(--accent); }
  #desktoptitle { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* Always rendered, never dismissible: docs/18 §3.1. A shared box is warn-toned because
     what it says changes what a person should be willing to type; a private one is quiet
     because it is only stating the ordinary case. */
  .boxclass {
    font-size: 11px; padding: 2px 8px; border-radius: var(--radius-pill);
    white-space: nowrap; flex: 0 1 auto; min-width: 0; overflow: hidden;
    text-overflow: ellipsis; cursor: default;
  }
  .boxclass.shared { background: var(--warn-soft); color: var(--warn); border: 1px solid var(--warn-border); }
  .boxclass.private { background: var(--surface-hover); color: var(--muted); }
  #boxnotice {
    font-size: 12px; line-height: 1.5; color: var(--warn);
    background: var(--warn-soft); border: 1px solid var(--warn-border);
    border-radius: var(--radius-md); padding: 7px 11px; margin: 0 16px 8px;
  }
  .paneheader a { font-size: 12px; }
  a#rec.on { color: var(--danger); }

  .desktopwrap { flex: none; padding: 14px 16px 10px; }
  iframe {
    width: 100%; border: 1px solid var(--border-strong); border-radius: var(--radius-md);
    background: #000; aspect-ratio: 16/10; display: block;
  }
  /* The desktop keeps its size no matter how long the activity feed gets. */
  #vnc { min-height: 240px; }
  .bar { flex: none; padding: 7px 16px; color: var(--muted); font-size: 12px; }
  .bar b { color: var(--text-soft); font-weight: 500; }
  #recordings a { margin-right: 10px; }
  /* One line, because it sits between the desktop and the activity feed. */
  #clipbar { display: flex; gap: 6px; align-items: center; }
  #clipbar b { font-family: var(--font-mono); font-size: 11px; }
  #clipbar input {
    flex: 1; min-width: 0; padding: 4px 9px; border-radius: var(--radius-input);
    border: 1px solid var(--border-strong); background: var(--surface); color: var(--text);
    font-family: var(--font-mono); font-size: 12px;
  }
  #clipbar input:focus { outline: 0; border-color: var(--accent); }
  .bar.note { line-height: 1.6; padding-bottom: 10px; }

  .activityhead { border-top: 1px solid var(--border); padding-top: 12px; }
  .feed { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 0 8px; }
  .ev {
    padding: 4px 16px; font-size: 12px; line-height: 1.55; color: var(--muted);
    border-top: 1px solid var(--border);
  }
  .ev:first-child { border-top: 0; }
  .ev b { color: var(--text-soft); font-weight: 600; }
  .ev .t { font-family: var(--font-mono); color: var(--muted); margin-right: 4px; }
  .ev.mail { color: var(--success); }
  .ev.err { color: var(--danger); }
  .ev.warn { color: var(--warn); }

  /* ── files ────────────────────────────────────────────────────────────────── */
  /* A column, said in CSS because showTab() only sets display:flex — without this the
     toolbar and the split laid out side by side and the file list was a squeezed strip. */
  #filesview { flex-direction: column; }
  #filespreview pre { white-space: pre-wrap; word-break: break-word; margin: 0; padding: 10px 14px; font-family: var(--font-mono); font-size: 12px; }
  #filespreview img, #filespreview video { max-width: 100%; display: block; }
  #fileslist .row { padding: 6px 12px; cursor: pointer; font-size: 13px; }
  #fileslist .row:hover { background: var(--surface-hover); }
  #fileslist .row.on { background: var(--accent-soft); }
  #filesview.dropping { outline: 2px dashed var(--accent); outline-offset: -4px; }
  #filesbar { display: flex; justify-content: space-between; gap: 8px; border-bottom: 1px solid var(--border); }
  #filesbar b { font-family: var(--font-mono); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #filesbar .plain a, #filesbar .plain label { margin-left: 10px; color: var(--accent-2); cursor: pointer; }
</style>
</head>
<body>

<header id="topbar">
  <span class="brand">
    <svg width="20" height="20" viewBox="0 0 128 128" aria-hidden="true"><rect x="4" y="4" width="120" height="120" rx="30" fill="#231a13"/><path d="M64 32 96 49 64 66 32 49Z" fill="#d9634a"/><path d="M32 49 64 66v32L32 81Z" fill="#d9634a" fill-opacity=".62"/><path d="M96 49 64 66v32l32-17Z" fill="#d9634a" fill-opacity=".34"/></svg>
    LumenBox
  </span>
  <span class="mid"><span id="model">&mdash;</span></span>
  <!-- A control, so it is reachable by keyboard and announced as one. It was a span that
       opened nothing; now it opens something, and a clickable span nothing can find is a
       defect whether or not anyone has complained about it yet. -->
  <span id="spendtoday" class="mono" role="button" tabindex="0"
        style="font-size:12px;color:var(--muted);white-space:nowrap"
        title="Tokens spent today, all agents \u2014 open the spend view"></span>
  <span id="whoami" style="font-size:12px;color:var(--muted);white-space:nowrap"></span>
  <button id="guidebtn" class="btn ghost sm" title="The four set-up steps, and where each thing is">Guide</button>
  <button id="settingsbtn" title="Settings" aria-label="Settings">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03Z"/></svg>
  </button>
  <button id="theme" title="Switch theme" aria-label="Switch theme">
    <svg id="themesun" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
    <svg id="thememoon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>
  </button>
</header>

<div id="boxbar" role="tablist" aria-label="Boxes"></div>

<div id="shell">

<div class="pane" id="sidebar">
  <div class="eyebrow-row"><span class="eyebrow">Agents</span><button id="new" class="btn ghost sm" title="New agent">+</button></div>
  <div class="scroll" id="agents"></div>
  <div style="padding:6px 12px 4px"><button id="shelfopen" class="btn sm" style="width:100%;justify-content:space-between;display:flex" title="Templates: saved agents you can stamp into this box"><span>Templates</span><span class="dim">stamp ▸</span></button></div>
  <div id="sidefoot">
    <div class="footrow"><span class="dot" id="boxdot"></span><span id="boxinfo">box</span></div>
    <div id="buildinfo"></div>
  </div>
</div>

<div class="pane" id="middle">
  <div id="setupcard" style="display:none"></div>
  <div class="paneheader">
    <span class="lead">
      <span id="title">&mdash;</span>
      <span id="titlerole" class="dim" style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></span>
      <span id="convwrap" style="position:relative;flex:none">
        <a href="#" id="convbtn" class="btn sm" style="display:none;text-decoration:none;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></a>
        <div id="convpanel" style="display:none">
          <input id="convfilter" placeholder="Filter threads&hellip;" autocomplete="off">
          <div id="convlist"></div>
          <a href="#" id="convmore" class="row dim" style="display:none">Load more&hellip;</a>
        </div>
      </span>
      <a href="#" id="agentcfg" style="font-size:12px;flex:none">Configure</a>
      <a href="#" id="agentdel" style="font-size:12px;flex:none;color:var(--danger)" title="Delete this agent (asks first)">Delete</a>
    </span>
    <span class="headactions" style="position:relative">
      <a href="#" id="sharebtn" title="Copy or download this thread, or its link">share ▾</a>
      <div id="sharemenu">
        <a href="#" data-share="md">Copy as Markdown</a>
        <a href="#" data-share="file">Download .md</a>
        <a href="#" data-share="link">Copy link to this thread</a>
      </div>
      <a href="#" id="foldall" title="Fold or unfold every step in this conversation">fold steps</a>
      <span id="round" class="roundpill"></span>
      <!-- Only shown while a turn is running: a stop button with nothing to stop invites a click
           that does nothing, and then the real one is not trusted. -->
      <button id="stop" class="btn sm" style="display:none">Stop</button>
    </span>
  </div>
  <!-- Ahead of the conversation on purpose. An agent waiting on consent has stopped working, and a
       person who has to scroll to find that out has been kept waiting by the interface. -->
  <div id="approvals" style="display:none"></div>
  <div id="progress" style="display:none">
    <div id="progresshead"></div>
    <div id="progresslist"></div>
  </div>
  <div class="scroll" id="chat"></div>
  <button id="jumplatest" class="btn sm accent" type="button">↓ latest</button>
  <form id="form">
    <!-- Anchored above the composer so it does not cover what is being typed. -->
    <div id="slashmenu" style="display:none"></div>
    <div class="inputrow">
      <textarea id="input" placeholder="Message this agent&hellip;"></textarea>
      <button id="send" class="btn accent">Send</button>
    </div>
    <div class="hintrow"><span>&#9166; send &middot; &#8679;&#9166; newline &middot; / skills</span></div>
  </form>
</div>

<div class="pane" id="rightpane">
  <div class="paneheader">
    <!-- Tabs rather than a third panel: the files view needs the height, and stacking it under a
         150px-tall desktop gave neither enough room to be usable. -->
    <span class="lead">
      <a href="#" id="tabdesktop" class="tab on">Desktop</a>
      <a href="#" id="tabfiles" class="tab">Files</a>
      <a href="#" id="tabtasks" class="tab">Tasks</a>
      <a href="#" id="tabauto" class="tab">Automations</a>
      <span id="desktoptitle"></span>
      <span id="boxclass" class="boxclass" style="display:none"></span>
    </span>
    <span class="headactions">
      <a id="rec" href="#">&#9679; record</a>
      <a id="full" href="#" target="_blank" rel="noopener" class="btn sm" style="text-decoration:none">Take over</a>
    </span>
  </div>
  <div id="desktopview">
    <div id="boxnotice" style="display:none"></div>
    <div class="desktopwrap"><iframe id="vnc" title="box desktop"></iframe></div>
    <div class="bar" id="recordings" style="display:none"></div>
    <div class="bar" id="clipbar">
      <b>clipboard</b>
      <input id="cliptext" placeholder="text to paste into the box" spellcheck="false">
      <button id="clipin" class="btn sm" title="Put this on the box's clipboard, then press Ctrl+V in the desktop">&rarr; box</button>
      <button id="clipout" class="btn sm" title="Read the box's clipboard and copy it here">&larr; box</button>
    </div>
    <div class="bar note">
      Every agent has its own desktop, so they never fight over focus. This shows the
      selected agent's. Click it for keyboard focus, or take it over full size &mdash; you
      can drive one while the others keep working.
    </div>
  </div>

  <!-- The files view. Two columns: what is there, and what is in the selected one. Previewing in
       place is the whole point — a link that opens markdown in a new tab shows raw text, which is
       what the old version did and why it was useless. -->
  <div id="filesview" style="display:none;flex:1;min-height:0;display:none">
    <div class="bar" id="filesbar">
      <b id="filespath">/home/box/work</b>
      <span class="plain">
        <a href="#" id="filesup">up</a>
        <a href="#" id="filesrefresh">refresh</a>
        <label class="dim">add file<input id="filesupload" type="file" multiple style="display:none"></label>
      </span>
    </div>
    <div id="filessplit" style="display:flex;flex:1;min-height:0">
      <div class="scroll" id="fileslist" style="width:44%;border-right:1px solid var(--border)"></div>
      <div class="scroll" id="filespreview" style="flex:1"><div class="dim" style="padding:10px 14px">Select a file.</div></div>
    </div>
  </div>
  <!-- The task board: work as an object the whole team sees. Rows grouped by status;
       creating and moving needs the driver role, same as prompting. -->
  <div id="tasksview" style="display:none;flex:1;min-height:0;flex-direction:column">
    <div class="bar" style="display:flex;gap:8px;align-items:center;border-bottom:1px solid var(--border)">
      <input id="tasknew" placeholder="New task title&hellip;" spellcheck="false" style="flex:1;min-width:0;padding:4px 9px;border-radius:var(--radius-input);border:1px solid var(--border-strong);background:var(--surface);color:var(--text);font:inherit;font-size:13px">
      <select id="taskassign" style="height:28px;border-radius:var(--radius-input);border:1px solid var(--border-strong);background:var(--surface);color:var(--text);font-size:12px"></select>
      <button class="btn sm" id="taskadd">Add</button>
    </div>
    <div class="scroll" id="tasklist"></div>
  </div>
  <!-- What runs without anyone asking. The page a person checks when they want to know
       whether the 06:30 brief is actually armed, when it last fired, and where it
       reports — the three things a cron expression in a file cannot tell them. -->
  <div id="autoview" style="display:none;flex:1;min-height:0;flex-direction:column">
    <div class="bar" style="display:flex;gap:8px;align-items:center;border-bottom:1px solid var(--border)">
      <span class="dim" id="autostate" style="flex:1;font-size:12px"></span>
      <a href="#" id="autorefresh" class="dim" style="font-size:12px">refresh</a>
    </div>
    <div class="scroll" id="autolist"></div>
  </div>
  <div class="eyebrow-row activityhead"><span class="eyebrow">Activity &mdash; all agents</span></div>
  <div class="feed" id="feed"></div>
</div>

</div>

<!-- Where the month went. A different question from the rest of this page, which answers
     "what is this agent doing now" — so a different surface, admin only, reached from the
     one number that was already in the header and did not open anything. -->
<div id="spendwrap" style="display:none">
  <div class="modal">
    <h3>Spend</h3>
    <div class="spendgrid">
      <div>
        <div style="font-size:10.5px;letter-spacing:0.06em;text-transform:uppercase;color:var(--muted);padding:0 6px 4px">Day &middot; out</div>
        <div class="daylist" id="spenddays"></div>
      </div>
      <div>
        <div id="spendhead" class="caveat" style="margin-bottom:10px"></div>
        <div id="spendbody"></div>
      </div>
    </div>
    <div id="spendcaveat" class="caveat"></div>
    <div class="actions"><button id="spendclose" class="btn ghost sm">Close</button></div>
  </div>
</div>

<!-- Settings. What is here is exactly what the config file holds: the provider choice
     the launch command used to carry, its model override, and the key. -->
<div id="settingswrap" style="display:none">
  <div class="modal">
    <h3>Settings</h3>
    <div id="settabs" class="tabs" style="display:flex;gap:6px;flex-wrap:wrap">
      <a href="#" class="tab on" data-settab="model">Model</a>
      <a href="#" class="tab" data-settab="boxes">Boxes</a>
      <a href="#" class="tab" data-settab="doors">Doors</a>
      <a href="#" class="tab" data-settab="team">Team</a>
      <a href="#" class="tab" data-settab="mine">Mine</a>
    </div>
    <div class="fieldnote" id="setwelcome" style="display:none;border:1px solid var(--border);border-radius:var(--radius-md);padding:10px 12px;color:var(--text-soft)">
      Welcome. LumenBox needs two things before agents can work: a model provider with a
      key, and the box &mdash; one Linux container with a desktop, a browser and a shell,
      running on this machine. Both are set up here.
    </div>
    <div class="field" data-tier="installation" data-settab="model">
      <label>Provider</label>
      <select id="setprovider"></select>
    </div>
    <div class="field" data-tier="installation" data-settab="model">
      <label>Model</label>
      <input id="setmodel" list="modellist" placeholder="preset default" spellcheck="false">
      <datalist id="modellist"></datalist>
    </div>
    <div class="field" data-tier="installation" id="setbasewrap" style="display:none" data-settab="model">
      <label>Base URL</label>
      <input id="setbase" placeholder="https://&hellip;" spellcheck="false">
    </div>
    <div class="field" data-tier="installation" data-settab="model">
      <label>API key</label>
      <input id="setkey" type="password" spellcheck="false" autocomplete="off">
      <div class="fieldnote" id="setkeynote"></div>
    </div>
    <div class="fieldnote">Saved to ~/.agentbox/config.json on this machine, mode 0600. A key stored
      here is used only when the environment does not already provide one, and is never placed
      inside the box. Changes take effect when the server restarts.</div>
    <div class="field" data-tier="installation" id="setboxwrap" data-settab="boxes">
      <label>Box</label>
      <div class="fieldnote" id="setboxstate" style="margin:0"></div>
      <div id="setboxactions" style="display:none">
        <button class="btn sm" id="setboxup">Start the box</button>
      </div>
      <pre id="setboxlog" style="display:none;max-height:140px;overflow:auto;background:var(--code-bg);color:var(--code-text);border:1px solid var(--border);border-radius:var(--radius-md);padding:10px 12px;font-family:var(--font-mono);font-size:11px;line-height:1.6;margin:0;white-space:pre-wrap"></pre>
    </div>
    <div class="field" data-tier="installation" id="setboxeswrap" data-settab="boxes">
      <label>Boxes</label>
      <div id="setboxes" style="display:flex;flex-direction:column;gap:6px"></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:4px">
        <input id="setboxname" placeholder="name, e.g. grok" spellcheck="false" style="flex:0.7;min-width:90px;font-family:var(--font-sans)">
        <input id="setboxurl" placeholder="http://127.0.0.1:13370" spellcheck="false" style="flex:1.4;min-width:160px">
        <input id="setboxtoken" type="password" placeholder="its BOXD_TOKEN" spellcheck="false" autocomplete="off" style="flex:1;min-width:120px">
        <input id="setboxfloor" placeholder="first display, e.g. 10" spellcheck="false" style="flex:0.7;min-width:110px">
        <button class="btn sm" id="setboxattach">Attach</button>
      </div>
      <div class="fieldnote">Every machine this installation drives. The first is this machine's
        own; an attached one is somebody else's boxd reached over a tunnel, with its own desktops
        from the display you name. An agent is created into a box and stays there.</div>
      <div class="fieldnote" id="setboxesstatus"></div>
    </div>
    <div class="field" data-tier="installation" data-settab="boxes">
      <label>Host execution</label>
      <label class="radio"><input type="checkbox" id="sethostenabled">
        Let agents run commands on this computer, outside the box</label>
      <input id="sethostcwd" placeholder="Working directory, e.g. /Users/you/projects" spellcheck="false">
      <div class="fieldnote">Off by default, and the one door through the box's wall — the way an
        agent reaches a USB device, an AppleScript, or a CLI tool on the host like <code>pi</code>,
        <code>claude</code> or <code>git</code>. Every host command still stops for your approval
        before it runs. Takes effect after a restart.</div>
      <div class="fieldnote" id="sethoststatus"></div>
    </div>
    <div class="field" data-tier="installation" data-settab="boxes">
      <label>Startup item</label>
      <label class="radio"><input type="checkbox" id="setstartupitem">
        Launch LumenBox automatically on system login (Startup Item)</label>
      <div class="fieldnote">Registers LumenBox as a login item so agents, desktop services, and chat channels are running after a computer restart. Applied by the app when it restarts the server.</div>
    </div>
    <div class="field" data-tier="organisation" data-settab="team">
      <label>Scopes</label>
      <div id="setscopes" style="display:flex;flex-direction:column;gap:6px"></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input id="setscopename" placeholder="Scope name, e.g. vendor-work" spellcheck="false" style="flex:1;min-width:120px;font-family:var(--font-sans)">
        <button class="btn sm" id="setscopeadd">Add</button>
      </div>
      <div class="fieldnote">A scope is a named authority bundle — a tool set and the secrets it
        grants — that agents are placed into (in the agent's Configure dialog). Adding a secret to a
        scope grants it to every agent in the scope; removing an agent from the scope revokes it.</div>
      <div class="fieldnote" id="setscopestatus"></div>
    </div>
    <div class="field" data-tier="organisation" data-settab="team">
      <label>Secrets</label>
      <div id="setsecrets" style="display:flex;flex-direction:column;gap:6px"></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input id="setsecid" placeholder="GITHUB_TOKEN" spellcheck="false" style="flex:1;min-width:110px">
        <input id="setsecval" type="password" placeholder="value" spellcheck="false" autocomplete="off" style="flex:1;min-width:110px">
        <input id="setsecgrant" placeholder="* or agent:id or principal:id" spellcheck="false" style="flex:1.3;min-width:130px;font-family:var(--font-sans);font-size:12px">
        <button class="btn sm" id="setsecadd">Add</button>
      </div>
      <div class="fieldnote">A credential, given to who may use it. It is delivered only through
        a host command (RunOnHost) — placed in that one command's environment on your machine,
        never written into the box. The agent uses it by name and never sees the value. Every use
        is audited in ~/.agentbox/vault-audit.jsonl.</div>
      <div class="fieldnote" id="setsecstatus"></div>
    </div>
    <div class="field" data-tier="installation" data-settab="doors">
      <label>Channels</label>
      <div id="setchannels" style="display:flex;flex-direction:column;gap:6px"></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <select id="setchtype" style="height:38px;border-radius:var(--radius-input);border:1px solid var(--border-strong);background:var(--bg);color:var(--text);padding:0 8px">
          <option value="feishu" selected>feishu</option>
          <option value="dingtalk">dingtalk</option>
        </select>
        <input id="setchid" placeholder="feishu-work" spellcheck="false" style="flex:1;min-width:90px">
        <input id="setchname" placeholder="显示名" spellcheck="false" style="flex:1;min-width:70px">
        <select id="setchagent" style="height:38px;border-radius:var(--radius-input);border:1px solid var(--border-strong);background:var(--bg);color:var(--text);padding:0 8px"></select>
        <input id="setchappid" placeholder="App/Client ID" spellcheck="false" style="flex:1;min-width:90px">
        <input id="setchsecret" type="password" placeholder="Secret" spellcheck="false" autocomplete="off" style="flex:1;min-width:90px">
        <button class="btn sm" id="setchadd">Add door</button>
      </div>
      <div class="fieldnote">Each row is a door: a bot on a wire, opening into this box. A channel
        turns on when its credentials are present (in the environment, or saved here into the
        config's env map under &lt;ID&gt;_APP_ID + _APP_SECRET). The id becomes the prefix of every
        identity the door mints and is chosen once (lowercase letters, digits, hyphens); the
        display name and the default agent — who answers when a message names nobody — change
        freely and apply at once. Second doors: Feishu and DingTalk (Telegram still needs its
        prefix work); with credentials in hand a new door opens immediately, no restart.</div>
      <div class="fieldnote" id="setchstatus"></div>
    </div>
    <div class="field" data-tier="installation" id="setmcpwrap" style="display:none" data-settab="team">
      <label>MCP servers</label>
      <div id="setmcp" style="display:flex;flex-direction:column;gap:6px"></div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
        <button type="button" class="ghost" id="setmcpreload">Reload from config</button>
        <span class="dim" id="setmcpreloaded" style="font-size:12px"></span>
      </div>
      <div id="setext" class="dim" style="font-size:12px;margin-top:8px"></div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
        <button type="button" class="ghost" id="setextreload">Reload extensions</button>
        <span class="dim" id="setextreloaded" style="font-size:12px"></span>
      </div>
      <div class="fieldnote">Tools other people wrote. Configured in mcpServers in
        ~/.agentbox/config.json — a stdio server is a process on this machine, so an operator
        adds one, never an agent. Their tools obey the same agent tool lists, scopes and
        approvals as the built-in ones. Edit the file, then reload: servers whose entry is
        unchanged keep running, changed or removed ones stop, new ones start.</div>
    </div>
    <div class="field" data-tier="organisation" id="setknockswrap" style="display:none" data-settab="doors">
      <label>Waiting at the door</label>
      <div id="setknocks" style="display:flex;flex-direction:column;gap:6px"></div>
      <div class="fieldnote">People who messaged the bot and are not on the list yet. One click
        lets them in, and they are told so on the channel they knocked from.</div>
    </div>
    <div class="field" data-tier="organisation" data-settab="team">
      <label>People</label>
      <div id="setpeople" style="display:flex;flex-direction:column;gap:6px"></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <select id="setinvrole" style="height:38px;border-radius:var(--radius-input);border:1px solid var(--border-strong);background:var(--bg);color:var(--text);padding:0 8px">
          <option value="driver" selected>driver</option>
          <option value="viewer">viewer</option>
          <option value="admin">admin</option>
        </select>
        <button class="btn sm" id="setinvite">New invite code</button>
        <span id="setinviteout" class="mono" style="font-size:12px"></span>
      </div>
      <div class="fieldnote">An invite code works once, for 15 minutes: the person sends
        <span class="mono">bind CODE</span> to the bot on any channel and they are in — no ids
        to copy. viewer reads, driver commands the agents, admin also changes settings; changing
        a role below applies to the next message, no restart.</div>
      <details style="margin-top:2px">
        <summary class="fieldnote" style="cursor:pointer;margin:0">Add by id manually…</summary>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px">
          <input id="setpname" placeholder="Name" spellcheck="false" style="flex:1;min-width:90px;font-family:var(--font-sans)">
          <input id="setpid" placeholder="telegram:123456" spellcheck="false" style="flex:1.4;min-width:120px">
          <select id="setprole" style="height:38px;border-radius:var(--radius-input);border:1px solid var(--border-strong);background:var(--bg);color:var(--text);padding:0 8px">
            <option value="viewer">viewer</option>
            <option value="driver" selected>driver</option>
            <option value="admin">admin</option>
          </select>
          <button class="btn sm" id="setpadd">Add</button>
        </div>
      </details>
      <div class="fieldnote" id="setpeoplestatus"></div>
    </div>
    <div class="field" data-tier="personal" id="setmcptokenswrap" style="display:none" data-settab="mine">
      <label>Your MCP tokens</label>
      <div id="setmcptokens" style="display:flex;flex-direction:column;gap:6px"></div>
      <div style="display:flex;gap:6px;margin-top:6px">
        <input id="setmcplabel" placeholder="what it is for, e.g. my editor" style="flex:1">
        <button class="btn" id="setmcpadd">Issue</button>
      </div>
      <div class="fieldnote" id="setmcpnew" style="word-break:break-all"></div>
      <div class="fieldnote">Lets an editor or another agent drive this installation over MCP,
        as you. The token is shown once — copy it now. Work done through it is attributed to
        you, and revoking one stops it immediately.</div>
    </div>
    <div class="field" data-tier="personal" id="setgrantswrap" style="display:none" data-settab="mine">
      <label>Standing approvals</label>
      <div id="setgrants" style="display:flex;flex-direction:column;gap:6px"></div>
      <div class="fieldnote">Each covers one exact action until revoked. Revoking makes the next
        identical action ask again.</div>
    </div>
    <div class="fieldnote" id="setstatus"></div>
    <div class="actions">
      <button class="btn" id="settest">Test connection</button>
      <button class="btn accent" id="setsaverestart">Save &amp; restart</button>
      <button class="btn" id="setsave">Save</button>
      <button class="btn ghost" id="setcancel">Cancel</button>
    </div>
  </div>
</div>

<!-- One dialog for creating and configuring an agent: identity, persona, tool set.
     The old path was window.prompt, which a desktop shell does not implement at all —
     the + button did nothing and said nothing. -->
<!-- The shelf (docs/39 §2): everything a person can stamp into a box, with one verb. -->
<div id="shelfwrap" style="display:none">
  <div class="modal" style="width:680px">
    <h3>Templates</h3>
    <div class="fieldnote">A template is a saved agent: persona, skills, routines, conventions — never history, never people. Stamping one makes a new agent in a box.</div>
    <div class="field"><label>Stamp into</label><select id="shelfbox" style="height:32px;border-radius:var(--radius-input);border:1px solid var(--border-strong);background:var(--bg);color:var(--text);padding:0 8px"></select></div>
    <div id="shelfbody" class="scroll" style="max-height:52vh"></div>
    <div class="fieldnote" id="shelfstatus"></div>
    <div class="actions">
      <button class="btn" id="shelfpaste">Paste or link…</button>
      <button class="btn ghost" id="shelfclose">Close</button>
    </div>
  </div>
</div>

<div id="agentwrap" style="display:none">
  <div class="modal">
    <h3 id="agenttitle">New agent</h3>
    <div class="field" id="agcatalogwrap">
      <label>From catalog</label>
      <div id="agcatalog" class="toolchips"></div>
      <div id="agcatalogpreview" style="display:none;margin-top:8px;padding:10px 12px;border:1px solid var(--border-strong);border-radius:var(--radius-md);background:var(--bg);font-size:12px"></div>
      <div class="fieldnote">Specialists and crews that ship with the install. A specialist fills
        this form; a crew adds its members in one step. Not seeded — adding is a choice.</div>
    </div>
    <div class="field" id="agimportwrap">
      <label>Or import a template</label>
      <textarea id="agimport" rows="3" spellcheck="false" placeholder="Paste a .lumenbox-template.json here" style="font-family:var(--font-mono);font-size:11px"></textarea>
      <div style="display:flex;gap:10px;align-items:center;margin-top:6px">
        <button class="btn sm" id="agimportgo" type="button">Import</button>
        <label class="btn sm ghost" for="agimportfile" style="cursor:pointer">Choose a file…</label>
        <input type="file" id="agimportfile" accept=".json,application/json" style="display:none">
        <span id="agimportname" class="dim" style="font-size:11px"></span>
      </div>
      <div class="fieldnote">A template is another bot's recipe: profile, conventions, skills and paused
        routines. The new bot installs it on its first turn and then asks you for whatever it still needs.
        Nothing in a template can reach your logins or connectors.</div>
    </div>
    <div class="field">
      <label>Name</label>
      <input id="agname" spellcheck="false" style="font-family:var(--font-sans)">
    </div>
    <div class="field">
      <label>Role label</label>
      <input id="agrole" placeholder="e.g. release manager" spellcheck="false" style="font-family:var(--font-sans)">
    </div>
    <div class="field" id="agboxwrap">
      <label>Box</label>
      <select id="agbox" style="font-family:var(--font-sans)"></select>
      <div class="fieldnote">Which machine it lives on. Chosen once: an agent's memory, files and
        logins are its box's, and it never moves &mdash; make another one on the other box instead.</div>
    </div>
    <div class="field">
      <label>Persona</label>
      <textarea id="agpersona" placeholder="What is this agent for? This becomes its system prompt."></textarea>
    </div>
    <div class="field">
      <label>Runtime</label>
      <div style="display:flex;gap:8px">
        <select id="agprovider" style="flex:1"></select>
        <input id="agmodel" placeholder="model (optional)" spellcheck="false" style="flex:1;font-family:var(--font-mono);font-size:12px">
      </div>
      <div class="fieldnote">Which model this agent runs on. Blank uses the installation default —
        set it to run, say, the reviewer on a bigger model than the tidy-up agent. The provider's
        key must be present in the environment.</div>
    </div>
    <div class="field">
      <label>Scope</label>
      <select id="agscope"></select>
      <div class="fieldnote">A scope confers a tool set and secret grants as one named bundle
        (managed in Settings). In a scope, the tools below are set by it and locked here.</div>
    </div>
    <div class="field">
      <label>Tools</label>
      <div id="agtools" class="toolchips"></div>
      <div class="fieldnote">An unchecked tool is withheld — it does not appear in the agent's
        prompt at all. Leaving everything checked means everything, including tools added later.</div>
    </div>
    <div class="field" id="agtemplatewrap" style="display:none">
      <label>Share as template</label>
      <div id="agtemplate" class="fieldnote"></div>
      <div style="display:flex;gap:10px;align-items:center;margin-top:6px">
        <button class="btn sm" id="agshare" type="button">Ask it to draft a template</button>
        <a href="#" id="agdownload" style="display:none;font-size:13px">Download latest</a>
      </div>
      <div class="fieldnote">The bot reads its own memory, skills and routines, leaves out what is
        private, and stages a version. Nothing leaves this box until you download the file.</div>
    </div>
    <div class="field" id="agdanger" style="display:none">
      <label>Delete</label>
      <div id="agdel1"><a href="#" id="agdelete" style="color:var(--danger);font-size:13px">Delete this agent&hellip;</a></div>
      <div id="agdel2" style="display:none;flex-direction:column;gap:8px">
        <label class="radio"><input type="radio" name="agrecords" value="archive" checked>
          Keep its records &mdash; the transcript, memory and plan are archived, restorable by moving them back</label>
        <label class="radio"><input type="radio" name="agrecords" value="delete">
          Delete everything it ever did</label>
        <div style="display:flex;gap:10px;padding-top:2px">
          <button class="btn sm danger" id="agdelconfirm">Delete agent</button>
          <button class="btn sm ghost" id="agdelback">Back</button>
        </div>
      </div>
    </div>
    <div class="fieldnote" id="agstatus"></div>
    <div class="actions">
      <button class="btn accent" id="agsave">Create</button>
      <button class="btn ghost" id="agcancel">Cancel</button>
    </div>
  </div>
</div>

<script src="/vendor/markdown-it.js"></script>
<script>
"use strict";
// Markdown rendering is markdown-it's job, served from node_modules by this server.
// html:false is what keeps model output inert — see src/web/markdown.ts.
var md = window.markdownit ? window.markdownit(${JSON.stringify(MARKDOWN_OPTIONS)}) : null;

// The token, out of the address bar.
//
// It is accepted once as a query parameter to bootstrap the cookie, and the cookie is what every
// later request uses — so by the time this runs it has done its job. Leaving it there put a working
// credential in browser history, in autocomplete, in the title bar of any screenshot, and in the
// referrer of any outbound link. The one that actually happens: you copy the address bar to show a
// colleague an agent's desktop, and hand over control of the box with it.
//
// Only if the page loaded, which means the cookie was set — this runs after the server accepted the
// request. Replacing it before that would lock someone out on the next refresh.
(function stripToken() {
  try {
    var url = new URL(window.location.href);
    if (!url.searchParams.has("token")) return;
    url.searchParams.delete("token");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  } catch (error) {
    // A browser without history.replaceState still works; it just keeps the token visible.
  }
})();

function renderMarkdown(text) {
  var value = String(text == null ? "" : text);
  // If the library did not load, show escaped text rather than nothing. A feed
  // showing raw Markdown is poor; a blank one is useless.
  if (!md) return linkifyWorkPaths("<p>" + esc(value).replace(/\n/g, "<br>") + "</p>");
  // After rendering, not before: markdown-it escapes and structures first, so this is operating on
  // known-safe HTML and cannot be used to inject anything. html:false remains the boundary.
  return linkifyWorkPaths(md.render(value));
}

function $(id) { return document.getElementById(id); }

// ── theme ──────────────────────────────────────────────────────────────────
// The boot script in <head> chose before first paint; this button only mutates.
function showThemeIcon() {
  var dark = document.documentElement.getAttribute("data-theme") === "dark";
  $("themesun").style.display = dark ? "" : "none";
  $("thememoon").style.display = dark ? "none" : "";
}
$("theme").onclick = function () {
  var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("lumen-theme", next); } catch (error) {}
  showThemeIcon();
};
showThemeIcon();

// Under the desktop shell the top bar is also the window title bar.
if (navigator.userAgent.indexOf("Electron") >= 0) {
  document.body.classList.add("electron");
  if (/Macintosh/.test(navigator.userAgent)) document.body.classList.add("electron-mac");
}

// ── settings ───────────────────────────────────────────────────────────────
// The dialog edits the config file the server reads at startup, so a saved change
// needs a restart to act. Under the desktop shell "Save & restart" is seamless — the
// shell relaunches the server; under a bare CLI the page says the process has ended.
var settingsPresets = [];

/** Which settings tab is showing; fields carry data-settab, and those not on the tab are hidden. */
function showSettingsTab(name) {
  var tabs = document.querySelectorAll("#settabs a[data-settab]");
  for (var i = 0; i < tabs.length; i++) tabs[i].className = "tab" + (tabs[i].getAttribute("data-settab") === name ? " on" : "");
  var fields = document.querySelectorAll("#settingswrap .field[data-settab]");
  for (var j = 0; j < fields.length; j++) {
    if (fields[j].getAttribute("data-settab") === name) fields[j].classList.remove("settab-off");
    else fields[j].classList.add("settab-off");
  }
}
document.getElementById("settabs").onclick = function (event) {
  var a = event.target.closest("a[data-settab]");
  if (!a) return;
  event.preventDefault();
  showSettingsTab(a.getAttribute("data-settab"));
};

function openSettings(tab) {
  showSettingsTab(typeof tab === "string" ? tab : "model");
  // Applied on open as well as on load: the dialog is built once and reopened, and
  // whoever is at the browser may have signed in since the page did.
  applyRole();
  fetch("/api/config")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      settingsPresets = data.presets || [];
      var sel = $("setprovider");
      sel.innerHTML = settingsPresets.map(function (p) {
        return '<option value="' + esc(p.name) + '">' + esc(p.label) + " &middot; " + esc(p.model) + "</option>";
      }).join("");
      var chosen = (data.config && data.config.provider) || "";
      if (chosen) sel.value = chosen;
      $("setmodel").value = (data.config && data.config.model) || "";
      $("setbase").value = (data.config && data.config.baseUrl) || "";
      $("setkey").value = "";
      var host = data.hostExec || {};
      $("sethostenabled").checked = !!host.enabled;
      $("sethostcwd").value = host.cwd || "";
      $("sethoststatus").textContent = host.enabled
        ? (host.unavailableReason ? "Enabled, but: " + host.unavailableReason : "Enabled and ready.")
        : "";
      $("setstartupitem").checked = !!(data.config && data.config.startupItem);
      $("setstatus").textContent = "Now running: " + (data.current || "");
      settingsProviderChanged();
      renderStandingGrants();
      renderBoxSection();
      renderChannels();
      renderSecrets();
      renderScopes();
      $("settingswrap").style.display = "flex";
    })
    .catch(function () { feed("could not load settings", "err"); });
}

/** Scopes: named authority bundles. Each row edits its tool set and secret list inline. */
var scopes = [];
var scopeTools = [];

function renderScopes() {
  fetch("/api/scopes")
    .then(function (r) { return r.status === 403 ? null : r.json(); })
    .then(function (data) {
      if (!data) { $("setscopes").innerHTML = ""; return; }
      scopes = data.scopes || [];
      scopeTools = data.allTools || [];
      if (!scopes.length) {
        $("setscopes").innerHTML = '<div class="fieldnote" style="margin:0">No scopes yet. Add one to bundle a tool set and secrets for a project.</div>';
        return;
      }
      $("setscopes").innerHTML = scopes.map(function (s, i) {
        var toolText = s.tools ? s.tools.length + " tools" : "all tools";
        var secText = (s.secretIds || []).length + " secrets";
        return '<div style="border:1px solid var(--border);border-radius:var(--radius-md);padding:8px 10px;display:flex;flex-direction:column;gap:6px">' +
          '<div style="display:flex;gap:8px;align-items:center">' +
            '<span style="flex:1;font-weight:600;font-size:13px">' + esc(s.name) + "</span>" +
            '<span class="dim" style="font-size:11px">' + toolText + " · " + secText + "</span>" +
            '<a href="#" data-scoperm="' + i + '" style="color:var(--danger);font-size:12px">Remove</a>' +
          "</div>" +
          '<div class="toolchips" data-scopetools="' + i + '">' +
            scopeTools.map(function (t) {
              var on = !s.tools || s.tools.indexOf(t) >= 0;
              return '<span class="toolchip' + (on ? " on" : "") + '" data-scopetool="' + esc(t) + '">' + esc(t) + "</span>";
            }).join("") +
          "</div>" +
          '<input data-scopesecrets="' + i + '" value="' + esc((s.secretIds || []).join(", ")) + '" placeholder="secret ids, comma-separated" spellcheck="false" style="padding:4px 8px;border-radius:var(--radius-input);border:1px solid var(--border-strong);background:var(--surface);color:var(--text);font-family:var(--font-mono);font-size:12px">' +
        "</div>";
      }).join("");
    })
    .catch(function () {});
}

function saveScopes() {
  $("setscopestatus").textContent = "Saving…";
  fetch("/api/scopes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scopes: scopes })
  })
    .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || "save failed"); return d; }); })
    .then(function () { $("setscopestatus").textContent = "Saved."; renderScopes(); })
    .catch(function (error) { $("setscopestatus").textContent = error.message; });
}

$("setscopeadd").onclick = function () {
  var name = $("setscopename").value.trim();
  if (!name) return;
  scopes.push({ id: "", name: name, secretIds: [] });
  $("setscopename").value = "";
  saveScopes();
};

document.getElementById("setscopes").addEventListener("click", function (event) {
  var rm = event.target.getAttribute && event.target.getAttribute("data-scoperm");
  if (rm !== null && rm !== undefined) { event.preventDefault(); scopes.splice(Number(rm), 1); saveScopes(); return; }
  var chip = event.target.closest && event.target.closest("[data-scopetool]");
  if (chip) {
    var wrap = chip.closest("[data-scopetools]");
    var idx = Number(wrap.getAttribute("data-scopetools"));
    var tool = chip.getAttribute("data-scopetool");
    var scope = scopes[idx];
    if (!scope.tools) scope.tools = scopeTools.slice(); // was "all"; materialize before removing one
    var at = scope.tools.indexOf(tool);
    if (at >= 0) scope.tools.splice(at, 1); else scope.tools.push(tool);
    chip.className = "toolchip" + (scope.tools.indexOf(tool) >= 0 ? " on" : "");
  }
});

document.getElementById("setscopes").addEventListener("change", function (event) {
  var sec = event.target.getAttribute && event.target.getAttribute("data-scopesecrets");
  if (sec === null || sec === undefined) return;
  scopes[Number(sec)].secretIds = event.target.value.split(",").map(function (x) { return x.trim(); }).filter(Boolean);
  saveScopes();
});

/** The vault secrets: names, descriptions and grants, never values. */
var secrets = [];

function renderSecrets() {
  fetch("/api/vault")
    .then(function (r) {
      if (r.status === 403) { $("setsecrets").innerHTML = ""; return null; }
      return r.json();
    })
    .then(function (data) {
      if (!data) return;
      secrets = data.secrets || [];
      if (!secrets.length) {
        $("setsecrets").innerHTML = '<div class="fieldnote" style="margin:0">No secrets yet. Add one to give an agent a credential for a host command.</div>';
        return;
      }
      $("setsecrets").innerHTML = secrets.map(function (s, i) {
        var who = (s.grants || []).map(function (g) { return g.holder + (g.expiresAt ? " (until " + g.expiresAt.slice(0,10) + ")" : ""); }).join(", ") || "nobody yet";
        return '<div style="display:flex;gap:8px;align-items:center;font-size:13px">' +
          '<span class="mono" style="min-width:110px;font-weight:600">' + esc(s.id) + "</span>" +
          '<span class="dim" style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis">' + esc(who) + "</span>" +
          '<a href="#" data-secrm="' + i + '" style="color:var(--danger);font-size:12px">Remove</a></div>';
      }).join("");
    })
    .catch(function () {});
}

$("setsecadd").onclick = function () {
  var id = $("setsecid").value.trim();
  var value = $("setsecval").value;
  var grant = $("setsecgrant").value.trim();
  if (!id || !value) { $("setsecstatus").textContent = "A secret needs a name and a value."; return; }
  $("setsecstatus").textContent = "Saving…";
  fetch("/api/vault", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: id, value: value, grants: grant ? [{ holder: grant }] : [] })
  })
    .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || "save failed"); return d; }); })
    .then(function () { $("setsecid").value = ""; $("setsecval").value = ""; $("setsecgrant").value = ""; $("setsecstatus").textContent = "Saved."; renderSecrets(); })
    .catch(function (error) { $("setsecstatus").textContent = error.message; });
};

document.getElementById("setsecrets").addEventListener("click", function (event) {
  var idx = event.target.getAttribute && event.target.getAttribute("data-secrm");
  if (idx === null || idx === undefined) return;
  event.preventDefault();
  var s = secrets[Number(idx)];
  if (!s) return;
  fetch("/api/vault/remove", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: s.id }) })
    .then(renderSecrets);
});

/** The people list: one row per identity, grouped nowhere — flat and editable. */
var people = [];

function renderMcpTokens(tokens) {
  var mine = (tokens || []).filter(function (t) { return t.mine; });
  $("setmcptokens").innerHTML = mine.length
    ? mine.map(function (t) {
        return '<div style="display:flex;gap:8px;align-items:center;font-size:13px">' +
          '<span style="flex:1">' + esc(t.label) + "</span>" +
          '<span class="dim" style="font-size:11px">' + esc(new Date(t.createdAt).toLocaleDateString()) + "</span>" +
          '<a href="#" data-revoke="' + esc(t.createdAt) + '" style="color:var(--danger);font-size:12px">Revoke</a></div>';
      }).join("")
    : '<div class="fieldnote" style="margin:0">None yet.</div>';
}

$("setmcpadd").onclick = function () {
  fetch("/api/mcp/tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: $("setmcplabel").value })
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      // Shown once, because it is not stored anywhere it could be read back.
      $("setmcpnew").textContent = d.token
        ? "Copy it now, it is not shown again: " + d.token
        : (d.error || "failed");
      $("setmcplabel").value = "";
      renderMcp();
    })
    .catch(function () { $("setmcpnew").textContent = "failed"; });
};

document.getElementById("setmcptokens").addEventListener("click", function (event) {
  var at = event.target.getAttribute && event.target.getAttribute("data-revoke");
  if (!at) return;
  event.preventDefault();
  fetch("/api/mcp/tokens/revoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ createdAt: at })
  }).then(renderMcp);
});

document.getElementById("setextreload").addEventListener("click", function () {
  var note = $("setextreloaded");
  note.textContent = "reloading…";
  fetch("/api/extensions/reload", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (x) {
      if (!x.ok) { note.textContent = x.j.error || "reload failed"; return; }
      note.textContent = "loaded " + (x.j.loaded || []).length + " file(s), " + (x.j.tools || []).length + " tool(s)" +
        ((x.j.problems || []).length ? "; " + x.j.problems.join("; ") : "");
      renderMcp();
    })
    .catch(function () { note.textContent = "reload failed"; });
});

document.getElementById("setmcpreload").addEventListener("click", function () {
  var note = $("setmcpreloaded");
  note.textContent = "reloading…";
  fetch("/api/mcp/reload", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (x) {
      if (!x.ok) { note.textContent = x.j.error || "reload failed"; return; }
      note.textContent = "started " + (x.j.started || []).length + ", stopped " + (x.j.stopped || []).length +
        ", kept " + (x.j.kept || []).length;
      // Servers come up in the background; look again once they have had a moment.
      setTimeout(renderMcp, 1500);
      renderMcp();
    })
    .catch(function () { note.textContent = "reload failed"; });
});

function renderMcp() {
  fetch("/api/mcp")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var servers = data.servers || [];
      renderMcpTokens(data.tokens);
      // An installation matter, so admins only — and admins with none see the empty state
      // and the reload, because "add one to config.json, then reload" is the way in.
      document.getElementById("setmcpwrap").style.display = myRole === "admin" ? "" : "none";
      var ext = data.extensions;
      $("setext").textContent = ext
        ? "Extensions (~/.agentbox/extensions): " + (ext.loaded.length ? ext.loaded.join(", ") : "none") +
          (ext.tools.length ? " — tools: " + ext.tools.join(", ") : "") +
          (ext.problems.length ? " — problems: " + ext.problems.join("; ") : "")
        : "";
      if (!servers.length) {
        $("setmcp").innerHTML = '<div class="dim" style="font-size:13px">none configured</div>';
        return;
      }
      $("setmcp").innerHTML = servers.map(function (s) {
        // A tool count worth noticing is said where the count is, not in a log nobody reads.
        var heavy = s.toolCount > (data.budget || 30);
        return '<div style="display:flex;gap:9px;align-items:center;font-size:13px">' +
          '<span class="dot ' + (s.running ? "ok" : "bad") + '"></span>' +
          '<span style="min-width:80px">' + esc(s.name) + "</span>" +
          '<span class="dim mono" style="flex:1;font-size:11px">' + esc(s.detail) + "</span>" +
          (heavy ? '<span style="font-size:11px;color:var(--warn,#b26b00)">in every prompt</span>' : "") +
        "</div>";
      }).join("");
    })
    .catch(function () {});
}

function renderChannels() {
  renderMcp();
  fetch("/api/channels")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      // One row per door record; the adapter statuses decorate them. A record with
      // no status was added after this process started and opens on the next restart.
      var statuses = {};
      (data.channels || []).forEach(function (ch) { statuses[ch.name] = ch; });
      var agents = data.agents || [];
      var agentOptions = function (selected) {
        return '<option value=""' + (selected ? "" : " selected") + ">(installation default)</option>" +
          agents.map(function (agent) {
            return '<option value="' + esc(agent.name) + '"' +
              (agent.name === selected ? " selected" : "") + ">" + esc(agent.name) + "</option>";
          }).join("");
      };
      $("setchannels").innerHTML = (data.records || []).map(function (rec) {
        var st = statuses[rec.id];
        var cls = st && st.running ? "ok" : st && st.configured ? "bad" : "";
        var detail = st ? st.detail : rec.credentialsSet
          ? "restart to open this door"
          : "set " + rec.envBase + "_APP_ID + _APP_SECRET";
        return '<div style="display:flex;gap:9px;align-items:center;font-size:13px;flex-wrap:wrap">' +
          '<span class="dot ' + cls + '"></span>' +
          '<span style="min-width:70px">' + esc(rec.name) + "</span>" +
          '<span class="dim mono" style="font-size:11px">' + esc(rec.id) + "</span>" +
          '<select data-chagent="' + esc(rec.id) + '" data-chtype="' + esc(rec.type) + '"' +
            ' style="height:26px;font-size:12px;border-radius:6px;border:1px solid var(--border-strong);background:var(--bg);color:var(--text)">' +
            agentOptions(rec.defaultAgent) + "</select>" +
          '<select data-chgroup="' + esc(rec.id) + '" data-chtype="' + esc(rec.type) + '" title="What a group message that names nobody does"' +
            ' style="height:26px;font-size:12px;border-radius:6px;border:1px solid var(--border-strong);background:var(--bg);color:var(--text)">' +
            '<option value="all"' + (rec.groupMessages === "addressed" ? "" : " selected") + '>groups: answer all</option>' +
            '<option value="addressed"' + (rec.groupMessages === "addressed" ? " selected" : "") + '>groups: only when addressed</option>' +
          "</select>" +
          '<span class="dim mono" style="font-size:11px;flex:1;min-width:80px;overflow:hidden;text-overflow:ellipsis">' + esc(detail || "") + "</span>" +
          (rec.grandfathered ? "" :
            '<a href="#" data-chremove="' + esc(rec.id) + '" style="color:var(--danger);font-size:12px">Remove</a>') +
          "</div>";
      }).join("");
      var addSelect = document.getElementById("setchagent");
      if (addSelect) addSelect.innerHTML = agentOptions("");
      // The door: whoever knocked, with the two answers that matter side by side.
      var knocks = data.knocks || [];
      document.getElementById("setknockswrap").style.display = knocks.length ? "" : "none";
      $("setknocks").innerHTML = knocks.map(function (k) {
        return '<div style="display:flex;gap:8px;align-items:center;font-size:13px;flex-wrap:wrap">' +
          '<span style="font-weight:600">' + esc(k.senderLabel) + "</span>" +
          '<span class="dim">' + esc(k.channel) + "</span>" +
          '<span class="mono dim" style="font-size:11px;flex:1;min-width:80px;overflow:hidden;text-overflow:ellipsis">' + esc(k.identity) + "</span>" +
          '<button class="btn sm" data-approve="' + esc(k.identity) + '" data-role="driver">Let in as driver</button>' +
          '<button class="btn sm ghost" data-approve="' + esc(k.identity) + '" data-role="viewer">Viewer</button>' +
          '<a href="#" data-dismiss="' + esc(k.identity) + '" style="color:var(--danger);font-size:12px">Ignore</a></div>';
      }).join("");
      // Flatten to one row per identity, which is what a person edits.
      people = [];
      (data.principals || []).forEach(function (p) {
        (p.identities.length ? p.identities : [""]).forEach(function (identity) {
          people.push({ id: p.id, name: p.name, role: p.role, identity: identity });
        });
      });
      renderPeople();
    })
    .catch(function () {});
}

// A changed default agent routes the next message; nothing to restart.
document.getElementById("setchannels").addEventListener("change", function (event) {
  var target = event.target;
  if (!target.getAttribute) return;
  var groupId = target.getAttribute("data-chgroup");
  if (groupId) {
    fetch("/api/channels/records", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: groupId, type: target.getAttribute("data-chtype"), groupMessages: target.value })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        $("setchstatus").textContent = d.error || (target.value === "addressed"
          ? "Saved — group messages that name nobody are kept as room context, not answered."
          : "Saved — every group message runs a turn.");
      });
    return;
  }
  var id = target.getAttribute("data-chagent");
  if (!id) return;
  fetch("/api/channels/records", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: id, type: target.getAttribute("data-chtype"), defaultAgent: target.value })
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      $("setchstatus").textContent = d.error || "Saved — the next message routes to it.";
    })
    .catch(function () { $("setchstatus").textContent = "failed"; });
});

document.getElementById("setchannels").addEventListener("click", function (event) {
  var target = event.target;
  if (!target.getAttribute) return;
  var id = target.getAttribute("data-chremove");
  if (!id) return;
  event.preventDefault();
  fetch("/api/channels/records/remove", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: id })
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      $("setchstatus").textContent = d.error || "Removed. Its adapter stops on the next restart.";
      renderChannels();
    })
    .catch(function () { $("setchstatus").textContent = "failed"; });
});

$("setchadd").onclick = function () {
  var id = $("setchid").value.trim();
  if (!id) { $("setchstatus").textContent = "The door needs an id — it becomes the identity prefix."; return; }
  $("setchstatus").textContent = "…";
  fetch("/api/channels/records", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: id,
      type: $("setchtype").value,
      name: $("setchname").value,
      defaultAgent: $("setchagent").value,
      appId: $("setchappid").value,
      appSecret: $("setchsecret").value
    })
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.error) { $("setchstatus").textContent = d.error; return; }
      $("setchstatus").textContent = d.started
        ? "Saved — the door is opening now. Its dot goes green when the wire connects."
        : d.restartNeeded
          ? "Saved. Restart the web process to apply the new credentials — and wait a " +
            "minute between stop and start, or Feishu keeps the dead connection."
          : "Saved.";
      $("setchid").value = ""; $("setchname").value = "";
      $("setchappid").value = ""; $("setchsecret").value = "";
      renderChannels();
    })
    .catch(function () { $("setchstatus").textContent = "failed"; });
};

document.getElementById("setknocks").addEventListener("click", function (event) {
  var target = event.target;
  if (!target.getAttribute) return;
  var secretSave = event.target.getAttribute && event.target.getAttribute("data-secret-save");
  if (secretSave) {
    event.preventDefault();
    var field = document.querySelector('[data-secret-input="' + secretSave + '"]');
    var value = field ? field.value : "";
    if (!value) { field && field.focus(); return; }
    fetch("/api/secrets/requests/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: secretSave, value: value }) })
      .then(function () { if (field) field.value = ""; return refreshPolicy(); })
      .catch(function () {});
    return;
  }
  var secretDismiss = event.target.getAttribute && event.target.getAttribute("data-secret-dismiss");
  if (secretDismiss) {
    event.preventDefault();
    fetch("/api/secrets/requests/dismiss", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: secretDismiss }) })
      .then(function () { return refreshPolicy(); }).catch(function () {});
    return;
  }
  var handback = event.target.getAttribute && event.target.getAttribute("data-handback");
  if (handback) {
    event.preventDefault();
    fetch("/api/handover/back", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: handback }) })
      .then(function () { return refreshPolicy(); }).catch(function () {});
    return;
  }
  var approve = target.getAttribute("data-approve");
  if (approve) {
    fetch("/api/channels/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: approve, role: target.getAttribute("data-role") })
    }).then(function () { renderChannels(); });
    return;
  }
  var dismiss = target.getAttribute("data-dismiss");
  if (dismiss) {
    event.preventDefault();
    fetch("/api/channels/dismiss", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: dismiss })
    }).then(function () { renderChannels(); });
  }
});

$("setinvite").onclick = function () {
  $("setinviteout").textContent = "…";
  fetch("/api/channels/invite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: $("setinvrole").value })
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      $("setinviteout").textContent = d.code
        ? 'Have them send: bind ' + d.code + '  (15 min, once)'
        : (d.error || "failed");
    })
    .catch(function () { $("setinviteout").textContent = "failed"; });
};

function renderPeople() {
  if (!people.length) {
    $("setpeople").innerHTML = '<div class="fieldnote" style="margin:0">Nobody yet. Add a person to let them command the agents from a channel.</div>';
    return;
  }
  $("setpeople").innerHTML = people.map(function (p, i) {
    var roles = ["viewer", "driver", "admin"].map(function (role) {
      return '<option value="' + role + '"' + (p.role === role ? " selected" : "") + ">" + role + "</option>";
    }).join("");
    return '<div style="display:flex;gap:8px;align-items:center;font-size:13px">' +
      '<span style="min-width:80px;font-weight:600">' + esc(p.name) + "</span>" +
      '<span class="mono" style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis">' + esc(p.identity) + "</span>" +
      '<select data-role-of="' + i + '" style="height:28px;border-radius:6px;border:1px solid var(--border-strong);background:var(--bg);color:var(--text);padding:0 4px;font-size:12px">' + roles + "</select>" +
      '<a href="#" data-remove="' + i + '" style="color:var(--danger);font-size:12px">Remove</a></div>';
  }).join("");
}

// A role changed in place applies to the person, not the row: the same human's other
// identities move with them, because two roles for one person is a contradiction.
document.getElementById("setpeople").addEventListener("change", function (event) {
  var idx = event.target.getAttribute && event.target.getAttribute("data-role-of");
  if (idx === null || idx === undefined) return;
  var person = people[Number(idx)];
  if (!person) return;
  people.forEach(function (p) { if (p.id === person.id) p.role = event.target.value; });
  renderPeople();
  savePeople();
});

function savePeople() {
  // Regroup rows back into principals by id, so one person's several ids are one entry.
  var byId = {};
  people.forEach(function (p) {
    if (!byId[p.id]) byId[p.id] = { id: p.id, name: p.name, role: p.role, identities: [] };
    if (p.identity) byId[p.id].identities.push(p.identity);
  });
  $("setpeoplestatus").textContent = "Saving…";
  fetch("/api/principals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ principals: Object.keys(byId).map(function (k) { return byId[k]; }) })
  })
    .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || "save failed"); return d; }); })
    .then(function () { $("setpeoplestatus").textContent = "Saved."; renderChannels(); })
    .catch(function (error) { $("setpeoplestatus").textContent = error.message; });
}

$("setpadd").onclick = function () {
  var name = $("setpname").value.trim();
  var identity = $("setpid").value.trim();
  if (!name || !identity) { $("setpeoplestatus").textContent = "A person needs a name and an id."; return; }
  // Same name = same person; reuse their id so several identities group together.
  var existing = people.filter(function (p) { return p.name === name; })[0];
  people.push({ id: existing ? existing.id : identity, name: name, role: $("setprole").value, identity: identity });
  $("setpname").value = ""; $("setpid").value = "";
  renderPeople();
  savePeople();
};

document.getElementById("setpeople").addEventListener("click", function (event) {
  var idx = event.target.getAttribute && event.target.getAttribute("data-remove");
  if (idx === null || idx === undefined) return;
  event.preventDefault();
  people.splice(Number(idx), 1);
  renderPeople();
  savePeople();
});

/** The box list in Settings, with attach and detach. */
function renderBoxes() {
  return fetch("/api/boxes")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var boxes = data.boxes || [];
      $("setboxes").innerHTML = boxes.map(function (b, i) {
        var where = b.kind === "docker" ? "docker on this machine" : esc(b.endpoint || "attached");
        return '<div style="display:flex;gap:8px;align-items:center;font-size:12.5px">' +
          '<span class="dot" style="width:8px;height:8px;background:' + (b.connected ? "var(--ok, #3fb950)" : "var(--warn)") + '"></span>' +
          '<b>' + esc(b.name) + "</b>" + (i === 0 ? ' <span class="dim">(own)</span>' : "") +
          '<span class="dim" style="flex:1">' + where + " · displays from :" + esc(b.displayFloor) + " · " + esc(b.agents) + " agent" + (b.agents === 1 ? "" : "s") + (b.connected ? "" : " · not connected") + "</span>" +
          (i === 0 ? "" : '<button class="btn sm ghost" data-detach-box="' + esc(b.name) + '"' + (b.agents > 0 ? ' disabled title="delete its agents first"' : "") + ">Detach</button>") +
          "</div>";
      }).join("") || '<div class="dim">No boxes.</div>';
    })
    .catch(function () { $("setboxes").innerHTML = '<div class="dim">Could not read the boxes.</div>'; });
}

$("setboxattach").onclick = function () {
  var body = {
    name: $("setboxname").value.trim(),
    baseUrl: $("setboxurl").value.trim(),
    token: $("setboxtoken").value.trim(),
    displayFloor: Number($("setboxfloor").value.trim() || "1")
  };
  if (!body.name || !body.baseUrl || !body.token) { $("setboxesstatus").textContent = "Name, URL and token are all needed."; return; }
  $("setboxattach").disabled = true;
  $("setboxesstatus").textContent = "Attaching…";
  fetch("/api/boxes/attach", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || "attach failed"); return d; }); })
    .then(function (d) {
      $("setboxesstatus").textContent = d.detail || "attached";
      $("setboxtoken").value = "";
      return renderBoxes().then(refresh);
    })
    .catch(function (err) { $("setboxesstatus").textContent = String(err.message || err); })
    .then(function () { $("setboxattach").disabled = false; });
};

$("setboxes").addEventListener("click", function (e) {
  var name = e.target && e.target.getAttribute && e.target.getAttribute("data-detach-box");
  if (!name) return;
  e.target.disabled = true;
  fetch("/api/boxes/detach", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: name }) })
    .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || "detach failed"); return d; }); })
    .then(function () { $("setboxesstatus").textContent = "Detached " + name + "."; return renderBoxes().then(refresh); })
    .catch(function (err) { $("setboxesstatus").textContent = String(err.message || err); e.target.disabled = false; });
});

function renderBoxSection() {
  renderBoxes();
  $("setboxstate").textContent = boxState.ok
    ? "Running — " + boxState.detail
    : "Not running. Agents have no desktop, shell or files until it is.";
  $("setboxactions").style.display = boxState.ok ? "none" : "";
}

/**
 * First run: nothing configured, or no box. Opens settings with the welcome note so
 * the two things the product needs are the first two things a person sees. Once
 * dismissed or saved, never again — the flag is the browser's, not the server's.
 */
function maybeOnboard() {
  try { if (localStorage.getItem("lumen-onboarded")) return; } catch (error) {}
  fetch("/api/config")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var configured = !!(data.config && data.config.provider);
      var anyKey = (data.presets || []).some(function (p) { return p.keyPresent; });
      if ((!configured && !anyKey) || !boxState.ok) {
        openSettings();
        $("setwelcome").style.display = "";
      }
    })
    .catch(function () {});
}

function markOnboarded() {
  try { localStorage.setItem("lumen-onboarded", "1"); } catch (error) {}
  $("setwelcome").style.display = "none";
}

$("setboxup").onclick = function () {
  $("setboxup").disabled = true;
  $("setboxlog").style.display = "";
  $("setboxlog").textContent = "starting…\n";
  fetch("/api/box/up", { method: "POST" })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.error) $("setboxlog").textContent += d.error + "\n";
    })
    .catch(function (error) { $("setboxlog").textContent += error.message + "\n"; })
    .then(function () { $("setboxup").disabled = false; });
};

/** The approvals that hold until revoked, with the one action that ends each. */
function renderStandingGrants() {
  fetch("/api/policy")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var grants = data.standing || [];
      $("setgrantswrap").style.display = grants.length ? "" : "none";
      $("setgrants").innerHTML = grants.map(function (grant) {
        return '<div style="display:flex;gap:10px;align-items:baseline">' +
          '<code style="flex:1;font-family:var(--font-mono);font-size:12px;word-break:break-all">' +
          esc(grant.description) + "</code>" +
          '<a href="#" data-revoke="' + esc(grant.fingerprint) + '" style="font-size:12px;color:var(--danger)">Revoke</a>' +
          "</div>";
      }).join("");
    })
    .catch(function () {});
}

document.getElementById("setgrants").addEventListener("click", function (event) {
  var fingerprint = event.target.getAttribute && event.target.getAttribute("data-revoke");
  if (!fingerprint) return;
  event.preventDefault();
  fetch("/api/policy/revoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fingerprint: fingerprint })
  }).then(renderStandingGrants);
});

function settingsProviderChanged() {
  var name = $("setprovider").value;
  $("setbasewrap").style.display = name === "custom" ? "" : "none";
  var preset = null;
  for (var i = 0; i < settingsPresets.length; i++) {
    if (settingsPresets[i].name === name) preset = settingsPresets[i];
  }
  if (!preset) return;
  // Suggestions, not a gate: vendors ship models faster than any list updates.
  $("modellist").innerHTML = (preset.models || []).map(function (m) {
    return '<option value="' + esc(m) + '">';
  }).join("");
  $("setmodel").placeholder = "preset default: " + preset.model;
  // Whether a credential is present is worth showing; the credential itself never
  // leaves the server.
  $("setkeynote").textContent = preset.keyPresent
    ? "A key for " + preset.keyEnv + " is already provided. Leave blank to keep using it."
    : "No " + preset.keyEnv + " found — paste a key here, or export the variable before starting.";
  $("setkey").placeholder = preset.keyPresent ? "provided by environment" : "paste API key";
}

function saveSettings(thenRestart) {
  var body = { provider: $("setprovider").value };
  var model = $("setmodel").value.trim();
  body.model = model === "" ? null : model;
  var base = $("setbase").value.trim();
  body.baseUrl = base === "" ? null : base;
  var key = $("setkey").value.trim();
  if (key !== "") body.key = key;
  body.hostExec = { enabled: $("sethostenabled").checked, cwd: $("sethostcwd").value.trim() };
  body.startupItem = $("setstartupitem").checked;
  $("setstatus").textContent = "Saving…";
  fetch("/api/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  })
    .then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || "save failed");
        return d;
      });
    })
    .then(function () {
      markOnboarded();
      if (!thenRestart) {
        $("setstatus").textContent = "Saved. Takes effect when the server restarts.";
        return;
      }
      $("setstatus").textContent = "Restarting…";
      return fetch("/api/restart", { method: "POST" }).then(waitForRestart);
    })
    .catch(function (error) {
      $("setstatus").textContent = "Save failed: " + error.message;
    });
}

function waitForRestart() {
  // The old process exits ~300ms after answering, so polling starts after that window —
  // a 200 from the dying server would reload the page into nothing.
  var tries = 0;
  setTimeout(function poll() {
    tries += 1;
    fetch("/api/state")
      .then(function (r) {
        if (r.ok) { window.location.reload(); return; }
        throw new Error("not yet");
      })
      .catch(function () {
        if (tries > 60) {
          $("setstatus").textContent =
            "The server did not come back — start it again yourself: agentbox web";
          return;
        }
        setTimeout(poll, 1000);
      });
  }, 1500);
}

// One real request against the endpoint, so "invalid api key" is learned here and not
// at the restart after saving.
$("settest").onclick = function () {
  var body = { provider: $("setprovider").value };
  var model = $("setmodel").value.trim();
  if (model) body.model = model;
  var base = $("setbase").value.trim();
  if (base) body.baseUrl = base;
  var key = $("setkey").value.trim();
  if (key) body.key = key;
  $("settest").disabled = true;
  $("setstatus").textContent = "Testing — one real request…";
  fetch("/api/config/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      $("setstatus").textContent = d.ok
        ? "Connected — " + d.model + " answered in " + d.latencyMs + "ms."
        : "Failed: " + d.error;
    })
    .catch(function (error) { $("setstatus").textContent = "Test failed: " + error.message; })
    .then(function () { $("settest").disabled = false; });
};

$("settingsbtn").onclick = function () { openSettings("model"); };
$("setprovider").onchange = settingsProviderChanged;
$("setsave").onclick = function () { saveSettings(false); };
$("setsaverestart").onclick = function () { saveSettings(true); };
$("setcancel").onclick = function () {
  markOnboarded();
  $("settingswrap").style.display = "none";
};
// ── the admin view ──────────────────────────────────────────────────────────────
//
// Reached from the header number, which had been sitting there since the honesty pass
// showing today's tokens and opening nothing. Everything below reads; nothing here
// changes anything, which is why one Close is the only control.

var spendDay = null;

function num(value) {
  return (value || 0).toLocaleString("en-US");
}

/** "1 turn", not "1 turns". A report that cannot count to one is not read carefully after that. */
function plural(count, word) {
  return num(count) + " " + word + (count === 1 ? "" : "s");
}

/**
 * A task's title, when the title is a bare link.
 *
 * A task is created from the first line of the message that asked for it, so pasting a URL
 * with no words produces a row that is all tracking parameters and identifies nothing:
 * t24 through t27 were four x.com links differing only in their status id. The full URL
 * stays on the element, so nothing is lost by showing less of it.
 */
function taskLabel(title) {
  var text = String(title || "");
  if (!/^https?:\/\/\S+$/.test(text)) return esc(text);
  try {
    var link = new URL(text);
    var tail = link.pathname.replace(/\/+$/, "").split("/").filter(Boolean).slice(-2).join("/");
    return '<span title="' + esc(text) + '">' + esc(link.hostname.replace(/^www\./, "")) +
      (tail ? " / " + esc(tail) : "") + "</span>";
  } catch (error) {
    return esc(text);
  }
}

/**
 * A figure that is not on file, said as a dash rather than as a number.
 *
 * Every task on the board predates the turnId field, so all of them read this way today.
 * That is the truth and worth showing: a column of zeroes would say these tasks were free.
 */
function unknownCell() {
  return '<td class="unknown" title="No usage row names this task\u2019s turns">\u2014</td>';
}

function cell(row, key) {
  if (row.unknown) return unknownCell();
  return '<td class="num">' + num(row.totals[key]) + "</td>";
}

function renderSpend(data) {
  spendDay = data.day || null;
  $("spenddays").innerHTML = (data.days || []).map(function (d) {
    return '<a href="#" data-day="' + esc(d.day) + '" class="' + (d.day === spendDay ? "on" : "") + '">' +
      "<span>" + esc(d.day) + "</span><span>" + num(d.totals.outputTokens) + "</span></a>";
  }).join("");

  var report = data.report || {};
  var totals = report.totals || {};
  // A task drill-down is about a task, so it says which one. "1 turn(s)" was technically
  // true and told the reader nothing they had not just clicked on.
  var heading = data.task
    ? esc(data.task.id) + " " + esc(data.task.title) + " &middot; " + esc(data.task.status)
    : esc(report.scope || "");
  $("spendhead").innerHTML =
    "<b>" + heading + "</b> &middot; " + plural(report.records, "call") +
    (report.turns ? " across " + plural(report.turns, "turn") : "") + "<br>" +
    // Tokens, exactly -- not thousands. Grouped with commas rather than abbreviated, because
    // a report a person is meant to re-derive by hand should print the number it counted.
    num(totals.inputTokens) + " tokens in &middot; " + num(totals.outputTokens) +
    " out &middot; " + num(totals.cacheReadTokens) + " cache read" +
    (report.money !== undefined && report.money !== null
      ? " &middot; <b>$" + report.money.toFixed(2) + "</b>"
      : "");

  var sections = [];
  ["byKind", "byAgent", "byModel"].forEach(function (key) {
    var rows = report[key] || [];
    if (rows.length < 2) return;
    var label = key.slice(2).toLowerCase();
    sections.push(
      "<table class=\"spend\" style=\"margin-bottom:12px\"><tr><th>" + label +
      "</th><th style=\"text-align:right\">tokens out</th>" +
      "<th style=\"text-align:right\">tokens in</th>" +
      // Cache reads are most of the traffic here and were not shown at all, so the two
      // columns that were shown added to a fraction of the row and looked like all of it.
      "<th style=\"text-align:right\">cache read</th></tr>" +
      rows.map(function (row) {
        return "<tr><td>" + esc(row[label] || "") + '</td><td class="num">' +
          num(row.totals.outputTokens) + '</td><td class="num">' + num(row.totals.inputTokens) +
          '</td><td class="num">' + num(row.totals.cacheReadTokens) + "</td></tr>";
      }).join("") + "</table>"
    );
  });

  var tasks = data.tasks || [];
  if (tasks.length) {
    sections.push(
      "<table class=\"spend\"><tr><th>task</th><th>status</th><th style=\"text-align:right\">turns</th>" +
      "<th style=\"text-align:right\">tokens out</th><th style=\"text-align:right\">tokens in</th>" +
      "<th style=\"text-align:right\">cache read</th></tr>" +
      tasks.map(function (row) {
        // The id is a link rather than the row being clickable: a <tr> with a handler is
        // invisible to the keyboard and to anything reading the page aloud, and it gives no
        // sign that it can be clicked. Same defect the header number had.
        return '<tr class="pick"><td><a href="#" data-task="' + esc(row.id) + '">' + esc(row.id) +
          "</a> " + taskLabel(row.title) + "</td><td>" + esc(row.status) + "</td>" +
          // Zero turns and an unknown cost are the same fact; showing one as a figure and
          // the other as a word invited the reading that these tasks ran and cost nothing.
          (row.unknown ? unknownCell() : '<td class="num">' + num(row.turns) + "</td>") +
          cell(row, "outputTokens") + cell(row, "inputTokens") + cell(row, "cacheReadTokens") +
          "</tr>";
      }).join("") + "</table>"
    );
  }
  if (tasks.length && tasks.every(function (row) { return row.unknown; })) {
    // Otherwise a column of dashes reads as a bug. It is not: workId and turnId landed on
    // 2026-08-27, and every task older than that has no usage row that names its turns.
    sections.push('<div class="caveat" style="padding-top:6px">' +
      "None of these can be costed yet: a usage row only names the turn it ran in from " +
      "2026-08-27 onwards, and every task above was worked before that.</div>");
  }
  if (data.tasksHidden) {
    // Said rather than filtered quietly: "no tasks" and "no task whose cost is recoverable"
    // are different facts and only one of them is true here.
    sections.push('<div class="caveat" style="padding-top:6px">' + num(data.tasksHidden) +
      " task(s) not shown: nothing on file names the turns they were worked in.</div>");
  }
  // What the board recorded, which is the "execution" half of the drill-down: the cost is
  // only half the answer to "what happened to this task".
  if (data.task) {
    sections.push(
      "<table class=\"spend\"><tr><th>when</th><th>status</th><th>by</th><th>note</th></tr>" +
      (data.task.history || []).map(function (change) {
        return "<tr><td>" + esc((change.at || "").replace("T", " ").slice(0, 19)) + "</td><td>" +
          esc(change.status || "") + "</td><td>" + esc((change.by || "").slice(0, 18)) +
          "</td><td>" + esc(change.note || "") + "</td></tr>";
      }).join("") + "</table>"
    );
  }
  $("spendbody").innerHTML = sections.join("") ||
    '<div class="caveat">Nothing on file for this.</div>';

  var caveats = [];
  if (report.compacted) {
    caveats.push("A lower bound: the usage file has been compacted, so older calls in this window are no longer on disk.");
  }
  if ((report.unpriced || []).length) {
    caveats.push("No cost shown: no rate for " + esc(report.unpriced.join(", ")) +
      ". Add a \u201crates\u201d block to config.json to price them.");
  }
  if (report.unjoinable) caveats.push(esc(report.unjoinable));
  $("spendcaveat").innerHTML = caveats.join("<br>");
}

function openSpend(query) {
  // Addressable, so a day or a task's cost can be linked to rather than described as a
  // sequence of clicks. It also makes the view checkable by navigating to it, which is the
  // only way it *could* be checked here: synthetic clicks do not reach this browser.
  location.hash = "spend" + (query || "");
  $("spendwrap").style.display = "flex";
  $("spendbody").innerHTML = '<div class="caveat">Reading&hellip;</div>';
  fetch("/api/spend" + (query || ""))
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) {
        $("spendbody").innerHTML = '<div class="caveat">' + esc(data.error) + "</div>";
        return;
      }
      renderSpend(data);
    })
    .catch(function (error) {
      $("spendbody").innerHTML = '<div class="caveat">' + esc(String(error)) + "</div>";
    });
}

/** Opens the view named by the address, if the address names one. */
function spendFromHash() {
  var hash = location.hash.replace(/^#/, "");
  if (hash.indexOf("spend") !== 0) return;
  openSpend(hash.slice("spend".length));
}
window.addEventListener("hashchange", spendFromHash);
spendFromHash();

$("spendtoday").onclick = function () { openSpend(""); };
$("spendtoday").onkeydown = function (event) {
  if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openSpend(""); }
};
function closeSpend() {
  $("spendwrap").style.display = "none";
  // Cleared, or the next reload reopens a dialog nobody asked for.
  if (location.hash.indexOf("#spend") === 0) location.hash = "";
}
$("spendclose").onclick = closeSpend;
$("spendwrap").addEventListener("click", function (event) {
  if (event.target === $("spendwrap")) closeSpend();
});
$("spenddays").addEventListener("click", function (event) {
  var link = event.target.closest("a[data-day]");
  if (!link) return;
  event.preventDefault();
  openSpend("?day=" + encodeURIComponent(link.getAttribute("data-day")));
});
$("spendbody").addEventListener("click", function (event) {
  var link = event.target.closest("a[data-task]");
  if (!link) return;
  event.preventDefault();
  // The drill-down the whole thing exists for: from a day to one task's execution.
  openSpend("?task=" + encodeURIComponent(link.getAttribute("data-task")));
});

$("settingswrap").addEventListener("click", function (event) {
  if (event.target === $("settingswrap")) {
    markOnboarded();
    $("settingswrap").style.display = "none";
  }
});

var agents = [];
var allTools = [];
var current = null;
/** Which conversation the middle pane is showing. Empty = the team room ("main"). */
var currentConversation = "main";
/** The last /api/state box report, for the settings dialog's box section. */
var boxState = { ok: false, detail: "" };
var onboardChecked = false;
var busy = new Set();
/** In-flight assistant text nodes, keyed by agent id, so deltas land in one bubble. */
var live = new Map();
/** The tool row awaiting its result, per agent. */
var openTool = new Map();

function esc(value) {
  return String(value).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
}
function nearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}
function nameOf(id) {
  for (var i = 0; i < agents.length; i++) if (agents[i].id === id) return agents[i].name;
  return String(id).slice(0, 8);
}

/**
 * The agent's identity color: assigned by roster position, stable while it exists.
 * Status is always a dot plus a word; this color marks identity, never state.
 */
function colorOfName(name) {
  for (var i = 0; i < agents.length; i++) {
    if (agents[i].name === name) return "var(--c-" + ((i % 8) + 1) + ")";
  }
  return "var(--muted)";
}

/**
 * One activity line. The at argument is when it happened; omit it for something now.
 *
 * The clock is there because this history outlives the process: without it, a line from
 * last night's run reads as if it just happened.
 */
function feed(html, cls, at) {
  var el = $("feed");
  var stick = nearBottom(el);
  var when = at ? new Date(at) : new Date();
  var stamp = isNaN(when.getTime())
    ? ""
    : '<span class="t">' + ("0" + when.getHours()).slice(-2) + ":" +
        ("0" + when.getMinutes()).slice(-2) + "</span> ";
  var row = document.createElement("div");
  row.className = "ev " + (cls || "");
  row.innerHTML = stamp + html;
  el.appendChild(row);
  if (stick) el.scrollTop = el.scrollHeight;
}

/** The box an agent lives in, as a small label with the connection dot. */
function boxHeaderHtml(box, index) {
  return '<div class="eyebrow-row" style="margin-top:' + (index === 0 ? "0" : "8px") + '" title="' + esc(box.kind === "docker" ? "the box on this machine" : "attached at " + (box.endpoint || "")) + '">' +
    '<span class="eyebrow" style="display:flex;align-items:center;gap:6px">' +
      '<span class="dot" style="width:7px;height:7px;background:' + (box.connected ? "var(--ok, #3fb950)" : "var(--warn)") + '"></span>' +
      esc(box.name) + (index === 0 ? ' <span class="dim" style="text-transform:none;font-weight:400">own</span>' : ' <span class="dim" style="text-transform:none;font-weight:400">attached · :' + esc(box.displayFloor) + "+</span>") +
    "</span></div>";
}

/** The box whose page is showing; null until the state arrives, then always one of boxesSeen. */
var currentBox = null;

/** The box bar: a tab per box, the current one lit, and a way to add one. */
function renderBoxBar() {
  var bar = $("boxbar");
  if (!bar) return;
  var many = boxesSeen.length > 1;
  bar.className = many ? "many" : "";
  if (!many) return;
  bar.innerHTML = boxesSeen.map(function (b) {
    return '<a href="#" role="tab" class="tab' + (b.id === currentBox ? " on" : "") + '" data-box="' + esc(b.id) + '"' +
      ' title="' + esc(b.kind === "docker" ? "the box on this machine" : "attached at " + (b.baseUrl || b.address || "another machine")) + '">' +
      '<span class="dot" style="background:' + (b.connected ? "var(--ok, #3fb950)" : "var(--warn)") + '"></span>' +
      esc(b.name) + ' <span class="kind">' + esc(b.kind === "docker" ? "docker" : "attached") + "</span>" +
      "</a>";
  }).join("") +
    '<a href="#" class="tab" data-newbox="1" title="Create or attach a box">+ box</a>';
}

$("boxbar").onclick = function (event) {
  var tab = event.target.closest("a[data-box]");
  if (tab) {
    event.preventDefault();
    selectBox(tab.getAttribute("data-box"));
    return;
  }
  if (event.target.closest("a[data-newbox]")) {
    event.preventDefault();
    openSettings("boxes");
  }
};

/** Switching a box switches the page: the list, the selected agent, the board. */
function selectBox(boxId) {
  if (boxId === currentBox) return;
  currentBox = boxId;
  renderBoxBar();
  renderAgents();
  var selected = agentById(current);
  if (!selected || selected.boxId !== currentBox) {
    var first = agents.filter(function (a) { return a.boxId === currentBox; })[0];
    if (first) select(first.id);
  }
  if (typeof loadTasks === "function") loadTasks();
}

/** The agents of the box whose page is showing. With one box, all of them. */
function agentsInView() {
  if (boxesSeen.length <= 1 || !currentBox) return agents;
  return agents.filter(function (a) { return a.boxId === currentBox; });
}

function renderAgents() {
  var html = "";
  var sorted = agentsInView();
  for (var i = 0; i < sorted.length; i++) {
    var a = sorted[i];
    html += '<div class="agent ' + (a.id === current ? "on" : "") + '" data-id="' + esc(a.id) + '">' +
      '<div class="dot ' + (busy.has(a.id) ? "busy" : "") +
      '" style="background:var(--c-' + ((i % 8) + 1) + ')"></div>' +
      '<div class="cols"><div class="nm">' + esc(a.name) + "</div>" +
      '<div class="ttl">' + esc(busy.has(a.id) ? "Running" : String(a.title || a.description || "idle").slice(0, 40)) +
      "</div></div>" +
      (a.displayIndex ? '<span class="dnum">d' + esc(a.displayIndex) + "</span>" : "") +
      "</div>";
  }
  $("agents").innerHTML = html;
  var nodes = document.querySelectorAll(".agent");
  for (var j = 0; j < nodes.length; j++) {
    nodes[j].onclick = function () { select(this.dataset.id); };
  }
}

/* ── the trace as a tree ───────────────────────────────────────────────────────
   A turn is rounds: the model says what it is about to do, then does it. That is a
   parent and its children, and rendering them as siblings — which is what this did —
   throws the structure away and leaves a flat wall in which nothing indicates that six
   fetches belong to the sentence above them.
   So a round is one details element. Its summary is what the model said it was doing; its
   children are the calls it made. Folding it folds the calls with it, which is what
   folding a node in a tree means. The final answer is not a round: it is the thing the
   rounds were for, and it stays unindented in the serif so one scan of the left edge
   finds it. */

/** The element new steps are appended to: the open round, or the chat when none is. */
var openStep = null;

function stepHost() {
  return openStep && openStep.isConnected ? openStep.querySelector(".kids") : $("chat");
}

/**
 * Opens a round whose summary is what the agent said it was about to do.
 *
 * Called when narration is followed by tool calls — the point at which that sentence is
 * revealed to have been a heading rather than an answer.
 */
/**
 * The bar that folds a whole turn's steps at once.
 *
 * Per turn rather than per page: "fold everything I can see" is a different wish from
 * "put this piece of work away", and the second is the one people actually have while
 * reading. Placed above the first step of the turn, so the control is where the thing it
 * controls is — the header link was correct and invisible.
 */
function stepGroupBar() {
  var chat = $("chat");
  var last = chat.lastElementChild;
  if (last && last.classList && last.classList.contains("steps")) return last;
  var group = document.createElement("div");
  group.className = "steps";
  group.innerHTML = '<a href="#" class="foldgroup"></a>';
  var link = group.querySelector(".foldgroup");
  // The state lives on the element rather than in a closure so that the page-wide control
  // can set it too, and so that both read the same thing rather than two flags that drift.
  var label = function () {
    var n = group.querySelectorAll("details.step").length;
    var calls = group.querySelectorAll("details.tool").length;
    var shut = group.classList.contains("shut");
    // Duration from the messages around the work: the one before it and the one after.
    var before = group.previousElementSibling, after = group.nextElementSibling;
    while (before && !(before.classList && before.classList.contains("msg") && before.getAttribute("data-at"))) before = before.previousElementSibling;
    while (after && !(after.classList && after.classList.contains("msg") && after.getAttribute("data-at"))) after = after.nextElementSibling;
    var ms = before && after ? Date.parse(after.getAttribute("data-at")) - Date.parse(before.getAttribute("data-at")) : NaN;
    var dur = isFinite(ms) && ms > 0 ? (ms < 60000 ? Math.round(ms / 1000) + "s" : Math.floor(ms / 60000) + "m " + Math.round((ms % 60000) / 1000) + "s") : "";
    link.textContent = (shut ? "\u25b8 " : "\u25be ") + "Worked" + (dur ? " for " + dur : "") +
      " · " + (calls ? calls + (calls === 1 ? " call" : " calls") : n + (n === 1 ? " step" : " steps"));
  };
  // Hiding, not collapsing. Each step keeps whatever it was \u2014 open or shut \u2014 so bringing
  // the group back gives the reader the view they left, which is what a tree does.
  link.onclick = function (event) {
    event.preventDefault();
    group.classList.toggle("shut");
    label();
  };
  group.relabel = label;
  if (folded) group.classList.add("shut");
  chat.appendChild(group);
  label();
  return group;
}

function beginStep(text, keepOpen) {
  var chat = $("chat");
  var stick = nearBottom(chat);
  var step = document.createElement("details");
  step.className = "step";
  // A step opened under text the person was reading stays open while the turn runs:
  // the text they were reading gets a heading and calls under it, and folds with the
  // rest when the turn ends and the transcript is re-rendered. Folding it the moment a
  // tool call arrived made the sentence vanish mid-read.
  step.open = keepOpen === true || !folded;
  step.innerHTML =
    '<summary><span class="lbl"></span><span class="cnt"></span></summary>' +
    '<div class="kids"></div>';
  var head = firstLineOf(text);
  step.querySelector(".lbl").textContent = head || "working";
  // Only the *rest* goes in the body. Putting the whole thing there repeated the first
  // sentence directly under itself, which read as a rendering fault rather than as a
  // heading and its detail.
  var rest = restAfter(text, head);
  if (rest !== "") {
    var full = document.createElement("div");
    full.className = "saidfull";
    full.innerHTML = renderMarkdown(rest);
    step.querySelector(".kids").appendChild(full);
  }
  var group = stepGroupBar();
  group.appendChild(step);
  if (group.relabel) group.relabel();
  openStep = step;
  if (stick) chat.scrollTop = chat.scrollHeight;
  return step;
}

/** Closes the current round, so what follows is not filed under it. */
function endStep() {
  openStep = null;
}

/** Whatever the agent said beyond the line already shown as the heading. */
function restAfter(text, head) {
  var whole = String(text || "").trim();
  if (head === "") return whole;
  // head is clamped and may end in an ellipsis, so compare on the unclamped prefix.
  var bare = head.replace(/…$/, "");
  var at = whole.indexOf(bare);
  if (at !== 0) return whole;
  return whole.slice(bare.length).replace(/^[\s。.!?、,，]+/, "").trim();
}

/** The first sentence or line, clamped — enough to know what a folded step was. */
function firstLineOf(text) {
  var line = String(text || "").trim().split(/[\n。.!?]/)[0] || "";
  return line.length > 58 ? line.slice(0, 58) + "…" : line;
}

/** Whether new steps arrive folded. Flipped by the header control, remembered per page. */
var folded = false;

/** A time as a person reads it beside a message: the clock today, the date otherwise. */
function whenLabel(at) {
  if (!at) return "";
  var d = new Date(at);
  if (isNaN(d.getTime())) return "";
  var now = new Date();
  var sameDay = d.toDateString() === now.toDateString();
  var hm = d.toTimeString().slice(0, 5);
  return sameDay ? hm : (d.getMonth() + 1) + "/" + d.getDate() + " " + hm;
}

/** The index of the entry being replayed, so a bubble can carry a permalink; -1 while live. */
var replayIndex = -1;

function bubble(role, who, text, at, extra) {
  var el = $("chat");
  var stick = nearBottom(el);
  var div = document.createElement("div");
  div.className = "msg " + role;
  var when = whenLabel(at);
  if (replayIndex >= 0) div.setAttribute("data-m", String(replayIndex));
  if (at) div.setAttribute("data-at", String(at));
  div.setAttribute("data-role", role === "user" ? "user" : role === "peer" ? "peer" : "agent");
  if (extra && extra.colour) div.style.setProperty("--peer-colour", extra.colour);
  var chips = extra && extra.chips ? extra.chips.map(function (c) { return ' <span class="chip">' + esc(c) + "</span>"; }).join("") : "";
  div.innerHTML = '<div class="who">' + esc(who) + chips + (when ? ' <span style="text-transform:none;letter-spacing:0;font-weight:400" title="' + esc(String(at)) + '">' + esc(when) + "</span>" : "") + '</div><div class="body"></div>' +
    '<div class="mtools">' +
      '<button type="button" data-act="copy" title="Copy the text">copy</button>' +
      '<button type="button" data-act="md" title="Copy as Markdown">md</button>' +
      '<button type="button" data-act="quote" title="Quote into the composer">quote</button>' +
      (replayIndex >= 0 ? '<button type="button" data-act="link" title="Copy a link to this message">link</button>' : "") +
      (role === "user" ? '<button type="button" data-act="resend" title="Put this back in the composer">resend</button>' : "") +
    "</div>";
  var body = div.querySelector(".body");
  body.innerHTML = renderMarkdown(text);
  div.__md = String(text == null ? "" : text);
  addCodeCopy(body);
  el.appendChild(div);
  if (stick) el.scrollTop = el.scrollHeight;
  return body;
}

/** A copy button on every code block (docs/40 §3). */
function addCodeCopy(body) {
  var pres = body.querySelectorAll("pre");
  for (var i = 0; i < pres.length; i++) {
    if (pres[i].querySelector(".precopy")) continue;
    var b = document.createElement("button");
    b.type = "button"; b.className = "precopy"; b.textContent = "copy"; b.title = "Copy this code";
    b.onclick = (function (pre, btn) {
      return function (event) {
        event.preventDefault();
        var code = pre.querySelector("code");
        copyText(code ? code.textContent : pre.textContent.replace(/copy$/, ""));
        btn.textContent = "copied"; setTimeout(function () { btn.textContent = "copy"; }, 1200);
      };
    })(pres[i], b);
    pres[i].appendChild(b);
  }
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text); });
  fallbackCopy(text);
  return Promise.resolve();
}
function fallbackCopy(text) {
  var ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); } catch (error) {}
  document.body.removeChild(ta);
}

/** Puts text into the composer, after whatever is there, and focuses it. */
function intoComposer(text) {
  var input = $("input");
  input.value = (input.value ? input.value.replace(/\s+$/, "") + "\n\n" : "") + text;
  input.focus();
  input.selectionStart = input.selectionEnd = input.value.length;
  input.dispatchEvent(new Event("input"));
}

function messageLink(index) {
  var u = new URL(location.href);
  u.search = "";
  u.searchParams.set("agent", current);
  u.searchParams.set("conversation", currentConversation);
  u.searchParams.set("m", String(index));
  return u.toString();
}

$("chat").addEventListener("click", function (event) {
  var btn = event.target.closest(".mtools button");
  if (!btn) return;
  event.preventDefault();
  var msg = btn.closest(".msg");
  var act = btn.getAttribute("data-act");
  var mdText = msg.__md || msg.querySelector(".body").textContent;
  var flash = function (label) { var was = btn.textContent; btn.textContent = label; setTimeout(function () { btn.textContent = was; }, 1200); };
  if (act === "copy") { copyText(msg.querySelector(".body").innerText); flash("copied"); }
  else if (act === "md") { copyText(mdText); flash("copied"); }
  else if (act === "quote") { intoComposer(mdText.split("\n").slice(0, 6).map(function (l) { return "> " + l; }).join("\n") + "\n"); }
  else if (act === "link") { copyText(messageLink(msg.getAttribute("data-m"))); flash("copied"); }
  else if (act === "resend") { intoComposer(mdText); }
});

/**
 * A collapsed row: one line of summary, the rest behind a click.
 *
 * Used for tool calls and for teammate messages, which are the two things that arrive
 * in bulk and drown the conversation when shown in full.
 */
/** The argument that identifies a call. Mirrors src/web/transcript.ts for replay. */
function toolDetail(tool, input) {
  var args = input || {};
  if (tool === "bash") return args.command || "";
  if (tool === "SendToAgent") return nameOf(args.target_id || "") + ": " + (args.text || "");
  if (tool === "computer") {
    var actions = args.actions || [];
    var names = [];
    for (var i = 0; i < actions.length; i++) names.push(actions[i].action);
    return names.join(" + ");
  }
  // A structured argument is the common case, not the exception: SetTodos takes a list of
  // objects and String() on it renders "[object Object],[object Object]" — which is what
  // the row showed. Summarise by shape instead, so a call is identifiable without being
  // expanded.
  var keys = Object.keys(args);
  if (keys.length === 0) return "";
  return keys
    .map(function (key) { return describeArg(args[key]); })
    .filter(function (part) { return part !== ""; })
    .join(" · ")
    .slice(0, 140);
}

/** One argument, in a form a person can read at a glance. */
function describeArg(value) {
  if (value == null) return "";
  if (Array.isArray(value)) {
    // The items themselves when they are words; a count when they are structures.
    var words = value.filter(function (item) { return typeof item !== "object"; });
    if (words.length === value.length) return words.join(", ");
    var labels = value.map(function (item) {
      return item && (item.text || item.title || item.name || item.action || item.id) || "";
    }).filter(Boolean);
    return labels.length ? labels.join(" · ") : value.length + " items";
  }
  if (typeof value === "object") {
    return value.text || value.title || value.name || value.command || value.url ||
      Object.keys(value).join(",");
  }
  return String(value);
}

function collapsedRow(cls, summaryHtml, detail) {
  var el = stepHost();
  var stick = nearBottom($("chat"));
  var row = document.createElement("details");
  row.className = "tool " + (cls || "");
  row.innerHTML = "<summary>" + summaryHtml + '</summary><div class="det"></div>';
  // textContent, not innerHTML: this is output from a command or another agent.
  row.querySelector(".det").textContent = String(detail == null ? "" : detail);
  el.appendChild(row);
  countStep();
  if (stick) $("chat").scrollTop = $("chat").scrollHeight;
  return row;
}

/** Keeps a step's summary saying how many calls are inside it, so folding loses nothing. */
function countStep() {
  if (!openStep || !openStep.isConnected) return;
  var n = openStep.querySelectorAll(".kids > details.tool").length;
  var cnt = openStep.querySelector(".cnt");
  if (cnt) cnt.textContent = n === 0 ? "" : n === 1 ? "1 call" : n + " calls";
}

/** Appends to an open row's body, for a result that arrives after the call. */
function appendDetail(row, text) {
  if (!row || !text) return;
  var body = row.querySelector(".det");
  body.textContent = body.textContent ? body.textContent + "\n\n" + text : String(text);
}

function toolCall(name, detail, result, isError) {
  var oneLine = String(detail == null ? "" : detail).replace(/\s+/g, " ");
  var row = collapsedRow(
    isError ? "err" : "",
    '<span class="nm">' + esc(name) + "</span> " + esc(oneLine.slice(0, 140)),
    detail
  );
  appendDetail(row, result);
  return row;
}

/**
 * A teammate message as a one-line hint.
 *
 * The established pattern for this is an inline hint — "Messaged [Bob]" — naming the
 * agent rather than quoting what was sent. Following that: the row says who and which
 * direction, and the message itself is one click away. The dot carries the teammate's
 * identity color, the same one the roster gave them.
 */
/**
 * A teammate speaking here, or this agent having messaged one (docs/41 §1).
 *
 * Incoming: a bubble in the teammate's colour with its name — it spoke in this room, and it
 * reads like a speaker, not like a log line. Three or more in a row fold to one line, as
 * Grok's "5 messages with 2 Bots" does. Outgoing: the text was the agent's own prose above;
 * the footer only says where it went.
 */
function peerNote(direction, name, text, priority, at) {
  var el = $("chat");
  var stick = nearBottom(el);
  if (direction === "to") {
    var foot = document.createElement("div");
    foot.className = "sentfoot";
    foot.innerHTML = '<details><summary><span class="peerdot" style="background:' + colorOfName(name) + '"></span>Messaged ⟶ ' + esc(name) + (priority ? " (priority)" : "") + '</summary><div class="det"></div></details>';
    foot.querySelector(".det").textContent = String(text == null ? "" : text);
    el.appendChild(foot);
    if (stick) el.scrollTop = el.scrollHeight;
    return foot;
  }
  var chips = ["teammate"];
  if (priority) chips.push("priority");
  var body = bubble("peer", name, text, at, { colour: colorOfName(name), chips: chips });
  var msg = body.parentNode;
  // Runs: the third incoming teammate message in a row starts a fold line above the run.
  var prev = msg.previousElementSibling;
  var run = prev && prev.classList.contains("peerrun") ? prev : null;
  if (run) { run.appendChild(msg); }
  else if (prev && prev.classList.contains("msg") && prev.classList.contains("peer")) {
    var wrap = document.createElement("div");
    wrap.className = "peerrun";
    var fold = document.createElement("div");
    fold.className = "peerfold";
    el.insertBefore(fold, prev);
    el.insertBefore(wrap, fold.nextSibling);
    wrap.appendChild(prev); wrap.appendChild(msg);
    fold.onclick = function () { fold.classList.toggle("shut"); relabelPeerFold(fold, wrap); };
    run = wrap;
  }
  if (run) relabelPeerFold(run.previousElementSibling, run);
  if (stick) el.scrollTop = el.scrollHeight;
  return body;
}
function relabelPeerFold(fold, run) {
  var msgs = run.querySelectorAll(".msg.peer");
  var names = {};
  for (var i = 0; i < msgs.length; i++) names[msgs[i].querySelector(".who").firstChild.textContent] = 1;
  var m = Object.keys(names).length;
  fold.textContent = (fold.classList.contains("shut") ? "▸ " : "▾ ") + msgs.length + " messages from " + m + (m === 1 ? " teammate" : " teammates");
}

/**
 * Says what kind of box this is, wherever the box is being used.
 *
 * Deliberately not a modal and not an acknowledgement: those are read once and dismissed
 * forever, and the thing worth knowing — that somebody else can see this screen — matters
 * every time, not the first time.
 */
function showBoxClass(box) {
  var badge = $("boxclass");
  var notice = $("boxnotice");
  if (!box || !box.access) {
    badge.style.display = "none";
    notice.style.display = "none";
    return;
  }
  badge.textContent = box.badge + (box.group ? " · " + box.group : "");
  // Warn-toned unless the class is actually enforced. A box labelled private with nothing
  // behind it must not read as the calm case; it is the shared case with a wrong label.
  badge.className = "boxclass " + (box.enforced === false ? "shared" : box.access);
  // The notice, or nothing. This used to fall through to "只有你能打开这台箱子" — the
  // strongest privacy claim in the product, arriving as an || fallback nobody decided on,
  // and false for every box that exists.
  badge.title = box.notice || "";
  badge.style.display = "";
  notice.textContent = box.notice || "";
  notice.style.display = box.notice ? "" : "none";
}

/** Points the desktop pane at one agent's own display. */
function showDesktop(id) {
  var agent = null;
  for (var i = 0; i < agents.length; i++) if (agents[i].id === id) agent = agents[i];
  if (!agent || !agent.desktopUrl) {
    $("desktoptitle").textContent = "";
    $("full").style.display = "none";
    return;
  }
  $("desktoptitle").textContent = agent.name + " · d" + agent.displayIndex + (boxesSeen.length > 1 && agent.boxName ? " · " + agent.boxName : "");
  $("full").href = agent.desktopUrl;
  $("full").style.display = "";
  // The iframe rides with embedded=1 so the proxy skips the box-class banner:
  // #boxnotice already says the same sentence right above this frame, and inside
  // the frame the banner only covered the desktop's top edge. Take over keeps the
  // plain URL — standalone, the banner is the only warning on the page.
  var embeddedUrl = agent.desktopUrl + "&embedded=1";
  // Only reload when it is a different desktop: re-setting src restarts noVNC and
  // flashes "Connecting…", so switching back and forth must not thrash it.
  if ($("vnc").getAttribute("src") !== embeddedUrl) {
    $("vnc").setAttribute("src", embeddedUrl);
  }
}

/**
 * One mapped transcript entry.
 *
 * The server hands over what to show — prose, teammate messages, tool calls, results —
 * because the stored transcript is written for the model and needs a real parse to read
 * as a conversation. See src/web/transcript.ts.
 */
/* ── the chat column, one model and one renderer (docs/41 §2) ─────────────────────────
   Every item in the column is one of: person, agent, teammate, sent, work, divider. The
   live stream and the replay both produce items through pushItem; drawItem is the only
   thing that turns an item into DOM; redrawItem replaces a node in place when an item
   grows (a streaming reply, a call whose result arrives). Nothing is moved, shrunk or
   re-filed after it was drawn: prose stays prose, work stays a fold. */

var thread = [];          // items in order, for the thread on screen
var openAgent = null;     // the agent item still streaming, if any
var openWork = null;      // the work item still collecting calls, if any
var openCall = new Map(); // agentId → the call awaiting its result
var openQuestion = null;  // the question item still waiting for an answer, if any
var workingItem = null;   // the "on it" row shown between turn start and the first word

function resetThread() {
  thread = []; openAgent = null; openWork = null; openCall.clear(); openQuestion = null; workingItem = null;
  $("chat").innerHTML = "";
}

/** The agent has started and said nothing yet. */
function showWorking() {
  if (workingItem || openAgent || openWork) return;
  workingItem = pushItem({ kind: "working" });
}

function dropWorking() {
  if (!workingItem) return;
  var at = thread.indexOf(workingItem);
  if (at >= 0) thread.splice(at, 1);
  if (workingItem.node && workingItem.node.isConnected) workingItem.node.remove();
  workingItem = null;
}

/** A person's message answers the question that was waiting, if one was. */
function answerQuestion(text) {
  if (!openQuestion) return;
  openQuestion.answered = String(text == null ? "" : text);
  redrawItem(openQuestion);
  openQuestion = null;
}

/** Sends an answer to the agent that asked, the same way the composer does. */
function sendAnswer(item, text) {
  if (!text || !current) return;
  item.answered = text; redrawItem(item);
  if (openQuestion === item) openQuestion = null;
  fetch("/api/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: current, text: text, conversation: currentConversation })
  }).then(function (res) {
    if (!res.ok) return res.text().then(function (t) { feed("answer rejected: " + esc(t), "err"); });
  }).catch(function (error) { feed("answer failed: " + esc(error.message), "err"); });
}

function pushItem(item) {
  if (item.kind !== "working") dropWorking();
  if (item.kind === "person") answerQuestion(item.text);
  thread.push(item);
  var el = $("chat");
  var stick = nearBottom(el);
  item.node = drawItem(item);
  el.appendChild(item.node);
  if (stick) el.scrollTop = el.scrollHeight;
  return item;
}

function redrawItem(item) {
  if (!item.node || !item.node.isConnected) return;
  var el = $("chat");
  var stick = nearBottom(el);
  var next = drawItem(item);
  item.node.replaceWith(next);
  item.node = next;
  if (stick) el.scrollTop = el.scrollHeight;
}

function whoLine(who, at, chips) {
  var when = whenLabel(at);
  return '<div class="who">' + esc(who) +
    (chips || []).map(function (c) { return ' <span class="chip">' + esc(c) + "</span>"; }).join("") +
    (when ? ' <span style="text-transform:none;letter-spacing:0;font-weight:400" title="' + esc(String(at)) + '">' + esc(when) + "</span>" : "") +
    "</div>";
}

function toolsHtml(kind, hasIndex) {
  return '<div class="mtools">' +
    '<button type="button" data-act="copy" title="Copy the text">copy</button>' +
    '<button type="button" data-act="md" title="Copy as Markdown">md</button>' +
    '<button type="button" data-act="quote" title="Quote into the composer">quote</button>' +
    (hasIndex ? '<button type="button" data-act="link" title="Copy a link to this message">link</button>' : "") +
    (kind === "person" ? '<button type="button" data-act="resend" title="Put this back in the composer">resend</button>' : "") +
    "</div>";
}

function drawItem(item) {
  var div = document.createElement("div");
  if (item.kind === "person" || item.kind === "agent" || item.kind === "teammate") {
    div.className = "msg " + (item.kind === "person" ? "user" : item.kind === "teammate" ? "peer" : "");
    div.setAttribute("data-role", item.kind === "person" ? "user" : item.kind === "teammate" ? "peer" : "agent");
    if (item.index !== undefined) div.setAttribute("data-m", String(item.index));
    if (item.at) div.setAttribute("data-at", String(item.at));
    if (item.streaming) div.setAttribute("data-partial", "1");
    var who = item.kind === "person" ? "you" : item.kind === "teammate" ? item.from : nameOf(current);
    var chips = item.kind === "teammate" ? ["teammate"].concat(item.priority ? ["priority"] : []) : [];
    if (item.kind === "teammate") div.style.setProperty("--peer-colour", colorOfName(item.from));
    div.innerHTML = whoLine(who, item.at, chips) + '<div class="body"></div>' + toolsHtml(item.kind, item.index !== undefined);
    var body = div.querySelector(".body");
    body.innerHTML = renderMarkdown(item.text);
    div.__md = String(item.text == null ? "" : item.text);
    addCodeCopy(body);
    return div;
  }
  if (item.kind === "sent") {
    div.className = "sentfoot";
    div.innerHTML = '<details><summary><span class="peerdot" style="background:' + colorOfName(item.to) + '"></span>Messaged ⟶ ' + esc(item.to) + (item.priority ? " (priority)" : "") + '</summary><div class="det"></div></details>';
    div.querySelector(".det").textContent = String(item.text == null ? "" : item.text);
    return div;
  }
  if (item.kind === "work") {
    var det = document.createElement("details");
    det.className = "work";
    det.open = item.open !== undefined ? item.open : !folded;
    var calls = item.calls || [];
    var ms = item.startAt && item.endAt ? Date.parse(item.endAt) - Date.parse(item.startAt) : NaN;
    var dur = isFinite(ms) && ms > 0 ? (ms < 60000 ? Math.round(ms / 1000) + "s" : Math.floor(ms / 60000) + "m " + Math.round((ms % 60000) / 1000) + "s") : "";
    var label = (item.done ? "Worked" : "Working") + (dur ? " for " + dur : "") + " · " + calls.length + (calls.length === 1 ? " call" : " calls");
    det.innerHTML = "<summary>" + esc(label) + '</summary><div class="calls"></div>';
    det.ontoggle = function () { item.open = det.open; };
    var host = det.querySelector(".calls");
    for (var i = 0; i < calls.length; i++) host.appendChild(drawCall(calls[i]));
    return det;
  }
  if (item.kind === "working") {
    div.className = "working";
    div.innerHTML = '<span class="dots"><span></span><span></span><span></span></span>' + esc(nameOf(current)) + " is on it";
    return div;
  }
  if (item.kind === "question") {
    div.className = "question";
    if (item.at) div.setAttribute("data-at", String(item.at));
    var opts = item.options || [];
    var html = whoLine(nameOf(current), item.at, ["question"]) + '<div class="qtitle"></div>';
    for (var o = 0; o < opts.length; o++) {
      html += '<button type="button" class="qopt' + (item.answered === opts[o] ? " chosen" : "") + '" data-opt="' + o + '"' + (item.answered !== undefined ? " disabled" : "") + '>' +
        '<span class="qkey">' + String.fromCharCode(65 + o) + "</span><span></span></button>";
    }
    if (item.answered === undefined) {
      html += '<form class="qfree"><input placeholder="Type your own answer" spellcheck="false"><button type="submit" class="btn sm accent">Send</button></form>';
    } else if (opts.indexOf(item.answered) < 0) {
      html += '<div class="qdone">you answered: <b></b></div>';
    }
    div.innerHTML = html;
    div.querySelector(".qtitle").textContent = item.question || "";
    var labels = div.querySelectorAll(".qopt span:last-child");
    for (var l = 0; l < labels.length; l++) labels[l].textContent = opts[l];
    var done = div.querySelector(".qdone b");
    if (done) done.textContent = item.answered;
    div.addEventListener("click", function (event) {
      var btn = event.target.closest && event.target.closest(".qopt");
      if (!btn || btn.disabled) return;
      sendAnswer(item, opts[Number(btn.getAttribute("data-opt"))]);
    });
    var free = div.querySelector(".qfree");
    if (free) free.onsubmit = function (event) {
      event.preventDefault();
      sendAnswer(item, free.querySelector("input").value.trim());
    };
    return div;
  }
  div.className = "divider" + (item.isNew ? " new" : "");
  div.textContent = item.label || "";
  return div;
}

function drawCall(call) {
  var row = document.createElement("details");
  row.className = "tool " + (call.isError ? "err" : "");
  var oneLine = String(call.detail == null ? "" : call.detail).replace(/\s+/g, " ");
  row.innerHTML = "<summary>" + '<span class="nm">' + esc(call.name) + "</span> " + esc(oneLine.slice(0, 140)) + '</summary><div class="det"></div>';
  row.querySelector(".det").textContent = String(call.detail == null ? "" : call.detail) + (call.result ? "\n\n" + String(call.result) : "");
  if (call.shot) {
    var img = document.createElement("img");
    img.className = "shot";
    img.src = "data:image/webp;base64," + call.shot;
    row.appendChild(img);
  }
  return row;
}

/** Closes whatever is still open: the next thing is a new item, not a continuation. */
function closeOpen() {
  if (openAgent) { openAgent.streaming = false; redrawItem(openAgent); openAgent = null; }
  if (openWork) { openWork.done = true; if (!openWork.endAt) openWork.endAt = new Date().toISOString(); redrawItem(openWork); openWork = null; }
}

/** One stored entry from the server, as items. Prose is prose whether or not calls followed it. */
function replayEntry(id, entry, index) {
  if (entry.kind === "peer") {
    closeOpen();
    for (var p = 0; p < entry.messages.length; p++) {
      pushItem({ kind: "teammate", from: entry.messages[p].from, text: entry.messages[p].text, priority: entry.messages[p].priority, at: entry.at });
    }
    return;
  }
  if (entry.kind === "tools") {
    if (openAgent) { openAgent.streaming = false; redrawItem(openAgent); openAgent = null; }
    if (!openWork) {
      var before = thread.length ? thread[thread.length - 1] : null;
      openWork = pushItem({ kind: "work", calls: [], startAt: before && before.at ? before.at : entry.at, done: false });
    }
    var asked = null;
    for (var t = 0; t < entry.tools.length; t++) {
      var c = entry.tools[t];
      openWork.calls.push({ name: c.name, detail: c.detail, result: c.result, isError: c.isError });
      if (c.question) asked = c.question;
    }
    redrawItem(openWork);
    if (asked) {
      closeOpen();
      openQuestion = pushItem({ kind: "question", question: asked.question, options: asked.options || [], at: entry.at });
    }
    return;
  }
  if (openWork) { openWork.done = true; openWork.endAt = entry.at || openWork.endAt; redrawItem(openWork); openWork = null; }
  if (openAgent) { openAgent.streaming = false; redrawItem(openAgent); openAgent = null; }
  pushItem({ kind: entry.role === "user" ? "person" : "agent", text: entry.text, at: entry.at, index: index });
}

function agentById(id) {
  for (var i = 0; i < agents.length; i++) if (agents[i].id === id) return agents[i];
  return null;
}

function select(id, conversation) {
  var switching = id !== current;
  current = id;
  // Selecting an agent selects its box: a link into another box's agent changes the page.
  var owner = agentById(id);
  if (owner && owner.boxId && owner.boxId !== currentBox && boxesSeen.some(function (b) { return b.id === owner.boxId; })) {
    currentBox = owner.boxId;
    renderBoxBar();
  }
  currentConversation = conversation || (switching ? "main" : currentConversation);
  $("title").textContent = nameOf(id);
  var selected = agentById(id);
  $("titlerole").textContent = selected
    ? String(selected.title || "") + (boxesSeen.length > 1 && selected.boxName ? (selected.title ? " · " : "") + "on " + selected.boxName : "")
    : "";
  $("round").textContent = "";
  spend = { input: 0, output: 0 };
  spendLabel = "";
  roundLabel = "";
  renderAgents();
  showDesktop(id);
  if (switching) refreshConversations(id);
  updateComposerTarget();
  resetThread();
  live.delete(id);

  return fetch("/api/transcript?agent=" + encodeURIComponent(id) +
      "&conversation=" + encodeURIComponent(currentConversation))
    .then(function (r) { return r.json(); })
    .then(function (entries) {
      var seenKey = "lumen-seen:" + id + ":" + currentConversation;
      var lastSeen = -1;
      try { lastSeen = Number(localStorage.getItem(seenKey) || "-1"); } catch (error) {}
      var lastDay = "";
      var newShown = false;
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        var day = e.at ? dayLabel(e.at) : "";
        if (day && day !== lastDay) { closeOpen(); pushItem({ kind: "divider", label: day }); lastDay = day; }
        if (!newShown && lastSeen >= 0 && i > lastSeen && e.kind === "text") { closeOpen(); pushItem({ kind: "divider", label: "new", isNew: true }); newShown = true; }
        replayEntry(id, e, i);
      }
      closeOpen();
      // Opened mid-turn: the start event is past, so say it from the state instead.
      if (busy.has(id) && id === current) showWorking();
      try { localStorage.setItem(seenKey, String(entries.length - 1)); } catch (error) {}
      $("chat").scrollTop = $("chat").scrollHeight;
      landMessageFromUrl();
      return loadTemplateCardInChat(id);
    });
}

/* ── the thread panel ─────────────────────────────────────────────────────────
   A native <select> cannot paginate, cannot filter, and renders raw ids; with a
   room's worth of topics it is a wall of uids. This is a list: newest first,
   labelled by channel, the person's first words and age, filterable as you type,
   loading more on demand. */

/** "3m" / "2h" / "5d" — enough to pick the thread from this morning over last week's. */
function fmtAgo(iso) {
  if (!iso) return "";
  var ms = Date.now() - Date.parse(iso);
  if (!isFinite(ms) || ms < 0) return "";
  var minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return minutes + "m";
  if (minutes < 60 * 24) return Math.floor(minutes / 60) + "h";
  return Math.floor(minutes / (60 * 24)) + "d";
}

/** One line for the button: where it came from and what was said. */
function conversationLabel(c) {
  if (!c || c.id === "main") return "Team room";
  var channel = String(c.id).split("-")[0] || "chat";
  var words = c.firstLine ? String(c.firstLine).slice(0, 40) : c.id;
  return channel + " · " + words;
}

var convLoaded = [];      // pages fetched so far, newest first, main pinned on top
var convTotal = 0;
var convAgent = null;     // whose threads convLoaded holds — a cache without an owner
                          // survived agent switches, and Bob's dropdown carried Ada's rooms
var CONV_PAGE = 50;

function fetchConversations(id, offset) {
  return fetch("/api/conversations?agent=" + encodeURIComponent(id) +
      "&limit=" + CONV_PAGE + "&offset=" + offset)
    .then(function (r) { return r.json(); });
}

/** Keeps the button honest: label of the viewed thread, and how many exist. */
function renderConvButton() {
  var btn = $("convbtn");
  if (convTotal <= 1) { btn.style.display = "none"; return; }
  var viewed = null;
  for (var i = 0; i < convLoaded.length; i++) {
    if (convLoaded[i].id === currentConversation) { viewed = convLoaded[i]; break; }
  }
  btn.style.display = "";
  btn.textContent = conversationLabel(viewed || { id: currentConversation }) +
    " (" + convTotal + ") ▾";
}

function renderConvList() {
  var needle = $("convfilter").value.trim().toLowerCase();
  var rows = convLoaded.filter(function (c) {
    if (!needle) return true;
    return (String(c.firstLine || "") + " " + c.id).toLowerCase().indexOf(needle) !== -1;
  }).map(function (c) {
    var channel = c.id === "main" ? "team" : (String(c.id).split("-")[0] || "chat");
    var words = c.id === "main" ? "Team room" : (c.firstLine || c.id);
    return '<a href="#" class="row' + (c.id === currentConversation ? " on" : "") + '" data-conv="' + esc(c.id) + '">' +
      '<span class="when">' + esc(fmtAgo(c.lastAt)) + '</span>' +
      '<span class="who">' + esc(channel) + '</span> ' +
      '<span class="what">' + esc(words) + '</span></a>';
  }).join("");
  $("convlist").innerHTML = rows || '<div class="row dim">Nothing matches</div>';
  // More pages exist and no filter is narrowing: filtering only searches what is
  // loaded, so the link stays visible then too, as the way to widen the search.
  $("convmore").style.display = convLoaded.length < convTotal ? "" : "none";
}

function refreshConversations(id) {
  // Another agent's threads are another agent's: the cache empties before the
  // first byte of the new one arrives, so a slow fetch can never show Ada's
  // rooms under Bob's name.
  if (convAgent !== id) {
    convAgent = id;
    convLoaded = [];
    convTotal = 0;
    renderConvButton();
    if ($("convpanel").style.display !== "none") renderConvList();
  }
  return fetchConversations(id, 0).then(function (data) {
    if (convAgent !== id) return; // the person switched again mid-flight
    var page = data.conversations || [];
    convTotal = data.total !== undefined ? data.total : page.length;
    // A refresh replaces the first page; deeper pages someone loaded stay behind it.
    var deeper = convLoaded.slice(page.length).filter(function (c) {
      return !page.some(function (p) { return p.id === c.id; });
    });
    convLoaded = page.concat(deeper);
    renderConvButton();
    if ($("convpanel").style.display !== "none") renderConvList();
  }).catch(function () {});
}

// A thread that starts while the page is open must be reachable without switching
// agents; the button also keeps its count and label current. The list itself only
// re-renders while the panel is open.
setInterval(function () { if (current) refreshConversations(current); }, 5000);

$("foldall").onclick = function (event) {
  event.preventDefault();
  folded = !folded;
  // Applies to what is on screen and to what arrives next, because a reader who folded
  // the steps away did not mean "until the agent says something else".
  // The same act as clicking every group bar, because two controls that say "fold" and do
  // different things is worse than either one alone.
  var works = document.querySelectorAll("details.work");
  for (var b = 0; b < works.length; b++) works[b].open = !folded;
  for (var t = 0; t < thread.length; t++) if (thread[t].kind === "work") thread[t].open = !folded;
  $("foldall").textContent = folded ? "unfold work" : "fold work";
};

$("convbtn").onclick = function (event) {
  event.preventDefault();
  var panel = $("convpanel");
  var open = panel.style.display !== "none";
  panel.style.display = open ? "none" : "";
  if (!open) {
    $("convfilter").value = "";
    renderConvList();
    $("convfilter").focus();
  }
};

$("convfilter").oninput = function () { renderConvList(); };

$("convlist").onclick = function (event) {
  var row = event.target.closest("[data-conv]");
  if (!row) return;
  event.preventDefault();
  $("convpanel").style.display = "none";
  if (current) select(current, row.getAttribute("data-conv"));
};

$("convmore").onclick = function (event) {
  event.preventDefault();
  if (!current) return;
  fetchConversations(current, convLoaded.length).then(function (data) {
    var page = data.conversations || [];
    convTotal = data.total !== undefined ? data.total : convTotal;
    var known = {};
    convLoaded.forEach(function (c) { known[c.id] = true; });
    convLoaded = convLoaded.concat(page.filter(function (c) { return !known[c.id]; }));
    renderConvList();
  }).catch(function () {});
};

// Clicking anywhere else closes the panel, like every other transient surface.
document.addEventListener("click", function (event) {
  var panel = $("convpanel");
  if (panel.style.display === "none") return;
  if (!$("convwrap").contains(event.target)) panel.style.display = "none";
});

/** The composer says which thread it will reach, so a reply never surprises anyone. */
function updateComposerTarget() {
  var name = nameOf(current);
  var viewed = null;
  for (var i = 0; i < convLoaded.length; i++) {
    if (convLoaded[i].id === currentConversation) { viewed = convLoaded[i]; break; }
  }
  $("input").placeholder = currentConversation === "main"
    ? "Message " + name + "…"
    : "Reply in " + conversationLabel(viewed || { id: currentConversation }) +
      " — reaches that chat, not the team room…";
}

function refresh() {
  return fetch("/api/state").then(function (r) { return r.json(); }).then(function (state) {
    boxesSeen = state.boxes || [];
    agents = state.agents;
    // Who is mid-turn as of this load; the stream carries changes from here on.
    for (var b = 0; b < agents.length; b++) if (agents[b].running) busy.add(agents[b].id);
    // The box in view: the one already chosen, else the agent in view's, else this machine's own.
    if (!currentBox || !boxesSeen.some(function (b) { return b.id === currentBox; })) {
      var viewing = agentById(current);
      currentBox = (viewing && viewing.boxId) || state.own || (boxesSeen[0] && boxesSeen[0].id) || null;
    }
    renderBoxBar();
    allTools = state.allTools || allTools;
    $("model").innerHTML = "<b>" + esc(state.provider) + "</b>";
    boxState = { ok: !!state.box.ok, detail: String(state.box.detail || "") };
    $("boxinfo").textContent = (state.box.ok ? state.box.detail : "box unavailable") +
      (state.boxes && state.boxes.length > 1 ? " · " + state.boxes.length + " boxes (" + state.boxes.filter(function (b) { return b.connected; }).length + " up)" : "");
    $("boxdot").className = "dot " + (state.box.ok ? "ok" : "bad");
    showBoxClass(state.box);
    if (!onboardChecked) {
      onboardChecked = true;
      maybeOnboard();
    }
    if (state.build) {
      $("buildinfo").textContent = "v" + state.build.version + " · " + state.build.commit;
    }
    if (state.usageToday) {
      var today = state.usageToday;
      $("spendtoday").textContent = today.records === 0
        ? ""
        : "today " + fmtTokens(today.inputTokens) + " in / " + fmtTokens(today.outputTokens) + " out";
      // Who spent it, on hover — the per-person breakdown the enterprise framework asks for.
      var by = state.usageByPrincipal || [];
      $("spendtoday").title = by.length
        ? "Today, by person:\n" + by.map(function (p) {
            return "  " + p.name + ": " + fmtTokens(p.inputTokens) + " in / " + fmtTokens(p.outputTokens) + " out";
          }).join("\n")
        : "Tokens spent today, all agents";
    }
    if (!current && agents.length) {
      var wantAgent = new URLSearchParams(location.search).get("agent");
      var wantConv = new URLSearchParams(location.search).get("conversation");
      var known = wantAgent && agents.some(function (a) { return a.id === wantAgent; });
      return select(known ? wantAgent : agents[0].id, known && wantConv ? wantConv : undefined);
    }
    renderAgents();
    // A newly created agent gets its display assigned server-side; keep the pane
    // in step without reloading an unchanged one.
    if (current) showDesktop(current);
    return Promise.all([refreshPolicy(), refreshProgress(), refreshSkills()]);
  });
}

// Every few seconds, because an approval and a ticked-off todo both arrive without an event to ride
// on. Slow enough to be free, fast enough that a person is not kept waiting by the interface.
setInterval(function () { refreshPolicy(); refreshProgress(); }, 4000);
// Skills change when someone writes one, which is rare. Slow enough to be free.
setInterval(refreshSkills, 30000);
// Only while the files tab is open: polling a listing nobody is looking at is work for nothing.
setInterval(function () {
  if ($("filesview").style.display !== "none") refreshFiles();
}, 15000);

/**
 * Anything waiting on a person, and the selected agent's plan.
 *
 * Polled rather than pushed. An approval is created by a turn that then *stops*, so there is no
 * stream of events to ride on — and the alternative to polling is a person watching an agent do
 * nothing while its request sits unseen on the server. Cheap: two small reads every few seconds.
 */
function refreshPolicy() {
  return Promise.all([
    fetch("/api/policy").then(function (r) { return r.json(); }),
    fetch("/api/secrets/requests").then(function (r) { return r.json(); }).catch(function () { return { requests: [] }; }),
    fetch("/api/handover").then(function (r) { return r.json(); }).catch(function () { return { pending: [] }; })
  ])
    .then(function (all) { renderApprovals(all[0].pending || [], all[1].requests || [], all[2].pending || []); })
    .catch(function () { /* a dropped poll is not worth a message; the next one covers it */ });
}

/** An agent asked the person for a secret by name: the value goes to the vault, never to the agent. */
function secretCard(item) {
  return '<div class="consent">' +
    '<div class="chead"><span class="dot"></span>' + esc(item.agentName) + ' needs a secret: <code>' + esc(item.id) + "</code></div>" +
    '<div class="note">' + esc(item.description) + "</div>" +
    '<div class="cactions" style="gap:8px;align-items:center">' +
      '<input type="password" data-secret-input="' + esc(item.id) + '" placeholder="paste the value" autocomplete="off" style="flex:1;height:30px;border-radius:6px;border:1px solid var(--border-strong);background:var(--bg);color:var(--text);padding:0 8px">' +
      '<button class="btn sm accent" data-secret-save="' + esc(item.id) + '">Save securely</button>' +
      '<button class="btn sm ghost" data-secret-dismiss="' + esc(item.id) + '">Dismiss</button>' +
    "</div>" +
    '<div class="note">Stored in this machine\'s vault with a grant to ' + esc(item.agentName) + " only. The agent never sees the value; the box never holds it.</div>" +
  "</div>";
}

/** An agent handed its desktop to the person with one instruction. */
function handoverCard(item) {
  var open = item.desktopPath
    ? '<a class="btn sm" href="' + esc(item.desktopPath) + '" target="_blank" rel="noopener" style="text-decoration:none">Open computer</a>'
    : "";
  return '<div class="consent">' +
    '<div class="chead"><span class="dot"></span>Computer &mdash; ' + esc(item.agentName) + " is waiting for you (" + esc(item.reason) + ")</div>" +
    '<div style="padding:4px 0 8px;font-size:14px">' + esc(item.instruction) + "</div>" +
    '<div class="cactions">' + open +
      '<button class="btn sm accent" data-handback="' + esc(item.agentId) + '">Hand back</button>' +
    "</div>" +
    '<div class="note">When you hand it back the agent is woken and looks at the screen first.</div>' +
  "</div>";
}

function renderApprovals(pending, secretRequests, handovers) {
  secretRequests = secretRequests || [];
  handovers = handovers || [];
  var box = $("approvals");
  if (!pending.length && !secretRequests.length && !handovers.length) {
    box.style.display = "none";
    box.innerHTML = "";
    return;
  }
  box.style.display = "";
  box.innerHTML = pending.map(function (item) {
    // The exact text the fingerprint was taken over. Not a summary of it: consent is given to what
    // is read here, so anything shortened would be consent to something else.
    return '<div class="consent">' +
      '<div class="chead"><span class="dot"></span>Consent needed &mdash; the turn is paused until you answer</div>' +
      "<code>" + esc(item.description) + "</code>" +
      '<div class="note">Each button says what it covers: this exact action, once, for this session, or until you revoke it in Settings. It covers this agent only — never another agent, never another command.</div>' +
      '<div class="cactions">' +
      '<button class="btn sm accent" data-approve="' + esc(item.id) + '" data-scope="once">Allow once</button>' +
      '<button class="btn sm" data-approve="' + esc(item.id) + '" data-scope="session">This session</button>' +
      '<button class="btn sm" data-approve="' + esc(item.id) + '" data-scope="always">Always</button>' +
      '<button class="btn sm ghost" data-deny="' + esc(item.id) + '">Refuse</button>' +
      "</div></div>";
  }).join("") + secretRequests.map(secretCard).join("") + handovers.map(handoverCard).join("");
}

document.getElementById("approvals").addEventListener("click", function (event) {
  var allow = event.target.getAttribute && event.target.getAttribute("data-approve");
  var deny = event.target.getAttribute && event.target.getAttribute("data-deny");
  if (!allow && !deny) return;
  var scope = (event.target.getAttribute && event.target.getAttribute("data-scope")) || "once";
  event.target.disabled = true;
  fetch(allow ? "/api/approve" : "/api/deny", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: allow || deny, scope: scope })
  }).then(function () {
    feed(
      allow
        ? "you allowed an action" +
          (scope === "session" ? " for this session" : scope === "always" ? ", standing until revoked" : "")
        : "you refused an action",
      "warn"
    );
    // The agent does not resume by itself: it was told to stop and ask. Say so, rather than
    // leaving a person waiting for something that is not coming.
    if (allow) feed("send the agent a message to have it retry the approved action", "");
    return refreshPolicy();
  });
});

document.getElementById("stop").addEventListener("click", function () {
  if (!current) return;
  $("stop").disabled = true;
  fetch("/api/stop", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: current })
  }).then(function () {
    // It takes effect at the next round boundary, not instantly — aborting mid-request would leave
    // a tool call with no result. Said here so the delay does not read as the button not working.
    feed("stopping " + esc(nameOf(current)) + " at the end of this round", "warn");
  }).finally(function () { $("stop").disabled = false; });
});

/** The selected agent's plan and todo list, which is what a long task's progress looks like. */
function refreshProgress() {
  if (!current) return Promise.resolve();
  return fetch("/api/progress?agent=" + encodeURIComponent(current) +
      "&conversation=" + encodeURIComponent(currentConversation))
    .then(function (r) { return r.json(); })
    .then(function (state) {
      var head = $("progresshead");
      var list = $("progresslist");
      var todos = state.todos || [];
      var hasPlan = !!(state.plan && state.plan.trim());
      if (!hasPlan && !todos.length) {
        $("progress").style.display = "none";
        return;
      }
      $("progress").style.display = "";
      var done = todos.filter(function (t) { return t.status === "done"; }).length;
      var complete = todos.length > 0 && done === todos.length;
      var planKey = "lumen-plan:" + current + ":" + currentConversation;
      var remembered = null;
      try { remembered = localStorage.getItem(planKey); } catch (error) {}
      var open = remembered === "open" ? true : remembered === "shut" ? false : !complete;
      head.innerHTML = '<details' + (open ? " open" : "") + '><summary><b>plan</b> ' + (hasPlan ? esc(state.plan.split("\n")[0]) : "&mdash;") +
        (todos.length ? ' <span class="dim mono">' + done + "/" + todos.length + " done</span>" : "") +
        ' <span class="dim">' + (open ? "▾" : "▸") + "</span></summary></details>";
      var det = head.querySelector("details");
      det.ontoggle = function () {
        try { localStorage.setItem(planKey, det.open ? "open" : "shut"); } catch (error) {}
        list.style.display = det.open ? "" : "none";
        var arrow = det.querySelector("summary .dim:last-child"); if (arrow) arrow.textContent = det.open ? "▾" : "▸";
      };
      list.style.display = open ? "" : "none";
      list.innerHTML = todos.map(function (t) {
        var mark = t.status === "done" ? "&#10003;" : t.status === "doing" ? "&rarr;" :
          t.status === "blocked" ? "&#9888;" : "&middot;";
        var dim = t.status === "done" ? "opacity:0.5;text-decoration:line-through" : "";
        return '<div style="' + dim + '">' + mark + " " + esc(t.text) + "</div>";
      }).join("");
    })
    .catch(function () {});
}

/**
 * What the agents have produced, as something a person can actually read.
 *
 * The first version of this was a flat list of links in a 150px box. Clicking one opened a new tab,
 * which for markdown — the most common thing an agent writes — shows raw text. So the panel existed
 * and was still useless, which is worse than absent: it looks like the problem was solved.
 *
 * Three things fix it, and none of them needed a desktop app:
 *
 *   - **Preview in place.** Markdown rendered, images and video shown, text and CSV readable. The
 *     point of handing a file over is that someone reads it.
 *   - **Newest first.** "What did the agent just make" is the question people have; alphabetical
 *     order answers a different one.
 *   - **Room.** A tab rather than a strip, so the list and the preview both get height.
 */
var filesDir = "/home/box/work";
var filesSelected = null;

function fileKind(name) {
  var ext = (name.match(/\.[^.]+$/) || [""])[0].toLowerCase();
  if (/^\.(png|jpe?g|webp|gif|svg|bmp|ico)$/.test(ext)) return "image";
  if (/^\.(mp4|webm|mov)$/.test(ext)) return "video";
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (/^\.(txt|log|json|csv|tsv|ya?ml|toml|ini|conf|sh|py|js|ts|tsx|jsx|html?|css|xml|sql|rs|go|java|rb|c|h|cpp|diff|patch)$/.test(ext)) return "text";
  if (ext === ".pdf") return "pdf";
  return "binary";
}

function fmtBytes(n) {
  if (typeof n !== "number") return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

function fmtWhen(iso) {
  if (!iso) return "";
  var then = new Date(iso).getTime();
  if (!then) return "";
  var secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return Math.round(secs / 60) + "m ago";
  if (secs < 86400) return Math.round(secs / 3600) + "h ago";
  return Math.round(secs / 86400) + "d ago";
}

function fileUrl(path, download) {
  return "/api/file?" + (download ? "download=1&" : "") + "path=" + encodeURIComponent(path);
}

function refreshFiles(dir) {
  if (dir) { filesDir = dir; filesSelected = null; }
  $("filespath").textContent = filesDir;
  $("filesup").style.visibility = filesDir === "/home/box/work" ? "hidden" : "";
  return fetch("/api/files?dir=" + encodeURIComponent(filesDir))
    .then(function (r) { return r.json(); })
    .then(function (listing) {
      var entries = (listing.entries || []).slice();
      // Directories first, then newest file first. Two sorts rather than one because a folder's own
      // mtime says nothing about what is in it.
      entries.sort(function (a, b) {
        if ((a.type === "directory") !== (b.type === "directory")) return a.type === "directory" ? -1 : 1;
        if (a.type === "directory") return a.name.localeCompare(b.name);
        return String(b.modified || "").localeCompare(String(a.modified || ""));
      });
      if (!entries.length) {
        $("fileslist").innerHTML = '<div class="dim" style="padding:10px 12px">Nothing here yet. Agents write to this directory; you can drop a file in.</div>';
        return;
      }
      $("fileslist").innerHTML = entries.map(function (e) {
        var full = filesDir.replace(/\/$/, "") + "/" + e.name;
        var on = full === filesSelected ? " on" : "";
        var meta = e.type === "directory" ? "" : fmtBytes(e.size) + " · " + fmtWhen(e.modified);
        return '<div class="row' + on + '" data-path="' + esc(full) + '" data-type="' + esc(e.type) + '">' +
          esc(e.name) + (e.type === "directory" ? "/" : "") +
          '<div class="dim mono" style="font-size:11px">' + esc(meta) + "</div></div>";
      }).join("");
    })
    .catch(function () {
      $("fileslist").innerHTML = '<div class="dim" style="padding:10px 12px">Could not read the work directory.</div>';
    });
}

function previewFile(path) {
  filesSelected = path;
  var name = path.split("/").pop();
  var kind = fileKind(name);
  var head = '<div class="bar" style="border-bottom:1px solid var(--border)"><b>' + esc(name) + "</b>" +
    ' <span><a href="' + fileUrl(path, true) + '">save</a> ' +
    '<a href="' + fileUrl(path) + '" target="_blank" rel="noopener">open</a></span></div>';

  if (kind === "image") {
    $("filespreview").innerHTML = head + '<img src="' + fileUrl(path) + '" alt="' + esc(name) + '">';
    return Promise.resolve();
  }
  if (kind === "video") {
    $("filespreview").innerHTML = head + '<video src="' + fileUrl(path) + '" controls></video>';
    return Promise.resolve();
  }
  if (kind === "pdf" || kind === "binary") {
    // Said rather than guessed at: a binary rendered as text is a screen of noise, and pretending to
    // preview it wastes the one action a person came here to take.
    $("filespreview").innerHTML = head +
      '<div class="dim" style="padding:10px 14px">' +
      (kind === "pdf" ? "PDF — open it in a tab, or save it." : "Not a text file. Save it to look at it.") +
      "</div>";
    return Promise.resolve();
  }

  $("filespreview").innerHTML = head + '<div class="dim" style="padding:10px 14px">Loading…</div>';
  return fetch(fileUrl(path))
    .then(function (r) { return r.text(); })
    .then(function (body) {
      // Markdown through the same renderer as the chat, so a report reads the way the agent meant
      // it to. Everything else escaped into a <pre>: it is text, not markup.
      $("filespreview").innerHTML = head +
        (kind === "markdown"
          ? '<div class="msg" style="padding:10px 14px"><div class="body" style="font-family:var(--font-sans);font-size:0.92rem">' + renderMarkdown(body) + "</div></div>"
          : "<pre>" + esc(body) + "</pre>");
    })
    .catch(function () {
      $("filespreview").innerHTML = head + '<div class="dim" style="padding:10px 14px">Could not read it.</div>';
    });
}

document.getElementById("fileslist").addEventListener("click", function (event) {
  var row = event.target.closest && event.target.closest(".row");
  if (!row) return;
  var path = row.getAttribute("data-path");
  if (row.getAttribute("data-type") === "directory") return refreshFiles(path);
  previewFile(path);
  refreshFiles();
});

document.getElementById("filesup").addEventListener("click", function (event) {
  event.preventDefault();
  refreshFiles(filesDir.replace(/\/[^/]+$/, "") || "/home/box/work");
});
document.getElementById("filesrefresh").addEventListener("click", function (event) {
  event.preventDefault();
  refreshFiles();
});

/** Sends one file into the work directory. The inverse of a download: giving the agent something. */
function uploadOne(file) {
  return new Promise(function (resolve) {
    var reader = new FileReader();
    reader.onload = function () {
      var base64 = String(reader.result).split(",")[1] || "";
      fetch("/api/file", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: filesDir.replace(/\/$/, "") + "/" + file.name, base64: base64 })
      })
        .then(function (r) { return r.json(); })
        .then(function (result) {
          feed(result.error
            ? "upload failed: " + esc(result.error)
            : "added " + esc(file.name) + " to " + esc(filesDir), result.error ? "err" : "");
          resolve();
        })
        .catch(function () { resolve(); });
    };
    reader.onerror = function () { resolve(); };
    reader.readAsDataURL(file);
  });
}

function uploadFiles(list) {
  var files = Array.prototype.slice.call(list || []);
  if (!files.length) return Promise.resolve();
  return files.reduce(function (chain, file) {
    return chain.then(function () { return uploadOne(file); });
  }, Promise.resolve()).then(function () { return refreshFiles(); });
}

document.getElementById("filesupload").addEventListener("change", function (event) {
  uploadFiles(event.target.files);
  event.target.value = "";
});

// Drag and drop, because that is how a person expects to hand over a file.
var filesView = document.getElementById("filesview");
["dragenter", "dragover"].forEach(function (name) {
  filesView.addEventListener(name, function (event) {
    event.preventDefault();
    filesView.classList.add("dropping");
  });
});
["dragleave", "drop"].forEach(function (name) {
  filesView.addEventListener(name, function () { filesView.classList.remove("dropping"); });
});
filesView.addEventListener("drop", function (event) {
  event.preventDefault();
  uploadFiles(event.dataTransfer && event.dataTransfer.files);
});

/** Which of the four views the right-hand pane is showing. */
function showTab(which) {
  $("desktopview").style.display = which === "desktop" ? "" : "none";
  $("filesview").style.display = which === "files" ? "flex" : "none";
  $("tasksview").style.display = which === "tasks" ? "flex" : "none";
  $("autoview").style.display = which === "auto" ? "flex" : "none";
  $("tabdesktop").className = "tab" + (which === "desktop" ? " on" : "");
  $("tabfiles").className = "tab" + (which === "files" ? " on" : "");
  $("tabtasks").className = "tab" + (which === "tasks" ? " on" : "");
  $("tabauto").className = "tab" + (which === "auto" ? " on" : "");
  if (which === "files") refreshFiles();
  if (which === "tasks") refreshTasks();
  if (which === "auto") refreshAutomations();
}
document.getElementById("tabdesktop").addEventListener("click", function (e) { e.preventDefault(); showTab("desktop"); });
document.getElementById("tabfiles").addEventListener("click", function (e) { e.preventDefault(); showTab("files"); });
document.getElementById("tabtasks").addEventListener("click", function (e) { e.preventDefault(); showTab("tasks"); });
document.getElementById("tabauto").addEventListener("click", function (e) { e.preventDefault(); showTab("auto"); });

// ── automations ────────────────────────────────────────────────────────────
//
// The three things a cron expression in a file cannot tell a person: whether the timer
// is armed at all, when this one last actually fired, and where its report goes.

function automationRow(s) {
  var when = esc(s.described) + (s.timezone ? ' <span class="dim">(' + esc(s.timezone) + ")</span>" : "");
  var last = s.running
    ? '<span style="color:var(--accent)">running now</span>'
    : s.lastRun
      ? "last ran " + esc(new Date(s.lastRun).toLocaleString())
      : '<span style="color:var(--warn)">never run</span>';
  // Where it reports is the line that matters most: a skill with no deliver runs and
  // says nothing in any chat, which is right for a tidy-up and looks broken for a brief.
  var where = s.deliver
    ? "reports to " + esc(s.deliver)
    : '<span class="dim">writes files only — no chat hears it</span>';
  // Provenance, not permission: an agent may stand up a routine of its own, and what
  // makes that safe is that the standing commitment says where it came from and what it
  // costs — reviewed afterwards rather than approved beforehand.
  var origin = s.authoredBy
    ? '<span style="color:var(--accent-2);font-size:10.5px;border:1px solid var(--border);border-radius:5px;padding:0 5px">by ' + esc(s.authoredBy) + "</span>"
    : "";
  // Paused is a state a person chose (or a template arrived in): shown, and switchable here.
  var pausedTag = s.paused
    ? '<span style="color:var(--warn);font-size:10.5px;border:1px solid var(--border);border-radius:5px;padding:0 5px">paused</span>'
    : "";
  var toggle = s.paused
    ? '<button class="btn ghost sm" data-resume="' + esc(s.slug) + '">Turn on</button>'
    : '<button class="btn ghost sm" data-pause="' + esc(s.slug) + '">Pause</button>';
  return '<div style="padding:10px 16px;border-bottom:1px solid var(--border)' + (s.paused ? ";opacity:.75" : "") + '">' +
    '<div style="display:flex;gap:9px;align-items:baseline">' +
      '<span style="flex:1;font-size:13px;font-weight:500">' + esc(s.name) + " " + origin + " " + pausedTag + "</span>" +
      toggle +
      '<button class="btn ghost sm" data-run="' + esc(s.slug) + '"' + (s.running || s.paused ? " disabled" : "") + ">Run now</button>" +
    "</div>" +
    '<div class="dim" style="font-size:11px;margin-top:3px">' + when +
      (s.agent ? " · as " + esc(s.agent) : "") + " · " + where + "</div>" +
    '<div class="dim" style="font-size:11px">' + last + ' · <span class="mono">' + esc(s.schedule) + "</span></div>" +
    (s.because ? '<div class="dim" style="font-size:11px;font-style:italic">' + esc(s.because) + "</div>" : "") +
  "</div>";
}

function refreshAutomations() {
  return fetch("/api/schedules")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var list = data.schedules || [];
      $("autostate").innerHTML = data.armed
        ? list.length + " automation" + (list.length === 1 ? "" : "s") + " armed"
        : '<span style="color:var(--warn)">The scheduler is off (AGENTBOX_SCHEDULER=0) — nothing below will fire.</span>';
      $("autolist").innerHTML = list.length
        ? list.map(automationRow).join("")
        : '<div class="dim" style="padding:12px 16px;font-size:13px">Nothing runs by itself. A skill becomes an automation by adding <span class="mono">schedule:</span> to its frontmatter — plus <span class="mono">timezone:</span> if the time was agreed in someone else’s zone, and <span class="mono">deliver:</span> for the chat that should receive the report.</div>';
    })
    .catch(function () {
      $("autolist").innerHTML = '<div class="dim" style="padding:12px 16px">Could not read the automations.</div>';
    });
}

document.getElementById("autorefresh").addEventListener("click", function (e) {
  e.preventDefault();
  refreshAutomations();
});

// A manual fire is the same path as a timed one, so what it proves is what will happen
// at 06:30 — and it deliberately does not count as the scheduled run.
document.getElementById("autolist").addEventListener("click", function (e) {
  var get = function (name) { return e.target && e.target.getAttribute && e.target.getAttribute(name); };
  var toggleSlug = get("data-resume") || get("data-pause");
  if (toggleSlug) {
    e.preventDefault();
    e.target.disabled = true;
    fetch(get("data-resume") ? "/api/schedules/resume" : "/api/schedules/pause", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: toggleSlug }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) alert(data.error);
        setTimeout(refreshAutomations, 400);
      })
      .catch(function () { setTimeout(refreshAutomations, 400); });
    return;
  }
  var slug = get("data-run");
  if (!slug) return;
  e.preventDefault();
  e.target.disabled = true;
  fetch("/api/schedules/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug: slug }),
  })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) alert(data.error);
      setTimeout(refreshAutomations, 400);
    })
    .catch(function () { e.target.disabled = false; });
});

// ── the task board ─────────────────────────────────────────────────────────
var TASK_STATUSES = ["open", "doing", "blocked", "review", "done", "dropped"];

function taskStatusColor(status) {
  if (status === "doing") return "var(--accent)";
  if (status === "blocked") return "var(--warn)";
  if (status === "review") return "var(--accent-2)";
  if (status === "done") return "var(--success)";
  if (status === "dropped") return "var(--muted)";
  return "var(--muted)";
}

/** Which task is expanded, and whether we have already scrolled to a deep-linked one. */
var openTask = new URLSearchParams(location.search).get("task") || "";
var taskScrolled = false;

/**
 * One task, opened out: who owns it, what it cost, and every move anybody made on it.
 *
 * The history is the point. A status alone says where a task is; the history says who
 * put it there and why — including the audit that refused it and the guard that voided
 * an audit. That is the evidence trail a person needs before accepting work, and it is
 * already recorded, so showing it costs nothing but the markup.
 */
function taskDetail(t) {
  var rows = (t.history || []).slice().reverse().map(function (h) {
    var when = new Date(h.at).toLocaleString();
    var who = nameOf(h.by) || h.by;
    return '<div style="display:flex;gap:8px;padding:3px 0;font-size:11px">' +
      '<span class="dim mono" style="white-space:nowrap">' + esc(when) + "</span>" +
      '<span style="white-space:nowrap">' + esc(who) + "</span>" +
      (h.status ? '<span style="color:' + taskStatusColor(h.status) + '">' + esc(h.status) + "</span>" : "") +
      (h.note ? '<span class="dim" style="flex:1;font-style:italic">' + esc(h.note) + "</span>" : "") +
    "</div>" +
    (h.evidence && h.evidence.length
      ? '<div class="dim mono" style="font-size:11px;padding-left:12px">evidence: ' + h.evidence.map(esc).join(" · ") + "</div>"
      : "") +
    (h.checked && h.checked.length
      ? '<div class="dim mono" style="font-size:11px;padding-left:12px">checked: ' + h.checked.map(esc).join(" · ") + "</div>"
      : "");
  }).join("");
  // The conversation is a link only when there is an agent whose transcript to open it
  // in: a conversation without an assignee has nowhere to take you.
  var conversation = t.conversation
    ? (t.assigneeId
        ? '<a href="#" data-openconv="' + esc(t.conversation) + '" data-agent="' + esc(t.assigneeId) + '">' + esc(t.conversation) + "</a>"
        : esc(t.conversation))
    : "the team room";
  return '<div style="margin:8px 0 2px 26px;padding:8px 10px;border-left:2px solid var(--border)">' +
    (t.description ? '<div style="font-size:12px;margin-bottom:6px">' + esc(t.description) + "</div>" : "") +
    '<div class="dim" style="font-size:11px;margin-bottom:6px">' +
      "asked by " + esc(nameOf(t.requester) || t.requester) + " · in " + conversation +
      " · created " + esc(new Date(t.createdAt).toLocaleString()) +
    "</div>" +
    (rows ? '<div style="max-height:220px;overflow:auto">' + rows + "</div>" : "") +
  "</div>";
}

function refreshTasks() {
  // The assignee picker doubles as the roster; refreshed with the board.
  $("taskassign").innerHTML = '<option value="">unassigned</option>' +
    agents.map(function (a) { return '<option value="' + esc(a.id) + '">' + esc(a.name) + "</option>"; }).join("");
  return fetch("/api/tasks")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var tasks = data.tasks || [];
      if (!tasks.length) {
        $("tasklist").innerHTML = '<div class="dim" style="padding:12px 16px;font-size:13px">Nothing on the board. Add a task above, or an agent will when work outlives one reply.</div>';
        return;
      }
      // Live statuses first, closed at the bottom; within a group, newest change first.
      var order = { open: 0, doing: 1, blocked: 2, review: 3, done: 4, dropped: 5 };
      tasks.sort(function (a, b) {
        return (order[a.status] - order[b.status]) || b.updatedAt.localeCompare(a.updatedAt);
      });
      $("tasklist").innerHTML = tasks.map(function (t) {
        var assignee = t.assigneeId ? nameOf(t.assigneeId) : "unassigned";
        var reviewer = t.reviewerId ? " · review by " + esc(nameOf(t.reviewerId)) : "";
        var last = t.history && t.history.length ? t.history[t.history.length - 1] : null;
        var lastNote = last && last.note ? esc(last.note) : "";
        var open = t.id === openTask;
        var proposed = t.proposedBy
          ? ' <span class="chip" style="font-size:10px">proposed</span>' +
            ' <button class="btn sm accent" data-commit="' + esc(t.id) + '" title="Make this proposal real work: agents may take it after you commit">Commit</button>'
          : "";
        return '<div style="padding:10px 16px;border-bottom:1px solid var(--border)' +
            (open ? ";background:var(--surface)" : "") + '">' +
          '<div style="display:flex;gap:9px;align-items:baseline">' +
            '<a href="#" data-open="' + esc(t.id) + '" class="mono" style="font-size:11px;color:var(--muted);text-decoration:none">' + esc(t.id) + "</a>" +
            '<a href="#" data-open="' + esc(t.id) + '" style="flex:1;font-size:13px;font-weight:500;color:var(--text);text-decoration:none">' + esc(t.title) + "</a>" + proposed +
            '<select data-task="' + esc(t.id) + '" style="height:24px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:' + taskStatusColor(t.status) + ';font-size:11px">' +
              TASK_STATUSES.map(function (s) {
                return '<option value="' + s + '"' + (s === t.status ? " selected" : "") + ">" + s + "</option>";
              }).join("") +
            "</select>" +
          "</div>" +
          '<div class="dim" style="font-size:11px;padding-left:26px">' + esc(assignee) + reviewer +
            (lastNote ? ' — <span style="font-style:italic">' + lastNote + "</span>" : "") + "</div>" +
          (open ? taskDetail(t) : "") +
        "</div>";
      }).join("");
      if (openTask) {
        var row = document.querySelector('[data-open="' + openTask + '"]');
        if (row && !taskScrolled) { row.scrollIntoView({ block: "center" }); taskScrolled = true; }
      }
    })
    .catch(function () {});
}

$("taskadd").onclick = function () {
  var title = $("tasknew").value.trim();
  if (!title) return;
  fetch("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: title, assigneeId: $("taskassign").value })
  }).then(function () { $("tasknew").value = ""; refreshTasks(); });
};

// Opening a task, and following it to the conversation it came from. Both are links
// rather than buttons because they are navigation: a person expects to click the id.
document.getElementById("tasklist").addEventListener("click", function (event) {
  var target = event.target;
  if (!target.getAttribute) return;
  var id = target.getAttribute("data-open");
  if (id) {
    event.preventDefault();
    openTask = openTask === id ? "" : id;
    taskScrolled = true;
    refreshTasks();
    return;
  }
  var conversation = target.getAttribute("data-openconv");
  if (conversation) {
    event.preventDefault();
    select(target.getAttribute("data-agent"), conversation);
    showTab("desktop");
  }
});

document.getElementById("tasklist").addEventListener("change", function (event) {
  var commitId = event.target.getAttribute && event.target.getAttribute("data-commit");
  if (commitId) {
    event.preventDefault();
    fetch("/api/tasks/commit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: commitId }) })
      .then(function () { loadTasks(); })
      .catch(function () {});
    return;
  }
  var id = event.target.getAttribute && event.target.getAttribute("data-task");
  if (!id) return;
  fetch("/api/tasks/update", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: id, status: event.target.value })
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      // The review gate may have redirected the move; re-render shows the truth.
      if (d.note) feed(esc(d.note), "warn");
      refreshTasks();
    });
});

// The board changes as agents work; refresh it while it is the visible tab.
setInterval(function () {
  if ($("tasksview").style.display !== "none") refreshTasks();
}, 8000);

/**
 * Turns a work path an agent mentioned into a link.
 *
 * Agents already say "I wrote /home/box/work/report.md", and that was dead text — the single
 * cheapest thing that was missing. Applied after markdown rendering, and skipped inside an existing
 * anchor so a path already formatted as a link is left alone.
 */
function linkifyWorkPaths(html) {
  return html.replace(/(^|[\s>(\[])(\/home\/box\/work\/[^\s<>)\]"']+)/g, function (all, lead, path) {
    var clean = path.replace(/[.,;:]+$/, "");
    var trailing = path.slice(clean.length);
    return lead + '<a href="/api/file?path=' + encodeURIComponent(clean) +
      '" target="_blank" rel="noopener">' + clean + "</a>" + trailing;
  });
}

/**
 * The composer's "/" menu.
 *
 * Picking a skill inserts its *name* as an ordinary instruction rather than pasting its body. Two
 * reasons: the body can be pages long and nobody wants that in their message, and the agent already
 * has the index in its prompt — so it reads the current version of the file rather than whatever was
 * pasted at the time. A message that carries a stale copy of a recipe is worse than one that names it.
 */
var skills = [];
var slashIndex = 0;

function refreshSkills() {
  return fetch("/api/skills")
    .then(function (r) { return r.json(); })
    .then(function (payload) {
      skills = payload.skills || [];
      // A skill nobody can choose is worth complaining about once, in the feed: the agent silently
      // never picks it, and only the person who wrote it can fix it.
      (payload.problems || []).forEach(function (problem) {
        if (!seenSkillProblems[problem]) {
          seenSkillProblems[problem] = true;
          feed("skill not usable &mdash; " + esc(problem), "warn");
        }
      });
    })
    .catch(function () {});
}
var seenSkillProblems = {};

function slashQuery() {
  var value = $("input").value;
  // Only when "/" opens the message: mid-sentence a slash is a path or a date, and popping a menu
  // over someone typing /home/box/work would be worse than having no menu.
  var match = /^\/([^\s]*)$/.exec(value);
  return match ? match[1].toLowerCase() : null;
}

function slashMatches(query) {
  return skills.filter(function (skill) {
    return skill.name.toLowerCase().indexOf(query) >= 0 || skill.slug.indexOf(query) >= 0;
  });
}

function renderSlash() {
  var query = slashQuery();
  var menu = $("slashmenu");
  if (query === null) { menu.style.display = "none"; return; }
  var found = slashMatches(query);
  if (!found.length) {
    menu.style.display = "";
    menu.innerHTML = '<div class="dim" style="padding:8px 11px">' +
      (skills.length ? "No skill matches." : "No skills yet. Ask an agent to write one when it works something out.") +
      "</div>";
    return;
  }
  if (slashIndex >= found.length) slashIndex = 0;
  menu.style.display = "";
  menu.innerHTML = found.map(function (skill, index) {
    return '<div class="row' + (index === slashIndex ? " on" : "") + '" data-skill="' + esc(skill.name) + '">' +
      "<b>" + esc(skill.name) + "</b>" +
      '<div class="dim" style="font-size:11px">' + esc(skill.description) + "</div></div>";
  }).join("");
}

// ── @ mentions (the composer names a teammate) ───────────────────────────────────────
var mentionIndex = 0;
/** The @word at the caret, or null when the caret is not in one. */
function mentionQuery() {
  var input = $("input");
  var before = input.value.slice(0, input.selectionStart);
  var m = /(^|\s)@([^\s@]*)$/.exec(before);
  return m ? m[2] : null;
}
function mentionMatches(query) {
  var q = query.toLowerCase();
  return agentsInView().filter(function (a) { return !q || a.name.toLowerCase().indexOf(q) >= 0; }).slice(0, 8);
}
function renderMention() {
  var query = mentionQuery();
  var menu = $("slashmenu");
  if (query === null) return false;
  var found = mentionMatches(query);
  menu.style.display = "";
  if (!found.length) { menu.innerHTML = '<div class="dim" style="padding:8px 11px">No agent in this box matches.</div>'; return true; }
  if (mentionIndex >= found.length) mentionIndex = 0;
  menu.innerHTML = found.map(function (a, index) {
    return '<div class="row' + (index === mentionIndex ? " on" : "") + '" data-mention="' + esc(a.name) + '">' +
      '<span class="peerdot" style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:' + colorOfName(a.name) + '"></span>' +
      "<b>" + esc(a.name) + "</b>" + (a.id === current ? ' <span class="dim">(this chat)</span>' : "") +
      '<div class="dim" style="font-size:11px">' + esc(a.title || a.description || "") + "</div></div>";
  }).join("");
  return true;
}
function chooseMention(name) {
  var input = $("input");
  var before = input.value.slice(0, input.selectionStart);
  var after = input.value.slice(input.selectionStart);
  var replaced = before.replace(/(^|\s)@[^\s@]*$/, "$1@" + name + " ");
  input.value = replaced + after;
  input.selectionStart = input.selectionEnd = replaced.length;
  $("slashmenu").style.display = "none";
  input.focus();
}
/** "@Name …" at the start of a message is addressed to Name: it goes to that agent's chat. */
function addressedTo(text) {
  var m = /^@(\S+)\s*/.exec(text);
  if (!m) return null;
  var name = m[1].toLowerCase();
  var hit = null;
  for (var i = 0; i < agents.length; i++) if (agents[i].name.toLowerCase() === name) hit = agents[i];
  return hit ? { agent: hit, rest: text.slice(m[0].length) } : null;
}

function chooseSkill(name) {
  $("slashmenu").style.display = "none";
  // Phrased as an instruction, because that is what it is. The agent resolves the name against the
  // index it already has.
  $("input").value = "Use the " + name + " skill.";
  $("input").focus();
}

document.getElementById("slashmenu").addEventListener("mousedown", function (event) {
  var mention = event.target.closest && event.target.closest("[data-mention]");
  if (mention) { event.preventDefault(); chooseMention(mention.getAttribute("data-mention")); return; }
  var row = event.target.closest && event.target.closest("[data-skill]");
  if (!row) return;
  event.preventDefault();
  chooseSkill(row.getAttribute("data-skill"));
});

// --- live events ----------------------------------------------------------

var stream = new EventSource("/api/events");

/**
 * The activity line for an event, or null if it does not belong in the feed.
 *
 * Shared by the live stream and by the replay of recent activity on load, so a
 * reloaded page reads the same as one that was open the whole time.
 */
/** An agent's name in its identity color, for the feed. */
function who(name) {
  return '<b style="color:' + colorOfName(name) + '">' + esc(name) + "</b>";
}

function activityLine(e) {
  if (e.type === "prompt") return { html: "<b>you</b> &rarr; " + who(nameOf(e.agentId)), cls: "" };
  if (e.type === "turn_started") return { html: who(nameOf(e.agentId)) + " started a turn", cls: "" };
  if (e.type === "tool_start") return { html: who(e.agentName) + " &rarr; " + esc(e.tool), cls: "" };
  if (e.type === "message_sent") {
    return {
      html: who(e.fromName) + " &rarr; " + who(e.toName) +
        (e.priority ? " (priority)" : "") + ": " + esc(String(e.text).slice(0, 90)),
      cls: "mail"
    };
  }
  if (e.type === "turn_failed") {
    return { html: who(nameOf(e.agentId)) + " failed: " + esc(e.error), cls: "err" };
  }
  if (e.type === "turn_interrupted") {
    return { html: who(nameOf(e.agentId)) + " interrupted (" + esc(e.reason) + ")", cls: "warn" };
  }
  if (e.type === "error") return { html: esc(e.message), cls: "err" };
  if (e.type === "question") return { html: who(e.agentName) + " asked: " + esc(String(e.question).slice(0, 90)), cls: "warn" };
  if (e.type === "template_import") {
    return { html: who(e.agentName) + " &larr; template: " + esc(e.summary), cls: e.complete && /but not all/.test(e.summary) ? "warn" : "" };
  }
  return null;
}

/** What happened before this page was opened. The feed used to start blank on reload. */
function loadActivity() {
  return fetch("/api/activity")
    .then(function (r) { return r.json(); })
    .then(function (events) {
      for (var i = 0; i < events.length; i++) {
        var line = activityLine(events[i]);
        if (line) feed(line.html, line.cls, events[i].at);
      }
    })
    .catch(function () { /* an empty feed is not worth an error row */ });
}

/** Tokens as a person reads them: exact until it stops being useful. */
function fmtTokens(n) {
  if (n < 10000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(n < 100000 ? 1 : 0) + "k";
  return (n / 1000000).toFixed(1) + "M";
}

var spend = { input: 0, output: 0 };
var spendLabel = "";
var roundLabel = "";

/**
 * Whether an event belongs in the conversation the middle pane is showing.
 *
 * The activity feed stays global — it is cross-agent on purpose — but a chat bubble
 * must match both the selected agent and the selected thread, or a Telegram reply
 * would splice itself into the team room the operator is reading. An event with no
 * conversation is the main room, matching how a pre-conversations turn is stored.
 */
function inView(e) {
  return e.agentId === current && (e.conversation || "main") === currentConversation;
}

stream.onmessage = function (raw) {
  var e = JSON.parse(raw.data);
  var line = activityLine(e);
  if (line) feed(line.html, line.cls);

  if (e.type === "prompt") {
    if (inView(e)) { closeOpen(); pushItem({ kind: "person", text: e.text, at: new Date().toISOString() }); }
    return;
  }

  if (e.type === "template_staged") {
    if (inView(e)) loadTemplateCardInChat(e.agentId);
    return;
  }

  if (e.type === "text") {
    if (!inView(e)) return;
    // Prose is a message. If the agent was mid-work, that work is done; what follows is a
    // new message, drawn the same way whether it turns out to be the answer or a sentence
    // before more calls. Nothing is shrunk or re-filed later.
    if (openWork) { openWork.done = true; openWork.endAt = new Date().toISOString(); redrawItem(openWork); openWork = null; }
    if (!openAgent) openAgent = pushItem({ kind: "agent", text: "", at: new Date().toISOString(), streaming: true });
    openAgent.text += e.delta;
    if (!openAgent.queued) {
      openAgent.queued = true;
      requestAnimationFrame(function () {
        var item = openAgent && openAgent.queued ? openAgent : null;
        if (!item) return;
        item.queued = false;
        var chat = $("chat"), stick = nearBottom(chat);
        var body = item.node && item.node.querySelector(".body");
        if (body) { body.innerHTML = renderMarkdown(item.text); item.node.__md = item.text; addCodeCopy(body); }
        if (stick) chat.scrollTop = chat.scrollHeight;
      });
    }
    return;
  }

  if (e.type === "tool_start") {
    if (!inView(e)) return;
    if (openAgent) { openAgent.streaming = false; openAgent.queued = false; redrawItem(openAgent); openAgent = null; }
    if (!openWork) openWork = pushItem({ kind: "work", calls: [], startAt: new Date().toISOString(), done: false });
    var call = { name: e.tool, detail: toolDetail(e.tool, e.input), result: "", isError: false };
    openWork.calls.push(call);
    redrawItem(openWork);
    openCall.set(e.agentId, { work: openWork, call: call });
    return;
  }

  if (e.type === "tool_end") {
    var pending = openCall.get(e.agentId);
    openCall.delete(e.agentId);
    if (!inView(e) || !pending) return;
    pending.call.result = e.summary || "";
    if (e.screenshot) pending.call.shot = e.screenshot;
    redrawItem(pending.work);
    return;
  }

  if (e.type === "message_sent") {
    // Teammates talk in the team room, never inside someone's outside chat, so these
    // only render when the team room is the one on screen.
    if (currentConversation !== "main") return;
    // Both sides, in their own chat: the sender's record of messaging a teammate, and
    // the recipient's of being messaged. Without the second, the pane jumps from
    // nothing to a reply and what prompted it only shows up on reload.
    if (e.toId === current) { closeOpen(); pushItem({ kind: "teammate", from: e.fromName, text: e.text, priority: e.priority, at: new Date().toISOString() }); }
    else if (e.fromId === current) pushItem({ kind: "sent", to: e.toName, text: e.text, priority: e.priority, at: new Date().toISOString() });
    return;
  }

  if (e.type === "turn_started") {
    busy.add(e.agentId); renderAgents();
    if (inView(e)) showWorking();
    return;
  }

  if (e.type === "question") {
    if (!inView(e)) return;
    closeOpen();
    openQuestion = pushItem({ kind: "question", question: e.question, options: e.options || [], at: new Date().toISOString() });
    return;
  }

  if (e.type === "turn_finished") {
    // No longer running, so the stop button goes away rather than staying to be clicked at nothing.
    if (e.agentId === current) $("stop").style.display = "none";
    if (inView(e)) { closeOpen(); dropWorking(); }
    busy.delete(e.agentId); live.delete(e.agentId); renderAgents();
    // A teammate that just worked may be new to this page, or have new history.
    refresh();
    return;
  }

  if (e.type === "turn_failed") {
    if (inView(e)) dropWorking();
    busy.delete(e.agentId); renderAgents();
    return;
  }

  if (e.type === "round") {
    if (inView(e)) {
      // A round starting is the clearest signal a turn is live, and the only one that is not a guess.
      $("stop").style.display = "";
      roundLabel = "round " + (e.round + 1);
      $("round").textContent = spendLabel ? roundLabel + " · " + spendLabel : roundLabel;
    }
    return;
  }

  if (e.type === "box_setup") {
    // Docker output while the box comes up, into the settings dialog's log — not the
    // activity feed, which an image pull would flood with a hundred lines.
    var boxLog = $("setboxlog");
    boxLog.style.display = "";
    boxLog.textContent += e.line + "\n";
    boxLog.scrollTop = boxLog.scrollHeight;
    if (e.done) {
      refresh().then(renderBoxSection);
      feed(e.ok ? "the box is up" : "starting the box failed — " + esc(e.line), e.ok ? "mail" : "err");
    }
    return;
  }

  if (e.type === "retrying") {
    // Explained rather than left as a pause. A silent gap while a connection is retried is
    // indistinguishable from a hang, and a person watching one reaches for the reload button.
    feed(
      "<b>" + esc(nameOf(e.agentId)) + "</b> retrying round " + (e.round + 1) +
        " in " + Math.round(e.delayMs / 100) / 10 + "s &mdash; " + esc(e.detail),
      "warn"
    );
    if (inView(e) && e.discardPartial) {
      // The partial answer exists only here: nothing was written to the transcript, so dropping it
      // is what stops the retry showing the same text twice.
      var last = $("chat").lastElementChild;
      if (last && last.getAttribute("data-partial") === "1") last.remove();
    }
    return;
  }

  if (e.type === "usage") {
    // Shown while it is being spent, not after: a turn that is costing more than it should is
    // something to notice during, and this is the only number that says so.
    if (!inView(e)) return;
    spend.input += e.inputTokens;
    spend.output += e.outputTokens;
    spendLabel = fmtTokens(spend.input) + " in / " + fmtTokens(spend.output) + " out";
    $("round").textContent = roundLabel ? roundLabel + " · " + spendLabel : spendLabel;
    return;
  }

};

stream.onerror = function () {
  feed("event stream dropped &mdash; reload the page to reconnect", "err");
};

// --- input ----------------------------------------------------------------

$("form").onsubmit = function (event) {
  event.preventDefault();
  var text = $("input").value.trim();
  if (!text || !current) return;
  // "@Bob do X" from Ada's chat goes to Bob, as it would in a group: the page switches to
  // Bob and sends the rest there. A mention in the middle of a sentence stays as text —
  // the agent reads names and messages a teammate itself.
  var target = current, conversation = currentConversation, addressed = addressedTo(text);
  if (addressed && addressed.agent.id !== current && addressed.rest.trim()) {
    target = addressed.agent.id; conversation = "main"; text = addressed.rest.trim();
    select(target);
    feed("to " + esc(addressed.agent.name), "");
  }
  $("input").value = "";
  $("send").disabled = true;
  fetch("/api/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Send to the thread on screen, not always the team room: reading a chat thread
    // and replying should reach that chat, not surface in the room the reader left.
    body: JSON.stringify({ agent: target, text: text, conversation: conversation })
  }).then(function (res) {
    if (!res.ok) return res.text().then(function (t) { feed("prompt rejected: " + esc(t), "err"); });
  }).catch(function (error) {
    feed("prompt failed: " + esc(error.message), "err");
  }).then(function () {
    $("send").disabled = false;
    $("input").focus();
  });
};

// Enter is overloaded, and an IME has the stronger claim on it: while composing,
// Enter accepts the candidate. That keydown reaches the page looking like a
// deliberate send, and sending on it throws away a half-composed sentence — the
// characters chosen so far go out as the message and the rest of the thought is
// lost. Anyone typing Chinese, Japanese or Korean hits this on their first line.
var composing = false;
var compositionEndedAt = 0;

$("input").addEventListener("compositionstart", function () {
  composing = true;
});
$("input").addEventListener("compositionend", function () {
  composing = false;
  compositionEndedAt = Date.now();
});

$("input").addEventListener("input", function () {
  slashIndex = 0; mentionIndex = 0;
  if (!renderMention()) renderSlash();
});

$("input").onkeydown = function (event) {
  // The slash menu takes the arrow keys and Enter while it is open, and nothing else — Escape
  // closes it so a person who opened it by accident is not trapped.
  var menu = $("slashmenu");
  if (menu.style.display !== "none" && mentionQuery() !== null) {
    var names = mentionMatches(mentionQuery());
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      mentionIndex = (mentionIndex + (event.key === "ArrowDown" ? 1 : -1) + names.length) % Math.max(1, names.length);
      renderMention();
      return;
    }
    if (event.key === "Escape") { event.preventDefault(); menu.style.display = "none"; return; }
    if ((event.key === "Enter" || event.key === "Tab") && names.length > 0) {
      if (event.isComposing || event.keyCode === 229 || composing) return;
      if (Date.now() - compositionEndedAt < 50) return;
      event.preventDefault();
      chooseMention(names[mentionIndex].name);
      return;
    }
  }
  if (menu.style.display !== "none" && slashQuery() !== null) {
    var found = slashMatches(slashQuery());
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      slashIndex = (slashIndex + (event.key === "ArrowDown" ? 1 : -1) + found.length) % Math.max(1, found.length);
      renderSlash();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      menu.style.display = "none";
      return;
    }
    // Enter picks, but never mid-composition: an IME accepting a candidate sends the same key, and
    // stealing it would make the menu unusable for anyone typing Chinese.
    if (event.key === "Enter" && !event.shiftKey && found.length > 0) {
      if (event.isComposing || event.keyCode === 229 || composing) return;
      if (Date.now() - compositionEndedAt < 50) return;
      event.preventDefault();
      chooseSkill(found[slashIndex].name);
      return;
    }
  }

  if (event.key !== "Enter" || event.shiftKey) return;

  // isComposing is the standard signal (Chrome, Firefox, Edge); keyCode 229 is the
  // older one some IMEs still send; the flag covers anything that sets neither.
  if (event.isComposing || event.keyCode === 229 || composing) return;

  // Safari delivers the accepting Enter *after* compositionend with isComposing
  // false, so none of the checks above can see it. Nothing legitimate arrives this
  // fast: a second, deliberate Enter needs the key released and pressed again.
  if (Date.now() - compositionEndedAt < 50) return;

  event.preventDefault();
  $("form").requestSubmit();
};

/**
 * The box's clipboard, in both directions.
 *
 * The desktop is a VNC canvas, so text cannot be typed into it from here and text copied
 * inside it cannot be got out. Writing puts it on the box's CLIPBOARD selection, ready
 * for a Ctrl+V in the desktop; reading pulls it back and, where the browser allows it,
 * onto the host clipboard too — the click is the user gesture that permission needs.
 */
function clipboard(text) {
  var body = { agent: current };
  if (text !== undefined) body.text = text;
  return fetch("/api/clipboard", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }).then(function (r) {
    return r.json().then(function (data) {
      if (!r.ok) throw new Error(data.error || "clipboard failed");
      return data;
    });
  });
}

function flashButton(button, label) {
  var original = button.textContent;
  button.textContent = label;
  setTimeout(function () { button.textContent = original; }, 1200);
}

$("clipin").onclick = function () {
  if (!current) return;
  var text = $("cliptext").value;
  if (!text) return;
  clipboard(text).then(function () {
    flashButton($("clipin"), "on the box");
  }).catch(function (error) {
    feed("clipboard: " + esc(error.message), "err");
  });
};

$("clipout").onclick = function () {
  if (!current) return;
  clipboard().then(function (data) {
    $("cliptext").value = data.text;
    if (!data.text) {
      flashButton($("clipout"), "empty");
      return;
    }
    // Best effort: this needs a secure context and permission, and the field is
    // already filled either way, so a refusal is not worth an error row.
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(data.text).then(function () {
        flashButton($("clipout"), "copied here");
      }, function () {
        flashButton($("clipout"), "in the field");
      });
    } else {
      flashButton($("clipout"), "in the field");
    }
  }).catch(function (error) {
    feed("clipboard: " + esc(error.message), "err");
  });
};

/**
 * Recording the desktop.
 *
 * A transcript says what an agent claims it did and a screenshot shows one instant;
 * neither answers "what did it actually do" after the screen has moved on. The file
 * lands on the box's work volume, so it outlives the container, and opens in a tab
 * rather than an embedded player — the browser plays fragmented MP4 natively.
 */
var recording = null;

function renderRecordings(list) {
  var box = $("recordings");
  if (!list || !list.length) {
    box.style.display = "none";
    return;
  }
  var html = "<b>recordings</b> ";
  for (var i = 0; i < Math.min(list.length, 6); i++) {
    var item = list[i];
    var size = item.size_bytes ? Math.round(item.size_bytes / 1024) + "KB" : "recording…";
    html += '<a href="/recording?name=' + encodeURIComponent(item.file) + '" target="_blank"' +
      ' rel="noopener">' + esc(item.file.replace(/\.mp4$/, "")) + " (" + size + ")</a>";
  }
  box.innerHTML = html;
  box.style.display = "";
}

function loadRecordings() {
  return fetch("/api/recordings")
    .then(function (r) { return r.json(); })
    .then(function (data) { renderRecordings(data.recordings); })
    .catch(function () { /* the box may be down; the pane just stays hidden */ });
}

$("rec").onclick = function (event) {
  event.preventDefault();
  if (!current) return;
  var starting = recording === null;
  var link = $("rec");
  link.textContent = starting ? "starting…" : "stopping…";

  fetch("/api/record", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: current, action: starting ? "start" : "stop" })
  }).then(function (r) {
    return r.json().then(function (data) {
      if (!r.ok) throw new Error(data.error || "failed");
      return data;
    });
  }).then(function (data) {
    recording = starting ? data.file : null;
    link.textContent = starting ? "■ stop" : "● record";
    link.className = starting ? "on" : "";
    if (!starting) feed("recording saved: " + esc(data.file), "mail");
    return loadRecordings();
  }).catch(function (error) {
    link.textContent = "● record";
    link.className = "";
    recording = null;
    feed("recording: " + esc(error.message), "err");
  });
};

// ── creating and configuring agents ────────────────────────────────────────
// One dialog, two modes. The previous version used window.prompt, which the desktop
// shell does not implement: the + button did nothing, silently.
var agentModal = { mode: "new", id: null, tools: {} };
/** The boxes the last /api/state reported, own first. More than one shows the box column. */
var boxesSeen = [];

function renderBoxSelect(agent) {
  var select = $("agbox");
  var html = "";
  for (var i = 0; i < boxesSeen.length; i++) {
    var b = boxesSeen[i];
    html += '<option value="' + esc(b.id) + '"' + (agent && agent.boxId === b.id ? " selected" : "") + (b.connected ? "" : " disabled") + ">" +
      esc(b.name) + (i === 0 ? " (own)" : "") + (b.connected ? "" : " — not connected") + "</option>";
  }
  select.innerHTML = html || '<option value="">(no box)</option>';
  // Chosen once: in Configure the field shows where the agent is and cannot change it.
  select.disabled = !!agent;
}
var agentCatalog = { experts: [], crews: [] };

function loadAgentCatalog() {
  return fetch("/api/catalog")
    .then(function (r) { return r.status === 403 ? null : r.json(); })
    .then(function (data) {
      if (!data) return;
      agentCatalog.experts = data.experts || [];
      agentCatalog.crews = data.crews || [];
    })
    .catch(function () { /* catalog is optional on a broken page */ });
}

function renderAgentCatalog() {
  var html = "";
  for (var i = 0; i < agentCatalog.experts.length; i++) {
    var expert = agentCatalog.experts[i];
    html += '<span class="toolchip" data-kind="expert" data-slug="' + esc(expert.slug) + '">' +
      esc(expert.title) + " · " + esc(expert.name) + "</span>";
  }
  for (var j = 0; j < agentCatalog.crews.length; j++) {
    var crew = agentCatalog.crews[j];
    html += '<span class="toolchip" data-kind="crew" data-slug="' + esc(crew.slug) + '">' +
      esc(crew.name) + "</span>";
  }
  $("agcatalog").innerHTML = html || "<span class=\"fieldnote\">No catalog loaded.</span>";
}

function installCrew(slug, boxId) {
  fetch("/api/catalog/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug: slug, boxId: boxId || undefined })
  })
    .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || "install failed"); return d; }); })
    .then(function (d) {
      $("agentwrap").style.display = "none";
      return refresh().then(function () { if (d.created && d.created[0]) return select(d.created[0].id); });
    })
    .catch(function (error) { $("agstatus").textContent = "Install failed: " + error.message; })
    .then(function () { $("agsave").disabled = false; });
}

$("agcatalog").onclick = function (event) {
  var chip = event.target.closest ? event.target.closest("[data-slug]") : null;
  if (!chip) return;
  var slug = chip.getAttribute("data-slug");
  var kind = chip.getAttribute("data-kind");
  if (kind === "crew") {
    // A look first, then a yes: the chip used to install the whole crew on one click,
    // into the first box, with no way to read what it was. Now it shows the members and
    // waits for the button; the crew lands in the box chosen in the form.
    var crew = null;
    for (var c = 0; c < (agentCatalog.crews || []).length; c++) if (agentCatalog.crews[c].slug === slug) crew = agentCatalog.crews[c];
    var members = crew ? (crew.members || []).map(function (m) {
      var slugOf = typeof m === "string" ? m : (m && m.slug) || "";
      var e = null;
      for (var q = 0; q < agentCatalog.experts.length; q++) if (agentCatalog.experts[q].slug === slugOf) e = agentCatalog.experts[q];
      if (e) return e.name + "（" + e.title + "）— " + e.summary;
      return typeof m === "string" ? m : ((m && m.name) || slugOf) + (m && m.title ? "（" + m.title + "）" : "");
    }) : [];
    var boxSel = $("agbox");
    var boxName = boxSel && boxSel.options[boxSel.selectedIndex] ? boxSel.options[boxSel.selectedIndex].textContent : "this box";
    // Right under the chips, where the eye is — not at the far bottom of the dialog.
    var preview = $("agcatalogpreview");
    preview.style.display = "";
    preview.innerHTML = '<div><b>' + esc(crew ? crew.name : slug) + "</b> — " + esc(crew ? crew.summary : "") + "</div>" +
      '<ul style="margin:6px 0 8px 16px;padding:0">' + members.map(function (m) { return "<li>" + esc(m) + "</li>"; }).join("") + "</ul>" +
      '<button class="btn sm accent" id="agcrewgo" type="button">Create these ' + members.length + " in " + esc(boxName) + "</button>" +
      ' <button class="btn sm ghost" id="agcrewno" type="button">Not now</button>';
    $("agcrewno").onclick = function () { preview.style.display = "none"; preview.innerHTML = ""; };
    $("agcrewgo").onclick = function () {
      $("agcrewgo").disabled = true;
      preview.innerHTML = "Adding " + esc(crew ? crew.name : slug) + "…";
      $("agsave").disabled = true;
      installCrew(slug, boxSel ? boxSel.value : undefined);
    };
    return;
  }
  if (false) {
    fetch("/api/catalog/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: slug })
    })
      .then(function (r) {
        return r.json().then(function (d) {
          if (!r.ok) throw new Error(d.error || "install failed");
          return d;
        });
      })
      .then(function (d) {
        $("agentwrap").style.display = "none";
        return refresh().then(function () {
          if (d.created && d.created[0]) return select(d.created[0].id);
        });
      })
      .catch(function (error) { $("agstatus").textContent = "Install failed: " + error.message; })
      .then(function () { $("agsave").disabled = false; });
    return;
  }
  var row = null;
  for (var k = 0; k < agentCatalog.experts.length; k++) {
    if (agentCatalog.experts[k].slug === slug) row = agentCatalog.experts[k];
  }
  if (!row) return;
  $("agname").value = row.name;
  $("agrole").value = row.title;
  $("agpersona").value = row.description;
  var granted = row.tools || [];
  agentModal.tools = {};
  var chips = document.querySelectorAll("#agtools .toolchip");
  for (var n = 0; n < chips.length; n++) {
    var tool = chips[n].getAttribute("data-tool");
    var on = granted.indexOf(tool) >= 0;
    agentModal.tools[tool] = on;
    chips[n].className = "toolchip" + (on ? " on" : "");
  }
  $("agstatus").textContent = row.summary;
};

// ── templates (docs/29) ────────────────────────────────────────────────────
/**
 * The share card: what a staged version carries, and the two things a person can do with
 * it — download the file, or publish it to the control plane for a link. Nothing leaves the
 * box until one of those is clicked; the bot cannot click either.
 */
function templateCardHtml(info) {
  var share = info.share
    ? '<div style="margin-top:6px;font-size:12px">Published (' + esc(info.share.visibility) + '): <a href="' + esc(info.share.url) + '" target="_blank">' + esc(info.share.url) + '</a> ' +
      '<button class="btn sm ghost" data-unpublish="' + esc(info.agentId) + '">Unpublish</button></div>'
    : info.canPublish
      ? '<div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="btn sm" data-publish="' + esc(info.agentId) + '" data-version="' + esc(String(info.version)) + '" data-visibility="public">Publish a link</button>' +
        '<button class="btn sm ghost" data-publish="' + esc(info.agentId) + '" data-version="' + esc(String(info.version)) + '" data-visibility="tenant">Team only</button>' +
        "</div>"
      : '<div class="dim" style="margin-top:6px;font-size:11px">Links need a control plane; this box has none, so the file is the way to share.</div>';
  return '<div class="consent" data-template-card="' + esc(info.agentId) + '" style="margin:8px 0">' +
    '<div class="chead"><span class="dot"></span>Template staged &mdash; version ' + esc(String(info.version)) + ', not shared until you say so</div>' +
    '<div style="font-size:13px;font-weight:500;margin-top:4px">' + esc(info.name) + '</div>' +
    '<div style="font-size:12px;margin-top:2px">' + esc(info.description) + '</div>' +
    '<div class="dim" style="font-size:11px;margin-top:4px">' + esc(info.counts) + "</div>" +
    '<div style="margin-top:6px"><a href="/api/templates/download?agent=' + encodeURIComponent(info.agentId) + '&version=' + esc(String(info.version)) + '" style="font-size:12px">Download the file</a></div>' +
    share +
    '<div class="dim" id="tplstatus-' + esc(info.agentId) + '" style="font-size:11px;margin-top:4px"></div>' +
  "</div>";
}

function showTemplateCard(info) {
  var old = document.querySelector('[data-template-card="' + info.agentId + '"]');
  if (old) old.remove();
  $("chat").insertAdjacentHTML("beforeend", templateCardHtml(info));
  $("chat").scrollTop = $("chat").scrollHeight;
}

/** The latest staged version for the agent in view, if any, rendered after the transcript. */
function loadTemplateCardInChat(agentId) {
  return fetch("/api/templates/mine?agent=" + encodeURIComponent(agentId))
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var versions = data.versions || [];
      if (!versions.length || current !== agentId) return;
      var latest = versions[versions.length - 1];
      showTemplateCard({
        agentId: agentId,
        version: latest.version,
        name: latest.name,
        description: latest.description,
        counts: latest.counts || "",
        share: data.share || null,
        canPublish: !!data.canPublish
      });
    })
    .catch(function () { /* no card is not an error */ });
}

$("chat").addEventListener("click", function (e) {
  var get = function (name) { return e.target && e.target.getAttribute && e.target.getAttribute(name); };
  var publish = get("data-publish");
  var unpublish = get("data-unpublish");
  if (!publish && !unpublish) return;
  e.preventDefault();
  e.target.disabled = true;
  var agentId = publish || unpublish;
  var status = $("tplstatus-" + agentId);
  if (status) status.textContent = publish ? "Publishing…" : "Unpublishing…";
  fetch(publish ? "/api/templates/publish" : "/api/templates/unpublish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(publish
      ? { agent: agentId, version: Number(get("data-version")), visibility: get("data-visibility") }
      : { agent: agentId })
  })
    .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || "failed"); return d; }); })
    .then(function () { return loadTemplateCardInChat(agentId); })
    .catch(function (err) {
      e.target.disabled = false;
      if (status) status.textContent = String(err.message || err);
    });
});

function loadTemplateCard(agentId) {
  $("agtemplate").textContent = "Loading…";
  $("agdownload").style.display = "none";
  return fetch("/api/templates/mine?agent=" + encodeURIComponent(agentId))
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var versions = data.versions || [];
      var origin = data.importedFrom
        ? "Created from the template “" + esc(data.importedFrom.name) + "”" + (data.importedFrom.createdBy ? " by " + esc(data.importedFrom.createdBy) : "") + ". "
        : "";
      if (!versions.length) {
        $("agtemplate").innerHTML = origin + "No template staged yet.";
        $("agshare").textContent = "Ask it to draft a template";
        return;
      }
      var latest = versions[versions.length - 1];
      $("agtemplate").innerHTML = origin + "Version " + latest.version + " staged" +
        (latest.stagedAt ? " " + esc(new Date(latest.stagedAt).toLocaleString()) : "") +
        ": <b>" + esc(latest.name) + "</b> — " + esc(latest.description);
      $("agshare").textContent = "Ask it to update the template";
      $("agdownload").href = "/api/templates/download?agent=" + encodeURIComponent(agentId) + "&version=" + latest.version;
      $("agdownload").style.display = "";
    })
    .catch(function () { $("agtemplate").textContent = "Could not read the template state."; });
}

$("agshare").onclick = function () {
  if (!agentModal.id) return;
  $("agshare").disabled = true;
  fetch("/api/templates/share", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: agentModal.id })
  })
    .then(function (r) { return r.json(); })
    .then(function () {
      $("agentwrap").style.display = "none";
      feed("asked " + esc(nameOf(agentModal.id)) + " to draft a template — watch the chat; the card is in Configure once it is staged", "");
      return select(agentModal.id);
    })
    .catch(function (err) { $("agstatus").textContent = String(err.message || err); })
    .then(function () { $("agshare").disabled = false; });
};

$("agimportfile").onchange = function () {
  var file = this.files && this.files[0];
  if (!file) return;
  $("agimportname").textContent = file.name;
  file.text().then(function (text) { $("agimport").value = text; });
};

/**
 * Landing from a share page: "/?import=<id>". The box fetches the storefront and the document
 * from the control plane with its own token and opens the new-agent dialog with both in place,
 * so the person reads what they are adding and clicks Import themselves.
 */
function landImportFromUrl() {
  var shareId = new URLSearchParams(location.search).get("import");
  if (!shareId) return;
  history.replaceState(null, "", location.pathname);
  fetch("/api/templates/preview?shareId=" + encodeURIComponent(shareId))
    .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || "could not fetch the template"); return d; }); })
    .then(function (d) {
      openAgentModal("new", null);
      $("agname").value = d.name || "";
      $("agimport").value = d.document || "";
      $("agstatus").textContent = "Shared template “" + (d.name || "") + "” by " + (d.ownerName || "someone") + " — " + (d.description || "") + " Press Import to add your own copy.";
      $("agimportgo").setAttribute("data-share-id", shareId);
    })
    .catch(function (err) { feed("could not open the shared template: " + esc(String(err.message || err)), "err"); });
}

$("agimportgo").onclick = function () {
  var text = $("agimport").value.trim();
  if (!text) { $("agstatus").textContent = "Paste a template first."; return; }
  $("agimportgo").disabled = true;
  $("agstatus").textContent = "Importing…";
  fetch("/api/templates/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ template: text, name: $("agname").value.trim() || undefined, shareId: $("agimportgo").getAttribute("data-share-id") || undefined })
  })
    .then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || "import failed");
        return d;
      });
    })
    .then(function (d) {
      $("agentwrap").style.display = "none";
      feed("importing " + esc(d.name) + " — it installs its recipe on its first turn", "");
      return refresh().then(function () { return select(d.id); });
    })
    .catch(function (err) { $("agstatus").textContent = String(err.message || err); })
    .then(function () { $("agimportgo").disabled = false; });
};

function openAgentModal(mode, agent) {
  var preview0 = document.getElementById("agcatalogpreview");
  if (preview0) { preview0.style.display = "none"; preview0.innerHTML = ""; }
  agentModal.mode = mode;
  agentModal.id = agent ? agent.id : null;
  $("agenttitle").textContent = mode === "new" ? "New agent" : "Configure " + agent.name;
  $("agsave").textContent = mode === "new" ? "Create" : "Save";
  $("agcatalogwrap").style.display = mode === "new" ? "" : "none";
  $("agimportwrap").style.display = mode === "new" ? "" : "none";
  $("agtemplatewrap").style.display = mode === "new" ? "none" : "";
  renderBoxSelect(agent);
  $("agimport").value = "";
  if (mode === "new") {
    loadAgentCatalog().then(renderAgentCatalog);
  } else {
    loadTemplateCard(agent.id);
  }
  $("agname").value = agent ? agent.name : "";
  $("agrole").value = agent ? String(agent.title || "") : "";
  $("agpersona").value = agent ? String(agent.description || "") : "";
  // null means unrestricted — every tool, including ones that do not exist yet.
  var granted = agent && agent.tools ? agent.tools : null;
  agentModal.tools = {};
  $("agtools").innerHTML = allTools.map(function (tool) {
    var on = granted === null || granted.indexOf(tool) >= 0;
    agentModal.tools[tool] = on;
    return '<span class="toolchip' + (on ? " on" : "") + '" data-tool="' + esc(tool) + '">' +
      esc(tool) + "</span>";
  }).join("");
  renderAgentScope(agent ? String(agent.scopeId || "") : "");
  renderAgentProvider(agent ? String(agent.provider || "") : "");
  $("agmodel").value = agent ? String(agent.model || "") : "";
  $("agstatus").textContent = "";
  $("agdanger").style.display = mode === "edit" ? "" : "none";
  $("agdel1").style.display = "";
  $("agdel2").style.display = "none";
  $("agentwrap").style.display = "flex";
  $("agname").focus();
}

$("agdelete").onclick = function (event) {
  event.preventDefault();
  $("agdel1").style.display = "none";
  $("agdel2").style.display = "flex";
};
$("agdelback").onclick = function () {
  $("agdel1").style.display = "";
  $("agdel2").style.display = "none";
};
$("agdelconfirm").onclick = function () {
  var records = document.querySelector('input[name="agrecords"]:checked');
  $("agdelconfirm").disabled = true;
  fetch("/api/agents/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: agentModal.id, records: records ? records.value : "archive" })
  })
    .then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || "delete failed");
        return d;
      });
    })
    .then(function (d) {
      $("agentwrap").style.display = "none";
      feed("agent deleted" + (d.archivedTo ? " — records archived" : ""), "warn");
      current = null;
      return refresh();
    })
    .catch(function (error) { $("agstatus").textContent = error.message; })
    .then(function () { $("agdelconfirm").disabled = false; });
};

$("agtools").addEventListener("click", function (event) {
  var chip = event.target.closest && event.target.closest("[data-tool]");
  if (!chip) return;
  // In a scope the tools come from the scope, not from here.
  if ($("agscope").value !== "") return;
  var tool = chip.getAttribute("data-tool");
  agentModal.tools[tool] = !agentModal.tools[tool];
  chip.className = "toolchip" + (agentModal.tools[tool] ? " on" : "");
});

/** Loads the scope options (admin-only endpoint; empty if not admin) and selects one. */
var agentScopes = [];
function renderAgentScope(selected) {
  fetch("/api/scopes")
    .then(function (r) { return r.status === 403 ? null : r.json(); })
    .then(function (data) {
      agentScopes = data ? (data.scopes || []) : [];
      $("agscope").innerHTML = '<option value="">— no scope (tools set here) —</option>' +
        agentScopes.map(function (s) {
          return '<option value="' + esc(s.id) + '"' + (s.id === selected ? " selected" : "") + ">" + esc(s.name) + "</option>";
        }).join("");
      applyScopeToTools();
    })
    .catch(function () { $("agscope").innerHTML = '<option value="">— no scope —</option>'; });
}

/** When a scope is chosen, its tool set fills and locks the chips. */
function applyScopeToTools() {
  var id = $("agscope").value;
  var scope = agentScopes.filter(function (s) { return s.id === id; })[0];
  var dim = id !== "" ? "0.5" : "1";
  var chips = document.querySelectorAll("#agtools .toolchip");
  if (scope && scope.tools) {
    for (var i = 0; i < chips.length; i++) {
      var tool = chips[i].getAttribute("data-tool");
      var on = scope.tools.indexOf(tool) >= 0;
      agentModal.tools[tool] = on;
      chips[i].className = "toolchip" + (on ? " on" : "");
      chips[i].style.opacity = dim;
    }
  } else {
    for (var j = 0; j < chips.length; j++) chips[j].style.opacity = dim;
  }
}
$("agscope").onchange = applyScopeToTools;

/** The provider dropdown reuses the settings presets list. */
function renderAgentProvider(selected) {
  fetch("/api/config")
    .then(function (r) { return r.status === 403 ? null : r.json(); })
    .then(function (data) {
      var presets = data ? (data.presets || []) : [];
      $("agprovider").innerHTML = '<option value="">— installation default —</option>' +
        presets.map(function (p) {
          return '<option value="' + esc(p.name) + '"' + (p.name === selected ? " selected" : "") + ">" + esc(p.label) + "</option>";
        }).join("");
    })
    .catch(function () { $("agprovider").innerHTML = '<option value="">— default —</option>'; });
}

function saveAgentModal() {
  var name = $("agname").value.trim();
  if (!name) {
    $("agstatus").textContent = "The agent needs a name.";
    return;
  }
  var granted = allTools.filter(function (tool) { return agentModal.tools[tool]; });
  var isNew = agentModal.mode === "new";
  var body = {
    name: name,
    title: $("agrole").value.trim(),
    description: $("agpersona").value,
    // A full set is sent as null — "everything", which stays true for future tools.
    tools: granted.length === allTools.length ? null : granted,
    // In a scope, the scope owns the tools; send them anyway as the fallback for if
    // it is ever removed from the scope.
    scopeId: $("agscope").value,
    provider: $("agprovider").value,
    model: $("agmodel").value.trim()
  };
  if (!isNew) body.id = agentModal.id;
  if (isNew && $("agbox").value) body.boxId = $("agbox").value;
  $("agstatus").textContent = "Saving…";
  $("agsave").disabled = true;
  fetch(isNew ? "/api/agents" : "/api/agents/update", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  })
    .then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || "save failed");
        return d;
      });
    })
    .then(function (d) {
      $("agentwrap").style.display = "none";
      return refresh().then(function () {
        if (isNew && d.id) return select(d.id);
        if (!isNew && current) {
          $("title").textContent = nameOf(current);
          var edited = agentById(current);
          $("titlerole").textContent = edited ? String(edited.title || "") : "";
        }
      });
    })
    .catch(function (error) { $("agstatus").textContent = "Save failed: " + error.message; })
    .then(function () { $("agsave").disabled = false; });
}

$("new").onclick = function () {
  openAgentModal("new", null);
  // A new agent goes into the box whose page is showing, unless the person picks another.
  var pick = document.getElementById("agbox");
  if (pick && currentBox) pick.value = currentBox;
};
$("agentcfg").onclick = function (event) {
  event.preventDefault();
  var agent = agentById(current);
  if (agent) openAgentModal("edit", agent);
};
$("agsave").onclick = saveAgentModal;
$("agcancel").onclick = function () { $("agentwrap").style.display = "none"; };
$("agentwrap").addEventListener("click", function (event) {
  if (event.target === $("agentwrap")) $("agentwrap").style.display = "none";
});

// Who is at this browser. A name in the header rather than a silent identity, because
// "my work is signed with my name" is the whole difference a second person notices.
var myRole = "admin";
fetch("/api/me")
  .then(function (r) { return r.json(); })
  .then(function (me) {
    myRole = me.role || "viewer";
    $("whoami").textContent = me.name ? me.name + " · " + me.role : "";
    $("whoami").title = me.identity ? "signed in as " + me.identity : "";
    applyRole();
  })
  .catch(function () {});

/**
 * What this person may decide, made visible rather than enforced here.
 *
 * Three kinds of setting, and they answer to different people. What the *installation*
 * is — its provider, its key, its box, its channels — and what the *organisation* is —
 * who may do what, which scopes exist, what things cost — are an admin's to decide.
 * What is personal is your own. A driver has no use for knowing which provider this
 * installation bills, and showing them a control that will answer 403 is worse than
 * never offering it: it promises and then withdraws.
 */
function applyRole() {
  var admin = myRole === "admin";
  var driver = admin || myRole === "driver";
  var fields = document.querySelectorAll("[data-tier]");
  for (var i = 0; i < fields.length; i++) {
    var tier = fields[i].getAttribute("data-tier");
    var maySee = tier === "personal" ? driver : admin;
    fields[i].style.display = maySee ? "" : "none";
  }
  // A viewer watches. Everything that starts work is gone rather than greyed out.
  ["input", "send", "new"].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.style.display = driver ? "" : "none";
  });
}

// Activity after the roster, because its lines name agents.
refresh().then(loadActivity).then(loadRecordings).then(landImportFromUrl);
setInterval(refresh, 15000);

// A chat card's "open in the workshop" link lands here: the board, with that task
// already open. Done after the first refresh so the roster is there to name people.
if (openTask) showTab("tasks");
// ── the shelf and the Set up card (docs/39 §2, §4) ───────────────────────────────────
function shelfCard(head, sub, action, dataAttr, preview) {
  return '<div class="shelfrow" style="padding:8px 4px;border-bottom:1px solid var(--border)">' +
    '<div style="display:flex;gap:10px;align-items:center">' +
    '<div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:500">' + head + "</div>" +
    '<div class="dim" style="font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + sub + "</div></div>" +
    (preview ? '<button class="btn sm ghost" data-preview="1" type="button">Preview</button>' : "") +
    '<button class="btn sm accent" ' + dataAttr + '>' + action + "</button></div>" +
    (preview ? '<div class="shelfpreview" style="display:none;margin:8px 0 2px;padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--bg);font-size:12px;line-height:1.5">' + preview + "</div>" : "") +
    "</div>";
}

function openShelf() {
  $("shelfwrap").style.display = "";
  $("shelfstatus").textContent = "";
  $("shelfbody").innerHTML = '<div class="dim">Loading…</div>';
  fetch("/api/templates/shelf").then(function (r) { return r.json(); }).then(function (d) {
    var boxes = d.boxes || [];
    $("shelfbox").innerHTML = boxes.map(function (b) {
      return '<option value="' + esc(b.id) + '"' + (b.id === currentBox ? " selected" : "") + ">" + esc(b.name) + (b.kind === "docker" ? " (docker)" : " (attached)") + "</option>";
    }).join("");
    var html = "";
    var market = d.marketplace || [];
    if (market.length) {
      html += '<div class="eyebrow" style="margin:6px 0;display:flex;justify-content:space-between;align-items:center"><span>Ready-made bots (' + market.length + ')</span>' +
        '<input id="shelffilter" placeholder="filter" style="height:22px;font-size:11px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);padding:0 6px;width:140px;text-transform:none;letter-spacing:0"></div>';
      html += market.map(function (t) {
        var badges = [t.skills.length + " skill" + (t.skills.length === 1 ? "" : "s")];
        if (t.routines.length) badges.push(t.routines.length + " routine" + (t.routines.length === 1 ? "" : "s"));
        if (t.connectors.length) badges.push("needs " + t.connectors.join(", "));
        if (t.memoryCount) badges.push(t.memoryCount + " conventions");
        var preview = '<div>' + esc(t.description) + "</div>" +
          (t.skills.length ? '<div style="margin-top:6px"><b>Skills:</b> ' + t.skills.map(esc).join(" · ") + "</div>" : "") +
          (t.routines.length ? '<div style="margin-top:4px"><b>Routines:</b> ' + t.routines.map(esc).join(" · ") + "</div>" : "") +
          (t.createdBy ? '<div class="dim" style="margin-top:4px">by ' + esc(t.createdBy) + " · ported from Grok Bot</div>" : "");
        return shelfCard(esc(t.name) + (t.title && t.title !== t.name ? ' <span class="dim">' + esc(t.title) + "</span>" : "") + ' <span class="dim" style="font-weight:400">' + esc(badges.join(" · ")) + "</span>",
          esc(t.description), "Stamp", 'data-stamp-template="' + esc(t.slug) + '" data-stamp-name="' + esc(t.name) + '"', preview);
      }).join("");
    }
    var mine = d.mine || [];
    html += '<div class="eyebrow" style="margin:12px 0 6px">Mine</div>';
    html += mine.length ? mine.map(function (t) {
      return shelfCard(esc(t.name) + ' <span class="dim">v' + esc(String(t.version)) + " · from " + esc(t.agentName) + "</span>",
        esc(t.description || t.counts || "") + (t.stamped ? " · stamped " + t.stamped + "×" : ""),
        "Stamp", 'data-stamp-agent="' + esc(t.agentId) + '" data-stamp-version="' + esc(String(t.version)) + '" data-stamp-name="' + esc(t.name) + '"');
    }).join("") : '<div class="dim" style="font-size:12px;padding:4px">None yet — open an agent\'s Configure and press “Ask it to draft a template”.</div>';
    var imported = d.imported || [];
    if (imported.length) {
      html += '<div class="eyebrow" style="margin:10px 0 6px">Stamped here from elsewhere</div>';
      html += imported.map(function (a) {
        return '<div class="dim" style="font-size:12px;padding:3px 4px">' + esc(a.agentName) + " — from “" + esc(a.from.name || "") + "”" + (a.from.createdBy ? " by " + esc(a.from.createdBy) : "") + "</div>";
      }).join("");
    }
    html += '<div class="eyebrow" style="margin:10px 0 6px">Roles (persona only — the same as + agent)</div>';
    html += (d.catalog || []).map(function (c) {
      return shelfCard(esc(c.name) + (c.title ? ' <span class="dim">' + esc(c.title) + "</span>" : "") + (c.kind === "crew" ? ' <span class="chip">crew of ' + c.members.length + "</span>" : ""),
        esc(c.summary || ""), "Stamp", 'data-stamp-catalog="' + esc(c.slug) + '" data-stamp-name="' + esc(c.name) + '"');
    }).join("");
    $("shelfbody").innerHTML = html;
    var filter = document.getElementById("shelffilter");
    if (filter) filter.oninput = function () {
      var q = filter.value.trim().toLowerCase();
      var rows = $("shelfbody").querySelectorAll(".shelfrow");
      for (var i = 0; i < rows.length; i++) {
        if (!rows[i].querySelector("button[data-stamp-template]")) continue;
        rows[i].style.display = !q || rows[i].textContent.toLowerCase().indexOf(q) >= 0 ? "" : "none";
      }
    };
  }).catch(function (e) { $("shelfbody").innerHTML = '<div class="dim">Could not read the shelf: ' + esc(String(e.message || e)) + "</div>"; });
}

$("shelfopen").onclick = function (e) { e.preventDefault(); openShelf(); };
$("shelfclose").onclick = function () { $("shelfwrap").style.display = "none"; };
$("shelfpaste").onclick = function () { $("shelfwrap").style.display = "none"; openAgentModal("new", null); };
$("shelfbody").onclick = function (event) {
  var pv = event.target.closest("button[data-preview]");
  if (pv) {
    var box = pv.closest(".shelfrow").querySelector(".shelfpreview");
    if (box) box.style.display = box.style.display === "none" ? "" : "none";
    return;
  }
  var btn = event.target.closest("button[data-stamp-template],button[data-stamp-catalog],button[data-stamp-agent]");
  if (!btn) return;
  var boxId = $("shelfbox").value;
  // One click. The name is the template's own; the server picks a free one if it is taken.
  var body = { boxId: boxId };
  if (btn.getAttribute("data-stamp-template")) body.templateSlug = btn.getAttribute("data-stamp-template");
  else if (btn.getAttribute("data-stamp-catalog")) body.catalogSlug = btn.getAttribute("data-stamp-catalog");
  else { body.agentId = btn.getAttribute("data-stamp-agent"); body.version = Number(btn.getAttribute("data-stamp-version")); }
  $("shelfstatus").textContent = "Stamping…";
  btn.disabled = true;
  fetch("/api/templates/stamp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || "stamp failed"); return d; }); })
    .then(function (d) {
      $("shelfwrap").style.display = "none";
      var made = (d.created || []).map(function (c) { return c.name; }).join(", ");
      feed("stamped " + esc(made) + " — it installs its recipe on its first turn", "");
      return refresh().then(function () { if (d.created && d.created[0]) select(d.created[0].id); });
    })
    .catch(function (err) { $("shelfstatus").textContent = String(err.message || err); btn.disabled = false; });
};

/** Four steps, shown until all four are done; each names the object it introduces. */
var guideForced = false;
function refreshSetup() {
  return fetch("/api/setup").then(function (r) { return r.json(); }).then(function (s) {
    var card = $("setupcard");
    if (!card) return;
    var steps = [
      { done: s.box, head: "A computer for the agents", sub: "A box is a computer: desktop, files, shell, engines. Create the Docker box, or attach one.", act: "Set up a box", go: function () { openSettings("boxes"); } },
      { done: s.agentTurn, head: "Your first agent", sub: "An agent lives in one box. Stamp one from the shelf — 设计 (Team designer) builds a team for you.", act: "Open templates", go: openShelf },
      { done: s.door, head: "A door (optional)", sub: "Feishu, DingTalk or Telegram reach this box; this page is a door too.", act: "Connect a door", go: function () { openSettings("doors"); } },
      { done: s.review, head: "First work", sub: "Say it in chat or add a task; it is done when it reaches review.", act: "Open tasks", go: function () { var t = $("tabtasks"); if (t) t.click(); } }
    ];
    if (steps.every(function (x) { return x.done; }) && !guideForced) { card.style.display = "none"; return; }
    card.style.display = "";
    card.innerHTML = '<div style="margin:10px 16px 0;padding:10px 14px;border:1px solid var(--border-strong);border-radius:var(--radius-card);background:var(--surface)">' +
      '<div class="eyebrow" style="margin-bottom:6px;display:flex;justify-content:space-between"><span>Set up</span><a href="#" data-setup-close="1" style="text-transform:none;letter-spacing:0">close</a></div>' +
      steps.map(function (x, i) {
        return '<div style="display:flex;gap:10px;align-items:center;padding:4px 0;font-size:12px">' +
          '<span style="width:16px;color:' + (x.done ? "var(--ok, #3fb950)" : "var(--muted)") + '">' + (x.done ? "✓" : String(i + 1)) + "</span>" +
          '<div style="flex:1"><b>' + esc(x.head) + "</b> <span class=\"dim\">" + esc(x.sub) + "</span></div>" +
          '<button class="btn sm' + (x.done ? " ghost" : "") + '" data-setup="' + i + '">' + esc(x.act) + "</button>" +
        "</div>";
      }).join("") + "</div>";
    card.onclick = function (event) {
      var b = event.target.closest("button[data-setup]");
      if (b) { event.preventDefault(); steps[Number(b.getAttribute("data-setup"))].go(); return; }
      if (event.target.closest("a[data-setup-close]")) { event.preventDefault(); guideForced = false; card.style.display = "none"; }
    };
  }).catch(function () {});
}
refreshSetup();
setInterval(refreshSetup, 30000);
$("guidebtn").onclick = function () { guideForced = true; refreshSetup(); };

$("agentdel").onclick = function (event) {
  event.preventDefault();
  var agent = agentById(current);
  if (!agent) return;
  openAgentModal("edit", agent);
  // Straight to the last field, with the two-step delete already open.
  $("agdel1").style.display = "none";
  $("agdel2").style.display = "flex";
  var danger = $("agdanger");
  if (danger) setTimeout(function () { danger.scrollIntoView({ block: "end" }); }, 30);
};
// ── dividers, jump to latest, share (docs/40 §4, §5) ──────────────────────────
function dayLabel(at) {
  var d = new Date(at);
  if (isNaN(d.getTime())) return "";
  var now = new Date();
  if (d.toDateString() === now.toDateString()) return "today";
  var y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
function divider(label, isNew) {
  var div = document.createElement("div");
  div.className = "divider" + (isNew ? " new" : "");
  div.textContent = label;
  $("chat").appendChild(div);
}

var unseenSinceScroll = 0;
$("chat").addEventListener("scroll", function () {
  if (nearBottom($("chat"))) { unseenSinceScroll = 0; $("jumplatest").style.display = "none"; }
});
var chatObserver = new MutationObserver(function (records) {
  var chat = $("chat");
  if (nearBottom(chat)) return;
  var added = 0;
  for (var i = 0; i < records.length; i++) for (var j = 0; j < records[i].addedNodes.length; j++) {
    var n = records[i].addedNodes[j];
    if (n.nodeType === 1 && n.classList && n.classList.contains("msg")) added += 1;
  }
  if (!added) return;
  unseenSinceScroll += added;
  $("jumplatest").textContent = "↓ " + unseenSinceScroll + " new";
  $("jumplatest").style.display = "";
});
chatObserver.observe($("chat"), { childList: true });
$("jumplatest").onclick = function () { var chat = $("chat"); chat.scrollTop = chat.scrollHeight; unseenSinceScroll = 0; this.style.display = "none"; };

/** The thread as Markdown a person can paste: who, when, what; steps as one line each. */
function threadAsMarkdown() {
  var out = [];
  var nodes = $("chat").children;
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    if (n.classList.contains("msg")) {
      var who = n.getAttribute("data-role") === "user" ? "You" : nameOf(current);
      var when = whenLabel(n.getAttribute("data-at"));
      out.push("**" + who + "**" + (when ? " (" + when + ")" : "") + "\n\n" + (n.__md || n.querySelector(".body").innerText) + "\n");
    } else if (n.classList.contains("divider")) {
      out.push("---\n_" + n.textContent + "_\n");
    } else if (n.classList.contains("work")) {
      var calls = n.querySelectorAll("details.tool > summary");
      out.push("_" + n.querySelector("summary").textContent + "_");
      for (var k = 0; k < calls.length; k++) out.push("— " + calls[k].textContent);
      out.push("");
    } else if (n.classList.contains("sentfoot")) {
      out.push("_" + n.querySelector("summary").textContent + "_\n");
    }
  }
  return out.join("\n");
}
$("sharebtn").onclick = function (event) {
  event.preventDefault();
  var m = $("sharemenu");
  m.style.display = m.style.display === "block" ? "none" : "block";
};
document.addEventListener("click", function (event) {
  if (!event.target.closest("#sharebtn") && !event.target.closest("#sharemenu")) $("sharemenu").style.display = "none";
});
$("sharemenu").onclick = function (event) {
  var a = event.target.closest("a[data-share]");
  if (!a) return;
  event.preventDefault();
  var what = a.getAttribute("data-share");
  if (what === "md") { copyText(threadAsMarkdown()); feed("thread copied as Markdown", ""); }
  else if (what === "file") {
    var blob = new Blob([threadAsMarkdown()], { type: "text/markdown" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url; link.download = nameOf(current) + "-" + currentConversation.replace(/[^A-Za-z0-9_-]+/g, "_") + "-" + new Date().toISOString().slice(0, 10) + ".md";
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  } else if (what === "link") {
    var u = new URL(location.href); u.search = "";
    u.searchParams.set("agent", current); u.searchParams.set("conversation", currentConversation);
    copyText(u.toString()); feed("thread link copied", "");
  }
  $("sharemenu").style.display = "none";
};

/** A permalink: open the agent and thread it names, then scroll to the message. */
var landed = false;
function landMessageFromUrl() {
  var p = new URLSearchParams(location.search);
  var m = p.get("m");
  if (m === null || landed) return;
  var node = document.querySelector('.msg[data-m="' + m + '"]');
  if (!node) return;
  landed = true;
  node.scrollIntoView({ block: "center" });
  node.style.outline = "2px solid var(--accent)";
  setTimeout(function () { node.style.outline = ""; }, 2500);
}

</script>
</body>
</html>`;

/**
 * The door, for somebody who has an invite code and no session yet.
 *
 * Its own page rather than a mode of the app, because it is reached *before*
 * authentication and must therefore be the one place the token gate lets through.
 * Redeeming a code hands out the installation's UI token as well as the identity
 * cookie: the code is the credential that admits a person, and their role — what
 * they may actually do once inside — comes from the roster, checked per request.
 * Removing somebody from the roster drops them to viewer; rotating the token ends
 * every session at once. Both are said plainly here rather than discovered later.
 */
export const LOGIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LumenBox &mdash; sign in</title>
<style>
  :root { color-scheme: light dark; --bg:#fbfbfa; --text:#1d1d1b; --muted:#6b6b66; --border:#e3e3df; --accent:#2f6f4f; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161615; --text:#eceae4; --muted:#9a9a92; --border:#2c2c2a; --accent:#7fbf9a; } }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:var(--bg); color:var(--text);
         font:15px/1.5 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif; }
  .card { width:min(420px,92vw); padding:28px 30px; border:1px solid var(--border); border-radius:14px; }
  h1 { margin:0 0 4px; font-size:19px; font-weight:600; }
  p.sub { margin:0 0 20px; color:var(--muted); font-size:13px; }
  label { display:block; font-size:12px; color:var(--muted); margin:14px 0 5px; }
  input { width:100%; box-sizing:border-box; padding:9px 11px; font:inherit; border-radius:9px;
          border:1px solid var(--border); background:transparent; color:var(--text); }
  #code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:2px; text-transform:uppercase; }
  button { margin-top:18px; width:100%; padding:10px; font:inherit; font-weight:500; cursor:pointer;
           border:0; border-radius:9px; background:var(--accent); color:#fff; }
  .note { margin-top:16px; font-size:12px; color:var(--muted); }
  .err { margin-top:14px; font-size:13px; color:#b3261e; min-height:18px; }
</style>
</head>
<body>
<div class="card">
  <h1>Sign in to LumenBox</h1>
  <p class="sub">An admin gives you a code &mdash; the same one that works in chat.</p>
  <label for="code">Invite code</label>
  <input id="code" autocomplete="off" spellcheck="false" placeholder="4F7KQZ" autofocus>
  <label for="name">Your name</label>
  <input id="name" autocomplete="name" placeholder="How your work should be signed">
  <button id="go">Sign in</button>
  <div class="err" id="err"></div>
  <div class="note">Codes last 15 minutes and work once. What you may do here comes from
    the role the admin gave you, not from the code.</div>
</div>
<script>
var go = document.getElementById("go");
function submit() {
  var code = document.getElementById("code").value.trim();
  var name = document.getElementById("name").value.trim();
  if (!code) { document.getElementById("err").textContent = "Enter the code you were given."; return; }
  go.disabled = true;
  document.getElementById("err").textContent = "";
  fetch("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: code, name: name })
  })
    .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || "sign-in failed"); return d; }); })
    .then(function () { location.href = "/"; })
    .catch(function (error) { go.disabled = false; document.getElementById("err").textContent = error.message; });
}
go.onclick = submit;
document.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
</script>
</body>
</html>`;
