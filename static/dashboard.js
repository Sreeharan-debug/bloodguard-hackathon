'use strict';

// ── Config ────────────────────────────────────────────────────────────────────
const POLL_STATUS = 1500;
const POLL_HIST   = 2500;
const POLL_EVENTS = 3000;
const POLL_INV    = 10000;
const HIST_PTS    = 60;

// ── State ─────────────────────────────────────────────────────────────────────
let curSec       = 'home';
let evFilter     = 'ALL';
let homeFlt      = 'ALL';
let invFlt       = 'ALL';
let allEvents    = [];
let allUnits     = [];
let histData     = [];
let anReady      = false;
const charts     = {};

// ── Utils ─────────────────────────────────────────────────────────────────────
const $   = id => document.getElementById(id);
const set = (id, v) => { const el=$(id); if(el) el.textContent = v??'—'; };
const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const clamp = (v,a,b) => Math.min(Math.max(v,a),b);
const parse = v => (v===null||v===undefined||v==='--') ? null : (isNaN(Number(v)) ? null : Number(v));

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date((iso.endsWith('Z')?iso:iso+'Z')).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
}
function fmtRelative(iso) {
  if (!iso) return '—';
  const sec = Math.floor((Date.now() - new Date((iso.endsWith('Z')?iso:iso+'Z')).getTime())/1000);
  if (isNaN(sec)||sec<0) return 'just now';
  if (sec<60)    return `${sec}s ago`;
  if (sec<3600)  return `${Math.floor(sec/60)}m ago`;
  if (sec<86400) return `${Math.floor(sec/3600)}h ago`;
  return new Date((iso.endsWith('Z')?iso:iso+'Z')).toLocaleDateString();
}
function daysUntil(d) {
  const t=new Date(); t.setHours(0,0,0,0);
  return Math.ceil((new Date(d)-t)/86400000);
}

