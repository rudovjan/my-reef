// Display preferences only: these limits never change equipment settings.
export function validRange(value){return Array.isArray(value)&&value.length===2&&value.every(Number.isFinite)&&value[0]<value[1];}
export function colorRange(sensor,khRange,targetKH){
 if(sensor.type==='ec'&&sensor.unit==='ppt')return [34,36];
 if(sensor.type==='alkalinity'){
  if(validRange(khRange))return khRange;
  return Number.isFinite(targetKH)&&targetKH>0.5?[Number((targetKH-0.5).toFixed(3)),Number((targetKH+0.5).toFixed(3))]:null;
 }
 const range=Array.isArray(sensor.ranges)?[sensor.ranges[1],sensor.ranges[2]]:null;
 return validRange(range)?range:null;
}
export function readingState(sensor,range){
 if(sensor.stale)return {tone:'unknown',label:'Stale reading'};
 if(sensor.available===false||sensor.value===null||sensor.value===undefined)return {tone:'unknown',label:sensor.status||'Unavailable'};
 if(typeof sensor.value!=='number'||!Number.isFinite(sensor.value)||!validRange(range))return {tone:'unknown',label:sensor.status==='Reading available'?'No target range':sensor.status||'No target range'};
 return sensor.value<range[0]?{tone:'bad',label:'Below range'}:sensor.value>range[1]?{tone:'bad',label:'Above range'}:{tone:'good',label:'In range'};
}
