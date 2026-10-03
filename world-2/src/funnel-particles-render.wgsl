struct View { cols:u32,rows:u32,cell:f32,time:f32,arrows:u32,burst:u32,pad0:u32,pad1:u32,appearance:vec4f,camera:vec4f }
struct Particle { pos:vec2f,alpha:f32,size:f32,owner:u32,life:u32,age:f32,pad:f32 }
@group(0) @binding(0) var<uniform> view:View;
@group(0) @binding(1) var<storage,read> particles:array<Particle>;
struct Vertex { @builtin(position) pos:vec4f,@location(0) local:vec2f,@location(1) alpha:f32 }
@vertex fn vertex(@builtin(vertex_index) vertex:u32,@builtin(instance_index) instance:u32)->Vertex {
 let corners=array<vec2f,6>(vec2f(-1.,-1.),vec2f(1.,-1.),vec2f(-1.,1.),vec2f(-1.,1.),vec2f(1.,-1.),vec2f(1.,1.));let c=corners[vertex];let p=particles[instance];
 let uv=((p.pos+c*p.size)/vec2f(f32(view.cols),f32(view.rows))-view.camera.xy)*view.camera.z+.5;
 return Vertex(vec4f(uv.x*2.-1.,1.-uv.y*2.,0.,1.),c,p.alpha*min(1.,view.camera.z*.65));
}
@fragment fn fragment(v:Vertex)->@location(0) vec4f {return vec4f(236./255.,214./255.,1.,v.alpha*(1.-smoothstep(.25,1.,length(v.local))));}
