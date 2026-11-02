#!/usr/bin/env python3
"""MakerWorld 多色换料分析（skill 版）。

用 Playwright 打开 MakerWorld 模型页（站点有 Cloudflare，直接抓 HTML 会 403），
注入本 skill 附带的用户脚本，读取 window.__MWCA__.state.res，输出 Markdown 报告。

用法:
  python3 mw_analyze.py "https://makerworld.com.cn/zh/models/<id>-..." --slots 4
  python3 mw_analyze.py "<url>" --slots 8 --scope all
  python3 mw_analyze.py "<url>" --ignore-over      # 排除颜色数 > 槽数的盘（分件版）
  python3 mw_analyze.py "<url>" --json             # 输出结构化 JSON
"""

import argparse
import json
import os
import re
import sys
import time

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
USERSCRIPT_PATH = os.path.join(SKILL_DIR, "assets", "makerworld-ams-planner.user.js")

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


def fmt_g(g):
    try:
        g = float(g)
    except (TypeError, ValueError):
        return "0 g"
    if g >= 100:
        return f"{round(g)} g"
    if g >= 10:
        return f"{g:.0f} g"
    return f"{g:.1f} g"


def fmt_t(sec):
    try:
        sec = float(sec)
    except (TypeError, ValueError):
        return "—"
    if sec <= 0:
        return "—"
    if sec < 5400:
        return f"{round(sec / 60)} min"
    return f"{sec / 3600:.1f} h"


def profile_id_from_url(url):
    m = re.search(r"profileId-(\d+)", url) or re.search(r"profileId=(\d+)", url)
    return int(m.group(1)) if m else 0


def read_userscript():
    with open(USERSCRIPT_PATH, "r", encoding="utf-8") as f:
        return f.read()


def collect_state(url, slots=4, scope="auto", ignore_over=False, timeout=120, headed=True):
    """打开页面 -> 注入用户脚本 -> 读取分析状态。"""
    from playwright.sync_api import sync_playwright

    script = read_userscript()
    pid = profile_id_from_url(url)
    if scope == "auto" and pid:
        scope = f"inst:{pid}" if False else scope  # auto 由脚本自己按 URL 判断

    with sync_playwright() as p:
        browser = p.chromium.launch(
            channel="chrome",
            headless=not headed,
            args=["--disable-blink-features=AutomationControlled", "--no-first-run"],
        )
        ctx = browser.new_context(locale="zh-CN", viewport={"width": 1440, "height": 900}, user_agent=UA)
        page = ctx.new_page()
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=int(timeout * 1000))
            deadline = time.time() + timeout
            # 1) 等 Cloudflare 验证页过去
            while time.time() < deadline:
                page.wait_for_timeout(800)
                title = page.title() or ""
                if "请稍候" not in title and "Just a moment" not in title:
                    break
            # 2) 等设计数据出现
            ready = False
            while time.time() < deadline:
                ready = page.evaluate(
                    """() => {
                        const el = document.getElementById('__NEXT_DATA__');
                        if (!el) return false;
                        try {
                            const j = JSON.parse(el.textContent);
                            const d = j && j.props && j.props.pageProps && j.props.pageProps.design;
                            return !!(d && Array.isArray(d.instances) && d.instances.length);
                        } catch (e) { return false; }
                    }"""
                )
                if ready:
                    break
                page.wait_for_timeout(600)
            if not ready:
                raise RuntimeError("页面没有加载出打印配置数据（可能被 Cloudflare 挡住或链接不是模型详情页）")

            # 3) 写入设置并注入用户脚本
            page.evaluate(
                """({slots, ignoreOver}) => {
                    try {
                        localStorage.setItem('mwca:slots', String(slots));
                        localStorage.setItem('mwca:ignoreOver', ignoreOver ? 'true' : 'false');
                    } catch (e) {}
                }""",
                {"slots": slots, "ignoreOver": bool(ignore_over)},
            )
            page.evaluate(script)
            # 4) 等分析结果
            state = None
            while time.time() < deadline:
                state = page.evaluate(
                    """() => {
                        const st = window.__MWCA__ && window.__MWCA__.state;
                        if (!st || !st.res) return null;
                        const r = st.res;
                        const host = document.getElementById('mwca-host');
                        const sr = host && host.shadowRoot;
                        const q = (sel) => (sr && sr.querySelector(sel) ? sr.querySelector(sel).textContent.trim() : '');
                        return {
                            designTitle: st.design ? st.design.title : '',
                            instances: st.design ? st.design.instances.map(i => ({id: i.id, title: i.title, plates: i.plates.length})) : [],
                            scope: st.scope || 'auto',
                            res: {
                                n: r.n, C: r.C, span: r.span, slots: r.slots,
                                maxPlateColors: r.maxPlateColors, exact: r.exact,
                                grams: r.grams, secs: r.secs,
                                colors: r.colors.map(c => ({disp: c.disp, hex: c.hex, mat: c.mat, plateCount: c.plateCount, grams: c.grams})),
                                plates: r.plates.map(pl => ({name: pl.name, grams: pl.grams, secs: pl.secs, cols: pl.cols})),
                                plan: r.plan ? {
                                    mounts: r.plan.mounts, ejects: r.plan.ejects, reloads: r.plan.reloads,
                                    steps: r.plan.steps.map(s => ({name: s.plate.name, grams: s.plate.grams, secs: s.plate.secs, cols: s.plate.cols, insert: s.insert, eject: s.eject}))
                                } : null
                            },
                            panel: {scope: q('.scope'), warn: q('.warn'), meta: sr ? Array.from(sr.querySelectorAll('.meta span')).map(e => e.textContent) : []}
                        };
                    }"""
                )
                if state:
                    break
                page.wait_for_timeout(600)
            if not state:
                raise RuntimeError("用户脚本没有产生分析结果（页面结构可能已变化）")
            return state
        finally:
            ctx.close()
            browser.close()


