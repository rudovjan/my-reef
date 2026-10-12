// Standalone implementation; no Home Assistant or Homebridge dependency.
// Protocol references and verification boundaries are in README.md.
const CLOUD = 'https://cloud.reef-beat.com';
const CLIENT_AUTH = 'Basic Z0ZqSHRKcGE6Qzlmb2d3cmpEV09SVDJHWQ=='; // Published ReefBeat app client identifier, not an account secret.
const disconnected = new Set(['disconnected', 'not_connected', 'offline']);
const num = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const str = value => typeof value === 'string' ? value.slice(0, 180) : '';
const obj = value => value && typeof value === 'object' && !Array.isArray(value);

export class ReefError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}
export function privateIPv4(ip) {
  if (typeof ip !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  const p = ip.split('.').map(Number);
  if (p.some(n => n > 255) || p[3] === 0 || p[3] === 255) return false;
  return p[0] === 10 || (p[0] === 192 && p[1] === 168) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31);
}
export function normalizeDashboard(data) {
  if (!obj(data) || !Array.isArray(data.probes)) throw new ReefError('The response did not contain a ReefControl probes list.');
  const sensors = [];
  for (const [index, p] of data.probes.entries()) {
    if (!obj(p)) continue;
    const type = str(p.type).toLowerCase();
    const uid = str(p.uid) || String(index);
    const available = !disconnected.has(str(p.status).toLowerCase()) && p.enabled !== false && p._disabled !== true;
    const unit = type === 'temperature' ? '°C' : type === 'orp' ? 'mV' : type === 'ec' ? ({ec:'mS/cm', ppt:'ppt', sg:'SG'}[p.unit] || str(p.unit) || 'unknown') : type === 'ph' ? 'pH' : '';
    const value = type === 'leak' ? (typeof p.detected === 'boolean' ? (p.detected ? 'Wet' : 'Dry') : null) : type === 'ato' ? (str(p.water_level) || null) : num(p.value);
    const ranges = Array.isArray(p.ranges) && p.ranges.length === 4 && p.ranges.every(v => num(v) !== null) ? p.ranges : null;
    const issue = !available ? 'Unavailable' : type === 'leak' && p.detected === true ? 'Leak detected' : value === null ? 'No reading' : ranges && typeof value === 'number' && (value < ranges[0] || value > ranges[3]) ? 'Outside acceptable range' : ranges && typeof value === 'number' && (value < ranges[1] || value > ranges[2]) ? 'Outside desired range' : null;
    sensors.push({id:type+':'+uid,type,name:str(p.name)||type||'Probe',unit,value:available?value:null,ranges,status:issue||'Reading available',available:available&&value!==null});
    const temperature = num(p.temp_value) ?? num(p.temp);
    if (['ec','ph','ato'].includes(type) && temperature !== null) {
      sensors.push({id:type+':'+uid+':temp',type:'temperature',name:(str(p.name)||type)+' · temperature',unit:'°C',value:available?temperature:null,ranges:null,status:available?'Reading available':'Unavailable',available});
    }
  }
  return {
    mode:str(data.mode)||'Unknown', sensors,
    ports:(Array.isArray(data.ports)?data.ports:[]).filter(obj).map(p=>({number:num(p.number),name:str(p.name)||'Port',mode:str(p.mode)||'Unknown',state:str(p.state)||'Unknown',type:str(p.type)})),
    buzzer:obj(data.buzzer) ? {active:data.buzzer.active === true,cause:str(data.buzzer.cause)} : null
  };
}

