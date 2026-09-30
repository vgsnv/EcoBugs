/**
 * Панель песочницы: параметры мира, время, слои, подсказка под курсором.
 * Параметры задаются при сотворении, поэтому правки копятся в черновике
 * и применяются кнопкой «Создать мир».
 */
import { LAYOUTS, LAYOUT_PRESETS, makeParams, validateParams, type WorldParams } from '../core/index.ts';
import { LAYER_NAMES, type Layer } from './render.ts';

export const SPEEDS = [1, 10, 100, 300, 1000, 3000, 10000] as const;

export interface PanelHandlers {
  onCreate(params: WorldParams): void;
  onTogglePause(): void;
  onStepOnce(): void;
  onSpeed(speed: number): void;
  onLayer(layer: Layer): void;
  onPartitions(show: boolean): void;
  onSave(): void;
  onLoad(file: File): void;
}

type NumberKey = 'sun' | 'backgroundLevel' | 'illumination' | 'spotSize' | 'baseTemperature' | 'spotHeat' | 'baseViscosity' | 'viscosityZoneSize';

interface SliderSpec {
  key: NumberKey;
  label: string;
  min: number;
  max: number;
  step: number;
}

const GROUPS: readonly { title: string; sliders: readonly SliderSpec[] }[] = [
  {
    title: 'Свет',
    sliders: [
      { key: 'sun', label: 'Солнце', min: 0.1, max: 3, step: 0.1 },
      { key: 'backgroundLevel', label: 'Яркость фона', min: 0.02, max: 0.9, step: 0.01 },
      { key: 'illumination', label: 'Освещённость', min: 0.05, max: 0.8, step: 0.01 },
      { key: 'spotSize', label: 'Размер пятен', min: 15, max: 200, step: 1 },
    ],
  },
  {
    title: 'Температура',
    sliders: [
      { key: 'baseTemperature', label: 'Базовая', min: 0.1, max: 3, step: 0.05 },
      { key: 'spotHeat', label: 'Нагрев в пятнах', min: 0, max: 3, step: 0.05 },
    ],
  },
  {
    title: 'Вязкость',
    sliders: [
      { key: 'baseViscosity', label: 'Базовая', min: 0.1, max: 5, step: 0.1 },
      { key: 'viscosityZoneSize', label: 'Размер зон', min: 30, max: 300, step: 5 },
    ],
  },
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));

export class Panel {
  private draft: WorldParams;
  private readonly errorsBox = el('div', { className: 'errors' });
  private readonly dirtyNote = el('div', { className: 'note' });
  private readonly waterValue = el('span', { className: 'value' });
  private readonly timeLabel = el('div', { className: 'time' });
  private readonly pauseButton = el('button');
  private readonly speedButtons = new Map<number, HTMLButtonElement>();
  private readonly stepButton = el('button', { textContent: '+1 шаг' });
  private readonly probeBox = el('div', { className: 'probe' });
  private readonly createButton = el('button', { className: 'primary', textContent: 'Создать мир' });
  private readonly fileStatus = el('div', { className: 'note' });
  private readonly revertButton = el('button', { textContent: 'Отменить правки' });
  private readonly defaultsButton = el('button', { textContent: 'По умолчанию' });
  private readonly inputs: (() => void)[] = [];
  private current: WorldParams;

  private readonly handlers: PanelHandlers;

  constructor(root: HTMLElement, initial: WorldParams, handlers: PanelHandlers) {
    this.handlers = handlers;
    this.draft = structuredClone(initial);
    this.current = structuredClone(initial);
    root.append(
      this.worldSection(),
      ...GROUPS.map((g) => this.sliderGroup(g.title, g.sliders, g.title === 'Вязкость' ? this.sharesRows() : [])),
      this.dirtyNote,
      this.errorsBox,
      this.createButton,
      el('span', { className: 'row' }, this.revertButton, this.defaultsButton),
      this.timeSection(),
      this.layerSection(),
      this.fileSection(),
      el('section', {}, el('h3', { textContent: 'Под курсором' }), this.probeBox),
    );
    this.revertButton.addEventListener('click', () => this.replaceDraft(this.current));
    this.defaultsButton.addEventListener('click', () => this.replaceDraft(makeParams({ seed: this.draft.seed })));
    this.createButton.addEventListener('click', () => {
      if (validateParams(this.draft).length === 0) handlers.onCreate(structuredClone(this.draft));
    });
    this.refresh();
    this.setProbe(null);
  }

