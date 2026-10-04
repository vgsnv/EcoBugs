struct Settings {cols:u32,rows:u32,blend:f32,first:u32,cell:f32,quantum:f32,worldDt:f32,processBlend:f32}
struct Display {field:vec4f,activity:vec4f}
@group(0) @binding(0) var<uniform> cfg:Settings;
@group(0) @binding(1) var<storage,read> geometry:array<vec4f>;
@group(0) @binding(2) var<storage,read> flow:array<vec2f>;
@group(0) @binding(3) var<storage,read_write> display:array<Display>;
@group(0) @binding(4) var<storage,read> terrain:array<vec4u>;
@group(0) @binding(5) var<storage,read> state:array<vec4u>;
@group(0) @binding(6) var<storage,read_write> previous:array<vec4u>;
@compute @workgroup_size(64) fn filterFlow(@builtin(global_invocation_id) id:vec3u){
 let k=id.x;if(k>=cfg.cols*cfg.rows){return;}
 let stock=vec4u(terrain[k].xy,state[k].y,0u);
 if(geometry[k].z>.5){display[k]=Display(vec4f(0.),vec4f(0.));previous[k]=stock;return;}
 let x=k%cfg.cols;let y=k/cfg.cols;let west=select(k,k-1u,x>0u);let north=select(k,k-cfg.cols,y>0u);
 let v=.5*vec2f(flow[k].x+select(0.,flow[west].x,x>0u),flow[k].y+select(0.,flow[north].y,y>0u));
 let average=mix(display[k].field.xyz,vec3f(v,length(v)),cfg.blend);
 display[k].field=vec4f(average,clamp(length(average.xy)/max(average.z,.000001),0.,1.));
 var rates=vec4f(0.);
 if(cfg.first==0u){
  // Subtract integers before conversion: avoid losing small changes in large stocks.
  let old=previous[k];
  let groundUp=stock.x-min(stock.x,old.x);let groundDown=old.x-min(stock.x,old.x);
  let depositUp=stock.y-min(stock.y,old.y);let depositDown=old.y-min(stock.y,old.y);
  let captured=stock.z-min(stock.z,old.z);
  rates=vec4f(f32(groundDown)+f32(depositDown),f32(depositUp),f32(captured),f32(groundUp))*cfg.quantum/(cfg.cell*cfg.cell*max(.1,cfg.worldDt));
 }
 display[k].activity=mix(display[k].activity,rates,cfg.processBlend);previous[k]=stock;
}
