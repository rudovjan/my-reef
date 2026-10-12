import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {RedSeaClient,normalizeDashboard,privateIPv4,createReefApi} from '../lib/backend.mjs';

const DEVICE={hwid:'aabbccddeeff',type:'reef-control',model:'RSCONTROLPRO',name:'My controller',ip_address:'192.168.1.80',aquarium_uid:'tank1'};
const DASH={mode:'auto',probes:[
 {uid:'t1',type:'temperature',name:'Water',status:'auto',value:25.2,ranges:[21,23,26,28]},
 {uid:'p1',type:'ph',status:'auto',value:8.15,temp_value:25.1},
 {uid:'e1',type:'ec',status:'auto',unit:'ppt',value:34.7,temp:25.3},
 {uid:'l1',type:'leak',status:'auto',detected:false},
 {uid:'a1',type:'ato',status:'auto',water_level:'below',temp:25},
],ports:[{number:0,name:'S1',mode:'off',state:'off'}],buzzer:{active:false}};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
function fixture({cloud=true,local=true,devices=[DEVICE],expires=2700}={}) {
 const calls=[];
 const fetcher=async(url,options)=>{calls.push({url,options});const path=new URL(url).pathname;
 if(path==='/oauth/token')return json({access_token:'SECRET_ACCESS_TOKEN',expires_in:expires});
 if(path==='/device')return json(devices);
 if(path==='/aquarium')return json([{uid:'tank1',name:'My Reef'}]);
 if(url.startsWith('http://'))return local?json(DASH):json({},503);
 if(path.endsWith('/dashboard'))return cloud?json(DASH):json({},404);
 throw Error('Unexpected request '+url);};
 return {fetcher,calls};
}
test('normalizes actual ReefControl fields, units, temperature variants, and binary probes',()=>{
 const normalized=normalizeDashboard(DASH);
 assert.equal(normalized.sensors.find(s=>s.id==='ec:e1').unit,'ppt');
 assert.equal(normalized.sensors.find(s=>s.id==='ph:p1:temp').value,25.1);
 assert.equal(normalized.sensors.find(s=>s.id==='ec:e1:temp').value,25.3);
 assert.equal(normalized.sensors.find(s=>s.type==='leak').value,'Dry');
 assert.equal(normalized.sensors.find(s=>s.type==='ato').value,'below');
 assert.equal(normalized.ports[0].number,0);
});
test('disconnected, disabled, unknown, and out-of-range values stay truthful',()=>{
 const data=normalizeDashboard({probes:[
 {uid:'1',type:'temperature',status:'offline',value:25},
 {uid:'2',type:'ph',enabled:false,value:8},
 {uid:'3',type:'temperature',value:0,ranges:[21,23,26,28]},
 {uid:'4',type:'ph',value:'8.1'},
 {uid:'5',type:'leak',detected:true},
 {uid:'6',type:'ec',unit:'sg',value:1.0264},
 ]});
 assert.equal(data.sensors[0].value,null);
 assert.equal(data.sensors[1].available,false);
 assert.equal(data.sensors[2].value,0);
 assert.equal(data.sensors[2].status,'Outside acceptable range');
 assert.equal(data.sensors[3].value,null);
 assert.equal(data.sensors[4].status,'Leak detected');
 assert.equal(data.sensors[5].unit,'SG');
 assert.throws(()=>normalizeDashboard({success:true}),/probes/);
});
test('local targets permit only private IPv4 literals; no DNS, loopback, ports, metadata, or URLs',()=>{
 for(const ip of ['192.168.1.80','10.2.3.4','172.16.0.2','172.31.2.5'])assert.equal(privateIPv4(ip),true);
 for(const ip of ['127.0.0.1','169.254.169.254','172.32.0.2','8.8.8.8','192.168.1.256','192.168.1.0','192.168.1.255','localhost','192.168.1.80:8000','http://192.168.1.80','[::1]'])assert.equal(privateIPv4(ip),false,ip);
});
test('cloud sign-in encodes special characters and never exposes account secrets',async()=>{
 const f=fixture();const client=new RedSeaClient(f);
 await client.connect('you+reef@example.com','a&b=c%xyz');
 const body=f.calls[0].options.body;
 assert.equal(body.get('username'),'you+reef@example.com');
 assert.equal(body.get('password'),'a&b=c%xyz');
 const state=await client.refresh(DEVICE.hwid);
 assert.equal(state.snapshot.sensors[0].value,25.2);
 assert.match(state.snapshot.source,/cloud/);
 assert.equal(f.calls.some(c=>c.url.startsWith('http://')),false);
 assert.equal(JSON.stringify(state).includes('SECRET_ACCESS_TOKEN'),false);
 assert.equal(JSON.stringify(state).includes('a&b=c%xyz'),false);
 for(const call of f.calls)assert.equal(call.options.redirect,'error');
});
test('failed experimental cloud reads fall back to the documented direct device endpoint',async()=>{
 const f=fixture({cloud:false});const client=new RedSeaClient(f);
 await client.connect('a@b.c','pass');
 const state=await client.refresh(DEVICE.hwid);
 assert.match(state.snapshot.source,/Direct device/);
 assert.equal(state.attempts[0].ok,false);assert.equal(state.attempts[1].ok,true);
 assert.equal(f.calls.at(-1).url,'http://192.168.1.80/dashboard');
 assert.equal(f.calls.at(-1).options.headers,undefined);
});
test('public IP from inventory is not fetched and missing probes never show connected readings',async()=>{
 const f=fixture({cloud:false,devices:[{...DEVICE,ip_address:'169.254.169.254'}]});
 const client=new RedSeaClient(f);await client.connect('a@b.c','pass');
 const state=await client.refresh(DEVICE.hwid);
 assert.equal(state.devices[0].ip,null);assert.equal(state.snapshot,null);
 assert.match(state.error,/Could not refresh/);
 assert.equal(f.calls.some(c=>c.url.startsWith('http://')),false);
});
test('failed refresh keeps previous readings labeled stale rather than inventing new samples',async()=>{
 let working=true,t=Date.now();const f=fixture();
 const client=new RedSeaClient({now:()=>t,fetcher:(url,options)=>url.endsWith('/dashboard')&&!working?Promise.resolve(json({},503)):f.fetcher(url,options)});
 await client.connect('a@b.c','pass');await client.refresh(DEVICE.hwid);
 const at=client.state().snapshot.at;working=false;t+=60000;
 const state=await client.refresh(DEVICE.hwid);
 assert.equal(state.stale,true);assert.equal(state.snapshot.at,at);assert.equal(state.history.length,1);
});
test('expiry requires reauthentication and history samples are limited to one per minute',async()=>{
 let t=Date.now();const f=fixture({expires:60});const client=new RedSeaClient({...f,now:()=>t});
 await client.connect('a@b.c','pass');await client.refresh(DEVICE.hwid);await client.refresh(DEVICE.hwid);
 assert.equal(client.state().history.length,1);
 t+=60001;assert.equal(client.state().expired,true);
 await assert.rejects(()=>client.cloud('/device'),/expired/);
});
const req=body=>Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]),{method:'POST'});
test('API isolates accounts by browser session and disconnect discards token and history',async()=>{
 const api=createReefApi({makeClient:()=>new RedSeaClient(fixture())});
 let result=await api.handle(req({email:'a@b.c',password:'secret'}),'/api/reef/connect','one');
 assert.equal(result.status,200);
 assert.equal((await api.handle({method:'GET'},'/api/reef/state','two')).data.connected,false);
 await api.handle(req({deviceId:DEVICE.hwid}),'/api/reef/refresh','one');
 assert.equal((await api.handle({method:'GET'},'/api/reef/state','one')).data.history.length,1);
 assert.equal(JSON.stringify(result).includes('SECRET_ACCESS_TOKEN'),false);
 await api.handle(req({}),'/api/reef/disconnect','one');
 assert.equal((await api.handle({method:'GET'},'/api/reef/state','one')).data.connected,false);
 await api.handle(req({email:'a@b.c',password:'secret'}),'/api/reef/connect','one');
 api.prune(new Map());
 assert.equal((await api.handle({method:'GET'},'/api/reef/state','one')).data.connected,false);
});
test('rejects invalid requests, oversized credentials, and unavailable Red Sea authentication',async()=>{
 const api=createReefApi();
 assert.equal((await api.handle(req(null),'/api/reef/connect','one')).status,400);
 assert.equal((await api.handle(req({email:'a',password:'x'.repeat(5000)}),'/api/reef/connect','one')).status,413);
 assert.equal((await api.handle(req({}),'/api/reef/refresh','one')).status,401);
 const client=new RedSeaClient({fetcher:async()=>json({error:'invalid_grant'},400)});
 await assert.rejects(()=>client.connect('a@b.c','wrong'),/email or password/);
});