export class RedSeaClient {
  constructor({fetcher = fetch, now = Date.now} = {}) {
    this.fetcher=fetcher; this.now=now; this.token=null; this.refreshToken=null; this.authRejected=false; this.renewing=null; this.expires=0; this.devices=[]; this.aquariums=[];
    this.selected=null; this.snapshot=null; this.history=[]; this.error=null; this.attempts=[]; this.lastAttempt=null;
  }
  async request(url, options={}) {
    try {
      const response=await this.fetcher(url,{...options,redirect:'error',signal:AbortSignal.timeout(8000)});
      if (!response.ok) {
        if (response.status===401 || response.status===403) throw new ReefError('Red Sea rejected this request. Sign in again if your session expired.',401);
        if (response.status===400 && url.endsWith('/oauth/token')) throw new ReefError('Red Sea rejected the email or password.',401);
        throw new ReefError('Red Sea returned HTTP '+response.status+'.',response.status===429?429:502);
      }
      let total=0; const chunks=[];
      for await (const chunk of response.body) { total+=chunk.byteLength; if(total>1024*1024) throw new ReefError('Red Sea response was too large.'); chunks.push(Buffer.from(chunk)); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch(error) {
      if(error instanceof ReefError) throw error;
      throw new ReefError('Could not read Red Sea. Check the connection and try again.');
    }
  }
  async connect(email,password) {
    if(typeof email!=='string'||!email.trim()||email.length>254||typeof password!=='string'||!password||password.length>1024) throw new ReefError('Enter your ReefBeat email and password.',400);
    const auth=await this.request(CLOUD+'/oauth/token',{method:'POST',headers:{Authorization:CLIENT_AUTH,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',username:email.trim(),password})});
    this.updateAuth(auth);
    const [devices,aquariums]=await Promise.all([this.cloud('/device'),this.cloud('/aquarium')]);
    if(!Array.isArray(devices)||!Array.isArray(aquariums)) throw new ReefError('Red Sea returned an unfamiliar device list.');
    this.aquariums=aquariums.filter(obj).map(a=>({id:str(a.uid),name:str(a.name)||'Aquarium'}));
    this.devices=devices.filter(d=>obj(d)&&(d.type==='reef-control'||/^RSCONTROL/.test(str(d.model)))).map(d=>({
      id:str(d.hwid), name:str(d.name)||str(d.model)||'ReefControl', model:str(d.model),
      aquariumId:str(d.aquarium_uid), ip:privateIPv4(d.ip_address)?d.ip_address:null
    })).filter(d=>d.id);
    return this.state();
  }
  updateAuth(auth) {
    if(!obj(auth)||typeof auth.access_token!=='string'||!auth.access_token) throw new ReefError('Red Sea did not return an access token.');
    const seconds=Number(auth.expires_in);
    this.token=auth.access_token;
    this.expires=this.now()+(Number.isFinite(seconds)&&seconds>0?Math.min(seconds,365*86400):2700)*1000;
    if(typeof auth.refresh_token==='string'&&auth.refresh_token)this.refreshToken=auth.refresh_token;
    this.authRejected=false;
  }
  async renew() {
    if(!this.refreshToken||this.authRejected)throw new ReefError('Your Red Sea session expired. Sign in again.',401);
    if(!this.renewing)this.renewing=(async()=>{
      try{
        const auth=await this.request(CLOUD+'/oauth/token',{method:'POST',headers:{Authorization:CLIENT_AUTH,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:this.refreshToken})});
        this.updateAuth(auth);
      }catch(error){
        if(error.status===401){this.authRejected=true;throw new ReefError('Red Sea requires a new sign-in. Its saved session could not be renewed.',401);}
        throw error;
      }
    })().finally(()=>{this.renewing=null;});
    await this.renewing;
  }
  async cloud(path) {
    if(!this.token||this.authRejected)throw new ReefError('Your Red Sea session expired. Sign in again.',401);
    if(this.now()>=this.expires-60000&&this.refreshToken)await this.renew();
    if(this.now()>=this.expires)throw new ReefError('Your Red Sea session expired. Sign in again.',401);
    try{return await this.request(CLOUD+path,{headers:{Authorization:'Bearer '+this.token}});}
    catch(error){
      if(error.status!==401)throw error;
      if(!this.refreshToken){this.authRejected=true;throw error;}
      await this.renew();
      try{return await this.request(CLOUD+path,{headers:{Authorization:'Bearer '+this.token}});}
      catch(retry){if(retry.status===401)this.authRejected=true;throw retry;}
    }
  }
  exportSession() {
    return {version:1,token:this.token,refreshToken:this.refreshToken,expires:this.expires,authRejected:this.authRejected,
      devices:this.devices,aquariums:this.aquariums,selected:this.selected,snapshot:this.snapshot,
      history:this.history,error:this.error,attempts:this.attempts,lastAttempt:this.lastAttempt};
  }
  restoreSession(data) {
    if(!obj(data)||data.version!==1||typeof data.token!=='string'||!data.token||!Number.isFinite(data.expires)||!Array.isArray(data.devices))return false;
    this.token=data.token;this.expires=data.expires;this.refreshToken=typeof data.refreshToken==='string'?data.refreshToken:null;this.authRejected=data.authRejected===true;
    this.devices=data.devices.filter(obj).map(d=>({...d,ip:privateIPv4(d.ip)?d.ip:null}));
    this.aquariums=Array.isArray(data.aquariums)?data.aquariums:[];this.selected=typeof data.selected==='string'?data.selected:null;
    this.snapshot=obj(data.snapshot)?data.snapshot:null;this.history=Array.isArray(data.history)?data.history:[];
    this.error=typeof data.error==='string'?data.error:null;this.attempts=Array.isArray(data.attempts)?data.attempts:[];
    this.lastAttempt=typeof data.lastAttempt==='string'?data.lastAttempt:null;
    return true;
  }
  async refresh(id=this.selected) {
    const device=this.devices.find(d=>d.id===id);
    if(!device) throw new ReefError('Choose a ReefControl from your account.',400);
    if(this.selected!==id) {this.snapshot=null; this.history=[];}
    this.selected=id; this.lastAttempt=new Date(this.now()).toISOString(); this.attempts=[];
    let normalized,source;
    // Experimental read: follows the family/hwid pattern seen for other ReefBeat devices.
    // A success requires a real probes[] payload; a successful login alone never means readings are connected.
    try { normalized=normalizeDashboard(await this.cloud('/reef-control/'+encodeURIComponent(id)+'/dashboard')); source='Red Sea cloud (experimental route verified by this response)'; this.attempts.push({transport:'cloud',ok:true}); }
    catch(error) { this.attempts.push({transport:'cloud',ok:false,message:error.message}); }
    if(!normalized&&device.ip) {
      try { normalized=normalizeDashboard(await this.request('http://'+device.ip+'/dashboard')); source='Direct device on your network'; this.attempts.push({transport:'local',ok:true}); }
      catch(error) {this.attempts.push({transport:'local',ok:false,message:error.message});}
    }
    if(!normalized) {
      this.error='Could not refresh Red Sea readings. '+(this.snapshot?'Keeping the last saved readings. ':'')+this.attempts.filter(a=>!a.ok).map(a=>a.message).join(' ');
      return this.state();
    }
    this.error=null;
    this.snapshot={...normalized,deviceId:id,at:new Date(this.now()).toISOString(),source};
    if(!this.history.length||this.now()-Date.parse(this.history.at(-1).at)>=60000) {
      this.history.push({at:this.snapshot.at,values:normalized.sensors.filter(s=>s.available&&typeof s.value==='number').map(s=>({id:s.id,unit:s.unit,value:s.value}))});
    }
    this.history=this.history.filter(h=>this.now()-Date.parse(h.at)<86400000).slice(-1440);
    return this.state();
  }
  state() {
    const at=this.snapshot?.at;
    return {connected:!!this.token,expired:!!this.token&&(this.authRejected||(this.now()>=this.expires&&!this.refreshToken)),expiresAt:this.token?new Date(this.expires).toISOString():null,
      devices:this.devices,aquariums:this.aquariums,selected:this.selected,snapshot:this.snapshot,
      stale:!!at&&(!!this.error||this.now()-Date.parse(at)>120000),error:this.error,attempts:this.attempts,lastAttempt:this.lastAttempt,history:this.history};
  }
}

export function createReefApi({makeClient = () => new RedSeaClient(), prefix='/api/reef/', vendor='Red Sea', refreshInterval=60000, store=null, isSessionValid=()=>true, sharedScope=null, now=Date.now}={}) {
  const clients=new Map(), busy=new Set(), attempts=new Map();
  const empty=()=>({connected:false,devices:[],aquariums:[],history:[],snapshot:null});
  const scopeFor=token=>sharedScope||token;
  const versions=new Map();
  function clientFor(scope){
    if(!clients.has(scope)&&store){
      const record=store.get(prefix,scope);
      if(record){const client=makeClient();if(client.restoreSession(record))clients.set(scope,client);}
    }
    return clients.get(scope);
  }
  function persist(scope,client){if(store&&client)store.set(prefix,scope,{...client.exportSession(),vendor:prefix});}
  function disconnectScope(scope){versions.set(scope,(versions.get(scope)||0)+1);clients.delete(scope);store?.delete(prefix,scope);}
  function due(client){return !client.lastAttempt||now()-Date.parse(client.lastAttempt)>=refreshInterval;}
  async function refreshClient(scope,client,id){
    const generation=versions.get(scope)||0;
    const data=await client.refresh(id);
    if((versions.get(scope)||0)===generation&&clients.get(scope)===client)persist(scope,client);
    return data;
  }
  return {
    prune(validTokens) {
      const validScopes=sharedScope?new Map([[sharedScope,null]]):validTokens;
      for(const scope of clients.keys())if(!validScopes.has(scope))clients.delete(scope);
      for(const scope of attempts.keys())if(!validScopes.has(scope))attempts.delete(scope);
      store?.prune(prefix,validScopes);
    },
    disconnect(token){disconnectScope(scopeFor(token));},
    moveSession(previous,next){if(sharedScope)return;const client=clientFor(previous);if(client){clients.set(next,client);persist(next,client);}disconnectScope(previous);},
    async poll(){
      if(!sharedScope||busy.has(sharedScope))return;
      const client=clientFor(sharedScope);
      if(!client||client.state().expired||!due(client))return;
      const id=client.selected||client.devices[0]?.id;if(!id)return;
      busy.add(sharedScope);
      try{await refreshClient(sharedScope,client,id);}finally{busy.delete(sharedScope);}
    },
    async handle(req,path,token) {
      const action=path.slice(prefix.length),scope=scopeFor(token);
      if(!isSessionValid(token))return {status:401,data:{error:'Your My Reef session expired.'}};
      if(action==='state'&&['GET','HEAD'].includes(req.method))return {status:200,data:clientFor(scope)?.state()||empty()};
      if(req.method!=='POST')return {status:405,data:{error:'Method not allowed'}};
      if(!['connect','refresh','disconnect'].includes(action))return {status:404,data:{error:'Not found'}};
      if(busy.has(scope))return action==='refresh'?{status:200,data:clientFor(scope)?.state()||empty()}:{status:409,data:{error:'A '+vendor+' request is already in progress.'}};
      busy.add(scope);
      try{
        let length=0,chunks=[];
        for await(const chunk of req){length+=chunk.length;if(length>4096)throw new ReefError('Request too large.',413);chunks.push(chunk);}
        let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw new ReefError('Invalid JSON.',400);}
        if(!obj(body))throw new ReefError('Invalid request.',400);
        if(action==='disconnect'){disconnectScope(scope);return {status:200,data:empty()};}
        if(action==='connect'){
          const recent=(attempts.get(scope)||[]).filter(t=>now()-t<60000);if(recent.length>=5)throw new ReefError('Too many sign-in attempts. Try again in a minute.',429);
          attempts.set(scope,[...recent,now()]);
          const generation=versions.get(scope)||0,client=makeClient();await client.connect(body.username??body.email,body.password,body.region);
          if(!isSessionValid(token)||(versions.get(scope)||0)!==generation)throw new ReefError('Your My Reef session expired.',401);
          clients.set(scope,client);persist(scope,client);return {status:200,data:client.state()};
        }
        const client=clientFor(scope);if(!client)throw new ReefError('Sign in to '+vendor+' first.',401);
        // Manual refresh is distinct from automatic polling, with a small request limit.
        const minimum=body.force===true?5000:refreshInterval;
        if(client.lastAttempt&&now()-Date.parse(client.lastAttempt)<minimum&&body.deviceId===client.selected)return {status:200,data:client.state()};
        return {status:200,data:await refreshClient(scope,client,body.deviceId)};
      }catch(error){return {status:error instanceof ReefError?error.status:502,data:{error:error instanceof ReefError?error.message:'The '+vendor+' request failed.'}};}
      finally{busy.delete(scope);}
    }
  };
}
