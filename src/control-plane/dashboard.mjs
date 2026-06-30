// Single-page operating surface. One ask bar, see anything, control what you're authorized to.
// Dependency-free: fetch for state, EventSource for the live feed. Altitude via a drill-down
// inspector: click a task/project to zoom in; approvals show what/why/blast-radius.
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>omni — operating surface</title>
<style>
  :root{--bg:#0b0e14;--panel:#141923;--ink:#e6edf3;--dim:#8b98a9;--ln:#222b3a;
    --ok:#3fb950;--warn:#d29922;--err:#f85149;--accent:#58a6ff}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
  header{padding:12px 18px;border-bottom:1px solid var(--ln);display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  header b{font-size:16px;letter-spacing:.5px}.tag{color:var(--dim);font-size:12px}
  .ask{flex:1;display:flex;gap:8px;min-width:320px}
  .ask input{flex:1;background:var(--panel);border:1px solid var(--ln);color:var(--ink);padding:8px 10px;border-radius:6px}
  button{background:var(--panel);border:1px solid var(--ln);color:var(--ink);padding:7px 11px;border-radius:6px;cursor:pointer;font:inherit}
  button:hover{border-color:var(--accent)}
  .grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;padding:12px}
  .panel{background:var(--panel);border:1px solid var(--ln);border-radius:8px;padding:11px;margin-bottom:12px}
  .panel h3{margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:var(--dim)}
  .metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:7px}
  .metric{background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:7px}
  .metric .v{font-size:18px}.metric .k{color:var(--dim);font-size:10px}
  .row{display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px dashed var(--ln);cursor:default}
  .row:last-child{border:0}.click{cursor:pointer}.click:hover{color:var(--accent)}
  .pill{font-size:10px;padding:1px 7px;border-radius:10px;border:1px solid var(--ln)}
  .s-done{color:var(--ok)}.s-failed,.s-needs_approval{color:var(--err)}.s-running,.s-verifying,.s-claimed{color:var(--accent)}
  .q{margin-bottom:6px}.q b{color:var(--accent)}
  #feed{height:200px;overflow:auto;font-size:11px}#feed div{padding:1px 0}
  .lvl-error{color:var(--err)}.lvl-warn{color:var(--warn)}.lvl-success{color:var(--ok)}
  pre{white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:8px;max-height:260px;overflow:auto;font-size:11px;margin:6px 0}
  .appr{background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:8px;margin-bottom:8px}
  .appr .w{color:var(--warn)}.muted{color:var(--dim)}
  .se{color:var(--dim);font-size:11px}
</style></head>
<body>
<header>
  <b>omni</b><span class="tag">operating surface</span>
  <div class="ask"><input id="ask" placeholder="Ask / goal... ('--playbook hello-utility' or free text)" />
  <button onclick="ask()">Submit</button></div>
  <button onclick="run()">▶ Run</button>
  <button onclick="scan()">⟳ Scan</button>
  <button onclick="cron()">⏱ Cron-tick</button>
</header>
<div class="grid">
  <div>
    <div class="panel"><h3>Metrics</h3><div id="metrics" class="metrics"></div></div>
    <div class="panel"><h3>Tasks (click to inspect)</h3><div id="tasks"></div></div>
    <div class="panel"><h3>Portfolio (click a project)</h3><div id="portfolio"></div></div>
  </div>
  <div>
    <div class="panel"><h3>Talk to <span id="entname">Omni</span> <span class="muted" id="brain"></span></h3>
      <div id="chatlog" style="height:150px;overflow:auto;font-size:12px;background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:8px"></div>
      <div style="display:flex;gap:6px;margin-top:6px"><input id="chatin" placeholder="say something to the entity..." style="flex:1;background:var(--bg);border:1px solid var(--ln);color:var(--ink);padding:7px;border-radius:6px" onkeydown="if(event.key==='Enter')say()"/><button onclick="say()">Send</button></div>
    </div>
    <div class="panel"><h3>Inspector <span class="muted" id="insp-scope"></span></h3><div id="inspector"><span class="muted">Click a task or project to drill in.</span></div></div>
    <div class="panel"><h3>Approvals inbox</h3><div id="approvals"></div></div>
  </div>
  <div>
    <div class="panel"><h3>Live feed</h3><div id="feed"></div></div>
    <div class="panel"><h3>Momentum queues</h3><div id="queues"></div></div>
    <div class="panel"><h3>Recurring ops</h3><div id="recurring"></div></div>
  </div>
