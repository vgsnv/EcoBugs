/**
 * Экран аквариума. Фазы 1–2:
 *  - Skia-рой (цвет и размер существ — из генов);
 *  - живые слайдеры «солнце» и «температура»;
 *  - оверлей статистики + спарклайн популяции;
 *  - инспектор особи по тапу.
 *
 * Требует: @shopify/react-native-skia, react-native-reanimated,
 *          react-native-worklets, @react-native-community/slider.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  useWindowDimensions,
  Pressable,
  Modal,
  type GestureResponderEvent,
} from 'react-native';
import { SafeAreaView, SafeAreaProvider } from 'react-native-safe-area-context';
import Slider from '@react-native-community/slider';
import { AquariumCanvas } from './AquariumCanvas.tsx';
import {
  useSimulation,
  CLIMATE,
  PLAN_HORIZON,
  type Inspected,
  type ResumeSummary,
  type NarrativeEvent,
  type ClimateKind,
  type ClimateView,
} from './useSimulation.ts';

const DAY_TICKS = 3000; // длительность суточного цикла света (~100 с при 30 tps)

export default function App() {
  return (
    <SafeAreaProvider>
      <Aquarium />
    </SafeAreaProvider>
  );
}

function Aquarium() {
  const { width } = useWindowDimensions();
  const view = width; // квадратный аквариум по ширине экрана
  const sim = useSimulation();
  const [sun, setSun] = useState(6);
  const [temp, setTemp] = useState(1);
  const [playing, setPlaying] = useState(true);
  const [inspected, setInspected] = useState<Inspected | null>(null);
  const [plannerOpen, setPlannerOpen] = useState(false);

  const scale = view / sim.worldSize;
  const onTapWater = (e: GestureResponderEvent) => {
    const { locationX, locationY } = e.nativeEvent;
    setInspected(sim.inspectAt(locationX / scale, locationY / scale));
  };

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <View
        style={[styles.tank, { width: view, height: view }]}
        onStartShouldSetResponder={() => true}
        onResponderRelease={onTapWater}
      >
        <AquariumCanvas
          worldSize={sim.worldSize}
          viewSize={view}
          posX={sim.posX}
          posY={sim.posY}
          radius={sim.radius}
          hue={sim.hue}
          count={sim.count}
          foodX={sim.foodX}
          foodY={sim.foodY}
          foodCount={sim.foodCount}
          trail={sim.trail}
          clock={sim.clock}
          sunlight={sun}
          dayPhase={(Math.sin((sim.stats.tick * 2 * Math.PI) / DAY_TICKS) + 1) / 2}
        />

        <View style={styles.readout} pointerEvents="none">
          <Stat k="Популяция" v={String(sim.stats.population)} big />
          <Stat k="Эпоха" v={sim.stats.tick.toLocaleString('ru')} />
          <Stat k="Ø размер" v={sim.stats.meanSize.toFixed(2)} />
          <Stat k="Ø скорость" v={sim.stats.meanSpeed.toFixed(2)} />
          <View style={styles.sparkWrap}>
            <Sparkline data={sim.stats.history} />
          </View>
        </View>

        {inspected && <Inspector data={inspected} onClose={() => setInspected(null)} />}
        {sim.event && !sim.catchingUp && <EventToast event={sim.event} />}
        {sim.catchingUp && (
          <View style={styles.catchup} pointerEvents="none">
            <Text style={styles.catchupText}>⏩ Догоняю мир</Text>
            <Text style={styles.catchupPct}>{sim.catchupPct}%</Text>
            <View style={styles.catchupBar}>
              <View style={[styles.catchupFill, { width: `${sim.catchupPct}%` }]} />
            </View>
          </View>
        )}
        {sim.resumeSummary && (
          <ResumeCard data={sim.resumeSummary} onClose={sim.dismissSummary} />
        )}
      </View>

      <View style={styles.panel}>
        <SliderRow
          label="☀ Солнечный свет"
          value={sun}
          format={(v) => v.toFixed(1)}
          min={0}
          max={18}
          onChange={(v) => {
            setSun(v);
            sim.setSunlight(v);
          }}
        />
        <SliderRow
          label="🌡 Температура"
          value={temp}
          format={(v) => v.toFixed(2) + '×'}
          min={0.4}
          max={1.8}
          onChange={(v) => {
            setTemp(v);
            sim.setTemperature(v);
          }}
        />
        <View style={styles.btns}>
          <Btn
            label={playing ? '⏸ Пауза' : '▶ Играть'}
            onPress={() => {
              setPlaying((p) => !p);
              sim.togglePlay();
            }}
          />
          <Btn label="🗓 Планировщик" onPress={() => setPlannerOpen(true)} />
          <Btn
            label="↻ Новый мир"
            onPress={() => {
              sim.reset();
              setInspected(null);
              setSun(6);
              setTemp(1);
              setPlaying(true);
            }}
          />
        </View>
      </View>

      {plannerOpen && (
        <ClimatePlanner
          nowTick={sim.stats.tick}
          getUpcoming={sim.getUpcoming}
          onSchedule={sim.scheduleClimate}
          onCancel={sim.cancelEvent}
          onClose={() => setPlannerOpen(false)}
        />
      )}
    </SafeAreaView>
  );
}

function Stat({ k, v, big }: { k: string; v: string; big?: boolean }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statK}>{k}</Text>
      <Text style={[styles.statV, big && styles.statVbig]}>{v}</Text>
    </View>
  );
}

/** Спарклайн популяции: тонкие столбики из истории (обновляется ~4 раза/сек). */
function Sparkline({ data }: { data: number[] }) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 10);
  return (
    <View style={styles.spark}>
      {data.map((v, i) => (
        <View
          key={i}
          style={{
            width: 2,
            marginRight: 1,
            height: Math.max(1, (v / max) * 34),
            backgroundColor: '#64f0d0',
            opacity: 0.85,
          }}
        />
      ))}
    </View>
  );
}

