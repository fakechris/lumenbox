/**
 * The Settings dialog's markup, extracted from app-html.ts for the size ratchet: the
 * page template is one String.raw literal, so its length is the file's length, and this
 * dialog is the largest self-contained, interpolation-free chunk in it. It is composed
 * back in at the position it always occupied; the browser script that drives these ids
 * still lives in app-html.ts, and app-html.test.ts checks the composed result, so an id
 * lost in the move fails the build rather than a person's first load.
 */
export const SETTINGS_DIALOG_HTML = `
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
      <a href="#" class="tab" data-settab="memory">Memory</a>
    </div>
    <div class="fieldnote" id="setwelcome" style="display:none;border:1px solid var(--border);border-radius:var(--radius-md);padding:10px 12px;color:var(--text-soft)">
      Welcome. LumenBox needs two things before agents can work: a model provider with a
      key, and the box &mdash; one Linux computer with a desktop, a browser and a shell,
      running in Docker on this machine, so Docker Desktop or OrbStack must be installed
      and started first. Both are set up here. Optionally, a web search key (Keenable,
      Brave or Tavily — any one of them) turns on the WebSearch tool; without it agents
      search through the box's browser instead.
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
      <label>Can see images</label>
      <select id="setvision">
        <option value="auto">Follow the model's default</option>
        <option value="on">Yes, even if the preset says no</option>
        <option value="off">No, withhold the screen</option>
      </select>
      <div class="fieldnote">Decides whether agents get the computer tool and screenshots. "Yes" is how a newly
        capable model is switched on without a release.</div>
    </div>
    <div class="field" data-tier="installation" data-settab="model">
      <label>Summary model</label>
      <input id="setsummarymodel" placeholder="cheaper model for compaction, memory and review (optional)" spellcheck="false">
    </div>
    <div class="fieldnote" id="seteffective"></div>
    <div class="field" data-tier="installation" data-settab="model">
      <label>API key</label>
      <input id="setkey" type="password" spellcheck="false" autocomplete="off">
      <div class="fieldnote" id="setkeynote"></div>
    </div>
    <div class="field" data-tier="installation" data-settab="model">
      <label>Web search key</label>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <select id="setsearchprov" style="min-width:130px"></select>
        <input id="setsearchkey" type="password" placeholder="paste search key" spellcheck="false" autocomplete="off" style="flex:1;min-width:140px">
      </div>
      <div class="fieldnote" id="setsearchnote"></div>
    </div>
    <div class="fieldnote">Saved to ~/.agentbox/config.json on this machine, mode 0600. A key stored
      here is used only when the environment does not already provide one, and is never placed
      inside the box. Provider, model, vision and summary model take effect on save; turns already
      running finish on the previous model. The host door, startup item and box image wait for a
      restart.</div>
    <div class="field" data-tier="installation" data-settab="model" id="setpartswrap" style="display:none">
      <label>Built-in rules</label>
      <div class="fieldnote">The prompt parts every agent reads: how a turn works, the front agent's short turns, unattended turns. Edit one here and it is yours; when a release changes the default you are shown both and asked. Prompt text only — no gate in code moves.</div>
      <div id="setparts"></div>
    </div>
    <div class="field" data-tier="installation" data-settab="memory">
      <label>Memory</label>
      <div class="fieldnote" style="margin:0">What each agent has kept, by box. Open an agent to read the lines, withdraw one, or
        correct it. A correction is an append — the old line is withdrawn and the new one kept — with a version check,
        so two people cannot silently overwrite each other; every change is audited in ~/.agentbox/memory-audit.jsonl and
        recalled by the next turn.</div>
      <div id="setmemstate" class="fieldnote" style="margin:4px 0 0"></div>
      <div id="setmemsummary" style="display:flex;flex-direction:column;gap:6px"></div>
      <div id="setmemdetail" style="display:none;margin-top:8px;border:1px solid var(--border);border-radius:var(--radius-md);padding:8px 10px">
        <div style="display:flex;gap:8px;align-items:baseline"><strong id="setmemtitle" style="flex:1"></strong><a href="#" id="setmemback" class="dim" style="font-size:12px">back</a></div>
        <div id="setmemlines" style="display:flex;flex-direction:column;gap:6px;margin-top:6px;max-height:320px;overflow:auto"></div>
      </div>
    </div>
    <div class="field" data-tier="installation" id="setboxwrap" data-settab="boxes">
      <label>Box</label>
      <div class="fieldnote" id="setboxstate" style="margin:0"></div>
      <div id="setboxactions" style="display:none">
        <button class="btn sm" id="setboxup">Start the box</button>
      </div>
      <pre id="setboxlog" style="display:none;max-height:140px;overflow:auto;background:var(--code-bg);color:var(--code-text);border:1px solid var(--border);border-radius:var(--radius-md);padding:10px 12px;font-family:var(--font-mono);font-size:11px;line-height:1.6;margin:0;white-space:pre-wrap"></pre>
      <input id="setboximage" placeholder="Image override, e.g. mirror.example.com/lumenbox:0.3.0 — empty uses the release default (fakechris/lumenbox, Docker Hub)" spellcheck="false" style="margin-top:8px">
      <div class="fieldnote" style="margin-top:4px">What docker pulls when this machine has no box image. Point it at a mirror if Docker Hub is slow or unreachable from your network; the first pull is hundreds of megabytes either way.</div>
    </div>
    <div class="field" data-tier="installation" data-settab="boxes">
      <label>Personal-box allocation limits</label>
      <div class="fieldnote">Limits apply when assigning a box to one person. Blank means unlimited by default, or inherit for a person. Lowering a limit keeps existing allocations. Self-service creation is not available yet.</div>
      <input id="setquotadefault" type="number" min="0" max="99" step="1" placeholder="Default: unlimited">
      <div id="setdirectories"></div>
      <div class="fieldnote">Sync enrolls a door in directory allocation checks. Resync within 24 hours; stale or failed sync pauses new allocations. Existing boxes remain. Person overrides take priority; multiple departments use the smallest configured limit.</div>
      <div id="setquotadepartments"></div>
      <div id="setquotapeople"></div>
      <button class="btn sm" id="setquotasave" type="button">Save allocation limits</button>
      <div class="fieldnote" id="setquotastatus" role="status"></div>
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
        <input id="setsecsites" placeholder="sites: github.com, *.example.com — or git, github.com" spellcheck="false" title="Where a browser may type this secret. Empty means it can be used in a host command but never filled into a web page. Write git among the sites for a git token: a host command then hands it to git through a one-run credential helper for those hosts (github.com when none) instead of its environment." style="flex:1.3;min-width:150px;font-family:var(--font-sans);font-size:12px">
        <button class="btn sm" id="setsecadd">Add</button>
      </div>
      <div class="fieldnote">A credential, given to who may use it. It is delivered only through
        a host command (RunOnHost) — placed in that one command's environment on your machine,
        never written into the box — or typed into a web page by the browser, and only on the
        sites listed. The agent uses it by name and never sees the value. Every use is audited in
        ~/.agentbox/vault-audit.jsonl. To change who holds it or its sites, add it again under the
        same name; the value is kept when you leave that box empty.</div>
      <div class="fieldnote" id="setsecstatus"></div>
    </div>
    <div class="field" data-tier="installation" data-settab="doors">
      <label>Connected services</label>
      <div id="setconns" style="display:flex;flex-direction:column;gap:6px"></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <select id="setconnprov" style="min-width:120px"></select>
        <input id="setconnid" placeholder="client id / app id" spellcheck="false" autocomplete="off" style="flex:1;min-width:110px">
        <input id="setconnsecret" type="password" placeholder="client secret / app secret" spellcheck="false" autocomplete="off" style="flex:1;min-width:110px">
        <input id="setconngrant" placeholder="* or agent:id or principal:id" spellcheck="false" style="flex:1.2;min-width:130px;font-family:var(--font-sans);font-size:12px">
        <button class="btn sm" id="setconnadd">Connect</button>
      </div>
      <div class="fieldnote" id="setconnsetup"></div>
      <div class="fieldnote">An OAuth authorization or an app credential, finished on this machine. The
        token lives in the vault as oauth:&lt;provider&gt;, is refreshed here when it lapses, and is
        attached by the host to every connector_request an agent makes — the agent never sees it, and
        a box's bundles or the grant above decide who may call. Writes are reviewed like any outward act.</div>
      <div class="fieldnote" id="setconnstatus"></div>
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
          <input id="setpid" placeholder="telegram:123456 or involute:&lt;actor id&gt;" spellcheck="false" style="flex:1.4;min-width:120px">
          <select id="setprole" style="height:38px;border-radius:var(--radius-input);border:1px solid var(--border-strong);background:var(--bg);color:var(--text);padding:0 8px">
            <option value="viewer">viewer</option>
            <option value="driver" selected>driver</option>
            <option value="admin">admin</option>
          </select>
          <button class="btn sm" id="setpadd">Add</button>
        </div>
        <div class="fieldnote" style="margin-top:6px">Someone who @-mentions an agent on Involute is
          answered only if their Involute identity is linked to a person here: add
          <span class="mono">involute:&lt;actor id&gt;</span> to that person (the id is in the refusal
          they received, and on their Involute profile). A driver in the agent's box is answered; a
          viewer, or somebody outside the box, is told why not. Remove the row to unlink.</div>
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
    <div class="field" data-tier="personal" id="settierwrap" style="display:none" data-settab="mine">
      <label>Would have asked (last 7 days)</label>
      <div id="settier" style="display:flex;flex-direction:column;gap:6px"></div>
      <div class="fieldnote">Actions that reach past the box — an outside service, an upload, a
        tool we cannot see into — or touch authority. Nothing here was stopped: this is what
        <code>AGENTBOX_TIER_GATE=enforce</code> would have asked you about.</div>
    </div>
    <div class="fieldnote" id="setstatus"></div>
    <div class="actions">
      <button class="btn" id="settest">Test connection</button>
      <button class="btn accent" id="setsaverestart">Save &amp; restart</button>
      <button class="btn" id="setsave">Save</button>
      <button class="btn ghost" id="setcancel">Cancel</button>
    </div>
  </div>
</div>`;
