import {createRefreshLoop} from './refresh-loop.js';
import {validRange,colorRange,readingState} from './ranges.js';
const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let state={connected:false},aqua={connected:false},busy=false,selectedMetric=null,refreshLoop;
const date=t=>t?new Date(t).toLocaleString():'Unknown';
let khRange=null;
try{const saved=JSON.parse(localStorage.getItem('my-reef-kh-range'));if(validRange(saved))khRange=saved;}catch{}
function age(t){const minutes=Math.floor((Date.now()-Date.parse(t))/60000);return !Number.isFinite(minutes)?'time unknown':minutes<1?'just now':minutes<60?minutes+'m ago':minutes<1440?Math.floor(minutes/60)+'h ago':Math.floor(minutes/1440)+'d ago';}

async function api(action,body,vendor='reef'){
 const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),25000);
 try{
  const response=await fetch('/api/'+vendor+'/'+action,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',signal:controller.signal,headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  if(response.redirected){location.href='/login';throw Error('Sign in to My Reef.');}
  const data=await response.json();
  if(data.code==='MY_REEF_AUTH_REQUIRED'){location.href='/login';throw Error('Sign in to My Reef.');}
  if(!response.ok)throw Error(data.error||'Request failed.');return data;
 }catch(error){if(error.name==='AbortError')throw Error('Connection timed out. Retrying automatically.');throw error;}finally{clearTimeout(timeout);}
}
function setBusy(value){busy=value;for(const id of ['connect','refresh','disconnect','device','aqua-connect','aqua-refresh','aqua-disconnect','aqua-device'])$(id).disabled=value;}
function message(text=''){$('message').textContent=text;}
async function run(fn,resume=true){if(busy)return;setBusy(true);message();try{await fn();}catch(error){message(error.message);}finally{setBusy(false);if(resume)void refreshLoop?.wake();}}
function options(id,data,empty){
 const select=$(id),previous=select.value;
 select.innerHTML=data.devices?.length?data.devices.map(d=>'<option value="'+esc(d.id)+'">'+esc(d.name)+(d.model?' · '+esc(d.model):'')+'</option>').join(''):'<option value="">'+empty+'</option>';
 if(data.selected)select.value=data.selected;else if(data.devices?.some(d=>d.id===previous))select.value=previous;
}
function allSensors(){return [...(state.snapshot?.sensors||[]).map(s=>({...s,vendor:'Red Sea',stale:state.stale||!!state.error||Date.now()-Date.parse(state.snapshot?.at)>120000})),...(aqua.snapshot?.sensors||[]).map(s=>({...s,vendor:'AquaWiz',stale:aqua.stale||!!aqua.error||!aqua.snapshot?.measuredAt||Date.now()-Date.parse(aqua.snapshot.measuredAt)>86400000}))];}
function sensorCard(s,title=s.name,featured=false){
 const range=colorRange(s,khRange,aqua.snapshot?.targetKH),status=readingState(s,range);
 const measured=s.vendor==='AquaWiz'?s.measuredAt:state.snapshot?.at;
 const timestamp=(s.vendor==='AquaWiz'?'Measured ':'Updated ')+age(measured);
 const rangeLabel=range?'Range '+range[0]+'–'+range[1]+' '+s.unit:s.type==='alkalinity'?'Set your KH range':'';
 return '<article class="sensor'+(featured?' featured':'')+'"><div class="kind">'+esc(s.vendor)+'</div><h3>'+esc(title)+'</h3><div class="reading '+status.tone+'">'+esc(s.value===null?'—':typeof s.value==='number'?Number(s.value.toFixed(s.unit==='SG'?4:2)):s.value)+'<span class="unit">'+esc(s.unit)+'</span></div><div class="status '+status.tone+'">'+esc(status.label)+'</div>'+(rangeLabel?'<div class="range">'+esc(rangeLabel)+'</div>':'')+(featured&&s.unit==='mS/cm'?'<div class="range">Conductivity</div>':'')+((featured||s.vendor==='AquaWiz')?'<div class="range timestamp" title="'+esc(date(measured))+'">'+esc(timestamp)+'</div>':'')+(featured&&s.vendor==='AquaWiz'?'<div class="range timestamp" title="'+esc(date(aqua.snapshot?.at))+'">Synced '+esc(age(aqua.snapshot?.at))+'</div>':'')+'</article>';
}
function missingCard(title,vendor){
 return '<article class="sensor featured"><div class="kind">'+esc(vendor)+'</div><h3>'+esc(title)+'</h3><div class="reading">—</div><div class="status warning">Awaiting reading</div><div class="range">'+(vendor==='AquaWiz'?'Connect your alkalinity tester to load KH.':'Connect ReefControl with a salinity probe to load this reading.')+'</div></article>';
}
function render(){
 document.body.classList.toggle('has-readings',state.connected||aqua.connected);
 $('setup').hidden=state.connected&&!state.expired;$('aqua-setup').hidden=aqua.connected&&!aqua.expired;
 $('dashboard').hidden=!state.connected&&!aqua.connected;
 $('red-toolbar').hidden=!state.connected;$('aqua-toolbar').hidden=!aqua.connected;
 const count=[state,aqua].filter(s=>s.snapshot&&!s.stale).length;
 $('connection').textContent=count?count+' source'+(count===1?'':'s')+' reporting':state.connected||aqua.connected?'Connected · awaiting readings':'Connect your equipment';
 $('connection').className='pill '+(count?'active':state.connected||aqua.connected?'warning':'');
 options('device',state,'No ReefControl found');options('aqua-device',aqua,'No AquaWiz KH controller found');
 $('refresh').hidden=!state.devices?.length;$('aqua-refresh').hidden=!aqua.devices?.length;
 $('source').textContent=state.snapshot?.source||'Choose your ReefControl to load its readings.';
 $('aqua-source').textContent=aqua.snapshot?'Last KH measurement: '+date(aqua.snapshot.measuredAt)+' · synced '+date(aqua.snapshot.at):'Choose your AquaWiz to sync its latest reading and history.';
 $('updated').textContent='Red Sea: '+(state.snapshot?date(state.snapshot.at):'not reporting')+' · AquaWiz: '+(aqua.snapshot?date(aqua.snapshot.measuredAt):'not reporting');
 $('session-note').textContent='Red Sea + AquaWiz';
 const sensors=allSensors();
 const alkalinity=sensors.find(s=>s.type==='alkalinity'),salinity=sensors.find(s=>s.type==='ec');
 const activeRange=alkalinity?colorRange(alkalinity,khRange,aqua.snapshot?.targetKH):khRange;
 if(!$('kh-range-settings').open){$('kh-low').value=activeRange?.[0]??'';$('kh-high').value=activeRange?.[1]??'';}
 $('kh-range-note').textContent=khRange?'Using your saved display range.':activeRange?'Using your AquaWiz KH target ±0.5 dKH.':'Enter a KH range to enable green/red numbers.';

 $('priorities').innerHTML=(alkalinity?sensorCard(alkalinity,'Alkalinity',true):missingCard('Alkalinity','AquaWiz'))+(salinity?sensorCard(salinity,'Salinity',true):missingCard('Salinity','Red Sea'));
 const remaining=sensors.filter(s=>s.id!==alkalinity?.id&&s.id!==salinity?.id);
 $('other-readings').hidden=!remaining.length;
 $('sensors').innerHTML=remaining.map(s=>sensorCard(s)).join('');
 const rank=s=>s.type==='alkalinity'?0:s.type==='ec'?1:2;
 const numeric=sensors.filter(s=>typeof s.value==='number').sort((a,b)=>rank(a)-rank(b));
 $('metric').innerHTML=numeric.map(s=>'<option value="'+esc(s.id)+'">'+esc(s.vendor)+' · '+esc(s.type==='alkalinity'?'Alkalinity':s.type==='ec'?'Salinity':s.name)+' ('+esc(s.unit)+')</option>').join('');
 if(numeric.some(s=>s.id===selectedMetric))$('metric').value=selectedMetric;
 $('metric').hidden=!numeric.length;chart();
 $('ports').innerHTML=state.snapshot?'<div class="row"><strong>Controller mode</strong><span>'+esc(state.snapshot.mode)+'</span></div>'+(state.snapshot.ports.map(p=>'<div class="row"><strong>'+esc(p.name)+'</strong><span>'+esc(p.mode)+' · '+esc(p.state)+'</span></div>').join('')||'<p class="fine">No ports reported.</p>')+(state.snapshot.buzzer?.active?'<p class="status warning">Buzzer active: '+esc(state.snapshot.buzzer.cause)+'</p>':''):'<p class="fine">Connect Red Sea to see your controller and ports.</p>';
 if(aqua.snapshot){$('ports').innerHTML+='<div class="row"><strong>AquaWiz KH target</strong><span>'+esc(aqua.snapshot.targetKH===null?'Unknown':aqua.snapshot.targetKH+' dKH')+'</span></div>';}
 $('health').innerHTML=[...(state.attempts||[]),...(aqua.attempts||[])].map(a=>'<div class="row"><strong>'+esc(a.transport==='cloud'?'Red Sea cloud':a.transport==='aquawiz'?'AquaWiz cloud':'Direct Red Sea device')+'</strong><span>'+(a.ok?'Read successful':'Unavailable')+'</span></div>'+(a.message?'<p class="fine">'+esc(a.message)+'</p>':'')).join('')||'<p class="fine">Connection results appear after syncing your equipment.</p>';
 const errors=[state.error,aqua.error,aqua.historyError,state.expired?'Red Sea session expired. Sign in again.':null,aqua.expired?'AquaWiz session expired. Sign in again.':null].filter(Boolean);
 if(errors.length)message(errors.join(' '));
}
function chart(){
 const sensor=allSensors().find(s=>s.id===$('metric').value);
 if(!sensor){$('chart').textContent='History appears after your first successful reading.';return;}
 const points=[...(state.history||[]),...(aqua.history||[])].flatMap(h=>{const v=h.values.find(v=>v.id===sensor.id&&v.unit===sensor.unit);return v?[{t:Date.parse(h.at),v:v.value}]:[];}).sort((a,b)=>a.t-b.t);
 if(points.length<2||points[0].t===points.at(-1).t){$('chart').textContent=points.length?'One measurement available. The next reading will extend the trend.':'No history available for this probe yet.';return;}
 const min=Math.min(...points.map(p=>p.v)),max=Math.max(...points.map(p=>p.v)),pad=Math.max((max-min)*.2,.01),lo=min-pad,hi=max+pad,start=points[0].t,end=points.at(-1).t;
 const xy=points.map(p=>[64+(p.t-start)/(end-start)*816,190-(p.v-lo)/(hi-lo)*155]),line=xy.map(([x,y])=>x.toFixed(1)+','+y.toFixed(1)).join(' ');
 const tick=t=>new Date(t).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
 $('chart').innerHTML='<svg viewBox="0 0 920 240" role="img" aria-label="'+esc(sensor.name)+' history"><g fill="#9ab0b5" font-family="system-ui" font-size="12"><text x="8" y="39">'+hi.toFixed(2)+'</text><text x="8" y="192">'+lo.toFixed(2)+'</text><text x="64" y="225">'+esc(tick(start))+'</text><text x="880" y="225" text-anchor="end">'+esc(tick(end))+'</text></g><path d="M64 35H880M64 112H880M64 190H880" stroke="#24404a" fill="none"/><polyline points="'+line+'" stroke="#8ee1ca" stroke-width="3" fill="none" stroke-linejoin="round"/>'+xy.map(([x,y],i)=>'<circle cx="'+x+'" cy="'+y+'" r="3" fill="#8ee1ca"><title>'+esc(tick(points[i].t)+' · '+points[i].v+' '+sensor.unit)+'</title></circle>').join('')+'</svg>';
}
async function refresh(force=false){const id=$('device').value;if(!id)return;state=await api('refresh',{deviceId:id,force});render();}
async function refreshAqua(force=false){const id=$('aqua-device').value;if(!id)return;aqua=await api('refresh',{deviceId:id,force},'aquawiz');render();}
$('signin').addEventListener('submit',event=>{event.preventDefault();run(async()=>{const password=$('password').value;$('password').value='';state=await api('connect',{email:$('email').value,password});render();await refresh();});});
$('aqua-signin').addEventListener('submit',event=>{event.preventDefault();run(async()=>{const password=$('aqua-password').value;$('aqua-password').value='';aqua=await api('connect',{username:$('aqua-username').value,password,region:$('aqua-region').value},'aquawiz');render();await refreshAqua();});});
$('refresh').addEventListener('click',()=>run(()=>refresh(true)));$('device').addEventListener('change',()=>run(refresh));
$('aqua-refresh').addEventListener('click',()=>run(()=>refreshAqua(true)));$('aqua-device').addEventListener('change',()=>run(refreshAqua));
$('disconnect').addEventListener('click',()=>run(async()=>{state=await api('disconnect',{});render();}));
$('aqua-disconnect').addEventListener('click',()=>run(async()=>{aqua=await api('disconnect',{},'aquawiz');render();}));
$('metric').addEventListener('change',()=>{selectedMetric=$('metric').value;chart();});
$('kh-range-form').addEventListener('submit',event=>{
 event.preventDefault();
 const range=[$('kh-low').valueAsNumber,$('kh-high').valueAsNumber];
 if(!validRange(range)||range[0]<=0){$('kh-range-feedback').textContent='Enter a positive lower limit below the upper limit.';return;}
 khRange=range;
 try{localStorage.setItem('my-reef-kh-range',JSON.stringify(range));$('kh-range-feedback').textContent='Range saved on this device.';}catch{$('kh-range-feedback').textContent='Range applied for this visit; browser storage is unavailable.';}
 $('kh-range-settings').open=false;render();
});
$('kh-range-reset').addEventListener('click',()=>{khRange=null;try{localStorage.removeItem('my-reef-kh-range');}catch{}$('kh-range-settings').open=false;render();});

