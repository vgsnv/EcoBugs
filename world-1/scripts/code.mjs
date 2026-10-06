/** «Код как вещество» без браузера. npm run code -- --seeds 1 --ticks 20000 --every 2000 */
import { createSoup, step, snapshot, resetWindow, LAWS } from '../src/code/vm.ts';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1]] : null).filter(Boolean));
for (const kv of String(args.set ?? '').split(',').filter(Boolean)) { const [k, v] = kv.split('='); if (!(k in LAWS)) throw Error(`нет закона ${k}`); LAWS[k] = Number(v); }
const seeds = String(args.seeds ?? '1').split(',').map(Number), ticks = Number(args.ticks ?? 20000), every = Number(args.every ?? 2000);
for (const seed of seeds) {
  const soup = createSoup(seed), t0 = performance.now();
  console.log(`== сид ${seed}`);
  for (let t = 1; t <= ticks; t++) {
    step(soup);
    if (t % every === 0) {
      const s = snapshot(soup);
      console.log(`${t}\tнас ${s.population}\tгенот ${s.genotypes}\tразмер ${s.meanSize.toFixed(1)}\tзанято ${Math.round(s.fill * 100)}%\tчужой код ${Math.round(s.foreignShare * 100)}%\tмусор ${Math.round(s.junkShare * 100)}%\tрожд ${s.births}\tкоманд ${s.executed}\t| размеры ${s.sizes.map(([z, c]) => `${z}×${c}`).join(' ')}`);
      resetWindow(soup);
      if (!s.population) break;
    }
  }
  console.error(`сид ${seed}: ${((performance.now() - t0) / 1000).toFixed(1)} с`);
}
