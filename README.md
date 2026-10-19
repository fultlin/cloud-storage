# Облачное хранилище

Учебный проект по cloud-file-storage.md.

Стек: NestJS 12 (ESM, Express 5), React 19, Vite 8, TypeScript 6.

## Запуск

Node.js 24, pnpm 11.25.0. Для актуальных генераторов Nest рекомендуется Node.js 24.15+.

```powershell
pnpm install
Copy-Item .env.example .env
pnpm dev
```

Веб: http://127.0.0.1:5173
API через Vite: http://127.0.0.1:5173/api

Пока отображается стартовый React-шаблон. API возвращает Hello World!.

## Проверки

```powershell
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @app/api test:e2e
```

## Пакеты

- apps/api — NestJS API.
- apps/web — React SPA.
- packages/shared — общие схемы и типы.

## Статус

Инициализирован каркас и настроена проверка env через Zod при запуске API.
Обязательные настройки перечислены в .env.example. Локальный .env не коммитится.
Значения в примере предназначены только для локальной разработки.
PostgreSQL, Redis и S3 пока не подключены; схема проверяет настройки, а не доступность сервисов.
Авторизация, БД и файловые операции — следующие блоки.
