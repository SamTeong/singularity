const CFG = {
  PALETTE: ["var(--ac)", "var(--azure)", "var(--amber)", "var(--sage)", "var(--ink-soft)", "#aa41af", "#3c69c8", "#00a5e6"],
  TOKEN: [{name:"input",key:"in",col:"var(--azure)"},{name:"output",key:"out",col:"var(--ac)"},{name:"cache_read",key:"cr",col:"var(--sage)"},{name:"cache_creation",key:"cc",col:"var(--amber)"}],
  HEAT: ["transparent","color-mix(in srgb,var(--ac) 22%,transparent)","color-mix(in srgb,var(--ac) 45%,transparent)","color-mix(in srgb,var(--ac) 70%,transparent)","var(--ac)"],
  LINE_COV: 0.05,
  PRESETS: [{id:"7d",label:"last 7 days",days:7},{id:"30d",label:"last 30 days",days:30},{id:"all",label:"all time"}]
};
// ---- fmt helpers ----
function esc(s){var d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML;}
function escAttr(s){return esc(s).replace(/'/g,'&#39;').replace(/"/g,'&#34;');}
function fmtMoney(n){return '$'+(n||0).toFixed(2);}
function fmtMoney3(n){return '$'+(n||0).toFixed(3);}
function fmtInt(n){return Math.round(n||0).toLocaleString('en-US');}
function fmtAbbr(n){n=+n||0;var u=[['b',1e9],['m',1e6],['k',1e3]];for(var i=0;i<u.length;i++){if(Math.abs(n)>=u[i][1])return (n/u[i][1]).toFixed(1)+u[i][0];}return (n).toFixed(0);}
function pad2(n){return String(n).padStart(2,'0');}
function el(id){return document.getElementById(id);}
function isDate(s){return typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s);}
function addDays(iso,n){var y=+iso.slice(0,4),m=+iso.slice(5,7),d=+iso.slice(8,10);var dt=new Date(y,m-1,d+n);return dt.getFullYear()+'-'+pad2(dt.getMonth()+1)+'-'+pad2(dt.getDate());}
// ---- StatValue count-up + TrendChip (zapac data-viz grammar) ----
// Animates [data-cu] numeric tiles from 0→final once (CU_FIRST gate), honoring
// prefers-reduced-motion. data-cu-k picks the formatter (int/money/money3/pct/abbr).
var CU_FIRST=true;
var CU_FMT={int:fmtInt,money:fmtMoney,money3:fmtMoney3,pct:function(v){return Math.round(v)+'%';},abbr:fmtAbbr};
function countUpEl(el){
  var to=parseFloat(el.dataset.cu);if(isNaN(to))return;
  var fmt=CU_FMT[el.dataset.cuK||'int']||fmtInt;
  if(!CU_FIRST||(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches)){el.textContent=fmt(to);return;}
  var t0=performance.now(),dur=900;
  function step(){var p=Math.min((performance.now()-t0)/dur,1);el.textContent=fmt(to*(1-Math.pow(1-p,3)));if(p<1)requestAnimationFrame(step);}
  requestAnimationFrame(step);
}
function countUpAll(){document.querySelectorAll('[data-cu]').forEach(countUpEl);CU_FIRST=false;}
function trendChip(dp){
  if(dp==null||isNaN(dp)||!isFinite(dp))return '';
  var dir=dp>0?'up':(dp<0?'down':'flat'),ar=dir==='up'?'▲':dir==='down'?'▼':'▪';
  return "<span class='trend-chip' data-dir='"+dir+"'>"+ar+" "+Math.abs(dp).toFixed(0)+"%</span>";
}

// ---- derived-stats math (client-side, embedded in the report) ----
function percentile(sv,p){if(!sv.length)return 0;var k=(sv.length-1)*p,f=Math.floor(k),c=Math.ceil(k);if(f===c)return +sv[f];return sv[f]*(c-k)+sv[c]*(k-f);}
function costDist(costs){var cs=costs.filter(function(c){return c!=null;}).slice().sort(function(a,b){return a-b;});var n=cs.length;return {mean:n?cs.reduce(function(a,b){return a+b;},0)/n:0,median:percentile(cs,0.5),p90:percentile(cs,0.9),max:n?cs[n-1]:0,n:n};}
function runRate(days){var keys=Object.keys(days).sort();if(!keys.length)return {avg:0,proj30:0,ndays:0};var last=keys.slice(-7);var s=0;last.forEach(function(k){s+=days[k].cost;});var nd=last.length||1;var avg=s/nd;return {avg:avg,proj30:avg*30,ndays:last.length};}
function pareto(costs){var cs=costs.filter(function(c){return c>0;}).sort(function(a,b){return b-a;});var tot=cs.reduce(function(a,b){return a+b;},0)||1;var cum=0,pts=[];cs.forEach(function(c,i){cum+=c;pts.push([i+1,c,cum/tot*100]);});return {top10_pct:cs.length?cs.slice(0,10).reduce(function(a,b){return a+b;},0)/tot*100:0,points:pts,n:cs.length,total:tot};}
function perModelRates(pm){var out={};for(var m in pm){var v=pm[m];var inp=v.in,cr=v.cr,tok=v.tokens,cost=v.cost;out[m]={cache_hit:(cr+inp)?cr/(cr+inp):0,cost_per_mtok:tok?cost/(tok/1e6):0,cost:cost,sessions:v.sessions};}return out;}
function bucketer(vals){var sv=vals.filter(function(v){return v>0;}).sort(function(a,b){return a-b;});if(!sv.length)return function(){return 0;};var q1=percentile(sv,0.25),q2=percentile(sv,0.5),q3=percentile(sv,0.75);return function(c){if(c<=0)return 0;if(c<=q1)return 1;if(c<=q2)return 2;if(c<=q3)return 3;return 4;};}
function spendSeries(days,lastDate){if(!lastDate)return [];var y=+lastDate.slice(0,4),m=+lastDate.slice(5,7),d=+lastDate.slice(8,10);var out=[];for(var i=29;i>=0;i--){var dt=new Date(y,m-1,d-i);var iso=dt.getFullYear()+'-'+pad2(dt.getMonth()+1)+'-'+pad2(dt.getDate());out.push((days[iso]||{}).cost||0);}return out;}
function modelColorMap(models){var cm={},i=0;models.forEach(function(m){if(m==='others')cm[m]='var(--ink-faint)';else{cm[m]=CFG.PALETTE[i%CFG.PALETTE.length];i++;}});return cm;}
function costByModel(bucket){var o={};Object.keys(bucket).forEach(function(k){var m=bucket[k].cost_by_model;var inner={};Object.keys(m).forEach(function(mm){inner[mm]=Math.round(m[mm]*1e6)/1e6;});o[k]=inner;});return o;}
function topn(d,n){n=n||12;var arr=Object.keys(d).map(function(k){return [k,d[k]];}).sort(function(a,b){return b[1]-a[1];}).slice(0,n);var o={};arr.forEach(function(x){o[x[0]]=x[1];});return o;}
function projLabel(p){if(!p||p==='unknown')return 'unknown';var parts=p.replace(/[\\/]+$/,'').split(/[\\/]/).filter(Boolean);return parts.length?parts.slice(-2).join('/'):p;}

// ---- SVG primitives ----
function svgWrap(w,h,inner,cls){return "<svg viewBox='0 0 "+w+" "+h+"' class='"+(cls||'chart')+"' xmlns='http://www.w3.org/2000/svg'>"+inner+"</svg>";}
function scaler(xmin,xmax,ymin,ymax,w,h,pad){var xr=(xmax-xmin)||1,yr=(ymax-ymin)||1;return [function(x){return pad+(x-xmin)/xr*(w-2*pad);},function(y){return h-pad-(y-ymin)/yr*(h-2*pad);}];}
function pathD(points,stroke,dash,fill,width){if(!points.length)return '';var d='M'+points.map(function(p){return p[0].toFixed(1)+','+p[1].toFixed(1);}).join(' L');var da=dash?" stroke-dasharray='6 5'":'';return "<path d='"+d+"' fill='"+(fill||'none')+"' stroke='"+stroke+"' stroke-width='"+(width||2)+"' vector-effect='non-scaling-stroke'"+da+"/>";}
function sparkline(vals,color){if(!vals.length||Math.max.apply(null,vals)<=0)return "<svg class='spark'></svg>";var W=200,H=28,P=2;var s=scaler(0,Math.max(vals.length-1,1),0,Math.max.apply(null,vals)||1,W,H,P);return svgWrap(W,H,pathD(vals.map(function(v,i){return [s[0](i),s[1](v)];}),color,false,'none',1.5),'spark');}
function svgCumulative(days,run){
  var keys=Object.keys(days).filter(isDate).sort();
  if(!keys.length)return '<p class="muted">No data.</p>';
  var W=1000,H=300,P=44,cum=0,pts=[];
  keys.forEach(function(k,i){cum+=days[k].cost;pts.push([i,cum]);});
  var xmax=keys.length-1, proj=[];
  if(run.avg && keys.length>=1){for(var j=1;j<15;j++)proj.push([xmax+j,cum+run.avg*j]);}
  var pxmax=proj.length?(xmax+14):(xmax||1);
  var ytop=(proj.length?proj[proj.length-1][1]:cum)||1;
  var s=scaler(0,pxmax||1,0,ytop,W,H,P),fx=s[0],fy=s[1];
  var lastX=fx(xmax);
  var inner="<line class='axis' x1='"+P+"' y1='"+(H-P)+"' x2='"+(W-P)+"' y2='"+(H-P)+"'/>"+
            "<line class='axis' x1='"+P+"' y1='"+P+"' x2='"+P+"' y2='"+(H-P)+"'/>"+
            "<text x='"+P+"' y='"+(P-12)+"'>$"+fmtInt(Math.round(ytop))+"</text>"+
            "<text x='"+P+"' y='"+(H-P+16)+"'>"+esc(keys[0])+"</text>";
  inner="<defs><linearGradient id='cumfill' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='var(--ac)' stop-opacity='.30'/><stop offset='1' stop-color='var(--ac)' stop-opacity='0'/></linearGradient></defs>"+inner;
  var areaD='M'+pts.map(function(p){return fx(p[0]).toFixed(1)+','+fy(p[1]).toFixed(1);}).join(' L')+' L'+lastX.toFixed(1)+','+(H-P)+' L'+fx(0).toFixed(1)+','+(H-P)+' Z';
  inner+="<path d='"+areaD+"' fill='url(#cumfill)' stroke='none'/>";
  inner+=pathD(pts.map(function(p){return [fx(p[0]),fy(p[1])];}),'var(--ac)',false,'none',2.2);
  // $ labels on the first and last (today) green datapoints
  inner+="<text x='"+(fx(0)+8).toFixed(1)+"' y='"+(fy(pts[0][1])-6).toFixed(1)+"' fill='var(--ink-soft)'>$"+fmtInt(Math.round(pts[0][1]))+"</text>";
  inner+="<text x='"+(lastX-8).toFixed(1)+"' y='"+(fy(pts[pts.length-1][1])-6).toFixed(1)+"' text-anchor='end' fill='var(--ink-soft)'>$"+fmtInt(Math.round(pts[pts.length-1][1]))+"</text>";
  inner+="<line x1='"+lastX.toFixed(1)+"' y1='"+P+"' x2='"+lastX.toFixed(1)+"' y2='"+(H-P)+"' stroke='var(--line)' stroke-width='1' stroke-dasharray='3 3'/>";
  var todayTop=!!proj.length && (W-P-lastX)<70;
  var todayY=todayTop?(P-12):(H-P+16);
  var todayFill=todayTop?" fill='var(--ink-faint)'":"";
  inner+="<text x='"+lastX.toFixed(1)+"' y='"+todayY+"' text-anchor='middle'"+todayFill+">"+esc(keys[keys.length-1])+"</text>";
  if(proj.length){
    var projEnd=addDays(keys[keys.length-1],14);
    var allp=[[pts[pts.length-1][0],pts[pts.length-1][1]]].concat(proj);
    inner+=pathD(allp.map(function(p){return [fx(p[0]),fy(p[1])];}),'var(--ink-faint)',true,'none',2);
    inner+="<text x='"+(W-P)+"' y='"+(P-12)+"' text-anchor='end' fill='var(--ink-faint)'>proj $"+fmtInt(Math.round(proj[proj.length-1][1]))+"</text>";
    inner+="<text x='"+(W-P)+"' y='"+(H-P+16)+"' text-anchor='end' fill='var(--ink-faint)'>"+esc(projEnd)+"</text>";
  }
  return svgWrap(W,H,inner);
}
function svgScatter(S,cmap){
  var pts=S.filter(function(s){return s.tok>0&&s.cost>0;});
  if(!pts.length)return '<p class="muted">No data.</p>';
  var W=1000,H=320,P=48,xs=pts.map(function(s){return Math.log10(s.tok);}),ys=pts.map(function(s){return s.cost;});
  var s=scaler(Math.min.apply(null,xs),Math.max.apply(null,xs)||1,0,Math.max.apply(null,ys)||1,W,H,P),fx=s[0],fy=s[1];
  var inner="<line class='axis' x1='"+P+"' y1='"+(H-P)+"' x2='"+(W-P)+"' y2='"+(H-P)+"'/>"+
            "<line class='axis' x1='"+P+"' y1='"+P+"' x2='"+P+"' y2='"+(H-P)+"'/>"+
            "<text x='"+P+"' y='"+(P-12)+"'>$"+Math.max.apply(null,ys).toFixed(2)+"</text>"+
            "<text x='"+(W-P)+"' y='"+(H-P+18)+"' text-anchor='end'>tokens (log) →</text>"+
            "<text x='"+P+"' y='"+(H-P+18)+"'>cost ↑</text>";
  pts.forEach(function(s){var x=fx(Math.log10(s.tok)),y=fy(s.cost);var col=cmap[s.model||'others']||'var(--ink-faint)';inner+="<circle cx='"+x.toFixed(1)+"' cy='"+y.toFixed(1)+"' r='4' fill='"+col+"' opacity='0.6'><title>"+esc(s.model||'others')+" · $"+s.cost.toFixed(2)+" · "+fmtInt(s.tok)+" tok</title></circle>";});
  return svgWrap(W,H,inner);
}
function svgPareto(par){
  var pts=par.points;if(!pts.length)return '<p class="muted">No data.</p>';
  var cap=60,bars=pts.slice(0,cap),W=1000,H=300,P=48,n=bars.length,cmax=bars.length?bars[0][1]:1;
  var s=scaler(0,Math.max(n,1),0,cmax,W,H,P),fx=s[0],fy=s[1];
  function fyp(p){return H-P-p/100*(H-2*P);}
  var bw=(W-2*P)/n*0.8;
  var inner="<line class='axis' x1='"+P+"' y1='"+(H-P)+"' x2='"+(W-P)+"' y2='"+(H-P)+"'/>"+
            "<line class='axis' x1='"+P+"' y1='"+P+"' x2='"+P+"' y2='"+(H-P)+"'/>"+
            "<text x='"+P+"' y='"+(P-12)+"'>$"+cmax.toFixed(2)+"</text>"+
            "<text x='"+(W-P)+"' y='"+(P-12)+"' text-anchor='end' fill='var(--ink-faint)'>100% cum</text>";
  bars.forEach(function(b){var rank=b[0],c=b[1];var x=fx(rank-0.5)-bw/2,y=fy(c);inner+="<rect x='"+x.toFixed(1)+"' y='"+y.toFixed(1)+"' width='"+bw.toFixed(1)+"' height='"+(H-P-y).toFixed(1)+"' fill='var(--ac)' opacity='0.55'><title>#"+rank+" · $"+c.toFixed(2)+"</title></rect>";});
  inner+=pathD(pts.slice(0,cap).map(function(b){return [fx(b[0]-0.5),fyp(b[2])];}),'var(--ink-soft)',false,'none',2);
  if(par.n>cap)inner+="<text x='"+(W-P)+"' y='"+(H-P+18)+"' text-anchor='end'>top "+cap+" of "+par.n+" sessions</text>";
  return svgWrap(W,H,inner);
}
function svgTreemap(pm,cmap){
  var items=Object.keys(pm).map(function(m){return [m,pm[m].cost];}).filter(function(x){return x[1]>0;}).sort(function(a,b){return b[1]-a[1];});
  if(!items.length)return '<p class="muted">No data.</p>';
  var W=1000,H=170,tot=items.reduce(function(a,b){return a+b[1];},0)||1,x=0,inner='';
  items.forEach(function(it){var m=it[0],c=it[1],w=c/tot*W;inner+="<rect x='"+x.toFixed(1)+"' y='0' width='"+w.toFixed(1)+"' height='"+H+"' rx='12' ry='12' fill='"+(cmap[m]||'var(--ink-faint)')+"' stroke='var(--surface)' stroke-width='3'><title>"+escAttr(m)+" · $"+c.toFixed(2)+" · "+(c/tot*100).toFixed(1)+"%</title></rect>";if(w>64){var label=esc(m.split('/').pop().slice(0,18));inner+="<text x='"+(x+7).toFixed(1)+"' y='22' fill='#fff' style='font-size:11px'>"+label+"</text><text x='"+(x+7).toFixed(1)+"' y='39' fill='#fff' style='font-size:11px'>$"+Math.round(c)+"</text>";}x+=w;});
  return svgWrap(W,H,inner,'treemap');
}
// month-grid calendar (design-system: Charts > Daily spend calendar) — renders the
// month containing `toDate`; cell intensity = daily spend relative to the month's peak.
var MONTHS_FULL=['January','February','March','April','May','June','July','August','September','October','November','December'];
function calMonth(days,toDate){
  if(!toDate)return '<p class="muted">No data.</p>';
  var y=+toDate.slice(0,4),m=+toDate.slice(5,7);
  var startPad=new Date(y,m-1,1).getDay();      // 0=Sun
  var dim=new Date(y,m,0).getDate();            // days in month
  var mx=0;for(var d=1;d<=dim;d++){var c0=(days[y+'-'+pad2(m)+'-'+pad2(d)]||{}).cost||0;if(c0>mx)mx=c0;}
  var dh=['S','M','T','W','T','F','S'],html=dh.map(function(x){return "<div class='dh'>"+x+"</div>";}).join('');
  for(var i=0;i<startPad;i++)html+="<div class='c empty'></div>";
  for(var d2=1;d2<=dim;d2++){
    var iso=y+'-'+pad2(m)+'-'+pad2(d2),c=(days[iso]||{}).cost||0,v=mx>0?c/mx:0;
    var bg=v<.06?'var(--line-soft)':"color-mix(in srgb, var(--ac) "+Math.round(v*82+12)+"%, transparent)";
    var tip=iso+' · '+(c?fmtMoney(c):'—');
    html+="<div class='c"+(v>.5?' on':'')+"' style='background:"+bg+"' title='"+escAttr(tip)+"'>"+d2+"</div>";
  }
  return "<div class='cal-lbl'>"+MONTHS_FULL[m-1]+" "+y+"</div><div class='cal'>"+html+"</div>";
}
function dayhourHeatmap(S){
  var grid=[];for(var d=0;d<7;d++)grid.push(new Array(24).fill(0));var seen=false;
  S.forEach(function(s){if(s.dow==null||s.hour==null)return;grid[s.dow][s.hour]+=s.cost;seen=true;});
  if(!seen)return '<p class="muted">No data.</p>';
  var b=bucketer(grid.flat());var dow=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];var out=["<div></div>"];
  for(var h=0;h<24;h++)out.push("<div class='hd'>"+(h%6===0?h:'')+"</div>");
  for(var d=0;d<7;d++){out.push("<div class='rl'>"+dow[d]+"</div>");for(var h=0;h<24;h++){var c=grid[d][h],lv=b(c);var tip=dow[d]+' '+pad2(h)+':00 · '+(c?'$'+c.toFixed(2):'—');out.push("<div class='cell'"+(lv?" style='background:"+CFG.HEAT[lv]+"'":"")+" title='"+escAttr(tip)+"'></div>");}}
  var pk=null,pkD=0,pkH=0;
  for(var d2=0;d2<7;d2++)for(var h2=0;h2<24;h2++){if(grid[d2][h2]>(pk||0)){pk=grid[d2][h2];pkD=d2;pkH=h2;}}
  var dowFull=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  var hh=pkH%12||12,ap=pkH<12?'AM':'PM';
  var ft=pk?"<div class='heatft'><span>Peak spend: <b>"+dowFull[pkD]+", "+hh+" "+ap+"</b> &middot; "+fmtMoney(pk)+" in that hour</span><span class='scalekey'>less <i style='background:"+CFG.HEAT[1]+"'></i><i style='background:"+CFG.HEAT[2]+"'></i><i style='background:"+CFG.HEAT[3]+"'></i><i style='background:"+CFG.HEAT[4]+"'></i> more</span></div>":'';
  return "<div class='heat'>"+out.join('')+"</div>"+ft;
}

