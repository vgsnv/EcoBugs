# EcoBugs

- `world-2/` — развиваемая WebGPU-версия мира: `npm --prefix world-2 run dev`, порт 5174.
- `world-1/` — архив прежней CPU/Canvas-версии без дальнейшей разработки и поддержки совместимости. Запуск: `npm --prefix world-1 run dev -- --host 127.0.0.1 --port 5173 --strictPort`. Удаление — только по отдельному решению пользователя.
- `rn-app/` — React Native-приложение (iOS/Android) со своим ядром `core/`. Заморожено: сейчас не развивается, см. `rn-app/README.md`.
- `docs/` — спецификация, планы и отчёты.
