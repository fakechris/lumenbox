/** Panel width, rather than window width, owns toolbar wrapping (docs/92 §4). */
export const PANE_HEADER_STYLE = String.raw`
.paneheader {
  position:relative; flex:none; min-height:52px; height:auto; box-sizing:border-box;
  display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between;
  gap:8px 16px; padding:8px 18px; border-bottom:1px solid var(--border);
}
.paneheader .lead, .paneheader .headactions {
  display:flex; flex-wrap:wrap; align-items:center; gap:8px; min-width:0; max-width:100%;
}
.paneheader .lead { flex:1 1 16rem; }
.paneheader .headactions { flex:0 1 auto; margin-left:auto; justify-content:flex-end; }
.paneheader .lead > *, .paneheader .headactions > * { min-width:0; max-width:100%; box-sizing:border-box; }
.paneheader a { font-size:12px; }
#title { font-weight:600; font-size:1rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#titlerole { font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#agentcfg, #agentdel { flex:none; } #agentdel { color:var(--danger); }
#convwrap { flex:0 1 auto; }
#convbtn { text-decoration:none; max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.paneheader .cvchip { flex:0 1 auto; white-space:normal; overflow-wrap:anywhere; }
.roundpill {
  display:flex; align-items:center; gap:7px; font-family:var(--font-mono); font-size:12px;
  color:var(--accent); background:var(--accent-soft); padding:4px 10px; border-radius:var(--radius-pill);
  white-space:normal; overflow-wrap:anywhere;
}
.roundpill:empty { display:none; }
#stop { flex:none; }
/* Overlays anchor to the header, not whichever wrapped row contains their trigger. */
.paneheader #sharemenu { top:100%; right:18px; min-width:0; width:220px; max-width:calc(100% - 36px); }
.paneheader #convpanel, .paneheader .cvpop {
  top:100%; left:18px; width:360px; min-width:0; max-width:calc(100% - 36px); box-sizing:border-box;
  max-height:60vh; overflow:auto;
}
.desktopcontext { display:flex; flex-wrap:wrap; align-items:center; gap:8px; flex:1 0 100%; min-width:0; }
.desktopcontext:has(#desktoptitle:empty):has(#boxclass[style*="display: none"]) { display:none; }
`;