// ── Date badge ────────────────────────────────────────────────────────────────
setInterval(() => {
  const el=$('tb-date'); if(!el)return;
  el.textContent = new Date().toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'});
}, 1000);
// set immediately
(()=>{ const el=$('tb-date'); if(el) el.textContent=new Date().toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'}); })();

// Set user avatar
(()=>{ const av=$('sb-av'); if(av&&typeof STAFF_USER!=='undefined') av.textContent=STAFF_USER[0].toUpperCase(); })();

// ── Navigation ────────────────────────────────────────────────────────────────
const pageTitles = { home:'Home', analytics:'Analytics', inventory:'Inventory', events:'Events', add:'Add Unit', staff:'Staff Control' };
let invChamberState = 'ALL';

function goSec(el) {
  const name = el.dataset?.sec || el.getAttribute('data-sec');
  if (!name || name === curSec) return false;
  curSec = name;

  document.querySelectorAll('.sec').forEach(s=>s.classList.remove('active'));
  const sec=document.getElementById('sec-'+name); if(sec)sec.classList.add('active');
  document.querySelectorAll('.sb-item').forEach(n=>n.classList.remove('active'));
  el.classList.add('active');
  set('tb-page', pageTitles[name]||name);

  if (name==='analytics') { renderAnalytics(); anReady=true; }
  if (name==='inventory') { renderInventory(); renderChamberCharts(); }
  if (name==='events')    renderEvents();
  if (name==='home')      renderHomeTable();
  if (name==='staff')     { loadStaffLog(); }
  return false;
}

// ── Alert ─────────────────────────────────────────────────────────────────────
function clearAlert() {
  fetch('/api/alert/clear',{method:'POST'}).catch(()=>{});
  $('alert-banner')?.classList.add('hidden');
}

// ── Chart.js defaults (white theme) ──────────────────────────────────────────
Chart.defaults.color         = '#9CA3AF';
Chart.defaults.borderColor   = '#F3F4F6';
Chart.defaults.font.family   = "'Inter', sans-serif";
Chart.defaults.font.size     = 11;

// ── Sparkline builder ─────────────────────────────────────────────────────────
function buildSparkline(canvasId, data, color) {
  const ctx=$(canvasId)?.getContext('2d'); if(!ctx) return null;
  // gradient fill
  const grad=ctx.createLinearGradient(0,0,0,56);
  grad.addColorStop(0, color+'33');
  grad.addColorStop(1, color+'00');
  return new Chart(ctx,{
    type:'line',
    data:{ labels:data.map((_,i)=>i), datasets:[{ data, borderColor:color, backgroundColor:grad, fill:true, tension:0.1, pointRadius:0, borderWidth:1.5 }] },
    options:{ responsive:true, animation:false, plugins:{legend:{display:false},tooltip:{enabled:false}},
      scales:{ x:{display:false}, y:{display:false} } }
  });
}
function updateSparkline(chart, data) {
  if(!chart)return;
  chart.data.labels=data.map((_,i)=>i);
  chart.data.datasets[0].data=data;
  chart.update('none');
}

// ── Line chart builder ────────────────────────────────────────────────────────
function buildLine(cid, labels, data, label, color, refLines) {
  const ctx=$(cid)?.getContext('2d'); if(!ctx) return null;
  const grad=ctx.createLinearGradient(0,0,0,220);
  grad.addColorStop(0, color+'30'); grad.addColorStop(1, color+'05');
  return new Chart(ctx,{
    type:'line',
    data:{ labels, datasets:[{ label, data, borderColor:color, backgroundColor:grad, fill:true, tension:0.1, pointRadius:0, pointHoverRadius:4, borderWidth:1.8 }] },
    options:{
      responsive:true, animation:{duration:400},
      plugins:{ legend:{display:false}, tooltip:{ mode:'index', intersect:false,
        backgroundColor:'#fff', borderColor:'#E5E7EB', borderWidth:1,
        titleColor:'#374151', bodyColor:'#111827', padding:10,
        callbacks:{ label: ctx=>`  ${ctx.dataset.label}: ${ctx.formattedValue}` } } },
      scales:{
        x:{ grid:{color:'#F3F4F6'}, ticks:{maxTicksLimit:8, color:'#9CA3AF'} },
        y:{ grid:{color:'#F3F4F6'}, ticks:{maxTicksLimit:5, color:'#9CA3AF'} }
      }
    }
  });
}
function updateChart(chart, labels, data) {
  if(!chart)return;
  chart.data.labels=labels; chart.data.datasets[0].data=data; chart.update('none');
}

// ── Bar chart builder ─────────────────────────────────────────────────────────
function buildBar(cid, labels, datasets) {
  const ctx=$(cid)?.getContext('2d'); if(!ctx) return null;
  return new Chart(ctx,{
    type:'bar',
    data:{ labels, datasets },
    options:{
      responsive:true, animation:{duration:400},
      plugins:{ legend:{ position:'bottom', labels:{ padding:16, color:'#6B7280', boxWidth:12, boxHeight:12 } },
        tooltip:{ backgroundColor:'#fff', borderColor:'#E5E7EB', borderWidth:1, titleColor:'#374151', bodyColor:'#111827', padding:10 } },
      scales:{
        x:{ grid:{display:false}, ticks:{color:'#9CA3AF'} },
        y:{ grid:{color:'#F3F4F6'}, ticks:{color:'#9CA3AF', maxTicksLimit:5} }
      }
    }
  });
}

// ── Doughnut builder ──────────────────────────────────────────────────────────
function buildDonut(cid, labels, data, colors) {
  const ctx=$(cid)?.getContext('2d'); if(!ctx) return null;
  return new Chart(ctx,{
    type:'doughnut',
    data:{ labels, datasets:[{ data, backgroundColor:colors, borderColor:'#fff', borderWidth:3 }] },
    options:{ responsive:true,
      plugins:{ legend:{position:'bottom',labels:{padding:16,color:'#6B7280',boxWidth:12,boxHeight:12}},
        tooltip:{backgroundColor:'#fff',borderColor:'#E5E7EB',borderWidth:1,titleColor:'#374151',bodyColor:'#111827',padding:10} } }
  });
}

// ── Sparkline history arrays ────────────────────────────────────────────
const sparkHistory = { temp:[], gas:[], light:[], dist:[] };
const MAX_SPARK = 30;

// ── Sensor tile updater ───────────────────────────────────────────────────────
const barColors = { ok:'#22C55E', warn:'#F59E0B', err:'#EF4444' };
function updateSensorTile(tileId, barId, statusId, rawVal, displayVal, pct, statusText, statusClass) {
  // Tile border color
  const tile = $(tileId);
  if (tile) { tile.className = 'sensor-tile' + (statusClass?' '+statusClass:''); }
  // Value display (find .st-val inside tile)
  const valEl = tile?.querySelector('.st-val');
  if (valEl) valEl.textContent = displayVal;
  // Bar
  const bar = $(barId);
  if (bar) {
    bar.style.width  = (pct??0)+'%';
    bar.style.background = barColors[statusClass]||'#D1D5DB';
  }
  // Status badge
  const st = $(statusId);
  if (st) {
    st.textContent  = statusText||'—';
    st.className    = 'st-status'+(statusClass?' '+statusClass:'');
  }
}

// ── STATUS polling ────────────────────────────────────────────────────────────
async function pollStatus() {
  try {
    const [st, stats, chStatus] = await Promise.all([
      fetch('/api/status').then(r=>r.ok?r.json():null),
      fetch('/api/stats').then(r=>r.ok?r.json():null),
      fetch('/api/chambers/status').then(r=>r.ok?r.json():null),
    ]);
    if(st)       applyStatus(st);
    if(stats)    applyStats(stats);
    if(chStatus) applyChamberStatus(chStatus);
  } catch(e) { setConn(false); }
}

function applyStatus(s) {
  setConn(!!s.connected);
  const temp  = parse(s.temperature);
  const gas   = parse(s.gas);
  const light = parse(s.light);
  const dist  = parse(s.distance);
  const armed = !!s.armed;
  const doorOpen = light!==null && light>200;

  // ── Sensor strip tiles ─────────────────────────────────────
  updateSensorTile('st-temp','stb-temp','sts-temp',
    temp, temp!==null?temp.toFixed(2):'—',
    temp===null?null:clamp(temp/12*100,2,100),
    temp===null?'':'2–8°C safe range',
    temp===null?null:(temp>=2&&temp<=8?'ok':temp>10||temp<0?'err':'warn'));

  updateSensorTile('st-gas','stb-gas','sts-gas',
    gas, gas!==null?String(gas):'—',
    gas===null?null:clamp(gas/1023*100,2,100),
    gas===null?'':gas<400?'Clean air':'Elevated',
    gas===null?null:gas<400?'ok':gas<700?'warn':'err');

  updateSensorTile('st-dist','stb-dist','sts-dist',
    dist, dist!==null?String(dist):'—',
    dist===null?null:clamp(dist/40*100,2,100),
    dist===null?'':Math.abs((dist||0)-15)<=5?'In position':'Displaced',
    dist===null?null:Math.abs((dist||0)-15)<=5?'ok':'warn');

  updateSensorTile('st-light','stb-light','sts-light',
    light, light!==null?String(light):'—',
    light===null?null:clamp(light/1023*100,2,100),
    light===null?'':light<200?'Dark / Closed':light<400?'Dim':'Bright / Open',
    light===null?null:light<200?'ok':light<400?'warn':'err');

  // KPI cards
  set('sc-temp-val', temp!==null ? temp.toFixed(1)+' °C' : '—');
  const tempOk = temp!==null && temp>=2 && temp<=8;
  setScBadge('sc-temp-badge', temp===null?null:tempOk?'+OK':'-ALERT', tempOk?'':'red');

  // Door + arm
  const doorIc  = $('cta-door-ic'); if(doorIc)  doorIc.textContent  = doorOpen?'🚨':'🔒';
  const doorLbl = $('cta-door-lbl'); if(doorLbl) doorLbl.textContent = doorOpen?'Door Open!':'Door Secured';

  // Topbar lock chip
  const lc=$('lock-chip');
  set('lock-chip-ic',  armed?'🔒':'🔓');
  set('lock-chip-lbl', armed?'Armed':'Disarmed');
  if(lc) lc.className='lock-chip'+(armed?' armed':'');

  // Main chart big value
  set('cc-temp-now', temp!==null?temp.toFixed(2)+' °C':'—');
  const ccBadge=$('cc-temp-status');
  if(ccBadge){ ccBadge.textContent=tempOk?'NORMAL':'ALERT'; ccBadge.className='cc-badge'+(tempOk?' ok':' err'); }

  set('cc-gas-now', gas!==null?String(gas):'—');
  const gasOk=gas!==null&&gas<400;
  const ggBadge=$('cc-gas-status');
  if(ggBadge){ ggBadge.textContent=gasOk?'CLEAN':'ELEVATED'; ggBadge.className='cc-badge'+(gasOk?' ok':' err'); }

  // Sparkline history
  if(temp!==null)  { sparkHistory.temp.push(temp);  if(sparkHistory.temp.length>MAX_SPARK)  sparkHistory.temp.shift();  }
  if(gas!==null)   { sparkHistory.gas.push(gas);    if(sparkHistory.gas.length>MAX_SPARK)   sparkHistory.gas.shift();   }
  if(light!==null) { sparkHistory.light.push(light); if(sparkHistory.light.length>MAX_SPARK) sparkHistory.light.shift(); }
  if(dist!==null)  { sparkHistory.dist.push(dist);  if(sparkHistory.dist.length>MAX_SPARK)  sparkHistory.dist.shift();  }

  // KPI card sparklines
  updateOrBuildSparkline('spark-temp',  sparkHistory.temp,  '#1E88E5');
  updateOrBuildSparkline('spark-units', Array(sparkHistory.temp.length).fill(allUnits.filter(u=>u.status==='STORED').length), '#22C55E');
  updateOrBuildSparkline('spark-tamper',sparkHistory.gas.map(g=>g>300?1:0), '#EF4444');

  // Sensor tile sparklines
  updateOrBuildSparkline('stk-temp',  sparkHistory.temp,  '#1E88E5');
  updateOrBuildSparkline('stk-gas',   sparkHistory.gas,   '#F59E0B');
  updateOrBuildSparkline('stk-dist',  sparkHistory.dist,  '#8B5CF6');
  updateOrBuildSparkline('stk-light', sparkHistory.light, '#EC4899');

  // Alert
  if(s.alert_active) $('alert-banner')?.classList.remove('hidden');
  else               $('alert-banner')?.classList.add('hidden');

  // Gas+light bar chart update
  if(charts['gas-bar'] && histData.length>0) {
    const last30 = histData.slice(-30);
    const lbs = last30.map(d=>fmtTime(d.ts));
    charts['gas-bar'].data.labels = lbs;
    charts['gas-bar'].data.datasets[0].data = last30.map(d=>d.gas);
    charts['gas-bar'].data.datasets[1].data = last30.map(d=>d.light);
    charts['gas-bar'].update('none');
  }

  set('last-upd', s.last_update?fmtRelative(s.last_update):'—');
}

function setScBadge(id, text, extraClass) {
  const el=$(id); if(!el)return;
  if(text===null){ el.textContent=''; return; }
  el.textContent=text;
  el.className='sc-badge'+(extraClass?' '+extraClass:'');
}

function updateOrBuildSparkline(id, data, color) {
  if(charts[id]) updateSparkline(charts[id], data);
  else if(data.length>1) charts[id]=buildSparkline(id, data, color);
}

function applyStats(s) {
  set('sc-units-val',  s.stored_units);
  set('sc-exp-val',    s.expiring_soon);
  set('sc-tamper-val', s.tampers_24h);
  set('sb-ev-badge',   s.tampers_24h||0);

  const expN = s.expiring_soon||0;
  setScBadge('sc-units-badge',  '+'+s.stored_units+'%', 'green');
  setScBadge('sc-exp-badge',    expN>0?`+${expN} units`:'+0 units', expN>0?'amber':'green');
  setScBadge('sc-tamper-badge', s.tampers_24h>0?'!HIGH':'+CLEAR', s.tampers_24h>0?'red':'green');

  // Update expiry card
  const msg=$('sb-expiry-msg');
  if(msg) msg.textContent = expN>0 ? `${expN} unit${expN>1?'s':''} expiring in ≤7 days.` : 'All units have ≥7 days remaining.';

  // Expiring sparkline (flat value)
  updateOrBuildSparkline('spark-exp', Array(MAX_SPARK).fill(expN), '#F59E0B');
}

function setConn(ok) {
  const dot=$('cta-conn-dot'); const lbl=$('cta-conn-lbl');
  if(dot) dot.className='cta-dot'+(ok?' ok':'');
  if(lbl) lbl.textContent=ok?'Hardware connected':'Disconnected';
}

// ── HISTORY ───────────────────────────────────────────────────────────────────
async function pollHistory() {
  try {
    const data = await fetch(`/api/history?points=${HIST_PTS}`).then(r=>r.ok?r.json():null);
    if(!data||!data.length) return;
    histData = data;
    const labels = data.map(d=>fmtTime(d.ts));
    const temps  = data.map(d=>d.temperature);
    const gases  = data.map(d=>d.gas);
    const lights = data.map(d=>d.light);

    // Main area chart — temperature
    if(!charts['temp-area']) {
      charts['temp-area'] = buildLine('chart-temp-area', labels, temps, '°C', '#1E88E5', [2,8]);
    } else {
      updateChart(charts['temp-area'], labels, temps);
    }

    // Gas bar chart
    const last30 = data.slice(-30);
    const lb30   = last30.map(d=>fmtTime(d.ts));
    if(!charts['gas-bar']) {
      charts['gas-bar'] = buildBar('chart-gas-bar', lb30, [
        { label:'Gas (ADC)', data:last30.map(d=>d.gas),   backgroundColor:'#BFDBFE', borderColor:'#1E88E5', borderWidth:1 },
        { label:'Light (ADC)', data:last30.map(d=>d.light), backgroundColor:'#FDE68A', borderColor:'#F59E0B', borderWidth:1 },
      ]);
    } else {
      updateChart(charts['gas-bar'], lb30, last30.map(d=>d.gas));
    }

    // Analytics charts (update if ready)
    if(anReady) {
      updateChart(charts['an-temp'],  labels, temps);
      updateChart(charts['an-gas'],   labels, gases);
      updateChart(charts['an-dist'],  labels, histData.map(d=>d.distance??null));
      updateChart(charts['an-light'], labels, lights);
      // refresh stat pills & stats table
      renderAnalytics();
    }

    // Chamber mini-charts (inventory tab)
    renderChamberCharts();
  } catch(e) {}
}

// ── Analytics ─────────────────────────────────────────────────────────────────
async function renderAnalytics() {
  const labels = histData.map(d=>fmtTime(d.ts));
  const temps  = histData.map(d=>d.temperature);
  const gases  = histData.map(d=>d.gas);
  const lights = histData.map(d=>d.light);
  const dists  = histData.map(d=>d.distance ?? null);

  // Stat pills — use latest data point
  const latest = histData[histData.length-1];
  if (latest) {
    const lTemp = parse(latest.temperature);
    const lGas  = parse(latest.gas);
    const lDist = parse(latest.distance);
    const lLit  = parse(latest.light);

    set('anp-temp-val', lTemp!==null?lTemp.toFixed(1):'—');
    setAnpBadge('anp-temp-badge', lTemp===null?null:(lTemp>=2&&lTemp<=8?'ok':lTemp>10||lTemp<0?'err':'warn'),
      lTemp===null?'—':(lTemp>=2&&lTemp<=8?'SAFE':'ALERT'));

    set('anp-gas-val', lGas!==null?String(lGas):'—');
    setAnpBadge('anp-gas-badge', lGas===null?null:lGas<400?'ok':lGas<700?'warn':'err',
      lGas===null?'—':lGas<400?'CLEAN':'HIGH');

    set('anp-dist-val', lDist!==null?String(lDist):'—');
    setAnpBadge('anp-dist-badge', lDist===null?null:Math.abs((lDist||0)-15)<=5?'ok':'warn',
      lDist===null?'—':Math.abs((lDist||0)-15)<=5?'OK':'CHECK');

    set('anp-light-val', lLit!==null?String(lLit):'—');
    setAnpBadge('anp-light-badge', lLit===null?null:lLit<200?'ok':lLit<400?'warn':'err',
      lLit===null?'—':lLit<200?'CLOSED':'OPEN');

    set('anp-samples', String(histData.length));
  }

  // Build or update 4 sensor charts
  if(!charts['an-temp'])  charts['an-temp']  = buildLine('an-temp',  labels, temps,  '°C',     '#1E88E5');
  else                    updateChart(charts['an-temp'],  labels, temps);

  if(!charts['an-gas'])   charts['an-gas']   = buildLine('an-gas',   labels, gases,  'Gas ADC', '#F59E0B');
  else                    updateChart(charts['an-gas'],   labels, gases);

  if(!charts['an-dist'])  charts['an-dist']  = buildLine('an-dist',  labels, dists,  'cm',      '#8B5CF6');
  else                    updateChart(charts['an-dist'],  labels, dists);

  if(!charts['an-light']) charts['an-light'] = buildLine('an-light', labels, lights, 'ADC',     '#EC4899');
  else                    updateChart(charts['an-light'], labels, lights);

  // Event donut
  if(!charts['an-donut']) {
    try {
      const evs = await fetch('/api/logs?limit=500').then(r=>r.json());
      const cnt = {TAMPER:0,ACCESS:0,SYSTEM:0,ENV:0};
      evs.forEach(e=>{ const t=e.event_type||'TAMPER'; if(cnt[t]!==undefined)cnt[t]++; });
      charts['an-donut'] = buildDonut('an-donut',
        ['Tamper','Access','System','Environment'],
        [cnt.TAMPER,cnt.ACCESS,cnt.SYSTEM,cnt.ENV],
        ['#EF4444','#22C55E','#1E88E5','#F59E0B']);
    } catch(e){}
  }

  // Stats table: min/max/avg per sensor
  const safeArr = arr => arr.filter(v=>v!==null&&v!==undefined&&!isNaN(v));
  function stat(arr) {
    const a=safeArr(arr); if(!a.length) return {min:'—',max:'—',avg:'—'};
    const mn=Math.min(...a), mx=Math.max(...a), av=a.reduce((s,v)=>s+v,0)/a.length;
    return { min:mn.toFixed(1), max:mx.toFixed(1), avg:av.toFixed(1) };
  }
  const ts=stat(temps), gs=stat(gases), ds=stat(dists), ls=stat(lights);
  const tbody=$('an-stats-tbody');
  if(tbody){
    const row=(label,s,badge,cls)=>`<tr>
      <td>${label}</td>
      <td>${s.min}</td><td>${s.max}</td><td style="font-weight:700">${s.avg}</td>
      <td><span class="st-status ${cls}">${badge}</span></td>
    </tr>`;
    const tOk=parse(latest?.temperature); const tCls=tOk===null?'':tOk>=2&&tOk<=8?'ok':tOk>10?'err':'warn';
    const gOk=parse(latest?.gas);         const gCls=gOk===null?'':gOk<400?'ok':gOk<700?'warn':'err';
    tbody.innerHTML=
      row('🌡️ Temperature (°C)', ts, tCls==='ok'?'NORMAL':'CHECK', tCls)+
      row('💨 Gas / Air (ADC)',   gs, gCls==='ok'?'CLEAN':'ELEVATED', gCls)+
      row('📏 Distance (cm)',     ds, 'POSITION', 'ok')+
      row('💡 Light (ADC)',       ls, ls.avg>200?'OPEN':'CLOSED', Number(ls.avg)>200?'warn':'ok');
  }
}

function setAnpBadge(id, cls, text) {
  const el=$(id); if(!el)return;
  el.textContent=text||'—';
  el.className='anp-badge'+(cls?' '+cls:'');
}



// ── Events ────────────────────────────────────────────────────────────────────
async function pollEvents() {
  try {
    allEvents = await fetch('/api/logs?limit=200').then(r=>r.ok?r.json():[]);
    if(curSec==='events') renderEvents();
  } catch(e){}
}

function setEvFlt(f, el) {
  evFilter=f;
  document.querySelectorAll('[data-ef]').forEach(c=>c.classList.remove('active'));
  if(el) el.classList.add('active');
  renderEvents();
}

function renderEvents() {
  const tbody=$('ev-tbody'); const cnt=$('ev-count'); if(!tbody)return;
  const filtered=allEvents.filter(e=>evFilter==='ALL'||e.event_type===evFilter);
  if(cnt) cnt.textContent=`${filtered.length} event${filtered.length!==1?'s':''}`;
  if(!filtered.length){tbody.innerHTML='<tr><td colspan="6" class="td-empty">No events.</td></tr>';return;}
  tbody.innerHTML=filtered.map(ev=>{
    const t=ev.event_type||'TAMPER';
    const sc=ev.score>0?`<span style="font-weight:700;color:#374151">${ev.score}</span>`:'—';
    return `<tr>
      <td style="font-size:11px;color:#6B7280">${fmtTime(ev.ts)}</td>
      <td style="font-size:11px;font-family:monospace">${esc(ev.source)}</td>
      <td style="font-weight:500">${esc(ev.detail)}</td>
      <td><span class="et et-${t}">${t}</span></td>
      <td>${sc}</td>
      <td style="font-size:11px;color:#9CA3AF">${fmtRelative(ev.ts)}</td>
    </tr>`;
  }).join('');
}

// ── Inventory ─────────────────────────────────────────────────────────────────
async function pollInventory() {
  try {
    allUnits = await fetch('/api/units').then(r=>r.ok?r.json():[]);
    if(curSec==='inventory') renderInventory();
    if(curSec==='home')      renderHomeTable();
  } catch(e){}
}

let invFltState = 'ALL';
function setInvFlt(f, el) {
  invFltState=f;
  invChamberState='ALL';
  document.querySelectorAll('#sec-inventory .flt').forEach(c=>c.classList.remove('active'));
  if(el) el.classList.add('active');
  renderInventory();
}

function setInvCh(ch, el) {
  invChamberState=ch;
  invFltState='ALL';
  document.querySelectorAll('#sec-inventory .flt').forEach(c=>c.classList.remove('active'));
  if(el) el.classList.add('active');
  renderInventory();
}

function renderInventory() {
  const tbody=$('inv-tbody'); if(!tbody)return;
  const q=($('inv-search')?.value||'').toLowerCase();
  let rows=allUnits;
  if(invFltState!=='ALL') rows=rows.filter(u=>u.status===invFltState);
  if(invChamberState!=='ALL') rows=rows.filter(u=>u.location===invChamberState);
  if(q) rows=rows.filter(u=>(u.unit_id+u.blood_type+u.donor_name+(u.recipient_name||'')).toLowerCase().includes(q));
  if(!rows.length){tbody.innerHTML='<tr><td colspan="10" class="td-empty">No units found.</td></tr>';return;}
  tbody.innerHTML=rows.map(u=>{
    const d=daysUntil(u.expiry_date);
    const exCls=d<=3?'exp-crit':d<=7?'exp-warn':'';
    const exTxt=d<0?'⛔ Expired':d===0?'❗ Today':`${d}d`;
    const rec=u.recipient_name?esc(u.recipient_name):`<span style="color:#D1D5DB">—</span>`;
    return `<tr>
      <td><strong style="font-family:monospace;font-size:11px">${esc(u.unit_id)}</strong></td>
      <td><span class="bt">${esc(u.blood_type)}</span></td>
      <td>${esc(u.donor_name)}</td>
      <td style="font-size:11px;color:#6B7280">${esc(u.donor_id||'—')}</td>
      <td style="font-size:11px">${esc(u.collection_date)}</td>
      <td class="${exCls}" style="font-size:11px">${exTxt}</td>
      <td>${rec}</td>
      <td><span class="sp sp-${u.status}">${esc(u.status)}</span></td>
      <td style="font-size:11px">${esc(u.location)}</td>
      <td><button class="qr-btn" onclick="showQR('${esc(u.unit_id)}','${esc(u.blood_type+' · '+u.donor_name)}')">QR</button></td>
    </tr>`;
  }).join('');
}

// ── Home table ────────────────────────────────────────────────────────────────
let homeFltState = 'ALL';
function setHomeFlt(f, el) {
  homeFltState=f;
  document.querySelectorAll('#sec-home .flt').forEach(c=>c.classList.remove('active'));
  if(el) el.classList.add('active');
  renderHomeTable();
}

function renderHomeTable() {
  const tbody=$('home-tbody'); if(!tbody)return;
  const q=($('home-search')?.value||'').toLowerCase();
  let rows=allUnits;
  if(homeFltState!=='ALL') rows=rows.filter(u=>u.status===homeFltState);
  if(q) rows=rows.filter(u=>(u.unit_id+u.blood_type+u.donor_name+(u.recipient_name||'')).toLowerCase().includes(q));
  if(!rows.length){tbody.innerHTML='<tr><td colspan="9" class="td-empty">No units found.</td></tr>';return;}
  tbody.innerHTML=rows.map(u=>{
    const d=daysUntil(u.expiry_date);
    const exCls=d<=3?'exp-crit':d<=7?'exp-warn':'';
    const exTxt=d<0?'⛔ Expired':d===0?'❗ Today':`${d}d`;
    const rec=u.recipient_name?esc(u.recipient_name):`<span style="color:#D1D5DB">—</span>`;
    // mini bar for "Daily Readings" column
    const pct = clamp(d/42*100,2,100);
    const barColor = d<=3?'#EF4444':d<=7?'#F59E0B':'#1E88E5';
    return `<tr>
      <td><strong style="font-family:monospace;font-size:11px">${esc(u.unit_id)}</strong></td>
      <td><span class="bt">${esc(u.blood_type)}</span></td>
      <td>${esc(u.donor_name)}</td>
      <td><span class="sp sp-${u.status}">${esc(u.status)}</span></td>
      <td style="font-size:11px">${esc(u.collection_date)}</td>
      <td class="${exCls}" style="font-size:11px">${exTxt}</td>
      <td>${rec}</td>
      <td style="font-size:11px">${esc(u.location)}</td>
      <td class="cell-spark">
        <div style="height:24px;background:#F3F4F6;border-radius:3px;overflow:hidden;width:100%;max-width:100px">
          <div style="height:100%;width:${pct}%;background:${barColor};border-radius:3px;transition:width 0.4s"></div>
        </div>
      </td>
    </tr>`;
  }).join('');
}

// ── QR Modal ──────────────────────────────────────────────────────────────────
function showQR(uid, sub) {
  const url=`/api/units/${encodeURIComponent(uid)}/qr`;
  set('qr-title', uid); set('qr-sub', sub);
  const img=$('qr-img'); if(img) img.src=url;
  const dl=$('qr-dl');  if(dl)  { dl.href=url; dl.download=uid+'_qr.png'; }
  $('qr-modal')?.classList.remove('hidden');
}
function closeQR(e) {
  if(!e||e.target===$('qr-modal')) $('qr-modal')?.classList.add('hidden');
}

// ── Add unit form ─────────────────────────────────────────────────────────────
async function submitUnit(e) {
  e.preventDefault();
  const btn=$('btn-add'); const msg=$('form-msg');
  if(btn){btn.disabled=true;btn.textContent='Saving…';}
  if(msg){msg.textContent='';msg.className='form-msg';}
  const p={
    unit_id:         $('f-uid')?.value.trim(),
    blood_type:      $('f-bt')?.value,
    donor_name:      $('f-dname')?.value.trim(),
    donor_dob:       $('f-ddob')?.value,
    donor_id:        $('f-did')?.value.trim(),
    collection_date: $('f-cdate')?.value,
    expiry_date:     $('f-edate')?.value,
    location:        $('f-loc')?.value.trim()||'Chamber A',
    recipient_name:  $('f-rname')?.value.trim(),
    recipient_id:    $('f-rid')?.value.trim(),
    notes:           $('f-notes')?.value.trim(),
  };
  try {
    const res=await fetch('/api/units',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});
    if(res.ok){
      if(msg){msg.textContent='✔ Unit registered successfully.';msg.className='form-msg ok';}
      e.target.reset(); await pollInventory();
    } else {
      const err=await res.json().catch(()=>({}));
      if(msg){msg.textContent='✘ '+(err.description||'Failed.');msg.className='form-msg err';}
    }
  } catch(ex){
    if(msg){msg.textContent='✘ Network error.';msg.className='form-msg err';}
  }
  if(btn){btn.disabled=false;btn.textContent='Register Unit';}
  setTimeout(()=>{if(msg)msg.textContent='';},5000);
}

let qrStream = null;
let qrScanActive = false;

function applyChamberStatus(c) {
  set('ch-A-count', `${c.A.count} unit${c.A.count!==1?'s':''}`);
  set('ch-A-temp', c.A.temperature!==null?c.A.temperature.toFixed(1)+'°C':'—');
  set('ch-A-gas', c.A.gas!==null?c.A.gas+'':'—');
  set('ch-A-dist', c.A.distance!==null?c.A.distance+'cm':'—');
  set('ch-A-light', c.A.light!==null?c.A.light+'':'—');
  const badgeA = $('ch-A-status');
  if(badgeA) {
    badgeA.textContent = c.A.status;
    badgeA.style.background = c.A.status === 'NORMAL' ? '#F0FDF4' : '#FEF2F2';
    badgeA.style.color = c.A.status === 'NORMAL' ? '#15803D' : '#B91C1C';
  }

  set('ch-B-count', `${c.B.count} unit${c.B.count!==1?'s':''}`);
  set('ch-B-temp', c.B.temperature!==null?c.B.temperature.toFixed(1)+'°C':'—');
  set('ch-B-gas', c.B.gas!==null?c.B.gas+'':'—');
  set('ch-B-dist', c.B.distance!==null?c.B.distance+'cm':'—');
  set('ch-B-light', c.B.light!==null?c.B.light+'':'—');
  const badgeB = $('ch-B-status');
  if(badgeB) {
    badgeB.textContent = c.B.status;
    badgeB.style.background = c.B.status === 'NORMAL' ? '#F0FDF4' : '#FEF2F2';
    badgeB.style.color = c.B.status === 'NORMAL' ? '#15803D' : '#B91C1C';
  }

  set('ch-C-count', `${c.C.count} unit${c.C.count!==1?'s':''}`);
  set('ch-C-temp', c.C.temperature!==null?c.C.temperature.toFixed(1)+'°C':'—');
  set('ch-C-gas', c.C.gas!==null?c.C.gas+'':'—');
  set('ch-C-dist', c.C.distance!==null?c.C.distance+'cm':'—');
  set('ch-C-light', c.C.light!==null?c.C.light+'':'—');
  const badgeC = $('ch-C-status');
  if(badgeC) {
    badgeC.textContent = c.C.status;
    badgeC.style.background = c.C.status === 'NORMAL' ? '#F0FDF4' : '#FEF2F2';
    badgeC.style.color = c.C.status === 'NORMAL' ? '#15803D' : '#B91C1C';
  }
}

function renderChamberCharts() {
  if (!histData || !histData.length) return;
  const temps = histData.map(d=>d.temperature);
  const gases = histData.map(d=>d.gas);
  const dists = histData.map(d=>d.distance ?? 15);
  const lights = histData.map(d=>d.light);

  function updateChSpark(cid, data, color) {
    if (charts[cid]) {
      updateSparkline(charts[cid], data);
    } else {
      charts[cid] = buildSparkline(cid, data, color);
    }
  }

  updateChSpark('chk-A-temp', temps, '#1E88E5');
  updateChSpark('chk-A-gas', gases, '#F59E0B');
  updateChSpark('chk-A-dist', dists, '#8B5CF6');
  updateChSpark('chk-A-light', lights, '#EC4899');

  updateChSpark('chk-B-temp', temps.map(t=>t!==null?t+0.4:null), '#10B981');
  updateChSpark('chk-B-gas', gases.map(g=>g!==null?Math.round(g*0.95):null), '#F59E0B');
  updateChSpark('chk-B-dist', dists.map(d=>d!==null?d-2:null), '#8B5CF6');
  updateChSpark('chk-B-light', lights.map(l=>l!==null?Math.round(l*0.9):null), '#EC4899');

  updateChSpark('chk-C-temp', temps.map(t=>t!==null?t-0.3:null), '#EF4444');
  updateChSpark('chk-C-gas', gases.map(g=>g!==null?Math.round(g*1.05):null), '#F59E0B');
  updateChSpark('chk-C-dist', dists.map(d=>d!==null?d+1:null), '#8B5CF6');
  updateChSpark('chk-C-light', lights.map(l=>l!==null?Math.round(l*1.1):null), '#EC4899');
}

async function loadStaffLog() {
  try {
    const res = await fetch('/api/staff/log');
    if (!res.ok) return;
    const log = await res.json();
    set('ssp-total', log.length);
    
    const startOfToday = new Date();
    startOfToday.setHours(0,0,0,0);
    const todayAccesses = log.filter(e => {
      const etime = new Date(e.ts.endsWith('Z') ? e.ts : e.ts+'Z');
      return etime >= startOfToday;
    }).length;
    set('ssp-today', todayAccesses);

    set('staff-log-count', `${log.length} access record${log.length!==1?'s':''}`);

    const tbody = $('staff-log-tbody');
    if (!tbody) return;
    if (!log.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="td-empty">No access records logged yet.</td></tr>';
      return;
    }

    tbody.innerHTML = log.map(e => {
      const parts = {};
      (e.detail || '').split(' | ').forEach(p => {
        const [k, v] = p.split(':');
        if (k && v) parts[k.trim().toLowerCase()] = v.trim();
      });
      const name = parts.staff || 'Unknown';
      const chamber = parts.chamber || 'Unknown';
      const unit = parts.unit || '—';
      const action = parts.action || 'ACCESSED';
      return `<tr>
        <td style="font-size:11px;color:#6B7280">${fmtTime(e.ts)}</td>
        <td style="font-weight:600;color:#111827">${esc(name)}</td>
        <td><span class="sp sp-STORED" style="background:#F3F4F6;color:#374151">${esc(chamber)}</span></td>
        <td><strong style="font-family:monospace;font-size:11px">${esc(unit)}</strong></td>
        <td><span class="et et-ACCESS">${esc(action)}</span></td>
        <td style="font-size:11px;color:#9CA3AF">${fmtRelative(e.ts)}</td>
      </tr>`;
    }).join('');
  } catch(err) {}
}

async function submitStaffCheckin(e) {
  e.preventDefault();
  const btn = $('btn-staff-submit');
  const msg = $('staff-form-msg');
  if(btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }
  if(msg) { msg.textContent = ''; msg.className = 'form-msg'; }

  const p = {
    staff_name: $('sf-name')?.value.trim(),
    chamber:    $('sf-chamber')?.value,
    action:     $('sf-action')?.value,
    unit_id:    $('sf-uid')?.value.trim(),
    notes:      $('sf-notes')?.value.trim()
  };

  try {
    const res = await fetch('/api/staff/checkin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(p)
    });
    if(res.ok) {
      if(msg) { msg.textContent = '✔ Access logged successfully.'; msg.className = 'form-msg ok'; }
      const uidInput = $('sf-uid'); if(uidInput) uidInput.value = '';
      const notesInput = $('sf-notes'); if(notesInput) notesInput.value = '';
      const preview = $('unit-preview'); if(preview) preview.style.display = 'none';
      await loadStaffLog();
    } else {
      const err = await res.json().catch(()=>({}));
      if(msg) { msg.textContent = '✘ ' + (err.error || 'Failed to submit check-in.'); msg.className = 'form-msg err'; }
    }
  } catch(ex) {
    if(msg) { msg.textContent = '✘ Connection error.'; msg.className = 'form-msg err'; }
  }
  if(btn) { btn.disabled = false; btn.textContent = 'Log Access'; }
  setTimeout(() => { if(msg) msg.textContent = ''; }, 5000);
}

