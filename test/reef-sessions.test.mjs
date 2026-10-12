import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,scryptSync} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {Readable} from 'node:stream';
import {RedSeaClient,createReefApi} from '../lib/backend.mjs';
import {AquaWizClient} from '../lib/aquawiz.mjs';
import {createSessionStore} from '../lib/session-store.mjs';
import {httpFetch} from '../support/http-helper.mjs';
const fetch=(url,options={})=>httpFetch(url,{...options,headers:{Host:'test.example',...options.headers}});
const json=(data,status=200)=>new Response(JSON.stringify(data),{status});
const req=body=>Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]),{method:'POST'});
const device={id:'reef-device',name:'Tank',model:'RSCONTROLPRO',ip:'192.168.1.80'};
const saved=(token)=>({version:1,token,expires:Date.now()+3600000,devices:[device],aquariums:[],selected:device.id,snapshot:{at:new Date().toISOString(),source:'Saved test reading',sensors:[],ports:[]},history:[{at:new Date().toISOString(),values:[]}],attempts:[]});
function temporary(){const dir=mkdtempSync(join(tmpdir(),'reef-sessions-'));return {dir,path:join(dir,'reef-sessions.enc.json'),keyPath:join(dir,'reef-sessions.key')};}

test('encrypted vault persists independently scoped tokens with owner-only permissions and detects tampering',()=>{
 const files=temporary();
 try{
  let store=createSessionStore(files);
  store.set('/api/reef/','browser-one',{...saved('RED_ACCESS_SECRET'),refreshToken:'REFRESH_SECRET',vendor:'/api/reef/'});
  store.set('/api/aquawiz/','browser-one',{...saved('AQUA_ACCESS_SECRET'),vendor:'/api/aquawiz/'});
  const raw=readFileSync(files.path,'utf8');assert.doesNotMatch(raw,/RED_ACCESS_SECRET|REFRESH_SECRET|AQUA_ACCESS_SECRET|browser-one/);
  assert.equal(statSync(files.path).mode&0o777,0o600);assert.equal(statSync(files.keyPath).mode&0o777,0o600);
  store=createSessionStore(files);assert.equal(store.get('/api/reef/','browser-one').refreshToken,'REFRESH_SECRET');assert.equal(store.get('/api/reef/','browser-two'),null);
  store.prune('/api/reef/',new Map());assert.equal(store.get('/api/reef/','browser-one'),null);assert.ok(store.get('/api/aquawiz/','browser-one'));
  const envelope=JSON.parse(readFileSync(files.path,'utf8'));const bytes=Buffer.from(envelope.data,'base64');bytes[0]^=1;envelope.data=bytes.toString('base64');writeFileSync(files.path,JSON.stringify(envelope));
  assert.throws(()=>createSessionStore(files),/could not be decrypted/);
 }finally{rmSync(files.dir,{recursive:true,force:true});}
});

test('Red Sea renews an expired saved token without a password, rotates refresh token, and keeps secrets private',async()=>{
 let now=Date.now(),renewals=0;
 const client=new RedSeaClient({now:()=>now,fetcher:async(url,options)=>{
  if(url.endsWith('/oauth/token')){renewals++;assert.equal(options.body.get('grant_type'),'refresh_token');assert.equal(options.body.get('refresh_token'),'OLD_REFRESH');assert.equal(options.body.has('password'),false);return json({access_token:'NEW_ACCESS',refresh_token:'NEW_REFRESH',expires_in:3600});}
  assert.equal(options.headers.Authorization,'Bearer NEW_ACCESS');return json({probes:[{type:'ec',uid:'s',unit:'ppt',value:35}]});
 }});
 client.restoreSession({...saved('OLD_ACCESS'),refreshToken:'OLD_REFRESH',expires:now-1});assert.equal(client.state().expired,false);
 const state=await client.refresh(device.id);assert.equal(renewals,1);assert.equal(state.snapshot.sensors[0].value,35);assert.equal(client.exportSession().refreshToken,'NEW_REFRESH');assert.doesNotMatch(JSON.stringify(state),/OLD_ACCESS|NEW_ACCESS|NEW_REFRESH|OLD_REFRESH/);
 now+=7200000;assert.equal(client.state().expired,false);
});

