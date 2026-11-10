FROM node:24.14.0-bookworm-slim AS base
WORKDIR /workspace

FROM base AS manifests
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json

FROM manifests AS dependencies
RUN pnpm install --frozen-lockfile

FROM manifests AS production-dependencies
RUN pnpm --filter @app/api... install --prod --frozen-lockfile

# Мигратор использует Prisma CLI, схему и историю миграций, но не запускает API.
FROM dependencies AS migrator
COPY apps/api/prisma apps/api/prisma
COPY apps/api/prisma.config.ts apps/api/prisma.config.ts
WORKDIR /workspace/apps/api
ENV NODE_ENV=production
USER node
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy", "--config", "prisma.config.ts"]

FROM dependencies AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @app/shared build \
    && DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build pnpm --filter @app/api build

# Здесь нет pnpm store, исходников приложения и инструментов сборки workspace.
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=production-dependencies /workspace/node_modules ./node_modules
COPY --from=production-dependencies /workspace/apps/api/package.json ./apps/api/package.json
COPY --from=production-dependencies /workspace/apps/api/node_modules ./apps/api/node_modules
COPY --from=production-dependencies /workspace/packages/shared/package.json ./packages/shared/package.json
COPY --from=production-dependencies /workspace/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build /workspace/packages/shared/dist ./packages/shared/dist
COPY --from=build /workspace/apps/api/dist ./apps/api/dist
WORKDIR /workspace/apps/api
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