  /** Мир создан с этими параметрами — черновик совпадает с миром. */
  setCurrent(params: WorldParams): void {
    this.current = structuredClone(params);
    this.draft = structuredClone(params);
    for (const sync of this.inputs) sync();
    this.refresh();
  }

  /** Заменить черновик целиком и обновить все поля панели. */
  private replaceDraft(params: WorldParams): void {
    this.draft = structuredClone(params);
    for (const sync of this.inputs) sync();
    this.refresh();
  }

  private worldSection(): HTMLElement {
    const seed = el('input', { type: 'number', min: '0', max: String(0xffffffff), step: '1' });
    const random = el('button', { textContent: 'Случайный' });
    const layout = el('select', {}, ...LAYOUTS.map((id) => el('option', { value: id, textContent: LAYOUT_PRESETS[id].name })));
    const size = el('select', {}, ...['800×600', '1200×600', '600×600', '1000×500'].map((s) => el('option', { value: s, textContent: s })));

    seed.addEventListener('input', () => { this.draft.seed = Number(seed.value); this.refresh(); });
    random.addEventListener('click', () => {
      this.draft.seed = Math.floor(Math.random() * 0xffffffff);
      seed.value = String(this.draft.seed);
      this.refresh();
    });
    layout.addEventListener('change', () => { this.draft.layout = layout.value as WorldParams['layout']; this.refresh(); });
    size.addEventListener('change', () => {
      const [w, h] = size.value.split('×').map(Number);
      this.draft.width = w;
      this.draft.height = h;
      this.refresh();
    });
    this.inputs.push(() => {
      seed.value = String(this.draft.seed);
      layout.value = this.draft.layout;
      const key = `${this.draft.width}×${this.draft.height}`;
      if (![...size.options].some((o) => o.value === key)) size.append(el('option', { value: key, textContent: key }));
      size.value = key;
    });
    return el('section', {},
      el('h3', { textContent: 'Мир' }),
      el('label', {}, 'Сид', el('span', { className: 'row' }, seed, random)),
      el('label', {}, 'Планировка', layout),
      el('label', {}, 'Размер чашки', size),
    );
  }

  private slider(spec: SliderSpec): HTMLElement {
    const input = el('input', { type: 'range', min: String(spec.min), max: String(spec.max), step: String(spec.step) });
    const value = el('span', { className: 'value' });
    input.addEventListener('input', () => {
      this.draft[spec.key] = Number(input.value);
      value.textContent = fmt(this.draft[spec.key]);
      this.refresh();
    });
    this.inputs.push(() => {
      input.value = String(this.draft[spec.key]);
      value.textContent = fmt(this.draft[spec.key]);
    });
    return el('label', {}, el('span', { className: 'row' }, spec.label, value), input);
  }

  private sharesRows(): HTMLElement[] {
    const make = (key: 'land' | 'shallows', label: string) => {
      const input = el('input', { type: 'range', min: '0', max: '0.6', step: '0.01' });
      const value = el('span', { className: 'value' });
      input.addEventListener('input', () => {
        this.draft.viscosityShares[key] = Number(input.value);
        this.draft.viscosityShares.water = Math.round((1 - this.draft.viscosityShares.land - this.draft.viscosityShares.shallows) * 100) / 100;
        value.textContent = fmt(this.draft.viscosityShares[key]);
        this.refresh();
      });
      this.inputs.push(() => {
        input.value = String(this.draft.viscosityShares[key]);
        value.textContent = fmt(this.draft.viscosityShares[key]);
      });
      return el('label', {}, el('span', { className: 'row' }, label, value), input);
    };
    return [
      make('land', 'Доля суши'),
      make('shallows', 'Доля отмели'),
      el('label', {}, el('span', { className: 'row' }, 'Доля воды', this.waterValue)),
    ];
  }

