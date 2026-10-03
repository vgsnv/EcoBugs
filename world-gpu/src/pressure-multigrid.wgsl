struct Params { cols:u32,rows:u32,coarseCols:u32,coarseRows:u32,omega:f32,pad0:f32,pad1:f32,pad2:f32 }
@group(0) @binding(0) var<uniform> cfg:Params;
@group(0) @binding(1) var<storage,read_write> geo:array<vec4f>;
@group(0) @binding(2) var<storage,read_write> pressure:array<f32>;
@group(0) @binding(3) var<storage,read_write> coarseGeo:array<vec4f>;
@group(0) @binding(5) var<storage,read> physical:array<vec4f>;
@group(0) @binding(4) var<storage,read_write> coarsePressure:array<f32>;
fn neighbor(k:u32,d:u32)->u32 {
 let x=k%cfg.cols;let y=k/cfg.cols;
 if(d==0u&&x+1u<cfg.cols){return k+1u;}if(d==1u&&y+1u<cfg.rows){return k+cfg.cols;}if(d==2u&&x>0u){return k-1u;}if(d==3u&&y>0u){return k-cfg.cols;}return k;
}
fn conduct(k:u32,j:u32)->f32 {if(k==j){return 0.;}if(j==k+1u){return geo[k].x;}if(j==k+cfg.cols){return geo[k].y;}if(k==j+1u){return geo[j].x;}return geo[j].y;}
fn physicalConduct(k:u32,j:u32)->f32{if(k==j||physical[k].z>.5||physical[j].z>.5){return 0.;}return 2.*physical[k].x*physical[j].x/(physical[k].x+physical[j].x);}
@compute @workgroup_size(64) fn initialize(@builtin(global_invocation_id) id:vec3u){let k=id.x;if(k>=cfg.cols*cfg.rows){return;}geo[k]=vec4f(physicalConduct(k,neighbor(k,0u)),physicalConduct(k,neighbor(k,1u)),physical[k].y,physical[k].z);}
fn equation(k:u32)->vec2f {var sum=0.;var weight=0.;for(var d=0u;d<4u;d++){let j=neighbor(k,d);let c=conduct(k,j);sum+=c*pressure[j];weight+=c;}return vec2f(sum,weight);}
fn relax(k:u32,color:u32){if(k>=cfg.cols*cfg.rows||((k%cfg.cols+k/cfg.cols)&1u)!=color){return;}if(geo[k].w>.5){pressure[k]=0.;return;}let e=equation(k);if(e.y>0.){pressure[k]+=cfg.omega*((e.x+geo[k].z)/e.y-pressure[k]);}else{pressure[k]=0.;}}
@compute @workgroup_size(64) fn red(@builtin(global_invocation_id) id:vec3u){relax(id.x,0u);}
@compute @workgroup_size(64) fn black(@builtin(global_invocation_id) id:vec3u){relax(id.x,1u);}
@compute @workgroup_size(64) fn restrictResidual(@builtin(global_invocation_id) id:vec3u){
 let k=id.x;if(k>=cfg.coarseCols*cfg.coarseRows){return;}let x=k%cfg.coarseCols;let y=k/cfg.coarseCols;var east=0.;var south=0.;var source=0.;var free=0u;
 for(var b=0u;b<2u;b++){for(var a=0u;a<2u;a++){let xx=x*2u+a;let yy=y*2u+b;if(xx>=cfg.cols||yy>=cfg.rows){continue;}let j=yy*cfg.cols+xx;if(geo[j].w>.5){continue;}free++;if(a==1u){east+=geo[j].x;}if(b==1u){south+=geo[j].y;}let e=equation(j);source+=geo[j].z+e.x-e.y*pressure[j];}}
 coarseGeo[k]=vec4f(east*.5,south*.5,source,select(1.,0.,free>0u));coarsePressure[k]=0.;
}
@compute @workgroup_size(64) fn prolong(@builtin(global_invocation_id) id:vec3u){
 let k=id.x;if(k>=cfg.cols*cfg.rows||geo[k].w>.5){return;}
 // Coarse cells double the distance between centres; averaged face conductance
 // and summed residual keep the finite-volume scaling.
 let parent=(k/cfg.cols/2u)*cfg.coarseCols+(k%cfg.cols/2u);pressure[k]+=coarsePressure[parent]*.8;
}
var<workgroup> cache:array<f32,256>;
@compute @workgroup_size(256) fn coarseSolve(@builtin(local_invocation_id) id:vec3u){
 let k=id.x;let n=cfg.cols*cfg.rows;if(k<n){cache[k]=pressure[k];}workgroupBarrier();
 for(var iteration=0u;iteration<512u;iteration++){
  for(var color=0u;color<2u;color++){
   if(k<n&&((k%cfg.cols+k/cfg.cols)&1u)==color&&geo[k].w<.5){
    var sum=0.;var weight=0.;for(var d=0u;d<4u;d++){let j=neighbor(k,d);let c=conduct(k,j);sum+=c*cache[j];weight+=c;}
    if(weight>0.){cache[k]+=cfg.omega*((sum+geo[k].z)/weight-cache[k]);}
   }
   workgroupBarrier();
  }
 }
 if(k<n){pressure[k]=cache[k];}
}
