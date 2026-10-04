/**
 * 右侧数据看板
 * - 评分环
 * - POI 数量列表（带状态色）
 * - 雷达图（实际 vs 理想）
 * - 柱状图（各类数量）
 */
(function (global) {
    'use strict';

    const Dashboard = {
        radarInst: null,
        barInst: null,

        /**
         * 初始化图表实例并填入主题色
         */
        ensureCharts: function () {
            if (this.radarInst && this.barInst) return;

            const radar = echarts.init(document.getElementById('radarChart'), null, { renderer: 'canvas' });
            const bar = echarts.init(document.getElementById('barChart'), null, { renderer: 'canvas' });

            // 主题色
            const T = global.THEME || { primary: '#3a7afe', textSub: '#8a9ec0', text: '#e6f0ff' };
            const textStyle = { color: T.text, fontFamily: 'inherit' };
            const axisLabelStyle = { color: T.textSub, fontSize: 11 };
            const splitLineStyle = { lineStyle: { color: 'rgba(120,180,255,0.10)' } };

            // 雷达图（6 类适配：标签只显示类别名，不追加"最少N"避免拥挤）
            const indicator = POI_CATEGORIES.map(c => ({ name: c.name, max: Math.max(POI_THRESHOLD[c.key].ideal + 2, 6) }));
            radar.setOption({
                backgroundColor: 'transparent',
                // appendToBody: tooltip 挂到 <body> 下，脱离图表容器的层叠上下文，
                // 避免被相邻面板（评分卡/图例卡）盖住；confine: 限制在视口内不出边。
                tooltip: { trigger: 'item', appendToBody: true, confine: true },
                radar: {
                    indicator,
                    center: ['50%', '52%'],
                    radius: '54%',
                    name: { textStyle: { ...axisLabelStyle, fontSize: 11 }, padding: [2, 4] },
                    axisLine: splitLineStyle,
                    splitLine: splitLineStyle,
                    splitArea: { areaStyle: { color: ['rgba(91,155,255,0.03)', 'rgba(91,155,255,0.06)'] } }
                },
                series: [{
                    type: 'radar',
                    data: [],
                    symbolSize: 6,
                    lineStyle: { width: 2 },
                    areaStyle: { opacity: 0.35 }
                }]
            });

            // 柱状图
            bar.setOption({
                backgroundColor: 'transparent',
                tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, appendToBody: true, confine: true },
                grid: { left: 48, right: 14, top: 14, bottom: 36 },
                xAxis: {
                    type: 'category',
                    data: POI_CATEGORIES.map(c => c.name),
                    axisLabel: { ...axisLabelStyle, fontSize: 10, rotate: 0, interval: 0 },  // 水平文字，6 类放得下
                    axisLine: { lineStyle: { color: 'rgba(120,180,255,0.2)' } }
                },
                yAxis: {
                    type: 'value',
                    name: '数量',
                    nameTextStyle: axisLabelStyle,
                    axisLabel: axisLabelStyle,
                    splitLine: splitLineStyle,
                    axisLine: { lineStyle: { color: 'rgba(120,180,255,0.2)' } }
                },
                series: [{
                    type: 'bar',
                    data: [],
                    barWidth: 14,
                    itemStyle: {
                        borderRadius: [6, 6, 0, 0],
                        color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                            colorStops: [
                                { offset: 0, color: '#5b9bff' },
                                { offset: 1, color: '#3a7afe' }
                            ]},
                        shadowBlur: 10,
                        shadowColor: 'rgba(58,122,254,0.5)'
                    },
                    label: { show: true, position: 'top', color: T.text, fontSize: 11 }
                }]
            });

            this.radarInst = radar;
            this.barInst = bar;

            window.addEventListener('resize', () => {
                radar.resize();
                bar.resize();
            });
        },

        /**
         * 设置评分环动画
         * @param {number} score 0-100
         */
        setScore: function (score, label) {
            const arc = document.getElementById('scoreArc');
            const num = document.getElementById('scoreNum');
            const tag = document.getElementById('scoreTag');
            if (!arc || !num || !tag) return;

            const lvl = Util.scoreLevel(score);
            const max = 326.7;  // 2πr=2π*52=326.7
            const offset = max * (1 - Math.max(0, Math.min(100, score)) / 100);
            arc.style.strokeDashoffset = offset.toString();
            arc.style.stroke = lvl.color;

            // 数字滚动
            const start = parseInt(num.textContent) || 0;
            const steps = 30;
            let i = 0;
            const t = setInterval(() => {
                i++;
                num.textContent = Math.round(start + (score - start) * (i / steps));
                if (i >= steps) { clearInterval(t); num.textContent = score; }
            }, 16);

            tag.textContent = label || lvl.text;
            tag.style.color = lvl.color;
            tag.style.borderColor = lvl.color + '60';
            tag.style.background = lvl.color + '15';
        },

        /**
         * 填充 POI 数量列表（带状态色）
         */
        renderPoiCount: function (resultByKey) {
            const box = document.getElementById('poiCountList');
            if (!box) return;
            box.innerHTML = '';

            let total = 0;
            let unsatisfied = 0;

            POI_CATEGORIES.forEach(cat => {
                const g = resultByKey[cat.key];
                const n = (g && g.items) ? g.items.length : 0;
                total += n;
                const th = POI_THRESHOLD[cat.key];
                let status, statusText, cls;
                if (n >= th.ideal)      { status = 0; statusText = '充足'; cls = 'ok'; }
                else if (n >= th.min)   { status = 1; statusText = '达标'; cls = 'low'; }
                else                    { status = 2; statusText = '缺失'; cls = 'bad'; unsatisfied++; }

                const item = document.createElement('div');
                item.className = 'poi-item';
                item.innerHTML = `
                    <div class="ico" style="background:${cat.color}25;color:${cat.color}">${cat.icon}</div>
                    <div class="name">${cat.name}<br><small style="color:#8a9ec0;font-size:11px">建议 ≥ ${th.ideal}</small></div>
                    <div class="count">${n}<small> 处</small></div>
                    <span class="status ${cls}">${statusText}</span>`;
                box.appendChild(item);
            });

            const totalTag = document.getElementById('poiTotalTag');
            if (totalTag) {
                totalTag.textContent = `${total} 项 · 缺失 ${unsatisfied} 类`;
            }
        },

        /**
         * 渲染「服务盲区识别」卡片
         * @param {Object} gap  GapFinder.analyze() 的返回值
         *
         * 判定口径（对齐「15 分钟生活圈」配套标准）：
         *   菜市场 / 药店 / 学校 三类的步行距离**全部** > 1 km 的点 → 服务盲区点位
         * 注：配套标准原文为“小学”，实际检索关键词扩展为小学/幼儿园/中学以提升召回，
         *     UI 统一简称为“学校”。
         */
        renderGap: function (gap) {
            const box = document.getElementById('gapBody');
            if (!box) return;
            const btn = document.getElementById('btnGapToggle');

            if (!gap || !gap.enabled) {
                box.innerHTML = '<p class="gap-empty muted">完成体检后自动识别：' + (global.WALK_MINUTES || 15) + ' 分钟步行范围内，' +
                    '<b>1 公里内没有菜市场 / 药店 / 学校</b>的点位。</p>';
                if (btn) { btn.disabled = true; btn.classList.remove('active'); btn.textContent = '显示点位'; }
                this.renderGapLegend(null);
                return;
            }

            const nameOf = (k) => {
                const c = POI_CATEGORIES.find(x => x.key === k);
                return c ? c.name : k;
            };

            const p = gap.params || {};
            const R = p.radiusMeters || 1000;
            const ratioPct = (gap.gapRatio * 100);
            const areaHa = gap.gapAreaM2 / 1e4;                       // 公顷
            const severePct = gap.gapCount ? (gap.severeCount / gap.gridCount) * 100 : 0;
            const mildPct   = Math.max(0, ratioPct - severePct);

            const html = [];

            // —— 三格核心指标 ——
            html.push(`
            <div class="gap-summary">
                <div class="gs-cell">
                    <div class="gs-val">${ratioPct.toFixed(1)}<small>%</small></div>
                    <div class="gs-lab">盲区点位占比</div>
                </div>
                <div class="gs-cell">
                    <div class="gs-val">${areaHa.toFixed(1)}<small> 公顷</small></div>
                    <div class="gs-lab">盲区面积</div>
                </div>
                <div class="gs-cell">
                    <div class="gs-val" title="路网绕行系数 λ = 真实步行距离 / 直线距离">${gap.lambda.toFixed(2)}<small> λ</small></div>
                    <div class="gs-lab">绕行系数</div>
                </div>
            </div>`);

            // —— 占比条（重度 / 一般 分色） ——
            html.push(`
            <div class="gap-ratio-row">
                <span>栅格 <b>${gap.gridCount}</b> 点 → 盲区 <b>${gap.gapCount}</b> 点</span>
                <span>重度 <b>${gap.severeCount}</b> 点</span>
            </div>
            <div class="gap-bar">
                <i class="gb-severe" style="width:${severePct.toFixed(2)}%"></i>
                <i class="gb-mild"   style="width:${mildPct.toFixed(2)}%"></i>
            </div>
            <div class="gap-legend-inline">
                <span><i style="background:#ff5470"></i>重度（三类均 > ${p.severeMeters || (global.BLIND_GAP ? global.BLIND_GAP.severeMeters : 1500)} m）</span>
                <span><i style="background:#ffb547"></i>一般（> ${R} m）</span>
            </div>`);

            // —— 各类单独缺失率：看清"到底缺哪一类" ——
            const keys = (p.checkKeys || []).filter(k => gap.missingRate && gap.missingRate[k] !== undefined);
            if (keys.length) {
                html.push('<div class="gap-keys">');
                keys.forEach(k => {
                    const r = gap.missingRate[k];
                    html.push(`
                    <div class="gap-key-row">
                        <span class="gk-name">${nameOf(k)}</span>
                        <span class="gk-bar"><i style="width:${Math.min(100, r * 100).toFixed(1)}%"></i></span>
                        <span class="gk-val">${(r * 100).toFixed(0)}%</span>
                    </div>`);
                });
                html.push('</div>');
            }

            // —— Top 连片盲区斑块 ——
            if (gap.patches && gap.patches.length) {
                const marks = ['①', '②', '③', '④', '⑤'];
                html.push('<div class="gap-patches"><h5>🔴 优先改造斑块（按面积 × 缺口强度排序）</h5>');
                gap.patches.forEach((pt, i) => {
                    html.push(`
                    <div class="gap-patch-item">
                        <span class="gp-rank">${marks[i] || (i + 1)}</span>
                        <span class="gp-main">
                            ${(pt.areaM2 / 1e4).toFixed(2)} 公顷 · 最近一类也要走 <b>${Math.round(pt.avgGap)}</b> m
                            <div class="gp-meta">最差点位 ${Math.round(pt.maxGap)} m · ${pt.size} 个栅格</div>
                        </span>
                    </div>`);
                });
                html.push('</div>');
            } else if (gap.gapCount === 0) {
                const weakest = keys.length && gap.missingRate
                    ? keys.reduce((max, k) => (gap.missingRate[k] > gap.missingRate[max] ? k : max), keys[0])
                    : null;
                const weakestHint = weakest && gap.missingRate[weakest] > 0
                    ? `（单类如${nameOf(weakest)}仍有 ${(gap.missingRate[weakest] * 100).toFixed(0)}% 覆盖薄弱区，见上方明细）`
                    : '（单类覆盖率均较好，无显著薄弱项）';
                html.push(`<p class="gap-none">🎉 未发现连片服务盲区：范围内没有「菜市场 / 药店 / 学校」三类配套同时超出 1 km 步行距离的点位${weakestHint}。</p>`);
            }

            // —— 参数透明化（便于复现 / 答辩自查） ——
            html.push(`
            <p class="gap-note">
                栅格 ${p.gridStepMeters || 120} m${p.stepAutoEnlarged ? '（范围过大已自动放大）' : ''} ·
                判定阈值 ${R} m 步行距离 ·
                λ 由 ${gap.lambdaSamples} 个锚点真实路网标定${gap.lambdaFallback ? '（样本不足，已用经验值 1.25）' : ''}
            </p>`);

            box.innerHTML = html.join('');

            if (btn) {
                btn.disabled = (gap.gapCount === 0);
                btn.textContent = '显示点位';
                btn.classList.remove('active');
            }
            this.renderGapLegend(gap);
        },

        /**
         * 地图图例：服务盲区点位 + 推荐选址 + 步行阻抗场（与配套设施共用一列）
         * 统一交给 app.js 的 renderLayerLegend 渲染，避免单列里维护多份图例状态。
         */
        renderGapLegend: function (gap) {
            if (typeof global.renderLayerLegend === 'function') global.renderLayerLegend(gap);
        },

        /**
         * 填充雷达 + 柱状图
         */
        renderCharts: function (resultByKey) {
            if (!this.radarInst || !this.barInst) return;
            this._lastSingle = resultByKey || {};   // 缓存最近一次单地址数据，供 exitCompare 还原

            // 雷达：实际 vs 最低 vs 理想
            // 实际数量不再封顶，保持与左侧图例、右侧柱状图/配套统计口径一致
            const actualData = POI_CATEGORIES.map(c => {
                const g = resultByKey[c.key];
                return g && g.items ? g.items.length : 0;
            });
            const minLine  = POI_CATEGORIES.map(c => POI_THRESHOLD[c.key].min);
            const idealLine = POI_CATEGORIES.map(c => POI_THRESHOLD[c.key].ideal);

            // 重新构建 indicator，避免初始化与更新时尺寸不一致导致空白；
            // max 取真实最大值、理想值、最低值中的最大者，保证雷达刻度与真实数量对齐
            const dataMax = Math.max(...actualData, ...idealLine, ...minLine, 6);
            const indicator = POI_CATEGORIES.map(c => ({
                name: c.name,
                max: dataMax
            }));
            this.radarInst.setOption({
                radar: {
                    indicator,
                    center: ['50%', '52%'],
                    radius: '54%',
                    name: { textStyle: { color: '#8a9ec0', fontSize: 11 }, padding: [2, 4] },
                    axisLine: { lineStyle: { color: 'rgba(120,180,255,0.10)' } },
                    splitLine: { lineStyle: { color: 'rgba(120,180,255,0.10)' } },
                    splitArea: { areaStyle: { color: ['rgba(91,155,255,0.03)', 'rgba(91,155,255,0.06)'] } }
                },
                legend: {
                    data: ['实际', '理想', '最低'],
                    top: 2, right: 6,              // 图例放右上角，避开底部"市场"标签
                    textStyle: { color: '#8a9ec0', fontSize: 11 },
                    itemWidth: 14, itemHeight: 6,
                    itemGap: 10
                },
                series: [{
                    type: 'radar',
                    data: [
                        { value: actualData, name: '实际', itemStyle: { color: '#5b9bff' }, lineStyle: { color: '#5b9bff' }, areaStyle: { color: 'rgba(58,122,254,0.40)' } },
                        { value: idealLine, name: '理想', itemStyle: { color: '#00d68f' }, lineStyle: { color: '#00d68f' }, areaStyle: { color: 'rgba(0,214,143,0.20)' } },
                        { value: minLine, name: '最低', itemStyle: { color: '#ffb547' }, lineStyle: { color: '#ffb547' }, areaStyle: { color: 'rgba(255,181,71,0.15)' } }
                    ]
                }]
            });

            // 柱状图
            const barData = POI_CATEGORIES.map(c => {
                const g = resultByKey[c.key];
                const n = g ? g.items.length : 0;
                return { value: n, itemStyle: { color: c.color } };
            });
            // replaceMerge:'series' —— 从对比模式的双系列切回单系列时，清掉多余的 B 系列
            // ⚠ replaceMerge 会用新 series **整体替换**旧 series（不做属性合并），
            //    因此 type / barWidth / itemStyle 必须在这里写全，否则旧配置被丢弃 → 柱子画不出来
            this.barInst.setOption({
                legend: { data: [] },   // 清掉对比模式的 A/B 图例
                grid: { left: 48, right: 14, top: 14, bottom: 36 },
                series: [{
                    name: '数量',
                    type: 'bar',
                    data: barData,
                    barWidth: 14,
                    itemStyle: {
                        borderRadius: [6, 6, 0, 0],
                        color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                            colorStops: [
                                { offset: 0, color: '#5b9bff' },
                                { offset: 1, color: '#3a7afe' }
                            ]},
                        shadowBlur: 10,
                        shadowColor: 'rgba(58,122,254,0.5)'
                    },
                    label: { show: true, position: 'top', color: '#e6f0ff', fontSize: 11 }
                }]
            }, { replaceMerge: 'series' });
        },

        /**
         * 对比模式：右侧看板切换为 A/B 并排视图
         * @param {Object|null} rA Compare.results[0]（addr/score/area/resultByKey/breakdown）
         * @param {Object|null} rB Compare.results[1]
         * 单地址 DOM 全部保留只隐藏，退出对比时 exitCompare() 无缝还原。
         */
        renderCompare: function (rA, rB) {
            if (!rA || !rB) return this.exitCompare();

            const scoreBody = document.querySelector('.score-card .score-body');
            const scoreCmp  = document.getElementById('scoreCompareBody');
            const poiList   = document.getElementById('poiCountList');
            const poiCmp    = document.getElementById('poiCompareList');
            const gapBody   = document.getElementById('gapBody');
            const gapCmp    = document.getElementById('gapCompareBody');

            // 首次进入对比：记下单地址模式的卡片标签文案，便于还原
            if (!this._inCompare) {
                const scoreTag = document.getElementById('scoreTag');
                const poiTag   = document.getElementById('poiTotalTag');
                this._cmpTags = {
                    score: scoreTag ? scoreTag.textContent : '',
                    poi:   poiTag ? poiTag.textContent : ''
                };
                this._inCompare = true;
            }

            // —— 1. 评分卡：A/B 两张迷你卡，胜出方高亮 ——
            const lvlA = Util.scoreLevel(rA.score), lvlB = Util.scoreLevel(rB.score);
            const winA = rA.score >= rB.score, winB = rB.score > rA.score;
            const poiA = totalPoiOf(rA.resultByKey), poiB = totalPoiOf(rB.resultByKey);
            if (scoreCmp) {
                scoreCmp.innerHTML = this._miniScoreCard('A', rA, lvlA, winA, poiA)
                                   + this._miniScoreCard('B', rB, lvlB, winB, poiB);
            }
            if (scoreBody) scoreBody.style.display = 'none';
            if (scoreCmp)  scoreCmp.hidden = false;

            const scoreTag = document.getElementById('scoreTag');
            if (scoreTag) {
                const winner = (rA.score > rB.score) ? 'A' : (rB.score > rA.score) ? 'B' : null;
                scoreTag.textContent = winner ? (winner + ' 更优 ' + Math.max(rA.score, rB.score)) : '平手';
                const c = (rA.score >= rB.score ? lvlA : lvlB).color;
                scoreTag.style.color = c; scoreTag.style.borderColor = c + '60'; scoreTag.style.background = c + '15';
            }

            // —— 2. 配套统计：每类 A/B 两列数量，多的一方高亮 ——
            if (poiCmp) {
                let html = '';
                POI_CATEGORIES.forEach(cat => {
                    const na = cntOf(rA.resultByKey, cat.key);
                    const nb = cntOf(rB.resultByKey, cat.key);
                    html += `
                    <div class="pc-row">
                        <div class="ico" style="background:${cat.color}25;color:${cat.color}">${cat.icon}</div>
                        <div class="pc-name">${cat.name}<small> · 建议≥${POI_THRESHOLD[cat.key].ideal}</small></div>
                        <span class="pc-cnt ${na > nb ? 'win-a' : ''}" title="地址 A">A <b>${na}</b></span>
                        <span class="pc-cnt ${nb > na ? 'win-b' : ''}" title="地址 B">B <b>${nb}</b></span>
                    </div>`;
                });
                poiCmp.innerHTML = html;
            }
            if (poiList) poiList.style.display = 'none';
            if (poiCmp)  poiCmp.hidden = false;
            const poiTag = document.getElementById('poiTotalTag');
            if (poiTag) poiTag.textContent = `A ${poiA} 项 · B ${poiB} 项`;

            // —— 2.5 全龄友好评分：A/B 双列对比（与单地址体检同源，复用各自地址真实路网上计算的 perType）——
            const ptBox = document.getElementById('perTypeScores');
            if (ptBox && rA.perType && rB.perType) {
                ptBox.innerHTML = this._renderPerTypeCompare(rA.perType, rB.perType);
            }

            // —— 2.6 无障碍可达性达标率：A/B 双列对比（最近设施实测 × GB 50180-2018，独有轮椅维度）——
            const acBox = document.getElementById('accessBody');
            if (acBox && rA.accessibility && rB.accessibility) {
                acBox.innerHTML = Accessibility.renderCompare(rA.accessibility, rB.accessibility);
            } else if (acBox) {
                acBox.innerHTML = '<p class="gap-empty muted">地址 A / B 暂无可比的无障碍可达性数据。</p>';
            }

            // —— 2.7 选址推荐：A/B 双列对比（针对盲区贪心选点）——
            const rcBox = document.getElementById('recommendBody');
            if (rcBox && rA.recommendation && rB.recommendation) {
                rcBox.innerHTML = Recommend.renderCompare(rA.recommendation, rB.recommendation);
            } else if (rcBox) {
                rcBox.innerHTML = '<p class="gap-empty muted">地址 A / B 暂无补点建议数据。</p>';
            }

            // —— 3. 盲区卡：先给占位，A/B 真实盲区分析完成后由 renderGapCompare 填充 ——
            if (gapBody) gapBody.style.display = 'none';
            if (gapCmp) {
                gapCmp.hidden = false;
                gapCmp.innerHTML = this._gapCompareHtml(null, null);
            }
            // 对比模式下禁用"显示点位"：地图此时是 A/B 双等时圈 + 双 POI，
            // 再叠单地址的盲区点位图会互相干扰（点位图请切回单地址模式查看）
            const gapBtn = document.getElementById('btnGapToggle');
            if (gapBtn) {
                this._gapBtnDisabled = gapBtn.disabled;   // 记下原状态，退出对比时还原
                gapBtn.disabled = true;
                gapBtn.classList.remove('active');
            }

            // —— 4. 雷达：A/B 两组数据叠加（A 蓝 / B 橙，与地图配色一致） ——
            if (this.radarInst) {
                const valsA = this._radarVals(rA.resultByKey);
                const valsB = this._radarVals(rB.resultByKey);
                // 对比模式刻度上限取 A/B 真实最大，避免单地址小刻度导致数值溢出
                const compareMax = Math.max(...valsA, ...valsB, 6);
                this.radarInst.setOption({
                    radar: {
                        indicator: POI_CATEGORIES.map(c => ({ name: c.name, max: compareMax }))
                    },
                    legend: {
                        data: ['A·实际', 'B·实际'],
                        top: 2, right: 6,
                        textStyle: { color: '#8a9ec0', fontSize: 11 },
                        itemWidth: 14, itemHeight: 6, itemGap: 10
                    },
                    series: [{
                        type: 'radar',
                        data: [
                            { value: valsA, name: 'A·实际', itemStyle: { color: '#5b9bff' }, lineStyle: { color: '#5b9bff', width: 2 }, areaStyle: { color: 'rgba(58,122,254,0.30)' } },
                            { value: valsB, name: 'B·实际', itemStyle: { color: '#ff9f43' }, lineStyle: { color: '#ff9f43', width: 2 }, areaStyle: { color: 'rgba(255,159,67,0.25)' } }
                        ]
                    }]
                });
            }

            // —— 5. 柱状图：分组柱 A/B 并排 ——
            if (this.barInst) {
                const mk = (r) => POI_CATEGORIES.map(c => ({ value: cntOf(r.resultByKey, c.key) }));
                this.barInst.setOption({
                    legend: {
                        data: ['A', 'B'], top: 0, right: 6,
                        textStyle: { color: '#8a9ec0', fontSize: 11 },
                        itemWidth: 14, itemHeight: 8
                    },
                    grid: { left: 48, right: 14, top: 24, bottom: 36 },
                    series: [
                        { name: 'A', type: 'bar', data: mk(rA), barWidth: 9, barGap: '30%',
                          itemStyle: { borderRadius: [4, 4, 0, 0], color: '#5b9bff' },
                          label: { show: true, position: 'top', color: '#9fc0ff', fontSize: 9 } },
                        { name: 'B', type: 'bar', data: mk(rB), barWidth: 9,
                          itemStyle: { borderRadius: [4, 4, 0, 0], color: '#ff9f43' },
                          label: { show: true, position: 'top', color: '#ffc38f', fontSize: 9 } }
                    ]
                }, { replaceMerge: 'series' });
            }
        },

        /**
         * 对比模式：填充「服务盲区识别」卡的 A/B 对比内容
         * @param {Object|null} gapA GapFinder.analyze() 结果（地址 A）
         * @param {Object|null} gapB 地址 B
         * 传 null 时渲染"识别中"占位；分析失败时降级为最近距离对比。
         */
        renderGapCompare: function (gapA, gapB) {
            const gapCmp = document.getElementById('gapCompareBody');
            if (!gapCmp || !this._inCompare) return;   // 已退出对比就不再回填，避免覆盖单地址数据
            gapCmp.innerHTML = this._gapCompareHtml(gapA, gapB);
        },

        /** 盲区卡 A/B 对比的 HTML（null = 识别中占位） */
        _gapCompareHtml: function (gapA, gapB) {
            const okA = !!(gapA && gapA.enabled);
            const okB = !!(gapB && gapB.enabled);

            // —— 占位：还没跑完（gapA/gapB 均为 null） ——
            if (gapA == null && gapB == null) {
                return '<p class="gap-empty muted">正在识别 A / B 两地的服务盲区点位…（栅格采样 + 步行距离标定）</p>';
            }

            // col() 只返回列内内容，外层 .gc-col 由下面统一包（便于加 win 高亮）
            const col = (tag, gap) => {
                if (!gap || !gap.enabled) {
                    return `
                        <div class="gc-head"><span class="sc-tag tag-${tag.toLowerCase()}">${tag}</span><b>未识别</b></div>
                        <div class="gc-line muted">${escapeHtmlD((gap && gap.reason) || '该地址盲区数据不可用')}</div>`;
                }
                const ratioPct = (gap.gapRatio * 100).toFixed(1);
                const areaHa   = (gap.gapAreaM2 / 1e4).toFixed(1);
                const amber = '#ffb547', green = '#00d68f';
                const c = gap.gapCount ? amber : green;
                return `
                    <div class="gc-head">
                        <span class="sc-tag tag-${tag.toLowerCase()}">${tag}</span>
                        <span class="sc-badge" style="color:${c};border-color:${c}66;background:${c}18">${gap.gapCount ? '存在盲区' : '无盲区'}</span>
                    </div>
                    <div class="gc-line"><span>盲区点位占比</span><b>${ratioPct}<small>%</small></b></div>
                    <div class="gc-line"><span>盲区面积</span><b>${areaHa}<small> 公顷</small></b></div>
                    <div class="gc-line"><span>重度点位</span><b>${gap.severeCount}<small> / ${gap.gridCount}</small></b></div>
                    <div class="gc-line"><span>绕行系数 λ</span><b>${gap.lambda.toFixed(2)}</b></div>`;
            };

            // 胜出方 = 盲区占比更低者（绿色高亮）
            const ra = okA ? gapA.gapRatio : null;
            const rb = okB ? gapB.gapRatio : null;
            let note = '';
            if (ra !== null && rb !== null) {
                if (Math.abs(ra - rb) < 0.005) note = '两址盲区占比基本持平。';
                else {
                    const win = ra < rb ? 'A' : 'B';
                    const d = Math.abs(ra - rb) * 100;
                    note = `地址 <b>${win}</b> 盲区占比更低（低 ${d.toFixed(1)} 个百分点），${(global.WALK_MINUTES || 15)} 分钟生活圈覆盖更完整。`;
                }
            } else if (ra === null && rb === null) {
                note = '两地均未能完成盲区识别，请切回单地址模式查看详细栅格结果。';
            } else {
                note = `仅地址 <b>${ra !== null ? 'A' : 'B'}</b> 完成盲区识别，另一地址数据不可用。`;
            }

            const params = (gapA && gapA.params) || (gapB && gapB.params) || {};
            return `
            <div class="gc-grid">
                <div class="gc-col ${(ra !== null && rb !== null && ra < rb) ? 'win' : ''}">${col('A', gapA)}</div>
                <div class="gc-col ${(ra !== null && rb !== null && rb < ra) ? 'win' : ''}">${col('B', gapB)}</div>
            </div>
            <p class="gc-note">${note}</p>
            <p class="gap-note">判定口径：${(global.WALK_MINUTES || 15)} 分钟步行范围内，菜市场 / 药店 / 学校 三类步行距离均 > ${params.radiusMeters || 1000} m 的点位（地图点位图仅展示单地址模式）。</p>`;
        },

        /** 迷你评分卡（A/B 共用） */
        _miniScoreCard: function (tag, r, lvl, win, poiTotal) {
            return `
            <div class="sc-mini ${win ? 'win' : ''}">
                <div class="sc-head">
                    <span class="sc-tag tag-${tag.toLowerCase()}">${tag}</span>
                    <span class="sc-badge" style="color:${lvl.color};border-color:${lvl.color}66;background:${lvl.color}18">${lvl.text}</span>
                    ${win ? '<span class="sc-lead">▲ 领先</span>' : ''}
                </div>
                <div class="sc-score" style="color:${lvl.color}">${r.score}<i>/100</i></div>
                <div class="sc-meta">
                    <span class="sc-addr" title="${escapeHtmlD(r.addr)}">${escapeHtmlD(r.addr)}</span>
                    <span>${(r.area / 1e6).toFixed(2)} km² · POI ${poiTotal} 项</span>
                </div>
            </div>`;
        },

        /** 雷达数值（与单地址/图例/柱状图口径一致：用真实数量，不封顶） */
        _radarVals: function (resultByKey) {
            return POI_CATEGORIES.map(c => {
                const g = resultByKey ? resultByKey[c.key] : null;
                return g && g.items ? g.items.length : 0;
            });
        },

        /** 退出对比模式：还原单地址看板 */
        exitCompare: function () {
            if (!this._inCompare) return;
            this._inCompare = false;

            const scoreBody = document.querySelector('.score-card .score-body');
            const scoreCmp  = document.getElementById('scoreCompareBody');
            const poiList   = document.getElementById('poiCountList');
            const poiCmp    = document.getElementById('poiCompareList');
            const gapBody   = document.getElementById('gapBody');
            const gapCmp    = document.getElementById('gapCompareBody');
            if (scoreBody) scoreBody.style.display = '';
            if (scoreCmp)  scoreCmp.hidden = true;
            if (poiList)   poiList.style.display = '';
            if (poiCmp)    poiCmp.hidden = true;
            if (gapBody)   gapBody.style.display = '';
            if (gapCmp)    gapCmp.hidden = true;

            // 还原"显示点位"按钮状态（对比模式期间被临时禁用）
            const gapBtn = document.getElementById('btnGapToggle');
            if (gapBtn) {
                gapBtn.disabled = (this._gapBtnDisabled !== false);
                this._gapBtnDisabled = null;
            }

            // 还原卡片标签
            const t = this._cmpTags || {};
            const scoreTag = document.getElementById('scoreTag');
            const poiTag   = document.getElementById('poiTotalTag');
            if (scoreTag) { scoreTag.textContent = t.score || '未体检'; scoreTag.style.color = ''; scoreTag.style.borderColor = ''; scoreTag.style.background = ''; }
            if (poiTag)   poiTag.textContent = t.poi || '0 项';
            this._cmpTags = null;

            // 雷达/柱状图还原为最近一次单地址数据（无则清空）
            this.renderCharts(this._lastSingle || {});
            // 全龄友好评分卡还原为最近一次单地址数据（无则清空）
            this.renderPerType(this._lastPerType || []);
            // 无障碍可达性达标率卡还原为最近一次单地址数据（无则清空占位）
            this.renderAccessibility(this._lastAccessibility || null);
            // 选址推荐卡还原为最近一次单地址数据（无则清空占位）
            this.renderRecommend(this._lastRecommendation || null);
        },

        /**
         * 评分算法（v3.1.0 重构·二次增强）
         *
         * 初版问题：3 个不同小区都拿了 94-95 分，区分度不够
         *   → 因为只统计"POI 总数"时，城区和近郊的数量级都溢出 ideal，全部吃满 90+。
         *
         * 二次增强：再增加【就近便利度】维度（按"中心点 → 最近一处该类 POI"的步行距离打分），
         *          距离衰减曲线区分"密集城区"（200m 内有医院）和"偏远郊区"（>2km 还找不到）。
         *
         * 最终 4 维加权：
         *  (一) 配套完整度 30% —— 该类 POI 数量相对 ideal 的占比（4 段线性）
         *  (二) 就近便利度 35% —— 中心点到最近一处该类 POI 的步行距离（5 档距离衰减）
         *  (三) 等时圈覆盖 20% —— 可达面积 < 1.5 km² 严重扣分
         *  (四) 类别多样性 15% —— 全部民生配套类别都≥1 处才能拿满分（按类别数动态归一）
         */

        /**
         * 各人群（全龄/适老/无障碍）评分 —— 真实路网计算（与地图体检同源）。
         * 不再用数学近似：复用 runAnalysis 已采样的 16 向完整步行路径（fullPaths），
         * 按第 t 类人的「速度 × 时长」截断出该类的真实可达多边形，
         * 用 pointInPolygon 统计落在其内的各类 POI，再走与单地址体检完全相同的 calcScore。
         * 这样「全龄友好评分」与「把该类人设为（主人群）重新体检」得到的分数完全一致。
         * @param {Array} types        global.WALK_TYPES
         * @param {BMapGL.Point} center 体检中心
         * @param {Array<Array<{lng,lat}>>} fullPaths buildPaths 返回的 16 向完整路径
         * @param {number} minutes      生活圈时长（分钟）
         * @param {string} activeKey    主人群 key
         * @param {Object} resultByKey  主人群检索到的 POI（每类 items 含 .point，供 pointInPolygon 过滤）
         * @returns {Array<{key,label,color,speed,areaKm2,score,isActive}>}
         */
        perTypeScores: function (types, center, fullPaths, minutes, activeKey, resultByKey) {
            const m = minutes || 15;
            const cats = (typeof POI_CATEGORIES !== 'undefined') ? POI_CATEGORIES : [];
            return (types || []).map(function (t) {
                const targetDist = t.speed * m;
                // 用共享的 16 向完整路径，按该类速度截断出真实可达多边形顶点
                const boundary = (fullPaths || []).map(function (fp) {
                    if (!fp || fp.length < 2) return null;
                    const p = Util.pointAtDistance(fp, targetDist);
                    return p || fp[fp.length - 1];
                }).filter(Boolean);

                let areaKm2 = 0, score = 0;
                if (boundary.length >= 3) {
                    const pts = boundary.map(function (p) { return { lng: p.lng, lat: p.lat }; });
                    areaKm2 = Util.polygonArea(pts) / 1e6;
                    // 统计落在该真实多边形内的 POI（逐类过滤，复用 calcScore 的同一套权重与口径）
                    const rk = {};
                    cats.forEach(function (cat) {
                        const g = resultByKey ? resultByKey[cat.key] : null;
                        const items = (g && g.items) ? g.items : [];
                        rk[cat.key] = {
                            items: items.filter(function (it) {
                                return it.point && Util.pointInPolygon(it.point, pts);
                            })
                        };
                    });
                    score = Dashboard.calcScore(rk, areaKm2 * 1e6, center).score;
                }
                return {
                    key: t.key, label: t.label, color: t.color, speed: t.speed,
                    areaKm2: +areaKm2.toFixed(2),
                    score: Math.round(score),
                    isActive: t.key === activeKey
                };
            });
        },

        /**
         * 渲染右侧「全龄友好评分」条：5 类人群各一条彩色进度条（与地图图例配色一致），
         * 当前主人群高亮并标「主」。差距一眼可见，直观呈现适老/无障碍友好程度。
         */
        renderPerType: function (perType) {
            const box = document.getElementById('perTypeScores');
            if (!box) return;
            if (!perType || !perType.length) { box.innerHTML = ''; return; }
            this._lastPerType = perType;   // 缓存，供退出对比模式时还原单地址视图
            const max = 100;
            box.innerHTML = perType.map(function (p) {
                const pct = Math.max(2, Math.min(100, (p.score / max) * 100));
                const activeCls = p.isActive ? ' is-active' : '';
                const mainTag = p.isActive ? '<span class="pt-main">主</span>' : '';
                return '<div class="pt-row' + activeCls + '" data-key="' + p.key + '">'
                    +   '<span class="pt-dot" style="background:' + p.color + '"></span>'
                    +   '<span class="pt-label">' + p.label + mainTag + '</span>'
                    +   '<span class="pt-track"><span class="pt-fill" style="width:' + pct + '%;background:' + p.color + '"></span></span>'
                    +   '<span class="pt-score">' + p.score + '</span>'
                    + '</div>';
            }).join('');
        },

        /**
         * 渲染「无障碍可达性达标率」卡（单地址模式）。
         * 写入 #accessBody，并缓存供退出对比模式时还原单地址视图。
         * @param {Object|null} access Accessibility.compute 的返回（null=清空占位）
         */
        renderAccessibility: function (access) {
            const box = document.getElementById('accessBody');
            if (!box) return;
            this._lastAccessibility = access;   // 缓存，供退出对比模式时还原单地址视图
            Accessibility.render(access, 'accessBody');
        },

        /**
         * 渲染「选址推荐」卡（单地址模式）。
         * 写入 #recommendBody，并缓存供退出对比模式时还原单地址视图。
         * @param {Object|null} rec Recommend.compute 的返回（null=清空占位）
         */
        renderRecommend: function (rec) {
            const box = document.getElementById('recommendBody');
            if (!box) return;
            this._lastRecommendation = rec;   // 缓存，供退出对比模式时还原单地址视图
            Recommend.render(rec, 'recommendBody');
        },

        /**
         * 对比模式：全龄友好评分 A/B 双列对比。
         * 把两地址各自（在真实路网上）算出的各人群评分并排，分数高的一方整行高亮。
         * @param {Array} pa A 地址的 perTypeScores 结果
         * @param {Array} pb B 地址的 perTypeScores 结果
         */
        _renderPerTypeCompare: function (pa, pb) {
            const mapA = {}, mapB = {};
            pa.forEach(p => { mapA[p.key] = p; });
            pb.forEach(p => { mapB[p.key] = p; });
            const order = pa.length ? pa : pb;
            if (!order.length) return '';
            let html = '';
            order.forEach(function (t) {
                const a = mapA[t.key], b = mapB[t.key];
                if (!a || !b) return;
                html += '<div class="pt-row pt-cmp" data-key="' + t.key + '">'
                    +   '<span class="pt-dot" style="background:' + t.color + '"></span>'
                    +   '<span class="pt-label">' + t.label + '</span>'
                    +   '<span class="pt-cnt a">A <b>' + a.score + '</b></span>'
                    +   '<span class="pt-cnt b">B <b>' + b.score + '</b></span>'
                    + '</div>';
            });
            return html;
        },

        calcScore: function (resultByKey, areaM2, center) {
            const missedCategories = [];
            const nearestDist = {};     // 各类到中心点的最近距离（米）
            const centerLat = (center && typeof center.lat === 'number') ? center.lat : null;
            const centerLng = (center && typeof center.lng === 'number') ? center.lng : null;

            // (一)(二) 同时计算 数量得分 + 最近距离
            let completenessWeighted = 0, weightSum = 0;
            let coveredCategory = 0;
            let proxSum = 0, proxWeightSum = 0;

            POI_CATEGORIES.forEach(cat => {
                const g = resultByKey[cat.key];
                const items = (g && g.items) ? g.items : [];
                const n = items.length;
                const th = POI_THRESHOLD[cat.key];
                const w = th.weight;

                // === (一) 数量得分（0~95） ===
                let sCount;
                if (n === 0) sCount = 0;
                else if (n <= th.min)     sCount = 60 * (n / Math.max(1, th.min));
                else if (n <= th.ideal)   sCount = 60 + 30 * ((n - th.min) / Math.max(1, th.ideal - th.min));
                else                      sCount = 90 + 5 * Math.min(1, Math.log(1 + (n - th.ideal) / Math.max(1, th.ideal)) / Math.log(3));
                if (sCount > 95) sCount = 95;

                if (n < th.min) missedCategories.push(cat.name);
                completenessWeighted += sCount * w;
                weightSum += w;
                if (n >= 1) coveredCategory++;

                // === (二) 就近便利度：找出该类所有 POI 离中心点的最近距离 ===
                if (n > 0 && centerLat !== null && centerLng !== null) {
                    let minD = Infinity;
                    for (const it of items) {
                        if (!it.point) continue;
                        const d = Util.distance(
                            { lng: centerLng, lat: centerLat },
                            { lng: it.point.lng, lat: it.point.lat }
                        );
                        if (d < minD) minD = d;
                    }
                    nearestDist[cat.key] = minD;
                    // 步行距离衰减：≤200m=100，500m=90，800m=75，1200m=55，2000m=25，>3000m=0
                    let sProx;
                    if      (minD <= 200)  sProx = 100;
                    else if (minD <= 500)  sProx = 100 - (minD - 200) / 300 * 10;   // 100 → 90
                    else if (minD <= 800)  sProx = 90  - (minD - 500) / 300 * 15;   // 90 → 75
                    else if (minD <= 1200) sProx = 75  - (minD - 800) / 400 * 20;   // 75 → 55
                    else if (minD <= 2000) sProx = 55  - (minD - 1200) / 800 * 30;  // 55 → 25
                    else if (minD <= 3000) sProx = 25  - (minD - 2000) / 1000 * 25; // 25 → 0
                    else                   sProx = 0;
                    proxSum += sProx * w;
                    proxWeightSum += w;
                } else {
                    // 没数据时该项 0 分，相当于严重扣分
                    proxSum += 0;
                    proxWeightSum += w;
                }
            });

            const completeness = weightSum > 0 ? completenessWeighted / weightSum : 0;
            const proximity    = proxWeightSum > 0 ? proxSum / proxWeightSum : 0;

            // (三) 等时圈覆盖（按 3.0 km² 满分；1.0 km² 硬下限）
            const areaKm2 = (areaM2 || 0) / 1e6;
            const coverage = coverageFromArea(areaKm2);

            // (四) 类别多样性：满分 = 全部类别都≥1 处（按类别数动态归一，避免拆分类别后超分）
            const nCat = POI_CATEGORIES.length;
            const diversity = nCat > 0 ? (coveredCategory / nCat) * 100 : 0;

            const total = completeness * 0.30 + proximity * 0.35 + coverage * 0.20 + diversity * 0.15;

            return {
                score: Util.clamp(Math.round(total), 0, 100),
                missedCategories,
                nearestDist,
                breakdown: {
                    completeness: Math.round(completeness),
                    proximity:    Math.round(proximity),
                    coverage:     Math.round(coverage),
                    diversity:    Math.round(diversity),
                    areaKm2:      +areaKm2.toFixed(2),
                    nearestSummary: POI_CATEGORIES.map(c => ({
                        name: c.name,
                        key:  c.key,
                        dist: nearestDist[c.key] != null ? Math.round(nearestDist[c.key]) : null
                    }))
                }
            };
        },

        /**
         * 计算可达面积 km²
         */
        setArea: function (areaM2) {
            const el = document.getElementById('metaArea');
            if (el) el.textContent = (areaM2 / 1e6).toFixed(2) + ' km²';
        },

        setCenter: function (address) {
            const el = document.getElementById('metaCenter');
            if (el) el.textContent = address;
        }
    };

    /* ========== 对比模式辅助 ========== */
    function cntOf(resultByKey, key) {
        const g = resultByKey ? resultByKey[key] : null;
        return (g && g.items) ? g.items.length : 0;
    }

    /**
     * 等时圈覆盖得分（私有，calcScore 与 perTypeScores 共用）
     * 按可达面积 km² 分段：≤0→0；<1.0→25×(a/1.0)；<3.0→25+75×((a-1)/2)；≥3.0→100
     */
    function coverageFromArea(areaKm2) {
        if (areaKm2 <= 0)      return 0;
        if (areaKm2 < 1.0)     return 25 * (areaKm2 / 1.0);
        if (areaKm2 < 3.0)     return 25 + 75 * ((areaKm2 - 1.0) / 2.0);
        return 100;
    }
    function totalPoiOf(resultByKey) {
        if (!resultByKey) return 0;
        let sum = 0;
        Object.values(resultByKey).forEach(g => { sum += (g && g.items) ? g.items.length : 0; });
        return sum;
    }
    function escapeHtmlD(s) {
        return (s == null ? '' : String(s))
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    global.Dashboard = Dashboard;
})(window);
