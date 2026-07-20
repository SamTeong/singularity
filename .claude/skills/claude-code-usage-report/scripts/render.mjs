// HTML report renderer for claude-code-usage-report: render(c) -> full self-contained document,
// in the "paper-and-clay" design language.
// The page layout lives in sources/base.html ({{PLACEHOLDER}} slots) and the larger
// hero/header block in sources/hero.html; short section markup is inlined as
// constants below, each returned by its render_<section>() function. Client-side
// chart code is sources/app.js, page CSS is sources/style.css + sources/fonts.css
// (base64-inlined woff2 from fetch-fonts.mjs), including the secnav/topbar
// chrome, and the reveal + ambient-glow scripts are sources/motion.html. The
// whole document is fully self-contained — zero external requests at view time.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOME = os.homedir();
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.dirname(SCRIPT_DIR);
const SOURCES_DIR = path.join(SCRIPT_DIR, "sources");
// State root must match stats.mjs / statusline.mjs (USAGE_REPORT_STATE overrides).
const STATE_ROOT = process.env.USAGE_REPORT_STATE || path.join(HOME, ".agents", ".claude-code-usage-report", "state");
const FORECAST_JSON = path.join(STATE_ROOT, "forecast.json");

function _source(name) {
  return fs.readFileSync(path.join(SOURCES_DIR, name), "utf-8");
}

// Replace {{KEY}} slots with literal values (callback form so '$' sequences in
// the replacement — common in the embedded JS/CSS — are never treated as
// String.replace special patterns).
function _fill(tpl, slots) {
  return tpl.replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => (key in slots ? slots[key] : m));
}

