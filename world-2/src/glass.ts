export const glassWidth = 10;
export const glassEdgeWidth = 1;
/** Shared appearance of the cup walls and internal partitions. */
export const glassStops = [
 { at: 0, color: '#f4fdff', opacity: .94 },
 { at: .22, color: '#d3eef4', opacity: .72 },
 { at: .65, color: '#80a6b4', opacity: .48 },
 { at: 1, color: '#bcd6e0', opacity: .84 },
] as const;
export const glassSvgStops = glassStops.map(s => `<stop offset="${s.at}" stop-color="${s.color}" stop-opacity="${s.opacity}"/>`).join('');
const rgba = (s: typeof glassStops[number]) => `vec4f(${[1,3,5].map(i => (parseInt(s.color.slice(i,i+2),16)/255).toFixed(6)).join(',')},${s.opacity.toFixed(2)})`;
export const glassShader = `fn glassMaterial(phase:f32)->vec4f {
${glassStops.slice(1).map((s,i) => {
 const a=glassStops[i];
 return `if(phase<=${s.at.toFixed(2)}){return mix(${rgba(a)},${rgba(s)},clamp((phase-${a.at.toFixed(2)})/${(s.at-a.at).toFixed(2)},0.,1.));}`;
}).join('\n')}
return ${rgba(glassStops[3])};
}`;