/** Карточка инспектора особи. */
function Inspector({ data, onClose }: { data: Inspected; onClose: () => void }) {
  const hueColor = `hsl(${Math.round(data.hue * 360)}, 75%, 62%)`;
  return (
    <Pressable style={styles.inspector} onPress={onClose}>
      <View style={styles.inspectHead}>
        <View style={[styles.swatch, { backgroundColor: hueColor }]} />
        <Text style={styles.inspectTitle}>Особь</Text>
        <Text style={styles.inspectClose}>✕</Text>
      </View>
      <Row k="Размер" v={data.size.toFixed(2)} />
      <Row k="Скорость" v={data.speed.toFixed(2)} />
      <Row k="Зрение" v={data.vision.toFixed(1)} />
      <Row k="Метаболизм" v={data.metabolism.toFixed(2)} />
      <Row k="Порог деления" v={data.reproThreshold.toFixed(0)} />
      <Row k="Скорость мутаций" v={data.mutationRate.toFixed(3)} />
      <Row
        k="Стратегия"
        v={
          data.sexualTendency > 0.5
            ? `половое ${Math.round(data.sexualTendency * 100)}%`
            : `деление ${Math.round((1 - data.sexualTendency) * 100)}%`
        }
      />
      <Row k="Энергия" v={data.energy.toFixed(1)} />
      <Row k="Возраст" v={String(data.age)} />
    </Pressable>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.inspectRow}>
      <Text style={styles.inspectK}>{k}</Text>
      <Text style={styles.inspectV}>{v}</Text>
    </View>
  );
}

/** Всплывающая «эпоха» — нарративное событие мира (группа 2: вовлечённость). */
function EventToast({ event }: { event: NarrativeEvent }) {
  const color = event.tone === 'bad' ? '#ff6b6b' : event.tone === 'good' ? '#64f0d0' : '#d3ece8';
  return (
    <View style={styles.epoch} pointerEvents="none">
      <Text style={[styles.epochText, { color, textShadowColor: color }]}>{event.text.toUpperCase()}</Text>
    </View>
  );
}

