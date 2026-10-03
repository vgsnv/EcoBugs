struct View { cols: u32, rows: u32, cell: f32, time: f32, arrows: u32, burst: u32, pad0: u32, pad1: u32, appearance:vec4f, camera:vec4f }
@group(0) @binding(0) var<uniform> view: View;
struct Surface{geometry:vec4f,climate:vec4f}
@group(0) @binding(1) var<storage, read> surface: array<Surface>;
@group(0) @binding(2) var<storage, read> state: array<vec4u>;
@group(0) @binding(3) var<storage, read> flow: array<vec2f>;
@group(0) @binding(4) var<storage, read> field: array<vec4f>;
@group(0) @binding(5) var<storage, read> vents: array<vec4f>;
struct Marker { state:vec4f,animation:vec4f }
@group(0) @binding(6) var<storage,read> markers:array<Marker>;
@group(0) @binding(7) var<storage,read> terrain:array<vec4u>;
@group(0) @binding(8) var<storage,read> material:array<vec4f>;
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
fn lightAt(k:u32,x:i32,y:i32)->f32{return field[nearby(k,x,y)].x;}
fn temperatureAt(k:u32,x:i32,y:i32)->f32{return surface[nearby(k,x,y)].climate.z;}
fn materialAt(k:u32,x:i32,y:i32)->vec4f{return material[nearby(k,x,y)];}
@fragment fn fragment(in: Varying) -> @location(0) vec4f {
  let uv=view.camera.xy+(in.uv-.5)/view.camera.z;
  if(any(uv<vec2f(0.))||any(uv>vec2f(1.))){return vec4f(.035,.065,.075,1.);}
  let pos = uv * vec2f(f32(view.cols), f32(view.rows));
  let x = min(view.cols - 1u, u32(pos.x)); let y = min(view.rows - 1u, u32(pos.y));
  let k = y * view.cols + x;
  if (surface[k].geometry.z > 0.5) { return vec4f(.11, .16, .18, 1.); }
  if(view.appearance.w>.5&&length(uv-.5)>.5){return vec4f(.035,.065,.075,1.);}
  let mobility = surface[k].geometry.x;
  let corner=vec2i(floor(pos-.5));let blend=fract(pos-.5);
  let samples=mix(mix(levels(k,corner.x,corner.y),levels(k,corner.x+1,corner.y),blend.x),mix(levels(k,corner.x,corner.y+1),levels(k,corner.x+1,corner.y+1),blend.x),blend.y);
  let density=samples.x;
  let resistance=1./max(.0001,mobility);
  let level=select((resistance-1.)/2.,1.+(resistance-3.)/6.,resistance>3.);
  let grade=select(level,(samples.y+samples.z)/20.,view.appearance.z>.5);
  let water=vec3f(.025,.25,.31);let shallow=vec3f(.28,.51,.47);let rock=vec3f(.48,.45,.39);
  var base=mix(water,shallow,smoothstep(.1,1.,grade));
  base=mix(base,rock,smoothstep(1.1,1.8,grade));
  let mm=pos*view.cell;
  let grain=fract(sin(dot(floor(mm/3.),vec2f(127.1,311.7)))*43758.5453);
  let detail=smoothstep(.7,3.,view.camera.z);
  base*=1.+(grain-.5)*.13*detail;
  base+=vec3f(.08,.11,.08)*exp(-pow((grade-1.12)*7.,2.));
  base*=1.-.14*exp(-pow((grade-1.45)*8.,2.));
  let illumination=mix(mix(lightAt(k,corner.x,corner.y),lightAt(k,corner.x+1,corner.y),blend.x),mix(lightAt(k,corner.x,corner.y+1),lightAt(k,corner.x+1,corner.y+1),blend.x),blend.y);
  if (view.pad0 == 1u) { base *= .65 + .5 * illumination; }
  base*=1./(1.+.11*density/view.appearance.y);
  let mineral = clamp(log(1. + density * 5./view.appearance.y) / 2.7, 0., .88);
  let deposit=clamp(log(1.+samples.z*5./view.appearance.y),0.,.8);
  base=mix(base,vec3f(.3,.17,.43),deposit);
  var color = mix(base, vec3f(.69, .46, .83), mineral);
  let west = select(k, k - 1u, x > 0u);
  let north = select(k, k - view.cols, y > 0u);
  var speed = vec2f((flow[k].x + flow[west].x) * .5, (flow[k].y + flow[north].y) * .5);
  if (view.burst == 1u && view.time >= 2.) { speed = vec2f(0.); }
  // A material coordinate field is advected by the same physical flow each model step.
  let maps=mix(mix(materialAt(k,corner.x,corner.y),materialAt(k,corner.x+1,corner.y),blend.x),mix(materialAt(k,corner.x,corner.y+1),materialAt(k,corner.x+1,corner.y+1),blend.x),blend.y);
  let weight=.5+.5*cos(view.time*6.2831853/40.);
  let a=maps.xy*view.cell/18.;let b=maps.zw*view.cell/18.;
  let causticA=pow(max(0.,cos(a.x+sin(a.y*1.3))*cos(a.y+sin(a.x*.8))),5.);
  let causticB=pow(max(0.,cos(b.x+sin(b.y*1.3))*cos(b.y+sin(b.x*.8))),5.);
  let ripple=mix(causticA,causticB,weight)*.065;
  color+=vec3f(.7,1.,.96)*ripple*(1.-smoothstep(1.25,1.75,grade));
  if(view.camera.w>0.5&&view.camera.w<1.5){color=mix(vec3f(.03,.09,.16),vec3f(1.,.83,.39),clamp(illumination,0.,1.));}
  if(view.camera.w>1.5&&view.camera.w<2.5){color=mix(vec3f(.025,.14,.15),vec3f(.85,.52,.96),min(1.,density/view.appearance.y));}
  if(view.camera.w>2.5&&view.camera.w<3.5){color=mix(vec3f(.04,.13,.19),vec3f(1.,.68,.25),clamp(log(1.+length(speed)*view.cell)/5.,0.,1.));}
  let crystal=step(.975,grain)*(1.-smoothstep(.04,.2,length(fract(mm/6.)-.5)))*deposit;
  color+=vec3f(.34,.2,.46)*crystal*(.15+.85*detail);
  if(grade>1.5){let fissure=1.-smoothstep(.015,.035,abs(sin(mm.x*.12+sin(mm.y*.08))));color*=1.-fissure*.12*detail;}
  if(view.camera.w>3.5){let temperature=mix(mix(temperatureAt(k,corner.x,corner.y),temperatureAt(k,corner.x+1,corner.y),blend.x),mix(temperatureAt(k,corner.x,corner.y+1),temperatureAt(k,corner.x+1,corner.y+1),blend.x),blend.y);color=mix(vec3f(.04,.25,.48),vec3f(1.,.55,.2),clamp((temperature-1.)/2.,0.,1.));}
  if (view.arrows == 1u) {
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
  if (abs(vents[k].y) > .001 || state[k].z > 0u) {
    let disk = 1. - smoothstep(.18,.45,length(fract(pos)-.5));
    color = mix(color, select(vec3f(.18,.68,.8),vec3f(.95,.67,.81),vents[k].y > 0. || state[k].z > 0u),disk);
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
  return vec4f(color, 1.);
}