test('Red Sea renewal is shared by concurrent reads; HTTP 401 retries only once',async()=>{
 const now=Date.now();let renewals=0;
 const client=new RedSeaClient({now:()=>now,fetcher:async(url,options)=>{
  if(url.endsWith('/oauth/token')){renewals++;await new Promise(resolve=>setTimeout(resolve,5));return json({access_token:'NEW',refresh_token:'ROTATED',expires_in:3600});}
  return json([],options.headers.Authorization==='Bearer OLD'?401:200);
 }});
 client.restoreSession({...saved('OLD'),refreshToken:'REFRESH',expires:now-1});
 await Promise.all([client.cloud('/device'),client.cloud('/aquarium')]);assert.equal(renewals,1);
 client.token='OLD';await client.cloud('/device');assert.equal(renewals,2);
 const rejected=new RedSeaClient({fetcher:async url=>json({},url.endsWith('/oauth/token')?200:401)});
 rejected.restoreSession({...saved('OLD'),refreshToken:'REFRESH'});
 // A malformed renewal must not be accepted as a usable token.
 await assert.rejects(()=>rejected.cloud('/device'),/access token/);
});

test('temporary renewal outage retains the session; denied renewal requires sign-in without deleting history',async()=>{
 const now=Date.now();let status=503;
 const c=new RedSeaClient({now:()=>now,fetcher:async()=>json({},status)});
 c.restoreSession({...saved('ACCESS'),refreshToken:'REFRESH',expires:now-1});
 await assert.rejects(()=>c.cloud('/device'),/503/);assert.equal(c.state().expired,false);assert.equal(c.state().history.length,1);
 status=400;await assert.rejects(()=>c.cloud('/device'),/new sign-in/);assert.equal(c.state().expired,true);assert.equal(c.state().history.length,1);
 const aqua=new AquaWizClient({fetcher:async()=>json({},401)});
 aqua.restoreSession({...saved('AQUA'),username:'owner',region:'china'});await assert.rejects(()=>aqua.read('/api/v1/KH/device/all_field'));
 assert.equal(aqua.state().expired,true);assert.equal(aqua.state().history.length,1);
});

test('saved API sessions migrate on browser re-login, and in-flight sign-in cannot revive a logged-out session',async()=>{
 const files=temporary();
 try{
  const store=createSessionStore(files),valid=new Set(['old','next']);
  store.set('/api/reef/','old',{...saved('ACCESS'),vendor:'/api/reef/'});
  const api=createReefApi({store,isSessionValid:t=>valid.has(t)});api.moveSession('old','next');
  assert.equal((await api.handle({method:'GET'},'/api/reef/state','next')).data.connected,true);assert.equal(store.get('/api/reef/','old'),null);
  api.disconnect('next');assert.equal(store.get('/api/reef/','next'),null);
  let release,started;const ready=new Promise(resolve=>{started=resolve;});const pending=new Promise(resolve=>{release=resolve;});
  const raced=createReefApi({store,isSessionValid:t=>valid.has(t),makeClient:()=>({async connect(){started();await pending;},state(){return {connected:true}},exportSession(){return saved('SECRET')}})});
  const result=raced.handle(req({email:'owner',password:'not-saved'}),'/api/reef/connect','old');await ready;valid.delete('old');raced.disconnect('old');release();
  assert.equal((await result).status,401);assert.equal(store.get('/api/reef/','old'),null);
 }finally{rmSync(files.dir,{recursive:true,force:true});}
});

