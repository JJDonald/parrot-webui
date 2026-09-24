# 安全模型

本文件回答四个问题：**凭据在哪里**、浏览器请求怎么被校验、BFF 到上游的边界是什么、重启后会话会怎样。
所有描述都对应仓库内的实现文件；未能在仓库内确认的部分标注「待现场确认」。

## 1. 凭据在哪里（唯一事实）

| 凭据 | 位置 | 生命周期 | 绝不出现的地方 |
| --- | --- | --- | --- |
| Parrot **管理主密钥**（managementKey） | 只出现在浏览器 `POST /webui/bff/auth/login` 的 JSON 请求体里 | 仅在该请求处理期间存在于 BFF 进程内存，用于向上游换取 Session | 环境变量、`.env`、Compose、镜像层、磁盘、日志、前端存储、诊断接口 |
| 上游 **Session credential** | 只在 BFF 进程内存（有界会话表） | 受本地空闲/绝对有效期与上游截止时间约束 | 浏览器（任何响应/HTML/JS）、Cookie、磁盘、日志 |
| 浏览器 **本地会话 Cookie** | 浏览器 Cookie jar + BFF 内存中的会话映射 | 空闲 D=1800s、绝对 D=28800s（可配置），或登出即失效 | 上游请求（不会转发浏览器 Cookie）、URL、LocalStorage |
| 预登录 Cookie | 同 Cookie 机制，供登录前的 CSRF/bootstrap 使用 | 300s（`bootstrapTtlSeconds` 固定值） | 上游请求 |

要点：

- **`.env` / Compose 里不得设置共享管理密钥**（任何形如 `PARROT_ADMIN_KEY` / `WEBUI_ADMIN_KEY` 的变量都是错误做法）。
  BFF 的配置加载（`apps/bff/src/config.ts`）**不读取**任何密钥类变量；它只读地址、时长、限流等参数。
- 上游 credential 只在 `apps/bff/src/upstream/client.ts` 里以 `Authorization: Bearer <credential>` 注入，
  并且 `maxRedirections: 0`（不跟随重定向，避免把 Authorization 带到别的主机）。
- 浏览器侧只有不透明 Cookie；Cookie 值不是上游 credential。

## 2. 浏览器请求校验（Origin / CSRF / Host / Fetch Metadata）

实现位置：`apps/bff/src/security/request-guard.ts`。

- **Host**：默认只接受与 `WEBUI_PUBLIC_ORIGIN` 的主机（含端口）完全一致的 Host；
  容器健康检查（`/webui/health/*`）额外允许 `127.0.0.1`/`localhost`/`::1`/`WEBUI_BIND_HOST`，
  这个例外**只**适用于健康检查路径，不扩展到 `/webui/bff/*`。
- **Origin**：写方法（POST/PUT/PATCH/DELETE）必须携带 Origin，且必须与 `WEBUI_PUBLIC_ORIGIN` 精确相等
  （协议、主机、端口）；缺失、`null`、空、错误一律拒绝。非写请求携带了错误 Origin 也拒绝（防御性）。
  不因 Cookie 有效而放行。
- **Fetch Metadata**：`Sec-Fetch-Site` 出现且不属于 `same-origin`/`none` 时拒绝。它是补充，不替代 Origin/CSRF。
- **CSRF**：写请求必须携带 `X-CSRF-Token`，与当前会话/预登录会话绑定的 Token 做常量时间比较；
  登录后重新签发（预登录 Token 与登录后 Token 是两套）。
- **Content-Type**：写请求只接受 `application/json`（或空），其他类型直接 415，避免把任意内容转发给上游。
- **CORS**：不开放跨域，不返回 `Access-Control-Allow-Origin: *`；同源前端与 BFF 共用 `/webui/` 路径。
- **无 CSRF 的例外**：无。包括登录、登出、OAuth 轮询 POST。

## 3. 固定目标与路由允许清单

- 上游地址只能来自部署环境 `PARROT_BASE_URL`（严格解析为 origin：禁止用户名/密码、路径、query、fragment）。
  浏览器**不能**传入任意 target/upstream/url，BFF 也不是开放转发代理。
- `PARROT_BASE_URL` 不得等于 `WEBUI_PUBLIC_ORIGIN`（否则通过 `/webui/` 形成代理循环，启动即失败）。
- 业务代理只允许构建时冻结的 `method + path` 模板集合（当前 76 条，见 `packages/contracts/mvp-routes.json`）；
  其余管理路径统一 404 `WEBUI_ROUTE_NOT_ALLOWED`。白名单外的能力（`updates/*`、`system/*`、`network/*`、
  `mcp/*`、`retention/*`、`proxy/*` 等）整体不开放。
- `/api/management/v1/auth/*` 只允许 BFF 认证控制器调用，不经浏览器通用代理。
- **不代理 `/v1/*` 推理入口**：本服务不是公共 AI 网关。
- 上游请求头由 BFF 重建：只按需传递 `Accept`、`Content-Type`、`If-Match`、`Idempotency-Key`、
  校验后的 `X-Request-Id`；**不转发**浏览器的 `Authorization`、`Cookie`、`Origin`、`Referer`、`Host`、
  `X-Forwarded-*`、`Proxy-*`、`Connection` 等。
- 不透传上游 `Set-Cookie`、CORS 与 hop-by-hop 头；认证/业务/日志/密钥响应统一 `Cache-Control: no-store`。

## 4. 来源判定与限流

