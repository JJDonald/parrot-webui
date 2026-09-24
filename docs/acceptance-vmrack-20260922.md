# 真机部署与验收记录：vmrack 美国机（2026-09-22）

本文件是 [`docs/acceptance.md`](./acceptance.md) §5「未验证（必须现场确认）」的现场兑现记录。
每条结论后面都跟着实际执行过的命令与真实输出；未执行的事项明确标注「未验证」。

## 1. 现场事实

| 项目 | 实测值 | 来源 |
| --- | --- | --- |
| 主机 | `209.146.116.54`（vmrack 美国） | 登录后 `hostname` = `c478f25c-f0bc-4e5d-8523-17f4b1d8ccf9` |
| 系统 | Debian GNU/Linux 12 (bookworm)，kernel 6.1.0-52-amd64，x86_64 | `/etc/os-release`、`uname -a` |
| 资源 | 2 vCPU / 1966 MB RAM / 50 GB（部署前已用 16 GB） | `nproc`、`free -m`、`df -h` |
| 容器运行时 | Docker 28.5.1、Docker Compose v5.0.0 | `docker --version` |
| **上游 Parrot** | 容器 `parrot`，镜像 `ghcr.io/danger-dream/parrot:latest`，`0.0.0.0:22122->22122/tcp`，`/health` = `status: ok` | `docker ps`、`curl 127.0.0.1:22122/health` |
| Parrot compose 位置 | `/opt/parrot/docker-compose.yml`（项目名 `parrot`，网络 `parrot_default`） | `docker compose ls -a` |
| **上游版本** | **`v0.33.1`**，`/health` 的 `version` 字段与 `/api/management/v1` 一致 | `curl /health`；BFF bootstrap 返回 `contract.release = v0.33.1` |
| 现有 HTTPS 入口 | Nginx Proxy Manager 容器 `npm`（`jc21/nginx-proxy-manager`，`docker run` 启动，`restart=always`），监听 80/81/443 | `docker ps`、`docker inspect npm` |
| **对外域名** | `parrot.huachuanx.com`（NPM `proxy_host/8.conf`，转发到 22122） | `grep -rl 22122 /home/docker/npm/data/nginx/` |
| NPM 数据目录 | `/home/docker/npm/data` → 容器内 `/data` | `docker inspect npm` |

> **重要发现（与 acceptance.md §5.8 相关）**：真实实例的版本 `v0.33.1` 与
> `packages/contracts/upstream-meta.json` 的基线提交 `9b73d058635470d59eef7a10876e6532649435d9`
> **完全一致**，因此 76 条冻结允许清单与线上实例同源，无需按
> [`compatibility.md`](./compatibility.md) 重新核对。BFF bootstrap 也回读了同一份快照哈希
> `ab552e2f3c80f6db368297ef50240b95a34ee3150687d6c3f161280ef870a5e2`。

## 2. 镜像构建位置与方式（现场选择）

`docs/deployment.md` 允许两种构建位置。本次**在开发机（Windows + Docker Desktop，linux/amd64）本地构建**，
再把镜像整体传到目标机，目标机只负责加载与运行：

```bash
# 开发机（仓库根目录）
docker build --progress=plain -t parrot-webui:local .
# 构建日志中的关键证据：
#   [build] contracts routes ok: 76
#   ✓ 1572 modules transformed.   ✓ built in 8.95s
#   naming to docker.io/library/parrot-webui:local done

docker images parrot-webui:local          # 574MB，config sha256 e6f23c58…
docker save parrot-webui:local | gzip -1 > parrot-webui-image.tgz   # 102 MB
scp parrot-webui-image.tgz root@209.146.116.54:/root/
# 目标机
gunzip -c /root/parrot-webui-image.tgz | docker load   # Loaded image: parrot-webui:local
```

这样做的原因：目标机只有 2 vCPU / 2 GB 且已加载 1.5 GB 常驻容器（Parrot + moontv + sub2api + postgres
+ redis + NPM 等），在目标机上跑 `pnpm install` + Vite 构建风险与耗时都更高。镜像内容与
`docker compose build` 完全一致（同一 `Dockerfile`，构建期仍执行 `pnpm contracts:generate --check`）。

构建前在开发机对镜像做过一次冒烟（同一镜像，参数指向不存在的上游）：

| 请求 | 结果 |
| --- | --- |
| `GET /webui/health/live` | 200 |
| `GET /webui/health/ready` | 200，`staticAssetsPresent: true`，`upstream.reachable: false`（无 Parrot 时的正确表现） |
| `GET /webui/` | 200 `text/html`，522 B |
| `GET /webui` | 308 → `/webui/` |

