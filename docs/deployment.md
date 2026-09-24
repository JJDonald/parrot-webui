# 部署与运维

本文件面向在同一台机器上做正式部署的运维者。**所有结论都必须在现场执行后填写记录**；
本文件不包含任何"已验证通过"的结论，凡是无法在仓库内确认的事项都标注「待现场确认」。

## 0. 硬前提（不满足就不要继续）

1. **同机部署**：WebUI 容器必须与原 Parrot 实例在同一台主机。不支持异机安装，不允许通过另一台服务器中转。
2. **同域名路径入口**：对外唯一入口是 `https://<原Parrot域名>/webui/`。
   不得新建域名/子域名，不得使用独立公网 IP + 端口。
3. **现有入口可改**：宿主上（或入口容器里）存在可修改的 HTTPS 反向代理配置，允许只为 `/webui/` 新增分流。
   - 方案 A：反向代理跑在宿主机（新增 `deploy/nginx-webui.conf` 或 `deploy/Caddyfile.example` 片段）。
   - 方案 B：反向代理本身也是容器（见第 4 节，需要改成内部网络访问，并删除 ports）。
   - 如果 TLS 入口只存在于不可修改的原容器内、或用户没有可改的入口：**报告阻塞，不要另开公网端口当后备方案**。
4. **容器运行时**：Linux 宿主 + Docker Engine + Compose v2（`docker compose version`）。
   构建需要访问 npm registry（拉取基础镜像与 pnpm 依赖）。
5. **管理凭据**：需要一份可用的 Parrot **管理主密钥**（用于登录换取上游 Session）。
   注意不是推理用的 API Key。管理密钥**只**在浏览器登录表单中出现，不要写进 `.env`、不要写进 Compose。
6. **上游就绪**：原 Parrot 已暴露既有 `/api/management/v1`。版本与就绪情况「待现场确认」，
   兼容性判断方法见 [compatibility.md](./compatibility.md)。

## 1. 构建镜像

在仓库根目录（`Dockerfile` 所在目录）执行：

```bash
# 可选：先做一次代码侧前置校验（与镜像构建内的步骤一致）
pnpm install --frozen-lockfile
pnpm contracts:generate --check
pnpm typecheck
pnpm test
pnpm build

# 构建镜像
docker compose build            # 或：docker build -t parrot-webui:local .

# 建议给本次交付打上版本标签，便于回滚（见第 6 节）
docker tag parrot-webui:local parrot-webui:0.1.0
```

镜像构建阶段做的事（`Dockerfile`）：锁定 Node 24 + pnpm、`--frozen-lockfile` 安装依赖、
`pnpm contracts:generate --check` 校验上游契约（快照哈希 + 76 条允许清单逐条核对）、
构建 web（`apps/web/dist`）与 bff（`apps/bff/dist`）。
运行镜像只含生产依赖 + 静态产物 + BFF 产物，以非 root 用户 `node` 运行。

未允许对外发布镜像时不要推送镜像仓库；只做本地可构建镜像与发布步骤记录。

## 2. 配置

```bash
cp .env.example .env
$EDITOR .env
```

必填项（缺失时 `docker compose config` 或容器启动会直接报错）：

| 变量 | 含义 | 现场填写要求 |
| --- | --- | --- |
| `PARROT_BASE_URL` | 本机原 Parrot 的内部 origin | 只能是 origin：不带路径、不带 `/api/management/v1`、不带 query；且不得等于 `WEBUI_PUBLIC_ORIGIN`（否则会形成 `/webui/` 代理循环）。默认示例 `http://host.docker.internal:22122`，端口「待现场确认」 |
| `WEBUI_PUBLIC_ORIGIN` | 现有 Parrot 的 HTTPS origin | 必须与用户实际访问域名完全一致（协议、主机、端口），不含路径 |
| `WEBUI_TRUST_PROXY` | 实际入口反向代理地址/CIDR（逗号分隔） | 禁止 `*`/`true`；必须与真实入口网络一致，填错会导致来源判定与限流键失真 |
| `WEBUI_INSTANCE_NAME` | 页面展示名 | 可选，默认 `Parrot` |

其它项（会话有效期、超时、限流、日志级别等）都有默认值，取值区间与校验规则以
`apps/bff/src/config.ts` 为准；`.env.example` 已逐项标注必填/默认与含义。

`NODE_ENV` 必须是 `production`；`WEBUI_BASE_PATH` 固定 `/webui/`，不要改。

