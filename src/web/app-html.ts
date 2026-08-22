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

  /* ── settings ─────────────────────────────────────────────────────────────── */
  #settingswrap, #agentwrap {
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
  .msg { padding: 6px 0; word-break: break-word; }
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

  /* ── right pane: what is happening now ────────────────────────────────────── */
  .tab {
    padding: 4px 12px; border-radius: var(--radius-pill); text-decoration: none;
    font-size: 12px; color: var(--muted); transition: background var(--dur) var(--ease);
  }
  .tab:hover { text-decoration: none; background: var(--surface-hover); }
  .tab.on { background: var(--accent-soft); color: var(--accent); }
  #desktoptitle { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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
  <span id="spendtoday" class="mono" style="font-size:12px;color:var(--muted);white-space:nowrap" title="Tokens spent today, all agents"></span>
  <button id="settingsbtn" title="Settings" aria-label="Settings">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03Z"/></svg>
  </button>
  <button id="theme" title="Switch theme" aria-label="Switch theme">
    <svg id="themesun" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
    <svg id="thememoon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>
  </button>
</header>

<div id="shell">

<div class="pane" id="sidebar">
  <div class="eyebrow-row"><span class="eyebrow">Agents</span><button id="new" class="btn ghost sm" title="New agent">+</button></div>
  <div class="scroll" id="agents"></div>
  <div id="sidefoot">
    <div class="footrow"><span class="dot" id="boxdot"></span><span id="boxinfo">box</span></div>
    <div id="buildinfo"></div>
  </div>
</div>

<div class="pane" id="middle">
  <div class="paneheader">
    <span class="lead">
      <span id="title">&mdash;</span>
      <span id="titlerole" class="dim" style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></span>
      <a href="#" id="agentcfg" style="font-size:12px;flex:none">Configure</a>
    </span>
    <span class="headactions">
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
      <span id="desktoptitle"></span>
    </span>
    <span class="headactions">
      <a id="rec" href="#">&#9679; record</a>
      <a id="full" href="#" target="_blank" rel="noopener" class="btn sm" style="text-decoration:none">Take over</a>
    </span>
  </div>
  <div id="desktopview">
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
  <div class="eyebrow-row activityhead"><span class="eyebrow">Activity &mdash; all agents</span></div>
  <div class="feed" id="feed"></div>
</div>

</div>

<!-- Settings. What is here is exactly what the config file holds: the provider choice
     the launch command used to carry, its model override, and the key. -->
