/**
 * 无障碍可达性达标率（最近设施实测 × GB 50180-2018）
 *
 * 与「配套数量」统计的本质区别：
 *   数量统计 → 只数"圈内有多少个某类设施"（供给密度，计数）；
 *   本模块   → 对居住采样点逐个测算"沿真实步行路网走到最近一处该类设施要多久"（出行成本，时间），
 *              再拿该耗时与 GB 50180-2018 的服务半径（折算为步行分钟）比对，得到达标率。
 *
 * 为什么区分「步行 / 轮椅」双口径：
 *   同一段"到最近设施"的路，用步行速度算一次、用轮椅速度算一次，差值即无障碍缺口；
 *   仅按成年 / 老年划分人群的实现缺少轮椅维度，无法表达"轮椅人群 X 分钟达标率"。
 *
 * 实现要点：
 *   1) 在等时圈多边形内生成居住采样点（上限 ACCESS.sampleMax，控制配额）；
 *   2) 对每个采样点 × 每类 GB 设施，先按直线距离取最近 POI，再调一次 BMapGL.WalkingRoute
 *      取真实步行距离（超时/失败回落到直线 × 绕行系数 λ 兜底，绝不卡死）；
 *   3) 由距离换算步行/轮椅耗时，与国标分钟阈值比对 → 累计达标率。
 */