/** Климатический планировщик (задача 5-2): игрок выкладывает будущие катаклизмы. */
function ClimatePlanner({
  nowTick,
  getUpcoming,
  onSchedule,
  onCancel,
  onClose,
}: {
  nowTick: number;
  getUpcoming: () => ClimateView[];
  onSchedule: (kind: ClimateKind, delayTicks: number) => void;
  onCancel: (id: number) => void;
  onClose: () => void;
}) {
  const [delay, setDelay] = useState(500);
  const [, force] = useState(0);
  const bump = () => force((n) => n + 1);
  const upcoming = getUpcoming(); // перечитывается каждый рендер (nowTick тикает 4/с)
  const kinds = Object.keys(CLIMATE) as ClimateKind[];

  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose} statusBarTranslucent>
    <View style={styles.plannerOverlay}>
      <View style={styles.plannerCard}>
        <View style={styles.plannerHead}>
          <Text style={styles.plannerTitle}>🗓 Климатический планировщик</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={styles.inspectClose}>✕</Text>
          </Pressable>
        </View>
        <Text style={styles.plannerHint}>Выложи будущие катаклизмы — и смотри, как эволюция их переживёт.</Text>

        {/* Таймлайн: сейчас → +горизонт, метки запланированных катаклизмов */}
        <View style={styles.timeline}>
          <View style={styles.timelineNow} />
          {upcoming.map((ev) => {
            const rel = Math.max(0, Math.min(1, (ev.startTick - nowTick) / PLAN_HORIZON));
            return (
              <Pressable
                key={ev.id}
                style={[styles.timelineMark, { left: `${rel * 100}%` }]}
                onPress={() => {
                  onCancel(ev.id);
                  bump();
                }}
              >
                <Text style={styles.timelineMarkIcon}>{CLIMATE[ev.kind].icon}</Text>
              </Pressable>
            );
          })}
        </View>
        <View style={styles.timelineAxis}>
          <Text style={styles.timelineAxisLabel}>сейчас</Text>
          <Text style={styles.timelineAxisLabel}>+{PLAN_HORIZON.toLocaleString('ru')} эпох</Text>
        </View>

        {/* Когда начать */}
        <View style={styles.sliderHead}>
          <Text style={styles.lab}>Начать через</Text>
          <Text style={styles.num}>+{Math.round(delay).toLocaleString('ru')} эпох</Text>
        </View>
        <Slider
          minimumValue={0}
          maximumValue={PLAN_HORIZON}
          value={delay}
          minimumTrackTintColor="#64f0d0"
          maximumTrackTintColor="rgba(255,255,255,0.15)"
          thumbTintColor="#64f0d0"
          onValueChange={setDelay}
        />

        {/* Палитра катаклизмов */}
        <View style={styles.palette}>
          {kinds.map((k) => (
            <Pressable
              key={k}
              style={styles.paletteBtn}
              onPress={() => {
                onSchedule(k, delay);
                bump();
              }}
            >
              <Text style={styles.paletteIcon}>{CLIMATE[k].icon}</Text>
              <Text style={styles.paletteLabel}>{CLIMATE[k].label}</Text>
            </Pressable>
          ))}
        </View>

        {/* Список запланированного */}
        {upcoming.length > 0 && (
          <View style={styles.plannerList}>
            {upcoming.map((ev) => (
              <View key={ev.id} style={styles.plannerRow}>
                <Text style={styles.plannerRowText}>
                  {CLIMATE[ev.kind].icon} {CLIMATE[ev.kind].label} · через {Math.max(0, ev.startTick - nowTick).toLocaleString('ru')} эпох
                </Text>
                <Pressable
                  onPress={() => {
                    onCancel(ev.id);
                    bump();
                  }}
                  hitSlop={8}
                >
                  <Text style={styles.plannerRemove}>✕</Text>
                </Pressable>
              </View>
            ))}
          </View>
        )}
      </View>
    </View>
    </Modal>
  );
}