<div id="settingswrap" style="display:none">
  <div class="modal">
    <h3>Settings &mdash; model &amp; key</h3>
    <div class="fieldnote" id="setwelcome" style="display:none;border:1px solid var(--border);border-radius:var(--radius-md);padding:10px 12px;color:var(--text-soft)">
      Welcome. LumenBox needs two things before agents can work: a model provider with a
      key, and the box &mdash; one Linux container with a desktop, a browser and a shell,
      running on this machine. Both are set up here.
    </div>
    <div class="field">
      <label>Provider</label>
      <select id="setprovider"></select>
    </div>
    <div class="field">
      <label>Model</label>
      <input id="setmodel" list="modellist" placeholder="preset default" spellcheck="false">
      <datalist id="modellist"></datalist>
    </div>
    <div class="field" id="setbasewrap" style="display:none">
      <label>Base URL</label>
      <input id="setbase" placeholder="https://&hellip;" spellcheck="false">
    </div>
    <div class="field">
      <label>API key</label>
      <input id="setkey" type="password" spellcheck="false" autocomplete="off">
      <div class="fieldnote" id="setkeynote"></div>
    </div>
    <div class="fieldnote">Saved to ~/.agentbox/config.json on this machine, mode 0600. A key stored
      here is used only when the environment does not already provide one, and is never placed
      inside the box. Changes take effect when the server restarts.</div>
    <div class="field" id="setboxwrap">
      <label>Box</label>
      <div class="fieldnote" id="setboxstate" style="margin:0"></div>
      <div id="setboxactions" style="display:none">
        <button class="btn sm" id="setboxup">Start the box</button>
      </div>
      <pre id="setboxlog" style="display:none;max-height:140px;overflow:auto;background:var(--code-bg);color:var(--code-text);border:1px solid var(--border);border-radius:var(--radius-md);padding:10px 12px;font-family:var(--font-mono);font-size:11px;line-height:1.6;margin:0;white-space:pre-wrap"></pre>
    </div>
    <div class="field">
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
    <div class="field">
      <label>Channels</label>
      <div id="setchannels" style="display:flex;flex-direction:column;gap:6px"></div>
      <div class="fieldnote">A channel turns on when its credentials are in the environment or the
        env map of the config file, and answers only the ids below. Anyone else who messages the bot
        is told their id and nothing more.</div>
      <input id="setallow" placeholder="telegram:123456, feishu:ou_abc, dingtalk:staff1" spellcheck="false">
      <div class="fieldnote" id="setallowstatus"></div>
    </div>
    <div class="field" id="setgrantswrap" style="display:none">
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
<div id="agentwrap" style="display:none">
  <div class="modal">
    <h3 id="agenttitle">New agent</h3>
    <div class="field">
      <label>Name</label>
      <input id="agname" spellcheck="false" style="font-family:var(--font-sans)">
    </div>
    <div class="field">
      <label>Role label</label>
      <input id="agrole" placeholder="e.g. release manager" spellcheck="false" style="font-family:var(--font-sans)">
    </div>
    <div class="field">
      <label>Persona</label>
      <textarea id="agpersona" placeholder="What is this agent for? This becomes its system prompt."></textarea>
    </div>
    <div class="field">
      <label>Tools</label>
      <div id="agtools" class="toolchips"></div>
      <div class="fieldnote">An unchecked tool is withheld — it does not appear in the agent's
        prompt at all. Leaving everything checked means everything, including tools added later.</div>
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

function openSettings() {
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
      $("setstatus").textContent = "Now running: " + (data.current || "");
      settingsProviderChanged();
      renderStandingGrants();
      renderBoxSection();
      renderChannels();
      $("settingswrap").style.display = "flex";
    })
    .catch(function () { feed("could not load settings", "err"); });
}

/** Which chat channels exist, whether each is up, and who may use them. */
function renderChannels() {
  fetch("/api/channels")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      $("setchannels").innerHTML = (data.channels || []).map(function (ch) {
        var cls = ch.running ? "ok" : ch.configured ? "bad" : "";
        return '<div style="display:flex;gap:9px;align-items:center;font-size:13px">' +
          '<span class="dot ' + cls + '"></span>' +
          "<span style=\"min-width:70px\">" + esc(ch.name) + "</span>" +
          '<span class="dim mono" style="font-size:11px">' + esc(ch.detail) + "</span></div>";
      }).join("");
      $("setallow").value = (data.allow || []).join(", ");
      $("setallowstatus").textContent = "";
    })
    .catch(function () {});
}

$("setallow").addEventListener("change", function () {
  var list = $("setallow").value.split(",").map(function (s) { return s.trim(); })
    .filter(function (s) { return s !== ""; });
  fetch("/api/channels/allow", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ allow: list })
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      $("setallowstatus").textContent = d.error
        ? d.error
        : "Saved — applies to the next message, no restart needed.";
    })
    .catch(function (error) { $("setallowstatus").textContent = error.message; });
});