  private sliderGroup(title: string, sliders: readonly SliderSpec[], extra: HTMLElement[]): HTMLElement {
    return el('section', {}, el('h3', { textContent: title }), ...sliders.map((s) => this.slider(s)), ...extra);
  }

  private timeSection(): HTMLElement {
    this.pauseButton.addEventListener('click', () => this.handlers.onTogglePause());
    this.stepButton.addEventListener('click', () => this.handlers.onStepOnce());
    const speeds = el('span', { className: 'row speeds' });
    for (const s of SPEEDS) {
      const b = el('button', { textContent: `×${s.toLocaleString('ru')}` });
      b.addEventListener('click', () => this.handlers.onSpeed(s));
      this.speedButtons.set(s, b);
      speeds.append(b);
    }
    return el('section', {},
      el('h3', { textContent: 'Время' }),
      this.timeLabel,
      el('span', { className: 'row' }, this.pauseButton, this.stepButton),
      speeds,
    );
  }

  private layerSection(): HTMLElement {
    const radios = (Object.keys(LAYER_NAMES) as Layer[]).map((layer, k) => {
      const input = el('input', { type: 'radio', name: 'layer', value: layer, checked: k === 0 });
      input.addEventListener('change', () => this.handlers.onLayer(layer));
      return el('label', { className: 'inline' }, input, LAYER_NAMES[layer]);
    });
    const parts = el('input', { type: 'checkbox', checked: true });
    parts.addEventListener('change', () => this.handlers.onPartitions(parts.checked));
    return el('section', {},
      el('h3', { textContent: 'Слой' }),
      ...radios,
      el('label', { className: 'inline' }, parts, 'Перегородки'),
    );
  }

  private fileSection(): HTMLElement {
    const save = el('button', { textContent: 'Сохранить в файл' });
    const load = el('button', { textContent: 'Загрузить из файла' });
    const picker = el('input', { type: 'file', accept: '.json,application/json', hidden: true });
    save.addEventListener('click', () => this.handlers.onSave());
    load.addEventListener('click', () => picker.click());
    picker.addEventListener('change', () => {
      const file = picker.files?.[0];
      if (file) this.handlers.onLoad(file);
      picker.value = '';
    });
    return el('section', {},
      el('h3', { textContent: 'Файл' }),
      el('span', { className: 'row' }, save, load),
      picker,
      this.fileStatus,
    );
  }

  /** Итог сохранения или загрузки: сообщение или список причин отказа. */
  setFileStatus(lines: readonly string[], isError: boolean): void {
    this.fileStatus.className = isError ? 'errors' : 'note';
    this.fileStatus.replaceChildren(...lines.map((l) => el('div', { textContent: l })));
  }

  setTime(step: number, paused: boolean, speed: number, stepsPerSecond: number): void {
    this.timeLabel.textContent = `Шаг ${step.toLocaleString('ru')} · ${paused ? 'пауза' : `${Math.round(stepsPerSecond).toLocaleString('ru')} шагов/с`}`;
    this.pauseButton.textContent = paused ? '▶ Пуск' : '⏸ Пауза';
    this.stepButton.disabled = !paused;
    for (const [s, b] of this.speedButtons) b.classList.toggle('active', s === speed);
  }

  setProbe(lines: readonly string[] | null): void {
    this.probeBox.replaceChildren(...(lines ?? ['Наведите курсор на чашку']).map((l) => el('div', { textContent: l })));
  }

  private refresh(): void {
    const s = this.draft.viscosityShares;
    s.water = Math.round((1 - s.land - s.shallows) * 100) / 100;
    this.waterValue.textContent = fmt(s.water);
    const errors = validateParams(this.draft);
    this.errorsBox.replaceChildren(...errors.map((e) => el('div', { textContent: e })));
    this.createButton.disabled = errors.length > 0;
    const dirty = JSON.stringify(this.draft) !== JSON.stringify(this.current);
    this.dirtyNote.textContent = dirty ? 'Параметры задаются при сотворении — изменения применятся к новому миру.' : '';
    this.revertButton.disabled = !dirty;
    this.defaultsButton.disabled = JSON.stringify(this.draft) === JSON.stringify(makeParams({ seed: this.draft.seed }));
  }
}

