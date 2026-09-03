/**
 * 多小区对比模块 · v3.3 简化版
 *
 * 配合新的"地址 A + 地址 B"双行布局：顶部有两组省/市/区下拉 + 详细地址。
 * 点击 🆚 显示地址 B 行；点击「🔬 开始对比」同时体检 A、B，渲染对比报告。
 *
 * 用法：
 *   Compare.reset()                       清空对比结果
 *   Compare.begin(addrA, addrB)           设置两个待体检地址
 *   Compare.runOne(idx)                   体检第 idx 个（0=A, 1=B）
 *   Compare.renderReport()                渲染对比表格 + 总结
 *   Compare.activateCompareTab()          切换报告 tab 到「🆚 对比报告」
 *   Compare.clear()                       用户关掉对比模式时清理
 */
(function (global) {
    'use strict';

    const Compare = {
        // 数据模型：固定 2 个 slot（A/B），由 begin() 写入
        slots: [null, null],   // [{ addr, status, summary? }, ...]
        results: [null, null], // [{ score, breakdown, missedCategories, area, center, resultByKey }, ...]

        /** 清空结果但保留 slot 输入 */
        reset: function () {
            this.slots = [null, null];
            this.results = [null, null];
            this.renderReport();
        },

        /** 设置两个待体检地址（A=0, B=1） */
        begin: function (addrA, addrB) {
            this.slots[0] = { addr: addrA, status: 'idle' };
            this.slots[1] = { addr: addrB, status: 'idle' };
            this.results = [null, null];
        },

        /** 体检第 idx 个 slot（0 或 1） */
        runOne: async function (idx) {
            const s = this.slots[idx];
            if (!s || !s.addr) return;
            s.status = 'running';
            const startTs = Date.now();
            try {
                if (!global.app || typeof global.app.runOneStandalone !== 'function') {
                    throw new Error('app.runOneStandalone 未注册到 window.app（请确认 app.js 已加载完成）');
                }
                const r = await global.app.runOneStandalone(s.addr, () => {});
                s.status = 'done';
                s.summary = {
                    addr: s.addr,
                    center: { lng: r.center.lng, lat: r.center.lat },
                    area: r.ir.area,
                    score: r.score,
                    missedCategories: r.missedCategories,
                    breakdown: r.breakdown,
                    resultByKey: r.resultByKey,
                    elapsedMs: Date.now() - startTs
                };
                this.results[idx] = {
                    addr: s.addr,
                    center: s.summary.center,
                    score: r.score,
                    area: r.ir.area,
                    ir: r.ir,              // 等时圈多边形对象（供对比地图渲染使用）
                    breakdown: r.breakdown,
                    missedCategories: r.missedCategories,
                    resultByKey: r.resultByKey
                };
            } catch (e) {
                console.warn('对比槽 #' + idx + ' 失败', e);
                s.status = 'error';
                s.error = e.message || String(e);
            }
            return s;
        },

        /** 渲染对比报告到 #reportCompare */
        renderReport: function () {
            const box = document.getElementById('reportCompare');
            if (!box) return;

            const rows = this.results
                .map((r, i) => ({ r, i, s: this.slots[i] }))
                .filter(x => x.r);

            if (rows.length < 2) {
                box.innerHTML = '<div class="empty-tip"><p>请同时填写地址 A 和地址 B，并完成体检。</p></div>';
                return;
            }

            // 同步保存对比报告标题，供 tab 切换时显示
            const addrTag = document.getElementById('reportAddr');
            if (addrTag && rows.length >= 2) {
                const addrs = rows.map(x => x.r.addr).filter(Boolean);
                addrTag.dataset.compare = addrs.length >= 2
                    ? `对比报告：${addrs[0]} vs ${addrs[1]}`
                    : '对比报告';
            }

            const sortedByScore = [...rows].sort((a, b) => a.r.score === undefined ? 1 : (b.r.score - a.r.score));
            const championIdx = sortedByScore[0].i;
            const runnerUp = sortedByScore[1];
            const delta = runnerUp ? (sortedByScore[0].r.score - runnerUp.r.score) : 0;

            const dims = [
                { key: 'completeness', name: '配套完整度', color: '#3a7afe' },
                { key: 'proximity',    name: '就近便利度', color: '#42d4ff' },
                { key: 'coverage',     name: '等时圈覆盖', color: '#00d68f' },
                { key: 'diversity',    name: '类别多样性', color: '#ab47bc' }
            ];

            let html = '';

            // 表格 1：地址 & 总评分
            html += `<h4 class="report-section-title">🏆 对比结果 · 共 ${rows.length} 个地址</h4>`;
            html += `<table class="compare-report-table t-summary">
                <thead><tr>
                    <th>排名</th><th>地址</th><th style="text-align:right">综合评分</th><th style="text-align:right">POI</th>
                    <th style="text-align:right">可达面积</th><th>等级</th>
                </tr></thead><tbody>`;
            sortedByScore.forEach((row, k) => {
                const lvl = Util.scoreLevel(row.r.score);
                const isChamp = k === 0;
                html += `<tr class="${isChamp ? 'row-champion' : ''}">
                    <td>${k + 1}${isChamp ? ' <span class="champion-badge">最佳</span>' : ''}</td>
                    <td><b>${escapeHtml(row.r.addr)}</b></td>
                    <td class="cell-num" style="color:${lvl.color}">${row.r.score}</td>
                    <td class="cell-num">${totalPoi(row.r.resultByKey)}</td>
                    <td class="cell-num">${(row.r.area / 1e6).toFixed(2)} km²</td>
                    <td><span class="champion-badge" style="background:${lvl.color}">${lvl.text}</span></td>
                </tr>`;
            });
            html += `</tbody></table>`;

            // 表格 2：维度数值对比
            html += `<h4 class="report-section-title">📊 四维度分项对比</h4>`;
            html += `<table class="compare-report-table t-dims">
                <thead><tr>
                    <th>维度</th>
                    ${sortedByScore.map(row => `<th style="text-align:right">${escapeHtml(truncate(row.r.addr, 14))}</th>`).join('')}
                </tr></thead><tbody>`;
            dims.forEach(d => {
                html += `<tr><td>${d.name}</td>`;
                const vals = sortedByScore.map(row => row.r.breakdown[d.key] || 0);
                const max = Math.max.apply(null, vals);
                sortedByScore.forEach((row, k) => {
                    const v = vals[k];
                    const isMax = (vals.length > 1 && v === max);
                    html += `<td class="cell-num" style="color:${isMax ? d.color : 'var(--text-sub)'}">${v}</td>`;
                });
                html += `</tr>`;
            });
            html += `</tbody></table>`;

            // 文字总结
            if (sortedByScore.length >= 2) {
                const champ = sortedByScore[0].r;
                const prev = sortedByScore[1].r;
                html += `<div class="compare-summary">
                    <b>📌 综合结论：</b>「<b>${escapeHtml(champ.addr)}</b>」综合得分 <b style="color:var(--success)">${champ.score}</b>，
                    领先「<b>${escapeHtml(prev.addr)}</b>」（<b>${prev.score}</b> 分）共 <b>${delta}</b> 分。<br>
                    <b>🎯 优势维度：</b>「${escapeHtml(champ.addr)}」在 <b>${maxDim(champ, dims).name}</b> 上表现最突出（<b>${maxDim(champ, dims).value}</b> 分）。<br>
                    <b>⚠️ 主要短板：</b>整体 <b>${minDim(champ, dims).name}</b> 仍有提升空间（<b>${minDim(champ, dims).value}</b> 分），
                    ${minDim(champ, dims).value < 60 ? '建议作为下一轮规划的重点改造方向。' : '但整体已达合格水平。'}
                </div>`;
            }

            // 改造建议
            html += `<h4 class="report-section-title">🛠️ 改造建议</h4>`;
            html += `<ul class="report-list">${rows.map(row => {
                const r = row.r;
                const advices = [];
                if (r.breakdown.coverage < 60) advices.push('等时圈覆盖偏小，建议加密慢行步道或增设人行天桥');
                if (r.breakdown.proximity < 70) advices.push('就近便利度不足，建议引入 24h 便利店、社区诊所');
                if (r.missedCategories && r.missedCategories.length) advices.push('补齐缺失配套：' + r.missedCategories.join('、'));
                if (!advices.length) advices.push('已较好，继续保持当前配套节奏');
                return `<li><b>${escapeHtml(r.addr)}：</b>${advices.join('；')}</li>`;
            }).join('')}</ul>`;

            box.innerHTML = html;
        },

        /** 用户关掉对比模式时清空状态 */
        clear: function () {
            this.slots = [null, null];
            this.results = [null, null];
            this.renderReport();
            const addrTag = document.getElementById('reportAddr');
            if (addrTag) delete addrTag.dataset.compare;
        },

        /** 切换报告 tab 到对比 */
        activateCompareTab: function () {
            const tab = document.getElementById('tabCompare');
            if (tab) tab.disabled = false;
            const card = document.querySelector('.report-card');
            if (card) card.classList.add('has-compare');
            // 切 tab + 显示
            document.querySelectorAll('.report-tabs .tab').forEach(t => {
                t.classList.toggle('active', t.dataset.tab === 'compare');
            });
            document.getElementById('reportSingle').hidden = true;
            document.getElementById('reportCompare').hidden = false;
            // 同步头部标题
            const addrTag = document.getElementById('reportAddr');
            if (addrTag) addrTag.textContent = addrTag.dataset.compare || '对比报告';
        },

        /** 切回单地址报告 tab */
        activateSingleTab: function () {
            const card = document.querySelector('.report-card');
            if (card) card.classList.remove('has-compare');
            document.querySelectorAll('.report-tabs .tab').forEach(t => {
                t.classList.toggle('active', t.dataset.tab === 'single');
            });
            document.getElementById('reportSingle').hidden = false;
            document.getElementById('reportCompare').hidden = true;
            // 同步头部标题
            const addrTag = document.getElementById('reportAddr');
            if (addrTag) addrTag.textContent = addrTag.dataset.single || '尚未体检';
        }
    };

    /* ========== 辅助函数 ========== */
    function totalPoi(r) {
        if (!r) return 0;
        let sum = 0;
        Object.values(r).forEach(g => { sum += (g && g.items) ? g.items.length : 0; });
        return sum;
    }
    function escapeHtml(s) {
        return (s == null ? '' : String(s))
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function truncate(s, n) { s = s || ''; return s.length > n ? s.slice(0, n) + '…' : s; }
    function maxDim(r, dims) {
        return dims.map(d => ({ name: d.name, value: r.breakdown[d.key] || 0 }))
            .sort((a, b) => b.value - a.value)[0];
    }
    function minDim(r, dims) {
        return dims.map(d => ({ name: d.name, value: r.breakdown[d.key] || 0 }))
            .sort((a, b) => a.value - b.value)[0];
    }

    global.Compare = Compare;
})(window);