/** Экран «пока тебя не было» (Фаза 3). */
function ResumeCard({ data, onClose }: { data: ResumeSummary; onClose: () => void }) {
  const away =
    data.awayMinutes >= 60
      ? `${(data.awayMinutes / 60).toFixed(1)} ч`
      : `${Math.max(1, Math.round(data.awayMinutes))} мин`;
  const popDelta = data.popAfter - data.popBefore;
  const sizeDelta = data.sizeAfter - data.sizeBefore;
  return (
    <View style={styles.resumeOverlay}>
      <View style={styles.resumeCard}>
        <Text style={styles.resumeTitle}>Пока тебя не было</Text>
        <Text style={styles.resumeLead}>
          Прошло {data.ticks.toLocaleString('ru')} эпох ≈ {away} реального времени
          {data.capped ? ' (мир достиг предела и замер)' : ''}.
        </Text>
        <Row k="Популяция" v={`${data.popBefore} → ${data.popAfter}  (${popDelta >= 0 ? '+' : ''}${popDelta})`} />
        <Row
          k="Ø размер"
          v={`${data.sizeBefore.toFixed(2)} → ${data.sizeAfter.toFixed(2)}  (${sizeDelta >= 0 ? '+' : ''}${sizeDelta.toFixed(2)})`}
        />
        <Pressable style={styles.resumeBtn} onPress={onClose}>
          <Text style={styles.resumeBtnText}>Продолжить наблюдение</Text>
        </Pressable>
      </View>
    </View>
  );
}

function SliderRow({
  label,
  value,
  format,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  format: (v: number) => string;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <View style={styles.sliderBlock}>
      <View style={styles.sliderHead}>
        <Text style={styles.lab}>{label}</Text>
        <Text style={styles.num}>{format(value)}</Text>
      </View>
      <Slider
        minimumValue={min}
        maximumValue={max}
        value={value}
        minimumTrackTintColor="#64f0d0"
        maximumTrackTintColor="rgba(255,255,255,0.15)"
        thumbTintColor="#64f0d0"
        onValueChange={onChange}
      />
    </View>
  );
}

