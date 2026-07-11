/**
 * Автопроверка инвариантов из CLAUDE.md.
 *
 * Смысл: правила, записанные только текстом, нарушаются незаметно. Здесь они
 * становятся исполняемым контрактом — регресс падает в CI, а не всплывает
 * через месяц как «мир после resume не совпадает».
 *
 *   node sim/check-invariants.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '../src/world.ts';
import { defaultGenesis, defaultConfig } from '../src/config.ts';
import { snapshot, restore } from '../src/serialize.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
let failed = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failed++; console.log(`  ✗ ${name}${detail ? '\n      ' + detail : ''}`); }
};

const srcFiles = readdirSync(SRC).filter((f) => f.endsWith('.ts'));
const read = (f: string) => readFileSync(join(SRC, f), 'utf8');

/** Убираем комментарии, чтобы не ловить упоминания в документации. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

console.log('\nИнвариант 1: ноль Math.random() в ядре (иначе ломается детерминизм)');
{
  const bad: string[] = [];
  for (const f of srcFiles) {
    if (/Math\s*\.\s*random/.test(stripComments(read(f)))) bad.push(f);
  }
  ok('нет Math.random() в src/', bad.length === 0, bad.join(', '));
}

console.log('\nИнвариант 2: ядро headless (ноль импортов React/RN/Skia)');
{
  const bad: string[] = [];
  for (const f of srcFiles) {
    const code = stripComments(read(f));
    if (/from\s+['"](react|react-native|react-native-reanimated|@shopify\/)/.test(code)) bad.push(f);
  }
  ok('нет UI-импортов в src/', bad.length === 0, bad.join(', '));
}

console.log('\nИнвариант 3: детерминизм — один сид даёт идентичную историю');
{
  const a = new World(defaultGenesis(4242), defaultConfig());
  const b = new World(defaultGenesis(4242), defaultConfig());
  for (let t = 0; t < 3000; t++) { a.step(); b.step(); }
  ok('сид 4242: два мира совпали', a.hash() === b.hash(), `${a.hash()} vs ${b.hash()}`);

  const c = new World(defaultGenesis(4243), defaultConfig());
  for (let t = 0; t < 3000; t++) c.step();
  ok('другой сид → другая история', a.hash() !== c.hash());
}

console.log('\nИнвариант 4: детерминизм держится при вмешательстве в таймлайн');
{
  const mk = () => {
    const w = new World(defaultGenesis(99), defaultConfig());
    const base = w.config.sunlight;
    w.schedule({ startTick: 500, endTick: 1200, param: 'sunlight',
      fromValue: base, toValue: base * 0.15, easing: 'smooth' });
    return w;
  };
  const a = mk(), b = mk();
  for (let t = 0; t < 2500; t++) { a.step(); b.step(); }
  ok('катаклизм воспроизводится', a.hash() === b.hash());
}

console.log('\nИнвариант 5: всё, влияющее на будущее, сериализуется');
{
  // Непрерывный прогон против «снимок в середине + догон».
  const cont = new World(defaultGenesis(31337), defaultConfig());
  for (let t = 0; t < 4000; t++) cont.step();

  const a = new World(defaultGenesis(31337), defaultConfig());
  for (let t = 0; t < 2000; t++) a.step();
  const restored = restore(JSON.parse(JSON.stringify(snapshot(a))));
  for (let t = 0; t < 2000; t++) restored.step();

  ok('снимок → восстановление → догон совпадает с непрерывным',
    cont.hash() === restored.hash(),
    `непрерывно=${cont.hash()} догон=${restored.hash()}\n      ` +
    `Скорее всего, новое поле влияет на симуляцию, но не попало в serialize.ts`);
}

console.log('\n' + '─'.repeat(58));
if (failed === 0) {
  console.log('  ИНВАРИАНТЫ ЦЕЛЫ.');
} else {
  console.log(`  НАРУШЕНО ИНВАРИАНТОВ: ${failed}. Читай CLAUDE.md, раздел «Инварианты».`);
}
console.log('─'.repeat(58) + '\n');
process.exit(failed === 0 ? 0 : 1);