// ---- bars / tables ----
function tokenBars(bucket,vis){
  var keys=Object.keys(bucket).sort().reverse();if(!keys.length)return '<p class="muted">No data.</p>';
  var visKeys=vis||CFG.TOKEN.map(function(tk){return tk.key;});
  var mx=0;keys.forEach(function(k){var b=bucket[k];var t=0;visKeys.forEach(function(key){t+=b[key];});if(t>mx)mx=t;});mx=mx||1;
  var rows='';keys.forEach(function(k){var b=bucket[k];var tot=0;var segs='';CFG.TOKEN.forEach(function(tk){if(visKeys.indexOf(tk.key)<0)return;var v=b[tk.key];if(v<=0)return;tot+=v;segs+="<div class='seg' style='width:"+(v/mx*100).toFixed(4)+"%;background:"+tk.col+"' data-tip='"+tk.name+" · "+fmtInt(v)+"'></div>";});rows+="<div class='bar-row'><div class='bar-label'>"+esc(k)+"</div><div class='sbar-track'>"+segs+"</div><div class='bar-val'>"+fmtAbbr(tot)+"</div></div>";});
  return rows;
}
function barChart(counts,color,fmt,color_map){
  var keys=Object.keys(counts);if(!keys.length)return '<p class="muted">No data.</p>';
  var mx=0;keys.forEach(function(k){if(counts[k]>mx)mx=counts[k];});mx=mx||1;
  var rows='';keys.forEach(function(k){var v=counts[k];var pct=Math.max(3,Math.round(v/mx*100));var val=fmt?fmt(v):v;var bcol=color_map?(color_map[k]||color):color;rows+="<div class='bar-row'><div class='bar-label'>"+esc(k)+"</div><div class='bar-track'><div class='bar' style='width:"+pct+"%;background:"+bcol+"'></div></div><div class='bar-val'>"+esc(val)+"</div></div>";});
  return rows;
}
function shareBars(months,cmap){
  var keys=Object.keys(months).sort().reverse();if(!keys.length)return '<p class="muted">No data.</p>';
  var rows='';keys.forEach(function(k){var cbm=months[k].cost_by_model;var tot=Object.keys(cbm).reduce(function(a,m){return a+cbm[m];},0)||1;var segs='';Object.keys(cbm).sort(function(a,b){return cbm[b]-cbm[a];}).forEach(function(m){var w=cbm[m]/tot*100;if(w<=0)return;segs+="<div class='seg' style='width:"+w.toFixed(3)+"%;background:"+(cmap[m]||'var(--ink-faint)')+"' data-tip='"+escAttr(m)+" · "+w.toFixed(1)+"%'></div>";});rows+="<div class='bar-row'><div class='bar-label'>"+esc(k)+"</div><div class='sbar-track'>"+segs+"</div><div class='bar-val'>$"+Math.round(tot)+"</div></div>";});
  return rows;
}
function periodTable(bucket,label,active){
  var keys=Object.keys(bucket).sort().reverse();if(!keys.length)return '<p class="muted">No data.</p>';
  var filt=active&&active.size;
  var head="<tr><th>"+esc(label)+"</th><th class='n'>Sessions</th><th class='n'>Cost $</th><th class='n'>Input tok</th><th class='n'>Output tok</th><th class='n'>Cache read</th><th class='n'>Cache create</th></tr>";
  var body='',tot={sessions:0,cost:0,in:0,out:0,cr:0,cc:0};
  keys.forEach(function(k){var d=bucket[k],r;
    if(filt){r={sessions:0,cost:0,in:0,out:0,cr:0,cc:0};var bm=d.by_model||{};Object.keys(bm).forEach(function(m){if(!active.has(m))return;var x=bm[m];r.sessions+=x.sessions;r.cost+=x.cost;r.in+=x.in;r.out+=x.out;r.cr+=x.cr;r.cc+=x.cc;});if(!r.sessions&&!r.cost)return;}
    else r=d;
    body+="<tr><td>"+esc(k)+"</td><td class='n'>"+r.sessions+"</td><td class='n'>"+r.cost.toFixed(2)+"</td><td class='n'>"+fmtInt(r.in)+"</td><td class='n'>"+fmtInt(r.out)+"</td><td class='n'>"+fmtInt(r.cr)+"</td><td class='n'>"+fmtInt(r.cc)+"</td></tr>";tot.sessions+=r.sessions;tot.cost+=r.cost;tot.in+=r.in;tot.out+=r.out;tot.cr+=r.cr;tot.cc+=r.cc;});
  body+="<tr class='total'><td>Total</td><td class='n'>"+tot.sessions+"</td><td class='n'>"+tot.cost.toFixed(2)+"</td><td class='n'>"+fmtInt(tot.in)+"</td><td class='n'>"+fmtInt(tot.out)+"</td><td class='n'>"+fmtInt(tot.cr)+"</td><td class='n'>"+fmtInt(tot.cc)+"</td></tr>";
  return "<table class='tbl'>"+head+body+"</table>";
}
function donutHtml(data,centerVal,centerSub){
  var total=0;data.forEach(function(x){total+=x.v;});
  if(total<=0)return '<p class="muted">No data.</p>';
  var R=64,SW=26,C=100,circ=2*Math.PI*R,accd=0,segs='';
  data.forEach(function(x){
    if(x.v<=0)return;
    var dash=x.v/total*circ;
    segs+="<circle cx='"+C+"' cy='"+C+"' r='"+R+"' fill='none' stroke='"+x.c+"' stroke-width='"+SW+"' stroke-dasharray='"+dash.toFixed(2)+" "+(circ-dash).toFixed(2)+"' stroke-dashoffset='"+(-accd).toFixed(2)+"' transform='rotate(-90 "+C+" "+C+")'><title>"+escAttr(x.k)+" \u00b7 "+fmtInt(x.v)+" ("+(x.v/total*100).toFixed(1)+"%)</title></circle>";
    accd+=dash;
  });
  var center=centerVal?"<text x='100' y='97' text-anchor='middle' class='donut-val'>"+esc(centerVal)+"</text><text x='100' y='118' text-anchor='middle' class='donut-sub'>"+esc(centerSub||'')+"</text>":'';
  var legend='';data.forEach(function(x){if(x.v<=0)return;legend+="<div class='li'><i style='background:"+x.c+"'></i><b>"+esc(x.k)+"</b><span class='pc'>"+(x.v/total*100).toFixed(0)+"%</span></div>";});
  return "<div class='donut-wrap'><div class='donut'><svg viewBox='0 0 200 200' width='176' style='max-width:100%'>"+segs+center+"</svg></div><div class='donut-legend'>"+legend+"</div></div>";
}
// callout/note row (design-system: Callouts & notes > Note variants) — bold figure + label
function noteRow(cls,iconPaths,v,k,tip){return "<div class='note"+(cls?' '+cls:'')+"'"+(tip?" title='"+escAttr(tip)+"'":"")+"><svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'>"+iconPaths+"</svg><div class='txt'><b>"+esc(v)+"</b> "+esc(k)+"</div></div>";}
// efficiency rate readout — big figure with a clay slash-unit (the ratio operator) + caption
// One row of the metric/ratio card (design-system "Metric / ratio card"): eyebrow
// label, hero figure with a clay /unit, a context line (ctxHtml may carry <b>),
// and an optional coverage meter. No delta/trend chip by design.
function ratioBlock(eyebrow,val,unit,ctxHtml,tip,meterPct,raw,kind){
  var u=(val==='—')?'':"<span class='unit'>"+esc(unit)+"</span>";
  var meter=(meterPct==null)?'':"<div class='ratio-meter'><i style='width:"+Math.max(0,Math.min(100,meterPct))+"%'></i></div>";
  var cu=(raw!=null&&!isNaN(raw))?" data-cu='"+raw+"' data-cu-k='"+(kind||'int')+"'":"";
  return "<div class='ratio'"+(tip?" title='"+escAttr(tip)+"'":"")+">"+
    "<div class='ratio-eyebrow'>"+esc(eyebrow)+"</div>"+
    "<div class='ratio-hero'><span class='ratio-val'"+cu+">"+esc(val)+u+"</span></div>"+
    "<div class='ratio-ctx'>"+ctxHtml+"</div>"+meter+"</div>";
}
// structured multi-column text card (design-system: Multi-column text > Structured columns)
function colcards(cols){
  var html=cols.map(function(c){
    var rows=c.stats.map(function(s){return "<div class='cc-row'><span>"+esc(s[0])+"</span><b>"+esc(s[1])+"</b></div>";}).join('');
    return "<div><h4>"+esc(c.title)+"</h4>"+rows+"</div>";
  }).join('');
  return "<div class='colcards'>"+html+"</div>";
}
function svgRateTrend(sessions){
  var rl=sessions.filter(function(s){return s.r5>0||s.r7>0;}).sort(function(a,b){return a.ts<b.ts?-1:a.ts>b.ts?1:0;});
  if(!rl.length)return '<p class="muted">No rate-limit data yet.</p>';
  var W=1000,H=220,P=38,n=rl.length;
  var s=scaler(0,Math.max(n-1,1),0,100,W,H,P);
  var fx=s[0],fy=s[1];
  var d5=pathD(rl.map(function(s2,i){return [fx(i),fy(s2.r5)];}),'var(--sage)',false,'none',2);
  var d7=pathD(rl.map(function(s2,i){return [fx(i),fy(s2.r7)];}),'var(--ac)',false,'none',2);
  var th80=pathD([[fx(0),fy(80)],[fx(n-1),fy(80)]],'var(--ink-soft)',true,'none',1);
  var ceiling=pathD([[fx(0),fy(100)],[fx(n-1),fy(100)]],'var(--ink-faint)',false,'none',0.6);
  var axes="<line class='axis' x1='"+P+"' y1='"+(H-P)+"' x2='"+(W-P)+"' y2='"+(H-P)+"'/>"+
          "<line class='axis' x1='"+P+"' y1='"+P+"' x2='"+P+"' y2='"+(H-P)+"'/>";
  var yticks=[0,25,50,75,100].map(function(v){return "<text x='"+(P-6)+"' y='"+(fy(v)+4).toFixed(1)+"' text-anchor='end' fill='var(--ink-faint)'>"+v+"%</text>";}).join('');
  // x-axis: label distinct calendar days at intervals — one label per day at the
  // x of its first rate-limit session, strided to cap ~12 labels so they don't
  // overlap. first day anchors start (flush to left axis), last anchors end.
  var dayFirst={},dayOrder=[];
  rl.forEach(function(s2,i){var d=s2.ts.slice(0,10);if(!(d in dayFirst)){dayFirst[d]=i;dayOrder.push(d);}});
  var MAXLBL=12,stride=Math.ceil(dayOrder.length/MAXLBL);
  var xlabels='';
  for(var di=0;di<dayOrder.length;di+=stride){
    if(di===dayOrder.length-1)continue; // last rendered below with end anchor
    var xi=fx(dayFirst[dayOrder[di]]);
    xlabels+="<text x='"+xi.toFixed(1)+"' y='"+(H-P+16)+"' text-anchor='"+(di===0?'start':'middle')+"' fill='var(--ink-faint)'>"+esc(dayOrder[di].slice(5,10))+"</text>";
  }
  var lastDi=dayOrder.length-1,lxi=fx(dayFirst[dayOrder[lastDi]]);
  xlabels+="<text x='"+lxi.toFixed(1)+"' y='"+(H-P+16)+"' text-anchor='"+(dayOrder.length>1?'end':'start')+"' fill='var(--ink-faint)'>"+esc(dayOrder[lastDi].slice(5,10))+"</text>";
  xlabels+="<text x='"+(W-P)+"' y='"+(P-10)+"' text-anchor='end' fill='var(--ink-faint)'>% used →</text>";
  // weekend bands: group rate-limit sessions by calendar date (dow 5=Sat, 6=Sun),
  // map each date's index range to a rect behind the lines. x-edges align to the
  // midpoint between adjacent points so bands don't overlap neighboring weekdays.
  var byDate={};
  rl.forEach(function(s2,i){if(s2.dow===5||s2.dow===6){var d=s2.ts.slice(0,10);if(!byDate[d])byDate[d]={min:i,max:i};byDate[d].min=Math.min(byDate[d].min,i);byDate[d].max=Math.max(byDate[d].max,i);}});
  var step=(n>1)?(fx(1)-fx(0))/2:0;
  var wknd='';
  Object.keys(byDate).sort().forEach(function(k){var b=byDate[k];
    var x1=b.min===0?P:Math.max(P,fx(b.min)-step);
    var x2=b.max===n-1?(W-P):Math.min(W-P,fx(b.max)+step);
    if(x2<=x1)return;
    wknd+="<rect x='"+x1.toFixed(1)+"' y='"+P+"' width='"+(x2-x1).toFixed(1)+"' height='"+(H-2*P)+"' fill='var(--weekend)' fill-opacity='0.5'/>";
  });
  // datapoint hit-areas: one circle per line per session, each carrying a native
  // <title> tooltip (date + both window values) — same pattern as svgScatter.
  var dots='';
  rl.forEach(function(s2,i){
    var x=fx(i),tip=esc(s2.ts.slice(0,10)+' · 5h '+s2.r5.toFixed(1)+'% · 7d '+s2.r7.toFixed(1)+'%');
    dots+="<circle cx='"+x.toFixed(1)+"' cy='"+fy(s2.r5).toFixed(1)+"' r='3' fill='var(--sage)' opacity='0.85'><title>"+tip+"</title></circle>";
    dots+="<circle cx='"+x.toFixed(1)+"' cy='"+fy(s2.r7).toFixed(1)+"' r='3' fill='var(--ac)' opacity='0.85'><title>"+tip+"</title></circle>";
  });
  var leg="<div class='legend' style='margin:6px 0'><span class='lg-item'><span class='lg-swatch' style='background:var(--sage)'></span>5h window</span><span class='lg-item'><span class='lg-swatch' style='background:var(--ac)'></span>7d window</span><span class='lg-item'><span class='lg-swatch' style='background:var(--weekend);opacity:.5'></span>weekend</span></div>";
  return leg+svgWrap(W,H,axes+ceiling+th80+yticks+xlabels+wknd+d5+d7+dots,'chart');
}
function renderRateLimits(sessions){
  var rl=sessions.filter(function(s){return s.r5>0||s.r7>0;});
  if(!rl.length)return "<div class='empty-state'><svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='9'/><path d='M12 8h.01M11 12h1v4h1'/></svg><h4>No rate-limit data yet.</h4><p>Tracking fills as sessions record — forward-only, Claude.ai Pro/Max only (absent for API-key/Bedrock/Vertex and some Max 20x oauth users).</p></div>";
  var r5s=rl.map(function(s){return s.r5;}),r7s=rl.map(function(s){return s.r7;});
  var avg=function(a){return a.reduce(function(x,y){return x+y;},0)/a.length;};
  var maxA=function(a){return Math.max.apply(null,a);};
  var nearCap=rl.filter(function(s){return s.r5>=80||s.r7>=80;}).length;
  var capped=rl.filter(function(s){return s.r5>=99.5||s.r7>=99.5;}).length;
  var peak7=maxA(r7s)||1;
  var rlCost=rl.reduce(function(x,s){return x+s.cost;},0);
  var $per7pt=peak7>0?(rlCost/peak7):0;
  return svgRateTrend(sessions)+colcards([
    {title:'5-hour window',stats:[["avg %",avg(r5s).toFixed(1)],["peak %",maxA(r5s).toFixed(1)]]},
    {title:'7-day window',stats:[["avg %",avg(r7s).toFixed(1)],["peak %",maxA(r7s).toFixed(1)]]},
    {title:'Headroom',stats:[["near-cap (>80%)",fmtInt(nearCap)],["capped (100%)",fmtInt(capped)],["$/7d%-pt at peak",fmtMoney($per7pt)]]}
  ]);
}
// Per-model weekly quotas + extra-usage credits from the OAuth usage snapshot
// (USAGE_LATEST, embedded by render.mjs). Point-in-time, not per-session, so it
// lives outside the SESSIONS payload. Empty-state when OAuth polling is off or
// the plan exposes no per-model breakdown. utilization is in percent (API contract).
function renderModelQuotas(L){
  L=L||{};
  var pm=L.per_model||{};
  var order=['sonnet','opus','design'];
  var have=order.filter(function(m){return pm[m]&&pm[m].utilization!=null;});
  if(!have.length){
    return "<div class='empty-state'><svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='9'/><path d='M12 8h.01M11 12h1v4h1'/></svg><h4>No per-model quota data.</h4><p>Captured from the OAuth usage API (opt-in): run <code>node stats.mjs fetch-usage --oauth --save</code> with <code>USAGE_REPORT_OAUTH=1</code>. Absent on some plans.</p></div>";
  }
  var colorFor=function(p){return p>=80?'var(--ac)':(p>=50?'var(--amber)':'var(--sage)');};
  var html='';
  order.forEach(function(m){
    var w=pm[m]; if(!w||w.utilization==null)return;
    var p=Number(w.utilization),pct=Math.max(2,Math.min(100,p));
    var reset=w.resets_at?(' resets '+esc(String(w.resets_at).slice(0,19).replace('T',' '))):'';
    html+="<div class='bar-row'><div class='bar-label'>"+esc(m)+"</div><div class='bar-track'><div class='bar' style='width:"+pct.toFixed(1)+"%;background:"+colorFor(p)+"'></div></div><div class='bar-val'>"+p.toFixed(1)+"%"+reset+"</div></div>";
  });
  var eu=L.extra_usage,cards='';
  if(eu&&eu.is_enabled){
    cards=colcards([{title:'Extra-usage credits',stats:[
      ["monthly limit",eu.monthly_limit!=null?fmtInt(eu.monthly_limit):'—'],
      ["used credits",eu.used_credits!=null?fmtInt(eu.used_credits):'—'],
      ["utilization",eu.utilization!=null?(Number(eu.utilization).toFixed(1)+'%'):'—']
    ]}]);
  }
  return html+cards+"<p class='muted' style='margin-top:6px'>Snapshot: "+esc(L.fetched_at||'—')+" · OAuth usage API (opt-in)</p>";
}
// Empirical-Bayes rate-limit forecast (FORECAST, embedded by render.mjs). Projects
// each gauge's utilization at its reset boundary with an 80% credible interval
// + ETA-to-threshold, fit from OAuth usage-snapshots (or a prior-only statusline
// fallback when OAuth is off). claumon MODEL v2.1 port (forecast.mjs). Empty-state
// when neither gauge has enough rl-bearing history.
function fmtEta(e){
  if(!e)return '—';
  if(e.pInf>=0.5)return 'never ('+Math.round(e.pInf*100)+'% of paths)';
  var med=e.median?new Date(e.median*1000):null;
  var s=med?(pad2(med.getMonth()+1)+'-'+pad2(med.getDate())+' '+pad2(med.getHours())+':'+pad2(med.getMinutes())):'—';
  return s+(e.upper?'':' · open-ended')+'  ·  P∞ '+Math.round(e.pInf*100)+'%';
}
function pad2(n){return String(n).padStart(2,'0');}
function renderForecast(F){
  F=F||{};
  var g=F.gauges||{};
  var labels={five_hour:'5-hour window',seven_day:'7-day window'};
  var keys=['five_hour','seven_day'];
  var anyOk=keys.some(function(k){return g[k]&&g[k].ok;});
  if(!anyOk){
    return "<div class='empty-state'><svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'><path d='M3 17l6-6 4 4 8-8'/><path d='M14 7h7v7'/></svg><h4>No forecast yet.</h4><p>Needs ≥2 completed rate-limit windows. Captured from the OAuth usage API (opt-in): run <code>node stats.mjs fetch-usage --oauth --save</code> with <code>USAGE_REPORT_OAUTH=1</code>. A prior-only view appears from statusline rl data once ≥2 sessions record it.</p></div>";
  }
  var colorFor=function(p){return p>=80?'var(--ac)':(p>=50?'var(--amber)':'var(--sage)');};
  var rows='';
  keys.forEach(function(k){
    var gg=g[k]; if(!gg||!gg.ok)return;
    var lbl=labels[k], src=gg.source==='statusline'?'statusline rl':'OAuth';
    if(gg.result){
      var fc=gg.result.forecast,u=gg.result.uNow;
      var f=fc.f,lo=fc.lower,hi=fc.upper;
      // scale 0..max(100, hi) so a projected value >100 (demand past the cap) stays visible
      var top=Math.max(100,Math.ceil(hi/10)*10);
      var pct=Math.max(0,Math.min(100,(f/top)*100)).toFixed(1);
      var bar="<div class='bar-row'><div class='bar-label'>"+esc(lbl)+"</div>"+
        "<div class='bar-track'><div class='bar' style='width:"+pct+"%;background:"+colorFor(f)+"'></div></div>"+
        "<div class='bar-val'>"+f.toFixed(1)+"%</div></div>";
      rows+=bar;
      rows+="<div class='cc-row' style='padding:2px 0 0 0'><span>now → reset</span><b>"+u.toFixed(1)+"% → "+f.toFixed(1)+"%  <span class='muted'>80% CI ["+lo.toFixed(1)+"–"+hi.toFixed(1)+"]</span></b></div>";
      rows+="<div class='cc-row' style='padding:2px 0 0 0'><span>ETA to 100%</span><b>"+esc(fmtEta(gg.result.etas['100']))+"</b></div>";
      rows+="<div class='cc-row' style='padding:2px 0 6px 0'><span>ETA to 80%</span><b>"+esc(fmtEta(gg.result.etas['80']))+"</b></div>";
    } else {
      var mu=gg.prior?gg.prior.mu0:0;
      rows+="<div class='bar-row'><div class='bar-label'>"+esc(lbl)+"</div><div class='bar-track'></div><div class='bar-val muted'>prior only</div></div>";
      rows+="<div class='cc-row' style='padding:2px 0 6px 0'><span>rate prior</span><b>"+mu.toFixed(2)+"%/h · n="+gg.nWindows+"</b></div>";
    }
    rows+="<p class='muted' style='margin:0 0 10px 0'>"+esc(lbl)+": "+src+", n="+gg.nWindows+" window"+(gg.nWindows===1?'':'s')+(gg.result&&gg.result.posterior?(gg.result.posterior.usedOLS?', OLS fit':', prior fallback'):'')+"</p>";
  });
  return rows+"<p class='muted' style='margin-top:4px'>Model "+esc(F.modelVersion||'v2.1-js')+" · fit "+esc(F.fitAt||'—')+" · 80% CI from monotone Gamma-process MC</p>";
}
function perModelEfficiency(rates,days,cmap){
  var keys=Object.keys(rates);if(!keys.length)return '<p class="muted">No data.</p>';
  var dkeys=Object.keys(days).filter(isDate).sort();
  var arr=keys.map(function(m){return [m,rates[m]];}).sort(function(a,b){return b[1].cost-a[1].cost;});
  var cards='';arr.forEach(function(x){var m=x[0],v=x[1];var series=dkeys.map(function(k){return (days[k].cost_by_model||{})[m]||0;});var spark=sparkline(series,cmap[m]||'var(--ac)');cards+="<div class='eff'><div class='nm'><span class='lg-swatch' style='background:"+(cmap[m]||'var(--ink-faint)')+";margin-right:6px'></span>"+esc(m)+"</div><div class='row'><span>cache hit</span><span>"+Math.round(v.cache_hit*100)+"%</span></div><div class='row'><span>$/1M tok</span><span>$"+v.cost_per_mtok.toFixed(2)+"</span></div><div class='row'><span>cost</span><span>$"+v.cost.toFixed(2)+"</span></div>"+spark+"</div>";});
  return "<div class='eff-grid'>"+cards+"</div>";
}
function topTable(sessions){
  var top=sessions.slice(0,10);var rows='';top.forEach(function(s){rows+="<tr><td>"+esc(s.ts)+"</td><td class='hide-sm'>"+esc(s.sid.slice(0,8))+"</td><td><span class='tag'>"+esc(s.model||'-')+"</span></td><td class='n'>$"+s.cost.toFixed(2)+"</td><td class='n'>"+fmtInt(s.tok)+"</td></tr>";});
  return "<table class='tbl'><thead><tr><th>Timestamp</th><th class='hide-sm'>Session</th><th>Model</th><th class='n'>Cost</th><th class='n'>Tokens</th></tr></thead><tbody>"+rows+"</tbody></table>";
}

