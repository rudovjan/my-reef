import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AquaWizClient,normalizeAquaWiz,normalizeAquaHistory} from '../lib/aquawiz.mjs';
import {createReefApi} from '../lib/backend.mjs';
import {Readable} from 'node:stream';
const NOW=Date.parse('2026-10-11T16:00:00Z'),SERIAL='KH1-00-12345';
const fields={latest_kh:'8123',latest_time:String(NOW-3600000),field8:'8500',field14:'1200'};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status});
function fixture({historyFails=false}={}){
 const calls=[];const fetcher=async(url,options)=>{calls.push({url,options});if(url.endsWith('/auth'))return json({access_token:'AQUA_SECRET',tokenExp:String(NOW+86400000),user:{devices:[SERIAL,'CA1-00-54321'],email:'private@example.com'}});
 if(url.endsWith('/all_field'))return json({...fields,access_token:'AQUA_RENEWED_SECRET',tokenExp:NOW+2*86400000});
 if(url.endsWith('/graphs'))return historyFails?json({},503):json({results:[[NOW-7200000,{field22:8070}],[NOW-3600000,{field22:8123}]]});
 throw Error('Unexpected URL');};return {fetcher,calls};
}
test('AquaWiz millidKH and measurement time follow the vendor web-app conversions',()=>{
 const s=normalizeAquaWiz(fields,SERIAL,NOW);
 assert.equal(s.sensors[0].value,8.123);assert.equal(s.targetKH,8.5);
 assert.equal(s.measuredAt,new Date(NOW-3600000).toISOString());
 assert.equal(s.supplementRemainingMl,1200);
 for(const latest_kh of [null,'',false,'not a number',0,-1])assert.equal(normalizeAquaWiz({...fields,latest_kh},SERIAL,NOW).sensors[0].value,null);
 assert.equal(normalizeAquaWiz({...fields,latest_time:1},SERIAL,NOW).measuredAt,null);
 assert.throws(()=>normalizeAquaWiz({success:true},SERIAL,NOW),/alkalinity/);
});
test('graph history rejects malformed points, deduplicates times, sorts, and preserves actual measurement timestamps',()=>{
 const rows=[[NOW-3600000,{field22:'8123'}],[NOW-7200000,{field22:8000}],[NOW-3600000,{field22:8123}],[NOW-8*86400000,{field22:8000}],[NOW+86400000,{field22:8000}],['bad',{field22:8000}],[NOW-1,{field22:null}],[NOW-2,{field22:0}]];
 const h=normalizeAquaHistory({results:rows},SERIAL,NOW);
 assert.equal(h.length,2);assert.equal(h[0].values[0].value,8);assert.equal(h[1].values[0].value,8.123);
 assert.throws(()=>normalizeAquaHistory({},SERIAL,NOW),/history format/);
});
test('direct AquaWiz login discovers KH devices; reading and history requests match the public bundle',async()=>{
 const f=fixture();const c=new AquaWizClient({...f,now:()=>NOW});
 await c.connect('myuser','my&password');assert.equal(c.devices.length,1);
 const auth=JSON.parse(f.calls[0].options.body);assert.deepEqual(auth,{user:'myuser',password:'my&password',token:{access_token:''}});
 const state=await c.refresh(SERIAL);
 assert.equal(state.history.length,2);assert.equal(state.stale,false);
 const read=f.calls.find(r=>r.url.endsWith('/all_field'));
 assert.equal(read.url,'https://server.aquawiz.net/api/v1/KH/'+SERIAL+'/all_field');
 assert.equal(read.options.headers.Authorization,'Bearer AQUA_SECRET');
 assert.deepEqual(JSON.parse(read.options.body),{user:'myuser',password:'',appid:1,token:{access_token:'AQUA_SECRET'}});
 const graph=f.calls.find(r=>r.url.endsWith('/graphs'));
 assert.equal(graph.options.headers.Authorization,'Bearer AQUA_RENEWED_SECRET');
 assert.equal(JSON.parse(graph.options.body).date,new Date(NOW-7*86400000).toISOString());
 assert.equal(state.expiresAt,new Date(NOW+2*86400000).toISOString());
 assert.doesNotMatch(JSON.stringify(state),/AQUA_SECRET|AQUA_RENEWED_SECRET|my&password|private@example.com/);
});
test('history failure does not suppress the latest KH; repeated syncs do not fabricate extra samples',async()=>{
 const f=fixture({historyFails:true});const c=new AquaWizClient({...f,now:()=>NOW});
 await c.connect('user','password');let state=await c.refresh(SERIAL);
 assert.equal(state.snapshot.sensors[0].value,8.123);assert.match(state.historyError,/history/);assert.equal(state.history.length,1);
 state=await c.refresh(SERIAL);assert.equal(state.history.length,1);
});
test('cloud region is allowlisted, missing or old timestamps are stale, expired token requires sign-in',async()=>{
 const f=fixture();let time=NOW;const c=new AquaWizClient({...f,now:()=>time});
 await assert.rejects(()=>c.connect('user','password','http://localhost'),/region/);
 await c.connect('user','password','china');assert.match(f.calls[0].url,/server.aquawiz.cn/);
 await c.refresh(SERIAL);time+=3*86400000;assert.equal(c.state().stale,true);assert.equal(c.state().expired,true);
 await assert.rejects(()=>c.read('/anything'),/expired/);
 await assert.rejects(()=>c.refresh('CA1-00-54321'),/KH controller/);
});
test('shared authenticated API supports independent AquaWiz sessions and username login',async()=>{
 const f=fixture();const api=createReefApi({prefix:'/api/aquawiz/',vendor:'AquaWiz',refreshInterval:600000,makeClient:()=>new AquaWizClient({...f,now:()=>NOW})});
 const req=data=>Object.assign(Readable.from([Buffer.from(JSON.stringify(data))]),{method:'POST'});
 assert.equal((await api.handle(req({username:'user',password:'pass'}),'/api/aquawiz/connect','owner')).status,200);
 assert.equal((await api.handle({method:'GET'},'/api/aquawiz/state','other')).data.connected,false);
 const read=await api.handle(req({deviceId:SERIAL}),'/api/aquawiz/refresh','owner');
 assert.equal(read.data.snapshot.sensors[0].unit,'dKH');
 assert.equal((await api.handle(req({}),'/api/aquawiz/disconnect','owner')).data.connected,false);
});
