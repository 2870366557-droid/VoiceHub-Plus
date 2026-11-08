# VoiceHub 运维自动化（腾讯云 TAT）

这里存放可选的定时运维脚本与配置说明。脚本可由 TAT（自动化助手）等调度工具按计划执行，覆盖数据库备份、异地同步、安全巡检、攻击监控、慢查询周报，以及放行 IP 库更新。

**核心约定：仓库里没有任何凭据。** 密钥、口令、令牌、私钥、站点标识全部通过外部配置文件或环境变量注入，脚本内只有占位符和默认值。配置方法见第 2、5 节。

---

## 1. 任务一览

| 脚本 | 任务 | 频率（北京时间） |
| --- | --- | --- |
| `scripts/01-db-backup.sh` | 数据库备份 + 完整性校验 + 过期清理 | 每天 03:15 |
| `scripts/02-backup-cos.sh` | 备份文件异地同步到 COS（查重/重试/回读/保留策略） | 每天 03:30 |
| `scripts/03-security-inspect.sh` | 每日安全巡检（容器、链路、证书、资源、暴露面、备份新鲜度） | 每天 08:00 |
| `scripts/04-attack-watch.sh` | 攻击监控与邮件告警（带冷却） | 每 10 分钟 |
| `scripts/05-slow-query.sh` | 数据库慢查询周报 | 每周一 09:00 |
| `scripts/06-geo-allow-update.sh` | 放行 IP 库更新（配合地域访问限制使用，见第 8 节） | 建议每月 1 日 04:00 |

---

## 2. 安全约定：凭据怎么管

### 原则

1. **命令内容零凭据**：TAT 命令里粘贴的是本目录脚本，脚本不保存任何密钥值。
2. **配置与代码分离**：站点信息写在主机上的 `/etc/voicehub/automation.env`（`chmod 600`），凭据写在各自的外部载体里，脚本只引用**路径**。
3. **最小权限 + 用完即删**：调用云 API 只用 CAM 子账号的临时密钥，通过环境变量传入，用完立即撤销。

### 凭据与环境信息清单

| 用途 | 载体（主机上） | 配置项 | 权限 | 说明 |
| --- | --- | --- | --- | --- |
| COS `SecretId` / `SecretKey` | `/root/.cos.conf`（coscmd 配置） | `VH_COS_CONF` | `600`，仅 root | 由 `coscmd` 自行读取，脚本不接触值 |
| 邮件 SMTP 账号 / 授权码 | 邮件发送脚本自带的配置 | `VH_MAIL_BIN` | `600` | 脚本只调用该程序，不传凭据 |
| 数据库口令 | compose 的 `.env` → 容器内环境变量 | — | `600` | 脚本用 `docker exec` 在容器内免密执行 |
| 腾讯云 API 密钥 | 环境变量（仅同步工具使用） | — | 环境变量 | `TENCENTCLOUD_SECRET_ID` / `TENCENTCLOUD_SECRET_KEY`，建议临时密钥 |
| SSH 私钥 | 运维终端本地 | — | `600` | 绝不入库 |
| 站点域名 / 验证文件 / 公网 IP | `/etc/voicehub/automation.env` | `VH_*` | `600` | 非凭据，但也不写入公开仓库 |

### 禁止事项

- 不要把 `.env`、`.cos.conf`、`*.pem`、PAT、API Key、实例 ID、真实域名/IP 提交到仓库。
- 不要在 TAT 命令描述、参数、标签里粘贴密钥。
- 不要在聊天、截图、日志里回显密钥。若曾外泄，**立即轮替/撤销**。
- 本目录的 `.gitignore` 已排除 `automation.env` 与各类 `*.env`；请保持。

---

## 3. 目录结构

