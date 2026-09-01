/**
 * 右侧数据看板
 * - 评分环
 * - POI 数量列表（带状态色）
 * - 雷达图（实际 vs 理想）
 * - 柱状图（5 类数量）
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

            // 雷达图
            const indicator = POI_CATEGORIES.map(c => ({ name: c.name + '\n最少' + POI_THRESHOLD[c.key].min, max: Math.max(POI_THRESHOLD[c.key].ideal + 2, 6) }));
            radar.setOption({
                backgroundColor: 'transparent',
                tooltip: { trigger: 'item' },
                radar: {
                    indicator,
                    center: ['50%', '55%'],
                    radius: '62%',
                    name: { textStyle: { ...axisLabelStyle, fontSize: 12 }, padding: [3, 6] },
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
                grid: { left: 56, right: 18, top: 18, bottom: 26 },
                xAxis: {
                    type: 'category',
                    data: POI_CATEGORIES.map(c => c.name),
                    axisLabel: axisLabelStyle,
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
                    barWidth: 18,
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
         * 填充雷达 + 柱状图
         */
        renderCharts: function (resultByKey) {
            if (!this.radarInst || !this.barInst) return;

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
                name: c.name + '\n最少' + POI_THRESHOLD[c.key].min,
                max: Math.max(POI_THRESHOLD[c.key].ideal + 2, 6)
            }));
            this.radarInst.setOption({
                radar: {
                    indicator,
                    center: ['50%', '55%'],
                    radius: '62%',
                    name: { textStyle: { color: '#8a9ec0', fontSize: 12 }, padding: [3, 6] },
                    axisLine: { lineStyle: { color: 'rgba(120,180,255,0.10)' } },
                    splitLine: { lineStyle: { color: 'rgba(120,180,255,0.10)' } },
                    splitArea: { areaStyle: { color: ['rgba(91,155,255,0.03)', 'rgba(91,155,255,0.06)'] } }
                },
                legend: {
                    data: ['实际', '理想', '最低'],
                    bottom: 0, textStyle: { color: '#8a9ec0', fontSize: 11 },
                    itemWidth: 14, itemHeight: 6
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
            this.barInst.setOption({
                series: [{
                    data: barData,
                    label: { show: true, position: 'top', color: '#e6f0ff', fontSize: 11 }
                }]
            });
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
         *  (四) 类别多样性 15% —— 5 类民生配套全都≥1 处才能拿满分
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

            // (四) 类别多样性
            const diversity = coveredCategory * 20;

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

    global.Dashboard = Dashboard;
})(window);
