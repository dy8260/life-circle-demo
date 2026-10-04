/* ============================================================
 * 生活圈助手（吉祥物「科技小精灵」）
 * 基于「在线体检」结果生成文字解读与固定问答；纯前端、无网络调用、无密钥。
 * 数据仅取自 window.__liveSnapshot（在线体检结果）。离线演示快照不在此读取
 * （按项目约定：助手仅对接在线数据，离线为地图显示兜底，不重复造解读）。
 * 地址「省/市/区/详细」拆分为本地规则解析。
 * 所有 UI 类名以 as- 前缀，避免与现有样式冲突。
 * ============================================================ */
(function () {
  'use strict';

  /* ---------- 可调参数（想改手感只动这几行） ---------- */
  var TILT_DEG = 12;       // 看向鼠标的倾斜幅度（度）
  var FOLLOW_PX = 6;       // 轻微跟随位移（px）
  var FOLLOW_MODE = 'tilt'; // 'tilt'=原地转头；'chase'=整图跟随鼠标（会离开右下角）

  /* ---------- 形象：A 科技小精灵（内联 SVG，改色搜 --as-m- 即可） ---------- */
  var MASCOT_SVG = [
    '<svg class="asmascot" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">',
    '  <g class="asorbit"><circle cx="60" cy="35" r="2.8" fill="#ffffff"/></g>',
    '  <g class="asorbit asb"><circle cx="92" cy="68" r="2.3" fill="var(--as-m-gold)"/></g>',
    '  <line x1="60" y1="30" x2="60" y2="14" stroke="var(--as-m-blue)" stroke-width="3"/>',
    '  <circle class="asantHalo" cx="60" cy="11" r="9" fill="var(--as-m-gold)"/>',
    '  <circle class="asantenna" cx="60" cy="11" r="5" fill="var(--as-m-gold)"/>',
    '  <path d="M40 50 A22 22 0 0 1 80 50" fill="none" stroke="var(--as-m-blue-l)" stroke-width="3" stroke-linecap="round" class="aswifi"/>',
    '  <path d="M46 56 A14 14 0 0 1 74 56" fill="none" stroke="var(--as-m-blue-l)" stroke-width="3" stroke-linecap="round" class="aswifi2"/>',
    '  <circle cx="60" cy="68" r="30" fill="var(--as-m-blue)"/>',
    '  <circle cx="60" cy="68" r="30" fill="none" stroke="var(--as-m-blue-d)" stroke-width="2"/>',
    '  <rect x="44" y="58" width="32" height="22" rx="8" fill="var(--as-m-blue-xl)"/>',
    '  <circle cx="54" cy="69" r="3.6" fill="var(--as-m-ink)" class="aseye"/>',
    '  <circle cx="66" cy="69" r="3.6" fill="var(--as-m-ink)" class="aseye"/>',
    '  <path class="asmouth" d="M55 76 Q60 80 65 76" fill="none" stroke="var(--as-m-ink)" stroke-width="2" stroke-linecap="round"/>',
    '  <circle class="ashand asl" cx="27" cy="72" r="6" fill="var(--as-m-hand)"/>',
    '  <circle class="ashand asr" cx="93" cy="72" r="6" fill="var(--as-m-hand)"/>',
    '</svg>'
  ].join('');

  /* ============================================================
   * 地址本地拆分（省/市/区/详细）——规则解析
   * ============================================================ */
  var PROVINCES = ['北京市','天津市','上海市','重庆市','河北省','山西省','辽宁省','吉林省','黑龙江省','江苏省','浙江省','安徽省','福建省','江西省','山东省','河南省','湖北省','湖南省','广东省','海南省','四川省','贵州省','云南省','陕西省','甘肃省','青海省','台湾省','内蒙古自治区','广西壮族自治区','西藏自治区','宁夏回族自治区','新疆维吾尔自治区','香港特别行政区','澳门特别行政区'];

  function matchSuffix(str, suffixes) {
    for (var i = 0; i < suffixes.length; i++) {
      var suf = suffixes[i];
      var idx = str.indexOf(suf);
      if (idx > 0) {
        var val = str.slice(0, idx + suf.length);
        if (val.length >= 2) return { val: val, rest: str.slice(idx + suf.length) };
      }
    }
    return null;
  }

  function splitAddress(raw) {
    raw = (raw || '').trim();
    if (!raw) return null;
    var province = null, city = null, district = null, rest = raw;
    for (var i = 0; i < PROVINCES.length; i++) {
      if (raw.indexOf(PROVINCES[i]) === 0) { province = PROVINCES[i]; rest = raw.slice(PROVINCES[i].length); break; }
    }
    if (!province) {
      return { province: null, city: null, district: null, detail: raw, note: '未识别到省级行政区，建议在开头补充「省 / 市 / 自治区」' };
    }
    var isMunicipality = /^(北京市|天津市|上海市|重庆市)$/.test(province);
    if (isMunicipality) {
      city = province;
    } else {
      var cm = matchSuffix(rest, ['市', '自治州', '盟', '地区']);
      if (cm) { city = cm.val; rest = cm.rest; }
    }
    var dm = matchSuffix(rest, ['区', '县', '旗']);
    if (dm) { district = dm.val; rest = dm.rest; }
    return { province: province, city: city, district: district, detail: (rest || '').trim() || null };
  }

  /* ============================================================
   * 数据源：仅在线体检结果
   * 主项目用 global.__liveSnapshot 缓存（global 在浏览器即全局对象）；
   * 此处 window 优先、并以 typeof 守卫回退 global，避免不同加载环境下读空。
   * ============================================================ */
  function gGet(name) {
    if (window[name] != null) return window[name];
    if (typeof global !== 'undefined' && global[name] != null) return global[name];
    return null;
  }

  function getSnapshot() {
    var s = gGet('__liveSnapshot');
    return (s && s.center) ? s : null;
  }

  /* 对比模式数据源：Compare.results[0]=A、[1]=B，两者都为完整快照才视为可解读 */
  function getCompare() {
    var C = gGet('Compare');
    if (C && C.results && C.results[0] && C.results[1]) {
      return { a: C.results[0], b: C.results[1] };
    }
    return null;
  }

  /* 选址推荐 perCategory 访问器：单地址快照用 s.recommend，对比快照用 s.recommendation
   * （内部 perCategory / ok 结构一致，此处统一收口，避免各解读函数散落判断） */
  function getPerCategory(s) {
    var r = s && (s.recommend || s.recommendation);
    return (r && r.perCategory) ? r.perCategory : [];
  }

  function scoreLevel(score) {
    if (score == null) return '—';
    if (score >= 90) return '优秀';
    if (score >= 75) return '良好';
    if (score >= 60) return '及格';
    return '偏弱';
  }

  /* ============================================================
   * 解读生成（字段对齐主项目真实结构）
   * ============================================================ */
  function buildNarrative(s) {
    var b = s.breakdown || {};
    var addr = (s.center && s.center.address) || '当前地址';
    var pct = function (v) { return v != null ? v + '%' : '—'; };

    var worst = null;
    (s.perType || []).forEach(function (p) {
      if (p.score != null && (worst == null || p.score < worst.score)) worst = p;
    });

    var gaps = getPerCategory(s)
      .filter(function (c) { return c.totalUncovered > 0; })
      .sort(function (a, b) { return b.totalUncovered - a.totalUncovered; });
    var topGap = gaps[0];

    var gc = (s.gapResult && s.gapResult.gapCount != null) ? s.gapResult.gapCount : 0;

    var t = '已为你完成【' + addr + '】的生活圈体检。综合评分 ' + s.score + ' 分（' + scoreLevel(s.score) + '）。';
    t += '维度构成：完整度 ' + pct(b.completeness) + '、就近度 ' + pct(b.proximity) +
         '、覆盖度 ' + pct(b.coverage) + '、多样性 ' + pct(b.diversity) + '。';
    if (worst) t += '各人群中「' + (worst.label || worst.key) + '」达标率最低（' + worst.score + ' 分），是公平性的主要短板。';
    t += '共识别出 ' + gc + ' 处服务盲区。';
    if (topGap) t += '设施缺口最突出的是「' + topGap.name + '」（' + topGap.totalUncovered + ' 处需求点未覆盖）。';
    t += '点击下方问题可查看更细的解读。';
    return t;
  }

  /* 对比模式自动解读：A vs B */
  function buildCompareNarrative(a, b) {
    var addrA = a.addr || (a.center && a.center.address) || '地址 A';
    var addrB = b.addr || (b.center && b.center.address) || '地址 B';
    var pct = function (v) { return v != null ? v + '%' : '—'; };
    var gA = (a.gapResult && a.gapResult.gapCount) || 0;
    var gB = (b.gapResult && b.gapResult.gapCount) || 0;
    var champ = a.score >= b.score ? addrA : addrB;
    var delta = Math.abs(a.score - b.score);

    var t = '已完成【' + addrA + '】与【' + addrB + '】的并排体检。';
    t += '综合评分：' + addrA + ' ' + a.score + ' 分、' + addrB + ' ' + b.score + ' 分，';
    t += (a.score === b.score) ? '两者持平。' : (champ + '更宜居，领先 ' + delta + ' 分。');

    var dims = ['completeness', 'proximity', 'coverage', 'diversity'];
    var dimName = { completeness: '完整度', proximity: '就近度', coverage: '覆盖度', diversity: '多样性' };
    var dimLines = [];
    dims.forEach(function (k) {
      var va = (a.breakdown && a.breakdown[k]) || 0;
      var vb = (b.breakdown && b.breakdown[k]) || 0;
      if (va !== vb) dimLines.push(dimName[k] + '：' + (va > vb ? addrA : addrB) + '更优');
    });
    if (dimLines.length) t += '分维度看，' + dimLines.join('、') + '。';
    t += '盲区数量：' + addrA + ' ' + gA + ' 处 vs ' + addrB + ' ' + gB + ' 处。';

    var topA = getPerCategory(a).filter(function (c) { return c.totalUncovered > 0; })
      .sort(function (x, y) { return y.totalUncovered - x.totalUncovered; })[0];
    var topB = getPerCategory(b).filter(function (c) { return c.totalUncovered > 0; })
      .sort(function (x, y) { return y.totalUncovered - x.totalUncovered; })[0];
    if (topA || topB) {
      t += '各自最突出缺口：' + addrA + (topA ? ('「' + topA.name + '」' + topA.totalUncovered + ' 处') : '无明显缺口') +
           '；' + addrB + (topB ? ('「' + topB.name + '」' + topB.totalUncovered + ' 处') : '无明显缺口') + '。';
    }
    t += '点击「两个社区谁更宜居？」可查看逐项对比。';
    return t;
  }

  var NO_DATA_MSG = '在页面顶部输入地址并完成「开始体检」后，我就能为你解读这个生活圈。';

  /* 单地址模式问答 */
  var SINGLE_QUESTIONS = [
    { key: 'overall',  q: '这个生活圈整体怎么样？' },
    { key: 'facility', q: '哪里最缺设施？' },
    { key: 'equity',   q: '对老人/小孩/轮椅友好吗？' },
    { key: 'barrier',  q: '哪些地方是服务盲区？' },
    { key: 'fix',      q: '先修路还是先补点？' }
  ];
  /* 对比模式问答 */
  var COMPARE_QUESTIONS = [
    { key: 'vs', q: '两个社区谁更宜居？' }
  ];

  function answerQuestion(key, s) {
    if (!s) return '暂无可解读的在线体检数据，请先完成一次地址体检。';
    switch (key) {
      case 'overall': {
        var b = s.breakdown || {};
        var pct = function (v) { return v != null ? v + '%' : '—'; };
        return '综合评分 <b>' + s.score + ' 分（' + scoreLevel(s.score) + '）</b>。维度：完整度 ' + pct(b.completeness) +
               '、就近度 ' + pct(b.proximity) + '、覆盖度 ' + pct(b.coverage) + '、多样性 ' + pct(b.diversity) + '。';
      }
      case 'facility': {
        var cats = getPerCategory(s)
          .filter(function (c) { return c.totalUncovered > 0; })
          .sort(function (a, b) { return b.totalUncovered - a.totalUncovered; });
        if (!cats.length) return '六类民生配套（菜市场 / 药店 / 学校等）在国标半径内均已覆盖，暂无显著供给缺口。';
        return '按缺口需求点排序：' + cats.map(function (c) { return '<b>' + c.name + '</b>：' + c.totalUncovered + ' 处未覆盖'; }).join('；') +
               '。建议优先在缺口密集处补点。';
      }
      case 'equity': {
        var pts = (s.perType || []).map(function (p) {
          var tag = p.score >= 85 ? 'good' : (p.score >= 70 ? 'warn' : 'bad');
          return '<span class="astag ' + tag + '">' + (p.label || p.key) + ' ' + p.score + '</span>';
        }).join(' ');
        var wheel = (s.perType || []).filter(function (p) { return p.key === 'wheel'; })[0];
        var r = '各人群 15 分钟生活圈评分：' + pts + '。';
        if (wheel) r += '<br>其中<b>轮椅无障碍评分仅 ' + wheel.score + ' 分</b>，是公平性主要短板，建议优先改善盲道连通与无障碍出入口。';
        return r;
      }
      case 'barrier': {
        var g = s.gapResult || {};
        var gc = g.gapCount || 0;
        if (!gc) return '当前未识别到服务盲区（六类配套均在步行可达范围内）。';
        var tri = g._tristate;
        var extra = tri ? ('三态判定：覆盖 ' + (tri.coverage || 0) + ' / 隐性 ' + (tri.hidden || 0) + ' / 显性 ' + (tri.explicit || 0) + '。') : '';
        return '共 <b>' + gc + '</b> 处服务盲区。其中重度盲区 ' + (g.severeCount != null ? g.severeCount : 0) +
               ' 处、一般盲区 ' + (g.normalCount != null ? g.normalCount : 0) + ' 处。' + extra +
               '隐性盲区占比高时，说明路网绕行是主因，仅靠补点难以消除。';
      }
      case 'fix': {
        var stress = gGet('Stress');
        var att = (stress && stress.lastResult && stress.lastResult.attribution) || null;
        if (!att || !att.ok) {
          return '暂无可用的归因数据（需完成一次在线体检并启用「应力测试」）。若已体检，可先在报告区点开「应力测试」tab 生成归因。';
        }
        var out = '归因结论：' + (att.headline || '') + '。';
        if (att.totalSupply != null) out += '供给缺口 ' + att.totalSupply + ' 处、连通缺口 ' + att.totalConnect + ' 处。';
        if (att.openList && att.openList.length) {
          out += '建议优先打通：' + att.openList.slice(0, 3).map(function (x) { return x.name || x; }).join('、') + '。';
        }
        return out;
      }
      case 'vs': {
        var cmp = getCompare();
        if (!cmp) return '请先在对比模式下完成地址 A、B 的体检，我才能对比两个社区。';
        var a = cmp.a, b = cmp.b;
        var addrA = a.addr || (a.center && a.center.address) || '地址 A';
        var addrB = b.addr || (b.center && b.center.address) || '地址 B';
        var champ = a.score >= b.score ? addrA : addrB;
        var delta = Math.abs(a.score - b.score);
        var out = '<b>' + champ + '</b>更宜居（综合 ' + (a.score >= b.score ? a.score : b.score) + ' 分 vs ' +
          (a.score >= b.score ? b.score : a.score) + ' 分，差 ' + delta + ' 分）。';
        var dims = [['completeness', '完整度'], ['proximity', '就近度'], ['coverage', '覆盖度'], ['diversity', '多样性']];
        var rows = dims.map(function (d) {
          var va = (a.breakdown && a.breakdown[d[0]]) || 0;
          var vb = (b.breakdown && b.breakdown[d[0]]) || 0;
          var who = va > vb ? 'A' : (vb > va ? 'B' : '=');
          return d[1] + '：A ' + va + ' / B ' + vb + '（' + who + ' 优）';
        }).join('<br>');
        out += '<br><br>维度对比：<br>' + rows;
        var wa = (a.perType || []).filter(function (p) { return p.key === 'wheel'; })[0];
        var wb = (b.perType || []).filter(function (p) { return p.key === 'wheel'; })[0];
        if (wa || wb) out += '<br><br>无障碍（轮椅）：A ' + (wa ? wa.score : '—') + ' 分 / B ' + (wb ? wb.score : '—') + ' 分。';
        return out;
      }
    }
    return '';
  }

  /* ============================================================
   * 构建 UI（注入到 body，纯加法）
   * ============================================================ */
  function buildUI() {
    var fab = document.createElement('button');
    fab.className = 'asfab'; fab.id = 'asfab'; fab.setAttribute('aria-label', '打开生活圈助手');
    fab.innerHTML = '<span class="astip" id="asTip">点我看解读</span>' +
                    '<span class="asfab-tilt" id="asTilt"><span class="asfab-inner" id="asInner">' +
                    '<span class="asring" id="asRing"></span>' + MASCOT_SVG + '</span></span>';

    var scrim = document.createElement('div'); scrim.className = 'asscrim'; scrim.id = 'asScrim';

    var panel = document.createElement('aside'); panel.className = 'aspanel'; panel.id = 'asPanel'; panel.setAttribute('aria-hidden', 'true');
    panel.innerHTML =
      '<div class="aspanel-head">' +
        '<span class="asava" id="asAva">' + MASCOT_SVG + '</span>' +
        '<div><div class="asttl">生活圈助手</div><div class="assub">基于在线体检结果的解读</div></div>' +
        '<button class="asclose" id="asClose" aria-label="关闭">×</button>' +
      '</div>' +
      '<div class="aspanel-body">' +
        '<div class="as-mode" id="asMode">' +
          '<button class="asmode-btn" id="asModeSingle" data-mode="single">单地址</button>' +
          '<button class="asmode-btn" id="asModeCompare" data-mode="compare">对比</button>' +
        '</div>' +
        '<div class="asspeech" id="asSpeech"><span id="asSpeechText"></span><span class="ascaret" id="asCaret"></span></div>' +

        '<div class="asaddr" id="asAddrBox"></div>' +

        '<div class="asq-title">常见解读问题（点击查看）</div>' +
        '<div class="aschips" id="asChips"></div>' +
        '<div class="asanswer" id="asAnswer"></div>' +
      '</div>';

    document.body.appendChild(scrim);
    document.body.appendChild(panel);
    document.body.appendChild(fab);
    return { fab: fab, scrim: scrim, panel: panel };
  }

  /* ============================================================
   * 交互
   * ============================================================ */
  function init() {
    var ui = buildUI();
    var fab = ui.fab, scrim = ui.scrim, panel = ui.panel;
    var fabTilt = document.getElementById('asTilt');
    var fabInner = document.getElementById('asInner');
    var ring = document.getElementById('asRing');
    var speechText = document.getElementById('asSpeechText');
    var caret = document.getElementById('asCaret');
    var chipsBox = document.getElementById('asChips');
    var answerBox = document.getElementById('asAnswer');
    var tip = document.getElementById('asTip');

    /* 鼠标视差 / 跟随：小人物“看向”并轻微追鼠标 */
    var rafId = null;
    window.addEventListener('mousemove', function (e) {
      if (rafId) return;
      rafId = requestAnimationFrame(function () {
        rafId = null;
        var r = fab.getBoundingClientRect();
        var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        var dx = Math.max(-1, Math.min(1, (e.clientX - cx) / (window.innerWidth / 2)));
        var dy = Math.max(-1, Math.min(1, (e.clientY - cy) / (window.innerHeight / 2)));
        if (FOLLOW_MODE === 'chase') {
          fab.style.left = (e.clientX - r.width / 2) + 'px';
          fab.style.top = (e.clientY - r.height / 2) + 'px';
          fab.style.right = 'auto'; fab.style.bottom = 'auto';
        }
        fabTilt.style.setProperty('--ry', (dx * TILT_DEG).toFixed(2) + 'deg');
        fabTilt.style.setProperty('--rx', (-dy * TILT_DEG).toFixed(2) + 'deg');
        fabTilt.style.setProperty('--mx', (dx * FOLLOW_PX).toFixed(2) + 'px');
        fabTilt.style.setProperty('--my', (dy * FOLLOW_PX).toFixed(2) + 'px');
      });
    });

    /* 点击：弹跳 + 扫光 + 涟漪 */
    function poke() {
      fabInner.classList.remove('asbounce', 'asscanning');
      ring.classList.remove('asgo');
      void fabInner.offsetWidth;
      fabInner.classList.add('asbounce', 'asscanning');
      ring.classList.add('asgo');
    }

    var lastRenderedKey = null;   // 防止重复打字；变化了才重打
    var typeTimer = null;

    function stopTyping() {
      if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }
      caret.style.display = 'none';
      fabInner.classList.remove('astalking');
    }

    function typeWriter(text) {
      stopTyping();
      var i = 0; speechText.textContent = '';
      fabInner.classList.add('astalking');
      caret.style.display = 'inline-block';
      typeTimer = setInterval(function () {
        speechText.textContent += text.charAt(i++);
        if (i >= text.length) {
          clearInterval(typeTimer); typeTimer = null;
          caret.style.display = 'none';
          fabInner.classList.remove('astalking');
        }
      }, 26);
    }

    var currentMode = 'single';   // 'single' | 'compare'

    function snapshotKey(s) {
      if (!s) return 'nodata';
      return (s.center && (s.center.address || s.center.lng + ',' + s.center.lat)) || 'snapshot';
    }

    /* 当前应展示的数据：对比优先（两个结果都在），否则回退单地址 */
    function currentData() {
      if (currentMode === 'compare') {
        var cmp = getCompare();
        if (cmp) return { type: 'compare', a: cmp.a, b: cmp.b };
        currentMode = 'single'; // 对比数据丢失则回退
      }
      return { type: 'single', s: getSnapshot() };
    }

    function dataKey(d) {
      if (!d) return 'none';
      if (d.type === 'compare') {
        return 'cmp:' + (d.a.addr || (d.a.center && d.a.center.address) || 'A') + '|' +
               (d.b.addr || (d.b.center && d.b.center.address) || 'B');
      }
      return 'single:' + snapshotKey(d.s);
    }

    function renderNarrative(force) {
      var d = currentData();
      var key = dataKey(d);
      if (!force && key === lastRenderedKey) return;
      lastRenderedKey = key;
      updateModeToggle(); // 同步模式高亮（currentData 可能因对比数据丢失自动回退）
      if (d.type === 'compare') typeWriter(buildCompareNarrative(d.a, d.b));
      else if (d.s) typeWriter(buildNarrative(d.s));
      else typeWriter(NO_DATA_MSG);
    }

    function updateModeToggle() {
      var hasCmp = !!getCompare();
      var btnS = document.getElementById('asModeSingle');
      var btnC = document.getElementById('asModeCompare');
      var modeBox = document.getElementById('asMode');
      if (btnS) btnS.classList.toggle('active', currentMode === 'single');
      if (btnC) { btnC.classList.toggle('active', currentMode === 'compare'); btnC.disabled = !hasCmp; }
      if (modeBox) modeBox.style.display = (getSnapshot() || hasCmp) ? 'flex' : 'none';
    }

    function clearChipsAndAnswer() {
      var cs = chipsBox.querySelectorAll('.aschip');
      for (var k = 0; k < cs.length; k++) cs[k].classList.remove('active');
      answerBox.innerHTML = '';
      answerBox.classList.remove('show');
    }

    /* 根据当前模式重新渲染地址输入区：单地址=1个输入框；对比=2个等宽输入框+对比按钮 */
    function renderAddrForm() {
      var box = document.getElementById('asAddrBox');
      if (!box) return;
      if (currentMode === 'compare') {
        box.innerHTML =
          '<div class="asq-title">输入两个详细地址，自动拆分并并排对比</div>' +
          '<div class="asaddr-row"><input class="asaddr-in" id="asAddrInA" type="text" placeholder="地址 A：如 北京市朝阳区望京SOHO T1" /></div>' +
          '<div class="asaddr-row"><input class="asaddr-in" id="asAddrInB" type="text" placeholder="地址 B：如 北京市海淀区中关村" /></div>' +
          '<div class="asaddr-row btn-row"><button class="asaddr-btn" id="asAddrBtn">对比</button></div>' +
          '<div class="asaddr-out" id="asAddrOut"></div>' +
          '<div class="asaddr-hint">两个地址各自拆分为省 / 市 / 区 / 详细（本地规则解析），点「对比」后自动回填到顶部 A / B 地址栏并立即开始并排体检。</div>';
        bindCompareQuery();
      } else {
        box.innerHTML =
          '<div class="asq-title">输入详细地址，我帮你拆分并查询</div>' +
          '<div class="asaddr-row"><input class="asaddr-in" id="asAddrIn" type="text" placeholder="如：北京市朝阳区望京SOHO T1" /></div>' +
          '<div class="asaddr-row btn-row"><button class="asaddr-btn" id="asAddrBtn">查询</button></div>' +
          '<div class="asaddr-out" id="asAddrOut"></div>' +
          '<div class="asaddr-hint">拆分为省 / 市 / 区 / 详细为本地规则解析。点「查询」后自动回填到顶部地址栏并立即开始体检。</div>';
        bindSingleQuery();
      }
    }

    function setMode(mode) {
      currentMode = mode;
      clearChipsAndAnswer();
      updateModeToggle();
      renderAddrForm();
      renderChips();
      renderNarrative(true);
    }

    function openPanel() {
      panel.classList.add('open');
      scrim.classList.add('show');
      panel.setAttribute('aria-hidden', 'false');
      tip.style.display = 'none';
      currentMode = getCompare() ? 'compare' : 'single';
      updateModeToggle();
      renderAddrForm();
      renderChips();
      renderNarrative(false);
    }
    function closePanel() {
      panel.classList.remove('open');
      scrim.classList.remove('show');
      panel.setAttribute('aria-hidden', 'true');
      fabInner.classList.remove('astalking');
    }
    fab.addEventListener('click', function () { poke(); openPanel(); });
    document.getElementById('asClose').addEventListener('click', closePanel);
    scrim.addEventListener('click', closePanel);

    /* 模式切换：有对比数据时才允许切到「对比」 */
    document.getElementById('asModeSingle').addEventListener('click', function () { setMode('single'); });
    document.getElementById('asModeCompare').addEventListener('click', function () { setMode('compare'); });

    function talkBriefly(ms) {
      fabInner.classList.add('astalking');
      clearTimeout(talkBriefly._t);
      talkBriefly._t = setTimeout(function () { fabInner.classList.remove('astalking'); }, ms);
    }

    /* 固定问答：根据当前模式渲染不同的问题集（函数声明，便于 setMode/openPanel 提前调用） */
    function renderChips() {
      chipsBox.innerHTML = '';
      var list = (currentMode === 'compare') ? COMPARE_QUESTIONS : SINGLE_QUESTIONS;
      list.forEach(function (item) {
        var c = document.createElement('button');
        c.className = 'aschip'; c.textContent = item.q; c.dataset.key = item.key;
        c.addEventListener('click', function () {
          var cs = chipsBox.querySelectorAll('.aschip');
          for (var k = 0; k < cs.length; k++) cs[k].classList.remove('active');
          c.classList.add('active');
          // vs 问答内部自行读取对比快照；其余问题使用单地址快照
          var data = (item.key === 'vs') ? getCompare() : getSnapshot();
          answerBox.innerHTML = answerQuestion(item.key, data);
          answerBox.classList.remove('show'); void answerBox.offsetWidth; answerBox.classList.add('show');
          talkBriefly(1800);
        });
        chipsBox.appendChild(c);
      });
    }

    /* 地址本地拆分 → 回填顶部地址栏 → 触发体检（单地址 or 对比） */
    function setSelectValue(el, value) {
      if (!el || value == null) return;
      var str = String(value);
      for (var i = 0; i < el.options.length; i++) {
        el.options[i].selected = (el.options[i].value === str);
      }
    }

    /* 单个三级联动回填（省→市→区→详细），触发 change 让 RegionPicker 逐层填充 */
    function fillOnePicker(provEl, cityEl, areaEl, detailEl, res) {
      setSelectValue(provEl, res.province);
      provEl.dispatchEvent(new Event('change', { bubbles: true }));
      if (res.city && cityEl.options.length > 1) setSelectValue(cityEl, res.city);
      cityEl.dispatchEvent(new Event('change', { bubbles: true }));
      if (res.district && areaEl.options.length > 1) setSelectValue(areaEl, res.district);
      detailEl.value = (res.detail || '').trim();
    }

    /* 单地址/对比体检完成后自动刷新助手解读 */
    var pollTimer = null;
    function startPollingForResult() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      var startAt = Date.now();
      var prevKey = lastRenderedKey;
      pollTimer = setInterval(function () {
        var s = getSnapshot();
        if (s && snapshotKey(s) !== prevKey) {
          clearInterval(pollTimer); pollTimer = null;
          renderNarrative(true);
          return;
        }
        if (Date.now() - startAt > 35000) { clearInterval(pollTimer); pollTimer = null; }
      }, 700);
    }

    /* 回填单个地址栏并触发单地址体检 */
    function setRegionAndRun(res) {
      var provEl = document.getElementById('provSelect');
      var cityEl = document.getElementById('citySelect');
      var areaEl = document.getElementById('areaSelect');
      var detailEl = document.getElementById('addrInput');
      var goBtn = document.getElementById('btnGo');
      var addrOut = document.getElementById('asAddrOut');
      if (!provEl || !cityEl || !areaEl || !detailEl || !goBtn) {
        if (addrOut) addrOut.innerHTML = '<span class="astag bad">错误</span> 页面顶部地址栏未加载，无法回填。';
        return;
      }
      var data = (window.REGION_DATA || {});
      if (!res.province || !data[res.province]) {
        if (addrOut) addrOut.innerHTML = '<span class="astag warn">提示</span> 未识别到系统支持的省级行政区，建议以「北京市 / 广东省 / 浙江省」等开头。';
        return;
      }
      // 切回单地址视图（若当前是对比模式，收起 B 行）
      currentMode = 'single';
      updateModeToggle();
      var addrBarB = document.getElementById('addrBarB');
      var btnCompare = document.getElementById('btnCompare');
      if (addrBarB && !addrBarB.hasAttribute('hidden') && btnCompare) btnCompare.click();

      fillOnePicker(provEl, cityEl, areaEl, detailEl, res);
      if (addrOut) addrOut.innerHTML += '<div class="asaddr-kv"><span class="asaddr-k">状态</span><span class="asaddr-v" style="color:var(--as-good)">已回填，开始体检…</span></div>';
      typeWriter('已回填地址，正在体检… 完成后我会自动为你解读。');
      lastRenderedKey = 'loading';
      startPollingForResult();
      setTimeout(function () { goBtn.click(); }, 120);
      // 触发后自动收起面板，让用户直接看地图体检结果（解读在后台生成，重开可见）
      closePanel();
    }

    /* 对比体检完成后自动刷新助手解读 */
    function startPollingForCompare() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      var startAt = Date.now();
      pollTimer = setInterval(function () {
        if (getCompare()) {
          clearInterval(pollTimer); pollTimer = null;
          currentMode = 'compare';
          updateModeToggle();
          renderChips();
          renderNarrative(true);
          return;
        }
        if (Date.now() - startAt > 45000) { clearInterval(pollTimer); pollTimer = null; }
      }, 700);
    }

    /* 回填 A/B 两组地址栏并触发并排对比体检 */
    function setRegionAndRunCompare(resA, resB) {
      var provA = document.getElementById('provSelect');
      var cityA = document.getElementById('citySelect');
      var areaA = document.getElementById('areaSelect');
      var detailA = document.getElementById('addrInput');
      var provB = document.getElementById('provSelectB');
      var cityB = document.getElementById('citySelectB');
      var areaB = document.getElementById('areaSelectB');
      var detailB = document.getElementById('addrInputB');
      var addrOut = document.getElementById('asAddrOut');
      if (!provA || !cityA || !areaA || !detailA || !provB || !cityB || !areaB || !detailB) {
        if (addrOut) addrOut.innerHTML = '<span class="astag bad">错误</span> 页面顶部地址栏未加载，无法回填。';
        return;
      }
      var data = (window.REGION_DATA || {});
      if (!resA.province || !data[resA.province] || !resB.province || !data[resB.province]) {
        if (addrOut) addrOut.innerHTML = '<span class="astag warn">提示</span> 两个地址都需以系统支持的「省 / 市 / 自治区」开头（如 北京市 / 广东省）。';
        return;
      }
      // 展开对比 B 行（若尚未展开，点击对比模式入口按钮完成显隐 + 顶栏高度同步）
      var addrBarB = document.getElementById('addrBarB');
      var btnCompare = document.getElementById('btnCompare');
      if (addrBarB && addrBarB.hasAttribute('hidden') && btnCompare) btnCompare.click();

      fillOnePicker(provA, cityA, areaA, detailA, resA);
      fillOnePicker(provB, cityB, areaB, detailB, resB);
      detailB.dispatchEvent(new Event('input', { bubbles: true }));

      if (addrOut) addrOut.innerHTML += '<div class="asaddr-kv"><span class="asaddr-k">状态</span><span class="asaddr-v" style="color:var(--as-good)">已回填 A/B，开始并排体检…</span></div>';
      typeWriter('已回填两个地址，正在并排体检… 完成后我会自动为你解读。');
      lastRenderedKey = 'loading';
      currentMode = 'compare';
      startPollingForCompare();
      setTimeout(function () {
        var b = document.getElementById('btnRunCompare');
        if (b && !b.disabled) b.click();
      }, 200);
      // 触发后自动收起面板，让用户直接看地图并排对比结果（解读在后台生成，重开可见）
      closePanel();
    }

    /* 单地址模式：绑定一个输入框 */
    function bindSingleQuery() {
      var addrIn = document.getElementById('asAddrIn');
      var addrOut = document.getElementById('asAddrOut');
      if (!addrIn || !addrOut) return;
      function doQuery() {
        var res = splitAddress(addrIn.value);
        if (!res) { addrOut.innerHTML = '请输入地址'; return; }
        var row = function (label, val) {
          return '<div class="asaddr-kv"><span class="asaddr-k">' + label + '</span><span class="asaddr-v">' +
            (val || '<i>未识别</i>') + '</span></div>';
        };
        if (res.note) {
          addrOut.innerHTML = '<span class="astag warn">提示</span> ' + res.note +
            (res.detail ? ('<br>已识别详情：' + res.detail) : '');
          return;
        }
        addrOut.innerHTML = row('省 / 自治区', res.province) + row('市', res.city) +
          row('区 / 县', res.district) + row('详细地址', res.detail);
        setRegionAndRun(res);
      }
      document.getElementById('asAddrBtn').addEventListener('click', doQuery);
      addrIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') doQuery(); });
    }

    /* 对比模式：绑定两个等宽输入框 */
    function bindCompareQuery() {
      var addrInA = document.getElementById('asAddrInA');
      var addrInB = document.getElementById('asAddrInB');
      var addrOut = document.getElementById('asAddrOut');
      if (!addrInA || !addrInB || !addrOut) return;
      function doQuery() {
        var resA = splitAddress(addrInA.value);
        var resB = splitAddress(addrInB.value);
        if (!resA || !resB) { addrOut.innerHTML = '<span class="astag warn">提示</span> 请同时填写地址 A 与地址 B。'; return; }
        if (resA.note || resB.note) {
          var msg = '';
          if (resA.note) msg += '<div>地址 A：' + resA.note + (resA.detail ? ('（已识别：' + resA.detail + '）') : '') + '</div>';
          if (resB.note) msg += '<div>地址 B：' + resB.note + (resB.detail ? ('（已识别：' + resB.detail + '）') : '') + '</div>';
          addrOut.innerHTML = '<span class="astag warn">提示</span> 两个地址都需以「省 / 市 / 自治区」开头。' + msg;
          return;
        }
        var row = function (label, val) {
          return '<div class="asaddr-kv"><span class="asaddr-k">' + label + '</span><span class="asaddr-v">' +
            (val || '<i>未识别</i>') + '</span></div>';
        };
        addrOut.innerHTML =
          '<div style="margin-bottom:4px"><b>地址 A</b></div>' +
          row('省/市/区', resA.province + ' / ' + resA.city + ' / ' + resA.district) +
          row('详细', resA.detail) +
          '<div style="margin:6px 0 4px"><b>地址 B</b></div>' +
          row('省/市/区', resB.province + ' / ' + resB.city + ' / ' + resB.district) +
          row('详细', resB.detail);
        setRegionAndRunCompare(resA, resB);
      }
      document.getElementById('asAddrBtn').addEventListener('click', doQuery);
      addrInA.addEventListener('keydown', function (e) { if (e.key === 'Enter') addrInB.focus(); });
      addrInB.addEventListener('keydown', function (e) { if (e.key === 'Enter') doQuery(); });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