**环境变量里不得出现共享管理密钥。** BFF 不读取、不落盘任何管理密钥（见 [security-model.md](./security-model.md)）。

上游可达性说明（实施文档 9.6）：

- 容器内的 `localhost` 指容器自己，不是宿主，也不是原 Parrot。
- `extra_hosts: host.docker.internal:host-gateway` 是默认通道；Linux 下**不保证**能访问宿主上只绑定
  `127.0.0.1` 的端口，必须实测。若不通，优先复用原 Parrot 已有的用户自定义网络 + 服务别名
  （给 WebUI 加入该网络，把 `PARROT_BASE_URL` 指向服务别名）。
- 不修改原 Parrot 的端口绑定、网络或证书来迁就 WebUI。
- 只有"必须走宿主回环"的现场，才考虑给 WebUI 用 host network，并同时把 BFF 监听改为
  `WEBUI_BIND_HOST=127.0.0.1` 且删除 `ports`；这是现场特定方案，不是通用模板。

## 3. 启动与端口发布检查

```bash
docker compose config            # 合并后的真实配置：确认 ports 只有 127.0.0.1
docker compose up -d --build
docker compose ps                # 期望 State=running、Health=healthy（待现场确认）
docker compose logs -f webui
```

检查端口没有被发布到公网：

```bash
docker compose config | grep -A3 published     # 只允许 127.0.0.1
ss -ltnp | grep ':3000'                        # 不应出现 0.0.0.0:3000 / [::]:3000
```

健康检查：容器内 `GET /webui/health/live`（存活，不依赖上游）与 `/webui/health/ready`（就绪，附带最小上游可达状态）。
这两个路径**不对外转发**（反向代理片段里直接 404）。

## 4. 反向代理

只新增 `/webui/` 分流，不改原 `/`、`/v1`、`/api/management/v1`、`/mcp` 规则。

- **方案 A（入口代理在宿主机）**：用 `deploy/nginx-webui.conf`（Nginx）或 `deploy/Caddyfile.example`（Caddy）。
  两个片段都保留 `/webui/` 前缀（`proxy_pass` 末尾不加 URI / 不写 `handle_path`），
  并把 `/webui/health`、`/webui/health/*` 直接 404。
  域名占位符 `parrot.example.com` 必须替换为实际域名。
- **方案 B（入口代理也是容器）**：按 `compose.yaml` 顶部的注释改：
  删除 `ports:`，改为 `expose: ["3000"]` + `networks: [existing-ingress]`（网络 `external: true`），
  入口代理通过服务名访问：`proxy_pass http://webui:3000;`（仍不加尾斜杠）。
  改完必须重新执行 `docker compose config` 确认合并结果里**没有** ports。
  `expose` 不是防火墙；该网络上其它容器的信任边界需要单独记录。

校验与平滑 reload：

```bash
# Nginx
sudo nginx -t && sudo nginx -s reload        # 或 systemctl reload nginx

# Caddy
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && systemctl reload caddy
```

reload 后必须回归检查原推理流式接口、原管理 API、MCP 等既有入口没有回归。

## 5. 验收（逐条记录结果，未执行不要写"通过"）

浏览器侧：

- [ ] 访问 `https://<域名>/webui`（无尾斜杠）得到 308 跳转到 `/webui/`。
- [ ] 只能用**管理密钥**登录（不是推理 API Key）；登录后能读出真实总览数据。
- [ ] 刷新页面保持登录；深链接（如 `/webui/channels`）直接刷新可用，不跳到域名根 `/login`。
- [ ] 静态资源、`/webui/bff/*` 请求、Cookie 全部在 `/webui/` 路径下；Cookie 是 HttpOnly，Path=`/webui/`，无 Domain。
- [ ] 域名根、`/v1`、`/api/management/v1`、`/mcp` 的既有行为与部署前一致。
- [ ] 用 IP:443 或错误 Host 访问不能拿到本项目页面/API。
- [ ] 外部访问 `https://<域名>/webui/health/live` 得到 404（健康检查不对外）。
- [ ] 浏览器开发工具和 BFF 日志里看不到 Parrot 管理密钥、上游 Session、OAuth token 或请求/响应正文。

**公网端口拒绝验证（必须从另一台公网机器执行，不能只在本机测、不能只测认证拒绝）：**

```bash
# 在另一台位于公网的机器上（IPv4）
curl -v --max-time 5 http://<宿主公网IPv4>:3000/webui/health/live
# 期望：连接被拒绝/超时（connection refused 或 timeout），而不是 HTTP 响应

# 同一台机器（IPv6）
curl -v --max-time 5 "http://[<宿主公网IPv6>]:3000/webui/health/live"
# 期望：同上失败
```

