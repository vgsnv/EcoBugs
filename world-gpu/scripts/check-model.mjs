import assert from 'node:assert/strict';
import { emittedQuanta, averagedVents } from '../src/vents.ts';
import { createGrid, SCENES, massByComponent } from '../src/model.ts';

for (const cols of [32, 64, 128]) for (const scene of Object.keys(SCENES)) {
  const grid = createGrid(scene, cols);
  const repeated = createGrid(scene, cols);
  assert.deepEqual(grid.geometry, repeated.geometry);
  assert.deepEqual(grid.state, repeated.state);
  const sums = [], scales = [];
  for (let k = 0; k < grid.components.length; k++) {
    const group = grid.components[k];
    if (group < 0) {
      assert.equal(grid.state[k * 4], 0);
      continue;
    }
    sums[group] = (sums[group] ?? 0) + grid.geometry[k * 4 + 1];
    scales[group] = (scales[group] ?? 0) + Math.abs(grid.geometry[k * 4 + 1]);
  }
  assert.ok(sums.every((sum, id) => Math.abs(sum) <= Math.max(1e-7, scales[id] * 1e-6)), `${scene}: unbalanced closed region`);
  assert.equal(massByComponent(grid, grid.state).reduce((a, b) => a + b, 0), grid.total);
  assert.ok(grid.total < 0xffffffff);
  assert.equal(new Set([...grid.components].filter(id => id >= 0)).size, scene === 'wall' || scene === 'light-wall' || scene === 'vent-wall' || scene === 'flight-wall' || scene === 'flight-impact' || scene === 'flight-slide' ? 2 : 1);
}
console.log(`${Object.keys(SCENES).length * 3} scenes: source balance per connected region, bounded integer mass, deterministic setup, impermeable geometry.`);

const pulse={cell:0,rate:50000,start:.25,end:.45,mass:1000000};
assert.equal(averagedVents([pulse],0)[1],10000);
assert.equal(averagedVents([pulse],1)[1],0);
assert.equal(Array.from({length:20},(_,step)=>emittedQuanta(pulse,step)).reduce((a,b)=>a+b,0),1000000);
assert.deepEqual(Array.from({length:5},(_,step)=>emittedQuanta(pulse,step)),[0,0,250000,500000,250000]);
console.log('Short impulse integration and quantized mineral emission are exact.');
