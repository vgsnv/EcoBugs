export type FlowView = 'auto'|'ripple'|'lines'|'strength'|'off';
export type FlowMode = 0|1|2|3;
export function flowMode(view:FlowView,speed:number):FlowMode{
 if(view==='off')return 3;
 if(view==='ripple')return 0;
 if(view==='lines')return 1;
 if(view==='strength')return 2;
 return speed<=1?0:speed<=100?1:2;
}
export function flowBlend(mode:FlowMode,elapsed:number,first:boolean):number{
 return first||mode===0||mode===3?1:1-Math.exp(-Math.max(0,elapsed)/(mode===2?.6:.25));
}
export const flowDescriptions = [
 'Рябь переносится течением в модельном времени',
 'Штрихи показывают сглаженное направление; движение штрихов условное',
 'Яркость — сила, штрихи — устойчивое направление; поле сглажено по кадрам за 0,6 с просмотра',
 'Течения скрыты',
] as const;
