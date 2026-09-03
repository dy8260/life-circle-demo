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
                tooltip: { trigger: 'item' },
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
                tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
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
         * 判定口径（对齐赛题任务书 2.3）：
         *   菜市场 / 药店 / 小学 三类的步行距离**全部** > 1 km 的点 → 服务盲区点位
         */
        renderGap: function (gap) {
            const box = document.getElementById('gapBody');
            if (!box) return;
            const btn = document.getElementById('btnGapToggle');

            if (!gap || !gap.enabled) {
                box.innerHTML = '<p class="gap-empty muted">完成体检后自动识别：15 分钟步行范围内，' +
                    '<b>1 公里内没有菜市场 / 药店 / 小学</b>的点位。</p>';
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
                <span><i style="background:#ff5470"></i>重度（三类均 > ${p.severeMeters || 1500} m）</span>
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
                html.push('<p class="gap-none">🎉 未发现服务盲区：范围内所有点位 1 km 内均可到达菜市场 / 药店 / 小学。</p>');
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
         * 地图图例：盲区色块（仅在有盲区时显示）
         */
        renderGapLegend: function (gap) {
            const ul = document.getElementById('gapLegendList');
            if (!ul) return;
            if (!gap || !gap.enabled || !gap.gapCount) { ul.hidden = true; ul.innerHTML = ''; return; }

            const p = gap.params || {};
            ul.innerHTML = `
                <li><i class="dot" style="background:#ffb547"></i>一般盲区（1~${((p.severeMeters || 1500) / 1000).toFixed(1)} km 无三类配套）</li>
                <li><i class="dot" style="background:#ff5470"></i>重度盲区（${((p.severeMeters || 1500) / 1000).toFixed(1)} km 以上无三类配套）</li>`;
            ul.hidden = false;
        },

        /**
         * 填充雷达 + 柱状图
         */
        renderCharts: function (resultByKey) {
            if (!this.radarInst || !this.barInst) return;
            this._lastSingle = resultByKey || {};   // 缓存最近一次单地址数据，供 exitCompare 还原

            // 雷达：实际 vs 最低 vs 理想
            const actualData = POI_CATEGORIES.map(c => {
                const g = resultByKey[c.key];
                const n = g ? g.items.length : 0;
                return Math.min(n, POI_THRESHOLD[c.key].ideal + 2);
            });
            const minLine  = POI_CATEGORIES.map(c => POI_THRESHOLD[c.key].min);
            const idealLine = POI_CATEGORIES.map(c => POI_THRESHOLD[c.key].ideal);

            // 重新构建 indicator，避免初始化与更新时尺寸不一致导致空白
            const indicator = POI_CATEGORIES.map(c => ({
                name: c.name,
                max: Math.max(POI_THRESHOLD[c.key].ideal + 2, 6)
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
                this.radarInst.setOption({
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
                    note = `地址 <b>${win}</b> 盲区占比更低（低 ${d.toFixed(1)} 个百分点），15 分钟生活圈覆盖更完整。`;
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
            <p class="gap-note">判定口径：15 分钟步行范围内，菜市场 / 药店 / 小学 三类步行距离均 > ${params.radiusMeters || 1000} m 的点位（地图点位图仅展示单地址模式）。</p>`;
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

        /** 雷达数值（封顶 ideal+2，与单地址口径一致） */
        _radarVals: function (resultByKey) {
            return POI_CATEGORIES.map(c => {
                const g = resultByKey ? resultByKey[c.key] : null;
                return Math.min(g && g.items ? g.items.length : 0, POI_THRESHOLD[c.key].ideal + 2);
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
            let coverage;
            if (areaKm2 <= 0)       coverage = 0;
            else if (areaKm2 < 1.0) coverage = 25 * (areaKm2 / 1.0);
            else if (areaKm2 < 3.0) coverage = 25 + 75 * ((areaKm2 - 1.0) / 2.0);
            else                    coverage = 100;

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
