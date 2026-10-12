import {RedSeaClient, ReefError} from './backend.mjs';
// Observed directly in AquaWiz's public build.js (2026-10-11).
const SERVERS={global:'https://server.aquawiz.net',china:'https://server.aquawiz.cn'};
const numeric=v=>(typeof v==='number'||(typeof v==='string'&&v.trim()))&&Number.isFinite(Number(v))?Number(v):null;
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
function timestamp(value,now) {
  const t=typeof value==='number'||(typeof value==='string'&&/^\d{12,14}$/.test(value))?Number(value):typeof value==='string'?Date.parse(value):NaN;
  return Number.isFinite(t)&&t>=946684800000&&t<=now+300000?new Date(t).toISOString():null;
}
export function normalizeAquaWiz(data,serial,now=Date.now()) {
  if(!object(data)||!Object.hasOwn(data,'latest_kh'))throw new ReefError('AquaWiz did not return an alkalinity reading.');
  const raw=numeric(data.latest_kh);
  const value=raw!==null&&raw>0?raw/1000:null;
  const measuredAt=timestamp(data.latest_time,now);
  const target=numeric(data.field8);
  return {deviceId:serial,at:new Date(now).toISOString(),measuredAt,source:'AquaWiz cloud',
    sensors:[{id:'aquawiz:'+serial+':kh',type:'alkalinity',name:'AquaWiz alkalinity',unit:'dKH',value,measuredAt,ranges:null,
      available:value!==null,status:value===null?'No valid KH reading':!measuredAt?'Measurement time unavailable':'Reading available'}],
    targetKH:target!==null&&target>0?target/1000:null,
    supplementRemainingMl:numeric(data.field14),historyError:null};
}
export function normalizeAquaHistory(data,serial,now=Date.now()) {
  if(!object(data)||!Array.isArray(data.results))throw new ReefError('AquaWiz returned an unfamiliar history format.');
  const points=new Map();
  for(const row of data.results){
    if(!Array.isArray(row)||!object(row[1]))continue;
    const at=timestamp(row[0],now),raw=numeric(row[1].field22);
    if(!at||Date.parse(at)<now-7*86400000||raw===null||raw<=0)continue;
    points.set(at,{at,values:[{id:'aquawiz:'+serial+':kh',unit:'dKH',value:raw/1000}]});
  }
  return [...points.values()].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)).slice(-5000);
}
export class AquaWizClient extends RedSeaClient {
  constructor(options={}) {super(options);this.username='';this.base=SERVERS.global;this.historyError=null;}
  async request(url,options={}) {
    try{return await super.request(url,options);}
    catch(error){throw new ReefError(error.message.replaceAll('Red Sea','AquaWiz'),error.status||502);}
  }
  updateToken(data,required=false){
    if(required&&(!object(data)||typeof data.access_token!=='string'||!data.access_token))throw new ReefError('AquaWiz did not return an access token. Check your username and password.',401);
    if(typeof data.access_token==='string'&&data.access_token)this.token=data.access_token;
    const expiry=numeric(data.tokenExp);
    if(expiry!==null)this.expires=expiry;
    if(required)this.authRejected=false;
    if(required&&(!expiry||expiry<=this.now()))throw new ReefError('AquaWiz returned an expired or invalid session.',401);
  }
  async connect(username,password,region='global'){
    if(typeof username!=='string'||!username.trim()||username.length>254||typeof password!=='string'||!password||password.length>1024)throw new ReefError('Enter your AquaWiz username and password.',400);
    if(!Object.hasOwn(SERVERS,region))throw new ReefError('Choose an available AquaWiz cloud region.',400);
    this.base=SERVERS[region];this.username=username.trim();
    const auth=await this.request(this.base+'/api/v1/KH/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:this.username,password,token:{access_token:''}})});
    this.updateToken(auth,true);
    if(!object(auth.user)||!Array.isArray(auth.user.devices))throw new ReefError('AquaWiz returned an unfamiliar device list.');
    this.devices=auth.user.devices.filter(s=>typeof s==='string'&&/^KH[A-Z0-9]*-[A-Za-z0-9-]{1,70}$/.test(s)).map(s=>({id:s,name:s,model:'AquaWiz KH'}));
    return this.state();
  }
  async read(path,body={}){
    if(!this.token||this.authRejected||this.now()>=this.expires)throw new ReefError('Your AquaWiz session expired. Sign in again.',401);
    try{return await this.request(this.base+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+this.token},
      body:JSON.stringify({user:this.username,password:'',appid:1,...body,token:{access_token:this.token}})});}catch(error){if(error.status===401)this.authRejected=true;throw error;}
  }
  async refresh(id=this.selected){
    const device=this.devices.find(d=>d.id===id);
    if(!device)throw new ReefError('Choose an AquaWiz KH controller from your account.',400);
    if(this.selected!==id){this.snapshot=null;this.history=[];this.historyError=null;}
    this.selected=id;this.lastAttempt=new Date(this.now()).toISOString();this.attempts=[];
    try{
      const data=await this.read('/api/v1/KH/'+encodeURIComponent(id)+'/all_field');
      const snapshot=normalizeAquaWiz(data,id,this.now());
      this.updateToken(data);
      this.snapshot=snapshot;this.error=null;
      this.attempts.push({transport:'aquawiz',ok:true});
    }catch(error){this.error=error.message;this.attempts.push({transport:'aquawiz',ok:false,message:error.message});return this.state();}
    try{
      const data=await this.read('/api/v1/query/device/'+encodeURIComponent(id)+'/graphs',{date:new Date(this.now()-7*86400000).toISOString()});
      this.history=normalizeAquaHistory(data,id,this.now());this.historyError=null;
    }catch(error){this.historyError='KH history could not be synced. '+error.message;}
    const latest=this.snapshot.sensors[0];
    if(latest.available&&this.snapshot.measuredAt){
      const point={at:this.snapshot.measuredAt,values:[{id:latest.id,unit:'dKH',value:latest.value}]};
      const map=new Map(this.history.map(p=>[p.at,p]));map.set(point.at,point);
      this.history=[...map.values()].filter(p=>Date.parse(p.at)>=this.now()-7*86400000).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)).slice(-5000);
    }
    return this.state();
  }
  exportSession(){return {...super.exportSession(),username:this.username,region:this.base===SERVERS.china?'china':'global',historyError:this.historyError};}
  restoreSession(data){
    if(!data||typeof data.username!=='string'||!Object.hasOwn(SERVERS,data.region)||!super.restoreSession(data))return false;
    this.username=data.username;this.base=SERVERS[data.region];this.historyError=typeof data.historyError==='string'?data.historyError:null;
    this.refreshToken=null;return true;
  }
  state(){
    const base=super.state(),at=this.snapshot?.measuredAt;
    return {...base,stale:!!this.snapshot&&(!!this.error||!at||this.now()-Date.parse(at)>86400000),historyError:this.historyError,region:this.base===SERVERS.china?'china':'global'};
  }
}
