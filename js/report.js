/**
 * 体检报告生成器
 *
 * 报告分四段：① 概览 ② 优势 ③ 不足与缺失 ④ 改造建议
 * 优点评价：n>=ideal → 充分、n>=min → 达标、n>0 → 基本覆盖、n=0 → 严重缺失
 */
(function (global) {
    'use strict';

    const Report = {

        /**
         * 生成报告并渲染到 #reportSingle
         * @returns {string} 报告纯文本（用于复制/导出）
         */
        build: function (center, resultByKey, areaM2, score, missedCategories, breakdown, gap) {
            const T = global.THEME || {};
            const lvl = Util.scoreLevel(score);

            // ----- 数据准备 -----
            const CAT_COUNT = POI_CATEGORIES.length;
            const CAT_NAMES = POI_CATEGORIES.map(c => c.name).join(' / ');
            let total = 0;
            const sufficient = [], adequate = [], lacking = [], missing = [];
            POI_CATEGORIES.forEach(cat => {
                const g = resultByKey[cat.key];
                const n = g ? g.items.length : 0;
                const th = POI_THRESHOLD[cat.key];
                total += n;
                if (n >= th.ideal) sufficient.push({ cat, n, th });
                else if (n >= th.min) adequate.push({ cat, n, th });
                else if (n > 0) lacking.push({ cat, n, th });
                else missing.push({ cat, n: 0, th });
            });

            // ----- 评语模板 -----
            const addrEl = document.getElementById('addrInput');
            const addr = (addrEl && addrEl.value ? addrEl.value.trim() : '') || center.address || '未指定地址';

            // 优势评语
            const strengthTips = {
                hospital: '社区医疗资源充足，居民日常就医与应急均较便利',
                pharmacy: '药店分布密集，便民购药与慢病管理覆盖面较好',
                market:   '菜市场可达性良好，生鲜采购与老年人日常买菜便利',
                store:    '商超便利店配套齐备，日常生活采购便捷度高',
                school:   '教育资源布局合理，满足适龄儿童上学需求',
                bus:      '公交/轨交站点多，公共交通可达性较强'
            };
            const weaknessTips = {
                hospital: '医院较少，建议关注急救响应距离，可向属地卫健部门申请增设社区卫生服务中心',
                pharmacy: '药店不足，老年人日常购药可能不便，可发展连锁药店或社区药柜',
                market:   '菜市场缺失或过远，生鲜采购不便，直接影响老年人生活质量（公共服务设施配套盲区判定口径之一）',
                store:    '商超便利店不足，日常生活采购不便，可考虑引入品牌连锁便利店',
                school:   '教育资源有限，需关注入学指标，远距离上学影响家庭生活质量',
                bus:      '公共交通覆盖面弱，建议协调公交集团加密班次或增设站点'
            };

            // ----- HTML 拼接 -----
            const html = [];

            // 报告头
            html.push(`
            <div class="report-header">
                <h2>${escapeHtml(addr)} · 15 分钟生活圈体检报告</h2>
                <span class="level ${lvl.grade}">${lvl.text} ${score} 分</span>
            </div>`);

            // 概览
            html.push(`
            <div class="report-section">
                <h4>① 体检概览</h4>
                <p>本次以<strong>真实步行路网</strong>计算可达圈，可达面积约 <b>${(areaM2 / 1e6).toFixed(2)} km²</b>。
                在 15 分钟步行范围内共检索到 <b>${total}</b> 处民生配套，按 ${escapeHtml(CAT_NAMES)} 共 <b>${CAT_COUNT}</b> 类统计如下。</p>
                <p>综合评分按 <b>"配套完整度 × 30% + 就近便利度 × 35% + 等时圈覆盖 × 20% + 类别多样性 × 15%"</b> 四维加权计算，参考《完整居住社区建设标准》与各地《15 分钟生活圈规划导则》。
                最终得分 <b style="color:${lvl.color}">${score}</b>。</p>
                ${renderBreakdown(breakdown, score)}
            </div>`);

            // 优势
            html.push(`
            <div class="report-section">
                <h4>② 配套优势 (${sufficient.length + adequate.length} 类达标)</h4>`);
            if (sufficient.length === 0 && adequate.length === 0) {
                html.push(`<p class="muted">⚠ 当前 15 分钟步行范围内，${CAT_COUNT} 类配套均未达"理想标准"，建议系统性补齐。</p>`);
            } else {
                html.push('<ul class="report-list">');
                sufficient.forEach(({ cat, n }) => {
                    html.push(`<li>✅ <b>${cat.name}</b> ${n} 处，超过理想门槛（≥${POI_THRESHOLD[cat.key].ideal}）— ${strengthTips[cat.key]}</li>`);
                });
                adequate.forEach(({ cat, n }) => {
                    html.push(`<li>🟢 <b>${cat.name}</b> ${n} 处，达到最低门槛（≥${POI_THRESHOLD[cat.key].min}）— ${strengthTips[cat.key]}</li>`);
                });
                html.push('</ul>');
            }
            html.push('</div>');

            // 不足
            html.push(`
            <div class="report-section">
                <h4>③ 配套不足 (${lacking.length + missing.length} 类需提升)</h4>`);
            if (lacking.length === 0 && missing.length === 0) {
                html.push(`<p>🎉 暂无短板，继续保持当前配套节奏。</p>`);
            } else {
                html.push('<ul class="report-list">');
                lacking.forEach(({ cat, n, th }) => {
                    html.push(`<li>🟡 <b>${cat.name}</b> 仅 ${n} 处，未达最低 ${th.min} 处门槛 — ${weaknessTips[cat.key]}</li>`);
                });
                missing.forEach(({ cat, th }) => {
                    html.push(`<li>🔴 <b>${cat.name}</b> 完全缺失（应至少 ${th.min} 处）— ${weaknessTips[cat.key]}</li>`);
                });
                html.push('</ul>');
            }
            html.push('</div>');

            // 服务盲区识别（核心指标，独立成章）
            html.push(renderGapSection(gap));

            // 改造建议
            html.push(`
            <div class="report-section">
                <h4>⑤ 改造建议</h4>
                <ol class="report-list">`);
            if (missing.length > 0) {
                html.push(`<li><strong>优先补齐缺失类：</strong>${missing.map(x => x.cat.name).join('、')} 是该社区最显著短板，建议在下一轮规划中作为重点。`);
            }
            if (lacking.length > 0) {
                html.push(`<li><strong>提升薄弱类：</strong>针对 ${lacking.map(x => `${x.cat.name}(${x.n} 处)`).join('、')}，可通过引入品牌连锁或社区合作方式来提高密度。`);
            }
            html.push(`<li><strong>慢行系统优化：</strong>等时圈非圆形，建议在等时圈"凹陷"区域（步行绕行严重的方向）研究增设人行天桥、地下通道或人行道拓宽。`);
            html.push(`<li><strong>老年人友好：</strong>80 m/min 的步行速度参照老年慢节奏；可在公交站、医院、菜市场附近设置无障碍坡道与休息座椅。`);
            html.push(`<li><strong>数据回流：</strong>本系统可在街道办、社区居委层面常态化运行，每年更新 POI 数据，对改造效果做闭环评估。</ol>
            </div>`);

            // 渲染
            const el = document.getElementById('reportSingle');
            if (el) el.innerHTML = html.join('');

            // 报告地址（地图右上角也会用到）
            const addrTag = document.getElementById('reportAddr');
            if (addrTag) addrTag.textContent = `${addr} · ${lvl.text} ${score} 分`;

            return this._plainText(addr, lvl, score, areaM2, total, sufficient, adequate, lacking, missing, gap);
        },

        _plainText(addr, lvl, score, areaM2, total, sufficient, adequate, lacking, missing, gap) {
            const lines = [];
            lines.push(`【15 分钟便民生活圈 · 体检报告】`);
            lines.push(`地址：${addr}`);
            lines.push(`综合评分：${score} / 100  (${lvl.text})`);
            lines.push(`可达面积：约 ${(areaM2 / 1e6).toFixed(2)} km²`);
            lines.push(`配套总数：${total} 处`);
            lines.push(``);
            lines.push(`配套情况：`);
            const all = [...sufficient.map(x => ({ ...x, kind: '充分' })),
                         ...adequate.map(x => ({ ...x, kind: '达标' })),
                         ...lacking.map(x => ({ ...x, kind: '偏少' })),
                         ...missing.map(x => ({ ...x, kind: '缺失' }))];
            all.forEach(x => {
                lines.push(` - ${x.cat.name}: ${x.n} 处  [${x.kind}]`);
            });
            lines.push(``);
            lines.push(`服务盲区识别（1 km 内无菜市场 / 药店 / 小学）：`);
            if (!gap || !gap.enabled) {
                lines.push(` - 未执行${gap && gap.reason ? '（' + gap.reason + '）' : ''}`);
            } else {
                lines.push(` - 分析栅格：${gap.gridCount} 点（步长 ${gap.params.gridStepMeters} m）`);
                lines.push(` - 盲区点位：${gap.gapCount} 点（${(gap.gapRatio * 100).toFixed(1)}%），其中重度 ${gap.severeCount} 点`);
                lines.push(` - 盲区面积：约 ${(gap.gapAreaM2 / 1e4).toFixed(2)} 公顷`);
                lines.push(` - 路网绕行系数 λ：${gap.lambda.toFixed(3)}（${gap.lambdaSamples} 个锚点标定${gap.lambdaFallback ? '，样本不足已用经验值' : ''}）`);
                if (gap.patches && gap.patches.length) {
                    gap.patches.forEach((pt, i) => {
                        lines.push(` - 优先斑块 ${i + 1}：${(pt.areaM2 / 1e4).toFixed(2)} 公顷，最近一类平均 ${Math.round(pt.avgGap)} m，最差 ${Math.round(pt.maxGap)} m`);
                    });
                }
            }
            return lines.join('\n');
        }
    };

    /**
     * ④ 服务盲区识别章节
     *
     * 口径严格对齐「15 分钟社区生活圈」公共服务设施配套标准：
     *   「识别出周边 1 公里内没有菜市场、药店或小学的『服务盲区』点位」
     * 这里的"1 公里"按**步行距离**计（直线距离 × 路网绕行系数 λ），
     * 否则会把需要绕行 1.5 km 才能到的点误判成"有配套"。
     *
     * @param {Object} gap  GapFinder.analyze() 的返回值
     */
    function renderGapSection(gap) {
        const head = '<div class="report-section"><h4>④ 服务盲区识别</h4>';

        if (!gap || !gap.enabled) {
            return head +
                `<p class="muted">本次未执行盲区分析${(gap && gap.reason) ? '（' + escapeHtml(gap.reason) + '）' : ''}。</p></div>`;
        }

        const p = gap.params || {};
        const R = p.radiusMeters || 1000;
        const nameOf = (k) => {
            const c = POI_CATEGORIES.find(x => x.key === k);
            return c ? c.name : k;
        };
        const checkNames = (p.checkKeys || []).map(nameOf).join(' / ');
        const marks = ['①', '②', '③', '④', '⑤'];

        const html = [head];

        html.push(`
            <p>本节基于「15 分钟社区生活圈」公共服务设施配套标准，识别<strong>服务盲区点位</strong>：
            以 ${p.gridStepMeters || 120} m 为步长在 15 分钟等时圈内均匀布设 <b>${gap.gridCount}</b> 个分析栅格，
            逐个计算到 <b>${escapeHtml(checkNames)}</b> 三类的<strong>步行</strong>最近距离；
            当三类距离<strong>全部超过 ${R} m</strong> 时，该点位判定为服务盲区。</p>`);

        if (gap.gapCount === 0) {
            html.push(`<p class="gap-none">🎉 未发现服务盲区：范围内 ${gap.gridCount} 个分析点位，均可在 ${R} m 步行距离内到达${escapeHtml(checkNames)}。</p>`);
        } else {
            html.push(`
            <p>共识别到 <b style="color:#ff5470">${gap.gapCount}</b> 个盲区点位，
            占分析范围的 <b>${(gap.gapRatio * 100).toFixed(1)}%</b>，
            盲区面积约 <b>${(gap.gapAreaM2 / 1e4).toFixed(2)} 公顷</b>；
            其中 <b>${gap.severeCount}</b> 个为重度盲区（三类最近距离均超过 ${p.severeMeters || 1500} m）。</p>`);

            // 最差 / 中心点状态
            if (gap.centerStatus) {
                const cs = gap.centerStatus;
                const distTxt = (p.checkKeys || [])
                    .map(k => `${nameOf(k)} ${cs.dist[k]} m`).join('、');
                html.push(`<p>📍 <b>中心点</b>${cs.isGap ? '本身即位于服务盲区内' : '不在服务盲区内'}，
                    三类最近步行距离分别为：${escapeHtml(distTxt)}。</p>`);
            }
            if (gap.worstPoint) {
                html.push(`<p>🚩 <b>最差点位</b>位于 <code>${gap.worstPoint.lat.toFixed(5)}, ${gap.worstPoint.lng.toFixed(5)}</code>，
                    三类中最容易到达的一类仍需步行 <b>${gap.worstPoint.worst} m</b>。</p>`);
            }

            // Top 斑块
            if (gap.patches && gap.patches.length) {
                html.push('<h5 style="margin:12px 0 6px;font-size:13px;color:#e6f0ff">🔴 优先改造斑块（按 面积 × 缺口强度 排序）</h5>');
                html.push('<ul class="report-list">');
                gap.patches.forEach((pt, i) => {
                    html.push(`<li><b>斑块 ${marks[i] || (i + 1)}</b>：约 ${(pt.areaM2 / 1e4).toFixed(2)} 公顷
                        （${pt.size} 个栅格），平均需步行 <b>${Math.round(pt.avgGap)} m</b> 才能到达最近的一类配套，
                        最差点位 <b>${Math.round(pt.maxGap)} m</b>
                        <div class="gp-meta">中心坐标 ${pt.centroid.lat.toFixed(5)}, ${pt.centroid.lng.toFixed(5)}</div></li>`);
                });
                html.push('</ul>');

                // 规划建议：斑块 + 主要缺口成因
                let bKey = null, bMax = -1;
                Object.keys(gap.bottleneckCount || {}).forEach(k => {
                    if (gap.bottleneckCount[k] > bMax) { bMax = gap.bottleneckCount[k]; bKey = k; }
                });
                if (bKey) {
                    html.push(`<p><strong>规划建议：</strong>上述斑块中，
                        <b>${nameOf(bKey)}</b> 是 ${bMax} 个盲区点位最难到达的配套类型（占盲区点位 ${(bMax / gap.gapCount * 100).toFixed(0)}%），
                        建议作为补建首选；若整体新建成本过高，可优先采用"移动菜车 / 社区药柜 / 校车接驳点"等过渡方案压缩盲区面积。</p>`);
                }
            }

            // 各类缺失率
            const keys = (p.checkKeys || []).filter(k => gap.missingRate && gap.missingRate[k] !== undefined);
            if (keys.length) {
                html.push('<h5 style="margin:12px 0 6px;font-size:13px;color:#e6f0ff">各类单独缺口（步行距离 > ' + R + ' m 的点位占比）</h5>');
                html.push('<ul class="report-list">');
                keys.forEach(k => {
                    html.push(`<li>${nameOf(k)}：<b>${(gap.missingRate[k] * 100).toFixed(0)}%</b> 的分析点位无法在 ${R} m 内到达
                        <div class="gp-meta">范围内共检索到 ${(gap.poiCount && gap.poiCount[k]) || 0} 处</div></li>`);
                });
                html.push('</ul>');
            }
        }

        // 方法与精度说明（答辩自查：口径、参数、误差来源全部透明）
        html.push(`
            <p class="muted" style="font-size:12px;margin-top:10px">
            <b>方法说明：</b>步行距离 = 直线距离 × 路网绕行系数 λ。
            λ 由 <b>${gap.lambdaSamples}</b> 个锚点的真实步行路径规划标定（取中位数，取值 ${gap.lambda.toFixed(3)}${gap.lambdaClamped ? '，已按 [1.00, 1.80] 钳制' : ''}），
            其余点位用距离场插值外推，避免对每个栅格点都发起路径规划请求${gap.lambdaFallback ? '。<b>⚠ 本次标定样本不足 2 条，λ 已退回经验值 1.25，盲区结果为估算值</b>' : ''}。
            精度主要受三方面影响：① POI 检索召回率（受 LocalSearch 关键字命中率限制）；
            ② λ 的空间均一性假设（实际绕行系数在河流、铁路、封闭小区附近会显著偏高）；
            ③ 栅格步长（步长越小边界越精细，代价是计算量按平方增长）。</p>`);

        html.push('</div>');
        return html.join('');
    }

    function escapeHtml(s) {
        return (s == null ? '' : String(s))
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /** 四维评分细项：html 片段（条形可视化） */
    function renderBreakdown(b, score) {
        if (!b || typeof b.completeness !== 'number') return '';
        const nCat = (typeof POI_CATEGORIES !== 'undefined') ? POI_CATEGORIES.length : 5;
        const items = [
            { name: '配套完整度', value: b.completeness, max: 100, color: '#3a7afe', tip: `${nCat} 类配套按数量达标度映射` },
            { name: '就近便利度', value: b.proximity,    max: 100, color: '#42d4ff', tip: '中心点走到最近 POI 的步行距离衰减' },
            { name: '等时圈覆盖', value: b.coverage,     max: 100, color: '#00d68f', tip: `可达 ${b.areaKm2} km²，3.0 km² 满分` },
            { name: '类别多样性', value: b.diversity,    max: 100, color: '#ab47bc', tip: `${nCat} 大类齐全才拿满分` }
        ];
        return `
            <div class="score-breakdown">
                <table class="bd-table">
                    ${items.map(it => `
                        <tr>
                            <td class="bd-name" title="${it.tip}">${it.name}</td>
                            <td class="bd-bar">
                                <div class="bd-bg"><div class="bd-fg" style="width:${Math.min(100, it.value).toFixed(0)}%;background:${it.color}"></div></div>
                            </td>
                            <td class="bd-val">${it.value}</td>
                            <td class="bd-pct">/ ${it.max}</td>
                        </tr>`).join('')}
                </table>
                <p class="bd-help muted">条形显示四维度独立得分，按 <b>30/35/20/15%</b> 加权 → 综合分 <b>${score}</b>。</p>
                ${renderNearestSummary(b.nearestSummary)}
            </div>`;
    }

    /** 列出每一类最近的 POI 距离（最近便利度证据） */
    function renderNearestSummary(rows) {
        if (!rows || !rows.length) return '';
        const li = rows.map(r => {
            const d = r.dist;
            const txt = d == null ? '<span class="bd-missing">无</span>' :
                        (d >= 1000 ? (d / 1000).toFixed(2) + ' km' : d + ' m');
            const cls = d == null ? 'bd-dist-nan' : (d <= 600 ? 'bd-dist-near' : (d <= 1200 ? 'bd-dist-mid' : 'bd-dist-far'));
            return `<li><b>${r.name}</b><i class="${cls}">${txt}</i></li>`;
        }).join('');
        return `
            <div class="nearest-summary">
                <h5>📍 就近便利度明细（距中心点）</h5>
                <ul>${li}</ul>
            </div>`;
    }
    global.Report = Report;
})(window);
