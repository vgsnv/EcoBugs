export class WorldSummary {
  private readonly values=new Map<string,HTMLElement>();
  constructor(privateRoot: HTMLElement) {
    this.root = privateRoot;
    privateRoot.innerHTML = '<div class="legend-head"><h2>Сводка мира</h2></div>';
    const groups: [string, [string, string][]][] = [
      ['Мир', [['size', 'Размеры'], ['area', 'Площадь'], ['age', 'Возраст'], ['water', 'Вода'], ['shallows', 'Отмель'], ['land', 'Суша']]],
      ['Минерал', [['total', 'Всего без грунта'], ['depths', 'В недрах'], ['medium', 'В среде'], ['deposits', 'В залежах'], ['transit', 'Из среды: в полёте']]],
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

  render(values:Record<string,string>,step:number):void{this.root.dataset.step=String(step);for(const [key,value]of Object.entries(values)){const node=this.values.get(key);if(node&&node.textContent!==value)node.textContent=value;}}
}
