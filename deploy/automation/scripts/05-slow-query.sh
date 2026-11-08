#!/bin/bash
# ---------------------------------------------------------------------------
# 统一配置：站点信息与凭据路径均从外部文件读取，脚本内不保存任何密钥。
# 部署：把 automation.env.example 复制为 /etc/voicehub/automation.env（600），
#       按实际环境填写；可用 VH_AUTOMATION_ENV 指定其他路径。
# 说明见 deploy/automation/README.md
# ---------------------------------------------------------------------------
VH_ENV_FILE=${VH_AUTOMATION_ENV:-/etc/voicehub/automation.env}
[ -r "$VH_ENV_FILE" ] && . "$VH_ENV_FILE"
VH_HOME=${VH_HOME:-/srv/voicehub}
# VoiceHub 每周数据库慢查询报告（腾讯云 TAT，每周一 09:00 北京时间）
# 2026-10-25 优化：容器慢日志只读取一次；检查 pg_stat_statements；邮件发送失败时保留统计不清零
set -uo pipefail
TS=$(date '+%F %T %Z')
MAIL=${VH_MAIL_BIN:-/usr/local/bin/voicehub-mail.py}
PGLOG=$(mktemp)
REP=$(mktemp)
trap 'rm -f "$PGLOG" "$REP"' EXIT

ext=$(docker exec voicehub-postgres psql -U voicehub -d voicehub -tAc \
  "select count(*) from pg_extension where extname='pg_stat_statements'" 2>/dev/null || echo 0)
if [ "${ext//[[:space:]]/}" != "1" ]; then
  echo "FAIL pg_stat_statements 扩展未启用（当前=$ext），周报无法生成"
  exit 1
fi
docker logs --since 168h voicehub-postgres >"$PGLOG" 2>&1 || true

{
echo "===== VoiceHub 慢查询周报 $TS ====="
echo "--- 按总耗时 Top 15 ---"
docker exec voicehub-postgres psql -U voicehub -d voicehub -tA -F' | ' -c "
SELECT round(total_exec_time::numeric,0)||'ms', calls||'次', round(mean_exec_time::numeric,1)||'ms均值',
       left(regexp_replace(query, '\s+', ' ', 'g'), 150)
FROM pg_stat_statements WHERE calls >= 3 AND query NOT LIKE '%pg_stat_statements%'
ORDER BY total_exec_time DESC LIMIT 15;"
echo "--- 按平均耗时 Top 10（calls>=10）---"
docker exec voicehub-postgres psql -U voicehub -d voicehub -tA -F' | ' -c "
SELECT round(mean_exec_time::numeric,1)||'ms均值', calls||'次',
       left(regexp_replace(query, '\s+', ' ', 'g'), 130)
FROM pg_stat_statements WHERE calls >= 10 AND query NOT LIKE '%pg_stat_statements%'
ORDER BY mean_exec_time DESC LIMIT 10;"
echo "--- PostgreSQL 容器慢日志（最近 7 天，>500ms）---"
grep -oE 'duration: [0-9.]+ ms  statement: .{0,140}' "$PGLOG" | LC_ALL=C sort -t: -k2 -rn | head -10 || echo "（无）"
echo "--- 表大小 Top 8 ---"
docker exec voicehub-postgres psql -U voicehub -d voicehub -tA -F' | ' -c "
SELECT relname, n_live_tup||'行', pg_size_pretty(pg_total_relation_size(relid)) AS 总大小
FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 8;"
echo "--- 连接数 ---"
docker exec voicehub-postgres psql -U voicehub -d voicehub -tA -c \
  "select count(*)||' / '||current_setting('max_connections') from pg_stat_activity;"
} >"$REP" 2>&1
cat "$REP"

RC=0
if [ -x "$MAIL" ]; then
  "$MAIL" "[VoiceHub] 数据库慢查询周报 $(date +%F)" <"$REP" || RC=$?
else
  echo "WARN 未找到 voicehub-mail.py，跳过邮件推送"
fi
if [ "$RC" -eq 0 ]; then
  docker exec voicehub-postgres psql -U voicehub -d voicehub -c "SELECT pg_stat_statements_reset();" >/dev/null 2>&1 \
    && echo "PASS 统计已重置，下周重新累计" || echo "WARN 统计重置失败"
else
  echo "WARN 邮件发送失败（exit $RC），本次不重置统计，下周报告将包含两周数据"
fi
echo "===== 周报结束 ====="
