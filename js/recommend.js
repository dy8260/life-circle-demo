/**
 * 选址推荐（补点建议）
 *
 * 针对「服务盲区」推荐"在哪里新建某类设施最能消除盲区"，让体检结论落到可执行的位置选择上。
 *
 * 思路：把盲区栅格点当作「需求点」，对每个盲区相关类别（菜市场 / 药店 / 学校，
 * 即盲区判定三类）求解最大覆盖选址（Maximal Coverage Location Problem）的贪心解：
 *   在需求点集合中贪心选取 K 处落点，使"以国标盲区半径 R 内能覆盖（消除）的需求点最多"
 *   （按严重度加权，优先覆盖重度盲区）。
 * 落点坐标取被覆盖需求点的（加权）质心，更贴近真实"需求中心"。
 *
 * 需求点来源分两层：
 *   ① 三类全缺的重度盲区点 gapPoints（权重 = worst，最强需求）；
 *   ② 单类缺失的栅格点（该类步行距离 > R，但未达三类全缺）—— 使"任一类别存在盲区"
 *      也能给出推荐，避免展示空白卡片、证明系统确有数据。
 *
 * 全程使用直线距离，不调用任何 WalkingRoute → 零地图配额、秒级完成。
 *
 * 消费方：看板「📍 选址推荐」卡、地图「🏗️」标注、体检报告「⑧ 选址推荐」节、对比报告。
 */