- 客户端来源解析（`apps/bff/src/security/ip.ts`）：**不信任任意来源的 X-Forwarded-For**。
  只有当直连对端地址落在 `WEBUI_TRUST_PROXY` 配置内时，才从右向左跳过可信代理、取第一个不可信地址。
  因此 `WEBUI_TRUST_PROXY` 必须等于真实入口代理地址/CIDR；正式模式留空或填 `*`/`true` 会在启动时失败。
- 默认限流与并发闸门（可在 `.env` 覆盖，取值区间见 `apps/bff/src/config.ts`）：

  | 项目 | 默认 |
  | --- | --- |
  | 登录：每来源每分钟 | 5 |
  | 登录：全局每分钟 | 30 |
  | 登录并发 | 4 |
  | 预登录 bootstrap：每来源每分钟 | 20 |
  | 预登录 bootstrap：全局每分钟 | 100 |
  | bootstrap 并发 | 8 |
  | 会话表容量 | 100 会话 + 200 预登录（有界，定期清理） |

- 上游 Parrot 自己对 BFF 来源还有一套限流：多用户会共享同一来源配额，429 与 `Retry-After` 会保留给前端。
  **不要**通过伪造来源头绕过上游限流。
- 如果 `WEBUI_TRUST_PROXY` 配错（例如全部用户被识别成同一个代理地址），来源限流会退化成共享桶；
  验收时要确认两个不同客户端的限流键不同（见 [deployment.md](./deployment.md) 第 5 节）。

## 5. 脱敏日志

BFF 只记录：请求方法、允许清单内的路由模板、状态码、耗时、requestId。
不记录完整 URL query、请求/响应正文、Cookie、Authorization、管理密钥、OAuth token、原始日志正文。
Fastify 层还额外 `redact`（remove）`authorization`、`cookie`、`x-csrf-token`、`set-cookie` 头。
反向代理侧对 `/webui/` 关闭 access_log（`deploy/nginx-webui.conf`），避免 OAuth 回填链接里的临时参数入日志。

## 6. Cookie 与同源风险

- Cookie 名带 `__Secure-` 前缀（生产）：`__Secure-parrot_webui_session`、`__Secure-parrot_webui_prelogin`；
  属性：`HttpOnly`、`Secure`、`SameSite=Lax`、`Path=/webui/`，**不设置 Domain**。
- 生产环境 `Secure` 恒为真；`WEBUI_DEV_INSECURE_COOKIES` 只在非 production 生效，供本地开发使用。
- 安全响应头：CSP（`script-src 'self'`，不含 `unsafe-inline`；`frame-ancestors 'none'`）、`nosniff`、
  `Referrer-Policy: no-referrer`、`X-Frame-Options: DENY`、生产环境 HSTS。
- **同域路径不构成安全隔离**：本项目与 Parrot 同域名、同源。如果该域名下还能托管不可信的可执行 HTML，
  必须先解决同源 XSS 风险，否则本项目与 Parrot 都会受影响。不要在 `/webui/` 下挂第三方页面。

## 7. 重启与登出后的会话行为

- 会话与上游 credential **只在进程内存**：容器/进程重启（`docker compose restart`、重建、升级）后
  所有本地会话消失，**用户需要重新登录**。这是明确支持的行为，不是缺陷。
- 单副本、单进程，第一版不支持多副本共享会话；不要横向扩容（会造成登录随机失效）。
- 本地登出（`POST /webui/bff/auth/logout`）会清除本地 Cookie 并**尝试**调用上游 `DELETE /auth/session` 吊销。
  **不能也不应声称"已远程吊销该管理密钥的全部会话"**：BFF 无法枚举或撤销其它客户端在原 Parrot 上持有的会话，
  上游吊销也可能因不可达而失败（失败时只影响本地登出的完整性，不会让本地会话继续可用）。
- 若怀疑管理密钥泄露，正确处置是在**上游 Parrot 侧轮换管理密钥**（轮换方式「待现场确认」），
  而不是只重启 WebUI；重启 WebUI 只清掉本项目内存里的旧 credential，不会影响别处已获取的会话。
- 删除容器/镜像不会删除原 Parrot 的任何配置或数据；本项目不挂载任何原数据目录、不安装 Docker socket。

## 8. 运维检查清单（可在容器内执行）

```bash
# 1) 确认非 root、根文件系统只读、capabilities 与提权限制
docker inspect parrot-webui-webui-1 \
  --format 'user={{.Config.User}} readonly={{.HostConfig.ReadonlyRootfs}} caps={{.HostConfig.CapDrop}} sec={{.HostConfig.SecurityOpt}}'

# 2) 确认没有任何挂载（不应出现 docker.sock 或原 Parrot 数据目录）
docker inspect parrot-webui-webui-1 --format '{{json .Mounts}}'

# 3) 确认环境变量里没有密钥类变量
docker inspect parrot-webui-webui-1 --format '{{json .Config.Env}}' | tr ',' '\n' | grep -i -E 'key|secret|token' || echo '无密钥类变量'

# 4) 确认健康检查不对外（应从公网/浏览器得到 404）
curl -sSI https://<原Parrot域名>/webui/health/live | head -1

# 5) 确认诊断接口不回显原始上游地址
curl -sS https://<原Parrot域名>/webui/bff/diagnostics   # 需已登录；upstream 应显示"已配置（默认不外显...）"
```

`WEBUI_DIAGNOSTICS_EXPOSE_UPSTREAM=1` 只应在排障时临时开启，用完立刻关掉。
