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
# VoiceHub 放行 IP 库更新（中国大陆 IPv4 + Cloudflare CDN 回源）
# 用途：更新 rewriter 放行 IP 库；可选由 TAT 定时器或 systemd timer 触发（默认不启用）
# 执行：建议每月 1 日 04:00（Asia/Shanghai），按需启用
# 适配：2026-11-08 线上 rewriter v6（只读 /app/geo-allow-cidrs.txt，IPv6 由代码内前缀放行）
# 2026-11-08 修正：
#   1) 单文件 bind mount 下用 install/mv 换 inode 会导致容器内仍读旧文件，改为原地截断写入；
#   2) 增加容器内行数校验与地域闸状态提示，避免「健康检查 200 即 PASS」的假阳性；
#   3) 明确 Cloudflare IPv6 段不入库（代码内硬编码前缀覆盖），仅校验下载源可用；
#   4) 健康检查探针头改用双引号使变量生效；地域闸开启时追加境外 IP 应被拦的校验。
set -uo pipefail

WORK=/tmp/geo-allow-update
CIDR_LIVE=${VH_GEO_CIDR_FILE:-$VH_HOME/rewriter/geo-allow-cidrs.txt}
GEO_STATE_FILE=${VH_GEO_STATE_FILE:-$VH_HOME/rewriter/state/geo-lock.json}
mkdir -p "$WORK"; cd "$WORK"

# ---------- 1. 下载中国 IPv4 段（APNIC 聚合）----------
DL=""
for u in "https://www.ipdeny.com/ipblocks/data/aggregated/cn-aggregated.zone" \
         "https://raw.githubusercontent.com/17mon/china_ip_list/master/china_ip_list.txt"; do
  if curl -sL --retry 3 --retry-delay 5 --max-time 120 -o cn.txt "$u" && [ "$(grep -c '/' cn.txt 2>/dev/null || echo 0)" -gt 3000 ]; then
    DL="$u"; break
  fi
done
[ -z "$DL" ] && { echo "FAIL 下载国内 IP 库失败"; exit 1; }
echo "PASS 国内库下载成功（$DL，$(grep -c '/' cn.txt) 条）"

# ---------- 2. 下载 Cloudflare 段 ----------
# rewriter 的 IPv6 放行由代码内 V6_CF_PREFIXES / V6_CN_PREFIXES 处理，不依赖本文件；
# 这里仍下载 v6 只是为了确认源可用，不参与合并。
curl -sL --retry 2 --max-time 60 -o cf4.txt https://www.cloudflare.com/ips-v4 || true
curl -sL --retry 2 --max-time 60 -o cf6.txt https://www.cloudflare.com/ips-v6 || true
[ "$(grep -c '/' cf4.txt 2>/dev/null || echo 0)" -ge 10 ] || { echo "FAIL Cloudflare IPv4 段下载失败"; exit 1; }
echo "PASS Cloudflare 段下载成功（v4 $(grep -c '/' cf4.txt) 条 / v6 $(grep -c '/' cf6.txt 2>/dev/null || echo 0) 条）"

# ---------- 3. 合并、去重、排序（仅 IPv4 CIDR，逐行，与 rewriter 解析格式一致）----------
python3 - <<'PY'
import ipaddress
def load(p):
    try:
        return [l.strip() for l in open(p) if '/' in l]
    except Exception:
        return []
cn = load('/tmp/geo-allow-update/cn.txt')
cf = load('/tmp/geo-allow-update/cf4.txt')
nets = []
for x in cn + cf:
    try:
        n = ipaddress.ip_network(x, strict=False)
        if n.version == 4:
            nets.append(n)
    except Exception:
        pass
assert len(nets) > 4000, f'IPv4 段数量异常: {len(nets)}'
out = [str(n) for n in ipaddress.collapse_addresses(nets)]
open('/tmp/geo-allow-update/new-cidrs.txt', 'w').write('\n'.join(out) + '\n')
print(f'PASS 生成 CIDR {len(out)} 条')
PY
[ $? -ne 0 ] && { echo "FAIL 生成 CIDR 失败"; exit 1; }

# ---------- 4. 无变化则跳过 ----------
if cmp -s new-cidrs.txt "$CIDR_LIVE" 2>/dev/null; then
  echo "PASS 数据无变化，跳过重启"; exit 0
fi

# ---------- 5. 替换 + 重启 + 健康检查 ----------
# compose 为「单文件 bind mount」：宿主 inode 直接挂进容器。
# 不能用 install/mv（会替换 inode，docker restart 不重建挂载，容器内仍读旧文件）；
# 必须原地截断写入保留 inode，再 restart 让 rewriter 启动时重新加载。
cp -a "$CIDR_LIVE" "$CIDR_LIVE.bak" 2>/dev/null || true
cat new-cidrs.txt > "$CIDR_LIVE"
chmod 644 "$CIDR_LIVE"
HOST_CNT=$(wc -l < "$CIDR_LIVE")
echo "INFO 已写入新 CIDR（$HOST_CNT 条，sha256 $(sha256sum new-cidrs.txt | cut -c1-12)…）"
docker restart voicehub-rewriter >/dev/null
sleep 8
PROBE_IP=${VH_PROBE_IP:-223.5.5.5}
DENY_IP=${VH_DENY_PROBE_IP:-8.8.8.8}
for i in $(seq 1 10); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "X-Forwarded-For: $PROBE_IP" http://127.0.0.1:3001/ 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then
    CT_CNT=$(docker exec voicehub-rewriter sh -c 'wc -l < /app/geo-allow-cidrs.txt' 2>/dev/null | tr -d ' ')
    if [ -n "$CT_CNT" ] && [ "$CT_CNT" != "$HOST_CNT" ]; then
      echo "FAIL 容器内 CIDR 行数(${CT_CNT})与宿主机($HOST_CNT)不一致，挂载未生效"
      break
    fi
    echo "PASS 更新完成并健康检查通过（CIDR $HOST_CNT 条，容器内已生效）"
    GEO_STATE=$(cat "$GEO_STATE_FILE" 2>/dev/null || echo '{"enabled":false}')
    if echo "$GEO_STATE" | grep -q '"enabled"[[:space:]]*:[[:space:]]*false'; then
      echo "WARN 地域闸当前关闭，200 只证明站点可用，未校验放行规则；开闸后请用境外 IP 复验（期望 403）"
      rm -f "$CIDR_LIVE.bak"
      exit 0
    fi
    # 闸门开启：额外验证境外 IP 确实被拦，避免「库已更新但闸门失效」被健康检查掩盖。
    # 此处只告警不回滚：IP 库本身是好的，回滚会二次重启且无助于恢复闸门。
    deny_code=$(curl -s -o /dev/null -w '%{http_code}' -H "X-Forwarded-For: $DENY_IP" http://127.0.0.1:3001/ 2>/dev/null || echo 000)
    if [ "$deny_code" = "403" ]; then
      echo "PASS 地域闸生效（境外测试 IP 返回 403）"
      rm -f "$CIDR_LIVE.bak"
      exit 0
    fi
    echo "WARN 地域闸疑似未生效：境外测试 IP 返回 $deny_code（期望 403），请检查 geo-lock 状态与放行库加载"
    exit 1
  fi
  sleep 3
done

# ---------- 6. 失败回滚（cp 保留 inode，容器内同步恢复）----------
cp -a "$CIDR_LIVE.bak" "$CIDR_LIVE" 2>/dev/null || true
docker restart voicehub-rewriter >/dev/null
echo "FAIL 健康检查失败，已回滚并重启"
exit 1
