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
  details.step .saidfull {
    font-family: var(--font-sans); font-size: 0.82rem; line-height: 1.5;
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
  <span id="whoami" style="font-size:12px;color:var(--muted);white-space:nowrap"></span>
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
      <span id="convwrap" style="position:relative;flex:none">
        <a href="#" id="convbtn" class="btn sm" style="display:none;text-decoration:none;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></a>
        <div id="convpanel" style="display:none">
          <input id="convfilter" placeholder="Filter threads&hellip;" autocomplete="off">
          <div id="convlist"></div>
          <a href="#" id="convmore" class="row dim" style="display:none">Load more&hellip;</a>
        </div>
      </span>
      <a href="#" id="agentcfg" style="font-size:12px;flex:none">Configure</a>
    </span>
    <span class="headactions">
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
    <div class="field" data-tier="installation">
      <label>Provider</label>
      <select id="setprovider"></select>
    </div>
    <div class="field" data-tier="installation">
      <label>Model</label>
      <input id="setmodel" list="modellist" placeholder="preset default" spellcheck="false">
      <datalist id="modellist"></datalist>
    </div>
    <div class="field" data-tier="installation" id="setbasewrap" style="display:none">
      <label>Base URL</label>
      <input id="setbase" placeholder="https://&hellip;" spellcheck="false">
    </div>
    <div class="field" data-tier="installation">
      <label>API key</label>
      <input id="setkey" type="password" spellcheck="false" autocomplete="off">
      <div class="fieldnote" id="setkeynote"></div>
    </div>
    <div class="fieldnote">Saved to ~/.agentbox/config.json on this machine, mode 0600. A key stored
      here is used only when the environment does not already provide one, and is never placed
      inside the box. Changes take effect when the server restarts.</div>
    <div class="field" data-tier="installation" id="setboxwrap">
      <label>Box</label>
      <div class="fieldnote" id="setboxstate" style="margin:0"></div>
      <div id="setboxactions" style="display:none">
        <button class="btn sm" id="setboxup">Start the box</button>
      </div>
      <pre id="setboxlog" style="display:none;max-height:140px;overflow:auto;background:var(--code-bg);color:var(--code-text);border:1px solid var(--border);border-radius:var(--radius-md);padding:10px 12px;font-family:var(--font-mono);font-size:11px;line-height:1.6;margin:0;white-space:pre-wrap"></pre>
    </div>
    <div class="field" data-tier="installation">
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
    <div class="field" data-tier="organisation">
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
    <div class="field" data-tier="organisation">
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
    <div class="field" data-tier="installation">
      <label>Channels</label>
      <div id="setchannels" style="display:flex;flex-direction:column;gap:6px"></div>
      <div class="fieldnote">A channel turns on when its credentials are in the environment or the
        env map of the config file (Feishu: FEISHU_APP_ID + FEISHU_APP_SECRET; Telegram:
        TELEGRAM_BOT_TOKEN; DingTalk: DINGTALK_CLIENT_ID + DINGTALK_CLIENT_SECRET).</div>
    </div>
    <div class="field" data-tier="installation" id="setmcpwrap" style="display:none">
      <label>MCP servers</label>
      <div id="setmcp" style="display:flex;flex-direction:column;gap:6px"></div>
      <div class="fieldnote">Tools other people wrote. Configured in mcpServers in
        ~/.agentbox/config.json — a stdio server is a process on this machine, so an operator
        adds one, never an agent. Their tools obey the same agent tool lists, scopes and
        approvals as the built-in ones.</div>
    </div>
    <div class="field" data-tier="organisation" id="setknockswrap" style="display:none">
      <label>Waiting at the door</label>
      <div id="setknocks" style="display:flex;flex-direction:column;gap:6px"></div>
      <div class="fieldnote">People who messaged the bot and are not on the list yet. One click
        lets them in, and they are told so on the channel they knocked from.</div>
    </div>
    <div class="field" data-tier="organisation">
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
    <div class="field" data-tier="personal" id="setmcptokenswrap" style="display:none">
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
    <div class="field" data-tier="personal" id="setgrantswrap" style="display:none">
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

function renderMcp() {
  fetch("/api/mcp")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var servers = data.servers || [];
      renderMcpTokens(data.tokens);
      // The server list is an installation matter; an admin who has none still sees
      // nothing, because there is nothing to say.
      document.getElementById("setmcpwrap").style.display =
        servers.length && myRole === "admin" ? "" : "none";
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
      $("setchannels").innerHTML = (data.channels || []).map(function (ch) {
        var cls = ch.running ? "ok" : ch.configured ? "bad" : "";
        return '<div style="display:flex;gap:9px;align-items:center;font-size:13px">' +
          '<span class="dot ' + cls + '"></span>' +
          "<span style=\"min-width:70px\">" + esc(ch.name) + "</span>" +
          '<span class="dim mono" style="font-size:11px">' + esc(ch.detail) + "</span></div>";
      }).join("");
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

document.getElementById("setknocks").addEventListener("click", function (event) {
  var target = event.target;
  if (!target.getAttribute) return;
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
    var shut = group.classList.contains("shut");
    link.textContent =
      (shut ? "\u25b8 show " : "\u25be hide ") + n + (n === 1 ? " step" : " steps");
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

function beginStep(text) {
  var chat = $("chat");
  var stick = nearBottom(chat);
  var step = document.createElement("details");
  step.className = "step";
  step.open = !folded;
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
    // The transcript emits a round's prose immediately before its calls, so the pairing
    // needs no guessing — if no round was opened by that prose, this round had none.
    if (!openStep) beginStep("");
    for (var t = 0; t < entry.tools.length; t++) {
      var call = entry.tools[t];
      toolCall(call.name, call.detail, call.result, call.isError);
    }
    endStep();
    return;
  }
  // Narration opens the round its calls will be filed under; anything else is a message.
  if (entry.aside) {
    beginStep(entry.text);
    return;
  }
  endStep();
  bubble(entry.role === "user" ? "user" : "", entry.role === "user" ? "you" : nameOf(id), entry.text);
}

function agentById(id) {
  for (var i = 0; i < agents.length; i++) if (agents[i].id === id) return agents[i];
  return null;
}

function select(id, conversation) {
  var switching = id !== current;
  current = id;
  currentConversation = conversation || (switching ? "main" : currentConversation);
  $("title").textContent = nameOf(id);
  var selected = agentById(id);
  $("titlerole").textContent = selected ? String(selected.title || "") : "";
  $("round").textContent = "";
  spend = { input: 0, output: 0 };
  spendLabel = "";
  roundLabel = "";
  renderAgents();
  showDesktop(id);
  if (switching) refreshConversations(id);
  updateComposerTarget();
  $("chat").innerHTML = "";
  live.delete(id);

  return fetch("/api/transcript?agent=" + encodeURIComponent(id) +
      "&conversation=" + encodeURIComponent(currentConversation))
    .then(function (r) { return r.json(); })
    .then(function (entries) {
      for (var i = 0; i < entries.length; i++) replayEntry(id, entries[i]);
      $("chat").scrollTop = $("chat").scrollHeight;
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
  return fetchConversations(id, 0).then(function (data) {
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
  var bars = document.querySelectorAll(".steps");
  for (var b = 0; b < bars.length; b++) {
    bars[b].classList.toggle("shut", folded);
    if (bars[b].relabel) bars[b].relabel();
  }
  $("foldall").textContent = folded ? "unfold steps" : "fold steps";
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
      // Who spent it, on hover — the per-person breakdown the enterprise framework asks for.
      var by = state.usageByPrincipal || [];
      $("spendtoday").title = by.length
        ? "Today, by person:\n" + by.map(function (p) {
            return "  " + p.name + ": " + fmtTokens(p.inputTokens) + " in / " + fmtTokens(p.outputTokens) + " out";
          }).join("\n")
        : "Tokens spent today, all agents";
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

/** Which of the three views the right-hand pane is showing. */
function showTab(which) {
  $("desktopview").style.display = which === "desktop" ? "" : "none";
  $("filesview").style.display = which === "files" ? "flex" : "none";
  $("tasksview").style.display = which === "tasks" ? "flex" : "none";
  $("tabdesktop").className = "tab" + (which === "desktop" ? " on" : "");
  $("tabfiles").className = "tab" + (which === "files" ? " on" : "");
  $("tabtasks").className = "tab" + (which === "tasks" ? " on" : "");
  if (which === "files") refreshFiles();
  if (which === "tasks") refreshTasks();
}
document.getElementById("tabdesktop").addEventListener("click", function (e) { e.preventDefault(); showTab("desktop"); });
document.getElementById("tabfiles").addEventListener("click", function (e) { e.preventDefault(); showTab("files"); });
document.getElementById("tabtasks").addEventListener("click", function (e) { e.preventDefault(); showTab("tasks"); });

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
    "</div>";
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
        return '<div style="padding:10px 16px;border-bottom:1px solid var(--border)' +
            (open ? ";background:var(--surface)" : "") + '">' +
          '<div style="display:flex;gap:9px;align-items:baseline">' +
            '<a href="#" data-open="' + esc(t.id) + '" class="mono" style="font-size:11px;color:var(--muted);text-decoration:none">' + esc(t.id) + "</a>" +
            '<a href="#" data-open="' + esc(t.id) + '" style="flex:1;font-size:13px;font-weight:500;color:var(--text);text-decoration:none">' + esc(t.title) + "</a>" +
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
    endStep();
    if (inView(e)) bubble("user", "you", e.text);
    return;
  }

  if (e.type === "text") {
    if (!inView(e)) return;
    // Prose arriving with no round open is the answer, and prose after a round has run is
    // the answer too — either way it belongs outside the tree.
    endStep();
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
    // Text followed by a tool call is narration, not the answer — the same distinction
    // turn.ts already makes when it decides whether a round is final. Marking it here is
    // what lets the two read differently: the process de-emphasised, the answer not.
    // The sentence that was streaming is revealed to have been a heading: the calls that
    // follow belong under it. Opening the round here rather than at text time is what
    // makes a final answer — text with no calls after it — stay out of the tree.
    var narrating = live.get(e.agentId);
    if (narrating && narrating.node) {
      var said = narrating.text;
      var block = narrating.node.parentNode;
      if (block && block.parentNode) block.parentNode.removeChild(block);
      beginStep(said);
    } else if (!openStep) {
      beginStep("");
    }
    live.delete(e.agentId);
    // Held so the result can be folded into the same row when it arrives.
    if (inView(e)) {
      openTool.set(e.agentId, toolCall(e.tool, toolDetail(e.tool, e.input)));
    }
    return;
  }

  if (e.type === "tool_end") {
    var row = openTool.get(e.agentId);
    openTool.delete(e.agentId);
    if (!inView(e) || !row) return;
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
    // Teammates talk in the team room, never inside someone's outside chat, so these
    // only render when the team room is the one on screen.
    if (currentConversation !== "main") return;
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
  $("input").value = "";
  $("send").disabled = true;
  fetch("/api/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Send to the thread on screen, not always the team room: reading a chat thread
    // and replying should reach that chat, not surface in the room the reader left.
    body: JSON.stringify({ agent: current, text: text, conversation: currentConversation })
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
refresh().then(loadActivity).then(loadRecordings);
setInterval(refresh, 15000);

// A chat card's "open in the workshop" link lands here: the board, with that task
// already open. Done after the first refresh so the roster is there to name people.
if (openTask) showTab("tasks");
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
export const LOGIN_HTML = String.raw`<!doctype html>
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
