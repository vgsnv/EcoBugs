struct View { cols: u32, rows: u32, cell: f32, time: f32, arrows: u32, burst: u32, pad0: u32, pad1: u32 }
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var<storage, read> geo: array<vec4f>;
@group(0) @binding(2) var<storage, read> state: array<vec4u>;
@group(0) @binding(3) var<storage, read> flow: array<vec2f>;
@group(0) @binding(4) var<storage, read> field: array<vec4f>;
@group(0) @binding(5) var<storage, read> vents: array<vec4f>;
struct Varying { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vertex(@builtin(vertex_index) i: u32) -> Varying {
  let p = array<vec2f, 3>(vec2f(-1., -1.), vec2f(3., -1.), vec2f(-1., 3.))[i];
  return Varying(vec4f(p, 0., 1.), vec2f(p.x * .5 + .5, .5 - p.y * .5));
}
// Interpolate the physical field without colouring through walls, corners or hole lips.
fn concentration(k:u32,px:i32,py:i32)->f32 {
  let own=f32(state[k].x)*.001/(view.cell*view.cell);
  if(px<0||py<0||px>=i32(view.cols)||py>=i32(view.rows)){return own;}
  let j=u32(py)*view.cols+u32(px);let x=i32(k%view.cols);let y=i32(k/view.cols);
  if(geo[j].z>.5||(geo[j].w>.5)!=(geo[k].w>.5)){return own;}
  if(px!=x&&py!=y&&(geo[u32(y)*view.cols+u32(px)].z>.5||geo[u32(py)*view.cols+u32(x)].z>.5
    ||(geo[u32(y)*view.cols+u32(px)].w>.5)!=(geo[k].w>.5)||(geo[u32(py)*view.cols+u32(x)].w>.5)!=(geo[k].w>.5))){return own;}
  return f32(state[j].x)*.001/(view.cell*view.cell);
}
@fragment fn fragment(in: Varying) -> @location(0) vec4f {
  let pos = in.uv * vec2f(f32(view.cols), f32(view.rows));
  let x = min(view.cols - 1u, u32(pos.x)); let y = min(view.rows - 1u, u32(pos.y));
  let k = y * view.cols + x;
  if (geo[k].z > 0.5) { return vec4f(.11, .16, .18, 1.); }
  let mobility = geo[k].x;
  var base = mix(vec3f(.35, .49, .46), vec3f(.035, .18, .25), mobility);
  if (mobility < .15) { base = vec3f(.35, .33, .30); }
  if (view.pad0 == 1u) { base *= .5 + .65 * field[k].x; }
  let corner=vec2i(floor(pos-.5));let blend=fract(pos-.5);
  let density=mix(mix(concentration(k,corner.x,corner.y),concentration(k,corner.x+1,corner.y),blend.x),
    mix(concentration(k,corner.x,corner.y+1),concentration(k,corner.x+1,corner.y+1),blend.x),blend.y);
  let mineral = clamp(log(1. + density * 75.) / 2.7, 0., .88);
  var color = mix(base, vec3f(.69, .46, .83), mineral);
  let west = select(k, k - 1u, x > 0u);
  let north = select(k, k - view.cols, y > 0u);
  var speed = vec2f((flow[k].x + flow[west].x) * .5, (flow[k].y + flow[north].y) * .5);
  if (view.burst == 1u && view.time >= 2.) { speed = vec2f(0.); }
  // Surface texture follows model time, stays inside the same physical cells.
  let phase = pos - speed * view.time;
  let ripple = pow(max(0., sin(phase.x * 2. + sin(phase.y * 1.7))), 16.) * .055;
  if (mobility > .15) { color += vec3f(ripple); }
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
  if (view.pad0 == 0u && abs(geo[k].y) > .035) {
    let edge = length(fract(pos) - .5);
    if (edge < .11) { color = mix(color, select(vec3f(.30, .76, .85), vec3f(.98, .70, .53), geo[k].y > 0.), .7); }
  }
  if (abs(vents[k].y) > .001 || state[k].z > 0u) {
    let disk = 1. - smoothstep(.18,.45,length(fract(pos)-.5));
    color = mix(color, select(vec3f(.18,.68,.8),vec3f(.95,.67,.81),vents[k].y > 0. || state[k].z > 0u),disk);
  }
  if (geo[k].w > .5) { color *= .4 + .4 * smoothstep(0., .55, length(fract(pos) - .5)); }
  return vec4f(color, 1.);
}
