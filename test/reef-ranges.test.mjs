import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validRange,colorRange,readingState} from '../public/ranges.js';
test('owner salinity limits override device limits and include both green boundaries',()=>{
 const sensor={type:'ec',value:35,unit:'ppt',ranges:[25,32,38,42],available:true,status:'Reading available'};
 const range=colorRange(sensor,null,null);assert.deepEqual(range,[34,36]);
 for(const value of [34,35,36])assert.equal(readingState({...sensor,value},range).tone,'good');
 for(const value of [33.99,36.01])assert.equal(readingState({...sensor,value},range).tone,'bad');
 assert.equal(readingState({...sensor,value:33},range).label,'Below range');assert.equal(readingState({...sensor,value:37},range).label,'Above range');
 assert.deepEqual(colorRange({...sensor,unit:'mS/cm',ranges:[40,50,55,60]},null,null),[50,55]);
 assert.deepEqual(colorRange({...sensor,unit:'SG',ranges:[1.02,1.024,1.026,1.03]},null,null),[1.024,1.026]);
});
test('KH uses explicit custom limits or target tolerance; missing target does not invent a range',()=>{
 const kh={type:'alkalinity',unit:'dKH'};
 assert.deepEqual(colorRange(kh,null,8),[7.5,8.5]);assert.deepEqual(colorRange(kh,[7,9],8),[7,9]);
 assert.equal(colorRange(kh,null,null),null);assert.equal(colorRange(kh,null,NaN),null);
 for(const range of [[9,7],[8,8],[NaN,9],['7',9],null])assert.equal(validRange(range),false);
});
test('missing, stale, unavailable and unbounded readings never appear green',()=>{
 const sensor={value:8,available:true,status:'Reading available'};
 for(const change of [{value:null},{value:undefined},{value:NaN},{stale:true},{available:false}])assert.equal(readingState({...sensor,...change},[7,9]).tone,'unknown');
 assert.equal(readingState(sensor,null).tone,'unknown');assert.equal(readingState({...sensor,stale:true},[7,9]).label,'Stale reading');
});