// ---- aggregate ----
function aggregate(S){
  var t={sessions:0,cost:0,in:0,out:0,cr:0,cc:0,dur:0,api:0,la:0,lr:0,turns:0,tools:0};
  var days={},months={},per_model={},models=[],modelSet={};
  var usage={tools:{},tool_errors:0,agents:{},skills:{},compactions:0},projects={};
  for(var i=0;i<S.length;i++){
    var s=S[i];
    t.sessions++;t.cost+=s.cost;t.in+=s.in;t.out+=s.out;t.cr+=s.cr;t.cc+=s.cc;t.dur+=s.dur;t.api+=s.api;t.la+=s.la;t.lr+=s.lr;t.turns+=s.turns;t.tools+=s.tools;
    if(s.model){if(!modelSet[s.model]){modelSet[s.model]=1;models.push(s.model);}var pm=per_model[s.model]||(per_model[s.model]={sessions:0,cost:0,tokens:0,in:0,out:0,cr:0,cc:0});pm.sessions++;pm.cost+=s.cost;pm.tokens+=s.tok;pm.in+=s.in;pm.out+=s.out;pm.cr+=s.cr;pm.cc+=s.cc;}
    var dk=s.ts.slice(0,10),mk=s.ts.slice(0,7);
    var bmk=s.model||'others';
    if(dk){var dd=days[dk]||(days[dk]={sessions:0,cost:0,in:0,out:0,cr:0,cc:0,api:0,dur:0,cost_by_model:{},by_model:{}});dd.sessions++;dd.cost+=s.cost;dd.in+=s.in;dd.out+=s.out;dd.cr+=s.cr;dd.cc+=s.cc;dd.api+=s.api||0;dd.dur+=s.dur||0;if(s.cost)dd.cost_by_model[bmk]=(dd.cost_by_model[bmk]||0)+s.cost;var dbm=dd.by_model[bmk]||(dd.by_model[bmk]={sessions:0,cost:0,in:0,out:0,cr:0,cc:0});dbm.sessions++;dbm.cost+=s.cost;dbm.in+=s.in;dbm.out+=s.out;dbm.cr+=s.cr;dbm.cc+=s.cc;}
    if(mk){var mo=months[mk]||(months[mk]={sessions:0,cost:0,in:0,out:0,cr:0,cc:0,cost_by_model:{},by_model:{}});mo.sessions++;mo.cost+=s.cost;mo.in+=s.in;mo.out+=s.out;mo.cr+=s.cr;mo.cc+=s.cc;if(s.cost)mo.cost_by_model[bmk]=(mo.cost_by_model[bmk]||0)+s.cost;var mbm=mo.by_model[bmk]||(mo.by_model[bmk]={sessions:0,cost:0,in:0,out:0,cr:0,cc:0});mbm.sessions++;mbm.cost+=s.cost;mbm.in+=s.in;mbm.out+=s.out;mbm.cr+=s.cr;mbm.cc+=s.cc;}
    var fc=s.facets;
    if(fc){
      if(fc.t){for(var nm in fc.t){usage.tools[nm]=(usage.tools[nm]||0)+fc.t[nm];}}
      if(fc.a){for(var nm2 in fc.a){usage.agents[nm2]=(usage.agents[nm2]||0)+fc.a[nm2];}}
      if(fc.s){for(var nm3 in fc.s){usage.skills[nm3]=(usage.skills[nm3]||0)+fc.s[nm3];}}
      usage.tool_errors+=fc.te||0;usage.compactions+=fc.ce||0;
      var cwd=fc.cwd||'unknown';var p=projects[cwd]||(projects[cwd]={sessions:0,cost:0});p.sessions++;p.cost+=s.cost;
    }
  }
  models.sort();
  var ss=S.slice().sort(function(a,b){return b.cost-a.cost;});
  return {totals:t,days:days,months:months,per_model:per_model,models:models,sessions:ss,n:S.length,usage:usage,projects:projects};
}
function deriveStats(agg,range){
  var t=agg.totals,costs=agg.sessions.map(function(s){return s.cost;});
  var loc=0,lineSessions=0,locCost=0,activeDurMs=0,activeCost=0;
  agg.sessions.forEach(function(s){loc+=s.la+s.lr;if(s.la+s.lr>0){lineSessions++;locCost+=s.cost;}if(s.cost>0){activeDurMs+=s.dur;activeCost+=s.cost;}});
  return {dist:costDist(costs),run:runRate(agg.days),pareto:pareto(costs),rates:perModelRates(agg.per_model),series:spendSeries(agg.days,range.to),cacheHit:(t.cr+t.in)?t.cr/(t.cr+t.in):0,loc:loc,lineSessions:lineSessions,locCost:locCost,lineCov:agg.n?lineSessions/agg.n:0,activeDurHr:activeDurMs/3.6e6,activeCost:activeCost};
}
function filterSessions(range){return SESSIONS.filter(function(s){var d=s.ts.slice(0,10);return d>=range.from && d<=range.to;});}

