type Sample=Pick<PointerEvent,'pointerId'|'pointerType'|'button'|'buttons'|'isPrimary'|'clientX'|'clientY'>;

/** Pointer lifecycle independent of rendering, including missing pointerup events. */
export class PanGesture {
 active:{id:number;x:number;y:number;startX:number;startY:number;moved:boolean}|null=null;
 begin(e:Sample):boolean{
  if(e.button!==0||!e.isPrimary)return false;
  this.active={id:e.pointerId,x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY,moved:false};return true;
 }
 move(e:Sample):{x:number;y:number}|null{
  const a=this.active;if(!a||a.id!==e.pointerId)return null;
  if(e.pointerType==='mouse'&&(e.buttons&1)===0){this.cancel();return null;}
  if(Math.hypot(e.clientX-a.startX,e.clientY-a.startY)>4)a.moved=true;
  const delta=a.moved?{x:e.clientX-a.x,y:e.clientY-a.y}:null;
  a.x=e.clientX;a.y=e.clientY;return delta;
 }
 cancel():number|undefined{const id=this.active?.id;this.active=null;return id;}
}

/** The visible viewport must include the outside rim when panned to a cup edge. */
export function cameraLimits(worldWidth:number,worldHeight:number,viewportWidth:number,viewportHeight:number,rim:number){
 return {x:Math.min(.5,(viewportWidth*.5-rim)/worldWidth),y:Math.min(.5,(viewportHeight*.5-rim)/worldHeight)};
}