若上面的命令能拿到任何 HTTP 响应，说明端口已公网暴露，必须立刻停止检查并修正 Compose/防火墙。

容器侧：

- [ ] `docker compose config` 与 `ss -ltnp` 确认 3000 只发布在 `127.0.0.1`，或方案 B 下完全不发布。
- [ ] `docker inspect` 确认：非 root 运行、`read_only` 根文件系统、无 bind 挂载 Docker socket、
      无原 Parrot 数据目录挂载、`cap_drop: ALL`、`no-new-privileges`。
- [ ] 容器停止/删除不影响原 Parrot 的推理与管理服务；原 Parrot 容器/镜像/Compose/网络未被改动。
- [ ] 原 Parrot 短暂不可达时，WebUI 显示明确错误（不伪造成功、不自动"修复"）。

升级后行为：

- [ ] `docker compose restart webui` 或重建容器后，浏览器需要**重新登录**（这是明确支持的行为）。

安装记录需要留档：部署主机与实际域名、入口软件与配置文件路径、`docker compose config` 输出、
上述每条检查的执行时间与结果。「待现场确认」项：具体域名、上游端口、入口实现、真实浏览器 Cookie 行为。

## 6. 升级

```bash
# 1) 拉取/更新代码或交付包，确认契约与测试
pnpm install --frozen-lockfile
pnpm contracts:generate --check
pnpm build

# 2) 构建新镜像并打版本标签
docker compose build
docker tag parrot-webui:local parrot-webui:<新版本>

# 3) 只重建 WebUI 服务（不动原 Parrot）
docker compose up -d --build
docker compose ps && docker compose logs --tail=100 webui

# 4) 重新走第 5 节的关键验收项（至少：/webui/ 可访问、能登录、原路径无回归、公网 3000 仍不可达）
```

注意：WebUI 是有界内存会话，重建容器会让所有用户重新登录。升级前提醒使用者。

## 7. 回滚

```bash
# 方式一：切回上一个已构建的镜像标签（最快）
docker tag parrot-webui:<上一版本> parrot-webui:local
docker compose up -d --force-recreate webui
docker compose ps

# 方式二：回到上一个交付版本的源码/目录后重建
docker compose up -d --build
```

回滚只影响 WebUI；不需要、也不允许改动原 Parrot 容器或数据。
回滚后重新执行第 5 节关键验收项。镜像标签与对应交付版本要记录在案；
本仓库不含 `.git` 目录时，请按交付包/版本目录编号回滚。

## 8. 卸载

顺序很重要：**先摘入口，再停服务**。

```bash
# 1) 移除入口新增的 /webui/ 片段（Nginx 删 include 行或片段文件；Caddy 删除新增的 4 段）
sudo nginx -t && sudo nginx -s reload          # 或：caddy validate ... && systemctl reload caddy

# 2) 确认原 Parrot 路径恢复正常（/、/v1、/api/management/v1、/mcp）
#    并确认 https://<域名>/webui/ 已不再由 WebUI 提供

# 3) 停止并删除 WebUI 容器（含本项目镜像，按需清理）
docker compose down
docker image rm parrot-webui:local parrot-webui:0.1.0 2>/dev/null || true

# 4) 清理本项目本机文件（按需）：.env（含部署参数）、构建缓存
rm -f .env
```

**不要**在卸载过程中删除或修改原 Parrot 的配置、数据目录、容器、镜像与网络。
卸载后原 Parrot 的推理与 Telegram 服务应保持可用（需现场确认）。

## 9. 待现场确认清单

1. 实际 Parrot 版本、管理 API 就绪情况与监听端口/绑定地址；容器到该地址的可达路径。
2. 现有域名与实际使用的访问方式（是否有 CDN、是否有第二层代理）。
3. `WEBUI_TRUST_PROXY` 的真实取值（入口代理自身地址/CIDR）。
4. 入口软件是 Nginx 还是 Caddy、配置目录与 reload 方式、是否 `default_server`。
5. Docker Desktop（Windows/macOS）还是 Linux 宿主：`host.docker.internal` 行为不同，必须实测。
6. 真实浏览器上的 Cookie/重定向行为，以及两端入口在公网的端口拒绝验证结果。
7. 反向代理改动后原推理流式接口、管理 API、MCP 的回归结果。