// ---- hero ----
function renderHero(agg,st,firstDate){
  var t=agg.totals,fromNote='from '+firstDate;
  var lineVal=(st.loc&&st.lineCov>=CFG.LINE_COV)?fmtMoney3(st.locCost/st.loc):'—';
  var lineSub=st.loc?(fmtInt(st.loc)+' lines · '+Math.round(st.lineCov*100)+'% coverage'):fromNote;
  var hourVal=st.activeDurHr?fmtMoney(st.activeCost/st.activeDurHr):'—';
  var hourSub=st.activeDurHr?(st.activeDurHr.toFixed(1)+'h active'):fromNote;
  var lineTip="$/line = cost of line-bearing sessions / total lines changed. Shown only when line coverage >= "+(CFG.LINE_COV*100).toFixed(0)+"% of sessions; lines_added/lines_removed are forward-only statusline columns, so older sessions have 0 lines and would inflate the value. Coverage now "+Math.round(st.lineCov*100)+"% ("+st.lineSessions+"/"+agg.n+").";
  var hourTip="$/hour = cost of $0-cost-excluded sessions / active hours (sum of per-session duration, uncapped). duration_ms is the transcript wall-clock span (first->last event), so sessions left open for days (idle/hung, e.g. 577h @ $0) are excluded by the $0-cost filter. Long-but-real sessions count fully.";
  // flagcard sparkline (replaces the delta caption in the header card)
  var fspk=el('flagSpark');
  if(fspk)fspk.innerHTML=sparkline(st.series,'var(--ac)');
  // efficiency ratios: bold rate readouts — figure + clay slash-unit + caption
  var eff=el('sec-eff-ratios');
  if(eff){
    var hourCtx=st.activeDurHr?("<b>"+st.activeDurHr.toFixed(1)+"h</b> active &middot; <b>"+esc(fmtMoney(t.cost))+"</b> total spend"):esc(fromNote);
    var covPct=Math.round((st.lineCov||0)*100);
    var lineCtx=st.loc?("<b>"+esc(fmtInt(st.loc))+"</b> lines &middot; <b>"+covPct+"%</b> coverage"):esc(fromNote);
    eff.innerHTML=
      ratioBlock("Cost / active hour",hourVal,"/hr",hourCtx,hourTip,null,st.activeDurHr?(st.activeCost/st.activeDurHr):null,'money')+
      ratioBlock("Cost / line shipped",lineVal,"/line",lineCtx,lineTip,st.loc?covPct:null,(st.loc&&st.lineCov>=CFG.LINE_COV)?(st.locCost/st.loc):null,'money3');
  }
  var apiPct=t.dur?(t.api/t.dur*100):0;
  var dkeys=Object.keys(agg.days).filter(isDate).sort().slice(-30);
  function series(f){return dkeys.map(function(k){return f(agg.days[k]);});}
  function sbars(vals){
    if(!vals||vals.length<2)return '';
    var mx=0;vals.forEach(function(v){if(v>mx)mx=v;});if(mx<=0)return '';
    var sv=vals.slice().sort(function(a,b){return a-b;});var q3=sv[Math.floor(sv.length*0.75)];
    var h='';vals.forEach(function(v){var pct=Math.max(8,Math.round(v/mx*100));var col=(v>0&&v>=q3)?'var(--ac)':'color-mix(in srgb,var(--ink-faint) 32%,transparent)';h+="<i style='height:"+pct+"%;background:"+col+"'></i>";});
    return "<div class='sbars'>"+h+"</div>";
  }
  var supp=[
    ["sessions",fmtInt(agg.n),agg.n,'int',"recorded","Rows in stats.csv (one per session). Bars: sessions per day, accent = busiest quartile.",sbars(series(function(dd){return dd.sessions;}))],
    ["output tok",fmtAbbr(t.out),t.out,'abbr',fmtAbbr(t.in)+" input","Output vs input tokens across all sessions. Bars: output tokens per day.",sbars(series(function(dd){return dd.out;}))],
    ["cache hit",Math.round(st.cacheHit*100)+"%",st.cacheHit*100,'pct',"read / (read+input)","cache_read / (cache_read + input) — higher means less re-processed context. Bars: daily cache-hit rate.",sbars(series(function(dd){return (dd.cr+dd.in)?dd.cr/(dd.cr+dd.in)*100:0;}))],
    ["API time",t.dur?(apiPct.toFixed(0)+'%'):'—',t.dur?apiPct:null,'pct',t.dur?'of wall-clock':fromNote,"api_duration_ms / duration_ms — share of wall-clock spent on API calls. Bars: daily share.",sbars(series(function(dd){return dd.dur?dd.api/dd.dur*100:0;}))]];
  var suppHtml='';supp.forEach(function(s){
    var vspan="<span class='v'"+(s[2]!=null?" data-cu='"+s[2]+"' data-cu-k='"+s[3]+"'":"")+">"+esc(s[1])+"</span>";
    suppHtml+="<div class='supp' title='"+escAttr(s[5])+"'>"+vspan+"<span class='k'>"+esc(s[0])+"</span><span class='d'>"+esc(s[4])+"</span>"+s[6]+"</div>";
  });
  return "<div class='supp-strip'>"+suppHtml+"</div>";
}