</div>
<script>
const $=id=>document.getElementById(id), esc=s=>String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
async function jget(u){return (await fetch(u)).json()}
async function jpost(u,b){return (await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})})).json()}

async function refresh(){
  const s=await jget('/api/status'), m=s.metrics;
  $('metrics').innerHTML=[['done',m.tasks_completed+'/'+m.tasks_total],['verified',m.tasks_verified],['failed',m.tasks_failed],
    ['median ms',m.median_time_to_completion_ms],['cost $',m.cost_total_usd],['eval %',m.eval_pass_rate==null?'—':Math.round(m.eval_pass_rate*100)],
    ['intervene',m.intervention_rate],['retry',m.retry_rate],['budget',m.daily_budget.spent+'/'+m.daily_budget.limit]]
    .map(([k,v])=>'<div class=metric><div class=v>'+v+'</div><div class=k>'+k+'</div></div>').join('');

  const tasks=await jget('/api/tasks');
  $('tasks').innerHTML=tasks.slice(0,14).map(t=>
    '<div class="row click" onclick="inspectTask(\\''+t.id+'\\')"><span>'+esc(t.title).slice(0,40)+'</span><span class="pill s-'+t.status+'">'+t.status+'</span></div>').join('')||'<div class=row>no tasks</div>';

  const port=await jget('/api/portfolio');
  $('portfolio').innerHTML=port.projects.map(p=>
    '<div class="row click" onclick="inspectProject(\\''+p.project_id+'\\')"><span>'+esc(p.project_id).slice(0,26)+'</span><span class="pill">'+p.done+'/'+p.tasks+' done · '+p.blocked+' blkd · $'+p.cost+'</span></div>').join('')||'<div class=row>no projects</div>'
    +'<div class="se" style="margin-top:6px">totals: '+port.totals.projects+' projects · '+port.totals.open_approvals+' approvals · $'+port.totals.total_cost+'</div>';

  $('queues').innerHTML=['now','next','blocked','improve','recurring'].map(q=>
    '<div class=q><b>'+q+'</b> '+(esc((s.queues[q]||[]).slice(0,3).map(i=>i.title).join(' · '))||'—')+'</div>').join('');

  $('approvals').innerHTML=s.approvals.map(a=>{
    const d=a.detail||{};
    return '<div class=appr><div><b>'+esc(a.action).slice(0,46)+'</b> <span class="pill s-needs_approval">'+a.risk+'</span></div>'+
      '<div class=se>why: '+esc(d.why||a.reason)+'</div>'+
      '<div class=se>engine: '+esc(d.engine||'?')+' · reversible: '+(d.reversible?'yes':'<span class=w>NO</span>')+'</div>'+
      (d.side_effects&&d.side_effects.length?'<div class=se>effects: '+esc(d.side_effects.join('; ')).slice(0,120)+'</div>':'')+
      '<div style="margin-top:6px"><button onclick="decide(\\''+a.id+'\\',\\'approve\\')">✓ Approve</button> '+
      '<button onclick="decide(\\''+a.id+'\\',\\'deny\\')">✗ Deny</button></div></div>';}).join('')||'<span class=muted>inbox clear</span>';

  const rec=await jget('/api/recurring');
  $('recurring').innerHTML=rec.map(r=>'<div class=row><span>'+esc(r.name)+' <span class=muted>('+r.action+')</span></span><span class=se>every '+r.interval_sec+'s · '+r.runs+' runs</span></div>').join('')||'<span class=muted>none — click Cron-tick to seed</span>';
}
async function inspectTask(id){
  const v=await jget('/api/task/'+id); if(v.error)return;
  $('insp-scope').textContent='· task';
  const t=v.task, ev=(t.evidence||[]).map(e=>esc(JSON.stringify(e))).join('\\n');
  $('inspector').innerHTML='<div><b>'+esc(t.title)+'</b> <span class="pill s-'+t.status+'">'+t.status+'</span></div>'+
    '<div class=se>'+t.kind+' · risk '+t.risk_level+' · engine '+esc(t.executor||'?')+' · attempts '+t.attempts+'</div>'+
    (t.goal_id?'<div class=se>goal: <span class="click" onclick="inspectGoal(\\''+t.goal_id+'\\')">'+t.goal_id+'</span></div>':'')+
    '<div class=se>verify: '+esc(JSON.stringify(t.verification_plan))+'</div>'+
    '<h3 style="margin-top:8px">Evidence</h3><pre>'+(ev||'(none)')+'</pre>'+
    (v.sessions&&v.sessions.length?'<div class=se>sessions: '+v.sessions.map(s=>s.executor+'/'+s.status+' $'+(s.cost||0)).join(', ')+'</div>':'')+
    (v.sessions&&v.sessions[0]?'<button onclick="inspectSession(\\''+v.sessions[v.sessions.length-1].id+'\\')">view diff/trace</button>':'');
}
async function inspectSession(id){
  const v=await jget('/api/session/'+id); if(!v||v.error)return;
  $('insp-scope').textContent='· session';
  $('inspector').innerHTML='<div><b>session '+esc(id)+'</b> '+esc(v.session.executor)+'/'+esc(v.session.status)+'</div>'+
    '<h3 style="margin-top:8px">Trace</h3><pre>'+v.events.map(e=>esc(e.ts.slice(11,19)+' '+e.type+' '+(e.message||''))).join('\\n')+'</pre>'+
    (v.diff?'<h3>Diff</h3><pre>'+esc(v.diff)+'</pre>':'');
}
async function inspectGoal(id){
  const v=await jget('/api/goal/'+id); if(!v||v.error)return;
  $('insp-scope').textContent='· goal';
  $('inspector').innerHTML='<div><b>'+esc(v.goal.description).slice(0,80)+'</b></div>'+
    '<div class=se>progress '+v.progress.done+'/'+v.progress.total+' ('+v.progress.pct+'%) · cost $'+v.cost+' · '+esc(v.goal.status)+'</div>'+
    v.tasks.map(t=>'<div class="row click" onclick="inspectTask(\\''+t.id+'\\')"><span>'+esc(t.title).slice(0,38)+'</span><span class="pill s-'+t.status+'">'+t.status+'</span></div>').join('');
}
async function inspectProject(id){
  const v=await jget('/api/project/'+id); if(!v||v.error)return;
  $('insp-scope').textContent='· project';
  $('inspector').innerHTML='<div><b>'+esc(id)+'</b></div>'+
    '<div class=se>tasks: '+esc(JSON.stringify(v.tasksByStatus))+' · cost $'+v.cost+' · knowledge '+v.knowledgeCount+'</div>'+
    '<h3 style="margin-top:8px">status.md</h3><pre>'+esc(v.files.status||'(none)')+'</pre>'+
    '<h3>handoff.md</h3><pre>'+esc(v.files.handoff||'(none)')+'</pre>';
}
function line(ev){const d=document.createElement('div');d.className='lvl-'+(ev.level||'info');
  d.textContent=(ev.ts||'').slice(11,19)+'  '+ev.type+'  '+(ev.message||'');$('feed').prepend(d);
  while($('feed').childNodes.length>120)$('feed').lastChild.remove();}
