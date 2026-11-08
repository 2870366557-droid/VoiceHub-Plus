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
# VoiceHub 攻击监控（腾讯云 TAT，每 10 分钟）
# 2026-10-25 优化：边缘日志只读取一次；补充 script 拦截计数；告警链接改为配置项；容器异常时明确失败
set -uo pipefail
SITE=${VH_SITE_URL:-https://example.invalid}
LOG="$VH_HOME/backups/attack-watch.log"
MAIL=${VH_MAIL_BIN:-/usr/local/bin/voicehub-mail.py}
COOLDOWN=/tmp/.voicehub-attack-mail
mkdir -p "$(dirname "$LOG")"
TS=$(date '+%F %T')
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

if ! docker logs --since 10m voicehub-rewriter >"$TMP" 2>&1; then
  echo "FAIL 无法读取 voicehub-rewriter 日志（容器可能未运行）"; exit 1
fi
cnt(){ grep -c "$1" "$TMP" 2>/dev/null || true; }
BAN=$(cnt '\[ban\] BLOCK')
GEO=$(cnt '\[geo\] BLOCK')
PAGE=$(cnt '\[attack-page\]')
LOCK=$(cnt '\[attack-lock\]')
SCRIPT=$(cnt '\[script\] BLOCK')

echo "$TS ban=$BAN geo=$GEO page=$PAGE lock=$LOCK script=$SCRIPT" >> "$LOG"
tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"

TOTAL=$((BAN + PAGE + SCRIPT))
if [ "$TOTAL" -gt 0 ]; then
  echo "ALERT 近 10 分钟检测到攻击活动: 封禁命中=$BAN 攻击声明页=$PAGE 脚本拦截=$SCRIPT 新增锁定=$LOCK 地域拦截=$GEO"
  echo "--- 攻击来源 Top ---"
  grep -E '\[ban\] BLOCK|\[attack-page\]|\[script\] BLOCK' "$TMP" \
    | sed -E 's/.*ip=([0-9.]+).*/\1/' | sort | uniq -c | sort -rn | head -5
  echo "--- 最近锁定 ---"
  grep '\[attack-lock\]' "$TMP" | tail -3
  NOW=$(date +%s)
  LAST=$(cat "$COOLDOWN" 2>/dev/null || echo 0)
  if [ $((NOW - LAST)) -gt 1800 ] && [ -x "$MAIL" ]; then
    {
      echo "VoiceHub 攻击告警"
      echo "时间: $(date '+%F %T %Z')   主机: $(hostname)  公网IP: ${VH_PUBLIC_IP:-未配置}"
      echo ""
      echo "近 10 分钟：封禁名单命中=$BAN  攻击声明页=$PAGE  脚本拦截=$SCRIPT  新增锁定=$LOCK  地域拦截=$GEO"
      echo "攻击来源 Top:"
      grep -E '\[ban\] BLOCK|\[attack-page\]|\[script\] BLOCK' "$TMP" \
        | sed -E 's/.*ip=([0-9.]+).*/\1/' | sort | uniq -c | sort -rn | head -8 | sed 's/^/  /'
      echo "最近锁定记录:"
      grep '\[attack-lock\]' "$TMP" | tail -5 | sed 's/^/  /'
      echo ""
      echo "详情见管理端 → 攻击日志：$SITE/dashboard"
    } | "$MAIL" "[VoiceHub] 攻击告警 $(date '+%m-%d %H:%M')" && echo "$NOW" > "$COOLDOWN"
  fi
else
  echo "PASS 近 10 分钟无攻击活动（地域拦截 $GEO 次为常规扫描）"
fi