(function (global) {
    'use strict';

    const Accessibility = {

        /**
         * 计算可达性达标率
         * @param {BMapGL.Point} center
         * @param {Array<{lng,lat}>} polygonPts 主人群等时圈多边形（采样居住点范围）
         * @param {Object} resultByKeyFull POI.fetchAll 全范围结果（含超出等时圈的候选，利于找到最近设施）
         * @param {Object} [opts] { onProgress(p,msg), walkSpeed, wheelSpeed }
         * @returns {Promise<{ok,categories,overall,sampledPoints,detail,note,disabled?}>}
         */
        compute: async function (center, polygonPts, resultByKeyFull, opts) {
            opts = opts || {};
            const onProgress = opts.onProgress || function () {};
            const cfg = global.ACCESS || {};
            if (cfg.enabled === false) {
                return { ok: false, disabled: true, categories: [], overall: null };
            }

            const cats = global.ACCESS_CATEGORIES || [];
            if (!cats.length) return { ok: false, categories: [], overall: null };

            // 速度：步行取主人群速度，轮椅取 WALK_TYPES 中 key==='wheel'
            const walkSpeed = opts.walkSpeed || (global.getActiveSpeed ? global.getActiveSpeed() : 80);
            let wheelSpeed = opts.wheelSpeed;
            if (!wheelSpeed) {
                const wt = (global.WALK_TYPES || []).find(t => t.key === 'wheel');
                wheelSpeed = wt ? wt.speed : 40;
            }

            // 居住采样点
            const pts = samplePoints(polygonPts, cfg.sampleMax || 10, cfg.gridStep || 0);
            if (!pts.length) return { ok: false, categories: [], overall: null };

            // 预取每类 POI 候选坐标
            const catItems = {};
            cats.forEach(c => {
                const g = resultByKeyFull && resultByKeyFull[c.key];
                catItems[c.key] = (g && g.items) ? g.items.filter(it => it.point) : [];
            });

            const lambda = (global.BLIND_GAP && global.BLIND_GAP.lambdaDefault) || 1.3;
            const concurrency = cfg.concurrency || 3;
            const timeoutMs = cfg.timeoutMs || 5000;

            // 每类累计
            const perCat = {};
            cats.forEach(c => { perCat[c.key] = { passWalk: 0, passWheel: 0, total: 0 }; });
            const detailByCat = {};
            cats.forEach(c => { detailByCat[c.key] = []; });

            // 任务 = 采样点 × 类别
            const tasks = [];
            for (const sp of pts) for (const c of cats) tasks.push({ sp, c });

            // λ 观测集：仅收录「真实路网」样本（src==='route'），供下游 λ 阻抗场与精度自证复用。
            // 兜底样本（直线 × λ）会把合成值当成实测值，反过来污染 λ 场，故必须按 src 过滤。
            const pairs = [];

            let done = 0;
            await Util.pmap(tasks, async (task) => {
                const { sp, c } = task;
                const items = catItems[c.key];
                let dist = Infinity;
                let nearest = null;
                let straightDist = null;
                let srcType = 'none';   // route=真实路网 / estimate=直线×λ 兜底 / none=无候选
                if (items && items.length) {
                    let bestD = Infinity;
                    for (const it of items) {
                        const d = Util.distance(sp, it.point);
                        if (d < bestD) { bestD = d; nearest = it; }
                    }
                    if (nearest) {
                        straightDist = bestD;
                        const realD = await walkDistance(sp, nearest.point, timeoutMs);
                        if (realD && realD > 0) {
                            dist = realD;                 // 真实步行路网距离
                            srcType = 'route';
                        } else {
                            dist = bestD * lambda;        // 兜底：直线 × λ
                            srcType = 'estimate';
                        }
                    }
                }
                const stdMinutes = Math.max(1, Math.round((c.stdRadius || 500) / 80));
                const walkMin = dist === Infinity ? Infinity : dist / walkSpeed;
                const wheelMin = dist === Infinity ? Infinity : dist / wheelSpeed;
                const okWalk = dist !== Infinity && walkMin <= stdMinutes;
                const okWheel = dist !== Infinity && wheelMin <= stdMinutes;

                const rec = perCat[c.key];
                rec.total += 1;
                if (okWalk) rec.passWalk += 1;
                if (okWheel) rec.passWheel += 1;
                detailByCat[c.key].push({
                    point: sp,
                    nearest: nearest ? { title: nearest.title, point: nearest.point } : null,
                    dist: dist === Infinity ? null : Math.round(dist),
                    // 直线距离与数据来源：扩张 Bullet 后 λ 场/归因模块依赖这两个字段做「缺设施 vs 缺路」判定
                    straight: (straightDist == null || !isFinite(straightDist)) ? null : Math.round(straightDist),
                    src: srcType,
                    walkMin: isFinite(walkMin) ? +walkMin.toFixed(1) : null,
                    wheelMin: isFinite(wheelMin) ? +wheelMin.toFixed(1) : null,
                    stdMinutes, okWalk, okWheel
                });

                // 真实路网样本 → 记为一条 λ 观测（λ = 步行距离 / 直线距离）
                if (srcType === 'route' && straightDist && straightDist > 1 && dist > 0) {
                    pairs.push({
                        lng: sp.lng, lat: sp.lat, key: c.key,
                        straight: Math.round(straightDist),
                        walk: Math.round(dist),
                        lambda: dist / straightDist
                    });
                }

                done++;
                if (done % 3 === 0) onProgress(done / tasks.length, '最近设施实测 ' + done + '/' + tasks.length);
            }, concurrency);

            const categories = cats.map(c => {
                const r = perCat[c.key];
                const rate = r.total ? Math.round(r.passWalk / r.total * 100) : 0;
                const wrate = r.total ? Math.round(r.passWheel / r.total * 100) : 0;
                const pc = (global.POI_CATEGORIES || []).find(x => x.key === c.key);
                return {
                    key: c.key, name: c.name, icon: c.icon, color: pc ? pc.color : '#3a7afe',
                    stdRadius: c.stdRadius, stdMinutes: Math.max(1, Math.round((c.stdRadius || 500) / 80)),
                    walkingRate: rate, wheelchairRate: wrate, count: r.total
                };
            });
            const overallWalk = avg(categories.map(c => c.walkingRate));
            const overallWheel = avg(categories.map(c => c.wheelchairRate));

            return {
                ok: true,
                categories,
                overall: { walkingRate: overallWalk, wheelchairRate: overallWheel },
                sampledPoints: pts.length,
                detail: detailByCat,
                // 供「步行阻抗场」复用的 λ 观测集（仅真实路网样本）
                lambdaPairs: pairs,
                note: '基于真实步行路网测算到最近设施耗时，按 GB 50180-2018 服务半径判定；轮椅人群按低速重算。'
            };
        },

        /**
         * 渲染单地址达标率表（写入容器）
         * @param {Object} access compute 的返回
         * @param {string} containerId
         */
        render: function (access, containerId) {
            const box = document.getElementById(containerId);
            if (!box) return;
            if (!access || !access.ok) {
                box.innerHTML = '<p class="gap-empty muted">' +
                    (access && access.disabled
                        ? '可达性达标率分析已关闭（配置项 ACCESS.enabled=false）。'
                        : '完成体检后自动测算各居住点到最近设施的步行 / 轮椅达标率。') + '</p>';
                return;
            }
            const rows = access.categories.map(c => {
                const wc = barColor(c.walkingRate), cc = barColor(c.wheelchairRate);
                return '<div class="ac-row">'
                    +   '<span class="ac-name">' + c.icon + ' ' + c.name
                    +     ' <small>(≤' + c.stdMinutes + '′)</small></span>'
                    +   '<div class="ac-walk"><div class="ac-pct">步行 <b style="color:' + wc + '">' + c.walkingRate + '%</b></div>'
                    +     '<div class="ac-track"><div class="ac-fill" style="width:' + c.walkingRate + '%;background:' + wc + '"></div></div></div>'
                    +   '<div class="ac-wheel"><div class="ac-pct">轮椅 <b style="color:' + cc + '">' + c.wheelchairRate + '%</b></div>'
                    +     '<div class="ac-track"><div class="ac-fill" style="width:' + c.wheelchairRate + '%;background:' + cc + '"></div></div></div>'
                    + '</div>';
            }).join('');
            const ow = barColor(access.overall.walkingRate), oc = barColor(access.overall.wheelchairRate);
            box.innerHTML =
                '<div class="ac-head ac-row"><span class="ac-name">类别</span>'
                +   '<span class="ac-col-label">步行达标</span><span class="ac-col-label">轮椅达标</span></div>'
                + rows
                + '<div class="ac-summary ac-row"><span class="ac-name"><b>综合</b></span>'
                +   '<div class="ac-walk"><div class="ac-pct">步行 <b style="color:' + ow + '">' + access.overall.walkingRate + '%</b></div>'
                +     '<div class="ac-track"><div class="ac-fill" style="width:' + access.overall.walkingRate + '%;background:' + ow + '"></div></div></div>'
                +   '<div class="ac-wheel"><div class="ac-pct">轮椅 <b style="color:' + oc + '">' + access.overall.wheelchairRate + '%</b></div>'
                +     '<div class="ac-track"><div class="ac-fill" style="width:' + access.overall.wheelchairRate + '%;background:' + oc + '"></div></div></div></div>'
                + '<p class="ac-note muted">抽样 ' + access.sampledPoints + ' 个居住点 · 依据 GB 50180-2018 服务半径实测</p>';
        },

        /**
         * 渲染对比模式 A/B 双列（返回 HTML 字符串，由调用方写入容器）
         */
        renderCompare: function (a, b) {
            if (!a || !a.ok || !b || !b.ok) {
                return '<p class="gap-empty muted">地址 A / B 暂无可比的可达性数据。</p>';
            }
            const rows = a.categories.map((ca, i) => {
                const cb = b.categories[i] || {};
                return '<div class="ac-row ac-cmp">'
                    +   '<span class="ac-name">' + ca.icon + ' ' + ca.name + ' <small>(≤' + ca.stdMinutes + '′)</small></span>'
                    +   '<span class="ac-cnt a">A <b>' + ca.walkingRate + '%</b></span>'
                    +   '<span class="ac-cnt b">B <b>' + (cb.walkingRate || 0) + '%</b></span>'
                    +   '<span class="ac-cnt a">A <b>' + ca.wheelchairRate + '%</b></span>'
                    +   '<span class="ac-cnt b">B <b>' + (cb.wheelchairRate || 0) + '%</b></span>'
                    + '</div>';
            }).join('');
            return '<div class="ac-head ac-row ac-cmp"><span class="ac-name">类别</span>'
                +   '<span class="ac-cnt a">A 步行</span><span class="ac-cnt b">B 步行</span>'
                +   '<span class="ac-cnt a">A 轮椅</span><span class="ac-cnt b">B 轮椅</span></div>'
                + rows
                + '<div class="ac-summary ac-row ac-cmp"><span class="ac-name"><b>综合</b></span>'
                +   '<span class="ac-cnt a">A <b>' + a.overall.walkingRate + '%</b></span>'
                +   '<span class="ac-cnt b">B <b>' + b.overall.walkingRate + '%</b></span>'
                +   '<span class="ac-cnt a">A <b>' + a.overall.wheelchairRate + '%</b></span>'
                +   '<span class="ac-cnt b">B <b>' + b.overall.wheelchairRate + '%</b></span></div>';
        }
    };

    /* ---------------- 内部工具 ---------------- */

    function avg(arr) { return arr.length ? Math.round(arr.reduce((s, x) => s + x, 0) / arr.length) : 0; }
    function barColor(v) { return v >= 85 ? '#00d68f' : v >= 70 ? '#3a7afe' : v >= 55 ? '#ffb547' : '#ff5470'; }

    /**
     * 在多边形内生成网格采样点，目标数量上限 maxN（过多则放大步长直至 ≤ maxN）
     */
    function samplePoints(poly, maxN, preferredStep) {
        if (!poly || poly.length < 3) return [];
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        poly.forEach(p => {
            const x = (p.lng != null) ? p.lng : (p.getLng ? p.getLng() : null);
            const y = (p.lat != null) ? p.lat : (p.getLat ? p.getLat() : null);
            if (x == null || y == null) return;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        });
        if (minX === Infinity) return [];
        const cLat = (minY + maxY) / 2;
        const base = (preferredStep && preferredStep > 0) ? preferredStep : 120; // 米
        let step = base / (111320 * Math.cos(cLat * Math.PI / 180)); // 度
        let guard = 0, pts = [];
        do {
            pts = [];
            for (let lng = minX; lng <= maxX + 1e-9; lng += step) {
                for (let lat = minY; lat <= maxY + 1e-9; lat += step) {
                    const p = { lng, lat };
                    if (Util.pointInPolygon(p, poly)) pts.push(p);
                }
            }
            step *= 1.5; guard++;
        } while (pts.length > maxN && guard < 14);
        return pts.slice(0, maxN);
    }

    /**
     * 真实步行距离：调 BMapGL.WalkingRoute 取路径长度；超时/失败返回 null（由调用方兜底）
     */
    function walkDistance(start, end, timeoutMs) {
        return new Promise((resolve) => {
            if (typeof BMapGL === 'undefined' || !global.__bmap) { resolve(null); return; }
            let done = false;
            const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
            const timer = setTimeout(() => finish(null), timeoutMs || 5000);
            const onDone = (res) => { clearTimeout(timer); finish(routeDistanceFrom(res, route)); };
            let route = null;
            const variants = [
                { renderOptions: { map: null, autoViewport: false }, onSearchComplete: onDone },
                { onSearchComplete: onDone }
            ];
            for (const o of variants) {
                try { route = new BMapGL.WalkingRoute(global.__bmap, o); break; }
                catch (e) { route = null; }
            }
            if (!route) { clearTimeout(timer); resolve(null); return; }
            try {
                if (typeof route.setSearchCompleteCallback === 'function') {
                    route.setSearchCompleteCallback(() => { clearTimeout(timer); finish(routeDistanceFrom(null, route)); });
                }
            } catch (e) {}
            try {
                route.search(new BMapGL.Point(start.lng, start.lat), new BMapGL.Point(end.lng, end.lat));
            } catch (e) { clearTimeout(timer); resolve(null); }
        });
    }

    function routeDistanceFrom(res, route) {
        const chains = [
            () => res && res.getPlan && res.getPlan(0) && res.getPlan(0).getRoute && res.getPlan(0).getRoute(0) && res.getPlan(0).getRoute(0).getDistance && res.getPlan(0).getRoute(0).getDistance(),
            () => route && route.getPlan && route.getPlan(0) && route.getPlan(0).getRoute && route.getPlan(0).getRoute(0) && route.getPlan(0).getRoute(0).getDistance && route.getPlan(0).getRoute(0).getDistance(),
            () => res && res.getPlan && res.getPlan(0) && res.getPlan(0).getDistance && res.getPlan(0).getDistance(),
            () => route && route.getPlan && route.getPlan(0) && route.getPlan(0).getDistance && route.getPlan(0).getDistance()
        ];
        for (const fn of chains) {
            try {
                const d = fn();
                if (d == null) continue;
                if (typeof d === 'number' && d > 0) return d;
                if (d && typeof d.value === 'number' && d.value > 0) return d.value;
                if (d && typeof d.getMeter === 'function') { const v = d.getMeter(); if (typeof v === 'number' && v > 0) return v; }
            } catch (e) {}
        }
        return null;
    }

    global.Accessibility = Accessibility;
})(window);
