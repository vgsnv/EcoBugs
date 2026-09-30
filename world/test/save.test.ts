import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeParams } from '../src/core/params.ts';
import { createWorld, stepWorld, worldHash } from '../src/core/world.ts';
import { WORLD_FORMAT_VERSION, WorldFileError, parseWorldFile, serializeWorld, worldToFile } from '../src/core/save.ts';
import { lightAt } from '../src/core/light.ts';

function sample() {
  const w = createWorld(makeParams({ seed: 314, layout: 'mixed', illumination: 0.4, viscosityShares: { water: 0.5, shallows: 0.3, land: 0.2 } }));
  for (let i = 0; i < 1234; i++) stepWorld(w);
  return w;
}

function rejects(text: string, fragment: string): void {
  assert.throws(() => parseWorldFile(text), (e: unknown) => {
    assert.ok(e instanceof WorldFileError);
    assert.ok(e.problems.some((p) => p.includes(fragment)), `причины: ${e.problems.join(' | ')}`);
    return true;
  });
}

test('после сохранения и загрузки состояние совпадает', () => {
  const w = sample();
  const loaded = parseWorldFile(serializeWorld(w, new Date('2026-09-30T12:00:00Z')));
  assert.equal(loaded.step, 1234);
  assert.deepEqual(loaded.params, w.params);
  assert.equal(worldHash(loaded), worldHash(w));
  assert.deepEqual(loaded.viscosity.levels, w.viscosity.levels);
  assert.deepEqual(loaded.partitions.blocked, w.partitions.blocked);
});

test('загруженный мир продолжает жить так же, как исходный', () => {
  const w = sample();
  const loaded = parseWorldFile(serializeWorld(w));
  for (let i = 0; i < 500; i++) { stepWorld(w); stepWorld(loaded); }
  assert.equal(worldHash(loaded), worldHash(w));
  for (let i = 0; i < 100; i++) {
    const x = (i * 13.7) % 800; const y = (i * 7.3) % 600;
    assert.equal(lightAt(loaded.light, x, y, loaded.step), lightAt(w.light, x, y, w.step));
  }
});

test('файл содержит метку формата, версию и контрольную сумму', () => {
  const file = worldToFile(sample());
  assert.equal(file.format, 'ecobugs-world');
  assert.equal(file.version, WORLD_FORMAT_VERSION);
  assert.match(file.checksum, /^[0-9a-f]{8}$/);
});

test('время сохранения не влияет на контрольную сумму', () => {
  const w = sample();
  const a = worldToFile(w, new Date('2020-01-01'));
  const b = worldToFile(w, new Date('2030-01-01'));
  assert.equal(a.checksum, b.checksum);
});

test('битые файлы отклоняются с понятной причиной', () => {
  const good = worldToFile(sample());
  const edit = (f: (d: any) => void) => { const d = structuredClone(good) as any; f(d); return JSON.stringify(d); };

  rejects('{ не json', 'не JSON');
  rejects('{"hello": 1}', 'нет метки формата');
  rejects(edit((d) => { d.version = 99; }), 'более новой версией');
  rejects(edit((d) => { delete d.version; }), 'версия');
  rejects(edit((d) => { d.params.sun = 7; }), 'Контрольная сумма не совпадает');
  rejects(edit((d) => { d.step = 1235; }), 'Контрольная сумма не совпадает');
  rejects(edit((d) => { d.step = -1; }), 'Номер шага');
  rejects(edit((d) => { d.step = 1.5; }), 'Номер шага');
  rejects(edit((d) => { delete d.checksum; }), 'контрольной суммы');
  rejects(edit((d) => { d.params.layout = 'labyrinth'; }), 'неизвестная заготовка');
  rejects(edit((d) => { d.params.backgroundLevel = 2; }), 'Яркость фона');
  rejects(edit((d) => { delete d.params.spotSize; }), 'Нет параметра «spotSize»');
  rejects(edit((d) => { delete d.params; }), 'Нет параметров');
  rejects(edit((d) => { d.params.viscosityShares = { water: 0.5, shallows: 0.5 }; }), 'Доля суши');
});

test('лишние поля в параметрах не мешают, но и не попадают в мир', () => {
  const d = worldToFile(sample()) as any;
  d.params.somethingNew = 42;
  const loaded = parseWorldFile(JSON.stringify(d));
  assert.ok(!('somethingNew' in loaded.params));
});