## 3. 现场适配（三处，全部有记录、可回滚）

### 3.1 为什么改：目标机的两个现场约束

1. **宿主 3000 端口已被占用**：`moontv-core`（`ghcr.io/szemeng76/lunatv`）正发布 `0.0.0.0:3000->3000/tcp`。
   `compose.yaml` 默认的 `127.0.0.1:3000:3000` 会直接冲突启动失败。
2. **入口代理是容器，不是宿主机进程**：NPM 跑在容器里，容器内的 `127.0.0.1` 是它自己，
   无法访问宿主回环上的 `127.0.0.1:3000`。因此「只发布到宿主回环」在方案 A 下根本无法被入口使用。

两条约束都指向 `compose.yaml` 顶部注释里的**方案 B**，故本次采用方案 B。

### 3.2 改动 1：`/opt/parrot-webui/compose.yaml`（方案 B）

由 `patch_compose.py` 做两处最小改动，其余逐字节不变（原文件备份为 `compose.yaml.orig-20260922`）：

```diff
-    ports:
-      - "127.0.0.1:3000:3000"
+    # 现场适配（方案 B：入口代理是容器 NPM）：
+    # 不发布任何宿主端口，只通过专用入口网络按服务别名访问；见文件末尾 networks。
+    expose:
+      - "3000"
+    networks:
+      - ingress
@@ 文件末尾新增 @@
+networks:
+  ingress:
+    external: true
+    name: parrot-webui-ingress
```

合并结果验证（`docker compose config`，在 `/opt/parrot-webui` 执行）：

```text
$ docker compose config | grep -c published
0        # 没有任何宿主端口发布，符合方案 B 的要求
```

### 3.3 改动 2：新增专用入口网络并接入 NPM

现场已占用网段 `172.17.0.0/16`（bridge）、`172.18`–`172.23.0.0/16`，故新建不冲突的专用网络：

```bash
docker network create --driver bridge --subnet 172.31.240.0/24 parrot-webui-ingress
docker network connect parrot-webui-ingress npm
# 结果：npm = 172.31.240.2，webui = 172.31.240.3；该网络下只有这两个容器
```

**运维注意（重要）**：`npm` 是用 `docker run` 启动的，不是 compose 项目，
所以 `docker network connect` 的接入**不会**在 `npm` 容器被删除重建后自动恢复。
若将来重建 NPM，必须重新执行一次：

```bash
docker network connect parrot-webui-ingress npm
```

### 3.4 改动 3：NPM 的 `/webui/` 增量分流

NPM 的 `proxy_host.conf` 模板在每个 proxy host 的 server 块末尾都会
`include /data/nginx/custom/server_proxy[.]conf`（宿主路径
`/home/docker/npm/data/nginx/custom/server_proxy.conf`）。该目录是 NPM 留给用户的自定义区，
NPM 自身不会改写它，因此把增量片段放在这里既能持久化、也不碰 NPM 的数据库。

本次新建该文件（内容对应 `deploy/nginx-webui.conf`，但代理目标改为容器名 `webui`）。
因为它是**全局** include，会对全部 7 个站点生效，所以片段里所有 location 都用
`if ($host != parrot.huachuanx.com) { return 404; }` 收口，保证只有目标域名能命中本项目。

```bash
docker exec npm nginx -t
# nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
# nginx: configuration file /etc/nginx/nginx.conf test is successful
docker exec npm nginx -s reload
```

### 3.5 现场 `.env`（`/opt/parrot-webui/.env`，权限 600，不含任何管理密钥）

```ini
NODE_ENV=production
PORT=3000
WEBUI_BIND_HOST=0.0.0.0
WEBUI_BASE_PATH=/webui/
WEBUI_STATIC_DIR=/app/apps/web/dist
PARROT_BASE_URL=http://host.docker.internal:22122
WEBUI_PUBLIC_ORIGIN=https://parrot.huachuanx.com
WEBUI_TRUST_PROXY=172.31.240.0/24
WEBUI_INSTANCE_NAME=Parrot
LOG_LEVEL=info
WEBUI_SESSION_IDLE_SECONDS=1800
WEBUI_SESSION_MAX_SECONDS=28800
PARROT_CONNECT_TIMEOUT_MS=5000
PARROT_REQUEST_TIMEOUT_MS=30000
WEBUI_DIAGNOSTICS_EXPOSE_UPSTREAM=0
```

