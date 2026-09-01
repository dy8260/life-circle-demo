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
        build: function (center, resultByKey, areaM2, score, missedCategories, breakdown) {
            const T = global.THEME || {};
            const lvl = Util.scoreLevel(score);

            // ----- 数据准备 -----
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
            const addr = document.getElementById('addrInput').value.trim() || center.address || '未指定地址';

            // 优势评语
            const strengthTips = {
                hospital: '社区医疗资源充足，居民日常就医与应急均较便利',
                pharmacy:  '药店分布密集，便民购药与慢病管理覆盖面较好',
                market:    '商超配套齐备，日常生活采购便捷度高',
                school:    '教育资源布局合理，满足适龄儿童上学需求',
                bus:       '公交/轨交站点多，公共交通可达性较强'
            };
            const weaknessTips = {
                hospital: '医院较少，建议关注急救响应距离，可向属地卫健部门申请增设社区卫生服务中心',
                pharmacy:  '药店不足，老年人日常购药可能不便，可发展连锁药店或社区药柜',
                market:    '商超不足，日常生活采购不便，可考虑引入社区菜场与品牌便利店',
                school:    '教育资源有限，需关注入学指标，远距离上学影响家庭生活质量',
                bus:       '公共交通覆盖面弱，建议协调公交集团加密班次或增设站点'
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
                在 15 分钟步行范围内共检索到 <b>${total}</b> 处民生配套，按医院 / 药店 / 商超 / 学校 / 公交 五大类统计如下。</p>
                <p>综合评分按 <b>"配套完整度 × 60% + 等时圈覆盖度 × 25% + 类别多样性 × 15%"</b> 三维加权计算，参考《完整居住社区建设标准》与各地《15 分钟生活圈规划导则》。
                最终得分 <b style="color:${lvl.color}">${score}</b>。</p>
                ${renderBreakdown(breakdown)}
            </div>`);

            // 优势
            html.push(`
            <div class="report-section">
                <h4>② 配套优势 (${sufficient.length + adequate.length} 类达标)</h4>`);
            if (sufficient.length === 0 && adequate.length === 0) {
                html.push(`<p class="muted">⚠ 当前 15 分钟步行范围内，五大类配套均未达"理想标准"，建议系统性补齐。</p>`);
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

            // 改造建议
            html.push(`
            <div class="report-section">
                <h4>④ 改造建议</h4>
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

            return this._plainText(addr, lvl, score, areaM2, total, sufficient, adequate, lacking, missing);
        },

        _plainText(addr, lvl, score, areaM2, total, sufficient, adequate, lacking, missing) {
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
            return lines.join('\n');
        }
    };

    function escapeHtml(s) {
        return (s == null ? '' : String(s))
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /** 四维评分细项：html 片段（条形可视化） */
    function renderBreakdown(b, score) {
        if (!b || typeof b.completeness !== 'number') return '';
        const items = [
            { name: '配套完整度', value: b.completeness, max: 100, color: '#3a7afe', tip: '5 类配套按数量达标度映射' },
            { name: '就近便利度', value: b.proximity,    max: 100, color: '#42d4ff', tip: '中心点走到最近 POI 的步行距离衰减' },
            { name: '等时圈覆盖', value: b.coverage,     max: 100, color: '#00d68f', tip: `可达 ${b.areaKm2} km²，3.0 km² 满分` },
            { name: '类别多样性', value: b.diversity,    max: 100, color: '#ab47bc', tip: '5 大类齐全才拿满分' }
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