// ---- helpers ----

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// html.escape(quote=True) equivalent: & < > " '
function esc(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function fmtLocal(d) {
  return (
    d.getFullYear() +
    "-" +
    pad2(d.getMonth() + 1) +
    "-" +
    pad2(d.getDate()) +
    " " +
    pad2(d.getHours()) +
    ":" +
    pad2(d.getMinutes()) +
    ":" +
    pad2(d.getSeconds())
  );
}

function _inum(v) {
  if (v === null || v === undefined || v === "") return 0;
  const f = parseFloat(v);
  return Number.isNaN(f) ? 0 : Math.trunc(f);
}

// ---- roadmap (claude-code-usage-report-suggestions integration) ----

function _sibling_skill(name, file) {
  // Resolve a sibling skill's script path without hardcoding the install root.
  const anchor = path.join(path.dirname(SKILL_DIR), name, "scripts", file);
  const cands = [
    anchor,
    path.join(HOME, ".agents", "skills", name, "scripts", file),
    path.join(HOME, ".claude", "skills", name, "scripts", file),
  ];
  for (const cand of cands) {
    if (isFile(cand)) return cand;
  }
  return anchor;
}

const IMPROVE_MJS = _sibling_skill("claude-code-usage-report-suggestions", "improve.mjs");

function _fetch_roadmap() {
  if (!isFile(IMPROVE_MJS)) return null;
  try {
    const out = execFileSync(process.execPath, [IMPROVE_MJS, "roadmap", "--json"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 60000,
      encoding: "utf-8",
    });
    const data = JSON.parse(out);
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function _render_suggestions(sg) {
  if (!sg) {
    return (
      "<p class='muted'>Run <code>/claude-code-usage-report-suggestions</code> for the pipeline " +
      "improvement roadmap (capture → schema → aggregation → visualization).</p>"
    );
  }
  const badge = { available: "st-ok", partial: "st-part", idea: "st-idea" };
  const rows = sg
    .map(
      (s) =>
        `<div class='sg rv' data-st='${esc(s.status)}'><span class='sg-b ${badge[s.status] || "st-idea"}'>` +
        `${esc(s.status)}</span><span class='sg-a'>${esc(s.area)}</span>` +
        `<span class='sg-t'>${esc(s.text)}</span></div>`
    )
    .join("");
  const hasAvail = sg.some((s) => s.status === "available");
  const filter = hasAvail
    ? "<div class='filter-bar'><span class='filter-lbl'>Roadmap</span>" +
      "<button id='road-filter' class='lg-all' type='button' aria-pressed='true'>Show available</button></div>"
    : "";
  const gridCls = hasAvail ? "sgs hide-avail" : "sgs";
  return `${filter}<div class='${gridCls}' id='road-sgs'>${rows}</div>`;
}

// ---- embedded SESSIONS payload ----

function _build_sessions_json(sessions) {
  const out = [];
  for (const s of sessions) {
    const d = {
      ts: s.ts, sid: s.sid, cost: s.cost, model: s.model, disp: s.disp,
      in: s.in, out: s.out, cr: s.cr, cc: s.cc, tok: s.tok,
      dur: s.dur, api: s.api, la: s.la, lr: s.lr,
      r5: s.rl5, r7: s.rl7,
      turns: s.turns, tools: s.tools, hour: s.hour, dow: s.dow,
    };
    const fc = s.facets;
    if (fc) {
      const f = {};
      if (fc.tools && Object.keys(fc.tools).length) f.t = fc.tools;
      if (fc.agents && Object.keys(fc.agents).length) f.a = fc.agents;
      if (fc.skills && Object.keys(fc.skills).length) f.s = fc.skills;
      const ce = _inum(fc.compactions);
      const te = _inum(fc.tool_errors);
      if (ce) f.ce = ce;
      if (te) f.te = te;
      const cwd = (fc.cwd || "").trim();
      if (cwd) f.cwd = cwd;
      if (Object.keys(f).length) d.facets = f;
    }
    out.push(d);
  }
  return out;
}

// ---- sections ----

function render_style() {
  // fonts.css carries the base64-inlined woff2 faces (self-hosted, generated by
  // fetch-fonts.mjs) so the report loads zero external resources.
  return _source("fonts.css") + "\n" + _source("style.css");
}

// hero.html carries the page <header>, opens the main .wrap container (closed
// by base.html after the last section), and includes the spend-over-time cards.
function render_hero() {
  return _fill(_source("hero.html"), { GENERATED: esc(fmtLocal(new Date())) });
}

const BREAKDOWN_HTML = `<header class='shead' id='sec-breakdown'><div class='shead-title'><h2>Breakdown</h2><span class='sub'>cost by day or month, filterable by model</span></div></header>
<div class='ctl-row'><div id='model-filter' class='legend'></div><div class='toggle'><button id='btn-day' class='active' onclick="show('day')">by day</button><button id='btn-month' onclick="show('month')">by month</button></div></div>
<section id='day-view'><div class='card rv'><h3>Cost by day</h3><div id='day-chart'></div></div><div class='scroll' id='day-table'></div></section>
<section id='month-view' style='display:none'><div class='card rv'><h3>Cost by month</h3><div id='month-chart'></div></div><div class='scroll' id='month-table'></div></section>`;

const TOKEN_ECONOMICS_HTML = `<header class='shead' id='sec-token-economics'><div class='shead-title'><h2>Token economics</h2><span class='sub'>where the tokens go and what the cache saves</span></div></header>
<div class='ctl-row'><div id='tok-legend' class='legend'></div><div class='toggle'><button id='tbtn-day' class='active' onclick="showTok('day')">by day</button><button id='tbtn-month' onclick="showTok('month')">by month</button></div></div>
<div id='tok-day'><div class='card rv'><h3>Token composition by day</h3><div id='tok-day-bars'></div></div></div>
<div id='tok-month' style='display:none'><div class='card rv'><h3>Token composition by month</h3><div id='tok-month-bars'></div></div></div>
<div class='grid12'><div class='card rv'><h3>Token mix</h3><div id='tok-mix'></div></div>
<div class='card rv'><h3>Cache-creation / cache-read ratio by day</h3><div id='cc-ratio'></div></div></div>`;

const EFFICIENCY_HTML = `<header class='shead' id='sec-efficiency'><div class='shead-title'><h2>Efficiency</h2><span class='sub'>what a session costs in tokens, time, and lines</span></div></header>
<h3 class='subhead'>Per-model efficiency</h3>
<div id='sec-eff-models' class='rv'></div>
<div class='card rv'><div id='sec-cadence'></div></div>`;

const RATE_LIMITS_HTML = `<header class='shead' id='sec-rate-limit-utilization-5h-7d'><div class='shead-title'><h2>Rate-limit utilization · 5h &amp; 7d</h2><span class='sub'>how close you run to the usage caps</span></div></header>
<div class='card rv'><h3>5h / 7d utilization (Claude models only)</h3><div id='sec-ratelimits'></div></div>
<div class='card rv'><h3>Token yield per rate-limit %</h3><div class='ctl-row'><div id='ty-legend' class='legend'></div><div class='toggle'><button id='tybtn-7d' class='active' onclick="showTY('7d')">7d</button><button id='tybtn-5h' onclick="showTY('5h')">5h</button></div></div><div id='sec-token-yield'></div><div id='sec-token-yield-summary'></div></div>
<div class='card rv'><h3>Rate-limit forecast at reset</h3><div id='sec-forecast'></div></div>`;

const WHEN_YOU_WORK_HTML = `<header class='shead' id='sec-when-you-work'><div class='shead-title'><h2>When you work</h2><span class='sub'>spend by weekday and hour</span></div></header>
<div class='card flush2 rv'><h3>Spend by day-of-week × hour</h3><div id='sec-dayhour'></div></div>`;

const SESSIONS_HTML = `<header class='shead' id='sec-sessions'><div class='shead-title'><h2>Sessions</h2><span class='sub'>the runs that carry the bill</span></div></header>
<div class='grid2'><div class='card rv'><h3>Cost vs tokens (per session)</h3><div id='sec-scatter'></div></div>
<div class='card rv'><h3 id='sec-pareto-title'></h3><div id='sec-pareto'></div></div></div>
<div class='scroll' id='sec-toptable'></div>`;

const USAGE_PATTERNS_HTML = `<header class='shead' id='sec-usage-patterns'><div class='shead-title'><h2>Usage patterns</h2><span class='sub'>tools, subagents, and skills in play</span></div></header>
<div class='card rv'><div id='sec-usage-stats'></div></div>
<div class='grid2'><div class='card rv'><h3>Tool mix (top 12)</h3><div id='sec-tools'></div></div>
<div class='card rv'><h3>Subagent types</h3><div id='sec-agents'></div></div></div>
<div class='card rv'><h3>Skills invoked</h3><div id='sec-skills'></div></div>`;

const PROJECTS_HTML = `<header class='shead' id='sec-by-project'><div class='shead-title'><h2>By project</h2><span class='sub'>which repos spend the budget</span></div></header>
<div class='grid2'><div class='card rv'><h3>Cost by project</h3><div id='sec-proj-cost'></div></div>
<div class='card rv'><h3>Sessions by project</h3><div id='sec-proj-sess'></div></div></div>`;

const MODELS_HTML = `<header class='shead' id='sec-models'><div class='shead-title'><h2>Models</h2><span class='sub'>cost share and adoption over time</span></div></header>
<div class='card rv'><h3>Cost share by model (area ∝ cost)</h3><div id='sec-treemap'></div></div>
<div class='grid2'><div class='card rv'><h3>Sessions by model</h3><div id='sec-model-sessions'></div></div>
<div class='card rv'><h3>Cost by model</h3><div id='sec-model-cost'></div></div></div>
<div class='card rv'><h3>Model adoption — cost share by month</h3><div id='sec-share'></div></div>`;

const ROADMAP_HTML = `<header class='shead' id='sec-insights-roadmap-what-could-come-next'><div class='shead-title'><h2>Usage roadmap</h2><span class='sub'>what could come next</span></div></header>
{{ROADMAP_BODY}}`;

function render_roadmap() {
  return _fill(ROADMAP_HTML, { ROADMAP_BODY: _render_suggestions(_fetch_roadmap()) });
}

const FOOTER_HTML = `<footer>Generated locally from ~/.agents/.claude-code-usage-report/state/stats.csv. All session data stays on this machine. Line counts, API time and rate-limit data are captured from the statusline going forward; older sessions show them as 0/—. Tool usage, projects, subagents, skills and compactions are derived from transcripts (retroactive). Run <code>/claude-code-usage-report-suggestions</code> for the roadmap as text.</footer>`;

// Floating section sidebar (replaces the old "Go to section" fan-out). The shell
// is static; the menu items, ticks, order and hidden-state are all derived at
// runtime from the .rsec wrappers by SIDEBAR_JS (see below), which also persists
// order + visibility to localStorage. Standardized on the design-system
// "Section floating sidebar".
const SIDEBAR_HTML = `<nav class='secnav' id='secnav' aria-label='Sections'>
<div class='secnav-rail' role='button' tabindex='0' aria-label='Open section menu' title='Sections'><div class='secnav-ticks'></div></div>
<div class='secnav-panel' role='menu' aria-label='Sections'>
<a class='secnav-top' href='#top' role='menuitem'><svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8'><path d='M12 19V5M6 11l6-6 6 6'/></svg>Top</a>
<div class='secnav-items'></div>
</div></nav>`;

// Runtime for the floating sidebar. Reads persisted order/visibility, applies it
// to the .rsec sections, builds the draggable + hideable menu, and keeps the rail
// ticks + localStorage in sync on every reorder / hide / scroll.
const SIDEBAR_JS = `
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
`;


function _load_forecast() {
  // Empirical-Bayes rate-limit forecast (Phase D). Built lazily by stats.mjs
  // _load_forecast before render; null when no rl data at all.
  if (!isFile(FORECAST_JSON)) return null;
  try {
    return JSON.parse(fs.readFileSync(FORECAST_JSON, "utf-8"));
  } catch {
    return null;
  }
}

// ---- burn highlights section (client-side; app.js fills #burn-cards) ----

const BURN_HTML = `<header class='shead' id='sec-burn-highlights'><div class='shead-title'><h2>Burn highlights</h2><span class='sub'>top reasons your tokens burned</span></div></header>
<div id='burn-cards'></div>`;

function render_scripts(sessions) {
  const secs = _build_sessions_json(sessions);
  // Escape < so a crafted field (cwd, tool/skill name from a transcript) can't
  // break out of the <script> context. JSON allows \u escapes inside strings.
  const sessions_json = JSON.stringify(secs).replace(/</g, "\\u003c");
  // FORECAST: empirical-Bayes rate-limit forecast (Phase D). Empty object when
  // absent so app.js can always deref .gauges and render the empty-state.
  const forecast = _load_forecast() || {};
  const forecast_json = JSON.stringify(forecast).replace(/</g, "\\u003c");
  return (
    "<script>\nvar SESSIONS=" + sessions_json + ";\n" +
    "var FORECAST=" + forecast_json + ";\n" + _source("app.js") +
    "\n" + SIDEBAR_JS + "</script>"
  );
}

// IntersectionObserver reveal-on-scroll + 2D-canvas ambient glow + flagcard
// updater — no external libs; every effect no-ops under prefers-reduced-motion.
function render_motion() {
  return _source("motion.html");
}

// ---- render ----

export function render(c) {
  return _fill(_source("base.html"), {
    STYLE: render_style(),
    HERO: render_hero(),
    BURN: BURN_HTML,
    BREAKDOWN: BREAKDOWN_HTML,
    TOKEN_ECONOMICS: TOKEN_ECONOMICS_HTML,
    EFFICIENCY: EFFICIENCY_HTML,
    RATE_LIMITS: RATE_LIMITS_HTML,
    WHEN_YOU_WORK: WHEN_YOU_WORK_HTML,
    SESSIONS: SESSIONS_HTML,
    USAGE_PATTERNS: USAGE_PATTERNS_HTML,
    PROJECTS: PROJECTS_HTML,
    MODELS: MODELS_HTML,
    ROADMAP: render_roadmap(),
    FOOTER: FOOTER_HTML,
    SCRIPTS: render_scripts(c.sessions),
    MOTION: render_motion(),
    SIDEBAR: SIDEBAR_HTML,
  });
}
