/**
 * Единый прогон всех проверок. Первое, что должен запустить принимающий
 * разработчик: если всё зелёное — ядро приехало целым.
 *
 *   node sim/all-tests.ts
 */
const suites = ['./check-invariants.ts', './tests.ts', './render-test.ts', './serialize-test.ts'];
let failed = 0;

for (const s of suites) {
  console.log(`\n${'═'.repeat(60)}\n  ${s}\n${'═'.repeat(60)}`);
  try {
    // Каждый набор сам печатает результат и делает process.exit при провале;
    // импортируем в отдельном процессе через child_process для изоляции.
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync(process.execPath, [new URL(s, import.meta.url).pathname], {
      encoding: 'utf8',
    });
    console.log(out.trim());
  } catch (e: any) {
    failed++;
    console.log(e.stdout?.trim() ?? '');
    console.log(`  ✗ НАБОР ПРОВАЛЕН: ${s}`);
  }
}

console.log(`\n${'═'.repeat(60)}`);
console.log(failed === 0
  ? '  ВСЁ ЗЕЛЁНОЕ — ядро приехало целым.'
  : `  ПРОВАЛЕНО НАБОРОВ: ${failed}`);
console.log('═'.repeat(60) + '\n');
process.exit(failed === 0 ? 0 : 1);