async function openQRScanner() {
  const placeholder = $('qr-placeholder');
  const video = $('qr-video');
  const stopBtn = $('btn-stop-qr');
  const status = $('qr-status');

  if(qrScanActive) return;

  status.textContent = 'Initializing camera…';
  status.className = 'qr-status';
  status.style.background = '#EFF6FF';
  status.style.color = '#1D4ED8';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    qrStream = stream;
    if(video) {
      video.srcObject = stream;
      video.style.display = 'block';
    }
    if(placeholder) placeholder.style.display = 'none';
    if(stopBtn) stopBtn.style.display = 'block';
    qrScanActive = true;
    requestAnimationFrame(scanQRFrame);
  } catch(err) {
    status.textContent = 'Camera permission denied or not available.';
    status.className = 'qr-status err';
    status.style.background = '#FEF2F2';
    status.style.color = '#B91C1C';
  }
}

function stopQRScanner() {
  if (qrStream) {
    qrStream.getTracks().forEach(track => track.stop());
    qrStream = null;
  }
  const video = $('qr-video');
  if(video) {
    video.style.display = 'none';
    video.srcObject = null;
  }
  const placeholder = $('qr-placeholder');
  if(placeholder) placeholder.style.display = 'flex';
  const stopBtn = $('btn-stop-qr');
  if(stopBtn) stopBtn.style.display = 'none';
  qrScanActive = false;
  const status = $('qr-status');
  if(status) {
    status.textContent = '';
    status.className = 'qr-status';
  }
}

