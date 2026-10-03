import { periodicFbm } from '../generation/noise.ts';
/** The original world's exact 256px seamless ripple, uploaded once per GPU world. */
export function rippleBytes():Uint8Array {
 const size=256,bytes=new Uint8Array(size*size*4),a=periodicFbm(0x51f7,4,4,2),b=periodicFbm(0x9e37,4,4,2);
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){
  const n=a(x/size*4,y/size*4)+b(x/size*4+.37,y/size*4+.61),k=(y*size+x)*4;
  bytes.set([255,250,230,Math.round(Math.max(0,1-Math.abs(n)*6)**3*255)],k);
 }
 return bytes;
}