// ---- render ----
function render(range){
  var S=filterSessions(range);
  var agg=aggregate(S);
  if(!agg.n){var msg='<p class="muted">No sessions in selected range.</p>';['kpi','sec-cumulative','sec-runrate','sec-cal','sec-eff-ratios','day-chart','month-chart','day-table','month-table','tok-day-bars','tok-month-bars','tok-mix','cc-ratio','sec-eff-models','sec-throughput','sec-ratelimits','sec-token-yield','sec-token-yield-summary','sec-model-quotas','sec-forecast','sec-dayhour','sec-scatter','sec-pareto','sec-toptable','sec-treemap','sec-model-sessions','sec-model-cost','sec-share','sec-usage-stats','sec-tools','sec-agents','sec-skills','sec-proj-cost','sec-proj-sess'].forEach(function(id){var e=el(id);if(e)e.innerHTML=msg;});el('tok-legend').innerHTML='';el('ty-legend').innerHTML='';return;}
  var st=deriveStats(agg,range),t=agg.totals;
  var chartModels=agg.models.slice();
  var hasOthers=Object.keys(agg.days).some(function(k){return 'others' in agg.days[k].cost_by_model;})||Object.keys(agg.months).some(function(k){return 'others' in agg.months[k].cost_by_model;});
  if(hasOthers)chartModels.push('others');
  var cmap=modelColorMap(chartModels);
  CHART={day:costByModel(agg.days),month:costByModel(agg.months),models:chartModels,colors:cmap};
  // hero
  el('kpi').innerHTML=renderHero(agg,st,FIRST_DATE);
  // spend over time
  el('sec-cumulative').innerHTML=svgCumulative(agg.days,st.run);
  el('sec-runrate').innerHTML="<div class='notes'>"+
    noteRow('info',"<circle cx='12' cy='12' r='9'/><path d='M12 7.5V12l3 1.8'/>",fmtMoney(st.run.avg),"avg / day (last "+st.run.ndays+"d)")+
    noteRow('',"<polyline points='3 17 9 11 13 15 21 7'/><polyline points='21 11 21 7 17 7'/>",fmtMoney(st.run.proj30),"projected 30d")+
    noteRow('ok',"<path d='M18 5H6l6 7-6 7h12'/>",fmtMoney(t.cost),"total to date")+
  "</div>";
  el('sec-cal').innerHTML=calMonth(agg.days,range.to);
  // breakdown (bars + tables both honor the model filter)
  CUR_AGG=agg;_draw();
  // token economics (legend pills filter the composition bars)
  renderTok();
  var totTok=t.in+t.out+t.cr+t.cc;
  el('tok-mix').innerHTML=donutHtml(CFG.TOKEN.map(function(tk){return {k:tk.name,v:t[tk.key],c:tk.col};}),fmtAbbr(totTok),'tokens');
  var ccKeys=Object.keys(agg.days).filter(isDate).sort().reverse();
  if(ccKeys.length>3)ccKeys=ccKeys.slice(0,-3);  // drop the 3 oldest days — keeps the panel compact
  var ccWaste={};ccKeys.forEach(function(k){var d=agg.days[k];ccWaste[k]=d.cr?(d.cc/d.cr):0;});
  el('cc-ratio').innerHTML=barChart(ccWaste,'var(--ink-soft)',function(v){return v.toFixed(2);});
  // efficiency
  el('sec-eff-models').innerHTML=perModelEfficiency(st.rates,agg.days,cmap);
  el('sec-throughput').innerHTML=colcards([
    {title:'Cadence',stats:[
      ["turns / session",agg.n?(t.turns/agg.n).toFixed(1):'—'],
      ["tools / session",agg.n?(t.tools/agg.n).toFixed(1):'—']]},
    {title:'Delivery',stats:[
      ["lines / session",(st.loc&&agg.n)?(st.loc/agg.n).toFixed(0):'—'],
      ["lines / hour",(st.loc&&st.activeDurHr)?(st.loc/st.activeDurHr).toFixed(0):'—'],
      ["churn (del/add)",t.la?(t.lr/t.la).toFixed(2):'—']]},
    {title:'Cost spread',stats:[
      ["median $/session",fmtMoney(st.dist.median)],
      ["p90 $/session",fmtMoney(st.dist.p90)],
      ["max $/session",fmtMoney(st.dist.max)]]}
  ]);
  // rate-limit utilization (5h / 7d) — forward-only, Claude.ai Pro/Max only
  el('sec-ratelimits').innerHTML=renderRateLimits(agg.sessions);
  // per-model weekly quotas + extra-usage credits (OAuth snapshot, opt-in)
  el('sec-model-quotas').innerHTML=renderModelQuotas(USAGE_LATEST);
  // rate-limit forecast at reset (EB model, OAuth snapshots + statusline fallback)
  el('sec-forecast').innerHTML=renderForecast(FORECAST);
  // token yield per rate-limit % (per-model deltas of the 5h/7d gauge)
  renderTY();
  // when you work
  el('sec-dayhour').innerHTML=dayhourHeatmap(agg.sessions);
  // sessions
  el('sec-scatter').innerHTML=svgScatter(agg.sessions,cmap);
  el('sec-pareto').innerHTML=svgPareto(st.pareto);
  el('sec-pareto-title').textContent="Pareto · top-10 sessions = "+Math.round(st.pareto.top10_pct)+"% of spend";
  el('sec-toptable').innerHTML=topTable(agg.sessions);
  // models
  el('sec-treemap').innerHTML=svgTreemap(agg.per_model,cmap);
  var modelSessions={},modelCost={};Object.keys(agg.per_model).forEach(function(m){modelSessions[m]=agg.per_model[m].sessions;modelCost[m]=agg.per_model[m].cost;});
  el('sec-model-sessions').innerHTML=barChart(modelSessions,'var(--ink-soft)',null,cmap);
  el('sec-model-cost').innerHTML=barChart(modelCost,'var(--ac)',function(v){return fmtMoney(v);},cmap);
  el('sec-share').innerHTML=shareBars(agg.months,cmap);
  // usage patterns
  var totTool=0;Object.keys(agg.usage.tools).forEach(function(k){totTool+=agg.usage.tools[k];});
  var errRate=totTool?(agg.usage.tool_errors/totTool*100):0;
  el('sec-usage-stats').innerHTML=colcards([
    {title:'Tool calls',stats:[["tool calls",fmtInt(totTool)],["tool errors",fmtInt(agg.usage.tool_errors)],["error rate",errRate.toFixed(1)+"%"]]},
    {title:'Context',stats:[["compactions",fmtInt(agg.usage.compactions)]]},
    {title:'Ecosystem',stats:[["subagent types",String(Object.keys(agg.usage.agents).length)],["skills used",String(Object.keys(agg.usage.skills).length)]]}
  ]);
  el('sec-tools').innerHTML=barChart(topn(agg.usage.tools),'var(--ink-soft)',function(v){return fmtInt(v);});
  el('sec-agents').innerHTML=barChart(topn(agg.usage.agents),'var(--azure)',function(v){return fmtInt(v);});
  el('sec-skills').innerHTML=barChart(topn(agg.usage.skills,20),'var(--ac)',function(v){return fmtInt(v);});
  // projects
  var projCost={},projSess={};Object.keys(agg.projects).forEach(function(k){var lbl=projLabel(k);projCost[lbl]=(projCost[lbl]||0)+agg.projects[k].cost;projSess[lbl]=(projSess[lbl]||0)+agg.projects[k].sessions;});
  el('sec-proj-cost').innerHTML=barChart(topn(projCost,15),'var(--ac)',function(v){return fmtMoney(v);});
  el('sec-proj-sess').innerHTML=barChart(topn(projSess,15),'var(--ink-soft)',function(v){return fmtInt(v);});
  countUpAll();
}

