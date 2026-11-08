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
# VoiceHub 每日安全巡检（腾讯云 TAT，每天 08:00 北京时间）
# 2026-10-25 优化：站点域名改为配置项；结果只采集一次并同时写 TAT 输出与邮件；
# 增加源站证书 SAN 校验、地域闸状态、www 域名检查；COS 免费额度到期改为提醒不判失败
set -uo pipefail
SITE=${VH_SITE_URL:-https://example.invalid}
VERIFY_PATH=${VH_VERIFY_PATH:-/site-verification.txt}
VERIFY_SHA=${VH_VERIFY_SHA:-UNSET}
MAIL=${VH_MAIL_BIN:-/usr/local/bin/voicehub-mail.py}
FAIL=0
ok(){ echo "PASS $*"; }
bad(){ echo "FAIL $*"; FAIL=$((FAIL+1)); }
warn(){ echo "WARN $*"; }
info(){ echo "INFO $*"; }

inspect(){
echo "===== VoiceHub 巡检 $(date '+%F %T %Z') ====="
echo "--- 容器 ---"
for c in voicehub voicehub-postgres voicehub-redis voicehub-rewriter; do
  st=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo missing)
  [ "$st" = "running" ] && ok "容器 $c running" || bad "容器 $c = $st"
done
echo "--- 可用性 ---"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:3000/ || echo 000)
[ "$code" = "200" ] && ok "本地应用 HTTP 200" || bad "本地应用 HTTP $code"
# 公网链路用「微信验证文件」验证：Nginx/rewriter 直接返回，不受地域闸影响
vfile=$(curl -s --max-time 15 -4 "$SITE$VERIFY_PATH" 2>/dev/null || true)
[ "$vfile" = "$VERIFY_SHA" ] && ok "公网链路 Cloudflare→源站 正常" || bad "公网链路异常（$SITE 验证文件读取失败）"
www_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -4 "${VH_WWW_URL:-https://www.example.invalid}/" 2>/dev/null || echo 000)
case "$www_code" in 200|403) info "www 域名 HTTP $www_code" ;; *) bad "www 域名异常 HTTP $www_code" ;; esac
root_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -4 "$SITE/" 2>/dev/null || echo 000)
info "公网首页 HTTP $root_code（403=地域闸拦截海外出口；200=地域闸关闭或出口被放行）"
gl=$(docker exec voicehub-rewriter sh -c 'cat /app/state/geo-lock.json 2>/dev/null' 2>/dev/null || true)
case "$gl" in
  *'"enabled":true'*) info "地域闸：开启（仅中国大陆放行）" ;;
  *'"enabled":false'*) warn "地域闸：关闭（所有 IP 放行，如需开启请在管理后台切换）" ;;
  *) warn "地域闸状态读取失败: ${gl:-空}" ;;