容器→上游通道**已实测可用**（不需要退回「加入 `parrot_default` 网络」的备选方案）：

```bash
docker run --rm --add-host host.docker.internal:host-gateway curlimages/curl:latest \
  -sS http://host.docker.internal:22122/health
# {"status":"ok","upstream_client":{"state":"ready","ready":true},...}
```

原因是原 Parrot 发布在 `0.0.0.0:22122`（不是仅 127.0.0.1），所以经 host-gateway 能到达。
`WEBUI_TRUST_PROXY` 写成专用入口网段 `172.31.240.0/24`，而该网段下只有 NPM 与 WebUI 两个容器，
来源判定与限流键不会被同网段的其它业务容器污染。

## 4. 验收结果（逐条，真实输出）

测试客户端：**开发机（独立公网客户端）**，全部走 `https://parrot.huachuanx.com/webui/`。
管理主密钥通过 ssh 在目标机读取后只在内存中使用，**未写入文件、未写入 `.env`、未出现在日志里**。

### 4.1 入口与路由

| 检查项 | 结果 |
| --- | --- |
| `GET /webui`（无尾斜杠） | **308** → `https://parrot.huachuanx.com/webui/` |
| `GET /webui/` | **200**，`text/html; charset=utf-8`，`cache-control: no-cache, must-revalidate` |
| `GET /webui/health/live`（外部） | **404**（健康检查不对外） |
| `GET /webui/channels` `/models` `/api-keys` `/about`（带 `Accept: text/html`） | 全部 **200** `text/html`，522 B（SPA 回退） |
| `GET /webui/assets/index-BXG0kKyz.js` | **200** `application/javascript`，1 589 645 B |
| SPA 回退的边界 | 不带 `Accept: text/html` 时返回 JSON 404（`/webui/bff/*`、`/webui/health/*` 保持 JSON 404），符合 `acceptance.md` §2.2 的设计 |

### 4.2 登录与真实上游数据（acceptance.md §5.1、§5.2 兑现）

```text
1) bootstrap            HTTP 200
   set-cookie: __Secure-parrot_webui_prelogin=…; Max-Age=300; Path=/webui/; HttpOnly; Secure; SameSite=Lax
   body: contract.release=v0.33.1, operationCount=237, upstream.reachable=true
2) 未登录 overview      HTTP 401（WEBUI_SESSION_REQUIRED）
3) 登录（真实管理主密钥）HTTP 200
   set-cookie: __Secure-parrot_webui_session=…; Max-Age=28800; Path=/webui/; HttpOnly; Secure; SameSite=Lax
   set-cookie: __Secure-parrot_webui_prelogin=; Max-Age=0; …（预登录 Cookie 被清除）
   session.subjectId=administrator, roles=["administrator"],
   capabilities=[management.destructive, management.logs.body.read, management.read,
                 management.secrets.write, management.update, management.write]
4) /webui/bff/auth/session   authenticated=true
5) 真实上游数据
   overview         http=200 bytes=1276
   channels         http=200 bytes=167
   stats/summary    http=200 bytes=2188
   api-keys         http=200 bytes=1089
   models           http=200 bytes=212481
   runtime/status   http=200 bytes=8032
```

`overview` 返回的是真实业务数据（非演示数据）：

```json
{"data":{"version":"0.33.1","uptimeSeconds":111414,"listeners":{"host":"0.0.0.0","port":22122},
 "counts":{"channels":0,"oauthAccounts":10,"apiKeys":1,"quotaHot":2},
 "today":{"total":95,"successCount":80,"errorCount":14,"totalRetries":30,"affinityHits":77,
          "totalInputTokens":894622,"totalOutputTokens":39543}}}
```

**现场踩坑记录（值得写进运维手册）**：Parrot 配置里的 `apiKeys.admin` 是**下游推理 API Key**，
**不是**管理主密钥；用它登录会得到上游的 `AUTHENTICATION_FAILED`（BFF 原样透传，状态 401）。
真正的管理主密钥是配置里的 `management.managementKey`（`pmk_` 前缀，本次实测 68 字节）。
这与 README「登录要填管理主密钥，不是推理 API Key」的说明一致，但仅看配置文件很容易选错字段。

### 4.3 安全边界