// ---- controls ----
function loadRange(){
  try{var r=JSON.parse(localStorage.getItem('claude-code-usage-report.range')||'null');if(r&&isDate(r.from)&&isDate(r.to)&&r.from<=r.to){r.preset=r.preset||null;return r;}}catch(e){}
  return {from:FIRST_DATE,to:LAST_DATE,preset:'all'};
}
function persistRange(r){try{localStorage.setItem('claude-code-usage-report.range',JSON.stringify(r));}catch(e){}}
function setActivePreset(id){document.querySelectorAll('.range-preset').forEach(function(b){b.className=b.dataset.p===id?'range-preset active':'range-preset';});}
function applyPreset(id){
  var from,to=LAST_DATE;
  if(id==='7d')from=addDays(LAST_DATE,-6);
  else if(id==='30d')from=addDays(LAST_DATE,-29);
  else from=FIRST_DATE;
  var range={from:from,to:to,preset:id};
  el('from').value=from;el('to').value=to;persistRange(range);setActivePreset(id);render(range);
}
function onDateChange(){
  var from=el('from').value,to=el('to').value;
  if(from&&to&&from>to){var tmp=from;from=to;to=tmp;el('from').value=from;el('to').value=to;}
  var range={from:from||FIRST_DATE,to:to||LAST_DATE,preset:null};
  persistRange(range);setActivePreset(null);render(range);
}
function initControls(range){
  var bar=el('rangeBar'),html='';
  CFG.PRESETS.forEach(function(p){html+="<button class='range-preset"+(p.id===range.preset?' active':'')+"' data-p='"+p.id+"'>"+p.label+"</button>";});
  bar.innerHTML=html;
  // date pickers live in their own (currently hidden) container; presets still drive them
  var dp=el('datePickers');
  if(dp)dp.innerHTML="<input type='date' id='from' min='"+FIRST_DATE+"' max='"+LAST_DATE+"' value='"+range.from+"'><span class='sep'>→</span><input type='date' id='to' min='"+FIRST_DATE+"' max='"+LAST_DATE+"' value='"+range.to+"'>";
  bar.querySelectorAll('.range-preset').forEach(function(b){b.onclick=function(){applyPreset(b.dataset.p);};});
  if(el('from'))el('from').onchange=onDateChange;
  if(el('to'))el('to').onchange=onDateChange;
}