function Btn({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable style={styles.btn} onPress={onPress}>
      <Text style={styles.btnText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#04121a' },
  tank: { backgroundColor: '#0b2a33', overflow: 'hidden' },
  readout: { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', gap: 16, padding: 14 },
  stat: {},
  statK: { color: '#7f9aa0', fontSize: 9, letterSpacing: 1.2, textTransform: 'uppercase' },
  statV: { color: '#d3ece8', fontSize: 15, fontVariant: ['tabular-nums'] },
  statVbig: { color: '#64f0d0', fontSize: 20 },
  sparkWrap: { marginLeft: 'auto', justifyContent: 'flex-end' },
  spark: { flexDirection: 'row', alignItems: 'flex-end', height: 34 },
  epoch: { position: 'absolute', top: '46%', left: 0, right: 0, alignItems: 'center' },
  epochText: { color: '#ff6b6b', fontSize: 14, letterSpacing: 4, textShadowColor: 'rgba(255,107,107,0.6)', textShadowRadius: 16 },
  inspector: {
    position: 'absolute',
    bottom: 14,
    left: 14,
    right: 14,
    backgroundColor: 'rgba(4,18,26,0.94)',
    borderWidth: 1,
    borderColor: 'rgba(100,240,208,0.3)',
    borderRadius: 12,
    padding: 14,
  },
  inspectHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 10, gap: 8 },
  swatch: { width: 14, height: 14, borderRadius: 7 },
  inspectTitle: { color: '#d3ece8', fontSize: 13, letterSpacing: 1, textTransform: 'uppercase', flex: 1 },
  inspectClose: { color: '#7f9aa0', fontSize: 14 },
  inspectRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 },
  inspectK: { color: '#7f9aa0', fontSize: 12 },
  inspectV: { color: '#d3ece8', fontSize: 12, fontVariant: ['tabular-nums'] },
  catchup: { position: 'absolute', top: '42%', left: 40, right: 40, alignItems: 'center' },
  catchupText: { color: '#64f0d0', fontSize: 14, letterSpacing: 2, textTransform: 'uppercase' },
  catchupPct: { color: '#d3ece8', fontSize: 26, fontVariant: ['tabular-nums'], marginTop: 4 },
  catchupBar: { marginTop: 10, height: 4, width: '100%', backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: 2, overflow: 'hidden' },
  catchupFill: { height: 4, backgroundColor: '#64f0d0' },
  resumeOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(4,18,26,0.7)', padding: 24 },
  resumeCard: { width: '100%', backgroundColor: '#06181e', borderWidth: 1, borderColor: 'rgba(100,240,208,0.3)', borderRadius: 14, padding: 20 },
  resumeTitle: { color: '#64f0d0', fontSize: 16, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 10 },
  resumeLead: { color: '#d3ece8', fontSize: 13, lineHeight: 19, marginBottom: 14 },
  resumeBtn: { marginTop: 16, backgroundColor: 'rgba(100,240,208,0.14)', borderWidth: 1, borderColor: 'rgba(100,240,208,0.4)', borderRadius: 8, paddingVertical: 12, alignItems: 'center' },
  resumeBtnText: { color: '#64f0d0', fontSize: 13 },
  plannerOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(4,18,26,0.82)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  plannerCard: { width: '100%', backgroundColor: '#06181e', borderWidth: 1, borderColor: 'rgba(100,240,208,0.3)', borderRadius: 16, padding: 18 },
  plannerHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  plannerTitle: { color: '#64f0d0', fontSize: 15, letterSpacing: 0.5 },
  plannerHint: { color: '#7f9aa0', fontSize: 12, lineHeight: 17, marginBottom: 16 },
  timeline: { height: 44, backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 8, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', justifyContent: 'center' },
  timelineNow: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 2, backgroundColor: '#64f0d0' },
  timelineMark: { position: 'absolute', width: 26, height: 26, marginLeft: -13, borderRadius: 13, backgroundColor: 'rgba(100,240,208,0.16)', borderWidth: 1, borderColor: 'rgba(100,240,208,0.5)', alignItems: 'center', justifyContent: 'center' },
  timelineMarkIcon: { fontSize: 13 },
  timelineAxis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4, marginBottom: 14 },
  timelineAxisLabel: { color: '#7f9aa0', fontSize: 10 },
  palette: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  paletteBtn: { flexGrow: 1, flexBasis: '46%', flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 12 },
  paletteIcon: { fontSize: 18 },
  paletteLabel: { color: '#d3ece8', fontSize: 12, flexShrink: 1 },
  plannerList: { marginTop: 16, gap: 6 },
  plannerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 },
  plannerRowText: { color: '#d3ece8', fontSize: 12, flexShrink: 1 },
  plannerRemove: { color: '#ff6b6b', fontSize: 14, paddingLeft: 12 },
  panel: { flex: 1, backgroundColor: '#06181e', padding: 16, borderTopWidth: 1, borderTopColor: 'rgba(100,240,208,0.16)' },
  sliderBlock: { marginBottom: 10 },
  sliderHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 },
  lab: { color: '#7f9aa0', fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase' },
  num: { color: '#d3ece8', fontSize: 13 },
  btns: { flexDirection: 'row', gap: 8, marginTop: 6 },
  btn: { flex: 1, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', borderRadius: 8, paddingVertical: 12, alignItems: 'center' },
  btnText: { color: '#d3ece8', fontSize: 11 },
});
