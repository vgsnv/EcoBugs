# EcoBugs

- `world-1/` — развиваемая CPU/Canvas-версия мира: `npm --prefix world-1 run dev -- --host 127.0.0.1 --port 5173 --strictPort`.
- `world-2/` — WebGPU-версия, отложена: не развивается, сохранена для сравнения. Запуск: `npm --prefix world-2 run dev`, порт 5174. Совместимость между версиями не поддерживается.
- `rn-app/` — React Native-приложение (iOS/Android) со своим ядром `core/`. Заморожено: сейчас не развивается, см. `rn-app/README.md`.
- `docs/` — спецификация, планы и отчёты.

Текущая работа — неживой мир world-1 на видеокарте: [план и состояние](docs/plan/world-gpu-engine.md). Правила для агента — [CLAUDE.md](CLAUDE.md).
