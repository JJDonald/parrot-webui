# syntax=docker/dockerfile:1.7
#
# Parrot 独立 WebUI 镜像（多阶段构建）
#
# 设计要点（实施文档 3.3 / 9.8）：
#   - 一个镜像、一个进程：React 静态页面 + Fastify BFF，容器内监听 PORT=3000；
#   - 构建阶段装依赖（frozen lockfile）、校验上游契约、构建 web 与 bff；
#   - 运行阶段只含生产依赖 + 静态产物 + BFF 产物，以非 root 用户 node 运行；
#   - 不安装 Docker socket、不挂载原 Parrot 数据目录、不在启动时写源码目录；
#   - SIGTERM 由 BFF 自己处理（apps/bff/src/index.ts 监听 SIGTERM/SIGINT 并 app.close()），
#     因此不在镜像里包一层 shell，保证 PID 1 直接收到信号；
#   - 3000 只作为同机反向代理的内部目标，绝不直接发布到公网（见 compose.yaml）。
#
# 入口说明：进程入口是 apps/bff/dist/index.js（调用 main()、注册信号处理与 listen）。
# apps/bff/dist/server.js 只导出 buildServer()，供集成测试在进程内组装应用，不自启动。

ARG NODE_IMAGE=node:24-bookworm-slim
ARG PNPM_VERSION=12.5.1

# ---------------------------------------------------------------- 工具链（Node 24 + 锁定 pnpm）
FROM ${NODE_IMAGE} AS toolchain
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
RUN corepack enable \
 && corepack prepare "pnpm@${PNPM_VERSION}" --activate \
 && pnpm --version
WORKDIR /app

# ---------------------------------------------------------------- 全部依赖（含构建工具 vite/tsc）
FROM toolchain AS deps
# pnpm workspace 的每个 importer 都必须出现在这里，--frozen-lockfile 才能通过
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/bff/package.json apps/bff/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
RUN --mount=type=cache,id=parrot-webui-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store

# ---------------------------------------------------------------- 构建：契约校验 + web + bff
FROM deps AS build
COPY tsconfig.base.json ./
COPY scripts/generate-contracts.mjs scripts/
COPY packages/contracts packages/contracts
COPY apps/bff apps/bff
COPY apps/web apps/web

# 1) 契约校验（--check 只校验不写文件）：快照 sha256 与上游提交记录一致，
#    且 mvp-routes.json 的每条 method+path 都真实存在于快照中，失败即中断构建。
RUN pnpm contracts:generate --check

# 2) contracts（目前为占位 build）→ web（apps/web/dist）→ bff（apps/bff/dist）
RUN pnpm build

# 3) 产物存在性检查，避免把空 dist 打进运行镜像
RUN test -f apps/web/dist/index.html \
 && test -f apps/bff/dist/index.js \
 && test -d apps/bff/dist

# 4) contracts 已由 pnpm build 产出真实 ES 模块（packages/contracts/dist），
#    Node 运行时可以直接 import，不再需要任何镜像内的类型剥离或 exports 改写。
RUN test -f packages/contracts/dist/generated/management-routes.js \
 && test -f packages/contracts/dist/src/index.js

# ---------------------------------------------------------------- 仅生产依赖
FROM toolchain AS prod-deps
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/bff/package.json apps/bff/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
# apps/web 的 dependencies 不是运行时必需，但 pnpm --frozen-lockfile 要求 workspace importer 齐全，
# 因此一并解析；vite/tsc/vitest/tsx 等 devDependencies 不会进入本阶段。
RUN --mount=type=cache,id=parrot-webui-pnpm-store,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile --ignore-scripts --store-dir=/pnpm/store \
 && mkdir -p node_modules apps/bff/node_modules packages/contracts/node_modules

# ---------------------------------------------------------------- 运行镜像
FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    WEBUI_BIND_HOST=0.0.0.0 \
    WEBUI_BASE_PATH=/webui/ \
    WEBUI_STATIC_DIR=/app/apps/web/dist

WORKDIR /app

# 生产依赖（含 workspace 链接：node_modules/@parrot-webui/contracts -> packages/contracts）
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/apps/bff/node_modules ./apps/bff/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/contracts/node_modules ./packages/contracts/node_modules

# 构建产物：BFF 与静态页面
COPY --from=build --chown=node:node /app/apps/bff/dist ./apps/bff/dist
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist

# contracts 包：运行期只用到编译后的冻结路由表与入口，package.json 的 exports 已指向 dist
COPY --chown=node:node packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=node:node /app/packages/contracts/dist ./packages/contracts/dist

# 构建期做一次真实解析检查（从 apps/bff 目录，与运行期解析路径一致）
RUN cd apps/bff && node --input-type=module -e "const m=await import('@parrot-webui/contracts/routes');if(!Array.isArray(m.FROZEN_UPSTREAM_ROUTES))process.exit(1);console.log('[build] contracts routes ok:', m.FROZEN_UPSTREAM_ROUTES.length);"

# 只读根文件系统下需要可写的临时目录（compose 同时挂 tmpfs /tmp）
RUN mkdir -p /tmp && chmod 1777 /tmp

USER node

EXPOSE 3000
STOPSIGNAL SIGTERM

# 存活检查用 /webui/health/live：不依赖上游可达，避免上游短暂故障触发容器重启循环
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/webui/health/live').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "apps/bff/dist/index.js"]
