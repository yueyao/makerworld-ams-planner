// ==UserScript==
// @name         MakerWorld 多色分析（颜色清单 + 最少换料）
// @namespace    https://github.com/yueyao/makerworld-ams-planner
// @homepageURL  https://github.com/yueyao/makerworld-ams-planner
// @supportURL   https://github.com/yueyao/makerworld-ams-planner/issues
// @downloadURL  https://raw.githubusercontent.com/yueyao/makerworld-ams-planner/main/makerworld-ams-planner.user.js
// @updateURL    https://raw.githubusercontent.com/yueyao/makerworld-ams-planner/main/makerworld-ams-planner.user.js
// @version      1.2.0
// @description  打开 MakerWorld 模型页时，自动读取页面自带的打印配置数据，统计所有打印盘的耗材颜色，计算最少装料/换料次数，并给出推荐打印顺序与每盘耗时。支持排除“超槽（AMS 版）”盘后按分件版重算。
// @author       Bo He
// @match        https://makerworld.com.cn/*
// @match        https://*.makerworld.com.cn/*
// @match        https://makerworld.com/*
// @match        https://*.makerworld.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * 数据来源：页面的 <script id="__NEXT_DATA__"> 里 props.pageProps.design，
 * 以及页面自身的 /api/v1/design-service/design/<id> 接口（SPA 站内跳转时兜底）。
 * 不需要登录、不额外请求第三方、不修改页面数据。
 */

