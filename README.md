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

## Локальная инфраструктура

Запустить Docker Desktop в режиме Linux containers. Добавить в .env переменные
POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB из .env.example.
Они должны соответствовать пользователю, паролю и базе в DATABASE_URL.
Изменение этих переменных не меняет уже созданную базу в volume.

```powershell
docker compose up -d
docker compose ps
docker compose logs -f seaweedfs
```

После готовности SeaweedFS создать бакет один раз:

```powershell
's3.bucket.create -name user-files' | docker compose exec -T seaweedfs weed shell -master=seaweedfs:9333 -filer=seaweedfs:8888
```

Повторное создание сообщает, что бакет уже существует. Посмотреть бакеты:

```powershell
's3.bucket.list' | docker compose exec -T seaweedfs weed shell -master=seaweedfs:9333 -filer=seaweedfs:8888
```

Порты доступны только через 127.0.0.1: PostgreSQL 5432, Redis 6379, S3 8333.
API и React запускаются отдельно через pnpm dev.

```powershell
docker compose stop
docker compose down
```

stop останавливает контейнеры. down удаляет контейнеры и сеть, сохраняя volumes.
Команда `docker compose down -v` удаляет также volumes со всеми данными.
Использовать её только для намеренного полного сброса локальных данных.

## Статус

Инициализирован каркас и настроена проверка env через Zod при запуске API.
Обязательные настройки перечислены в .env.example. Локальный .env не коммитится.
Значения в примере предназначены только для локальной разработки.
PostgreSQL подключён через Prisma 7. Сессии API используют Redis через express-session
и connect-redis. S3 пока используется только как инфраструктура.
UsersService создаёт пользователей с Argon2id-хешем и проверяет пароли.
HTTP-эндпоинты авторизации и файловые операции — следующие блоки.
В shared доступны usernameSchema, passwordSchema, credentialsSchema и тип Credentials.
Подключение этих схем к HTTP и React-формам — следующие задачи.

Тесты UsersService требуют запущенного Docker Engine. Testcontainers создаёт
отдельный PostgreSQL-контейнер, применяет миграции и удаляет контейнер после тестов.
Локальная база из Compose в этих тестах не используется.

Тесты сессий запускают отдельный Redis через Testcontainers. Они проверяют cookie,
TTL, восстановление сессии после пересоздания Nest и работу за HTTPS-прокси.
Тестовый контроллер сессий не включается в production-сборку.
Анонимные запросы не создают cookie и записи Redis. Cookie появится после записи
userId при реализации входа и регистрации.
Для запуска API и HTTP-теста нужны PostgreSQL и Redis:

```powershell
docker compose up -d postgres redis
pnpm dev
```

## Prisma и миграции

После запуска PostgreSQL применить миграции и сгенерировать клиент:

```powershell
pnpm --filter @app/api db:deploy
pnpm --filter @app/api prisma:generate
pnpm dev
```

После изменения schema.prisma создать новую миграцию в локальной разработке:

```powershell
pnpm --filter @app/api db:migrate --name describe_change
```

schema.prisma описывает модели. prisma/migrations содержит версионированный SQL.
prisma.config.ts загружает корневой .env для CLI отдельно от Nest.
Сгенерированный клиент в src/generated не коммитится; генерация выполняется перед
сборкой, проверкой типов, запуском разработки и тестами.

Первая миграция добавляет users и уникальный индекс username, не меняя другие таблицы.
Применённые миграции не редактируются. Изменения оформляются новой миграцией.
Удаление users уничтожит аккаунты, поэтому автоматического отката с удалением таблицы нет.
В рабочем окружении ошибка кода исправляется откатом приложения или новой совместимой миграцией.