| 检查项 | 结果 |
| --- | --- |
| 未登录读受保护接口 | 401 `WEBUI_SESSION_REQUIRED` |
| 登录请求缺 `x-csrf-token` | 403 `WEBUI_CSRF_REJECTED` |
| 其它域名访问 `/webui/`（`porn` / `moontv` / `api`.huachuanx.com） | 全部 **404**（`$host` 白名单生效，未泄露本项目） |
| Cookie 属性（真实公网 HTTPS） | `__Secure-` 前缀、`HttpOnly`、`Secure`、`Path=/webui/`、`SameSite=Lax`、**不设 Domain** |
| **真实浏览器是否接受并回传 `__Secure-` Cookie** | 通过。在面板浏览器里对 `/webui/bff/auth/login` 发一次**故意错误**的密钥：拿到 `bootstrap 200` + CSRF + `login 401 AUTHENTICATION_FAILED`。若浏览器没保存/未回传预登录 Cookie，这里会先被 `WEBUI_CSRF_REJECTED` 拦下（403） |
| BFF 日志/浏览器里是否出现管理密钥 | BFF 只记录 method/route/status/durationMs/requestId；日志中无 body/Cookie/Authorization |
| 退出登录 | `POST /webui/bff/auth/logout` → 200；随后 `overview` → 401 |

### 4.4 公网端口封闭（acceptance.md §5.6 兑现）

```bash
$ docker port parrot-webui-webui-1          # 空：未发布任何宿主端口
$ ss -ltnp | grep -E "3000|172.31.240"
LISTEN 0  32768  0.0.0.0:3000  …  docker-proxy  pid=11922   # ← moontv-core 的既有监听，与本项目无关
LISTEN 0  32768     [::]:3000  …  docker-proxy  pid=11927   # ← 同上
# 没有 172.31.240.x 的宿主机监听，WebUI 只存在于容器网络内部
$ docker compose config | grep -c published
0
```

WebUI **没有任何宿主端口**，公网无从连接；入口只有 `https://parrot.huachuanx.com/webui/`。
（对照：`docs/nginx-webui.conf` 里「公网 3000 应连接失败」的检查在本机不适用，
因为宿主 3000 已被 moontv 合法占用；这里用「零发布 + 无新增监听」证明同一结论。）

### 4.5 容器加固（acceptance.md §5.4 兑现）

```text
User=node                  # 容器内 id → uid=1000(node) gid=1000(node)，非 root
ReadonlyRootfs=true
CapDrop=[ALL]
SecurityOpt=[no-new-privileges:true]
Tmpfs=map[/tmp:size=32m,mode=1777]
Privileged=false
NetworkMode=parrot-webui-ingress
Binds=[]                   # 无任何挂载：没有 docker.sock，也没有原 Parrot 数据目录
Health=healthy  Restarts=0
```

### 4.6 原 Parrot 无回归（acceptance.md §5.5 兑现）

```bash
$ docker ps --filter name=^parrot$
parrot  Up 31 hours (healthy)  ghcr.io/danger-dream/parrot:latest  created 2026-09-20
$ docker inspect parrot  →  网络=parrot_default   端口=22122/tcp
$ md5sum /opt/parrot/docker-compose.yml
c765e3d977059b0abdbd5a8e588d020e     # mtime 仍是 Sep 2，与部署前一致
```

入口回归（改动后实测，与部署前行为一致）：

| 入口 | 结果 |
| --- | --- |
| `https://parrot.huachuanx.com/v1/models` | 401（未认证，符合原行为） |
| `https://parrot.huachuanx.com/api/management/v1/meta` | 401 |
| `https://porn.huachuanx.com/` | 302（该站点自身行为） |
| `https://moontv.huachuanx.com/` | 307（该站点自身行为） |

### 4.7 真实浏览器（acceptance.md §5.7 兑现）

面板浏览器打开 `https://parrot.huachuanx.com/webui/`：

- 标题 `Parrot 管理台`；登录页完整渲染，并展示真实探测结果：`契约 v0.33.1`、`237 个上游操作`、`上游可达`。
- **控制台零消息**（无 JS 报错、无 CSP 违规 —— 即 `script-src 'self'` 与 Ant Design CSS-in-JS 在真实浏览器下可用）。
- 深链接：直接访问 `/webui/models` 时 SPA 正常加载，并停在 `/webui/login`（**没有**跳到域名根的 `/login`），符合验收项。
- 登录页明确说明「需要管理密钥，不是推理用的 API Key」，且不显示未实现的 Telegram 登录按钮。

### 4.8 真机验收中发现并修复的真实缺陷：浏览器里根本无法登录

