/** Эволюционная лаборатория без браузера: прогоны на нескольких сидах. npm run evo -- --seeds 1,2,3 --ticks 20000 --every 2000 */
import { createSim, step, snapshot, resetWindow, ACTIONS, describeRule, LAWS } from '../src/evo/sim.ts';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1]] : null).filter(Boolean));
// --set predation=0,spotDrift=0 — законы для опыта.
for (const kv of String(args.set ?? '').split(',').filter(Boolean)) { const [k, v] = kv.split('='); if (!(k in LAWS)) throw Error(`нет закона ${k}`); LAWS[k] = Number(v); }
const seeds = String(args.seeds ?? '1').split(',').map(Number), ticks = Number(args.ticks ?? 20000), every = Number(args.every ?? 2000);
for (const seed of seeds) {
  const sim = createSim(seed), t0 = performance.now();
  console.log(`== сид ${seed}`);
  for (let t = 1; t <= ticks; t++) {
    step(sim);
    if (t % every === 0) {
      const s = snapshot(sim), newEst = sim.stats.newEstablished;
      const acts = s.actions.map((v, k) => v > 0.02 ? `${ACTIONS[k]} ${Math.round(v * 100)}%` : '').filter(Boolean).join(', ');
      console.log(`${t}\tнас ${s.population}\tгенот ${s.genotypes}\tзакрепл ${s.established} (+${newEst})\tправил ${s.meanRules.toFixed(1)} (живых ${s.meanLiving.toFixed(1)})/${s.maxRules}\tтело ${s.meanBody.toFixed(2)}\tсвяз ${Math.round(s.bonded * 100)}%\tубийств ${s.kills}\tминерал ${s.mineralTotal.toFixed(0)}\t| ${acts}`);
      resetWindow(sim);
      if (!s.population) break;
    }
  }
  const top = [...sim.genotypes.values()].sort((a, b) => b.count - a.count).slice(0, 3);
  for (const g of top) console.log(`  генотип №${g.id} (${g.count}):`, g.rules.map((r, k) => `${describeRule(r)} [${(100 * g.fired[k] / (g.fired.reduce((a, b) => a + b, 0) || 1)).toFixed(1)}%]`).join(' | '));
  console.error(`сид ${seed}: ${((performance.now() - t0) / 1000).toFixed(1)} с`);
}