```
deploy/automation/
├── README.md                  # 本文：配置说明
├── automation.env.example     # 配置模板（全占位符）
├── .gitignore                 # 防止本地配置误入库
├── sync-to-tat.py             # 可选：把脚本同步为 TAT 命令
└── scripts/
    ├── 01-db-backup.sh
    ├── 02-backup-cos.sh
    ├── 03-security-inspect.sh
    ├── 04-attack-watch.sh
    ├── 05-slow-query.sh
    └── 06-geo-allow-update.sh
```

---

## 4. 前置条件

- 目标主机已安装 **TAT Agent**，且在 TAT 控制台可见（状态「在线」）。
- 主机上有：`docker`、`curl`、`openssl`、`python3`、`sha256sum`、`numfmt`、`coscmd`（仅 COS 任务需要）。
- 执行用户 **root**（需要 `docker exec`、`systemctl`、`docker restart`）。
- 已知部署约定（若与你的环境不同，修改脚本内对应常量）：容器名 `voicehub` / `voicehub-postgres` / `voicehub-redis` / `voicehub-rewriter`；数据库用户与库名 `voicehub`；应用端口 `3000`、rewriter `3001`。
- 地域：填**你的实例所在地域**（如 `ap-guangzhou`），定时表达式按 **Asia/Shanghai（UTC+8）** 解释。

---

## 5. 配置步骤

### Step 1 · 生成主机配置

把模板复制到主机并填写（**不要提交填好后的文件**）：

```bash
sudo install -d -m 700 /etc/voicehub
sudo cp automation.env.example /etc/voicehub/automation.env
sudo chmod 600 /etc/voicehub/automation.env
sudo vi /etc/voicehub/automation.env      # 把所有 <...> 换成实际值
```

关键项：`VH_HOME`、`VH_SITE_URL`、`VH_SITE_HOST`、`VH_WWW_URL`、`VH_VERIFY_PATH`、`VH_VERIFY_SHA`、`VH_COS_CONF`、`VH_MAIL_BIN`、`VH_EXPECTED_PORTS`（含 `|`，值必须加引号）。
未配置时脚本用中性默认值，巡检与告警会提示异常——所以**务必填写**。

### Step 2 · 准备凭据载体

```bash
# COS：由 coscmd 生成配置（会提示输入密钥，仅在主机上保存）
sudo coscmd config -a <SecretId> -s <SecretKey> -b <bucket> -r <region>
sudo chmod 600 /root/.cos.conf

# 邮件：部署你自己的发送脚本，凭据放该脚本同目录配置，权限 600
#       路径填入 VH_MAIL_BIN
```

> 数据库口令由 compose 的 `.env` 提供，脚本不读取，无需额外配置。

### Step 3 · 在 TAT 创建命令

控制台路径：**自动化助手 TAT → 命令管理 → 新建命令**。每条命令：

- 命令类型：`SHELL`
- 命令内容：粘贴对应 `scripts/*.sh` 的**全部内容**
- 执行用户：`root`；工作目录：`/`
- 超时：见下表
- 无需开启「参数功能」（脚本从配置文件读取）

| 命令名称 | 来源脚本 | 超时（秒） |
| --- | --- | --- |
| `VoiceHub-每日数据库备份` | `01-db-backup.sh` | 600 |
| `VoiceHub-COS异地备份` | `02-backup-cos.sh` | 600 |
| `VoiceHub-每日安全巡检` | `03-security-inspect.sh` | 600 |
| `VoiceHub-攻击监控` | `04-attack-watch.sh` | 600 |
| `VoiceHub-数据库慢查询周报` | `05-slow-query.sh` | 300 |

> 命令名需与已有名称**完全一致**，否则同步工具会把它当成新命令重复创建。触发器名与命令名可以不同，见下表。

也可跳过手工粘贴，用第 7 节的同步工具。

### Step 4 · 创建定时触发器

控制台路径：**自动化助手 TAT → 定时任务 → 新建**。每个触发器：选择对应命令 → 选择目标实例 → 执行用户 `root` → 类型「周期性执行」→ 填 Cron（时区选 **Asia/Shanghai**）。