def ops_text(step, colors):
    parts = []
    ins = list(step.get("insert") or [])
    ejs = list(step.get("eject") or [])
    while ins:
        c = ins.pop(0)
        e = ejs.pop(0) if ejs else None
        if e is None:
            parts.append(f"装 {colors[c]['disp']}")
        else:
            parts.append(f"换 {colors[e]['disp']}→{colors[c]['disp']}")
    for e in ejs:
        parts.append(f"取 {colors[e]['disp']}")
    return "；".join(parts) if parts else "—"


def render_markdown(state):
    r = state["res"]
    colors = r["colors"]
    lines = []
    lines.append(f"**模型**：{state['designTitle']}")
    if state.get("panel", {}).get("scope"):
        lines.append(f"**范围**：{state['panel']['scope']}")
    if r["plan"]:
        lines.append(
            f"**总览**：{r['n']} 盘 / {r['C']} 色 / AMS {r['slots']} 槽 / "
            f"装料 {r['plan']['mounts']} 次 / 换料 {r['plan']['ejects']} 次 / "
            f"净重 {fmt_g(r['grams'])} / 预计 {fmt_t(r['secs'])} / 最少需 {r['span']} 槽"
        )
    else:
        lines.append(
            f"**总览**：{r['n']} 盘 / {r['C']} 色 / AMS {r['slots']} 槽 / "
            f"净重 {fmt_g(r['grams'])} / 预计 {fmt_t(r['secs'])} / 最少需 {r['span']} 槽"
        )
    warn = (state.get("panel", {}) or {}).get("warn")
    if warn:
        lines.append("")
        lines.append(f"**提示**：{warn}")

    lines.append("")
    lines.append("### 颜色清单")
    lines.append("| 颜色 | HEX | 材料 | 出现盘数 | 克数 |")
    lines.append("|---|---|---|---|---|")
    for c in colors:
        lines.append(f"| {c['disp']} | {c['hex']} | {c['mat']} | {c['plateCount']} | {fmt_g(c['grams'])} |")

    lines.append("")
    if r["plan"]:
        lines.append("### 推荐打印顺序")
        lines.append("| # | 盘 | 耗时 | 克数 | 颜色 | 开打前操作 |")
        lines.append("|---|---|---|---|---|---|")
        for i, s in enumerate(r["plan"]["steps"], 1):
            cs = "+".join(colors[ci]["disp"] for ci in s["cols"])
            lines.append(
                f"| {i} | {s['name']} | {fmt_t(s['secs'])} | {fmt_g(s['grams'])} | {cs} | {ops_text(s, colors)} |"
            )
    else:
        lines.append("### 各盘颜色与耗时")
        lines.append("| 盘 | 耗时 | 克数 | 颜色 |")
        lines.append("|---|---|---|---|")
        for pl in r["plates"]:
            cs = "+".join(colors[ci]["disp"] for ci in pl["cols"])
            lines.append(f"| {pl['name']} | {fmt_t(pl['secs'])} | {fmt_g(pl['grams'])} | {cs} |")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description="MakerWorld 多色换料分析（skill 版）")
    ap.add_argument("url", help="MakerWorld 模型页 URL")
    ap.add_argument("--slots", type=int, default=4, help="AMS 料位数，默认 4")
    ap.add_argument("--scope", default="auto", help="auto / all / inst:<id>")
    ap.add_argument("--ignore-over", action="store_true", help="排除颜色数超过槽数的盘")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument("--headless", action="store_true", help="无头模式（默认有头，Cloudflare 更容易过）")
    ap.add_argument("--timeout", type=int, default=120, help="秒")
    args = ap.parse_args()

    if not os.path.exists(USERSCRIPT_PATH):
        sys.exit(f"缺少用户脚本：{USERSCRIPT_PATH}")

    try:
        state = collect_state(
            args.url,
            slots=max(1, min(16, args.slots)),
            scope=args.scope,
            ignore_over=args.ignore_over,
            timeout=args.timeout,
            headed=not args.headless,
        )
    except Exception as e:  # noqa: BLE001
        sys.exit(f"分析失败：{e}")

    if args.json:
        print(json.dumps(state, ensure_ascii=False, indent=1))
    else:
        print(render_markdown(state))


if __name__ == "__main__":
    main()
