/**
 * The Settings dialog's markup, extracted from app-html.ts for the size ratchet: the
 * page template is one String.raw literal, so its length is the file's length, and this
 * dialog is the largest self-contained, interpolation-free chunk in it. It is composed
 * back in at the position it always occupied; the browser script that drives these ids
 * still lives in app-html.ts, and app-html.test.ts checks the composed result, so an id
 * lost in the move fails the build rather than a person's first load. The tab row is rendered
 * from settings-registry.ts, the panes' one home (INV-1660).
 */
import { renderSettingsTabs } from "./settings-registry.ts";

export const SETTINGS_DIALOG_HTML = `
<!-- Settings. What is here is exactly what the config file holds: the provider choice
     the launch command used to carry, its model override, and the key. -->
<div id="settingswrap" style="display:none">
  <div class="modal">
    <h3>{{ui.settings.settings}}</h3>
    <div id="settabs" class="tabs" style="display:flex;gap:6px;flex-wrap:wrap">
${renderSettingsTabs()}
    </div>
    <div class="fieldnote" id="setwelcome" style="display:none;border:1px solid var(--border);border-radius:var(--radius-md);padding:10px 12px;color:var(--text-soft)">
      {{ui.settings.welcome-lumenbox-needs-two-things}}
    </div>
    <div class="field" data-tier="installation" data-settab="model">
      <label>{{ui.settings.provider}}</label>
      <select id="setprovider"></select>
    </div>
    <div class="field" data-tier="installation" data-settab="model">
      <label>{{ui.settings.model}}</label>
      <input id="setmodel" list="modellist" placeholder="{{ui.settings.preset-default}}" spellcheck="false">
      <datalist id="modellist"></datalist>
    </div>
    <div class="field" data-tier="installation" id="setbasewrap" style="display:none" data-settab="model">
      <label>{{ui.settings.base-url}}</label>
      <input id="setbase" placeholder="{{ui.settings.https}}" spellcheck="false">
    </div>
    <div class="field" data-tier="installation" data-settab="model">
      <label>{{ui.settings.can-see-images}}</label>
      <select id="setvision">
        <option value="auto">{{ui.settings.follow-the-models-default}}</option>
        <option value="on">{{ui.settings.yes-even-if-the-preset}}</option>
        <option value="off">{{ui.settings.no-withhold-the-screen}}</option>
      </select>
      <div class="fieldnote">{{ui.settings.decides-whether-agents-get-the}}</div>
    </div>
    <div class="field" data-tier="installation" data-settab="model">
      <label>{{ui.settings.summary-model}}</label>
      <input id="setsummarymodel" placeholder="{{ui.settings.cheaper-model-for-compaction-memory}}" spellcheck="false">
    </div>
    <div class="fieldnote" id="seteffective"></div>
    <div class="field" data-tier="installation" data-settab="model">
      <label>{{ui.settings.api-key}}</label>
      <input id="setkey" type="password" spellcheck="false" autocomplete="off">
      <div class="fieldnote" id="setkeynote"></div>
    </div>
    <div class="field" data-tier="installation" data-settab="model">
      <label>{{ui.settings.web-search-key}}</label>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <select id="setsearchprov" style="min-width:130px"></select>
        <input id="setsearchkey" type="password" placeholder="{{ui.settings.paste-search-key}}" spellcheck="false" autocomplete="off" style="flex:1;min-width:140px">
      </div>
      <div class="fieldnote" id="setsearchnote"></div>
    </div>
    <div class="fieldnote">{{ui.settings.saved-to-agentbox-config-json}}</div>
    <div class="field" data-tier="installation" data-settab="model" id="setpartswrap" style="display:none">
      <label>{{ui.settings.built-in-rules}}</label>
      <div class="fieldnote">{{ui.settings.the-prompt-parts-every-agent}}</div>
      <div id="setparts"></div>
    </div>
    <div class="field" data-tier="installation" data-settab="memory">
      <label>{{ui.settings.memory}}</label>
      <div class="fieldnote" style="margin:0">{{ui.settings.what-each-agent-has-kept}}</div>
      <div id="setmemstate" class="fieldnote" style="margin:4px 0 0"></div>
      <div id="setmemsummary" style="display:flex;flex-direction:column;gap:6px"></div>
      <div id="setmemdetail" style="display:none;margin-top:8px;border:1px solid var(--border);border-radius:var(--radius-md);padding:8px 10px">
        <div style="display:flex;gap:8px;align-items:baseline"><strong id="setmemtitle" style="flex:1"></strong><a href="#" id="setmemback" class="dim" style="font-size:12px">{{ui.settings.back}}</a></div>
        <div id="setmemlines" style="display:flex;flex-direction:column;gap:6px;margin-top:6px;max-height:320px;overflow:auto"></div>
      </div>
    </div>
    <div class="field" data-tier="installation" id="setboxwrap" data-settab="boxes">
      <label>{{ui.settings.box}}</label>
      <div class="fieldnote" id="setboxstate" style="margin:0"></div>
      <div id="setboxactions" style="display:none">
        <button class="btn sm" id="setboxup">{{ui.settings.start-the-box}}</button>
      </div>
      <pre id="setboxlog" style="display:none;max-height:140px;overflow:auto;background:var(--code-bg);color:var(--code-text);border:1px solid var(--border);border-radius:var(--radius-md);padding:10px 12px;font-family:var(--font-mono);font-size:11px;line-height:1.6;margin:0;white-space:pre-wrap"></pre>
      <input id="setboximage" placeholder="{{ui.settings.image-override-e-g-mirror}}" spellcheck="false" style="margin-top:8px">
      <div class="fieldnote" style="margin-top:4px">{{ui.settings.what-docker-pulls-when-this}}</div>
    </div>
    <div class="field" data-tier="installation" data-settab="boxes">
      <label>{{ui.settings.personal-box-allocation-limits}}</label>
      <div class="fieldnote">{{ui.settings.limits-apply-when-assigning-a}}</div>
      <input id="setquotadefault" type="number" min="0" max="99" step="1" placeholder="{{ui.settings.default-unlimited}}">
      <div id="setdirectories"></div>
      <div class="fieldnote">{{ui.settings.sync-enrolls-a-channel-in}}</div>
      <div id="setquotadepartments"></div>
      <div id="setquotapeople"></div>
      <button class="btn sm" id="setquotasave" type="button">{{ui.settings.save-allocation-limits}}</button>
      <div class="fieldnote" id="setquotastatus" role="status"></div>
    </div>
    <div class="field" data-tier="installation" id="setboxeswrap" data-settab="boxes">
      <label>{{ui.settings.boxes}}</label>
      <div id="setboxes" style="display:flex;flex-direction:column;gap:6px"></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:4px">
        <input id="setboxname" placeholder="{{ui.settings.name-e-g-grok}}" spellcheck="false" style="flex:0.7;min-width:90px;font-family:var(--font-sans)">
        <input id="setboxurl" placeholder="{{ui.settings.http-127-0-0-1}}" spellcheck="false" style="flex:1.4;min-width:160px">
        <input id="setboxtoken" type="password" placeholder="{{ui.settings.its-boxd-token}}" spellcheck="false" autocomplete="off" style="flex:1;min-width:120px">
        <input id="setboxfloor" placeholder="{{ui.settings.first-display-e-g-10}}" spellcheck="false" style="flex:0.7;min-width:110px">
        <button class="btn sm" id="setboxattach">{{ui.settings.attach}}</button>
      </div>
      <div class="fieldnote">{{ui.settings.every-machine-this-installation-drives}}</div>
      <div class="fieldnote" id="setboxesstatus"></div>
    </div>
    <div class="field" data-tier="installation" data-settab="boxes">
      <label>{{ui.settings.host-execution}}</label>
      <label class="radio"><input type="checkbox" id="sethostenabled">
        {{ui.settings.let-agents-run-commands-on}}</label>
      <input id="sethostcwd" placeholder="{{ui.settings.working-directory-e-g-users}}" spellcheck="false">
      <div class="fieldnote">{{ui.settings.off-by-default-and-the}} <code>pi</code>,
        <code>claude</code> {{ui.settings.or}} <code>git</code>{{ui.settings.every-host-command-still-stops}}</div>
      <div class="fieldnote" id="sethoststatus"></div>
    </div>
    <div class="field" data-tier="installation" data-settab="boxes">
      <label>{{ui.settings.startup-item}}</label>
      <label class="radio"><input type="checkbox" id="setstartupitem">
        {{ui.settings.launch-lumenbox-automatically-on-system}}</label>
      <div class="fieldnote">{{ui.settings.registers-lumenbox-as-a-login}}</div>
    </div>
    <div class="field" data-tier="organisation" data-settab="team">
      <label>{{ui.settings.scopes}}</label>
      <div id="setscopes" style="display:flex;flex-direction:column;gap:6px"></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input id="setscopename" placeholder="{{ui.settings.scope-name-e-g-vendor}}" spellcheck="false" style="flex:1;min-width:120px;font-family:var(--font-sans)">
        <button class="btn sm" id="setscopeadd">{{ui.settings.add}}</button>
      </div>
      <div class="fieldnote">{{ui.settings.a-scope-is-a-named}}</div>
      <div class="fieldnote" id="setscopestatus"></div>
    </div>
    <div class="field" data-tier="organisation" data-settab="team">
      <label>{{ui.settings.secrets}}</label>
      <div id="setsecrets" style="display:flex;flex-direction:column;gap:6px"></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input id="setsecid" placeholder="GITHUB_TOKEN" spellcheck="false" style="flex:1;min-width:110px">
        <input id="setsecval" type="password" placeholder="{{ui.settings.value}}" spellcheck="false" autocomplete="off" style="flex:1;min-width:110px">
        <input id="setsecgrant" placeholder="{{ui.settings.or-agent-id-or-principal}}" spellcheck="false" style="flex:1.3;min-width:130px;font-family:var(--font-sans);font-size:12px">
        <input id="setsecsites" placeholder="{{ui.settings.sites-github-com-example-com}}" spellcheck="false" title="{{ui.settings.where-a-browser-may-type}}" style="flex:1.3;min-width:150px;font-family:var(--font-sans);font-size:12px">
        <button class="btn sm" id="setsecadd">{{ui.settings.add}}</button>
      </div>
      <div class="fieldnote">{{ui.settings.a-credential-given-to-who}}</div>
      <div class="fieldnote" id="setsecstatus"></div>
    </div>
    <div class="field" data-tier="installation" data-settab="doors">
      <label>{{ui.settings.connectors}}</label>
      <div id="setconns" style="display:flex;flex-direction:column;gap:6px"></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <select id="setconnprov" style="min-width:120px"></select>
        <input id="setconnid" placeholder="{{ui.settings.client-id-app-id}}" spellcheck="false" autocomplete="off" style="flex:1;min-width:110px">
        <input id="setconnsecret" type="password" placeholder="{{ui.settings.client-secret-app-secret}}" spellcheck="false" autocomplete="off" style="flex:1;min-width:110px">
        <input id="setconngrant" placeholder="{{ui.settings.or-agent-id-or-principal}}" spellcheck="false" style="flex:1.2;min-width:130px;font-family:var(--font-sans);font-size:12px">
        <button class="btn sm" id="setconnadd">{{ui.settings.connect}}</button>
      </div>
      <div class="fieldnote" id="setconnsetup"></div>
      <div class="fieldnote">{{ui.settings.an-oauth-authorization-or-an}}</div>
      <div class="fieldnote" id="setconnstatus"></div>
    </div>
    <div class="field" data-tier="installation" data-settab="doors">
      <label>{{ui.settings.channels}}</label>
      <div id="setchannels" style="display:flex;flex-direction:column;gap:6px"></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <select id="setchtype" style="height:38px;border-radius:var(--radius-input);border:1px solid var(--border-strong);background:var(--bg);color:var(--text);padding:0 8px">
          <option value="feishu" selected>{{ui.settings.feishu}}</option>
          <option value="dingtalk">{{ui.settings.dingtalk}}</option>
        </select>
        <input id="setchid" placeholder="{{ui.settings.feishu-work}}" spellcheck="false" style="flex:1;min-width:90px">
        <input id="setchname" placeholder="{{ui.settings.display-name}}" spellcheck="false" style="flex:1;min-width:70px">
        <select id="setchagent" style="height:38px;border-radius:var(--radius-input);border:1px solid var(--border-strong);background:var(--bg);color:var(--text);padding:0 8px"></select>
        <input id="setchappid" placeholder="{{ui.settings.app-client-id}}" spellcheck="false" style="flex:1;min-width:90px">
        <input id="setchsecret" type="password" placeholder="{{ui.settings.secret}}" spellcheck="false" autocomplete="off" style="flex:1;min-width:90px">
        <button class="btn sm" id="setchadd">{{ui.settings.add-channel}}</button>
      </div>
      <div class="fieldnote">{{ui.settings.each-row-is-a-channel}}</div>
      <div class="fieldnote" id="setchstatus"></div>
    </div>
    <div class="field" data-tier="installation" id="setmcpwrap" style="display:none" data-settab="team">
      <label>{{ui.settings.mcp-servers}}</label>
      <div id="setmcp" style="display:flex;flex-direction:column;gap:6px"></div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
        <button type="button" class="ghost" id="setmcpreload">{{ui.settings.reload-from-config}}</button>
        <span class="dim" id="setmcpreloaded" style="font-size:12px"></span>
      </div>
      <div id="setext" class="dim" style="font-size:12px;margin-top:8px"></div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
        <button type="button" class="ghost" id="setextreload">{{ui.settings.reload-extensions}}</button>
        <span class="dim" id="setextreloaded" style="font-size:12px"></span>
      </div>
      <div class="fieldnote">{{ui.settings.tools-other-people-wrote-configured}}</div>
    </div>
    <div class="field" data-tier="organisation" id="setknockswrap" style="display:none" data-settab="doors">
      <label>{{ui.settings.waiting-to-be-let-in}}</label>
      <div id="setknocks" style="display:flex;flex-direction:column;gap:6px"></div>
      <div class="fieldnote">{{ui.settings.people-who-messaged-an-agent}}</div>
    </div>
    <div class="field" data-tier="organisation" data-settab="team">
      <label>{{ui.settings.people}}</label>
      <div id="setpeople" style="display:flex;flex-direction:column;gap:6px"></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <select id="setinvrole" style="height:38px;border-radius:var(--radius-input);border:1px solid var(--border-strong);background:var(--bg);color:var(--text);padding:0 8px">
          <option value="driver" selected>{{ui.settings.driver}}</option>
          <option value="viewer">{{ui.settings.viewer}}</option>
          <option value="admin">{{ui.settings.admin}}</option>
        </select>
        <button class="btn sm" id="setinvite">{{ui.settings.new-invite-code}}</button>
        <span id="setinviteout" class="mono" style="font-size:12px"></span>
      </div>
      <div class="fieldnote">{{ui.settings.an-invite-code-works-once}}
        <span class="mono">{{ui.settings.bind-code}}</span> {{ui.settings.to-an-agent-on-any}}</div>
      <details style="margin-top:2px">
        <summary class="fieldnote" style="cursor:pointer;margin:0">{{ui.settings.add-by-id-manually}}</summary>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px">
          <input id="setpname" placeholder="{{ui.settings.name}}" spellcheck="false" style="flex:1;min-width:90px;font-family:var(--font-sans)">
          <input id="setpid" placeholder="{{ui.settings.telegram-123456-or-involute-actor}}" spellcheck="false" style="flex:1.4;min-width:120px">
          <select id="setprole" style="height:38px;border-radius:var(--radius-input);border:1px solid var(--border-strong);background:var(--bg);color:var(--text);padding:0 8px">
            <option value="viewer">{{ui.settings.viewer}}</option>
            <option value="driver" selected>{{ui.settings.driver}}</option>
            <option value="admin">{{ui.settings.admin}}</option>
          </select>
          <button class="btn sm" id="setpadd">{{ui.settings.add}}</button>
        </div>
        <div class="fieldnote" style="margin-top:6px">{{ui.settings.someone-who-mentions-an-agent}}
          <span class="mono">{{ui.settings.involute-actor-id}}</span> {{ui.settings.to-that-person-the-id}}</div>
      </details>
      <div class="fieldnote" id="setpeoplestatus"></div>
    </div>
    <div class="field" data-tier="personal" id="setmcptokenswrap" style="display:none" data-settab="mine">
      <label>{{ui.settings.your-mcp-tokens}}</label>
      <div id="setmcptokens" style="display:flex;flex-direction:column;gap:6px"></div>
      <div style="display:flex;gap:6px;margin-top:6px">
        <input id="setmcplabel" placeholder="{{ui.settings.what-it-is-for-e}}" style="flex:1">
        <button class="btn" id="setmcpadd">{{ui.settings.issue}}</button>
      </div>
      <div class="fieldnote" id="setmcpnew" style="word-break:break-all"></div>
      <div class="fieldnote">{{ui.settings.lets-an-editor-or-another}}</div>
    </div>
    <div class="field" data-tier="personal" id="setgrantswrap" style="display:none" data-settab="mine">
      <label>{{ui.settings.standing-approvals}}</label>
      <div id="setgrants" style="display:flex;flex-direction:column;gap:6px"></div>
      <div class="fieldnote">{{ui.settings.each-covers-one-exact-action}}</div>
    </div>
    <div class="field" data-tier="personal" id="settierwrap" style="display:none" data-settab="mine">
      <label>{{ui.settings.would-have-asked-last-7}}</label>
      <div id="settier" style="display:flex;flex-direction:column;gap:6px"></div>
      <div class="fieldnote">{{ui.settings.actions-that-reach-past-the}}
        <code>{{ui.settings.agentbox-tier-gate-enforce}}</code> {{ui.settings.would-have-asked-you-about}}</div>
    </div>
    <div class="fieldnote" id="setstatus"></div>
    <div class="actions">
      <button class="btn" id="settest">{{ui.settings.test-connection}}</button>
      <button class="btn accent" id="setsaverestart">{{ui.settings.save-restart}}</button>
      <button class="btn" id="setsave">{{ui.settings.save}}</button>
      <button class="btn ghost" id="setcancel">{{ui.settings.cancel}}</button>
    </div>
  </div>
</div>`;