(function () {
  'use strict';

  if (window.__MWCA_LOADED__) return;
  window.__MWCA_LOADED__ = true;

  /* ============================ 基础工具 ============================ */

  var HOST_ID = 'mwca-host';
  var LS_PREFIX = 'mwca:';

  var store = {
    get: function (k, d) {
      try {
        var v = localStorage.getItem(LS_PREFIX + k);
        return v == null ? d : JSON.parse(v);
      } catch (e) { return d; }
    },
    set: function (k, v) {
      try { localStorage.setItem(LS_PREFIX + k, JSON.stringify(v)); } catch (e) {}
    }
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtG(g) {
    if (!isFinite(g) || g <= 0) return '0 g';
    if (g >= 100) return Math.round(g) + ' g';
    if (g >= 10) return g.toFixed(0) + ' g';
    return g.toFixed(1) + ' g';
  }

  function fmtT(sec) {
    if (!isFinite(sec) || sec <= 0) return '—';
    if (sec < 5400) return Math.round(sec / 60) + ' min';
    return (sec / 3600).toFixed(1) + ' h';
  }

  /* ============================ 颜色命名 ============================ */

  // 常见 3MF 设定色
  var KNOWN_COLORS = {
    '#00FF00': '绿', '#FF0000': '红', '#F4EE2A': '黄', '#EC008C': '玫红',
    '#FF9016': '橙', '#8080FF': '蓝紫', '#FFFFFF': '白', '#6F5034': '棕',
    '#000000': '黑', '#F55A74': '桃粉'
  };

  function hexToRgb(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    var n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function colorName(hex) {
    hex = String(hex || '').toUpperCase();
    if (KNOWN_COLORS[hex]) return KNOWN_COLORS[hex];
    var rgb = hexToRgb(hex);
    if (!rgb) return '未知';
    var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var l = (max + min) / 2;
    var d = max - min;
    var s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    var h = 0;
    if (d !== 0) {
      if (max === r) h = 60 * (((g - b) / d) % 6);
      else if (max === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
      if (h < 0) h += 360;
    }
    if (s < 0.12) return l > 0.88 ? '白' : l < 0.14 ? '黑' : '灰';
    if (s < 0.45 && l > 0.55 && h >= 25 && h <= 70) return '米色';
    if (l < 0.22) {
      if (h < 20 || h >= 340) return '深红';
      if (h < 45) return '棕';
      if (h < 70) return '深黄';
      if (h < 160) return '深绿';
      if (h < 260) return '深蓝';
      return '深紫';
    }
    var base;
    if (h < 15 || h >= 345) base = l > 0.62 ? '粉' : '红';
    else if (h < 40) base = l < 0.45 ? '棕' : '橙';
    else if (h < 68) base = '黄';
    else if (h < 95) base = '黄绿';
    else if (h < 155) base = '绿';
    else if (h < 190) base = '青';
    else if (h < 240) base = '蓝';
    else if (h < 265) base = '蓝紫';
    else if (h < 300) base = '紫';
    else if (h < 330) base = '玫红';
    else base = l > 0.6 ? '粉' : '红';
    if (l >= 0.55 && base !== '白') base = '浅' + base;
    else if (l <= 0.3) base = '深' + base;
    return base;
  }

  /* ============================ 数据读取 ============================ */

  function currentModelId() {
    var m = /\/models\/(\d+)/.exec(location.pathname);
    return m ? m[1] : null;
  }

  function currentProfileId() {
    var m = /profileId-(\d+)/.exec(location.hash || '');
    return m ? Number(m[1]) : 0;
  }

  function readPageDesign() {
    var el = document.getElementById('__NEXT_DATA__');
    if (!el) return null;
    try {
      var j = JSON.parse(el.textContent || '{}');
      var d = j && j.props && j.props.pageProps && j.props.pageProps.design;
      return d && Array.isArray(d.instances) ? d : null;
    } catch (e) { return null; }
  }

  var designCache = new Map();

  function fetchDesign(id) {
    if (designCache.has(id)) return Promise.resolve(designCache.get(id));
    return fetch('/api/v1/design-service/design/' + id, {
      credentials: 'include',
      headers: { accept: 'application/json' }
    }).then(function (r) {
      if (!r.ok) return null;
      return r.json().then(function (j) {
        if (j && Array.isArray(j.instances)) { designCache.set(id, j); return j; }
        return null;
      });
    }).catch(function () { return null; });
  }

  /*
   * 把接口原始结构整理成：
   * { id, title, instances:[{ id, title, isDefault, plates:[{ index, mats:[{hex,mat,g}], grams, secs, thumb }] }] }
   */
  function normalizeDesign(d) {
    var instances = [];
    (d.instances || []).forEach(function (inst) {
      var mi = inst && inst.extention && inst.extention.modelInfo;
      if (!mi || !Array.isArray(mi.plates)) return;
      var plates = [];
      mi.plates.forEach(function (p, k) {
        var mats = [];
        var sum = 0;
        (p.filaments || []).forEach(function (f) {
          var hex = String((f && f.color) || '').toUpperCase();
          if (!/^#[0-9A-F]{6}$/.test(hex)) return;
          var g = parseFloat(f.usedG);
          if (!isFinite(g)) g = 0;
          mats.push({ hex: hex, mat: String(f.type || 'PLA').toUpperCase(), g: g });
          sum += g;
        });
        if (!mats.length) return;
        var w = parseFloat(p.weight);
        plates.push({
          index: p.index || k + 1,
          mats: mats,
          grams: isFinite(w) && w > 0 ? w : sum,
          secs: parseFloat(p.prediction) || 0,
          thumb: (p.thumbnail && p.thumbnail.url) || (p.top_picture && p.top_picture.url) || ''
        });
      });
      if (!plates.length) return;
      instances.push({
        id: inst.id,
        title: String(inst.title || '').trim() || ('配置 ' + inst.id),
        isDefault: inst.id === d.defaultInstanceId,
        plates: plates
      });
    });
    return { id: d.id, title: String(d.title || '').trim(), defaultInstanceId: d.defaultInstanceId, instances: instances };
  }

  function buildPlates(design, instances) {
    var plates = [];
    instances.forEach(function (inst) {
      inst.plates.forEach(function (p) {
        plates.push({
          name: inst.plates.length > 1
            ? (looksLikeSettingsTitle(inst.title) ? ('盘 ' + p.index) : (inst.title + ' #' + p.index))
            : inst.title,
          instId: inst.id,
          mats: p.mats,
          grams: p.grams,
          secs: p.secs
        });
      });
    });
    return { title: design.title, instances: instances, plates: plates };
  }

  function plateColorCount(p) {
    var s = new Set();
    for (var i = 0; i < p.mats.length; i++) s.add(p.mats[i].mat + '|' + p.mats[i].hex);
    return s.size;
  }

  function looksLikeSettingsTitle(t) {
    return /(层高|填充|墙|喷嘴|速度|精度|mm|ams|一体|分件|版本|预设|profile)/i.test(String(t || ''));
  }

  // 多个配置、每个只有 1 盘、名字是不同模型名 → 当成一套模型合集（比如 13 个水果）
  function looksLikeCollection(insts) {
    if (insts.length < 2) return false;
    var seen = new Set();
    for (var i = 0; i < insts.length; i++) {
      var x = insts[i];
      if (x.plates.length !== 1) return false;
      if (seen.has(x.title)) return false;
      if (looksLikeSettingsTitle(x.title)) return false;
      seen.add(x.title);
    }
    return true;
  }

  function pickInstance(insts) {
    var pid = currentProfileId();
    return insts.filter(function (x) { return x.id === pid; })[0] ||
           insts.filter(function (x) { return x.isDefault; })[0] ||
           insts[0];
  }

  function resolveScope(design, scope) {
    var insts = design.instances;
    if (!insts.length) return null;
    if (scope === 'all') return buildPlates(design, insts);
    if (scope && String(scope).indexOf('inst:') === 0) {
      var id = Number(String(scope).slice(5));
      var one = insts.filter(function (x) { return x.id === id; })[0];
      if (one) return buildPlates(design, [one]);
    }
    // auto：像“一套模型合集”就全量统计；否则只看链接指向/默认的那个配置
    if (looksLikeCollection(insts)) return buildPlates(design, insts);
    return buildPlates(design, [pickInstance(insts)]);
  }

  /* ============================ 排程计算 ============================ */

  /*
   * 统计颜色 + 求“同色只上机一次”的打印顺序。
   * 判定条件：在打印顺序的每个切点上，横跨切点的颜色数（同时需要挂在机上的颜色）≤ 槽数。
   * 盘数 ≤ 16 时用子集 DP 求精确最优（等价于路径宽度），否则用启发式。
   */
  function analyze(plates, slots) {
    var colorMap = new Map();
    var colors = [];

    plates.forEach(function (p) {
      var set = new Set();
      p.mats.forEach(function (m) {
        var key = m.mat + '|' + m.hex;
        var c = colorMap.get(key);
        if (!c) {
          c = {
            key: key, hex: m.hex, mat: m.mat, name: colorName(m.hex),
            idx: colors.length, grams: 0, plateCount: 0, plateNames: []
          };
          colorMap.set(key, c);
          colors.push(c);
        }
        c.grams += m.g;
        set.add(c.idx);
      });
      p.cols = Array.from(set);
      p.gramsPerColor = p.mats;
    });

    plates.forEach(function (p) {
      p.cols.forEach(function (ci) {
        var c = colors[ci];
        c.plateCount += 1;
        if (c.plateNames.indexOf(p.name) < 0) c.plateNames.push(p.name);
      });
    });

    // 按出现盘数排序，同时把 idx 重映射
    colors.sort(function (a, b) {
      return (b.plateCount - a.plateCount) || (b.grams - a.grams) || a.hex.localeCompare(b.hex);
    });
    var remap = new Map();
    colors.forEach(function (c, i) { remap.set(c.idx, i); c.idx = i; });
    plates.forEach(function (p) { p.cols = p.cols.map(function (ci) { return remap.get(ci); }).sort(function (a, b) { return a - b; }); });

    // 显示名去重
    var used = new Map();
    colors.forEach(function (c) {
      var base = c.name + (c.mat && c.mat !== 'PLA' ? '·' + c.mat : '');
      var n = used.get(base) || 0;
      used.set(base, n + 1);
      c.disp = n === 0 ? base : base + '·' + c.hex.slice(1, 4);
    });

    var n = plates.length;
    var C = colors.length;
    var maxPlateColors = plates.reduce(function (m, p) { return Math.max(m, p.cols.length); }, 0);
    var orderInfo = n <= 16 ? exactOrder(plates, C) : greedyOrder(plates, C);
    var span = orderInfo.span;
    // 在最省换料的前提下，把颜色相近的盘排在一起，让顺序更好执行
    orderInfo.order = refineOrder(orderInfo.order, plates, C, Math.max(slots, span));
    var plan = null;
    if (maxPlateColors <= slots) {
      plan = buildPlan(plates, orderInfo.order, slots, colors);
    }

    return {
      colors: colors,
      plates: plates,
      n: n,
      C: C,
      slots: slots,
      maxPlateColors: maxPlateColors,
      span: span,
      order: orderInfo.order,
      exact: orderInfo.exact,
      plan: plan,
      grams: plates.reduce(function (a, p) { return a + (p.grams || 0); }, 0),
      secs: plates.reduce(function (a, p) { return a + (p.secs || 0); }, 0)
    };
  }

  function exactOrder(plates, C) {
    var n = plates.length;
    var size = 1 << n;
    var full = size - 1;
    var colorMasks = new Array(C).fill(0);
    var plateMasks = new Array(n).fill(0);
    plates.forEach(function (p, i) {
      p.cols.forEach(function (c) {
        colorMasks[c] |= (1 << i);
        plateMasks[i] |= (1 << c);
      });
    });

    // 切点之后还要继续占着槽的颜色数
    var span = new Uint8Array(size);
    for (var S = 1; S < size; S++) {
      var invS = full ^ S;
      var cnt = 0;
      for (var c = 0; c < C; c++) {
        var m = colorMasks[c];
        if ((m & S) && (m & invS)) cnt++;
      }
      span[S] = cnt;
    }

    // dp[S] = 按某个顺序打完集合 S 时，“同时在机”颜色数的最大值的最小值。
    // 在盘 pos 开打那一刻，机上要有：跨过切点的颜色 + 这盘里“打完就不再出现”的颜色。
    var INF = 255;
    var best = new Uint8Array(size).fill(INF);
    var pick = new Int8Array(size).fill(-1);
    best[0] = 0;
    for (var s = 1; s < size; s++) {
      var sp = span[s];
      var outS = full ^ s;
      var bv = INF, bp = -1;
      for (var v = 0; v < n; v++) {
        if (!(s & (1 << v))) continue;
        var prev = s ^ (1 << v);
        var pm = plateMasks[v];
        var dead = 0;
        for (var cc = 0; cc < C; cc++) {
          if (!(pm & (1 << cc))) continue;
          if (!(colorMasks[cc] & outS)) dead++;
        }
        var val = Math.max(best[prev], sp + dead);
        if (val < bv) { bv = val; bp = v; }
      }
      best[s] = bv; pick[s] = bp;
    }

    var order = [];
    var cur = full;
    while (cur) {
      var v = pick[cur];
      order.push(v);
      cur = cur ^ (1 << v);
    }
    order.reverse();
    return { order: order, span: best[full], exact: true };
  }

  function measureSpan(order, plates, C) {
    var first = new Array(C).fill(Infinity);
    var last = new Array(C).fill(-1);
    order.forEach(function (pi, pos) {
      plates[pi].cols.forEach(function (c) {
        if (pos < first[c]) first[c] = pos;
        if (pos > last[c]) last[c] = pos;
      });
    });
    var max = 0;
    for (var pos = 0; pos < order.length; pos++) {
      var cnt = 0;
      for (var c = 0; c < C; c++) if (first[c] <= pos && last[c] >= pos) cnt++;
      if (cnt > max) max = cnt;
    }
    return max;
  }

  function greedyOrder(plates, C) {
    var n = plates.length;
    var step = Math.max(1, Math.ceil(n / 48));
    var starts = [];
    for (var i = 0; i < n; i += step) starts.push(i);
    if (starts[starts.length - 1] !== n - 1) starts.push(n - 1);

    var best = null;
    starts.forEach(function (s) {
      var order = [s];
      var used = new Set([s]);
      while (order.length < n) {
        var active = new Set(plates[order[order.length - 1]].cols);
        var bestP = -1, bestScore = Infinity;
        for (var j = 0; j < n; j++) {
          if (used.has(j)) continue;
          var cols = plates[j].cols;
          var overlap = 0, news = 0;
          for (var k = 0; k < cols.length; k++) {
            if (active.has(cols[k])) overlap++; else news++;
          }
          var score = news * 10 - overlap * 2 - cols.length * 0.01;
          if (score < bestScore) { bestScore = score; bestP = j; }
        }
        order.push(bestP);
        used.add(bestP);
      }
      var span = measureSpan(order, plates, C);
      if (!best || span < best.span) best = { order: order, span: span, exact: false };
    });
    if (!best) {
      var ord = plates.map(function (_, i) { return i; });
      best = { order: ord, span: measureSpan(ord, plates, C), exact: false };
    }
    return best;
  }

  /*
   * 按顺序生成每一步要装/换哪些料。
   * 优先换掉“以后再也不用的颜色”；实在没有才换掉“下次用得最远的颜色”（会产生重装）。
   */
  // 固定种子的伪随机，保证同一页面每次渲染出的顺序一致
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 相邻两盘共用的颜色数 + 材料是否一致，用来衡量顺序“顺不顺”
  function materialSig(p) {
    var s = new Set();
    for (var i = 0; i < p.mats.length; i++) s.add(p.mats[i].mat);
    return Array.from(s).sort().join('+');
  }

  function orderScore(order, plates) {
    var s = 0;
    for (var i = 1; i < order.length; i++) {
      var a = plates[order[i - 1]];
      var b = plates[order[i]];
      for (var k = 0; k < a.cols.length; k++) if (b.cols.indexOf(a.cols[k]) >= 0) s += 10;
      if (materialSig(a) === materialSig(b)) s += 2;
    }
    return s;
  }

  // 在不突破 maxSpan 的前提下，做局部搜索：让颜色相近的盘尽量相邻
  function refineOrder(order, plates, C, maxSpan) {
    var n = order.length;
    if (n < 4) return order.slice();
    var rnd = mulberry32(0x9E3779B1 ^ (n * 131) ^ (C * 17));
    var cur = order.slice();
    var curScore = orderScore(cur, plates);
    var best = cur.slice();
    var bestScore = curScore;
    var iterations = Math.min(6000, n * n * 30);

    for (var it = 0; it < iterations; it++) {
      var i = 1 + Math.floor(rnd() * (n - 1));
      var j = 1 + Math.floor(rnd() * (n - 1));
      if (i === j) continue;
      var t = cur[i]; cur[i] = cur[j]; cur[j] = t;
      if (measureSpan(cur, plates, C) <= maxSpan) {
        var sc = orderScore(cur, plates);
        if (sc >= curScore) {
          curScore = sc;
          if (sc > bestScore) { bestScore = sc; best = cur.slice(); }
          continue;
        }
      }
      t = cur[i]; cur[i] = cur[j]; cur[j] = t;
    }
    return best;
  }

  function buildPlan(plates, order, slots, colors) {
    var loaded = new Set();
    var steps = [];
    var mounts = 0, ejects = 0, reloads = 0, impossible = false;

    var lastPos = new Map();
    order.forEach(function (pi, pos) {
      plates[pi].cols.forEach(function (c) { lastPos.set(c, pos); });
    });

    var countOf = function (c) { return colors && colors[c] ? colors[c].plateCount : 0; };
    var gramsOf = function (c) { return colors && colors[c] ? colors[c].grams : 0; };

    for (var pos = 0; pos < order.length; pos++) {
      var p = plates[order[pos]];
      var need = new Set(p.cols);
      var ej = [], ins = [];

      for (var ki = 0; ki < p.cols.length; ki++) {
        var c = p.cols[ki];
        if (loaded.has(c)) continue;
        if (loaded.size >= slots) {
          var dead = Array.from(loaded).filter(function (x) {
            return !need.has(x) && lastPos.get(x) < pos;
          });
          if (dead.length) {
            // 优先撤掉用得最少的颜色，好让常用色留到最后
            dead.sort(function (a, b) {
              return (countOf(a) - countOf(b)) || (gramsOf(a) - gramsOf(b)) || (a - b);
            });
          } else {
            var nextUse = function (x) {
              for (var k = pos + 1; k < order.length; k++) {
                if (plates[order[k]].cols.indexOf(x) >= 0) return k;
              }
              return 1e9;
            };
            dead = Array.from(loaded).filter(function (x) { return !need.has(x); });
            dead.sort(function (a, b) { return nextUse(b) - nextUse(a); });
          }
          if (!dead.length) { impossible = true; break; }
          var ev = dead[0];
          loaded.delete(ev);
          ejects++;
          ej.push(ev);
          if (lastPos.get(ev) >= pos) reloads++;
        }
        loaded.add(c);
        mounts++;
        ins.push(c);
      }

      steps.push({ plate: p, pos: pos, eject: ej, insert: ins });
      if (impossible) break;
    }

    return { steps: steps, mounts: mounts, ejects: ejects, reloads: reloads, impossible: impossible };
  }

  function opsText(step, res) {
    var parts = [];
    var ins = step.insert.slice();
    var ej = step.eject.slice();
    while (ins.length) {
      var c = ins.shift();
      var e = ej.shift();
      parts.push(e != null ? '换 ' + res.colors[e].disp + '→' + res.colors[c].disp
                           : '装 ' + res.colors[c].disp);
    }
    ej.forEach(function (e) { parts.push('取 ' + res.colors[e].disp); });
    return parts.join('；');
  }

  /* ============================ 面板 UI ============================ */

  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box}',
    '.panel{width:356px;max-width:calc(100vw - 24px);max-height:min(74vh,680px);display:flex;flex-direction:column;',
    'background:#fff;color:#1b1f24;border:1px solid rgba(0,0,0,.1);border-radius:14px;overflow:hidden;',
    'box-shadow:0 12px 34px rgba(0,0,0,.18);font:12px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",system-ui,sans-serif}',
    '.hd{display:flex;align-items:center;gap:6px;padding:8px 10px;background:linear-gradient(90deg,rgba(10,124,255,.14),rgba(0,196,140,.14));cursor:move;user-select:none;flex:none}',
    '.hd .dot{width:9px;height:9px;border-radius:50%;background:linear-gradient(135deg,#0a7cff,#00c48c);flex:none}',
    '.hd b{font-size:12px;font-weight:600}',
    '.hd .sp{flex:1}',
    '.hd button{border:0;background:rgba(0,0,0,.06);color:inherit;border-radius:7px;padding:3px 7px;font-size:11px;cursor:pointer;line-height:1.4}',
    '.hd button:hover{background:rgba(0,0,0,.12)}',
    '.bd{overflow:auto;padding:10px 10px 12px;display:flex;flex-direction:column;gap:8px}',
    '.bd>*{flex:0 0 auto}',
    '.panel.min .bd{display:none}',
    '.ttl{font-size:12px;font-weight:600;line-height:1.35;max-height:2.7em;overflow:hidden}',
    '.scope{font-size:10.5px;opacity:.6}',
    '.sum{display:flex;gap:6px}',
    '.sum div{flex:1;display:flex;flex-direction:column;align-items:center;padding:5px 2px;border-radius:9px;background:rgba(0,0,0,.04)}',
    '.sum b{font-size:15px;line-height:1.15;font-variant-numeric:tabular-nums}',
    '.sum span{font-size:9.5px;opacity:.6}',
    '.sum div.hl{background:rgba(10,124,255,.12)}',
    '.sum div.hl b{color:#0a6fd8}',
    '.meta{font-size:10.5px;opacity:.7;display:flex;gap:10px;flex-wrap:wrap}',
    '.warn{padding:6px 8px;border-radius:8px;font-size:10.8px;line-height:1.45}',
    '.warn.bad{background:rgba(220,38,38,.1);color:#b91c1c}',
    '.warn.mid{background:rgba(217,119,6,.12);color:#b45309}',
    '.sec{font-size:10.5px;font-weight:600;opacity:.55;margin-top:2px}',
    '.chips{display:flex;flex-wrap:wrap;margin:-2px 0 0}',
    '.chip{display:inline-flex;align-items:center;gap:4px;padding:2px 6px;margin:0 4px 4px 0;border-radius:999px;background:rgba(0,0,0,.05);font-size:10.5px;white-space:nowrap}',
    '.chip i{width:10px;height:10px;border-radius:50%;border:1px solid rgba(0,0,0,.18);flex:none}',
    '.chip em{font-style:normal;opacity:.55;font-size:9.5px}',
    '.chip.top{background:rgba(10,124,255,.14)}',
    '.tbl{width:100%;border-collapse:collapse;font-size:10.8px}',
    '.tbl th{text-align:left;font-weight:600;opacity:.5;font-size:9.5px;padding:2px 3px;border-bottom:1px solid rgba(0,0,0,.08)}',
    '.tbl td{padding:3px;border-bottom:1px solid rgba(0,0,0,.05);vertical-align:middle}',
    '.tbl tr:last-child td{border-bottom:0}',
    '.no{width:16px;opacity:.45;font-variant-numeric:tabular-nums}',
    '.nm{max-width:62px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.tm{white-space:nowrap;opacity:.7;font-size:10px;font-variant-numeric:tabular-nums;text-align:right;padding-right:5px}',
    '.dots{white-space:nowrap}',
    '.dots i{display:inline-block;width:9px;height:9px;border-radius:50%;border:1px solid rgba(0,0,0,.18);margin-right:2px;vertical-align:-1px}',
    '.op{font-size:10px;line-height:1.4}',
    '.op .sw{color:#0a6fd8}',
    '.ft{display:flex;align-items:center;gap:6px;font-size:10.5px;flex-wrap:wrap;margin-top:2px}',
    '.ft input{width:44px;padding:2px 4px;border:1px solid rgba(0,0,0,.15);border-radius:6px;background:transparent;color:inherit;font:inherit}',
    '.ft select{max-width:150px;padding:2px 4px;border:1px solid rgba(0,0,0,.15);border-radius:6px;background:transparent;color:inherit;font:inherit}',
    '.ft input[type=checkbox]{width:auto;margin:0}',
    '.ck{display:inline-flex;align-items:center;gap:3px;cursor:pointer;opacity:.85;white-space:nowrap}',
    '.note{font-size:9.8px;opacity:.55;line-height:1.5}',
    '@media (prefers-color-scheme:dark){',
    '.panel{background:#1b1e23;color:#e6e8eb;border-color:rgba(255,255,255,.1);box-shadow:0 12px 34px rgba(0,0,0,.5)}',
    '.hd{background:linear-gradient(90deg,rgba(10,124,255,.22),rgba(0,196,140,.22))}',
    '.hd button{background:rgba(255,255,255,.1)}.hd button:hover{background:rgba(255,255,255,.18)}',
    '.sum div{background:rgba(255,255,255,.07)}',
    '.sum div.hl{background:rgba(10,124,255,.25)}.sum div.hl b{color:#7fb8ff}',
    '.chip{background:rgba(255,255,255,.09)}.chip.top{background:rgba(10,124,255,.28)}',
    '.warn.bad{background:rgba(248,113,113,.14);color:#fca5a5}',
    '.warn.mid{background:rgba(251,191,36,.14);color:#fbbf24}',
    '.tbl th{border-bottom-color:rgba(255,255,255,.12)}',
    '.tbl td{border-bottom-color:rgba(255,255,255,.07)}',
    '.ft input,.ft select{border-color:rgba(255,255,255,.2)}',
    '}'
  ].join('');

  var state = {
    design: null,      // normalizeDesign 结果
    res: null,         // analyze 结果
    scope: store.get('scope', 'auto'),
    slots: Math.max(1, Math.min(16, Math.floor(store.get('slots', 4)))),
    ignoreOver: !!store.get('ignoreOver', false),
    min: store.get('min', false),
    hidden: false,
    lastId: null
  };

  var hostEl = null;
  var shadow = null;

  function ensureHost() {
    if (hostEl && document.documentElement.contains(hostEl)) return;
    hostEl = document.getElementById(HOST_ID);
    if (hostEl) { shadow = hostEl.shadowRoot; return; }
    hostEl = document.createElement('div');
    hostEl.id = HOST_ID;
    hostEl.style.cssText = 'position:fixed;z-index:2147483000;right:16px;bottom:16px;font-size:0;';
    try { shadow = hostEl.attachShadow({ mode: 'open' }); } catch (e) { shadow = null; }
    document.documentElement.appendChild(hostEl);
  }

  function hidePanel() {
    if (hostEl) hostEl.style.display = 'none';
  }

  function showPanel() {
    if (hostEl) hostEl.style.display = '';
  }

  function render() {
    ensureHost();
    if (!shadow) return;
    if (state.hidden || !state.design) { hidePanel(); return; }
    var scopeRes = resolveScope(state.design, state.scope);
    if (!scopeRes || !scopeRes.plates.length) { hidePanel(); return; }

    var allPlates = scopeRes.plates;
    var overPlates = allPlates.filter(function (p) { return plateColorCount(p) > state.slots; });
    var plates = allPlates;
    var excluded = 0;
    if (state.ignoreOver && overPlates.length && allPlates.length > overPlates.length) {
      plates = allPlates.filter(function (p) { return plateColorCount(p) <= state.slots; });
      excluded = overPlates.length;
    }

    var res;
    try { res = analyze(plates, state.slots); }
    catch (e) { hidePanel(); return; }
    state.res = res;

    var scopeLabel;
    var instCount = scopeRes.instances.length;
    if (instCount === state.design.instances.length && instCount > 1) {
      scopeLabel = '全部 ' + instCount + ' 个配置';
      if (!looksLikeCollection(state.design.instances)) scopeLabel += '（可能是备选方案）';
    } else if (instCount === 1) {
      var t = scopeRes.instances[0].title || '';
      scopeLabel = '配置：' + (t.length > 20 ? t.slice(0, 20) + '…' : t);
      if (scopeRes.instances[0].plates.length > 1) scopeLabel += ' · ' + scopeRes.instances[0].plates.length + ' 盘';
    } else {
      scopeLabel = instCount + ' 个配置';
    }

    var optimal = !!(res.plan && !res.plan.impossible && res.plan.reloads === 0);
    var warn = '';
    if (overPlates.length && !excluded) {
      var names = overPlates.slice(0, 3).map(function (p) {
        return '「' + p.name + '」' + plateColorCount(p) + ' 色';
      }).join('、');
      var needSlots = overPlates.reduce(function (m, p) { return Math.max(m, plateColorCount(p)); }, 0);
      warn = '<div class="warn bad">❌ ' + names + ' 超过 ' + state.slots + ' 槽，打不了：这个配置至少要 ' + needSlots +
             ' 槽。若这些盘是“AMS 一体打印”的备选方案，可勾选下面的“忽略超槽盘”，按其余单色/分件盘算。</div>';
    } else if (excluded) {
      var names2 = overPlates.slice(0, 3).map(function (p) {
        return '「' + p.name + '」' + plateColorCount(p) + ' 色';
      }).join('、');
      warn = '<div class="warn mid">已排除 ' + excluded + ' 个超槽盘（' + names2 + '），按剩余 ' + res.n + ' 盘计算。</div>';
    } else if (!optimal) {
      warn = '<div class="warn mid">⚠ 按最优顺序也需要 ' + res.span + ' 个料位同时在机；' + state.slots + ' 槽下会重复上料 ' +
             (res.plan ? res.plan.reloads : '?') + ' 次。想让“每色只上一次”，至少设 ' + res.span + ' 槽。</div>';
    }

    var mounts = res.plan ? res.plan.mounts : '—';
    var ejects = res.plan ? res.plan.ejects : '—';
    var starCount = res.colors.filter(function (c) { return c.plateCount >= Math.max(2, res.n * 0.5); }).length;

    var chips = res.colors.map(function (c) {
      var top = c.plateCount >= Math.max(2, res.n * 0.5) ? ' top' : '';
      var title = c.mat + ' · ' + c.plateCount + ' 盘 · ' + fmtG(c.grams) + ' · ' + c.hex;
      return '<span class="chip' + top + '" title="' + esc(title) + '"><i style="background:' + c.hex + '"></i>' +
             esc(c.disp) + '<em>' + c.plateCount + '</em></span>';
    }).join('');

    var rows = '';
    var cum = 0;
    if (res.plan) {
      res.plan.steps.forEach(function (s, i) {
        var dots = s.plate.cols.map(function (ci) {
          var c = res.colors[ci];
          return '<i style="background:' + c.hex + '" title="' + esc(c.disp) + '"></i>';
        }).join('');
        var ops = opsText(s, res) || '—';
        cum += s.plate.secs || 0;
        rows += '<tr><td class="no">' + (i + 1) + '</td>' +
                '<td class="nm" title="' + esc(s.plate.name + ' · ' + fmtG(s.plate.grams) + ' · ' + fmtT(s.plate.secs)) + '">' + esc(s.plate.name) + '</td>' +
                '<td class="tm" title="累计 ' + esc(fmtT(cum)) + '">' + fmtT(s.plate.secs) + '</td>' +
                '<td class="dots">' + dots + '</td>' +
                '<td class="op">' + esc(ops) + '</td></tr>';
      });
    } else {
      res.plates.forEach(function (p) {
        var dots = p.cols.map(function (ci) {
          var c = res.colors[ci];
          return '<i style="background:' + c.hex + '" title="' + esc(c.disp) + '"></i>';
        }).join('');
        var cc = plateColorCount(p);
        rows += '<tr><td class="no">·</td>' +
                '<td class="nm" title="' + esc(p.name + ' · ' + fmtG(p.grams) + ' · ' + fmtT(p.secs)) + '">' + esc(p.name) + '</td>' +
                '<td class="tm">' + fmtT(p.secs) + '</td>' +
                '<td class="dots">' + dots + '</td>' +
                '<td class="op">' + cc + ' 色 · ' + fmtG(p.grams) + '</td></tr>';
      });
    }

    var tblHead = res.plan
      ? '<tr><th></th><th>盘</th><th>耗时</th><th>色</th><th>操作</th></tr>'
      : '<tr><th></th><th>盘</th><th>耗时</th><th>色</th><th>克数</th></tr>';

    var longest = null;
    res.plates.forEach(function (p) {
      if (!longest || (p.secs || 0) > (longest.secs || 0)) longest = p;
    });

    var ignoreCk = overPlates.length
      ? '<label class="ck" title="把超过槽数的盘排除，按剩下的盘计算（适合分件/单色打印思路）">' +
        '<input type="checkbox" data-role="ignoreOver"' + (state.ignoreOver ? ' checked' : '') + '>忽略 ' + overPlates.length + ' 个超槽盘</label>'
      : '';

    var instOpts = '<option value="auto"' + (state.scope === 'auto' ? ' selected' : '') + '>自动</option>' +
      '<option value="all"' + (state.scope === 'all' ? ' selected' : '') + '>全部配置</option>' +
      state.design.instances.map(function (inst) {
        var v = 'inst:' + inst.id;
        return '<option value="' + v + '"' + (state.scope === v ? ' selected' : '') + '>' + esc(inst.title) + '</option>';
      }).join('');

    var html =
      '<style>' + CSS + '</style>' +
      '<div class="panel' + (state.min ? ' min' : '') + '">' +
        '<div class="hd" data-role="hd">' +
          '<span class="dot"></span><b>多色分析</b><span class="sp"></span>' +
          '<button data-act="copy" title="复制颜色清单和排程到剪贴板">复制</button>' +
          '<button data-act="refresh" title="重新读取页面数据">↻</button>' +
          '<button data-act="min" title="收起/展开">' + (state.min ? '+' : '−') + '</button>' +
        '</div>' +
        '<div class="bd">' +
          '<div class="ttl">' + esc(state.design.title || 'MakerWorld 模型') + '</div>' +
          '<div class="scope">' + esc(scopeLabel) + ' · AMS ' + state.slots + ' 槽' + (starCount ? ' · 常驻色 ' + starCount + ' 个' : '') + '</div>' +
          '<div class="sum">' +
            '<div><b>' + res.n + '</b><span>盘</span></div>' +
            '<div><b>' + res.C + '</b><span>色</span></div>' +
            '<div class="hl"><b>' + mounts + '</b><span>装料</span></div>' +
            '<div class="hl"><b>' + ejects + '</b><span>换料</span></div>' +
          '</div>' +
          '<div class="meta"><span>净重 ' + fmtG(res.grams) + '</span><span>预计 ' + fmtT(res.secs) + '</span>' +
            '<span>最少需 ' + res.span + ' 槽' + (res.span === 1 && res.n > 1 ? '（可不用 AMS）' : '') + '</span>' +
            (longest ? '<span>最长 ' + esc(longest.name) + ' ' + fmtT(longest.secs) + '</span>' : '') +
            (optimal ? '<span>已按最优排程</span>' : '') + '</div>' +
          warn +
          '<div class="sec">颜色清单（按出现盘数）</div>' +
          '<div class="chips">' + chips + '</div>' +
          '<div class="sec">' + (res.plan ? '推荐打印顺序（含每盘耗时）' : '各盘颜色与耗时') + '</div>' +
          '<table class="tbl"><thead>' + tblHead + '</thead><tbody>' + rows + '</tbody></table>' +
          '<div class="ft">槽数 <input data-role="slots" type="number" min="1" max="16" value="' + state.slots + '">' +
            ' 范围 <select data-role="scope">' + instOpts + '</select>' + ignoreCk + '</div>' +
          '<div class="note">换料次数下限 = 颜色数 − 槽数（每色只上机一次即可达到）。净重为模型耗材，不含多色擦料；' +
            '遇到“AMS 一体打印版 + 分件版”都放在一个配置里的情况，用“忽略超槽盘”分别看。</div>' +
        '</div>' +
      '</div>';

    shadow.innerHTML = html;
    showPanel();
    bindEvents();
  }

  function bindEvents() {
    var hd = shadow.querySelector('[data-role="hd"]');
    var copyBtn = shadow.querySelector('[data-act="copy"]');
    var refBtn = shadow.querySelector('[data-act="refresh"]');
    var minBtn = shadow.querySelector('[data-act="min"]');
    var slotsInput = shadow.querySelector('[data-role="slots"]');
    var scopeSel = shadow.querySelector('[data-role="scope"]');

    if (copyBtn) copyBtn.addEventListener('click', function () {
      var txt = buildCopyText();
      if (!txt) return;
      var done = function () { copyBtn.textContent = '已复制'; setTimeout(function () { copyBtn.textContent = '复制'; }, 1200); };
      try {
        navigator.clipboard.writeText(txt).then(done, function () { fallbackCopy(txt); done(); });
      } catch (e) { fallbackCopy(txt); done(); }
    });

    if (refBtn) refBtn.addEventListener('click', function () {
      state.lastId = null;
      designCache.clear();
      tick(true);
    });

    if (minBtn) minBtn.addEventListener('click', function () {
      state.min = !state.min;
      store.set('min', state.min);
      render();
    });

    if (slotsInput) slotsInput.addEventListener('change', function () {
      var v = parseInt(slotsInput.value, 10);
      if (!isFinite(v)) v = 4;
      v = Math.max(1, Math.min(16, v));
      state.slots = v;
      store.set('slots', v);
      render();
    });

    if (scopeSel) scopeSel.addEventListener('change', function () {
      state.scope = scopeSel.value;
      store.set('scope', state.scope);
      render();
    });

    var ignoreCkDb = shadow.querySelector('[data-role="ignoreOver"]');
    if (ignoreCkDb) ignoreCkDb.addEventListener('change', function () {
      state.ignoreOver = !!ignoreCkDb.checked;
      store.set('ignoreOver', state.ignoreOver);
      render();
    });

    // 拖动面板
    if (hd) {
      var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
      hd.addEventListener('pointerdown', function (e) {
        if (e.target.closest('button')) return;
        var r = hostEl.getBoundingClientRect();
        dragging = true;
        sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
        hostEl.style.right = 'auto';
        hostEl.style.bottom = 'auto';
        hostEl.style.left = ox + 'px';
        hostEl.style.top = oy + 'px';
        try { hd.setPointerCapture(e.pointerId); } catch (err) {}
      });
      hd.addEventListener('pointermove', function (e) {
        if (!dragging) return;
        var nx = Math.max(0, Math.min(window.innerWidth - 80, ox + e.clientX - sx));
        var ny = Math.max(0, Math.min(window.innerHeight - 40, oy + e.clientY - sy));
        hostEl.style.left = nx + 'px';
        hostEl.style.top = ny + 'px';
      });
      var endDrag = function () { dragging = false; };
      hd.addEventListener('pointerup', endDrag);
      hd.addEventListener('pointercancel', endDrag);
    }
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) {}
  }

  function buildCopyText() {
    var res = state.res;
    if (!res) return '';
    var lines = [];
    lines.push('MakerWorld 多色分析 · ' + (state.design.title || ''));
    lines.push('盘数 ' + res.n + ' / 颜色 ' + res.C + ' / AMS ' + state.slots + ' 槽' +
      (res.plan ? ' / 装料 ' + res.plan.mounts + ' 次 / 换料 ' + res.plan.ejects + ' 次' : '') +
      ' / 净重 ' + fmtG(res.grams) + ' / 预计 ' + fmtT(res.secs) +
      (state.scope && state.scope !== 'auto' ? ' / 范围 ' + state.scope : ''));
    lines.push('');
    lines.push('颜色：' + res.colors.map(function (c) {
      return c.disp + '(' + c.hex + '，' + c.plateCount + '盘' + (c.mat !== 'PLA' ? '，' + c.mat : '') + ')';
    }).join('，'));
    lines.push('');
    if (res.plan) {
      lines.push('顺序\t模型\t耗时\t克数\t颜色\t操作');
      res.plan.steps.forEach(function (s, i) {
        lines.push([
          i + 1,
          s.plate.name,
          fmtT(s.plate.secs),
          fmtG(s.plate.grams),
          s.plate.cols.map(function (ci) { return res.colors[ci].disp; }).join('+'),
          opsText(s, res) || '-'
        ].join('\t'));
      });
    } else {
      lines.push('模型\t耗时\t克数\t颜色');
      res.plates.forEach(function (p) {
        lines.push([
          p.name,
          fmtT(p.secs),
          fmtG(p.grams),
          p.cols.map(function (ci) { return res.colors[ci].disp; }).join('+')
        ].join('\t'));
      });
    }
    return lines.join('\n');
  }

  /* ============================ 生命周期 ============================ */

  var ticking = false;

  function tick(force) {
    if (ticking) return;
    ticking = true;
    try {
      var id = currentModelId();
      if (!id) {
        state.design = null;
        state.lastId = null;
        hidePanel();
        return;
      }
      if (!force && state.lastId === id && state.design && String(state.design.id) === id) return;

      var d = readPageDesign();
      if (d && String(d.id) !== id) d = null; // 站内跳转后可能残留上一页数据

      var apply = function (raw) {
        if (!raw || String(raw.id) !== id) { return; }
        var norm = normalizeDesign(raw);
        if (!norm.instances.length) { hidePanel(); return; }
        state.design = norm;
        state.lastId = id;
        render();
      };

      if (d) {
        apply(d);
      } else {
        fetchDesign(id).then(function (raw) {
          if (currentModelId() !== id) return;
          apply(raw);
        });
      }
    } finally {
      ticking = false;
    }
  }

  tick();
  setInterval(function () { tick(false); }, 800);
  window.addEventListener('popstate', function () { tick(true); });
  window.addEventListener('hashchange', function () {
    if (state.scope === 'auto') tick(true);
  });

  // 调试用
  window.__MWCA__ = {
    analyze: analyze,
    normalizeDesign: normalizeDesign,
    resolveScope: resolveScope,
    state: state
  };
})();