async function ask(){const v=$('ask').value.trim();if(!v)return;const mp=v.match(/--playbook\\s+(\\S+)/);
  await jpost('/api/goal', mp?{playbook:mp[1]}:{description:v});$('ask').value='';refresh();}
async function run(){await jpost('/api/run');refresh();}
async function scan(){await jpost('/api/scan');refresh();}
async function cron(){await jpost('/api/cron-tick');refresh();}
async function decide(id,d){await jpost('/api/approvals/'+id+'/'+d);refresh();}
async function say(){const v=$('chatin').value.trim();if(!v)return;addchat('you',v);$('chatin').value='';
  try{const r=await jpost('/api/say',{message:v});addchat($('entname').textContent,r.reply);refresh();}catch(e){addchat('!','error');}}
function addchat(who,txt){const d=document.createElement('div');d.style.margin='4px 0';
  d.innerHTML='<b style="color:var(--accent)">'+esc(who)+'</b> '+esc(txt).replace(/\\n/g,'<br>');
  $('chatlog').appendChild(d);$('chatlog').scrollTop=9e9;}
async function brain(){try{const m=await jget('/api/model');$('brain').textContent=m.connected?'· model: '+m.provider:'· no model connected yet';}catch{}}
brain();
const es=new EventSource('/events');
es.onmessage=e=>{try{const ev=JSON.parse(e.data);line(ev);if(/task\\.|goal\\.|approval|eval|recurring/.test(ev.type))refresh();}catch{}};
refresh();setInterval(refresh,5000);
</script>
</body></html>`;