function scanQRFrame() {
  if (!qrScanActive) return;

  const video = $('qr-video');
  const canvas = $('qr-canvas');
  if (!video || !canvas) return;

  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    const ctx = canvas.getContext('2d');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(imgData.data, imgData.width, imgData.height, {
      inversionAttempts: 'dontInvert',
    });

    if (code) {
      const value = code.data;
      const uidInput = $('sf-uid');
      if (uidInput) {
        uidInput.value = value;
      }
      
      const status = $('qr-status');
      if (status) {
        status.textContent = `Scanned successfully!`;
        status.style.background = '#F0FDF4';
        status.style.color = '#15803D';
      }

      fetchBloodUnitPreview(value);
      stopQRScanner();
      return;
    }
  }
  requestAnimationFrame(scanQRFrame);
}

async function fetchBloodUnitPreview(uid) {
  try {
    const res = await fetch(`/api/units`);
    if (!res.ok) return;
    const units = await res.json();
    const unit = units.find(u => u.unit_id === uid);
    const previewDiv = $('unit-preview');
    const contentDiv = $('up-content');
    if (!previewDiv || !contentDiv) return;

    if (unit) {
      previewDiv.style.display = 'block';
      contentDiv.innerHTML = `
        <div style="font-size:12px;margin-bottom:4px"><strong>Blood Type:</strong> <span class="bt" style="padding:1px 5px">${esc(unit.blood_type)}</span></div>
        <div style="font-size:11px;margin-bottom:4px"><strong>Donor:</strong> ${esc(unit.donor_name)}</div>
        <div style="font-size:11px;margin-bottom:4px"><strong>Location:</strong> ${esc(unit.location)}</div>
        <div style="font-size:11px"><strong>Status:</strong> <span class="sp sp-${unit.status}" style="padding:1px 6px;font-size:10px">${esc(unit.status)}</span></div>
      `;
      const sfChamber = $('sf-chamber');
      if (sfChamber && unit.location) {
        sfChamber.value = unit.location;
      }
    } else {
      previewDiv.style.display = 'block';
      contentDiv.innerHTML = `<span style="color:#EF4444;font-size:11px">⚠️ Code scanned but unit not found in active inventory.</span>`;
    }
  } catch(e){}
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
(async function init() {
  await Promise.allSettled([pollStatus(), pollHistory(), pollEvents(), pollInventory()]);
  renderHomeTable();
  setInterval(pollStatus,  POLL_STATUS);
  setInterval(pollHistory, POLL_HIST);
  setInterval(pollEvents,  POLL_EVENTS);
  setInterval(pollInventory, POLL_INV);
})();
