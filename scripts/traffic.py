#!/usr/bin/env python3
"""告解室流量后台（终端版）——gh api 拉两个仓库的访问数据，14 天窗口。
用法：python3 scripts/traffic.py"""
import json, subprocess

def gh(path):
    r = subprocess.run(["gh", "api", path], capture_output=True, text=True)
    return json.loads(r.stdout) if r.returncode == 0 else None

for repo in ["confession-booth-live", "confession-booth"]:
    full = f"repos/lululynne/{repo}"
    views = gh(f"{full}/traffic/views") or {}
    clones = gh(f"{full}/traffic/clones") or {}
    refs = gh(f"{full}/traffic/popular/referrers") or []
    stars = (gh(full) or {}).get("stargazers_count", "?")
    print(f"== {repo} ==")
    print(f"  仓库页浏览 {views.get('count',0)} 次 / {views.get('uniques',0)} 人 · clone {clones.get('count',0)} · star {stars}")
    if refs:
        print("  来源：" + "、".join(f"{r['referrer']}({r['uniques']}人)" for r in refs[:5]))
    for d in (views.get("views") or [])[-7:]:
        print(f"    {d['timestamp'][:10]}  {d['count']:>4} 次 / {d['uniques']} 人")