test('owner connections survive server restart, are shared across signed-in browsers, and survive browser logout',async()=>{
 const files=temporary(),session=randomBytes(32).toString('base64url'),salt=randomBytes(16).toString('hex');
 writeFileSync(join(files.dir,'auth.json'),JSON.stringify({salt,hash:scryptSync('test-password',salt,64).toString('hex')}));
 writeFileSync(join(files.dir,'sessions.json'),JSON.stringify({version:2,authSalt:salt,sessions:{[session]:null}}));
 const store=createSessionStore(files);
 store.set('/api/reef/','owner:'+salt,{...saved('RED_TEST_TOKEN'),refreshToken:'REFRESH_TEST_TOKEN',vendor:'/api/reef/'});
 store.set('/api/aquawiz/','owner:'+salt,{...saved('AQUA_TEST_TOKEN'),username:'test-user',region:'china',vendor:'/api/aquawiz/'});
 const headers={Cookie:'my_reef_session='+session};let child;
 async function start(){child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:'0',MY_REEF_DATA_DIR:files.dir,PUBLIC_ORIGIN:'https://test.example',REEF_POLLING:'off'},stdio:['ignore','pipe','pipe']});const [data]=await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('Server exited');})]);return 'http://127.0.0.1:'+ /port (\d+)/.exec(data.toString())[1];}
 async function stop(){if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}}
 try{
  let base=await start();
  const login=await fetch(base+'/login',{method:'POST',redirect:'manual',headers:{Origin:'https://test.example'},body:new URLSearchParams({password:'test-password',next:'/'})});
  assert.equal(login.headers.get('location'),'/');
  const other={Cookie:login.headers.get('set-cookie').split(';')[0]};
  assert.equal(Object.values(JSON.parse(readFileSync(join(files.dir,'sessions.json'),'utf8')).sessions).every(value=>value===null),true);
  for(let restart=0;restart<2;restart++){
   for(const browser of [headers,other])for(const vendor of ['reef','aquawiz']){const response=await fetch(base+'/api/'+vendor+'/state',{headers:browser});assert.equal(response.status,200);const state=await response.json();assert.equal(state.connected,true);assert.equal(state.selected,device.id);assert.equal(state.history.length,1);assert.equal(state.snapshot.source,'Saved test reading');assert.doesNotMatch(JSON.stringify(state),/TEST_TOKEN|test-user/);}
   await stop();base=await start();
  }
  const logout=await fetch(base+'/logout',{method:'POST',redirect:'manual',headers:{...headers,Origin:'https://test.example'}});assert.equal(logout.status,303);
  await stop();const reopened=createSessionStore(files),owner='owner:'+salt;assert.ok(reopened.get('/api/reef/',owner));assert.ok(reopened.get('/api/aquawiz/',owner));
  base=await start();assert.equal((await fetch(base+'/api/reef/state',{redirect:'manual',headers})).status,401);
  assert.equal((await (await fetch(base+'/api/reef/state',{headers:other})).json()).connected,true);
  const disconnect=await fetch(base+'/api/aquawiz/disconnect',{method:'POST',headers:{...other,Origin:'https://test.example','Content-Type':'application/json'},body:'{}'});assert.equal((await disconnect.json()).connected,false);
  await stop();assert.equal(createSessionStore(files).get('/api/aquawiz/',owner),null);assert.ok(createSessionStore(files).get('/api/reef/',owner));
 }finally{await stop();rmSync(files.dir,{recursive:true,force:true});}
});