esac
echo "--- TLS 证书（源站证书，SNI=根域名）---"
cer=$(echo | openssl s_client -connect 127.0.0.1:443 -servername "${VH_SITE_HOST:-example.invalid}" 2>/dev/null)
end=$(printf '%s\n' "$cer" | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
if [ -n "$end" ]; then
  days=$(( ( $(date -d "$end" +%s) - $(date +%s) ) / 86400 ))
  [ "$days" -gt 30 ] && ok "源站证书剩余 ${days} 天（$end）" || bad "源站证书仅剩 ${days} 天"
  if printf '%s\n' "$cer" | openssl x509 -noout -ext subjectAltName 2>/dev/null | grep -q "DNS:${VH_SITE_HOST:-example.invalid}"; then
    ok "源站证书 SAN 含 ${VH_SITE_HOST:-example.invalid}"
  else
    warn "源站证书 SAN 不含 ${VH_SITE_HOST:-example.invalid} —— 请重新签发源站证书并替换 nginx 证书文件"
  fi
else
  bad "无法读取源站证书"
fi
echo "--- 资源 ---"
mem_used=$(free | awk '/Mem:/{printf "%d", $3/$2*100}')
disk_used=$(df / | awk 'NR==2{gsub("%","",$5); print $5}')
[ "$mem_used" -lt 90 ] && ok "内存使用 ${mem_used}%" || bad "内存使用 ${mem_used}%"
[ "$disk_used" -lt 90 ] && ok "磁盘使用 ${disk_used}%（$(df -h / | awk 'NR==2{print $4}') 可用）" || bad "磁盘使用 ${disk_used}%"
sw=$(free -m | awk '/Swap:/{print $2}')
[ "$sw" -gt 0 ] && ok "Swap 已启用 ${sw}MB" || bad "Swap 未启用"
echo "--- 安全检查服务 ---"
for s in nginx fail2ban ufw docker; do
  st=$(systemctl is-active "$s" 2>/dev/null || echo inactive)
  [ "$st" = "active" ] && ok "$s active" || bad "$s = $st"
done
f2b=$(fail2ban-client status sshd 2>/dev/null | grep -oP 'Currently banned:\s+\K\d+' || echo "?")
info "fail2ban 当前封禁 SSH 爆破 IP: ${f2b}"
echo "--- 网络暴露面 ---"
# 基线：仅 SSH 高位端口与 Cloudflare 回源 HTTP/HTTPS 允许监听公网。
# 应用、rewriter、数据库、缓存只监听 127.0.0.1，不应出现在公网监听列表里；
# 白名单保持最小集，任何新增的公网监听端口都应被判为异常，不得把测试/内部端口加进来。
EXPECTED=${VH_EXPECTED_PORTS:-22222|80|443}
ports=$(ss -lntp 2>/dev/null | awk 'NR>1{print $4}' | grep -E '^(0\.0\.0\.0|\[::\]|\*):' | sed -E 's/.*:([0-9]+)$/\1/' | sort -un)
listed=$(printf '%s\n' "$ports" | paste -sd, - | sed 's/^$/无/')
extra=$(printf '%s\n' "$ports" | grep -vE "^($EXPECTED)$" | grep -c . || true)
info "实际公网监听端口: ${listed:-无}"
if [ "$extra" -eq 0 ]; then
  ok "公网暴露面符合预期（仅 $EXPECTED：SSH 与 Cloudflare 回源）"
else
  bad "存在 $extra 个非预期公网监听端口：$(printf '%s\n' "$ports" | grep -vE "^($EXPECTED)$" | tr '\n' ' ')"
fi
echo "--- 边缘防护（近 24 小时）---"
ban=$(docker logs --since 24h voicehub-rewriter 2>&1 | grep -c '\[ban\] BLOCK' || true)
geo=$(docker logs --since 24h voicehub-rewriter 2>&1 | grep -c '\[geo\] BLOCK' || true)
page=$(docker logs --since 24h voicehub-rewriter 2>&1 | grep -c '\[attack-page\]' || true)
info "封禁命中 ${ban:-0} 次 / 地域拦截 ${geo:-0} 次 / 攻击声明页 ${page:-0} 次"
attlog=$(docker exec voicehub-postgres psql -U voicehub -d voicehub -tAc \
  "select count(*) from \"AttackLog\" where \"createdAt\" > now() - interval '24 hours'" 2>/dev/null || echo 0)
info "攻击日志入库（24h）: ${attlog:-0} 条"
echo "--- 数据库 ---"
mig=$(docker exec voicehub-postgres psql -U voicehub -d voicehub -tAc 'select count(*) from __drizzle_migrations__' 2>/dev/null || echo 0)
[ "$mig" -ge 66 ] && ok "数据库迁移数 $mig" || bad "数据库迁移数 $mig（应 ≥66）"
users=$(docker exec voicehub-postgres psql -U voicehub -d voicehub -tAc 'select count(*) from "User"' 2>/dev/null || echo 0)
info "用户数 $users"
db_size=$(docker exec voicehub-postgres psql -U voicehub -d voicehub -tAc "select pg_size_pretty(pg_database_size('voicehub'))" 2>/dev/null || echo "?")
info "数据库大小 $db_size"
echo "--- 流量统计（Nginx 响应字节）---"
TODAY_D=$(LC_ALL=C date +%d/%b/%Y)
TODAY_BYTES=$(awk -v d="$TODAY_D" '$4 ~ d {sum+=$10} END {print sum+0}' /var/log/nginx/access.log 2>/dev/null || echo 0)
ALL_BYTES=$(cat /var/log/nginx/access.log* 2>/dev/null | awk '{sum+=$10} END {print sum+0}')
TODAY_MB=$(awk -v b="$TODAY_BYTES" 'BEGIN{printf "%.2f", b/1048576}')
TOTAL_MB=$(awk -v b="$ALL_BYTES" 'BEGIN{printf "%.2f", b/1048576}')
QUOTA_GB=1536
PCT=$(awk -v t="$TOTAL_MB" -v q="$QUOTA_GB" 'BEGIN{printf "%.3f", (t/1024/q)*100}')
info "今日出站流量约 ${TODAY_MB} MB（含 Cloudflare 回源）"
info "日志保留期内累计约 ${TOTAL_MB} MB / 月配额 ${QUOTA_GB} GB（约 ${PCT}%）"
AVG_MBPS=$(awk -v b="$TODAY_BYTES" 'BEGIN{printf "%.2f", (b*8)/(86400*1000000)}')
info "今日平均出站速率约 ${AVG_MBPS} Mbps（套餐上限 30Mbps）"
echo "--- 异地备份 ---"
if [ -f /tmp/.cos-last-upload ]; then
  info "最近 COS 上传: $(cat /tmp/.cos-last-upload)"
else
  info "COS 异地备份: 尚未记录上传结果"
fi
if [ "$(date +%Y%m%d)" -ge 20270301 ]; then
  warn "COS 免费额度已于 2027-03 到期，请检查是否产生费用"
fi
echo "--- 备份新鲜度 ---"
last=$(ls -1t "$VH_HOME"/backups/vh-*.dump 2>/dev/null | head -1)
if [ -n "$last" ]; then
  age_h=$(( ( $(date +%s) - $(stat -c %Y "$last") ) / 3600 ))
  [ "$age_h" -lt 26 ] && ok "最近备份 $(basename "$last") ${age_h} 小时前" || bad "最近备份已 ${age_h} 小时（>26h）"
else
  bad "没有任何数据库备份"
fi
}

REPORT=$(mktemp)
inspect >"$REPORT" 2>&1
cat "$REPORT"
echo "--- 邮件推送 ---"
if [ -x "$MAIL" ]; then
  if "$MAIL" "[VoiceHub] 每日安全巡检 $(date +%F)" <"$REPORT"; then
    echo "PASS 巡检报告已发送"
  else
    rc=$?
    echo "FAIL 巡检报告发送失败（exit $rc）"
    FAIL=$((FAIL+1))
  fi
else
  warn "未找到 voicehub-mail.py，跳过邮件推送"
fi
rm -f "$REPORT"
echo "===== 巡检结束：失败 $FAIL 项 ====="
exit "$FAIL"
