#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 scripts/ 下的运维脚本同步为腾讯云 TAT 命令。

安全约定
  - 凭据只从环境变量读取，不写入仓库、不打印、不落盘：
      TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY
      TENCENTCLOUD_SESSION_TOKEN（可选，使用临时密钥时）
  - 默认只读对比（dry-run）；只有显式 --apply 才写入 TAT。
  - 不自动创建定时触发器：实例 ID 属于你的资源信息，按 README 表格在控制台配置。
  - 同步只改命令内容，不改命令 ID，已绑定的定时器不受影响。

依赖：pip install tencentcloud-sdk-python-tat
用法：
  export TENCENTCLOUD_SECRET_ID=<...> TENCENTCLOUD_SECRET_KEY=<...>
  python3 sync-to-tat.py --region <your-region>              # 只读对比
  python3 sync-to-tat.py --region <your-region> --apply      # 创建/更新命令
  python3 sync-to-tat.py --region <your-region> --apply --include-geo   # 额外同步 IP 库命令
  # 用完请及时 unset 或删除临时密钥
"""
import argparse
import base64
import hashlib
import json
import os
import sys

# (TAT 命令名, 脚本文件, 超时秒)
COMMANDS = [
    ("VoiceHub-每日数据库备份", "01-db-backup.sh", 600),
    ("VoiceHub-COS异地备份", "02-backup-cos.sh", 600),
    ("VoiceHub-每日安全巡检", "03-security-inspect.sh", 600),
    ("VoiceHub-攻击监控", "04-attack-watch.sh", 600),
    ("VoiceHub-数据库慢查询周报", "05-slow-query.sh", 300),
]
GEO_COMMAND = ("VoiceHub-放行IP库月度更新", "06-geo-allow-update.sh", 600)

# (触发器名称, 对应命令名, cron，按 Asia/Shanghai 北京时间)
# 注意：触发器名与命令名不一定相同，以生产现有名称为准，避免同步时重复创建。
INVOKERS = [
    ("VoiceHub-数据库每日备份", "VoiceHub-每日数据库备份", "15 3 * * *"),
    ("VoiceHub-COS异地备份", "VoiceHub-COS异地备份", "30 3 * * *"),
    ("VoiceHub-每日安全巡检", "VoiceHub-每日安全巡检", "0 8 * * *"),
    ("VoiceHub-攻击监控-10分钟", "VoiceHub-攻击监控", "*/10 * * * *"),
    ("VoiceHub-慢查询周报", "VoiceHub-数据库慢查询周报", "0 9 * * 1"),
]


def die(msg):
    print("ERROR " + msg)
    sys.exit(2)


def print_invokers(include_geo=False):
    print("\n建议的定时触发器（时区 Asia/Shanghai，UTC+8）：")
    print(f"  {'触发器名称':<28} {'Cron':<16} 对应命令")
    for name, cmd, cron in INVOKERS:
        print(f"  {name:<28} {cron:<16} {cmd}")
    if include_geo:
        print(f"  {'VoiceHub-放行IP库月度更新':<28} {'0 4 1 * *':<16} {GEO_COMMAND[0]}（可选，默认不启用）")
    print("  实例：在控制台选择目标 CVM / Lighthouse 实例；执行用户 root。")


def main():
    ap = argparse.ArgumentParser(description="同步运维脚本到腾讯云 TAT 命令")
    ap.add_argument("--region", default=os.environ.get("TAT_REGION"), help="地域 ID，如 ap-guangzhou")
    ap.add_argument("--scripts-dir", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts"))
    ap.add_argument("--apply", action="store_true", help="真正写入 TAT；默认仅只读对比")
    ap.add_argument("--include-geo", action="store_true", help="一并同步可选的放行 IP 库命令")
    args = ap.parse_args()

    if not args.region:
        die("请用 --region 或环境变量 TAT_REGION 指定地域")

    wanted = list(COMMANDS)
    if args.include_geo:
        wanted.append(GEO_COMMAND)

    items = []
    for name, fn, timeout in wanted:
        path = os.path.join(args.scripts_dir, fn)
        if not os.path.isfile(path):
            die("缺少脚本：" + path)
        raw = open(path, "rb").read()
        items.append((name, fn, timeout, raw, hashlib.sha256(raw).hexdigest()))

    print("待同步脚本：")
    for name, fn, timeout, raw, sha in items:
        print(f"  {fn:<30} {len(raw):>6} B  sha256 {sha[:12]}  -> {name} ({timeout}s)")

    sid = os.environ.get("TENCENTCLOUD_SECRET_ID")
    skey = os.environ.get("TENCENTCLOUD_SECRET_KEY")
    stok = os.environ.get("TENCENTCLOUD_SESSION_TOKEN")
    if not (sid and skey):
        print("\n未检测到 API 凭据环境变量，跳过在线对比。")
        print("如需在线对比/同步，请设置 TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY")
        print("（建议使用 CAM 子账号最小权限的临时密钥，用完立即删除）。")
        print_invokers(args.include_geo)
        return

    try:
        from tencentcloud.common import credential
        from tencentcloud.common.profile.client_profile import ClientProfile
        from tencentcloud.common.profile.http_profile import HttpProfile
        from tencentcloud.tat.v20201028 import tat_client, models
    except ImportError:
        die("缺少 SDK：pip install tencentcloud-sdk-python-tat")

    cred = credential.Credential(sid, skey, stok) if stok else credential.Credential(sid, skey)
    hp = HttpProfile(endpoint="tat.tencentcloudapi.com", reqTimeout=30)
    cl = tat_client.TatClient(cred, args.region, ClientProfile(httpProfile=hp))

    existing = {}
    off = 0
    while True:
        q = models.DescribeCommandsRequest()
        q.Limit, q.Offset = 100, off
        r = cl.DescribeCommands(q)
        cs = r.CommandSet or []
        for x in cs:
            d = json.loads(x.to_json_string())
            if d.get("CreatedBy") != "USER":
                continue
            content = ""
            try:
                content = base64.b64decode(d.get("Content", "")).decode("utf-8", "ignore")
            except Exception:
                pass
            existing[d.get("CommandName")] = (
                d.get("CommandId"),
                hashlib.sha256(content.encode()).hexdigest(),
            )
        off += len(cs)
        if not cs or off >= (r.TotalCount or 0):
            break

    print(f"\nTAT 地域 {args.region}：现有用户命令 {len(existing)} 条")
    plan = []
    for name, fn, timeout, raw, sha in items:
        if name in existing:
            cid, remote_sha = existing[name]
            state = "内容一致" if remote_sha == sha else "有差异，需更新"
            plan.append(("UPDATE", name, cid, raw, timeout))
        else:
            state = "不存在，需创建"
            plan.append(("CREATE", name, None, raw, timeout))
        print(f"  {name:<30} {state}")

    if not args.apply:
        print("\n[dry-run] 未做任何写入。确认无误后加 --apply 执行。")
        print_invokers(args.include_geo)
        return

    print("\n[apply] 即将写入生产 TAT。请确认目标主机已完成第 5 节 Step 1/2："
          "存在 /etc/voicehub/automation.env 且已按实际环境填写，否则脚本会使用中性默认值。")
    for action, name, cid, raw, timeout in plan:
        sha = hashlib.sha256(raw).hexdigest()
        content = base64.b64encode(raw).decode()
        if action == "CREATE":
            q = models.CreateCommandRequest()
            q.CommandName = name
            q.CommandType = "SHELL"
            q.Content = content
            q.Timeout = timeout
            q.Username = "root"
            q.WorkingDirectory = "/"
            q.Description = "由 deploy/automation 同步，权威源见仓库"
            r = cl.CreateCommand(q)
            print(f"  CREATE {name} -> {r.CommandId}")
        elif existing.get(name, (None, None))[1] != sha:
            q = models.ModifyCommandRequest()
            q.CommandId = cid
            q.CommandType = "SHELL"
            q.Content = content
            q.Timeout = timeout
            cl.ModifyCommand(q)
            print(f"  UPDATE {name} ({cid})")
        else:
            print(f"  SKIP   {name}（内容一致）")
    print("\n命令同步完成。定时触发器请按 README 表格在控制台配置或核对。")
    print_invokers(args.include_geo)


if __name__ == "__main__":
    main()