// ---- model-filter (breakdown bars only) ----
var CHART={},ACTIVE=new Set();
function _vis(){return ACTIVE.size?ACTIVE:new Set(CHART.models);}
function _chart(target,data){
  var vis=_vis(),keys=Object.keys(data).sort().reverse(),totals={},mx=0;
  keys.forEach(function(k){var t=0;Object.keys(data[k]).forEach(function(m){if(vis.has(m))t+=data[k][m];});totals[k]=t;if(t>mx)mx=t;});
  mx=mx||1;var h='',any=false;
  keys.forEach(function(k){var t=totals[k];if(t<=0)return;any=true;var segs='';
    CHART.models.forEach(function(m){if(!vis.has(m))return;var c=data[k][m]||0;if(c<=0)return;segs+='<div class="seg" style="width:'+(c/mx*100).toFixed(4)+'%;background:'+CHART.colors[m]+'" data-tip="'+escAttr(m+' · '+fmtMoney(c))+'"></div>';});
    h+='<div class="bar-row"><div class="bar-label">'+esc(k)+'</div><div class="sbar-track">'+segs+'</div><div class="bar-val">'+fmtMoney(t)+'</div></div>';
  });
  target.innerHTML=any?h:'<p class="muted">No data for selected models.</p>';
}
function _legend(){
  var filtered=ACTIVE.size>0,target=el('model-filter');
  target.innerHTML=CHART.models.map(function(m){var off=filtered&&!ACTIVE.has(m)?' off':'';return '<button class="lg-item'+off+'" data-m="'+escAttr(m)+'"><span class="lg-swatch" style="background:'+CHART.colors[m]+'"></span>'+esc(m)+'</button>';}).join('')+'<button class="lg-all'+(filtered?'':' active')+'">all</button>';
  target.querySelectorAll('button[data-m]').forEach(function(b){b.onclick=function(){_toggle(b.dataset.m);};});
  target.querySelector('.lg-all').onclick=function(){ACTIVE=new Set();_draw();};
}
function _toggle(m){if(ACTIVE.has(m))ACTIVE.delete(m);else ACTIVE.add(m);_draw();}
function _tables(){if(!CUR_AGG)return;el('day-table').innerHTML=periodTable(CUR_AGG.days,'Date',ACTIVE);el('month-table').innerHTML=periodTable(CUR_AGG.months,'Month',ACTIVE);}
function _draw(){_legend();_chart(el('day-chart'),CHART.day);_chart(el('month-chart'),CHART.month);_tables();}

// ---- token-legend filter (token composition bars) ----
// SEMANTIC IS SOLO/DESELECT, NOT independent show/hide — confirmed correct, do NOT "fix":
//   empty TOK_ACTIVE = all series visible (default); click a pill = solo it (set adds key,
//   others get .off); click again = remove from set; emptied set or All = back to all-visible.
// Empty-means-all makes independent per-pill toggle impossible without extra base-state.
// tokVis MUST return Array.from(TOK_ACTIVE) (a Set crashes tokenBars on .indexOf).
var TOK_ACTIVE=new Set(),CUR_AGG=null;
function tokVis(){return TOK_ACTIVE.size?Array.from(TOK_ACTIVE):CFG.TOKEN.map(function(tk){return tk.key;});}
function renderTokLegend(){
  var filtered=TOK_ACTIVE.size>0,target=el('tok-legend');
  target.innerHTML=CFG.TOKEN.map(function(tk){var off=filtered&&!TOK_ACTIVE.has(tk.key)?' off':'';return '<button class="lg-item'+off+'" data-k="'+tk.key+'"><span class="lg-swatch" style="background:'+tk.col+'"></span>'+tk.name+'</button>';}).join('')+'<button class="lg-all'+(filtered?'':' active')+'">all</button>';
  target.querySelectorAll('button[data-k]').forEach(function(b){b.onclick=function(){_toggleTok(b.dataset.k);};});
  target.querySelector('.lg-all').onclick=function(){TOK_ACTIVE=new Set();renderTok();};
}
function _toggleTok(k){if(TOK_ACTIVE.has(k))TOK_ACTIVE.delete(k);else TOK_ACTIVE.add(k);renderTok();}
function renderTok(){
  renderTokLegend();
  if(!CUR_AGG)return;
  var vis=tokVis();
  el('tok-day-bars').innerHTML=tokenBars(CUR_AGG.days,vis);
  el('tok-month-bars').innerHTML=tokenBars(CUR_AGG.months,vis);
}

