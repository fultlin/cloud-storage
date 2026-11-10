FROM node:24.14.1-bookworm-slim AS build
WORKDIR /workspace
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm --filter cloud-storage --filter @app/web... install --frozen-lockfile
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @app/shared build && pnpm --filter @app/web build

FROM nginx:1.30.6-alpine
# 100 файлов × 5 ГиБ плюс запас для заголовков multipart.
ENV NGINX_CLIENT_MAX_BODY_SIZE=501g
ENV NGINX_ENVSUBST_FILTER=^NGINX_CLIENT_MAX_BODY_SIZE$
COPY --from=build /workspace/apps/web/dist/ /usr/share/nginx/html/
COPY apps/web/nginx/default.conf.template /etc/nginx/templates/default.conf.template
