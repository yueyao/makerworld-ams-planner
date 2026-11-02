---
name: makerworld-ams-planner
description: 分析 MakerWorld 模型页的多色打印需求：统计所有打印盘用到的颜色（区分 PLA/PETG）、计算最少装料/换料次数、给出推荐打印顺序与每盘耗时。当用户贴 makerworld.com.cn 或 makerworld.com 的模型链接，询问颜色、耗材、AMS 料位够不够、换料次数、多盘/多配置怎么打时使用。
whenToUse: 用户给出 MakerWorld 模型链接并问“几个颜色/要换几次料/AMS 怎么安排/打印顺序/这个模型多色好不好打”，或要求对比同一模型的多个打印配置时。
---

# MakerWorld 多色换料分析

把 MakerWorld 模型页里的打印配置数据变成一份可执行的换料报告：**几种颜色、装几次料、换几次料、按什么顺序打、每盘多久**。

## 工作流程

1. 确认链接是模型详情页：`/models/<数字id>`（`makerworld.com.cn` 或 `makerworld.com` 都可以）。不是模型页（搜索页/合集页）就没数据。
2. 运行分析脚本（`resourceBase.path` 是本 skill 目录）：

   ```bash
   python3 "<skill目录>/scripts/mw_analyze.py" "<模型URL>" --slots 4
   ```

   常用参数：
   - `--slots N`：AMS 料位数。一台 AMS 2 Pro = 4，两台 = 8；默认 4。
   - `--ignore-over`：某盘颜色数超过槽数时，排除该盘再算。很多作者会把「AMS 一体打印版」和「分件单色版」放进同一个打印配置，这时用它看分件版的换料数。
   - `--scope all`：把页面里所有打印配置合并统计（默认 `auto`：一套多模型合集会合并，同一模型的多个备选配置只看链接指向的那个）。
   - `--scope inst:<id>`：只看指定打印配置。
   - `--json`：输出结构化数据，便于二次处理。
   - `--headless`：无头模式；默认有头（Cloudflare 更容易过），会短暂弹出 Chrome 窗口。

3. 把脚本输出的 Markdown 报告整理给用户。报告已包含总览、颜色清单、打印顺序（含耗时/克数/开打前换料动作）、以及“打不了/超槽盘”等警告。
4. 用户若想自己在浏览器里边看边点，指向用户脚本仓库：<https://github.com/yueyao/makerworld-ams-planner>（Tampermonkey 安装后模型页右下角出面板）。

## 脚本怎么工作

- 用 Playwright + 本机 Chrome 打开页面（MakerWorld 有 Cloudflare，直接抓 HTML 会 403）；
- 把本 skill 附带的 `assets/makerworld-ams-planner.user.js` 注入页面；用户脚本 v1.3 起默认只显示悬浮按钮、不自动分析，所以脚本会调用 `window.__MWCA__.open()` 展开面板，再读取 `window.__MWCA__.state.res`；
- Python 只负责格式化成 Markdown，换料算法与用户脚本完全一致（子集 DP 求最小同时在机颜色数 + 局部搜索排序 + 贪心换料模拟）。

## 关键口径（汇报时带上）

- **装料次数下限 = 颜色种类数**；**换料次数下限 = max(0, 颜色数 − 槽数)**。
- 只有存在一种顺序让“任何时刻同时在机颜色数 ≤ 槽数”时，才能做到每个颜色只上机一次。
- 某盘颜色数 > 槽数时，这一盘本身打不了，要么加槽位、要么换“分件/单色”打法（`--ignore-over`）。
- 净重是模型耗材，**不含多色擦料**；实际备料建议 ×1.3~1.5。
- 耗时是作者打印配置里的预测值，不是本机切片结果；换机器/层高/喷嘴会有出入。
- 颜色中文名是按 HEX 推的近似名（如 浅蓝/深棕/米色），对色以 HEX 为准。

## 排错

- `分析失败：页面没有加载出打印配置数据` → 可能被 Cloudflare 拦住或链接不是模型页；重试一次（有头模式），或让用户把页面 `__NEXT_DATA__` 内容/截图发来。
- 缺 Playwright：`pip install playwright && python3 -m playwright install chromium`（本机已装）。
- 页面结构改版导致用户脚本失效时，先更新仓库里的 `.user.js`，再同步到本 skill 的 `assets/`。