(function (global) {
    'use strict';

    const Recommend = {
        _markers: [],

        /**
         * 计算选址推荐
         * @param {Object} gapResult GapFinder.analyze 的返回（含 gapPoints / params / _walk / _grid / _isGap）
         * @param {Object} [opts] { topK, radiusMeters, categories }
         * @returns {Object} { ok, perCategory:[{key,name,color,icon,stdRadius,totalUncovered,eliminatedPct,sites:[{lat,lng,covered,coveredPct,rank}]}], radiusMeters, note }
         */
        compute: function (gapResult, opts) {
            opts = opts || {};
            if (!gapResult || !gapResult.enabled) {
                return { ok: false, perCategory: [], note: '当前未执行服务盲区识别，暂无法生成补点建议。' };
            }
            const R = opts.radiusMeters || (gapResult.params && gapResult.params.radiusMeters) || 1000;
            const keys = opts.categories || (gapResult.params && gapResult.params.checkKeys) || ['market', 'pharmacy', 'school'];
            const topK = opts.topK || (global.RECOMMEND && global.RECOMMEND.topK) || 3;
            const maxDemand = (global.RECOMMEND && global.RECOMMEND.maxDemand) || 300;

            // 类别展示信息（颜色 / 名称 / 图标）
            const catInfo = {};
            (global.POI_CATEGORIES || []).forEach(c => { catInfo[c.key] = c; });
            const stdMap = {};
            (global.ACCESS_CATEGORIES || []).forEach(c => { stdMap[c.key] = c.stdRadius; });

            // 需求点来源：
            //   ① 三类全缺的重度盲区点 gapPoints（权重 = worst，最强需求）；
            //   ② 单类缺失的栅格点（该类步行距离 > R 但未达三类全缺）—— 使"任一类别存在盲区"也给出推荐。
            const gapPts = (gapResult.gapPoints && gapResult.gapPoints.length) ? gapResult.gapPoints : null;
            const walk = gapResult._walk, grid = gapResult._grid, isGap = gapResult._isGap;
            const hasRaw = !!(walk && grid && grid.cells);

            function demandFor(key) {
                const out = [];
                if (gapPts) {
                    for (let i = 0; i < gapPts.length; i++) {
                        const p = gapPts[i];
                        const d = p.dist ? p.dist[key] : null;
                        if (d == null || !isFinite(d) || d > R) {
                            out.push({ lng: p.lng, lat: p.lat, w: p.worst ? p.worst : 1 });
                        }
                    }
                }
                if (hasRaw && walk[key]) {
                    const arr = walk[key], cells = grid.cells;
                    const stride = arr.length > maxDemand ? Math.ceil(arr.length / maxDemand) : 1;
                    for (let i = 0; i < arr.length; i += stride) {
                        const d = arr[i];
                        if (!isFinite(d) || d <= R) continue;
                        if (isGap && isGap[i]) continue;   // 三类全缺点已在 gapPts 计入，避免重复加权
                        out.push({ lng: cells[i].lng, lat: cells[i].lat, w: Math.max(1, d / R) });
                    }
                }
                return out;
            }

            const perCategory = keys.map(function (key) {
                const info = catInfo[key] || { key: key, name: key, color: '#3a7afe', icon: '📍' };
                // 该类的"未覆盖"需求点：该类步行距离 > R（盲区阈值，与盲区卡口径一致）
                const uncovered = demandFor(key);
                const total = uncovered.length;
                const sites = [];
                if (total > 0) {
                    const remaining = uncovered.slice();
                    for (let k = 0; k < topK && remaining.length; k++) {
                        // 选覆盖权重和最大的候选（候选取自剩余未覆盖点）
                        let best = null, bestScore = -1, bestCovered = [];
                        for (let c = 0; c < remaining.length; c++) {
                            const cand = remaining[c];
                            let cov = [], score = 0;
                            for (let r = 0; r < remaining.length; r++) {
                                if (Util.distance(cand, remaining[r]) <= R) { cov.push(r); score += remaining[r].w; }
                            }
                            if (score > bestScore) { bestScore = score; best = cand; bestCovered = cov; }
                        }
                        if (!best) break;
                        // 推荐落点 = 被覆盖需求点的（加权）质心（更贴近真实"需求中心"）
                        let clng = 0, clat = 0, wsum = 0;
                        bestCovered.forEach(ri => {
                            const rp = remaining[ri];
                            clng += rp.lng * rp.w; clat += rp.lat * rp.w; wsum += rp.w;
                        });
                        const lat = wsum ? clat / wsum : best.lat;
                        const lng = wsum ? clng / wsum : best.lng;
                        const coveredCount = bestCovered.length;
                        sites.push({
                            lat: +lat.toFixed(5), lng: +lng.toFixed(5),
                            covered: coveredCount,
                            coveredPct: Math.round(coveredCount / total * 100),
                            rank: k + 1
                        });
                        // 从 remaining 移除已被覆盖的点（下一轮覆盖剩余）
                        const remove = new Set(bestCovered);
                        for (let r = remaining.length - 1; r >= 0; r--) { if (remove.has(r)) remaining.splice(r, 1); }
                    }
                }
                const eliminated = sites.reduce((s, x) => s + x.covered, 0);
                return {
                    key: key,
                    name: info.name,
                    color: info.color,
                    icon: info.icon || '📍',
                    stdRadius: stdMap[key] || R,
                    totalUncovered: total,
                    eliminatedPct: total ? Math.round(eliminated / total * 100) : 0,
                    sites: sites
                };
            });

            // 只要任一类别存在盲区（重度三类全缺 或 单类局部缺口），就给出推荐，确保结论有真实数据支撑
            const anyGap = perCategory.some(c => c.totalUncovered > 0);
            if (!anyGap) {
                return { ok: false, perCategory: [], note: '当前范围内各配套步行距离均在盲区阈值内，暂无需补点建议。' };
            }
            const severeCount = gapPts ? gapPts.length : 0;
            const note = '基于服务盲区栅格需求点：优先覆盖"三类全缺"重度盲区，并纳入单类缺失的局部缺口，'
                + '按"国标盲区半径 ' + R + ' m 内覆盖最多缺口点（按严重度加权）"贪心选取落点；'
                + '直线距离估算，不消耗地图配额，落点坐标为被覆盖需求点的加权质心。'
                + (severeCount ? ('（已识别 ' + severeCount + ' 处三类全缺重度盲区）')
                              : '（暂无三类全缺重度盲区，以下为单类局部覆盖缺口建议）');
            return { ok: true, perCategory: perCategory, radiusMeters: R, note: note };
        },

        /**
         * 渲染单地址选址推荐卡（写入容器）
         */
        render: function (rec, containerId) {
            const box = document.getElementById(containerId);
            if (!box) return;
            if (!rec || !rec.ok) {
                box.innerHTML = '<p class="gap-empty muted">' + esc(rec && rec.note ? rec.note : '完成体检后自动生成补点建议。') + '</p>';
                return;
            }
            const rows = rec.perCategory.map(function (c) {
                const sitesHtml = c.sites.map(function (s, i) {
                    const main = i === 0 ? ' <b class="rc-main">首选</b>' : '';
                    return '<div class="rc-site"><span class="rc-rank">' + (i + 1) + '.</span>'
                        + '<span class="rc-coord">' + s.lat.toFixed(4) + ', ' + s.lng.toFixed(4) + '</span>'
                        + '<span class="rc-cov">消除 <b style="color:' + c.color + '">' + s.coveredPct + '%</b> 盲区</span>' + main + '</div>';
                }).join('');
                return '<div class="rc-row">'
                    +   '<div class="rc-head">'
                    +     '<span class="rc-ico" style="background:' + c.color + '22;color:' + c.color + '">' + c.icon + '</span>'
                    +     '<span class="rc-name">' + c.name + '</span>'
                    +     '<span class="rc-total">共可消除 <b style="color:' + c.color + '">' + c.eliminatedPct + '%</b> 盲区</span>'
                    +   '</div>'
                    +   (sitesHtml || '<div class="rc-site muted">暂无新建需求</div>')
                    + '</div>';
            }).join('');
            box.innerHTML = rows + '<p class="ac-note muted">' + highlightNote(rec.note) + '</p>';
        },

        /**
         * 渲染对比模式 A/B 双列（返回 HTML 字符串）
         */
        renderCompare: function (a, b) {
            if (!a || !a.ok || !b || !b.ok) {
                return '<p class="gap-empty muted">地址 A / B 暂无可比的补点建议数据。</p>';
            }
            const keys = a.perCategory.map(c => c.key);
            const head = '<div class="rc-row rc-head rc-cmp">'
                +   '<span class="rc-name">类别</span>'
                +   '<span class="rc-cnt a">A 消除率</span><span class="rc-cnt b">B 消除率</span>'
                +   '<span class="rc-cnt a">A 推荐落点</span><span class="rc-cnt b">B 推荐落点</span></div>';

            function fmtSites(list, color) {
                if (!list || !list.length) return '<span class="rc-zero">—</span>';
                return list.map(function (s, i) {
                    const tag = i === 0 ? '首选' : ('次选' + i);
                    return '<div class="rc-site-line">'
                        +   '<span class="rc-site-tag" style="color:' + color + '">' + tag + '</span>'
                        +   '<span class="rc-coord-mini">' + s.lat.toFixed(4) + ',' + s.lng.toFixed(4) + '</span>'
                        +   '<span class="rc-cov-mini">消除' + s.coveredPct + '%</span>'
                        + '</div>';
                }).join('');
            }

            const rows = keys.map(function (key) {
                const ca = a.perCategory.find(c => c.key === key) || {};
                const cb = b.perCategory.find(c => c.key === key) || {};
                const color = ca.color || '#3a7afe';
                return '<div class="rc-row rc-cmp">'
                    +   '<span class="rc-name"><span class="rc-ico" style="background:' + color + '22;color:' + color + '">' + (ca.icon || '') + '</span> ' + (ca.name || key) + '</span>'
                    +   '<span class="rc-cnt a">A <b>' + (ca.eliminatedPct || 0) + '%</b></span>'
                    +   '<span class="rc-cnt b">B <b>' + (cb.eliminatedPct || 0) + '%</b></span>'
                    +   '<span class="rc-cnt a rc-sites">' + fmtSites(ca.sites, color) + '</span>'
                    +   '<span class="rc-cnt b rc-sites">' + fmtSites(cb.sites, color) + '</span>'
                    + '</div>';
            }).join('');

            // 说明：仅展示一份口径说明（A/B 取其一即可），并把"无三类全缺重度盲区、属单类局部覆盖建议"用绿色高亮，
            // 让用户一眼明白：当前没有重度盲区，以下推荐属于补强建议而非盲区整改。
            const noteText = a.note || b.note || '';
            const noteBlock = '<div class="rc-cmp-note muted">'
                + (noteText ? '<div class="rc-cmp-note-line">' + highlightNote(noteText) + '</div>' : '')
                + '<div class="rc-cmp-note-line">消除率 = 新建该类设施后预计可消除的盲区点占比（按严重度加权）。</div>'
                + '</div>';
            return head + rows + noteBlock;
        },

        /**
         * 在地图上标注推荐落点（🏗️ 桩，按类别着色 + 弹窗说明）
         * @param {BMapGL.Map} map
         * @param {Object} rec compute 的返回
         */
        renderMarkers: function (map, rec) {
            this.clearMarkers(map);
            if (!map || typeof BMapGL === 'undefined' || !rec || !rec.ok) return;
            (rec.perCategory || []).forEach(function (c) {
                (c.sites || []).forEach(function (s, i) {
                    try {
                        const pt = new BMapGL.Point(s.lng, s.lat);
                        const mk = new BMapGL.Marker(pt);
                        map.addOverlay(mk);
                        const label = new BMapGL.Label('🏗️ ' + c.name + (i === 0 ? '·首选' : '') + ' 消除' + s.coveredPct + '%', {
                            offset: new BMapGL.Size(12, -12)
                        });
                        label.setStyle({
                            color: c.color, fontSize: '11px',
                            border: '1px solid ' + c.color,
                            background: 'rgba(13,27,61,0.88)',
                            padding: '2px 6px', borderRadius: '6px', whiteSpace: 'nowrap'
                        });
                        mk.setLabel(label);
                        Recommend._markers.push(mk);
                    } catch (e) { /* 单个标注失败不影响其余 */ }
                });
            });
        },

        /** 清除地图上的推荐标注 */
        clearMarkers: function (map) {
            if (this._markers && this._markers.length) {
                const m = map || global.__bmap;
                this._markers.forEach(function (mk) { try { if (m) m.removeOverlay(mk); } catch (e) {} });
            }
            this._markers = [];
        }
    };

    function esc(s) {
        return (s == null ? '' : String(s))
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // 把"暂无三类全缺重度盲区，以下为单类局部覆盖缺口建议"用绿色高亮，
    // 让用户一眼明白：当前没有重度盲区，以下推荐属于补强建议而非盲区整改。
    // 单地址体检报告与对比报告共用同一逻辑。
    const HL_KEY = '（暂无三类全缺重度盲区，以下为单类局部覆盖缺口建议）';
    function highlightNote(note) {
        let s = esc(note || '');
        const idx = s.indexOf(HL_KEY);
        if (idx >= 0) {
            s = s.slice(0, idx) + '<span class="rc-note-hl">' + HL_KEY + '</span>' + s.slice(idx + HL_KEY.length);
        }
        return s;
    }

    global.Recommend = Recommend;
})(window);
