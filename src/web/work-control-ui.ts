/** One action for the current work; legacy containment always requires an explicit member list. */
export const WORK_CONTROL_JS = `(function(){
  var dialog, body, note, confirm, preview, target, selected, labels, generation=0;
  function el(tag,text){var n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;}
  function request(path,method,data){return fetch(path,{method:method||"GET",headers:{"content-type":"application/json"},...(data?{body:JSON.stringify(data)}:{})}).then(function(r){return r.json().then(function(d){if(!r.ok)throw Error(d.error||r.status);return d;});});}
  function mount(){
    if(dialog)return;
    dialog=el("dialog");dialog.id="work-cancel-dialog";dialog.setAttribute("aria-labelledby","work-cancel-title");dialog.addEventListener("cancel",function(){generation++;});dialog.style.cssText="width:min(560px,calc(100vw - 48px));max-height:80vh;overflow:auto;border:1px solid var(--border);border-radius:var(--radius-md);padding:var(--sp-5);box-sizing:border-box;background:var(--surface);color:var(--text)";
    var title=el("h2","{{ui.wc.title}}");title.id="work-cancel-title";title.style.marginTop="0";dialog.appendChild(title);body=el("div");dialog.appendChild(body);note=el("p");note.setAttribute("role","status");dialog.appendChild(note);
    var actions=el("div");actions.className="ui-row";actions.style.justifyContent="flex-end";
    var close=el("button","{{ui.wc.back}}");close.className="btn ghost";close.onclick=function(){generation++;dialog.close();};actions.appendChild(close);
    confirm=el("button");confirm.className="btn";confirm.onclick=submit;actions.appendChild(confirm);dialog.appendChild(actions);document.body.appendChild(dialog);
  }
  function render(d){
    preview=d;body.replaceChildren();selected=[];body.appendChild(el("h3",d.title));
    if(d.legacy){
      body.appendChild(el("p","{{ui.wc.legacy}}"));
      (window.agents||[]).forEach(function(a){var label=el("label"),box=el("input");box.type="checkbox";box.value=a.id;label.className="ui-row";label.style.margin="8px 0";box.onchange=function(){selected=Array.from(body.querySelectorAll('input:checked')).map(function(n){return n.value;});confirm.disabled=!selected.length;};label.appendChild(box);label.appendChild(el("span",a.name));body.appendChild(label);});
      body.appendChild(el("p","{{ui.wc.queueWarning}}"));confirm.textContent="{{ui.wc.pauseSelected}}";confirm.disabled=true;return;
    }
    body.appendChild(el("p","{{ui.wc.members}} "+d.participants.map(function(a){return a.name;}).join(", ")));
    var counts={};d.resources.forEach(function(r){counts[r.kind]=(counts[r.kind]||0)+1;});
    labels={"model-route":"{{ui.wc.modelAccess}}","host-command":"{{ui.wc.hostCommand}}",command:"{{ui.wc.job}}",turn:"{{ui.wc.turn}}",message:"{{ui.wc.message}}",job:"{{ui.wc.job}}",delegate:"{{ui.wc.delegate}}",fork:"{{ui.wc.fork}}",orchestrate:"{{ui.wc.plan}}","ext-job":"{{ui.wc.extension}}",approval:"{{ui.wc.approval}}",pause:"{{ui.wc.approval}}",question:"{{ui.wc.question}}",secret:"{{ui.wc.secret}}",desktop:"{{ui.wc.desktop}}",task:"{{ui.wc.task}}",route:"{{ui.wc.toolRoute}}",reminder:"{{ui.wc.reminder}}"};
    var list=el("ul");Object.keys(counts).forEach(function(k){list.appendChild(el("li",(labels[k]||"{{ui.wc.other}}")+" · "+counts[k]));});body.appendChild(list);body.appendChild(el("p","{{ui.wc.effectsWarning}}"));
    confirm.disabled=false;confirm.textContent=d.cancelled?"{{ui.wc.checkAgain}}":"{{ui.wc.confirm}}";
  }
  function submit(){
    var ticket=generation;
    confirm.disabled=true;note.textContent="{{ui.wc.stopping}}";
    var data=preview.legacy?{agents:selected}:Object.assign({},target,{token:preview.token,reason:"{{ui.wc.reason}}"});
    request(preview.legacy?"/api/work-control/pause-members":"/api/work-control/cancel","POST",data).then(function(d){
      if(ticket!==generation)return;
      if(d.cancelled){render(Object.assign({},preview,{cancelled:d.cancelled,resources:d.cancelled.resources}));var pending=d.cancelled.resources.filter(function(r){return r.state!=="confirmed";});confirm.disabled=!pending.length;note.textContent=pending.length?"{{ui.wc.cancelledPending}} "+pending.length:"{{ui.wc.cancelled}}";
        {var list=el("ul");d.cancelled.resources.forEach(function(r){var member=preview.participants.find(function(a){return a.id===r.agentId;});var item=el("li",(labels[r.kind]||"{{ui.wc.other}}")+" · "+(member?member.name+" · ":"")+(r.state==="confirmed"?"{{ui.wc.confirmed}}":r.state==="requested"?"{{ui.wc.requested}}":"{{ui.wc.unconfirmed}}"));var details=el("details"),summary=el("summary","{{ui.wc.diagnostics}}");details.appendChild(summary);details.appendChild(el("p",r.id+" · "+(r.detail||"")));item.appendChild(details);list.appendChild(item);});body.appendChild(list);}
      }else{var errors=d.failures.length+(d.nativeStops||[]).filter(function(r){return r.state!=="confirmed";}).length+d.results.reduce(function(n,r){return n+(r.result.errors||[]).length;},0);note.textContent="{{ui.wc.paused}} "+d.paused.length+(errors?" · {{ui.wc.unconfirmed}} "+errors:"")+" {{ui.wc.queueWarning}}";}
      if(typeof refreshProgress==="function")refreshProgress();
    }).catch(function(e){if(ticket!==generation)return;note.textContent=e.message+" {{ui.wc.refresh}}";confirm.disabled=false;});
  }
  window.openWorkCancellation=function(input){mount();var ticket=++generation;target=input;note.textContent="{{ui.wc.loading}}";confirm.disabled=true;body.replaceChildren();if(!dialog.open)dialog.showModal();
    request("/api/work-control/preview?"+new URLSearchParams(input)).then(function(d){if(ticket!==generation||!dialog.open)return;render(d);note.textContent="";}).catch(function(e){if(ticket!==generation)return;note.textContent=e.message;});
  };
  document.addEventListener("click",function(e){var b=e.target.closest("[data-work-cancel]");if(!b)return;var taskId=b.getAttribute("data-work-cancel");window.openWorkCancellation(taskId?{taskId:taskId}:{agentId:current,conversation:currentConversation});});
  var timer=setInterval(function(){var bar=document.getElementById("currentwork");if(!bar)return;
    if(!document.getElementById("work-cancel-action")){var button=el("button","{{ui.wc.open}}");button.id="work-cancel-action";button.className="btn sm ghost";button.setAttribute("data-work-cancel","");bar.after(button);}
    document.getElementById("work-cancel-action").hidden=bar.hidden;
  },500);
})();`;
