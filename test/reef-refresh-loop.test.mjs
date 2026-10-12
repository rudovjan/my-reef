import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRefreshLoop} from '../public/refresh-loop.js';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function timers(){let callback=null;return {setTimer(fn){callback=fn;return 1;},clearTimer(){callback=null;},async tick(){const fn=callback;callback=null;if(fn)await fn();},pending(){return !!callback;}};}
test('refresh begins immediately, repeats while visible, and resumes immediately after background suspension',async()=>{
 const clock=timers();let visible=true,reads=0;
 const loop=createRefreshLoop({...clock,refresh:async()=>{reads++;},isVisible:()=>visible});
 await loop.start();assert.equal(reads,1);assert.equal(clock.pending(),true);
 await clock.tick();assert.equal(reads,2);
 visible=false;loop.pause();await loop.wake();assert.equal(reads,2);assert.equal(clock.pending(),false);
 visible=true;await loop.wake();assert.equal(reads,3);assert.equal(clock.pending(),true);loop.stop();assert.equal(clock.pending(),false);
});
test('resume during an in-flight request queues a fresh read rather than being dropped',async()=>{
 const clock=timers();let release,reads=0;
 const suspended=new Promise(resolve=>{release=resolve;});
 const loop=createRefreshLoop({...clock,refresh:async()=>{reads++;if(reads===1)await suspended;}});
 const start=loop.start();await flush();assert.equal(reads,1);
 void loop.wake();void loop.wake();release();await start;await flush();assert.equal(reads,2);assert.equal(clock.pending(),true);loop.stop();
});
test('failed or timed-out reads are retried and cannot permanently stop the loop',async()=>{
 const clock=timers();let reads=0,errors=0;
 const loop=createRefreshLoop({...clock,refresh:async()=>{reads++;if(reads===1)throw Error('Timed out');},onError:()=>{errors++;}});
 await loop.start();assert.equal(errors,1);assert.equal(clock.pending(),true);
 await clock.tick();assert.equal(reads,2);assert.equal(clock.pending(),true);
 await loop.wake();assert.equal(reads,3);loop.stop();
});
