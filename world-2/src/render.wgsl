struct View { cols: u32, rows: u32, cell: f32, time: f32, arrows: u32, burstAndSeed: u32, pad0: u32, pad1: u32, appearance:vec4f, camera:vec4f }
@group(0) @binding(0) var<uniform> view: View;
struct Surface{geometry:vec4f,climate:vec4f}
@group(0) @binding(1) var<storage, read> surface: array<Surface>;
@group(0) @binding(2) var<storage, read> state: array<vec4u>;
@group(0) @binding(3) var<storage, read> flow: array<vec2f>;
struct LightSettings { cols:u32,rows:u32,regions:u32,count:u32,time:f32,drift:f32,sun:f32,background:f32,rhythm:f32,contrast:f32,entrainment:f32,pad:f32,world:vec4f,offset:vec4f,cycle:vec4f,spatial:vec4f }
struct Ellipse {a:vec4f,b:vec4f,c:vec4f}
struct Blob {a:vec4f,b:vec4f,c:vec4f,d:vec4f,e:vec4f,f:vec4f,ellipse:Ellipse,next:u32,pad0:u32,pad1:u32,pad2:u32}
@group(0) @binding(4) var<storage,read> blobs:array<Blob>;
@group(0) @binding(5) var<storage,read> lightHeads:array<u32>;
struct Marker { state:vec4f,animation:vec4f }
@group(0) @binding(6) var<storage,read> markers:array<Marker>;
@group(0) @binding(7) var<storage,read> terrain:array<vec4u>;
@group(0) @binding(8) var<storage,read> material:array<vec4f>;
@group(0) @binding(9) var rippleTexture:texture_2d<f32>;
@group(0) @binding(10) var rippleSampler:sampler;
@group(0) @binding(11) var<uniform> lightSettings:LightSettings;
struct GlassGeometry { info:vec4f, segments:array<vec4f,64> }
@group(0) @binding(12) var<uniform> glassGeometry:GlassGeometry;
struct Varying { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vertex(@builtin(vertex_index) i: u32) -> Varying {
  let p = array<vec2f, 3>(vec2f(-1., -1.), vec2f(3., -1.), vec2f(-1., 3.))[i];
  return Varying(vec4f(p, 0., 1.), vec2f(p.x * .5 + .5, .5 - p.y * .5));
}
// Interpolate the physical field without colouring through walls, corners or hole lips.
fn levels(k:u32,px:i32,py:i32)->vec3f {
  let own=vec3f(f32(state[k].x),f32(terrain[k].x),f32(terrain[k].y))*view.appearance.x/(view.cell*view.cell);
  if(px<0||py<0||px>=i32(view.cols)||py>=i32(view.rows)){return own;}
  let j=u32(py)*view.cols+u32(px);let x=i32(k%view.cols);let y=i32(k/view.cols);
  if(surface[j].geometry.z>.5||(surface[j].geometry.w>.5)!=(surface[k].geometry.w>.5)){return own;}
  if(px!=x&&py!=y&&(surface[u32(y)*view.cols+u32(px)].geometry.z>.5||surface[u32(py)*view.cols+u32(x)].geometry.z>.5
    ||(surface[u32(y)*view.cols+u32(px)].geometry.w>.5)!=(surface[k].geometry.w>.5)||(surface[u32(py)*view.cols+u32(x)].geometry.w>.5)!=(surface[k].geometry.w>.5))){return own;}
  return vec3f(f32(state[j].x),f32(terrain[j].x),f32(terrain[j].y))*view.appearance.x/(view.cell*view.cell);
}
fn nearby(k:u32,x:i32,y:i32)->u32{
 if(x<0||y<0||x>=i32(view.cols)||y>=i32(view.rows)){return k;}let j=u32(y)*view.cols+u32(x);if(surface[j].geometry.z>.5||(surface[j].geometry.w>.5)!=(surface[k].geometry.w>.5)){return k;}return j;
}
fn lightAt(k:u32,x:i32,y:i32)->f32{
 let climate=surface[nearby(k,x,y)].climate;let cfg=lightSettings;
 var wave=sin(cfg.time*.1+.7);if(cfg.count>0u){wave=sin(cfg.time*6.2831853/cfg.cycle.x+cfg.cycle.y);}
 return cfg.sun*(1.+cfg.rhythm*wave)*mix(cfg.background,1.,climate.x)*climate.y;
}
fn temperatureAt(k:u32,x:i32,y:i32)->f32{return surface[nearby(k,x,y)].climate.z;}
fn materialAt(k:u32,x:i32,y:i32)->vec4f{return material[nearby(k,x,y)];}
// Same prepared ellipses and spatial bins as physics; visual edge width follows pixels.
fn visualSpot(pos:vec2f,pixel:f32)->f32{
 let cfg=lightSettings;let size=vec2i(cfg.spatial.xy);let period=cfg.world.xy*2.;
 let wrapped=pos-floor(pos/period)*period;let center=vec2i(wrapped/period*cfg.spatial.xy);var intensity=0.;
 for(var dy=-min(1,size.y-1);dy<=min(1,size.y-1);dy++){
  for(var dx=-min(1,size.x-1);dx<=min(1,size.x-1);dx++){
   let bin=(center+vec2i(dx,dy)+size)%size;var i=lightHeads[u32(bin.y*size.x+bin.x)];
   loop{
    if(i==0xffffffffu){break;}let e=blobs[i].ellipse;i=blobs[i].next;
    var delta=pos-e.a.xy;delta-=round(delta/period)*period;
    if(abs(delta.x)>e.c.z||abs(delta.y)>e.c.z){continue;}
    let uv=vec2f(dot(delta,e.b.xy)*e.a.z,dot(delta,vec2f(-e.b.y,e.b.x))*e.a.w);
    let angle=atan2(uv.y,uv.x);let boundary=1.+e.c.x*sin(3.*angle+e.b.z)+e.c.y*sin(5.*angle+e.b.w);
    let edge=max(.09,max(pixel,e.c.z*.035)*max(e.a.z,e.a.w)*2.);
    intensity=max(intensity,1.-smoothstep(boundary-edge,boundary+edge,length(uv)));
   }
  }
 }
 return intensity;
}
// Integer hashing keeps material anchored to the world, without animated screen noise.
fn grainHash(p:vec2i)->f32 {
  var h=(bitcast<u32>(p.x)*1597334677u) ^ (bitcast<u32>(p.y)*3812015801u) ^ (view.burstAndSeed>>1u);
  h=(h^(h>>16u))*2246822519u;h=(h^(h>>13u))*3266489917u;
  return f32((h^(h>>16u))>>8u)/16777216.;
}
fn stoneNoise(p:vec2f)->f32 {
  let i=vec2i(floor(p));let f=fract(p);let t=f*f*(3.-2.*f);
  return mix(mix(grainHash(i),grainHash(i+vec2i(1,0)),t.x),mix(grainHash(i+vec2i(0,1)),grainHash(i+vec2i(1,1)),t.x),t.y);
}
// Cellular slab borders, as in the original stone material; evaluated only at resolved scales.
fn fracturedStone(p:vec2f)->f32{
 let cell=vec2i(floor(p));var first=100.;var second=100.;
 for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
  let q=cell+vec2i(x,y);let site=vec2f(q)+vec2f(grainHash(q),grainHash(q+vec2i(37,59)));
  let distance=dot(site-p,site-p);
  if(distance<first){second=first;first=distance;}else if(distance<second){second=distance;}
 }}
 return sqrt(second)-sqrt(first);
}
fn stoneMottle(mm:vec2f,pixel:f32)->f32{
 return (filteredStone(mm,40.,pixel)-.5)*1.07+(filteredStone(mm+vec2f(13.,47.),20.,pixel)-.5)*.53+(filteredStone(mm+vec2f(31.,19.),10.,pixel)-.5)*.27+(filteredStone(mm,5.,pixel)-.5)*.13;
}
// SHARED_GLASS_MATERIAL
fn glassDistance(mm:vec2f)->f32{
 var distance=1e8;
 for(var i=0u;i<u32(glassGeometry.info.x);i++){
  let segment=glassGeometry.segments[i];let q=abs(mm-segment.xy)-segment.zw;
  distance=min(distance,length(max(q,vec2f(0.)))+min(max(q.x,q.y),0.));
 }
 return distance;
}
fn glassTone(pos:vec2f,pixel:f32)->vec3f{
 let cell=vec2i(floor(pos));let horizontal=blockedAt(cell+vec2i(-1,0))+blockedAt(cell+vec2i(1,0))>=blockedAt(cell+vec2i(0,-1))+blockedAt(cell+vec2i(0,1));
 let step=select(vec2i(1,0),vec2i(0,1),horizontal);let at=select(fract(pos).x,fract(pos).y,horizontal);
 var before=0.;var after=0.;
 for(var n=1;n<=4;n++){if(blockedAt(cell-step*n)>.5){before+=1.;}else{break;}}
 for(var n=1;n<=4;n++){if(blockedAt(cell+step*n)>.5){after+=1.;}else{break;}}
 let phase=clamp(pos.y/f32(view.rows),0.,1.);
 var edge=min(before+at,after+1.-at)*view.cell;
 if(glassGeometry.info.y>.5){edge=max(0.,-glassDistance(pos*view.cell));}
 let rim=1.-smoothstep(pixel*.35,pixel*1.3,edge);
 let glass=glassMaterial(phase);
 // Tint is composited onto the adjacent scene below, rather than a white backing.
 return mix(glass.rgb,vec3f(1.),rim*.9);
}
// Fade unresolved scales before they alias; all derivatives are evaluated before branching.
fn resolved(scale:f32,pixel:f32)->f32{return 1.-smoothstep(scale*.16,scale*.65,pixel);}
fn filteredStone(mm:vec2f,scale:f32,pixel:f32)->f32{
  let visibility=resolved(scale,pixel);
  if(visibility<.001){return .5;}
  return mix(.5,stoneNoise(mm/scale),visibility);
}
fn mineralGrain(mm:vec2f,pixel:f32)->vec2f{
  let scale=3.2;let visibility=resolved(scale,pixel);
  if(visibility<.001){return vec2f(0.);}
  let p=mm/scale;let cell=vec2i(floor(p));let h=grainHash(cell);
  let centre=vec2f(.3+.4*h,.3+.4*grainHash(cell+vec2i(17,43)));
  let d=fract(p)-centre;let angle=h*6.2831853;let axis=vec2f(cos(angle),sin(angle));
  let local=vec2f(dot(d,axis),dot(d,vec2f(-axis.y,axis.x)));
  let radius=.09+.11*grainHash(cell+vec2i(71,11));
  let shape=max(abs(local.x)*.75+abs(local.y)*1.25,max(abs(local.x),abs(local.y)));
  let aa=max(.005,pixel/scale);
  let mask=(1.-smoothstep(radius-aa,radius+aa,shape))*visibility;
  return vec2f(mask,mask*clamp(.5+local.x/max(radius,.001),0.,1.));
}
fn fluidTexture(mm:vec2f,pixel:f32)->f32{
  // Reuse the original narrow ripple ridges, on physically advected material coordinates.
  let a=textureSampleLevel(rippleTexture,rippleSampler,mm/160.,0.).a;
  let b=textureSampleLevel(rippleTexture,rippleSampler,(mm+vec2f(37.,61.))/235.,0.).a;
  return (a*.7+b*.3)*resolved(12.,pixel);
}
fn blockedAt(p:vec2i)->f32{
  if(any(p<vec2i(0))||p.x>=i32(view.cols)||p.y>=i32(view.rows)){return 0.;}
  // Outside-dish cells belong to the smooth circular cup rim, not glass partitions.
  if(view.appearance.w>.5){let centre=(vec2f(p)+.5)-vec2f(f32(view.cols),f32(view.rows))*.5;if(length(abs(centre)+.5)>f32(view.cols)*.5){return 0.;}}
  return select(0.,1.,surface[u32(p.y)*view.cols+u32(p.x)].geometry.z>.5);
}
// Exact pixel coverage of the cell mask (for pixels smaller than a cell).
// This smooths raster edges without inventing traversable gaps or changing the mask.
fn wallCoverage(pos:vec2f,footprint:vec2f)->f32{
  if(glassGeometry.info.y>.5&&(view.arrows&0x80000000u)!=0u){return 0.;}
  if(glassGeometry.info.y>.5){let pixel=max(footprint.x,footprint.y)*view.cell;return 1.-smoothstep(-pixel*.5,pixel*.5,glassDistance(pos*view.cell));}
  if(any(footprint>=vec2f(1.))){return blockedAt(vec2i(floor(pos)));}
  let half=min(footprint*.5,vec2f(.49));let lo=vec2i(floor(pos-half));let hi=vec2i(floor(pos+half));
  if(all(lo==hi)){return blockedAt(lo);}
  let left=clamp((vec2f(hi)-(pos-half))/max(footprint,vec2f(.00001)),vec2f(0.),vec2f(1.));
  let weight=select(left,vec2f(1.),lo==hi);
  return mix(mix(blockedAt(hi),blockedAt(vec2i(lo.x,hi.y)),weight.x),mix(blockedAt(vec2i(hi.x,lo.y)),blockedAt(lo),weight.x),weight.y);
}
@fragment fn fragment(in: Varying) -> @location(0) vec4f {
  let uv=view.camera.xy+(in.uv-.5)/view.camera.z;
  let pos = uv * vec2f(f32(view.cols), f32(view.rows));
  let mm=pos*view.cell;
  let pixel=max(length(dpdx(mm)),length(dpdy(mm)));
  let footprint=fwidth(pos);
  let wallAmount=wallCoverage(pos,footprint);
  var wall=vec3f(.65,.76,.83);
  if(wallAmount>.001){wall=glassTone(pos,pixel);}
  let circleDistance=(length(uv-.5)-.5)*f32(view.cols)*view.cell;
  let circleCoverage=select(0.,smoothstep(-pixel*.5,pixel*.5,circleDistance),view.appearance.w>.5);
  if(any(uv<vec2f(0.))||any(uv>vec2f(1.))){return vec4f(.949,.957,.937,1.);}
  let x = min(view.cols - 1u, u32(pos.x)); let y = min(view.rows - 1u, u32(pos.y));
  var k = y * view.cols + x;
  // The physical mask is conservative: fill its excess border from the closest
  // free cell before drawing the continuous glass shape over it.
  if(glassGeometry.info.y>.5 && surface[k].geometry.z>.5){
    var best=1e8;
    for(var dy=-3;dy<=3;dy++){for(var dx=-3;dx<=3;dx++){
      let p=vec2i(i32(x)+dx,i32(y)+dy);
      if(any(p<vec2i(0))||p.x>=i32(view.cols)||p.y>=i32(view.rows)){continue;}
      let j=u32(p.y)*view.cols+u32(p.x);let d=distance(vec2f(p)+.5,pos);
      if(surface[j].geometry.z<.5 && d<best){best=d;k=j;}
    }}
  }
  if(view.appearance.w>.5&&circleDistance>pixel*.5){return vec4f(.949,.957,.937,1.);}
  if (glassGeometry.info.y<.5 && wallAmount>.999) {
    let wallMaterial=wall;
    return vec4f(mix(wallMaterial,vec3f(.949,.957,.937),circleCoverage),1.);
  }
  let mobility = surface[k].geometry.x;
  let corner=vec2i(floor(pos-.5));let blend=fract(pos-.5);
  let samples=mix(mix(levels(k,corner.x,corner.y),levels(k,corner.x+1,corner.y),blend.x),mix(levels(k,corner.x,corner.y+1),levels(k,corner.x+1,corner.y+1),blend.x),blend.y);
  let density=samples.x;
  let resistance=1./max(.0001,mobility);
  let level=select((resistance-1.)/2.,1.+(resistance-3.)/6.,resistance>3.);
  let grade=select(level,(samples.y+samples.z)/20.,view.appearance.z>.5);
  // Original CPU world's thresholds, palette, material coverage and layer ordering.
  let shallow=smoothstep(.2,1.3,grade);let land=smoothstep(1.35,1.75,grade);
  let broad=stoneMottle(mm+vec2f(73.,19.),pixel);
  let fine=filteredStone(mm+vec2f(23.,97.),1.25,pixel);
  let detail=resolved(1.25,pixel);
  var crack=0.;let slabDetail=resolved(14.,pixel);
  if(slabDetail>.01&&land>.01){let aa=max(.015,pixel/14.);crack=(1.-smoothstep(.02,.07+aa,fracturedStone(mm/14.)))*slabDetail;}
  let stone=61.+15.*broad+6.*(fine*2.-1.)-12.*crack+36.*(1.-land);
  var base=(vec3f(stone)+vec3f(6.,3.,0.))/255.;
  let deposit=smoothstep(.5,8.,samples.z/view.appearance.y);
  let crystal=mineralGrain(mm,pixel)*deposit;
  base=mix(base,vec3f(101.,57.,137.)/255.+vec3f(.247,.165,.275)*crystal.x,deposit*.9);
  let water=mix(vec3f(28.,101.,142.)/255.,vec3f(102.,180.,188.)/255.,shallow);
  base=mix(base,water,(1.-.42*shallow)*(1.-land)*(1.-.24*deposit));
  let shore=smoothstep(1.08,1.3,grade)*(1.-smoothstep(1.3,1.5,grade))*.22*(1.-deposit);
  let wet=smoothstep(1.35,1.53,grade)*(1.-smoothstep(1.58,1.83,grade))*.42*(1.-.65*deposit);
  base=mix(base,vec3f(151.,201.,194.)/255.,shore);
  base=mix(base,vec3f(31.,51.,55.)/255.,wet);
  let illumination=mix(mix(lightAt(k,corner.x,corner.y),lightAt(k,corner.x+1,corner.y),blend.x),mix(lightAt(k,corner.x,corner.y+1),lightAt(k,corner.x+1,corner.y+1),blend.x),blend.y);
  var spot=mix(mix(surface[nearby(k,corner.x,corner.y)].climate.x,surface[nearby(k,corner.x+1,corner.y)].climate.x,blend.x),mix(surface[nearby(k,corner.x,corner.y+1)].climate.x,surface[nearby(k,corner.x+1,corner.y+1)].climate.x,blend.x),blend.y);
  if(lightSettings.count>0u){spot=visualSpot(mm,pixel);}
  let lit=bitcast<f32>(view.pad0);let clarity=1./(1.+.11*density);
  let mask=spot*clarity;
  let sunlight=vec3f(255.,232.,185.)/255.;
  if(lit>0.){
    base*=mix(vec3f(140.,150.,185.)/255.,vec3f(1.),mask*min(1.,lit));
    let warmth=min(.95,.2*min(1.,lit)+.35*f32((view.arrows>>16u)&255u)/255.);
    base*=mix(vec3f(1.),sunlight,mask*warmth);
    base=1.-(1.-base)*(1.-sunlight*mask*.07*min(1.,lit));
    base=mix(base,vec3f(1.),mask*clamp((lit-1.)*.55,0.,1.));
  }
  base*=1.-(1.-clarity)*.35;
  let relative=density/view.appearance.y;
  let mineral=clamp(log(max(relative,.15)/.15)/log(6./.15),0.,1.);
  var color=mix(base,mix(vec3f(216.,165.,255.),vec3f(185.,131.,237.),smoothstep(.4,1.,mineral))/255.,mineral*.46);
  let west = select(k, k - 1u, x > 0u);
  let north = select(k, k - view.cols, y > 0u);
  var speed = vec2f((flow[k].x + flow[west].x) * .5, (flow[k].y + flow[north].y) * .5);
  if ((view.burstAndSeed&1u) == 1u && view.time >= 2.) { speed = vec2f(0.); }
  // A material coordinate field is advected by the same physical flow each model step.
  let maps=mix(mix(materialAt(k,corner.x,corner.y),materialAt(k,corner.x+1,corner.y),blend.x),mix(materialAt(k,corner.x,corner.y+1),materialAt(k,corner.x+1,corner.y+1),blend.x),blend.y);
  let weight=.5+.5*cos(view.time*6.2831853/40.);
  let ripple=mix(fluidTexture(maps.xy*view.cell,pixel),fluidTexture(maps.zw*view.cell,pixel),weight);
  let flowContrast=.45+.55*length(speed)*view.cell/(length(speed)*view.cell+1.7);
  let rippleAlpha=ripple*flowContrast*(1.-land)*.5*min(1.,lit);
  color=1.-(1.-color)*(1.-vec3f(.78,.9,.89)*rippleAlpha);
  // Small moving mineral grains share the advected coordinates; no particle readback.
  let spacing=36.;let grainPos=maps.xy*view.cell/spacing;let grainCell=vec2i(floor(grainPos));
  let centre=vec2f(grainHash(grainCell+vec2i(19,3)),grainHash(grainCell+vec2i(2,31)));
  let distance=max(abs(fract(grainPos).x-centre.x),abs(fract(grainPos).y-centre.y))*spacing;
  let cssMm=f32(view.cols)*view.cell/max(1.,f32((view.arrows>>1u)&32767u)*view.camera.z);
  let grain=1.-smoothstep(.55*cssMm,.55*cssMm+pixel,distance);
  let activity=clamp((relative*length(speed)*view.cell-.01)/.29,0.,1.);
  let life=.5+.5*sin(bitcast<f32>(view.pad1)*1.6+grainHash(grainCell)*6.2831853);
  color=mix(color,vec3f(236.,214.,255.)/255.,grain*activity*.6*life);
  if(view.camera.w>0.5&&view.camera.w<1.5){color=mix(vec3f(.03,.09,.16),vec3f(1.,.83,.39),clamp(illumination,0.,1.));}
  if(view.camera.w>1.5&&view.camera.w<2.5){color=mix(vec3f(.025,.14,.15),vec3f(.85,.52,.96),min(1.,density/view.appearance.y));}
  if(view.camera.w>2.5&&view.camera.w<3.5){color=mix(vec3f(.04,.13,.19),vec3f(1.,.68,.25),clamp(log(1.+length(speed)*view.cell)/5.,0.,1.));}
  if(view.camera.w>3.5){let temperature=mix(mix(temperatureAt(k,corner.x,corner.y),temperatureAt(k,corner.x+1,corner.y),blend.x),mix(temperatureAt(k,corner.x,corner.y+1),temperatureAt(k,corner.x+1,corner.y+1),blend.x),blend.y);color=mix(vec3f(.04,.25,.48),vec3f(1.,.55,.2),clamp((temperature-1.)/2.,0.,1.));}
  if ((view.arrows&1u) == 1u) {
    let f = fract(pos) - .5;
    let s = length(speed);
    if (s > .0001) {
      let axis = speed / s; let along = dot(f, axis); let across = abs(dot(f, vec2f(-axis.y, axis.x)));
      let body = abs(along) < .28 && across < .025;
      let head = along > .1 && along < .3 && across < (.3 - along) * .7;
      if (body || head) { color = mix(color, vec3f(.79, .94, .92), .8); }
    }
  }
  if (view.pad0 == 0u && abs(surface[k].geometry.y) > .035) {
    let edge = length(fract(pos) - .5);
    if (edge < .11) { color = mix(color, select(vec3f(.30, .76, .85), vec3f(.98, .70, .53), surface[k].geometry.y > 0.), .7); }
  }
  if (state[k].z > 0u) {
    let disk = 1. - smoothstep(.18,.45,length(fract(pos)-.5));
    color = mix(color, select(vec3f(.18,.68,.8),vec3f(.95,.67,.81),state[k].z > 0u),disk);
  }
  if(markers[k].state.x>0.){
    let m=markers[k];let stage=m.state.x;let progress=clamp((view.time*10.-m.state.z)/max(1.,m.state.w-m.state.z),0.,1.);
    let displayTime=bitcast<f32>(view.pad1);let pulse=.5+.5*sin(displayTime*9.424778);
    var radius=.15;var opacity=.45;var tint=vec3f(.53,.41,.36);var flash=0.;
    if(stage<1.5){radius=.12+(.18+.12*m.state.y)*progress;opacity=.4+.5*progress;tint=mix(vec3f(.48,.31,.2),vec3f(.96,.77,.5),progress);if(progress>.98){opacity*=.85+.15*pulse;}}
    else if(stage<2.5){radius=(.24+.16*m.state.y)*(1.-.3*progress);opacity=.95-.25*progress;tint=vec3f(.78,.54,.85);flash=m.animation.y*exp(-max(0.,displayTime-m.animation.x)*5.);}
    else if(stage>3.5){radius=.15*(1.-progress*.6);opacity=.4*(1.-progress);tint=vec3f(.48,.48,.47);}
    let d=length(fract(pos)-.5);let disk=1.-smoothstep(radius*.65,radius,d);let rim=exp(-pow((d-radius*.83)/.025,2.));
    color=mix(color,tint,disk*opacity);color+=vec3f(.24,.2,.22)*rim*opacity;
    color=mix(color,vec3f(1.,.98,.93),(1.-smoothstep(0.,radius*.6,d))*flash);
  }
  if (surface[k].geometry.w > .5) { let strength=select(1.,surface[k].geometry.w-2.,surface[k].geometry.w>1.5);let d=length(fract(pos)-.5);color*=mix(1.,.2+.65*smoothstep(0.,.6,d),strength);color+=vec3f(.08,.18,.2)*exp(-pow((d-.42)*25.,2.))*strength;}
  let contact=wallCoverage(pos-vec2f(pixel/view.cell,pixel*2./view.cell),footprint)*(1.-wallAmount);
  color*=1.-contact*.28;
  let glass=glassMaterial(clamp(pos.y/f32(view.rows),0.,1.));
  color=mix(color,mix(color,wall,glass.a),wallAmount);
  color=mix(color,vec3f(.949,.957,.937),circleCoverage);
  return vec4f(color, 1.);
}
