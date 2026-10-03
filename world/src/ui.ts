import { DEFAULT_PARAMS, PARAM_LABELS, makeParams, type WorldParams } from './generation/params.ts';
export const camera={x:.5,y:.5,zoom:1,layer:0};
export function installUi(canvas:HTMLCanvasElement){
 const toolbar=document.querySelector('.toolbar')!;
 toolbar.insertAdjacentHTML('beforeend',`<label><input type="checkbox" id="rulers">Линейки</label><button id="fullscreen">Полный экран</button><button id="summary-toggle">Сводка</button><label>Показ<select id="layer"><option value="0">Мир</option><option value="1">Свет</option><option value="2">Минерал</option><option value="3">Скорость течения</option><option value="4">Температура</option></select></label>`);
 const dish=document.querySelector('.dish') as HTMLElement;document.addEventListener('fullscreenchange',()=>{rulerKey='';});window.addEventListener('resize',()=>{rulerKey='';});dish.insertAdjacentHTML('beforeend','<div id="ruler-overlay"></div><button id="exit-fullscreen">Выйти из полного экрана</button>');document.getElementById('fullscreen')!.onclick=()=>{if(document.fullscreenElement)void document.exitFullscreen();else void dish.requestFullscreen();};document.getElementById('exit-fullscreen')!.onclick=()=>{void document.exitFullscreen();};document.getElementById('summary-toggle')!.onclick=()=>document.querySelector('main')!.classList.toggle('summary-hidden');
 const transport=document.querySelector('.transport')!;
 transport.insertAdjacentHTML('afterend',`<div class="camera-controls"><button id="zoom-out" title="Уменьшить">−</button><span id="zoom-label">×1</span><button id="zoom-in" title="Приблизить">+</button><button id="fit">Вся чашка</button><span id="ruler"></span><span id="coordinates"></span></div><div class="map"><canvas id="minimap" aria-label="Миникарта — нажмите для перехода"></canvas><span id="viewbox"></span></div><div class="files"><button id="save">Сохранить мир</button><label class="file-button">Открыть мир<input id="load" type="file" accept=".json"></label><button id="recover" hidden>Восстановить GPU</button><span id="checkpoint-age"></span></div>`);
 document.querySelector('aside')!.insertAdjacentHTML('afterbegin',`<details id="creation"><summary>Создать новый мир</summary><form id="world-settings"><label>Форма чашки<select name="shape"><option value="rectangle">Прямоугольник</option><option value="circle">Круг</option></select></label>${Object.entries(DEFAULT_PARAMS).filter(([key])=>!['shape','viscosityShares'].includes(key)).map(([key,value])=>`<label>${PARAM_LABELS[key]??key}<input name="${key}" type="number" step="any" value="${value}" required></label>`).join('')}${Object.entries(DEFAULT_PARAMS.viscosityShares).map(([key,value])=>`<label>${{water:'Вода',shallows:'Отмель',land:'Суша'}[key]} · %<input name="${key}" type="number" step="any" value="${value*100}" required></label>`).join('')}<button type="submit">Сотворить</button><p id="creation-error" role="alert"></p></form></details>`);
 const settings=document.querySelector('#world-settings') as HTMLFormElement;
 const shape=settings.elements.namedItem('shape') as HTMLSelectElement,aspect=settings.elements.namedItem('aspectRatio') as HTMLInputElement;
 shape.onchange=()=>{aspect.readOnly=shape.value==='circle';if(aspect.readOnly)aspect.value='1';};
 const changeZoom=(factor:number)=>{camera.zoom=Math.max(1,Math.min(16,camera.zoom*factor));bound();};
 document.getElementById('zoom-in')!.onclick=()=>changeZoom(2);document.getElementById('zoom-out')!.onclick=()=>changeZoom(.5);
 document.getElementById('fit')!.onclick=()=>{Object.assign(camera,{x:.5,y:.5,zoom:1});bound();};
 document.getElementById('layer')!.onchange=e=>{camera.layer=Number((e.target as HTMLSelectElement).value);};
 canvas.onwheel=e=>{e.preventDefault();changeZoom(e.deltaY<0?1.15:1/1.15);};
 let previous:{x:number;y:number}|null=null;
 canvas.onpointerdown=e=>{previous={x:e.clientX,y:e.clientY};canvas.setPointerCapture(e.pointerId);};
 canvas.onpointerup=()=>{previous=null;};canvas.onpointercancel=()=>{previous=null;};
 canvas.onpointermove=e=>{const r=canvas.getBoundingClientRect();if(previous){camera.x-=(e.clientX-previous.x)/r.width/camera.zoom;camera.y-=(e.clientY-previous.y)/r.height/camera.zoom;previous={x:e.clientX,y:e.clientY};bound();}};
 const mini=document.getElementById('minimap') as HTMLCanvasElement;mini.onclick=e=>{const r=mini.getBoundingClientRect();camera.x=(e.clientX-r.left)/r.width;camera.y=(e.clientY-r.top)/r.height;bound();};
 document.addEventListener('keydown',e=>{if((e.target as HTMLElement).matches('input,select,textarea'))return;if(e.key==='+'||e.key==='=')changeZoom(2);if(e.key==='-')changeZoom(.5);});
 return {mini,params:()=>{const data=new FormData(document.querySelector('#world-settings') as HTMLFormElement),values:Record<string,unknown>={};for(const key of Object.keys(DEFAULT_PARAMS))if(key!=='viscosityShares')values[key]=key==='shape'?data.get(key):Number(data.get(key));values.viscosityShares=Object.fromEntries(['water','shallows','land'].map(key=>[key,Number(data.get(key))/100]));return makeParams(values as Partial<WorldParams>);},setParams:(p:WorldParams)=>{aspect.readOnly=p.shape==='circle';const form=document.querySelector('#world-settings') as HTMLFormElement;for(const [key,value]of Object.entries(p)){if(key==='viscosityShares'){for(const [name,share]of Object.entries(value))(form.elements.namedItem(name) as HTMLInputElement).value=String(Number(share)*100);}else (form.elements.namedItem(key) as HTMLInputElement).value=String(value);}}};
}
function bound(){const half=.5/camera.zoom;camera.x=Math.max(half,Math.min(1-half,camera.x));camera.y=Math.max(half,Math.min(1-half,camera.y));document.getElementById('zoom-label')!.textContent=`×${camera.zoom.toFixed(1)}`;const box=document.getElementById('viewbox')!;Object.assign(box.style,{left:`${(camera.x-half)*100}%`,top:`${(camera.y-half)*100}%`,width:`${100/camera.zoom}%`,height:`${100/camera.zoom}%`});}
let rulerKey="";
export function updateRulers(width:number,height:number,shape='rectangle'){
 const key=JSON.stringify([width,height,shape,!!document.fullscreenElement,camera,(document.getElementById('rulers') as HTMLInputElement).checked]);if(key===rulerKey)return;rulerKey=key;
 const overlay=document.getElementById('ruler-overlay')!;
 if(document.fullscreenElement){const r=document.getElementById('world')!.getBoundingClientRect(),d=document.querySelector('.dish')!.getBoundingClientRect();Object.assign(overlay.style,{inset:'auto',left:`${r.left-d.left}px`,top:`${r.top-d.top}px`,width:`${r.width}px`,height:`${r.height}px`});}
 else overlay.removeAttribute('style');
 if(!(document.getElementById('rulers') as HTMLInputElement).checked){overlay.innerHTML='';return;}
 const span=width/camera.zoom,raw=span/6,scale=10**Math.floor(Math.log10(raw)),step=([1,2,5,10].find(n=>n*scale>=raw)??10)*scale;
 const x0=(camera.x-.5/camera.zoom)*width,y0=(camera.y-.5/camera.zoom)*height;
 let lines='',labelsX='',labelsY='';
 for(const [axis,limit,start,size]of [['x',width,x0,width],['y',height,y0,height]] as const){
  for(let value=Math.ceil(start/(step/5))*(step/5);value<=Math.min(limit,start+size/camera.zoom);value+=step/5){
   const p=(value-start)/size*camera.zoom*100,major=Math.abs(value/step-Math.round(value/step))<.001;
   lines+=axis==='x'?`<line x1="${p}%" x2="${p}%" y1="0" y2="100%" opacity="${major?.28:.09}"/>`:`<line x1="0" x2="100%" y1="${p}%" y2="${p}%" opacity="${major?.28:.09}"/>`;
   if(major){if(axis==='x')labelsX+=`<text x="${p}%" y="14">${value.toFixed(0)}</text>`;else labelsY+=`<text x="1" y="${p}%">${value.toFixed(0)}</text>`;}
  }
 }
 const clip=shape==='circle'?`<defs><clipPath id="cup-ruler-clip"><ellipse cx="${((.5-camera.x)*camera.zoom+.5)*100}%" cy="${((.5-camera.y)*camera.zoom+.5)*100}%" rx="${camera.zoom*50}%" ry="${camera.zoom*50}%"/></clipPath></defs>`:'';
 overlay.innerHTML=`<svg class="ruler-grid" width="100%" height="100%">${clip}<g ${shape==='circle'?'clip-path="url(#cup-ruler-clip)"':''} stroke="#d0e4d8" stroke-width="1">${lines}</g></svg><svg class="ruler-x" width="100%" height="20" aria-label="X, мм"><g fill="#dfebe1" font-size="10">${labelsX}</g></svg><svg class="ruler-y" width="28" height="100%" aria-label="Y, мм"><g fill="#dfebe1" font-size="10">${labelsY}</g></svg>`;
}
