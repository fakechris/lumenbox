/** Global operator workspace; current conversation and member do not constrain this view. */
export const WORK_GOVERNANCE_STYLE = `
#wg-panel{position:fixed;inset:var(--topbar-h,48px) 0 0;z-index:80;background:var(--bg);color:var(--text);overflow:auto;padding:var(--sp-5);box-sizing:border-box}#wg-panel[hidden]{display:none}.wg-shell{max-width:1100px;margin:0 auto;min-width:0}.wg-head,.wg-nav,.wg-tools,.wg-actions{display:flex;gap:var(--sp-3);align-items:center;flex-wrap:wrap;min-width:0}.wg-head{justify-content:space-between}.wg-head h1{font-size:var(--fs-xl);margin:0}.wg-nav{margin:var(--sp-5) 0 var(--sp-3)}.wg-nav button[aria-current=true]{background:var(--accent-soft);color:var(--accent)}.wg-nav .btn,.wg-tools .btn,.wg-actions .btn{font-size:var(--fs-md);min-height:40px;white-space:normal;max-width:100%}.wg-note{color:var(--muted);font-size:var(--fs-sm);line-height:1.7;overflow-wrap:anywhere}.wg-tools input[type=search]{flex:1 1 240px;min-width:0}.wg-list{margin-top:var(--sp-4)}.wg-row{border-top:1px solid var(--border);padding:var(--sp-4) 0;display:grid;grid-template-columns:24px minmax(0,1fr);gap:var(--sp-3)}.wg-row summary{cursor:pointer;font-weight:600;font-size:var(--fs-md);overflow-wrap:anywhere}.wg-row p{line-height:1.7;overflow-wrap:anywhere}.wg-row input{width:18px;height:18px}.wg-details{padding:var(--sp-3) 0}.wg-actions{justify-content:space-between;margin-top:var(--sp-4)}#wg-preview{width:min(700px,calc(100vw - 32px));max-height:85vh;overflow:auto;box-sizing:border-box;border:1px solid var(--border);border-radius:var(--radius-md);padding:var(--sp-5);background:var(--surface);color:var(--text)}#wg-preview article{border-top:1px solid var(--border);padding:var(--sp-3) 0;overflow-wrap:anywhere}#wg-preview::backdrop{background:rgba(0,0,0,.35)}.wg-scope{font-weight:600}.wg-error{color:var(--danger)}
`;
export const WORK_GOVERNANCE_JS = String.raw`
(function(){
  var panel, list, status, tools, nav, metrics, boundary, boundaryBody, boundarySummary, previewDialog, previewBody, confirm, previewNote, previous, next, pager;
  var section="", search="", archive=false, offset=0, total=0, rows=[], selected=new Map(), nodes=new Map(), generation=0, pendingPreview, operationId, timer;
  var word=function(key){return t("ui.wg."+key);};
  function node(tag,text){var n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;}
  function button(text,run){var b=node("button",text);b.type="button";b.className="btn sm ghost";b.onclick=run;return b;}
  function request(path,data){return fetch(path,data?{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(data)}:{}).then(function(r){return r.json().then(function(data){if(!r.ok)throw Error(data.error||word("unavailable"));return data;});});}
  function label(key){var value=word(key);return value.indexOf("ui.wg.")===0?word("unknown"):value;}
  function mount(){
    if(panel)return;
    panel=node("section");panel.id="wg-panel";panel.hidden=true;panel.setAttribute("aria-label",word("title"));
    var shell=node("div");shell.className="wg-shell";panel.appendChild(shell);
    var head=node("div");head.className="wg-head";head.appendChild(node("h1",word("title")));head.appendChild(button(word("back"),function(){generation++;panel.hidden=true;document.getElementById("work-management-nav").focus();}));shell.appendChild(head);
    shell.appendChild(node("p",word("purpose"))).className="wg-note";
    nav=node("nav");nav.className="wg-nav";nav.setAttribute("aria-label",word("views"));
    nav.appendChild(button(word("myWork"),function(){panel.hidden=true;window.openTeamTasks();}));
    [["", "automatic"],["running","running"],["future","future"],["history","history"],["members","members"]].forEach(function(tab){var b=button(word(tab[1]),function(){section=tab[0];offset=0;selected.clear();load();});b.dataset.wgSection=tab[0];nav.appendChild(b);});shell.appendChild(nav);
    metrics=node("p");metrics.id="wg-metrics";metrics.className="wg-note";shell.appendChild(metrics);boundary=node("details");boundary.className="wg-note";boundary.id="wg-boundaries";boundarySummary=node("summary");boundaryBody=node("div");boundary.appendChild(boundarySummary);boundary.appendChild(boundaryBody);shell.appendChild(boundary);
    tools=node("div");tools.className="wg-tools";
    var input=node("input");input.type="search";input.id="wg-search";input.placeholder=word("search");input.setAttribute("aria-label",word("search"));input.oninput=function(){clearTimeout(timer);timer=setTimeout(function(){search=input.value;offset=0;selected.clear();load();},200);};tools.appendChild(input);
    var archiveLabel=node("label"), archiveBox=node("input");archiveBox.type="checkbox";archiveBox.id="wg-archive";archiveBox.onchange=function(){archive=archiveBox.checked;offset=0;load();};archiveLabel.appendChild(archiveBox);archiveLabel.appendChild(document.createTextNode(" "+word("archive")));tools.appendChild(archiveLabel);
    tools.appendChild(button(word("refresh"),load));shell.appendChild(tools);
    status=node("p");status.id="wg-status";status.className="wg-note";status.setAttribute("role","status");shell.appendChild(status);
    list=node("div");list.id="wg-list";list.className="wg-list";shell.appendChild(list);
    var actions=node("div");actions.className="wg-actions";
    actions.appendChild(button(word("preview"),showPreview)).id="wg-preview-action";
    previous=button(word("previous"),function(){offset=Math.max(0,offset-50);selected.clear();load();});next=button(word("next"),function(){offset+=50;selected.clear();load();});pager=node("span");pager.id="wg-pager";actions.appendChild(previous);actions.appendChild(pager);actions.appendChild(next);shell.appendChild(actions);
    document.body.appendChild(panel);
    list.addEventListener("change",function(e){var key=e.target.dataset.wgSelect;if(!key)return;var row=rows.find(function(r){return r.key===key;});if(e.target.checked&&row)selected.set(key,row.actions[0]);else selected.delete(key);selectionLabel();});
    list.addEventListener("click",function(e){var link=e.target.closest("[data-wg-task]");if(link){panel.hidden=true;window.openTaskFocus(link.dataset.wgTask);}var operation=e.target.closest("[data-wg-operation]");if(operation)showOperation(operation.dataset.wgOperation);});
    previewDialog=node("dialog");previewDialog.id="wg-preview";previewDialog.setAttribute("aria-label",word("preview"));previewDialog.appendChild(node("h2",word("preview")));previewBody=node("div");previewBody.id="wg-preview-body";previewDialog.appendChild(previewBody);previewNote=node("p");previewNote.setAttribute("role","status");previewDialog.appendChild(previewNote);
    var footer=node("div");footer.className="wg-actions";footer.appendChild(button(word("back"),function(){previewDialog.close();}));confirm=button(word("confirm"),apply);confirm.id="wg-confirm";footer.appendChild(confirm);previewDialog.appendChild(footer);document.body.appendChild(previewDialog);
  }
  function selectionLabel(){var b=document.getElementById("wg-preview-action");b.textContent=word("preview")+" ("+selected.size+")";b.disabled=!selected.size;}
  function paint(data){
    total=data.total;rows=data.rows;
    nav.querySelectorAll("[data-wg-section]").forEach(function(b){b.setAttribute("aria-current",String(b.dataset.wgSection===section));});
    metrics.textContent=word("executionCount")+": "+data.metrics.executions+" · "+word("futureCount")+": "+data.metrics.future+" · "+word("cardCount")+": "+data.metrics.cards;
    status.textContent=word("observed")+" "+new Date(data.observedAt).toLocaleTimeString()+" · "+word("zeroNotStopped");boundary.hidden=!data.unknown.length;boundarySummary.textContent=word("inventoryBoundary")+" · "+data.unknown.length;var boundaryText=data.unknown.map(label).join("\n");if(boundaryBody.textContent!==boundaryText)boundaryBody.textContent=boundaryText;
    var keep=new Set(rows.map(function(r){return r.key;}));nodes.forEach(function(n,key){if(!keep.has(key)){n.remove();nodes.delete(key);}});
    rows.forEach(function(row){
      var n=nodes.get(row.key);if(!n){n=node("article");n.className="wg-row";n.dataset.wgResource=row.key;nodes.set(row.key,n);}
      var html=(row.actions.length?'<label><input type="checkbox" data-wg-select="'+esc(row.key)+'" aria-label="'+esc(label(row.actions[0])+" · "+row.title)+'"'+(selected.has(row.key)?' checked':'')+'></label>':'<span></span>')+'<details><summary>'+esc(row.title)+'</summary><div class="wg-details"><p>'+esc(label(row.kind))+" · "+esc(row.revoked?label(row.revoked):label(row.state))+'</p><p class="wg-note">'+esc(word("source"))+": "+esc(label(row.source))+'</p><p>'+esc(row.next?new Date(row.next).toLocaleString():(row.conditions?row.conditions.map(label).join(" · "):label(row.condition||"noKnownTrigger")))+'</p><p class="wg-scope">'+esc(label(row.scope))+'</p>'+row.unknown.map(function(code){return '<p class="wg-note">'+esc(label(code))+'</p>';}).join("")+(row.kind==="operation"?'<button class="btn sm ghost" data-wg-operation="'+esc(row.target.id)+'">'+esc(word("reviewRetry"))+'</button>':'')+(row.taskId?'<button class="btn sm ghost" data-wg-task="'+esc(row.taskId)+'">'+esc(word("openWork"))+'</button>':'')+'</div></details>';
      if(n._html!==html&&!n.contains(document.activeElement)){var open=n.querySelector("details");var wasOpen=open&&open.open;n.innerHTML=html;n._html=html;if(wasOpen)n.querySelector("details").open=true;}
      list.appendChild(n);
    });
    if(!rows.length){if(!document.getElementById("wg-empty")){var empty=node("p",word("empty"));empty.id="wg-empty";list.appendChild(empty);}}else{var empty=document.getElementById("wg-empty");if(empty)empty.remove();}
    previous.disabled=offset===0;next.disabled=offset+50>=total;pager.textContent=(total?offset+1:0)+"–"+Math.min(offset+50,total)+" / "+total;selectionLabel();
  }
  function load(quiet){if(!panel||panel.hidden)return;if(quiet!==true){list.replaceChildren();nodes.clear();selected.clear();selectionLabel();}var ticket=++generation;status.textContent=word("loading");var query=new URLSearchParams({section:section,search:search,offset:String(offset),archive:archive?"1":"0"});if(!section)query.set("section","automatic");return request("/api/work-management?"+query).then(function(data){if(ticket!==generation||panel.hidden)return;paint(data);}).catch(function(e){if(ticket!==generation)return;status.textContent=e.message;});}
  function showPreview(){
    pendingPreview=null;operationId=crypto.randomUUID();confirm.disabled=true;previewBody.replaceChildren();previewNote.textContent=word("loading");if(!previewDialog.open)previewDialog.showModal();
    request("/api/work-management/preview",{choices:Array.from(selected,function(pair){return {key:pair[0],action:pair[1]};})}).then(function(data){
      pendingPreview=data;data.selections.forEach(function(choice){var article=node("article");article.appendChild(node("h3",choice.row.title));article.appendChild(node("p",label(choice.action)+" · "+label(choice.row.scope)));if(choice.row.members)article.appendChild(node("p",word("members")+": "+choice.row.members.join(", ")));if(choice.row.coverage)choice.row.coverage.forEach(function(resource){article.appendChild(node("p",word("affectedResources")+" · "+resource.count+" · "+label(resource.kind)));});choice.row.unknown.forEach(function(code){article.appendChild(node("p",label(code))).className="wg-note";});previewBody.appendChild(article);});previewNote.textContent=word("reviewScope");confirm.textContent=word("confirm");confirm.disabled=false;
    }).catch(function(e){previewNote.textContent=e.message;});
  }
  function showOperation(id){pendingPreview={token:""};operationId=id;confirm.disabled=true;previewBody.replaceChildren();previewNote.textContent=word("loading");if(!previewDialog.open)previewDialog.showModal();request("/api/work-management/operation?id="+encodeURIComponent(id)).then(function(data){data.selections.forEach(function(choice){var article=node("article");article.appendChild(node("h3",choice.row.title));article.appendChild(node("p",label(choice.action)+" · "+label(choice.row.scope)));choice.row.unknown.forEach(function(code){article.appendChild(node("p",label(code)));});previewBody.appendChild(article);});previewNote.textContent=word("reviewScope");confirm.textContent=word("retry");confirm.disabled=false;}).catch(function(e){previewNote.textContent=e.message;});}
  function apply(){if(!pendingPreview)return;confirm.disabled=true;previewNote.textContent=word("applying");request("/api/work-management/apply",{token:pendingPreview.token,operationId:operationId}).then(function(data){
    previewBody.replaceChildren();data.results.forEach(function(result){var choice=data.selections.find(function(c){return c.row.key===result.key;}),article=node("article");article.appendChild(node("h3",choice.row.title));article.appendChild(node("p",label(result.state)));if(result.detail)article.appendChild(node("p",label(result.detail))).className="wg-note";previewBody.appendChild(article);});var unfinished=data.results.some(function(row){return row.state!=="confirmed";});previewNote.textContent=unfinished?word("partial"):word("applied");confirm.textContent=word("retry");confirm.disabled=!unfinished;selected.clear();load();
    }).catch(function(e){previewNote.textContent=e.message;confirm.textContent=word("retry");confirm.disabled=false;});}
  window.openWorkManagement=function(){mount();panel.hidden=false;section="";offset=0;selected.clear();load();};
  document.addEventListener("click",function(e){if(e.target.closest("#work-management-nav")){e.preventDefault();window.openWorkManagement();}});
  setInterval(function(){if(panel&&!panel.hidden&&!previewDialog.open)load(true);},10000);
})();
`;
