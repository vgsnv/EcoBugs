import type { Grid } from './model.ts';
export interface Checkpoint {
 version:'ecobugs-gpu-1';grid:Grid;step:number;current:number;pressureIndex:number;
 buffers:{label:string;bytes:Uint8Array}[];sources:unknown;funnels:unknown;geology:unknown;
 sourceUpdateStep:number;markerCells:number[];previousVentRates:Float32Array|null;
}
const types={Uint8Array,Uint32Array,Int32Array,Float32Array,Float64Array};
export function encodeCheckpoint(value:Checkpoint):string{
 return JSON.stringify(value,(_key,v)=>{
  if(!ArrayBuffer.isView(v))return v;
  const bytes=new Uint8Array(v.buffer,v.byteOffset,v.byteLength);let binary='';
  for(let i=0;i<bytes.length;i+=4096)binary+=String.fromCharCode(...bytes.subarray(i,i+4096));
  return {array:v.constructor.name,data:btoa(binary)};
 });
}
export function decodeCheckpoint(text:string):Checkpoint{
 const value=JSON.parse(text,(_key,v)=>{
  if(!v||typeof v!=='object'||!('array'in v))return v;
  const ctor=types[v.array as keyof typeof types];if(!ctor||typeof v.data!=='string')throw new Error('Неизвестный массив сохранения.');
  const binary=atob(v.data),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
  return new ctor(bytes.buffer);
 }) as Checkpoint;
 if(value.version!=='ecobugs-gpu-1'||!Number.isSafeInteger(value.step)||value.step<0||!value.grid||!Array.isArray(value.buffers)
  ||![0,1].includes(value.current)||![0,1].includes(value.pressureIndex))throw new Error('Несовместимое или повреждённое сохранение.');
 return value;
}