// ---- token yield per rate-limit % (5h/7d) ----
// "% usage" (r5/r7) is an account-global, CUMULATIVE gauge reading at session end
// — not per-model, not a per-session increment. So a raw tok/pct is wrong. Instead:
// walk rl-bearing sessions in global time order, take per-session gauge DELTAS
// (drop => window reset, delta = current pct), attribute each delta to that
// session's own model, then efficiency = Sum(tokens)/Sum(delta%) = Mtok per 1%.
// Aggregate ratio (not per-session) avoids divide-by-zero; skip when Sum(delta)<0.05.
function tokenYield(S,gk){
  // Claude models only: r5/r7 is the shared Claude account 5h/7d quota. Non-Claude models
  // (glm/ollama/etc.) don't draw from it — their gauge reading is just the ambient Claude
  // value, so their tokens/delta would be meaningless. Excluding them also keeps the delta
  // chain coherent: a Claude session after a non-Claude gap compares to the prior Claude reading.
  var rl=S.filter(function(s){return s[gk]>0&&/^claude/i.test(s.model||'');}).slice().sort(function(a,b){return a.ts<b.ts?-1:a.ts>b.ts?1:0;});
  var sumT={},sumD={},aggT={},aggD={},prev=null;
  rl.forEach(function(s){
    var pct=s[gk],d=(prev==null)?pct:(pct>=prev?pct-prev:pct);prev=pct;
    if(d<=0)return;
    var m=s.model,day=s.ts.slice(0,10);
    (sumT[m]=sumT[m]||{})[day]=(sumT[m][day]||0)+s.tok;
    (sumD[m]=sumD[m]||{})[day]=(sumD[m][day]||0)+d;
    aggT[m]=(aggT[m]||0)+s.tok;aggD[m]=(aggD[m]||0)+d;
  });
  var series={},agg={},models=[],dayset={};
  Object.keys(aggT).forEach(function(m){
    if(aggD[m]<0.05)return;
    series[m]={};var td=sumT[m],dd=sumD[m];
    Object.keys(td).forEach(function(day){if(dd[day]<0.05)return;series[m][day]={e:(td[day]/1e6)/dd[day],t:td[day],d:dd[day]};dayset[day]=1;});
    agg[m]={e:(aggT[m]/1e6)/aggD[m],t:aggT[m],d:aggD[m]};
    models.push(m);
  });
  models.sort();
  return {days:Object.keys(dayset).sort(),series:series,agg:agg,models:models};
}
function svgTokenYield(data,cmap,vis){
  var days=data.days,n=days.length;
  var models=data.models.filter(function(m){return vis.has(m);});
  if(!n||!models.length)return '<p class="muted">No data for selected models.</p>';
  var ymax=0;models.forEach(function(m){days.forEach(function(d){var c=data.series[m][d];if(c&&c.e>ymax)ymax=c.e;});});
  ymax=ymax||1;
  var W=1000,H=220,P=48,s=scaler(0,Math.max(n-1,1),0,ymax,W,H,P),fx=s[0],fy=s[1];
  var axes="<line class='axis' x1='"+P+"' y1='"+(H-P)+"' x2='"+(W-P)+"' y2='"+(H-P)+"'/>"+
           "<line class='axis' x1='"+P+"' y1='"+P+"' x2='"+P+"' y2='"+(H-P)+"'/>";
  var yticks=[0,0.5,1].map(function(f){var v=ymax*f;return "<text x='"+(P-6)+"' y='"+(fy(v)+4).toFixed(1)+"' text-anchor='end' fill='var(--ink-faint)'>"+v.toFixed(2)+"</text>";}).join('');
  var MAXLBL=12,stride=Math.max(1,Math.ceil(n/MAXLBL)),xlabels='';
  for(var i=0;i<n;i+=stride){if(i===n-1)continue;xlabels+="<text x='"+fx(i).toFixed(1)+"' y='"+(H-P+16)+"' text-anchor='"+(i===0?'start':'middle')+"' fill='var(--ink-faint)'>"+esc(days[i].slice(5,10))+"</text>";}
  xlabels+="<text x='"+fx(n-1).toFixed(1)+"' y='"+(H-P+16)+"' text-anchor='"+(n>1?'end':'start')+"' fill='var(--ink-faint)'>"+esc(days[n-1].slice(5,10))+"</text>";
  xlabels+="<text x='"+(W-P)+"' y='"+(P-10)+"' text-anchor='end' fill='var(--ink-faint)'>Mtok / 1% ↑</text>";
  var lines='',dots='';
  models.forEach(function(m){
    var col=cmap[m]||'var(--ink-faint)',run=[];
    function flush(){if(run.length>=2)lines+=pathD(run.map(function(p){return [fx(p.i),fy(p.e)];}),col,false,'none',2);run=[];}
    days.forEach(function(d,i){var c=data.series[m][d];if(c&&c.e!=null){run.push({i:i,e:c.e});var tip=esc(m+' · '+d+' · '+c.e.toFixed(2)+' Mtok/1% ('+fmtAbbr(c.t)+' tok / '+c.d.toFixed(1)+'%)');dots+="<circle cx='"+fx(i).toFixed(1)+"' cy='"+fy(c.e).toFixed(1)+"' r='3' fill='"+col+"' opacity='0.9'><title>"+tip+"</title></circle>";}else{flush();}});
    flush();
  });
  return svgWrap(W,H,axes+yticks+xlabels+lines+dots,'chart');
}
var TY_ACTIVE=new Set(),TY_GAUGE='7d';
function tyVisSet(data){return TY_ACTIVE.size?TY_ACTIVE:new Set(data.models);}
function renderTYLegend(data){
  var filtered=TY_ACTIVE.size>0,target=el('ty-legend');if(!target)return;
  target.innerHTML=data.models.map(function(m){var off=filtered&&!TY_ACTIVE.has(m)?' off':'';var col=(CHART.colors&&CHART.colors[m])||'var(--ink-faint)';return '<button class="lg-item'+off+'" data-m="'+escAttr(m)+'"><span class="lg-swatch" style="background:'+col+'"></span>'+esc(m)+'</button>';}).join('')+'<button class="lg-all'+(filtered?'':' active')+'">all</button>';
  target.querySelectorAll('button[data-m]').forEach(function(b){b.onclick=function(){_toggleTY(b.dataset.m);};});
  target.querySelector('.lg-all').onclick=function(){TY_ACTIVE=new Set();renderTY();};
}
function _toggleTY(m){if(TY_ACTIVE.has(m))TY_ACTIVE.delete(m);else TY_ACTIVE.add(m);renderTY();}
function showTY(v){TY_GAUGE=v;var b7=el('tybtn-7d'),b5=el('tybtn-5h');if(b7)b7.className=v==='7d'?'active':'';if(b5)b5.className=v==='5h'?'active':'';renderTY();}
function renderTY(){
  if(!CUR_AGG)return;
  var gk=TY_GAUGE==='5h'?'r5':'r7',data=tokenYield(CUR_AGG.sessions,gk),lg=el('ty-legend');
  if(!data.models.length){
    if(lg)lg.innerHTML='';
    el('sec-token-yield').innerHTML="<div class='empty-state'><svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='9'/><path d='M12 8h.01M11 12h1v4h1'/></svg><h4>No rate-limit data in range.</h4><p>Token yield needs Claude sessions carrying "+esc(TY_GAUGE)+" rate-limit % (forward-only, Claude.ai Pro/Max only). Non-Claude models draw separate quotas and are excluded.</p></div>";
    el('sec-token-yield-summary').innerHTML='';return;
  }
  renderTYLegend(data);
  var vis=tyVisSet(data),cmap=(CHART&&CHART.colors)||{};
  el('sec-token-yield').innerHTML=svgTokenYield(data,cmap,vis)+"<p class='muted' style='margin-top:6px'>Mtok consumed per 1% of the "+esc(TY_GAUGE)+" window burned — per-session gauge deltas, reset-aware. Claude models only — they share the account 5h/7d quota, so lines compare each model's token density per quota point (higher = more tokens per 1%). Non-Claude models (separate quotas) are excluded; non-Pro/pre-statusline sessions carry no gauge.</p>";
  var order=data.models.slice().sort(function(a,b){return data.agg[b].e-data.agg[a].e;}),map={};
  order.forEach(function(m){map[m]=data.agg[m].e;});
  el('sec-token-yield-summary').innerHTML="<div class='subhead' style='margin-top:10px'>Overall Mtok per 1% ("+esc(TY_GAUGE)+")</div>"+barChart(map,'var(--ac)',function(v){return v.toFixed(2)+' Mtok/%';},cmap);
}

// ---- view + theme toggles ----
function show(v){
  el('day-view').style.display=v==='day'?'':'none';
  el('month-view').style.display=v==='month'?'':'none';
  el('btn-day').className=v==='day'?'active':'';
  el('btn-month').className=v==='month'?'active':'';
  try{localStorage['claude-code-usage-report.view']=v;}catch(e){}
}
function showTok(v){
  el('tok-day').style.display=v==='day'?'':'none';
  el('tok-month').style.display=v==='month'?'':'none';
  el('tbtn-day').className=v==='day'?'active':'';
  el('tbtn-month').className=v==='month'?'active':'';
}
var __sunPaths='<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/>';
var __moonPaths='<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>';
function __lbl(t){var i=document.getElementById('thI');if(i)i.innerHTML=t==='dark'?__sunPaths:__moonPaths;}
function __tgl(){var d=document.documentElement,n=d.dataset.theme==='dark'?'light':'dark';d.dataset.theme=n;try{localStorage.setItem('agents-report-theme',n);}catch(e){}__lbl(n);if(window.updateGlow)window.updateGlow();}

// ---- roadmap filter (hide already-available features) ----
function initRoadmapFilter(){
  var btn=el('road-filter'),grid=el('road-sgs');if(!btn||!grid)return;
  // default state: available cards hidden, button outlined + "Show available"
  btn.onclick=function(){
    var hidden=grid.classList.toggle('hide-avail');
    btn.textContent=hidden?'Show available':'Hide available';
    btn.classList.toggle('active',!hidden);  // filled only while everything is shown
    btn.setAttribute('aria-pressed',hidden?'true':'false');
  };
}

// ---- main ----
var FIRST_DATE,LAST_DATE;
function main(){
  var ds=SESSIONS.map(function(s){return s.ts.slice(0,10);}).filter(isDate).sort();
  FIRST_DATE=ds[0];LAST_DATE=ds[ds.length-1];
  var range=loadRange();
  initControls(range);
  render(range);
  initRoadmapFilter();
  __lbl(document.documentElement.dataset.theme);
  try{if(localStorage['claude-code-usage-report.view']==='month')show('month');}catch(e){}
}
document.addEventListener('DOMContentLoaded',main);
