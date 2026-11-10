# Облачное хранилище

Учебное многопользовательское хранилище с веб-интерфейсом. Поддерживает
регистрацию, работу с файлами и папками, поиск, загрузку с прогрессом и отменой,
скачивание файлов и ZIP-архивов папок.

- [Архитектурные решения](DECISIONS.md)
- [Результаты проверок и открытые пункты приёмки](VERIFICATION.md)

## Быстрый запуск

Нужны Git и Docker с Compose v2 в режиме Linux containers. Клонируйте
репозиторий и выполните из его корня:

```powershell
Copy-Item .env.example .env
docker compose -f compose.full.yaml up --build -d --wait
```

В Bash используйте `cp .env.example .env`. Если `.env` уже настроен, пропустите
копирование. Откройте [http://127.0.0.1:8080/](http://127.0.0.1:8080/) и
зарегистрируйтесь. При первом запуске отдельные контейнеры `migrator` и
`s3-init` применяют миграции и подготавливают бакет `user-files`. Оба должны
завершиться с кодом 0. Веб доступен через nginx, остальные сервисы общаются
внутри сети Compose.

```powershell
docker compose -f compose.full.yaml ps -a
docker compose -f compose.full.yaml logs migrator s3-init api web
docker compose -f compose.full.yaml down
```

`down` сохраняет данные. Флаг `-v` удаляет volumes вместе с данными проекта.
У полного стека свои volumes, отдельные от режима разработки.

## Разработка

Для горячей перезагрузки нужны Node.js 24 и pnpm 11.25.0. Подготовьте
корневой `.env` из [примера](.env.example), установите зависимости и запустите
PostgreSQL, Redis и SeaweedFS:

```powershell
pnpm install
docker compose up -d --wait
's3.bucket.create -name user-files' | docker compose exec -T seaweedfs weed shell -master=seaweedfs:9333 -filer=seaweedfs:8888
pnpm --filter @app/api db:deploy
pnpm dev
```

Создайте бакет один раз после готовности SeaweedFS. Vite открывается на
[http://127.0.0.1:5173/](http://127.0.0.1:5173/) и передаёт `/api` в NestJS
на порту 3000. PostgreSQL, Redis и S3 доступны только через loopback на портах
5432, 6379 и 8333. Остановить зависимости можно командой `docker compose stop`.

После изменения [схемы Prisma](apps/api/prisma/schema.prisma) создайте миграцию:

```powershell
pnpm --filter @app/api db:migrate --name describe_change
```

Храните SQL миграций в Git. Сгенерированный Prisma Client создаётся автоматически
перед сборкой, проверкой типов, запуском API в режиме разработки и тестами.

Для работы над интерфейсом без бэкенда скопируйте
[apps/web/.env.example](apps/web/.env.example) в `apps/web/.env.local`, задайте
`VITE_MOCK_API=true` и запустите `pnpm --filter @app/web dev`.
Демо-аккаунт `demo_user` использует пароль `demo_pass123`. Мок-сессия и
изменённые данные сбрасываются при обновлении страницы.

## Архитектура

- `apps/api` — NestJS и Express. PostgreSQL хранит пользователей через Prisma 7,
  Redis хранит сессии, S3 хранит объекты под отдельным префиксом каждого
  пользователя. Загрузка, скачивание и ZIP идут потоками.
- `apps/web` — React, Vite, React Router и TanStack Query. Загрузка идёт через
  XHR для прогресса и отмены. Скачивание использует обычную навигацию браузера.
- `packages/shared` — схемы Zod для авторизации и путей, общие для API и UI.
- nginx раздаёт SPA и проксирует `/api/` с исходным путём. Буферизация запроса
  и ответа API отключена. Образ API содержит собранный код и production-зависимости,
  работает от UID 1000. Prisma CLI доступен в отдельном образе мигратора.

### Контракт API

При `SWAGGER_ENABLED=true` доступны Swagger UI на `/api/docs` и документ
на `/api/docs-json`. В production Swagger отключён. После изменения контракта
запустите API в режиме разработки и обновите снимок и типы фронтенда:

```powershell
curl.exe --noproxy "*" --fail http://127.0.0.1:3000/api/docs-json -o apps/web/openapi.json
pnpm --filter @app/web api:generate
```

### Ограничения

- Перемещение копирует все объекты и затем удаляет исходники. Если копирование
  прервалось, проверьте назначение и удалите частичную копию перед повтором.
  При сбое удаления проверьте полную копию и удалите оставшиеся исходники.
  Не меняйте то же дерево параллельно с перемещением.
- Поиск линейно сканирует ключи пользователя. Браузер при выборе папки на загрузку
  передаёт только файлы, поэтому пустые подпапки нужно создать отдельно.
- Удаление папки и откат загрузки могут завершиться частично при отказе S3.
  Если Redis недоступен при создании сессии после регистрации, аккаунт может
  сохраниться. После восстановления Redis войдите с теми же данными.
- SeaweedFS 4.48 может вернуть `409` при создании файла с именем существующей
  папки. Контракт допускает оба ресурса. Проверка с выбранным внешним S3 нужна
  перед приёмкой.

## Переменные окружения

Локальные значения перечислены в [.env.example](.env.example), серверные —
в [.env.production.example](.env.production.example). Оба примера копируются
в отдельные файлы с настройками. Реальные секреты в Git не добавляются.

| Переменные | Назначение |
| --- | --- |
| `NODE_ENV`, `PORT` | Режим и порт API. Compose запускает API на 3000 внутри сети. |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `DATABASE_URL` | Инициализация PostgreSQL и строка подключения Prisma. В Compose хост БД — `postgres`. Изменение переменных не меняет уже созданную базу. |
| `REDIS_URL`, `SESSION_SECRET`, `SESSION_TTL_SECONDS` | Подключение Redis, секрет подписи cookie и TTL сессии в секундах. Compose задаёт адрес `redis://redis:6379`. |
| `TRUST_PROXY`, `COOKIE_SECURE`, `SWAGGER_ENABLED` | Доверие ближайшему прокси, флаг `Secure` у cookie и показ документации. TLS-дополнение включает `COOKIE_SECURE`. |
| `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE` | URL, регион, доступ и стиль адресации S3. Compose использует бакет `user-files`. |
| `UPLOAD_MAX_FILE_SIZE_BYTES`, `UPLOAD_MAX_FILES`, `NGINX_CLIENT_MAX_BODY_SIZE` | Размер файла, число файлов и лимит всего запроса с запасом на multipart. По умолчанию 5 ГиБ, 100 файлов и `501g`. |
| `FULL_WEB_PORT`, `FULL_DATABASE_URL` | Порт полного локального стека и необязательный URI базы. Задайте URI с URL-кодированным паролем, если в нём есть специальные символы. |
| `WEB_BIND_ADDRESS`, `WEB_HTTP_PORT`, `WEB_HTTPS_PORT` | Адрес привязки nginx и порты на VPS. |
| `TLS_CERT_DIR`, `HTTPS_PUBLIC_AUTHORITY` | Каталог TLS-сертификата и ключа, публичный адрес для редиректа. |
| `VITE_MOCK_API` | Запуск фронтенда с MSW в режиме разработки. |

## Проверки

```powershell
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @app/api test:e2e
pnpm --filter @app/web exec playwright install chromium
pnpm --filter @app/web test:e2e
pnpm --filter @app/web test:full
```

Для `pnpm test` нужен Docker, интеграционные тесты используют Testcontainers.
Для `test:e2e` API запустите зависимости из раздела [«Разработка»](#разработка)
и подготовьте бакет. `test:e2e` фронтенда использует моки. `test:full`
требует запущенный полный локальный Compose. Для другого порта задайте
`FULL_STACK_BASE_URL` с локальным HTTP-адресом. Сценарий создаёт тестового
пользователя, загружает папку, проверяет F5, поиск, перемещение и скачивание.

Дополнительные проверки:

| Команда или режим | Что проверяет |
| --- | --- |
| `pnpm --filter @app/api verify:frontend` | Браузер с реальным API на изолированных зависимостях. |
| `pnpm --filter @app/api verify:large-http` | Передача 2 ГиБ, SHA-256 и RSS процесса API без nginx. |
| `pnpm --filter @app/api verify:large-nginx` | Передача 1 ГиБ через запущенный полный Compose, сверка размера и SHA-256. |
| `test:full` с `FULL_STACK_LARGE_UPLOAD=true` | Промежуточный прогресс загрузки 1 ГиБ в Chromium и обновление списка. |
| `pnpm --filter @app/api exec vitest run src/storage/storage.integration.spec.ts -t 'streams 2 GiB'` с `RUN_LARGE_STORAGE_TEST=true` | Передача 2 ГиБ напрямую через StorageService на временном SeaweedFS. |

## Деплой на VPS

Нужен Linux с Docker Engine и Compose v2. На VPS работают nginx, API,
PostgreSQL и Redis. Файлы хранятся во внешнем S3.

1. Загрузите нужную ревизию. Скопируйте `.env.production.example` в
   `.env.production` и ограничьте доступ командой `chmod 600 .env.production`.
2. Задайте отдельные случайные пароль PostgreSQL и `SESSION_SECRET`.
   В `DATABASE_URL` используйте хост `postgres` и тот же пароль, закодированный
   для URL при необходимости.
3. Создайте приватный бакет `user-files` и укажите HTTPS endpoint, регион,
   ключи и `S3_FORCE_PATH_STYLE` по требованиям провайдера. Ключу нужны права
   на проверку бакета, листинг, чтение, запись, удаление и multipart upload.

```bash
docker compose --env-file .env.production -f compose.prod.yaml --profile deploy build api web migrator &&
docker compose --env-file .env.production -f compose.prod.yaml up -d --wait postgres redis &&
docker compose --env-file .env.production -f compose.prod.yaml run --rm migrator &&
docker compose --env-file .env.production -f compose.prod.yaml up -d --wait api web
```

По умолчанию nginx слушает на `127.0.0.1:80` VPS. Для HTTP-проверки откройте
SSH-туннель `ssh -L 8080:127.0.0.1:80 user@server` и перейдите на локальный
порт 8080. PostgreSQL, Redis и API не публикуют порты.

### Публичный HTTPS

1. Направьте домен на VPS. Поместите цепочку `fullchain.pem` и ключ
   `privkey.pem` в отдельный каталог вне репозитория. Ограничьте права на ключ.
2. В `.env.production` задайте абсолютный `TLS_CERT_DIR`, домен без
   `https://` в `HTTPS_PUBLIC_AUTHORITY` и `WEB_BIND_ADDRESS=0.0.0.0`.
   Разрешите TCP 80 и 443. Если HTTPS использует нестандартный публичный
   порт, укажите его и в `WEB_HTTPS_PORT`, и в `HTTPS_PUBLIC_AUTHORITY`.
3. Добавьте `-f compose.prod.tls.yaml` сразу после `-f compose.prod.yaml`
   во всех командах развёртывания. nginx перенаправит HTTP на HTTPS с кодом 308,
   а API будет выдавать сессионную cookie с флагом `Secure`.

После продления сертификата обновите файлы в смонтированном каталоге.
С тем же префиксом `docker compose` выполните `exec web nginx -t`, затем
`exec web nginx -s reload`.

### Проверка и обновление

Проверьте `ps` и `logs api web`, вложенную страницу после F5, вход,
флаги cookie, загрузку и скачивание. `GET /api/user/me` без сессии должен
вернуть 401. Перед обновлением сохраните резервную копию базы. При ошибке
миграции не запускайте новую версию API. Откат кода возможен, если предыдущая
версия API совместима с уже применённой схемой.
