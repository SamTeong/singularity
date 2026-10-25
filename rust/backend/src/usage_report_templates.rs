// Extracted verbatim from bundled render.mjs template literals.
pub const BREAKDOWN_HTML: &str = r#"<header class='shead' id='sec-breakdown'><div class='shead-title'><h2>Breakdown</h2><span class='sub'>cost by day or month, filterable by model</span></div></header>
<div class='ctl-row'><div id='model-filter' class='legend'></div><div class='toggle'><button id='btn-day' class='active' onclick="show('day')">by day</button><button id='btn-month' onclick="show('month')">by month</button></div></div>
<section id='day-view'><div class='card rv'><h3>Cost by day</h3><div id='day-chart'></div></div><div class='scroll' id='day-table'></div></section>
<section id='month-view' style='display:none'><div class='card rv'><h3>Cost by month</h3><div id='month-chart'></div></div><div class='scroll' id='month-table'></div></section>"#;
pub const TOKEN_ECONOMICS_HTML: &str = r#"<header class='shead' id='sec-token-economics'><div class='shead-title'><h2>Token economics</h2><span class='sub'>where the tokens go and what the cache saves</span></div></header>
<div class='ctl-row'><div id='tok-legend' class='legend'></div><div class='toggle'><button id='tbtn-day' class='active' onclick="showTok('day')">by day</button><button id='tbtn-month' onclick="showTok('month')">by month</button></div></div>
<div id='tok-day'><div class='card rv'><h3>Token composition by day</h3><div id='tok-day-bars'></div></div></div>
<div id='tok-month' style='display:none'><div class='card rv'><h3>Token composition by month</h3><div id='tok-month-bars'></div></div></div>
<div class='grid12'><div class='card rv'><h3>Token mix</h3><div id='tok-mix'></div></div>
<div class='card rv'><h3>Cache-creation / cache-read ratio by day</h3><div id='cc-ratio'></div></div></div>"#;
pub const EFFICIENCY_HTML: &str = r#"<header class='shead' id='sec-efficiency'><div class='shead-title'><h2>Efficiency</h2><span class='sub'>what a session costs in tokens, time, and lines</span></div></header>
<h3 class='subhead'>Per-model efficiency</h3>
<div id='sec-eff-models' class='rv'></div>
<div class='card rv'><div id='sec-cadence'></div></div>"#;
pub const RATE_LIMITS_HTML: &str = r#"<header class='shead' id='sec-rate-limit-utilization-5h-7d'><div class='shead-title'><h2>Rate-limit utilization · 5h &amp; 7d</h2><span class='sub'>how close you run to the usage caps</span></div></header>
<div class='card rv' data-harness='claude'><h3>5h / 7d utilization (Claude models only)</h3><div id='sec-ratelimits'></div></div>
<div class='card rv' data-harness='ollama'><h3>5h / 7d utilization (Ollama cloud models only)</h3><div id='sec-ollama-util'></div></div>
<div class='card rv' data-harness='codex'><h3>5h / 7d utilization (Codex models only)</h3><div id='sec-codex-util'></div></div>
<div class='card rv'><h3>Token yield per rate-limit %</h3><div class='ctl-row'><div id='ty-legend' class='legend'></div><div class='toggle'><button id='tybtn-7d' class='active' data-harness='claude' onclick="showTY('7d')">7d</button><button id='tybtn-5h' data-harness='claude' onclick="showTY('5h')">5h</button><button id='tybtn-ollama-wk' data-harness='ollama' onclick="showTY('ollama-wk')">7d (ollama)</button><button id='tybtn-codex-wk' data-harness='codex' onclick="showTY('codex-wk')">7d (codex)</button></div></div><div id='sec-token-yield'></div><div id='sec-token-yield-summary'></div></div>
<div class='card rv' data-harness='claude'><h3>Rate-limit forecast at reset (Claude models only)</h3><div id='sec-forecast'></div></div>
<div class='card rv' data-harness='ollama'><h3>Rate-limit forecast at reset (Ollama cloud models only)</h3><div id='sec-ollama-forecast'></div></div>
<div class='card rv' data-harness='codex'><h3>Rate-limit forecast at reset (Codex models only)</h3><div id='sec-codex-forecast'></div></div>
<div class='card rv' data-harness='claude'><h3>5h-window to 7d-window rate (Claude models only)</h3><div id='sec-window-balance'></div></div>
<div class='card rv' data-harness='ollama'><h3>5h-window to 7d-window (Ollama cloud models only)</h3><div id='sec-ollama-window-balance'></div></div>
<div class='card rv' data-harness='codex'><h3>5h-window to 7d-window (Codex models only)</h3><div id='sec-codex-window-balance'></div></div>"#;
pub const WHEN_YOU_WORK_HTML: &str = r#"<header class='shead' id='sec-when-you-work'><div class='shead-title'><h2>When you work</h2><span class='sub'>spend by weekday and hour</span></div></header>
<div class='card flush2 rv'><h3>Spend by day-of-week × hour</h3><div id='sec-dayhour'></div></div>"#;
pub const SESSIONS_HTML: &str = r#"<header class='shead' id='sec-sessions'><div class='shead-title'><h2>Sessions</h2><span class='sub'>the runs that carry the bill</span></div></header>
<div class='grid2'><div class='card rv'><h3>Cost vs tokens (per session)</h3><div id='sec-scatter'></div></div>
<div class='card rv'><h3 id='sec-pareto-title'></h3><div id='sec-pareto'></div></div></div>
<div class='scroll' id='sec-toptable'></div>"#;
pub const USAGE_PATTERNS_HTML: &str = r#"<header class='shead' id='sec-usage-patterns'><div class='shead-title'><h2>Usage patterns</h2><span class='sub'>tools, subagents, and skills in play</span></div></header>
<div class='card rv'><div id='sec-usage-stats'></div></div>
<div class='grid2'><div class='card rv'><h3>Tool mix (top 12)</h3><div id='sec-tools'></div></div>
<div class='card rv'><h3>Subagent types</h3><div id='sec-agents'></div></div></div>
<div class='card rv'><h3>Skills invoked</h3><div id='sec-skills'></div></div>"#;
pub const PROJECTS_HTML: &str = r#"<header class='shead' id='sec-by-project'><div class='shead-title'><h2>By project</h2><span class='sub'>which repos spend the budget</span></div></header>
<div class='grid2'><div class='card rv'><h3>Cost by project</h3><div id='sec-proj-cost'></div></div>
<div class='card rv'><h3>Sessions by project</h3><div id='sec-proj-sess'></div></div></div>"#;
pub const MODELS_HTML: &str = r#"<header class='shead' id='sec-models'><div class='shead-title'><h2>Models</h2><span class='sub'>cost share and adoption over time</span></div></header>
<div class='card rv'><h3>Cost share by model (area ∝ cost)</h3><div id='sec-treemap'></div></div>
<div class='grid2'><div class='card rv'><h3>Sessions by model</h3><div id='sec-model-sessions'></div></div>
<div class='card rv'><h3>Cost by model</h3><div id='sec-model-cost'></div></div></div>
<div class='card rv'><h3>Model adoption — cost share by month</h3><div id='sec-share'></div></div>
<div class='card rv'><h3>Cost by harness — share by month</h3><div id='sec-harness-share'></div></div>"#;
pub const ROADMAP_HTML: &str = r#"<header class='shead' id='sec-insights-roadmap-what-could-come-next'><div class='shead-title'><h2>Usage roadmap</h2><span class='sub'>what could come next</span></div></header>
{{ROADMAP_BODY}}"#;
pub const FOOTER_HTML: &str = r#"<footer>Generated locally from ~/.agents/.harness-usage-report/state/stats.csv. All session data stays on this machine. Line counts, API time and rate-limit data are captured from the statusline going forward; older sessions show them as 0/—. Tool usage, projects, subagents, skills and compactions are derived from transcripts (retroactive). Run <code>/harness-usage-report-suggestions</code> for the roadmap as text.</footer>"#;
pub const SIDEBAR_HTML: &str = r#"<nav class='secnav' id='secnav' aria-label='Sections'>
<div class='secnav-rail' role='button' tabindex='0' aria-label='Open section menu' title='Sections'><div class='secnav-ticks'></div></div>
<div class='secnav-panel' role='menu' aria-label='Sections'>
<a class='secnav-top' href='#top' role='menuitem'><svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8'><path d='M12 19V5M6 11l6-6 6 6'/></svg>Top</a>
<div class='secnav-items'></div>
</div></nav>"#;
pub const SIDEBAR_JS: &str = r##"
(function(){
 var KEY='insights-secnav-v1';
 var host=document.getElementById('report-sections'),nav=document.getElementById('secnav');
 if(!host||!nav)return;
 var itemsBox=nav.querySelector('.secnav-items'),ticksBox=nav.querySelector('.secnav-ticks'),rail=nav.querySelector('.secnav-rail');
 var GRIP='<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>';
 var EYES='<svg class="eye-on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg><svg class="eye-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3l18 18M10.6 10.7a3 3 0 0 0 4.2 4.2M9.4 5.2A9.6 9.6 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4M6.2 6.2A17 17 0 0 0 2 12s3.5 7 10 7a9.3 9.3 0 0 0 3-.5"/></svg>';
 function secs(){return Array.prototype.slice.call(host.querySelectorAll('.rsec'));}
 function secById(id){var r=null;secs().forEach(function(s){if(s.dataset.sec===id)r=s;});return r;}
 function labelFor(s){var h=s.querySelector('.shead-title h2');return h?h.textContent.trim():(s.dataset.sec||'');}
 function top(s){return s.getBoundingClientRect().top+(window.scrollY||window.pageYOffset);}
 function loadState(){try{return JSON.parse(localStorage.getItem(KEY))||{};}catch(e){return {};}}
 function saveState(){var order=[],hidden=[];secs().forEach(function(s){order.push(s.dataset.sec);if(s.classList.contains('is-hidden'))hidden.push(s.dataset.sec);});try{localStorage.setItem(KEY,JSON.stringify({order:order,hidden:hidden}));}catch(e){}}
 function revealIn(s){s.classList.remove('is-hidden');s.querySelectorAll('.rv').forEach(function(e){e.classList.add('in');e.style.opacity='';e.style.transform='';});}
 // Reordering the DOM can leave scroll-reveal cards stuck at opacity:0, so after a
 // reorder we force every card visible.
 function revealAll(){host.querySelectorAll('.rv').forEach(function(e){e.classList.add('in');e.style.opacity='1';e.style.transform='none';});}
 // apply persisted order + hidden state to the real sections
 var st=loadState();
 if(st.order&&st.order.length)st.order.forEach(function(id){var s=secById(id);if(s)host.appendChild(s);});
 if(st.hidden&&st.hidden.length)st.hidden.forEach(function(id){var s=secById(id);if(s)s.classList.add('is-hidden');});
 function buildTicks(){ticksBox.innerHTML='';itemsBox.querySelectorAll('.secnav-item').forEach(function(it){var t=document.createElement('div');t.className='tick'+(it.classList.contains('hidden')?' off':'');t.dataset.sec=it.dataset.sec;ticksBox.appendChild(t);});highlight();}
 function highlight(){var vis=secs().filter(function(s){return !s.classList.contains('is-hidden');});if(!vis.length){ticksBox.querySelectorAll('.tick').forEach(function(t){t.classList.remove('on');});return;}var y=(window.scrollY||window.pageYOffset)+140,cur=vis[0];vis.forEach(function(s){if(top(s)<=y)cur=s;});var id=cur.dataset.sec;ticksBox.querySelectorAll('.tick').forEach(function(t){t.classList.toggle('on',!t.classList.contains('off')&&t.dataset.sec===id);});}
 function buildItems(){itemsBox.innerHTML='';secs().forEach(function(s){var id=s.dataset.sec,hidden=s.classList.contains('is-hidden');var it=document.createElement('div');it.className='secnav-item'+(hidden?' hidden':'');it.setAttribute('draggable','true');it.dataset.sec=id;it.innerHTML='<span class="secnav-grip" aria-hidden="true">'+GRIP+'</span><a class="secnav-label" href="#'+id+'" draggable="false">'+labelFor(s)+'</a><button class="secnav-eye" type="button" aria-label="Toggle section" aria-pressed="'+(hidden?'true':'false')+'">'+EYES+'</button>';itemsBox.appendChild(it);});buildTicks();}
 var dragEl=null;
 function afterEl(y){var best=null,bestOff=-Infinity;itemsBox.querySelectorAll('.secnav-item:not(.dragging)').forEach(function(c){var b=c.getBoundingClientRect(),off=y-b.top-b.height/2;if(off<0&&off>bestOff){bestOff=off;best=c;}});return best;}
 itemsBox.addEventListener('dragstart',function(e){var it=e.target.closest('.secnav-item');if(!it)return;dragEl=it;e.dataTransfer.effectAllowed='move';requestAnimationFrame(function(){it.classList.add('dragging');});});
 itemsBox.addEventListener('dragover',function(e){e.preventDefault();if(!dragEl)return;var a=afterEl(e.clientY);if(a==null)itemsBox.appendChild(dragEl);else itemsBox.insertBefore(dragEl,a);});
 itemsBox.addEventListener('dragend',function(){if(dragEl){dragEl.classList.remove('dragging');dragEl=null;}itemsBox.querySelectorAll('.secnav-item').forEach(function(it){var s=secById(it.dataset.sec);if(s)host.appendChild(s);});saveState();buildTicks();revealAll();window.scrollTo({top:0,behavior:'smooth'});});
 itemsBox.addEventListener('click',function(e){var eye=e.target.closest('.secnav-eye');if(eye){e.preventDefault();var it=eye.closest('.secnav-item'),s=secById(it.dataset.sec),hid=it.classList.toggle('hidden');if(s){if(hid)s.classList.add('is-hidden');else revealIn(s);}eye.setAttribute('aria-pressed',hid?'true':'false');saveState();buildTicks();return;}if(e.target.closest('.secnav-label'))setOpen(false);});
 function setOpen(o){nav.classList.toggle('open',o);}
 rail.addEventListener('click',function(){setOpen(!nav.classList.contains('open'));});
 rail.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();setOpen(!nav.classList.contains('open'));}});
 nav.querySelector('.secnav-top').addEventListener('click',function(){setOpen(false);});
 document.addEventListener('keydown',function(e){if(e.key==='Escape')setOpen(false);});
 document.addEventListener('click',function(e){if(!nav.contains(e.target))setOpen(false);});
 buildItems();
 window.addEventListener('scroll',highlight,{passive:true});
 window.addEventListener('resize',highlight);
})();
"##;
pub const FILTERRAIL_HTML: &str = r#"<div class='filterrail' id='filterrail'>
<div class='filterrail-hit'></div>
<div class='filterrail-rail' id='filterrail-rail' role='button' tabindex='0' aria-expanded='false' aria-controls='filterrail-panel' aria-label='Filters'>
<span class='fr-badge' id='fr-badge'></span>
<span class='fr-dots' id='fr-dots'></span>
</div>
<div class='filterrail-panel' id='filterrail-panel' role='region' aria-label='Filters'>
<button class='filterrail-pin' id='filterrail-pin' type='button' aria-pressed='false' aria-label='Pin filters open'><svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8'><path d='M12 3v7m-4 0h8l1 4H7l1-4Z'/><path d='M12 14v7'/></svg></button>
<div class='fr-body'>
<div id='rangeBar'></div>
<div id='datePickers'></div>
</div>
</div>
</div>"#;
pub const FILTERRAIL_JS: &str = r#"
(function(){
  var KEY='insights-filterrail-v1';
  var rail=document.getElementById('filterrail');if(!rail)return;
  var trigger=document.getElementById('filterrail-rail'),pin=document.getElementById('filterrail-pin');
  function setOpen(o){rail.classList.toggle('open',o);if(trigger)trigger.setAttribute('aria-expanded',o?'true':'false');}
  function setPinned(p){rail.classList.toggle('pinned',p);if(pin)pin.setAttribute('aria-pressed',p?'true':'false');try{localStorage.setItem(KEY,p?'1':'0');}catch(e){}}
  var pinned=false;try{pinned=localStorage.getItem(KEY)==='1';}catch(e){}
  setPinned(pinned);
  if(trigger){
    trigger.addEventListener('click',function(){setOpen(!rail.classList.contains('open'));});
    trigger.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();setOpen(!rail.classList.contains('open'));}});
  }
  if(pin)pin.addEventListener('click',function(e){e.stopPropagation();setPinned(!rail.classList.contains('pinned'));});
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!rail.classList.contains('pinned'))setOpen(false);});
  document.addEventListener('click',function(e){if(!rail.contains(e.target))setOpen(false);});
})();
"#;
pub const BURN_HTML: &str = r#"<header class='shead' id='sec-burn-highlights'><div class='shead-title'><h2>Burn highlights</h2><span class='sub'>top reasons your tokens burned</span></div></header>
<div id='burn-cards'></div>"#;