| 触发器名称 | 对应命令 | Cron（北京时间） | 说明 |
| --- | --- | --- | --- |
| `VoiceHub-数据库每日备份` | `VoiceHub-每日数据库备份` | `15 3 * * *` | 每天 03:15 |
| `VoiceHub-COS异地备份` | `VoiceHub-COS异地备份` | `30 3 * * *` | 每天 03:30（晚于本地备份） |
| `VoiceHub-每日安全巡检` | `VoiceHub-每日安全巡检` | `0 8 * * *` | 每天 08:00 |
| `VoiceHub-攻击监控-10分钟` | `VoiceHub-攻击监控` | `*/10 * * * *` | 每 10 分钟 |
| `VoiceHub-慢查询周报` | `VoiceHub-数据库慢查询周报` | `0 9 * * 1` | 每周一 09:00 |

> 顺序有依赖：COS 同步必须晚于本地备份。调整频率时请保持这个先后关系。

### Step 5 · 校验

1. 对每条命令点「手动执行」，确认输出以 `PASS` 开头且退出码为 0；`SKIP` 表示条件未满足（如无备份可传），`FAIL` 需排查。
2. 检查产物：备份目录出现 `.dump` 与 `.sha256`；COS 出现同名对象；巡检邮件收到。
3. 观察 1～2 个周期，在「执行记录」里确认定时器按时触发。
4. 脚本应输出明确的状态前缀：`PASS` / `WARN` / `INFO` / `FAIL`。

---

## 6. 脚本行为要点

| 脚本 | 主要动作 | 失败处理 |
| --- | --- | --- |
| 01 | `pg_dump` → `pg_restore -l` 校验 → 写 sha256 → 清理 N 天前备份与孤立校验文件 | 任一步失败即退出 1，不产生半成品 |
| 02 | 取最新 dump → COS 查重 → 最多重试 3 次上传并回读 → 上传 sha256 → 保留最近 N 份 | 三次失败退出 1；未配置 COS 则 `SKIP` |
| 03 | 容器/链路/证书/资源/服务/端口/攻击日志/数据库/流量/备份新鲜度，结果同时输出与邮件 | 累计失败项作为退出码 |
| 04 | 读取近 10 分钟 rewriter 日志统计拦截类型，超限发告警邮件（30 分钟冷却） | 无法读取容器日志时明确失败 |
| 05 | 检查 `pg_stat_statements`，生成 Top 慢查询/表大小/连接数周报并邮件 | 邮件发送失败时**不重置**统计 |
| 06 | 下载国内 IPv4 段与 CDN 回源段 → 合并去重 → 原地更新 IP 库 → 重启 rewriter → 健康检查 + 容器内行数校验 | 校验失败自动回滚并重启 |

### 公网暴露面基线

巡检只放行 **SSH 高位端口 + `80`/`443`（Cloudflare 回源）** 三个公网监听端口，白名单由 `VH_EXPECTED_PORTS` 配置。应用 `3000`、rewriter `3001`、PostgreSQL `5432`、Redis `6379` 只允许监听 `127.0.0.1`，并由 ufw 拒绝外部访问；任何新增的公网监听端口都会判为 `FAIL`。

**不要把测试站或内部端口写进白名单**——那会让真实的新增暴露面被漏报。旧版本曾把已不存在的测试站端口列入预期并报「符合预期」，现已移除。巡检会先输出「实际公网监听端口」列表，便于与基线逐项核对。

---

## 7. 用同步工具维护命令（可选，推荐）

手工粘贴容易和仓库版本漂移。`sync-to-tat.py` 会对比仓库脚本与 TAT 现有命令的内容哈希，只更新有差异的命令（命令 ID 不变，已绑定的定时器不受影响）。