这是本次真机测试最重要的产出 —— `acceptance.md` §5.7 写的是「浏览器行为未验证」，
一验证就发现登录在真实浏览器里 **100% 不可用**；而 curl 直连 BFF 却完全正常，
所以此前基于假上游的自动化测试根本碰不到它。

**现象**：在真实 Chrome 里打开登录页、填入管理主密钥、点「登录」，页面报：

```text
权限不足，无法执行该操作 [上游权限判定]
WEBUI_CSRF_REJECTED：当前会话缺少 CSRF Token，请刷新页面后重试
```

刷新毫无用处（提示语本身就在骗人）。更关键的是：**BFF 日志里一条
`POST /webui/bff/auth/login` 都没有** —— 请求从来没有被发出去。

**根因**（`apps/web/src/app/AuthProvider.tsx`）：初始化时先 `refreshBootstrap()`
（把预登录 CSRF 存进内存），紧接着 `refreshSession()`；未登录时后者走 `else` 分支执行
`setCsrfToken(null)`，**把刚拿到的预登录 CSRF 抹掉了**。于是提交登录时，
`apps/web/src/api/client.ts` 的本地校验 `if (!state.csrfToken) throw ...` 直接在浏览器里抛错，
请求根本不会发出。这是确定性缺陷：每次刷新后都一样。

**修复**（3 个文件、4 处改动；修复后 `pnpm typecheck` 四包全绿、`pnpm test` 71 例全绿）：

| 文件 | 改动 | 说明 |
| --- | --- | --- |
| `apps/web/src/app/AuthProvider.tsx` | 未登录分支不再 `setCsrfToken(null)` | **根因**：会话 CSRF 与预登录 CSRF 是两回事，`/bff/auth/session` 未登录时返回 `csrfToken: null`，不能拿它覆盖预登录 Token |
| `apps/web/src/app/AuthProvider.tsx` | `login()` 前先 `refreshBootstrap({ adoptCsrf: true })` | 预登录会话 TTL 只有 5 分钟，且登录成功时 BFF 会清掉预登录 Cookie，所以每次登录都要重新取一份；否则「页面放久了」或「注销后再登录」同样会失败 |
| `apps/web/src/components/state.tsx` | `isPermissionDenied` 要求 `source === 'upstream'` | WebUI 自己产生的 403 不再被说成「上游权限判定」，不再误导排查方向 |
| `apps/web/src/api/client.ts` | 新增 `suppressSessionLost` 选项，`bff.login` 使用 | 登录时密钥不对返回的 401 只代表这次换票失败，不再触发「会话已失效，请重新登录」的全局提示 |

**修复后实测**（面板浏览器，用**故意错误**的密钥，避免真实密钥进入日志与对话记录）：

```text
GET  /webui/bff/bootstrap      200    ← login() 先取新鲜预登录会话（新逻辑生效）
POST /webui/bff/auth/login     401    ← 请求真的发出去了（修复前：一条 POST 都没有）
UI：Parrot 返回了业务错误 [Parrot 业务错误] AUTHENTICATION_FAILED：Authentication failed 请求ID：a4952d937298f4f4538a5bec
```

错误归因从此正确（上游业务错误），也不再出现「会话已失效」的误导提示；
用**真实密钥**的完整链路见 §4.2（登录 200、读到真实总览/渠道/模型数据）。

## 5. 未验证（本次仍未覆盖，与本次部署无关）

1. **真实供应商 OAuth 联调**（OpenAI / Claude 等真实授权端点）：仅按代码路径处理，未逐家联调。
2. **用真实密钥在浏览器里走查登录后的页面交互**（总览 → 渠道 → 账号 → 模型 → Key → 日志 → 任务 → 注销）：
   本次为不把生产管理主密钥键入 GUI 剪贴板，未用真实密钥在浏览器完成这一步；
   浏览器侧的登录通路（预登录会话 → CSRF → POST → 上游鉴权 → 错误归因）已在 §4.8 用错误密钥完整验证，
   已登录态下的数据读取由 §4.2 的真实 API 链路覆盖。
   如需补做，面板浏览器已停在登录页，可由操作者自行填入密钥。
3. **Telegram 批准登录**、模型别名 CRUD、多值筛选、负载均衡/网络诊断/MCP 等未实现能力：
   仍是 `acceptance.md` §4 的范围外项。
4. **CDN / 第二层代理**：`parrot.huachuanx.com` 无 CDN，本次按单层公网入口配置 `$remote_addr`。
   若将来前面加 CDN，需按 `docs/nginx-webui.conf` 顶部说明先做真实来源还原。