test('API persists rotated Red Sea tokens and updated AquaWiz tokens for the next process',async()=>{
 const files=temporary(),now=Date.now();
 try{
  const store=createSessionStore(files);
  store.set('/api/reef/','owner',{...saved('OLD'),refreshToken:'OLD_REFRESH',expires:now-1,lastAttempt:null,vendor:'/api/reef/'});
  const reef=createReefApi({store,makeClient:()=>new RedSeaClient({now:()=>now,fetcher:async url=>url.endsWith('/oauth/token')?json({access_token:'ROTATED',refresh_token:'ROTATED_REFRESH',expires_in:3600}):json({probes:[]})})});
  assert.equal((await reef.handle(req({deviceId:device.id}),'/api/reef/refresh','owner')).status,200);
  store.set('/api/aquawiz/','owner',{...saved('AQUA_OLD'),username:'user',region:'global',lastAttempt:null,vendor:'/api/aquawiz/'});
  const aqua=createReefApi({store,prefix:'/api/aquawiz/',makeClient:()=>new AquaWizClient({now:()=>now,fetcher:async url=>url.endsWith('/all_field')?json({latest_kh:8000,latest_time:now,access_token:'AQUA_ROTATED',tokenExp:now+30*86400000}):json({results:[]})})});
  assert.equal((await aqua.handle(req({deviceId:device.id}),'/api/aquawiz/refresh','owner')).status,200);
  const reopened=createSessionStore(files);assert.equal(reopened.get('/api/reef/','owner').refreshToken,'ROTATED_REFRESH');assert.equal(reopened.get('/api/aquawiz/','owner').token,'AQUA_ROTATED');
  assert.equal(reopened.get('/api/aquawiz/','owner').expires,now+30*86400000);
  assert.doesNotMatch(readFileSync(files.path,'utf8'),/ROTATED|password|user/);
 }finally{rmSync(files.dir,{recursive:true,force:true});}
});

test('background polling refreshes the shared owner without a browser and multiple browsers see the same latest state',async()=>{
 const files=temporary();let now=Date.now(),reads=0;
 try{
  const store=createSessionStore(files),owner='owner';
  store.set('/api/reef/',owner,{...saved('READ_TOKEN'),lastAttempt:null,vendor:'/api/reef/'});
  const api=createReefApi({store,sharedScope:owner,now:()=>now,isSessionValid:t=>['web','app'].includes(t),makeClient:()=>new RedSeaClient({now:()=>now,fetcher:async()=>{reads++;return json({probes:[{type:'ec',uid:'salinity',unit:'ppt',value:35+reads/100}]});}})});
  await Promise.all([api.poll(),api.poll()]);assert.equal(reads,1);
  const web=(await api.handle({method:'GET'},'/api/reef/state','web')).data;
  const app=(await api.handle({method:'GET'},'/api/reef/state','app')).data;assert.deepEqual(web,app);assert.equal(web.snapshot.sensors[0].value,35.01);
  assert.equal((await api.handle({method:'GET'},'/api/reef/state','unauthenticated')).status,401);
  now+=60000;await api.poll();assert.equal(reads,2);
  now+=10000;await api.handle(req({deviceId:device.id,force:true}),'/api/reef/refresh','app');assert.equal(reads,3);
  await api.poll();assert.equal(reads,3);
  api.disconnect('web');await api.poll();assert.equal((await api.handle({method:'GET'},'/api/reef/state','app')).data.connected,false);assert.equal(store.get('/api/reef/',owner),null);
 }finally{rmSync(files.dir,{recursive:true,force:true});}
});

test('migration chooses the most recently used saved vendor connection and keeps an existing owner connection',()=>{
 const files=temporary();
 try{
  const store=createSessionStore(files),sessions=new Map([['older',null],['newer',null]]);
  store.set('/api/reef/','older',{...saved('OLD'),lastAttempt:'2026-10-11T10:00:00Z',vendor:'/api/reef/'});
  store.set('/api/reef/','newer',{...saved('NEW'),lastAttempt:'2026-10-11T11:00:00Z',vendor:'/api/reef/'});
  store.promote('/api/reef/','owner',sessions);assert.equal(store.get('/api/reef/','owner').token,'NEW');
  store.set('/api/reef/','newer',{...saved('DIFFERENT'),lastAttempt:'2026-10-11T12:00:00Z',vendor:'/api/reef/'});
  store.promote('/api/reef/','owner',sessions);assert.equal(store.get('/api/reef/','owner').token,'NEW');
  store.prune('/api/reef/',new Map([['owner',null]]));assert.equal(store.get('/api/reef/','newer'),null);assert.ok(store.get('/api/reef/','owner'));
 }finally{rmSync(files.dir,{recursive:true,force:true});}
});