```bash
pip install tencentcloud-sdk-python-tat

# 凭据只走环境变量，建议使用临时密钥，用完立即撤销
export TENCENTCLOUD_SECRET_ID=<...>
export TENCENTCLOUD_SECRET_KEY=<...>
# export TENCENTCLOUD_SESSION_TOKEN=<...>   # 临时密钥时加这行
export TAT_REGION=<your-region>

python3 sync-to-tat.py --region "$TAT_REGION"            # 只读对比，不写入
python3 sync-to-tat.py --region "$TAT_REGION" --apply    # 创建/更新命令

unset TENCENTCLOUD_SECRET_ID TENCENTCLOUD_SECRET_KEY     # 用完清除
```

- 默认 **dry-run**：只列出脚本哈希与「一致 / 需更新 / 需创建」，并打印建议的定时器表。
- `--apply` 才调用写接口；`--include-geo` 额外同步可选的 IP 库命令。
- **不自动创建定时器**，避免把命令误绑到错误实例；请按第 5 节 Step 4 在控制台配置。
- 工具不打印、不保存、不落盘任何凭据。

---

## 8. 放行 IP 库更新（可选功能）

`06-geo-allow-update.sh` 用于更新 rewriter 的放行 IP 库（中国大陆 IPv4 + CDN 回源段）。

**为什么要替换旧脚本**：早期版本维护的文件与运行时实际读取的文件不一致，更新不会生效；数据源格式变化后下载校验会直接失败；单文件挂载方式下用 `install/mv` 替换文件也不会在容器内生效；健康检查在地域闸关闭时还会给出通过但实际未验证规则的假象。

**本版修正**：对齐运行时实际读取的文件路径；改用稳定的聚合数据源并校验条数；采用原地截断写入以保留挂载 inode；增加容器内行数强校验与失败回滚；地域闸关闭时给出明确提示而非误报通过。

**启用方式**（在需要地域访问限制时）：

1. 确认地域访问限制已开启，且 `VH_GEO_CIDR_FILE`、`VH_GEO_STATE_FILE`、`VH_PROBE_IP` 已在 `automation.env` 配好；
2. 先手工执行一次，确认输出 `PASS ... 容器内已生效`；
3. 用 `sync-to-tat.py --apply --include-geo` 创建命令，再按 `0 4 1 * *`（每月 1 日 04:00）建定时器；
4. 启用后用境外 IP 复验，期望被拦截。

> IPv6 放行由 rewriter 代码内的固定前缀处理，不依赖该 IP 库文件，脚本只处理 IPv4。

---

## 9. 故障排查

| 现象 | 检查点 |
| --- | --- |
| 命令输出 `FAIL 工作目录 ... 不存在` | `VH_HOME` 是否指向实际部署目录 |
| 巡检「公网链路异常」 | `VH_SITE_URL` / `VH_VERIFY_PATH` / `VH_VERIFY_SHA` 是否与站点验证文件一致 |
| 巡检「证书 SAN 不含 ...」 | `VH_SITE_HOST` 是否为证书实际签发主机名 |
| 告警邮件没收到 | `VH_MAIL_BIN` 是否存在且可执行、其自身配置是否正确、是否处于冷却期 |
| COS 任务 `SKIP` | `VH_COS_CONF` 指向的文件是否存在、`coscmd` 是否可用 |
| 周报提示扩展未启用 | 在数据库启用 `pg_stat_statements` 并重启 |
| 巡检「存在非预期公网监听端口」 | 用 `ss -lntp` 确认监听地址是否为 `0.0.0.0` / `[::]`；内部服务应只绑定 `127.0.0.1`，核对 ufw 规则与 compose 端口映射 |
| IP 库更新报行数不一致 | 确认 compose 为单文件 bind mount，脚本是否采用原地写入 |
| 定时器没触发 | TAT Agent 在线状态、地域、时区（Asia/Shanghai）、触发器是否启用 |

---

## 10. 变更记录

| 日期 | 内容 |
| --- | --- |
| 2026-11-08 | 运维脚本统一配置外置与占位符化；更新放行 IP 库脚本；巡检补充公网监听端口检查；整理脚本集与配置说明、同步工具 |
| 2026-10-25 | 备份完整性校验、COS 查重重试、巡检与告警增强、慢查询周报 |