async function syncDashboard(){
 const fetched=await Promise.allSettled([api('state'),api('state',undefined,'aquawiz')]);
 const errors=[];
 if(fetched[0].status==='fulfilled')state=fetched[0].value;else errors.push(fetched[0].reason.message);
 if(fetched[1].status==='fulfilled')aqua=fetched[1].value;else errors.push(fetched[1].reason.message);
 render();
 const requests=[],now=Date.now();
 if(fetched[0].status==='fulfilled'&&state.connected&&!state.expired&&(!state.lastAttempt||now-Date.parse(state.lastAttempt)>=60000))requests.push(refresh());
 if(fetched[1].status==='fulfilled'&&aqua.connected&&!aqua.expired&&(!aqua.lastAttempt||now-Date.parse(aqua.lastAttempt)>=900000))requests.push(refreshAqua());
 for(const result of await Promise.allSettled(requests))if(result.status==='rejected')errors.push(result.reason.message);
 if(errors.length)message(errors.join(' '));
}
refreshLoop=createRefreshLoop({refresh:()=>run(syncDashboard,false),isVisible:()=>!document.hidden,onError:error=>message(error.message)});
document.addEventListener('visibilitychange',()=>{if(document.hidden)refreshLoop.pause();else void refreshLoop.wake();});
window.addEventListener('pageshow',()=>void refreshLoop.wake());
window.addEventListener('focus',()=>void refreshLoop.wake());
window.addEventListener('online',()=>void refreshLoop.wake());
await refreshLoop.start();