## 6. 升级 / 回滚 / 卸载（本机实际路径）

升级（重新构建后替换镜像，不动 Parrot）：

```bash
# 开发机
docker build -t parrot-webui:local . && docker save parrot-webui:local | gzip -1 > img.tgz
scp img.tgz root@209.146.116.54:/root/
# 目标机
gunzip -c /root/img.tgz | docker load
cd /opt/parrot-webui && docker compose up -d --force-recreate webui
docker compose ps && docker compose logs --tail=50 webui
```

回滚入口（先摘入口，再停服务）：

```bash
# 1) 摘掉 /webui/ 分流
rm -f /home/docker/npm/data/nginx/custom/server_proxy.conf
docker exec npm nginx -t && docker exec npm nginx -s reload
# 2) 停 WebUI（不动 Parrot）
cd /opt/parrot-webui && docker compose down
# 3) 按需清理网络
docker network disconnect parrot-webui-ingress npm && docker network rm parrot-webui-ingress
```

回滚 compose 适配本身：`cp /opt/parrot-webui/compose.yaml.orig-20260922 /opt/parrot-webui/compose.yaml`。

## 7. 安装记录留档（deployment.md §9 要求的现场项）

| 待现场确认项 | 现场答案 |
| --- | --- |
| 实际 Parrot 版本 / 管理 API 就绪 / 监听端口 / 可达路径 | `v0.33.1`；`/health` ok；`0.0.0.0:22122`；容器内经 `host.docker.internal:22122`（host-gateway）实测可达 |
| 现有域名与访问方式、是否有 CDN / 第二层代理 | `https://parrot.huachuanx.com`；NPM 单层入口，无 CDN |
| `WEBUI_TRUST_PROXY` 真实取值 | `172.31.240.0/24`（专用入口网络，仅含 NPM 与 WebUI） |
| 入口软件 / 配置目录 / reload 方式 / 是否 default_server | Nginx Proxy Manager 容器；`/home/docker/npm/data/nginx/custom/server_proxy.conf`；`docker exec npm nginx -t && nginx -s reload`；其它站点未改 |
| Docker 宿主类型 | Linux 宿主（Debian 12），非 Docker Desktop，`host.docker.internal` 经 host-gateway 有效（已实测） |
| 真实浏览器 Cookie / 重定向行为 | `__Secure-` + HttpOnly + Secure + Path=/webui/ + SameSite=Lax + 无 Domain，浏览器已接受并回传；`/webui` → 308 `/webui/` |
| 反向代理改动后原推理/管理/MCP 回归 | `/v1/models` 401、`/api/management/v1/meta` 401、其它域名首页 302/307 —— 与改动前一致 |
| 部署主机与产物 | `209.146.116.54:/opt/parrot-webui`；镜像 `parrot-webui:local`（含 §4.8 修复，已 `--force-recreate` 生效） |

### 7.1 交付镜像的最终构建与上线记录

为避免任何构建缓存残留，最后一次交付用了 `docker rmi parrot-webui:local` +
`docker build --no-cache` 的干净重建，再整体传到目标机加载：

| 项 | 值 |
| --- | --- |
| 构建方式 | 开发机 `docker build --no-cache --progress=plain -t parrot-webui:local .`（仍执行 `pnpm contracts:generate --check`，输出 `[build] contracts routes ok: 76`） |
| 镜像 | `parrot-webui:local`，574 MB，构建机镜像 ID `4902290eb10f` |
| 传输 | `docker save \| gzip -1` → 102 MB，`sha256 d4b2d94df4243d888a2fb15cc1fa3cc4bcef12233fa627860c00b4286c7557aa`，两端校验一致；scp 15.8 s |
| 目标机镜像 ID | `sha256:c59861d7b111054f9ff7c0137c51d4cb924f956b3cb44c8ef65e739292988047`（与容器 `docker inspect .Image` 一致，旧镜像已 `docker rmi` 清理） |
| 前端产物 | `/webui/assets/index-BuzoPGLR.js`（构建包内可检索到本次修复的标识 `adoptCsrf`、`suppressSessionLost`，证明修复确实进入交付物） |
| 上线后复验 | `/webui` 308、`/webui/` 200、`/webui/models` 深链接 200、`/webui/health/live` 404、`/v1/models` 401（无回归）；真实密钥登录 200 并读回真实数据；浏览器端提交实测为 `bootstrap 200 → POST /webui/bff/auth/login 401`，错误归因正确 |
