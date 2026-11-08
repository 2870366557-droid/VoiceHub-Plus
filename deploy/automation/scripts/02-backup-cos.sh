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
# VoiceHub 数据库备份异地同步到腾讯云 COS（腾讯云 TAT，每天 03:30 北京时间）
# 依赖：coscmd 及其配置文件（路径由 VH_COS_CONF 指定，权限 600；凭据不入库）
# 2026-10-25 优化：上传前查重、失败重试 3 次并回读校验、同步上传 sha256、保留最近 14 份
set -uo pipefail
BK="$VH_HOME/backups"
CONF=${VH_COS_CONF:-/root/.cos.conf}
PREFIX=${VH_COS_PREFIX:-voicehub/}
KEEP=${VH_KEEP_COPIES:-14}
DUMP=$(ls -1t "$BK"/vh-*.dump 2>/dev/null | head -1)
[ -n "$DUMP" ] || { echo "SKIP 没有可上传的备份"; exit 0; }
command -v coscmd >/dev/null 2>&1 || { echo "FAIL coscmd 未安装"; exit 1; }
[ -f "$CONF" ] || { echo "SKIP COS 未配置（缺少 $CONF）"; exit 0; }

NAME=$(basename "$DUMP")
SHA=$(cut -d' ' -f1 "$DUMP.sha256" 2>/dev/null || true)

if coscmd info "$PREFIX$NAME" >/dev/null 2>&1; then
  echo "PASS 远端已存在，跳过上传: $PREFIX$NAME"
else
  OK=0
  for i in 1 2 3; do
    if coscmd upload "$DUMP" "$PREFIX$NAME" >/dev/null 2>&1 && coscmd info "$PREFIX$NAME" >/dev/null 2>&1; then
      OK=1; break
    fi
    echo "  第 $i 次上传失败，$((i*5)) 秒后重试"
    sleep $((i*5))
  done
  [ "$OK" = "1" ] || { echo "FAIL COS 上传失败（已重试 3 次）"; exit 1; }
  echo "PASS 已上传 COS: $PREFIX$NAME（$(du -h "$DUMP" | cut -f1)）"
fi
[ -n "$SHA" ] && echo "$NAME $SHA" > /tmp/.cos-last-upload

if [ -f "$DUMP.sha256" ]; then
  coscmd upload "$DUMP.sha256" "$PREFIX$NAME.sha256" >/dev/null 2>&1 \
    && echo "PASS 已上传校验文件: $PREFIX$NAME.sha256"
fi

# 保留最近 KEEP 份（文件名时间升序，删除最旧的）
mapfile -t ALL < <(coscmd list -a "$PREFIX" 2>/dev/null | grep -oE "${PREFIX}vh-[0-9]{8}-[0-9]{6}\.dump" | sort)
N=${#ALL[@]}
DEL=$((N-KEEP))
if [ "$DEL" -gt 0 ]; then
  for ((i=0; i<DEL; i++)); do
    f=${ALL[$i]}
    coscmd delete "$f" >/dev/null 2>&1 && echo "  已清理旧备份: $f"
    coscmd delete "$f.sha256" >/dev/null 2>&1 || true
  done
fi
KEPT=$(( N < KEEP ? N : KEEP ))
echo "PASS COS 备份完成，保留最近 $KEPT 份（共 $N 份）"
