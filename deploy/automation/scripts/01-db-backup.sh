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
# VoiceHub 每日数据库备份（腾讯云 TAT，每天 03:15 北京时间）
# 2026-10-25 优化：导出后先用 pg_restore -l 校验备份完整性；校验和/孤立文件清理
set -uo pipefail
BK="$VH_HOME/backups"
TS=$(date +%Y%m%d-%H%M%S)
DUMP="$BK/vh-$TS.dump"
mkdir -p "$BK"
cd "$VH_HOME" || { echo "FAIL 工作目录 $VH_HOME 不存在"; exit 1; }

if ! docker exec voicehub-postgres sh -c \
  'pg_dump -U voicehub -d voicehub -Fc -Z 9 -f /tmp/vh.dump && pg_restore -l /tmp/vh.dump >/dev/null'; then
  echo "FAIL pg_dump 失败或备份文件未通过完整性校验"; exit 1
fi
docker cp voicehub-postgres:/tmp/vh.dump "$DUMP" >/dev/null || { echo "FAIL 备份文件复制失败"; exit 1; }
docker exec voicehub-postgres rm -f /tmp/vh.dump >/dev/null 2>&1
chmod 600 "$DUMP"

SIZE=$(stat -c%s "$DUMP")
if [ "$SIZE" -lt 50000 ]; then echo "FAIL 备份文件过小（$SIZE 字节）"; exit 1; fi
SHA=$(sha256sum "$DUMP" | cut -d' ' -f1)
printf '%s  %s\n' "$SHA" "$(basename "$DUMP")" > "$DUMP.sha256"
chmod 600 "$DUMP.sha256"

# 保留最近 14 天，并清理没有对应 dump 的孤立校验文件
find "$BK" -maxdepth 1 -name 'vh-*.dump' -mtime +"${VH_KEEP_DAYS:-14}" -delete 2>/dev/null
find "$BK" -maxdepth 1 -name 'vh-*.dump.sha256' -mtime +"${VH_KEEP_DAYS:-14}" -delete 2>/dev/null
for f in "$BK"/vh-*.dump.sha256; do
  [ -e "$f" ] || continue
  [ -e "${f%.sha256}" ] || rm -f "$f"
done

ROWS=$(docker exec voicehub-postgres psql -U voicehub -d voicehub -tAc 'select count(*) from "User"' 2>/dev/null || echo 0)
TOTAL=$(find "$BK" -maxdepth 1 -name 'vh-*.dump' | wc -l)
echo "PASS 备份完成 $(basename "$DUMP")（$(numfmt --to=iec "$SIZE")，sha256 ${SHA:0:12}…）用户=$ROWS 现有备份=$TOTAL 份"
