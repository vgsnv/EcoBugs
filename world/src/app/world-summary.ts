import { flowAt, insideDish, isBlocked, mineralInDeposits, mineralInEruptions, mineralInMedium, millimetresPerSecond, type MineralExchanges, type World } from '../core/index.ts';
import { formatArea, formatDuration, formatLength, formatMass, formatNumber, formatPercent, formatWorldAge } from './units.ts';

type Sample = { step: number; water: number; shallows: number; land: number; depths: number; medium: number; deposits: number; eruptions: number; emitted: number; funnelSunk: number };

/** История наблюдения, а не состояние физики. При смене/загрузке мира начинается заново. */
export class WorldSummary {
  private exchanges: MineralExchanges = { emitted: 0, funnelSunk: 0 };
  private history: Sample[] = [];
  private lastRender = -Infinity;
  private lastStep = -1;
  private readonly values = new Map<string, HTMLElement>();
  constructor(privateRoot: HTMLElement) {
    this.root = privateRoot;
    privateRoot.innerHTML = '<div class="legend-head"><h2>Сводка мира</h2></div>';
    const groups: [string, [string, string][]][] = [
      ['Мир', [['size', 'Размеры'], ['area', 'Площадь'], ['age', 'Возраст'], ['water', 'Вода'], ['shallows', 'Отмель'], ['land', 'Суша']]],
      ['Минерал', [['total', 'Всего без грунта'], ['depths', 'В недрах'], ['medium', 'В среде'], ['deposits', 'В залежах'], ['transit', 'В извержениях']]],
      ['Сейчас', [['volcanoes', 'Активные вулканы'], ['funnels', 'Воронки'], ['movements', 'Подвижки / толчки'], ['flow', 'Среднее течение']]],
      ['Изменения', [['period', 'Период наблюдения'], ['deltaWater', 'Вода'], ['deltaShallows', 'Отмель'], ['deltaLand', 'Суша'], ['deltaDepths', 'Недра'], ['deltaMedium', 'Среда'], ['deltaDeposits', 'Залежи'], ['deltaEruptions', 'Извержений началось'], ['emitted', 'Выброшено вулканами'], ['funnelSunk', 'Воронки → недра']]],
    ];
    for (const [title, rows] of groups) {
      const section = document.createElement('section'); section.className = 'summary-section';
      const heading = document.createElement('h3'); heading.textContent = title; section.append(heading);
      const list = document.createElement('dl');
      for (const [key, label] of rows) {
        const name = document.createElement('dt'); name.textContent = label;
        const value = document.createElement('dd'); value.textContent = '—';
        this.values.set(key, value); list.append(name, value);
      }
      section.append(list); privateRoot.append(section);
    }
    const note = document.createElement('p'); note.className = 'summary-note';
    note.textContent = 'Изменения — разница наблюдений примерно за минуту мира; точный период указан выше. Изменения запасов — итоговый баланс; потоки вулканов и воронок считаются отдельно. После загрузки наблюдение начинается заново.';
    privateRoot.append(note);
  }
  private readonly root: HTMLElement;

  reset(world: World): void { this.history = []; this.exchanges = { emitted: 0, funnelSunk: 0 }; this.lastRender = -Infinity; this.lastStep = -1; this.observe(world); }

  observe(world: World, exchanges = this.exchanges): void {
    this.exchanges = { ...exchanges };
    const previous = this.history.at(-1);
    if (previous && world.step - previous.step < 10) return;
    const shares = world.viscosity.shares, mineral = world.mineral;
    this.history.push({ step: world.step, ...shares, depths: mineral.depths, medium: mineralInMedium(mineral), deposits: mineralInDeposits(world.terrain), eruptions: mineral.eruptions, ...this.exchanges });
    if (this.history.length > 128) this.history.shift();
  }

  render(world: World, now: number): void {
    if (this.root.hidden) { this.lastRender = -Infinity; return; }
    if (now - this.lastRender < 500 || (world.step === this.lastStep && this.lastRender !== -Infinity)) return;
    this.lastRender = now; this.lastStep = world.step;
    const set = (key: string, text: string) => { this.values.get(key)!.textContent = text; };
    const m = world.mineral, s = world.viscosity.shares;
    const medium = mineralInMedium(m), deposits = mineralInDeposits(world.terrain), transit = mineralInEruptions(m);
    const d = world.dish;
    set('size', d.shape === 'circle' ? `Ø ${formatLength(d.width)}` : `${formatLength(d.width)} × ${formatLength(d.height)}`);
    set('area', formatArea(d.shape === 'circle' ? Math.PI * (d.width / 2) ** 2 : d.width * d.height));
    set('age', formatWorldAge(world.step));
    for (const key of ['water', 'shallows', 'land'] as const) set(key, formatPercent(s[key]));
    set('total', formatMass(m.depths + medium + deposits + transit));
    set('depths', formatMass(m.depths)); set('medium', formatMass(medium)); set('deposits', formatMass(deposits)); set('transit', formatMass(transit));
    set('volcanoes', `${m.volcanoes.filter(v => v.stage === 'erupting').length} извергаются · ${m.volcanoes.filter(v => v.stage === 'preparing').length} готовятся`);
    set('funnels', String(m.funnels.length));
    set('movements', `${world.terrain.active.filter(v => !v.quake).length} / ${world.terrain.active.filter(v => v.quake).length}`);
    let sum = 0, count = 0;
    for (let j = 0; j < 15; j++) for (let i = 0; i < 20; i++) {
      const x = (i + 0.5) * d.width / 20, y = (j + 0.5) * d.height / 15;
      if (!insideDish(d, x, y) || isBlocked(world.partitions, x, y)) continue;
      sum += Math.hypot(...flowAt(world, x, y)); count++;
    }
    set('flow', count ? `≈ ${formatNumber(millimetresPerSecond(sum / count))} мм/с` : '—');
    this.values.get('flow')!.title = 'Средняя величина скорости по равномерной сетке 20 × 15, без стен и участков вне чашки.';
    let baseline = this.history[0];
    for (const sample of this.history) { if (sample.step <= world.step - 600) baseline = sample; else break; }
    const elapsed = baseline ? world.step - baseline.step : 0;
    set('period', elapsed > 0 ? `За ${formatDuration(elapsed)}` : 'Ожидаем изменения');
    const signed = (delta: number, format: (n: number) => string) => {
      const text = format(Math.abs(delta));
      return text === format(0) ? text : `${delta > 0 ? '↑ +' : '↓ −'}${text}`;
    };
    for (const [key, source] of [['deltaWater', 'water'], ['deltaShallows', 'shallows'], ['deltaLand', 'land']] as const)
      set(key, elapsed ? signed(s[source] - baseline[source], n => `${formatNumber(n * 100)} п.п.`) : '—');
    for (const [key, value, source] of [['deltaDepths', m.depths, 'depths'], ['deltaMedium', medium, 'medium'], ['deltaDeposits', deposits, 'deposits']] as const)
      set(key, elapsed ? signed(value - baseline[source], formatMass) : '—');
    set('deltaEruptions', elapsed ? String(m.eruptions - baseline.eruptions) : '—');
    set('emitted', elapsed ? formatMass(this.exchanges.emitted - baseline.emitted) : '—');
    set('funnelSunk', elapsed ? formatMass(this.exchanges.funnelSunk - baseline.funnelSunk) : '—');
  }
}