function renderBoxSection() {
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

$("settingsbtn").onclick = openSettings;
$("setprovider").onchange = settingsProviderChanged;
$("setsave").onclick = function () { saveSettings(false); };
$("setsaverestart").onclick = function () { saveSettings(true); };
$("setcancel").onclick = function () {
  markOnboarded();
  $("settingswrap").style.display = "none";
};
$("settingswrap").addEventListener("click", function (event) {
  if (event.target === $("settingswrap")) {
    markOnboarded();
    $("settingswrap").style.display = "none";
  }
});

var agents = [];
var allTools = [];
var current = null;
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

function renderAgents() {
  var html = "";
  for (var i = 0; i < agents.length; i++) {
    var a = agents[i];
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

function bubble(role, who, text) {
  var el = $("chat");
  var stick = nearBottom(el);
  var div = document.createElement("div");
  div.className = "msg " + role;
  div.innerHTML = '<div class="who">' + esc(who) + '</div><div class="body"></div>';
  var body = div.querySelector(".body");
  body.innerHTML = renderMarkdown(text);
  el.appendChild(div);
  if (stick) el.scrollTop = el.scrollHeight;
  return body;
}

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
  var values = Object.keys(args).map(function (key) { return String(args[key]); });
  return values.length ? values[0] : "";
}

function collapsedRow(cls, summaryHtml, detail) {
  var el = $("chat");
  var stick = nearBottom(el);
  var row = document.createElement("details");
  row.className = "tool " + (cls || "");
  row.innerHTML = "<summary>" + summaryHtml + '</summary><div class="det"></div>';
  // textContent, not innerHTML: this is output from a command or another agent.
  row.querySelector(".det").textContent = String(detail == null ? "" : detail);
  el.appendChild(row);
  if (stick) el.scrollTop = el.scrollHeight;
  return row;
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
function peerNote(direction, name, text, priority) {
  var oneLine = String(text == null ? "" : text).replace(/\s+/g, " ");
  var row = document.createElement("details");
  row.className = "note";
  row.innerHTML = "<summary>" +
    '<span class="peerdot" style="background:' + colorOfName(name) + '"></span>' +
    esc(direction) + ' <span class="chip">' + esc(name) + "</span>" +
    (priority ? " (priority)" : "") +
    ' <span class="dim">' + esc(oneLine.slice(0, 60)) + "</span>" +
    '</summary><div class="det"></div>';
  row.querySelector(".det").textContent = String(text == null ? "" : text);
  var el = $("chat");
  var stick = nearBottom(el);
  el.appendChild(row);
  if (stick) el.scrollTop = el.scrollHeight;
  return row;
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
  $("desktoptitle").textContent = agent.name + " · d" + agent.displayIndex;
  $("full").href = agent.desktopUrl;
  $("full").style.display = "";
  // Only reload when it is a different desktop: re-setting src restarts noVNC and
  // flashes "Connecting…", so switching back and forth must not thrash it.
  if ($("vnc").getAttribute("src") !== agent.desktopUrl) {
    $("vnc").setAttribute("src", agent.desktopUrl);
  }
}

/**
 * One mapped transcript entry.
 *
 * The server hands over what to show — prose, teammate messages, tool calls, results —
 * because the stored transcript is written for the model and needs a real parse to read
 * as a conversation. See src/web/transcript.ts.
 */
function replayEntry(id, entry) {
  if (entry.kind === "peer") {
    for (var p = 0; p < entry.messages.length; p++) {
      peerNote("from", entry.messages[p].from, entry.messages[p].text, entry.messages[p].priority);
    }
    return;
  }
  if (entry.kind === "tools") {
    for (var t = 0; t < entry.tools.length; t++) {
      var call = entry.tools[t];
      toolCall(call.name, call.detail, call.result, call.isError);
    }
    return;
  }
  bubble(entry.role === "user" ? "user" : "", entry.role === "user" ? "you" : nameOf(id), entry.text);
}

function agentById(id) {
  for (var i = 0; i < agents.length; i++) if (agents[i].id === id) return agents[i];
  return null;
}

function select(id) {
  current = id;
  $("title").textContent = nameOf(id);
  var selected = agentById(id);
  $("titlerole").textContent = selected ? String(selected.title || "") : "";
  $("round").textContent = "";
  spend = { input: 0, output: 0 };
  spendLabel = "";
  roundLabel = "";
  renderAgents();
  showDesktop(id);
  $("chat").innerHTML = "";
  live.delete(id);

  return fetch("/api/transcript?agent=" + encodeURIComponent(id))
    .then(function (r) { return r.json(); })
    .then(function (entries) {
      for (var i = 0; i < entries.length; i++) replayEntry(id, entries[i]);
      $("chat").scrollTop = $("chat").scrollHeight;
    });
}

function refresh() {
  return fetch("/api/state").then(function (r) { return r.json(); }).then(function (state) {
    agents = state.agents;
    allTools = state.allTools || allTools;
    $("model").innerHTML = "<b>" + esc(state.provider) + "</b>";
    boxState = { ok: !!state.box.ok, detail: String(state.box.detail || "") };
    $("boxinfo").textContent = state.box.ok ? state.box.detail : "box unavailable";
    $("boxdot").className = "dot " + (state.box.ok ? "ok" : "bad");
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
    }
    if (!current && agents.length) return select(agents[0].id);
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
  return fetch("/api/policy")
    .then(function (r) { return r.json(); })
    .then(function (state) { renderApprovals(state.pending || []); })
    .catch(function () { /* a dropped poll is not worth a message; the next one covers it */ });
}

function renderApprovals(pending) {
  var box = $("approvals");
  if (!pending.length) {
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
      '<div class="note">Each button says what it covers: this exact action, once, for this session, or until you revoke it in Settings.</div>' +
      '<div class="cactions">' +
      '<button class="btn sm accent" data-approve="' + esc(item.id) + '" data-scope="once">Allow once</button>' +
      '<button class="btn sm" data-approve="' + esc(item.id) + '" data-scope="session">This session</button>' +
      '<button class="btn sm" data-approve="' + esc(item.id) + '" data-scope="always">Always</button>' +
      '<button class="btn sm ghost" data-deny="' + esc(item.id) + '">Refuse</button>' +
      "</div></div>";
  }).join("");
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
  return fetch("/api/progress?agent=" + encodeURIComponent(current))
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
      head.innerHTML = "<b>plan</b> " + (hasPlan ? esc(state.plan.split("\n")[0]) : "&mdash;") +
        (todos.length ? ' <span class="dim mono">' + done + "/" + todos.length + " done</span>" : "");
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

/** Which of the two views the right-hand pane is showing. */
function showTab(which) {
  var files = which === "files";
  $("desktopview").style.display = files ? "none" : "";
  $("filesview").style.display = files ? "flex" : "none";
  $("tabfiles").className = "tab" + (files ? " on" : "");
  $("tabdesktop").className = "tab" + (files ? "" : " on");
  if (files) refreshFiles();
}
document.getElementById("tabdesktop").addEventListener("click", function (e) { e.preventDefault(); showTab("desktop"); });
document.getElementById("tabfiles").addEventListener("click", function (e) { e.preventDefault(); showTab("files"); });

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

function chooseSkill(name) {
  $("slashmenu").style.display = "none";
  // Phrased as an instruction, because that is what it is. The agent resolves the name against the
  // index it already has.
  $("input").value = "Use the " + name + " skill.";
  $("input").focus();
}

document.getElementById("slashmenu").addEventListener("mousedown", function (event) {
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

stream.onmessage = function (raw) {
  var e = JSON.parse(raw.data);
  var line = activityLine(e);
  if (line) feed(line.html, line.cls);

  if (e.type === "prompt") {
    if (e.agentId === current) bubble("user", "you", e.text);
    return;
  }

  if (e.type === "text") {
    if (e.agentId !== current) return;
    var open = live.get(e.agentId);
    if (!open) {
      open = { node: bubble("", e.agentName, ""), text: "", queued: false };
      // Marked while it is still streaming, so a retry can drop it. Cleared when the turn's own
      // message is stored, at which point it is no longer a partial anyone should discard.
      open.node.setAttribute("data-partial", "1");
      live.set(e.agentId, open);
    }
    open.text += e.delta;
    // The whole message has to be re-rendered, not appended to: half a fence is not
    // yet a code block, and a list grows an item at a time. Deltas arrive far faster
    // than the screen refreshes, so paint once per frame instead of once per delta.
    if (!open.queued) {
      open.queued = true;
      requestAnimationFrame(function () {
        open.queued = false;
        var chat = $("chat");
        var stick = nearBottom(chat);
        open.node.innerHTML = renderMarkdown(open.text);
        if (stick) chat.scrollTop = chat.scrollHeight;
      });
    }
    return;
  }

  if (e.type === "tool_start") {
    live.delete(e.agentId);
    // Held so the result can be folded into the same row when it arrives.
    if (e.agentId === current) {
      openTool.set(e.agentId, toolCall(e.tool, toolDetail(e.tool, e.input)));
    }
    return;
  }

  if (e.type === "tool_end") {
    var row = openTool.get(e.agentId);
    openTool.delete(e.agentId);
    if (e.agentId !== current || !row) return;
    appendDetail(row, e.summary);
    if (e.screenshot) {
      var img = document.createElement("img");
      img.className = "shot";
      img.src = "data:image/webp;base64," + e.screenshot;
      // Inside the row, so it appears when opened rather than filling the column.
      row.appendChild(img);
    }
    return;
  }

  if (e.type === "message_sent") {
    // Both sides, in their own chat: the sender's record of messaging a teammate, and
    // the recipient's of being messaged. Without the second, the pane jumps from
    // nothing to a reply and what prompted it only shows up on reload.
    if (e.toId === current) peerNote("from", e.fromName, e.text, e.priority);
    else if (e.fromId === current) peerNote("to", e.toName, e.text, e.priority);
    return;
  }

  if (e.type === "turn_started") {
    busy.add(e.agentId); renderAgents();
    return;
  }

  if (e.type === "turn_finished") {
    // No longer running, so the stop button goes away rather than staying to be clicked at nothing.
    if (e.agentId === current) $("stop").style.display = "none";
    var settled = live.get(e.agentId);
    if (settled) settled.node.removeAttribute("data-partial");
    busy.delete(e.agentId); live.delete(e.agentId); renderAgents();
    // A teammate that just worked may be new to this page, or have new history.
    refresh();
    return;
  }

  if (e.type === "turn_failed") {
    busy.delete(e.agentId); renderAgents();
    return;
  }

  if (e.type === "round") {
    if (e.agentId === current) {
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
    if (e.agentId === current && e.discardPartial) {
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
    if (e.agentId !== current) return;
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
  $("input").value = "";
  $("send").disabled = true;
  fetch("/api/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: current, text: text })
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
  slashIndex = 0;
  renderSlash();
});

$("input").onkeydown = function (event) {
  // The slash menu takes the arrow keys and Enter while it is open, and nothing else — Escape
  // closes it so a person who opened it by accident is not trapped.
  var menu = $("slashmenu");
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

function openAgentModal(mode, agent) {
  agentModal.mode = mode;
  agentModal.id = agent ? agent.id : null;
  $("agenttitle").textContent = mode === "new" ? "New agent" : "Configure " + agent.name;
  $("agsave").textContent = mode === "new" ? "Create" : "Save";
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
  var tool = chip.getAttribute("data-tool");
  agentModal.tools[tool] = !agentModal.tools[tool];
  chip.className = "toolchip" + (agentModal.tools[tool] ? " on" : "");
});

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
    tools: granted.length === allTools.length ? null : granted
  };
  if (!isNew) body.id = agentModal.id;
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

$("new").onclick = function () { openAgentModal("new", null); };
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

// Activity after the roster, because its lines name agents.
refresh().then(loadActivity).then(loadRecordings);
setInterval(refresh, 15000);
</script>
</body>
</html>`;
