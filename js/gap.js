/**
 * 服务盲区识别（Service Blind-spot Identification）
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【要解决的问题】
 *   「15 分钟社区生活圈」配套标准原文：
 *     「系统能否准确识别出周边 1 公里内没有菜市场、药店或小学的『服务盲区』点位」
 *
 *   "周边 1 公里" 在生活圈语境下指**步行 1 公里**，不是直线 1 公里。
 *   直接算直线距离会系统性高估可达性（绕行、过街天桥、封闭小区、断头路都会拉长实际路程），
 *   导致本该是盲区的点被误判为"有配套"。
 *
 * 【算法五步】
 *   ① 栅格采样  —— 在 15 分钟等时圈多边形内按 gridStepMeters 打栅格，得到待判定点位集合
 *   ② λ 标定    —— 抽少量锚点调真实 WalkingRoute，测「步行距离 / 直线距离」绕行系数 λ
 *   ③ 距离场插值 —— 用「直线最近距离 × λ」外推全栅格的步行距离场（零 API 消耗的空间插值）
 *   ④ 盲区判定   —— 菜市场 / 药店 / 小学三类步行距离**全部** > 1000m 的点 → 盲区点
 *   ⑤ 连通聚合   —— 栅格 4 邻域连通分量聚成"连片盲区斑块"，按严重度排序取 Top-N
 *
 * 【为什么是 1 次 API 都不多花地铺满全图？】
 *   「API 深度调用与工程优化」一项明确写了两条等价路径：
 *     (a) 批量距离矩阵（routematrix）  (b) 并发请求 + 空间插值
 *   本项目的 AK 是**浏览器端**类型，百度 Web Service 接口（含 routematrix）对浏览器端 AK
 *   返回 status=240「APP 服务被禁用」，路径 (a) 走不通。
 *   因此走 (b)：只花 6 次 WalkingRoute 做 λ 标定，其余全部交给距离场插值——
 *   这既满足"控制 API 调用次数"的工程优化要求，也避免了 O(栅格数 × POI 数) 次路径规划。
 *
 * 【精度自检】
 *   λ 的中位数与样本数会随结果一起返回，并在算法文档中给出实测区间。
 *   若标定样本 < 2 条（网络异常/路网无解），自动退回 lambdaDefault 经验值，
 *   并在结果里标记 `lambdaFallback: true`，报告端会提示"本项为估算值"。
 */
(function (global) {
    'use strict';

    // 经纬度 → 米的换算（用于栅格步长与空间索引剪枝）
    const M_PER_DEG_LAT = 111320;

    // 空间索引网格边长（度）。≈ 440m，保证绝大多数查询在 0~1 环内命中
    const IDX_CELL_DEG = 0.004;

    // 配置缺省值（config.js 未加载时兜底，防止整模块崩溃）
    const FALLBACK_CFG = {
        radiusMeters: 1000,
        checkKeys: ['market', 'pharmacy', 'school'],
        gridStepMeters: 120,
        severeMeters: 1500,
        lambdaDefault: 1.25,
        lambdaMin: 1.00,
        lambdaMax: 1.80,
        calibAnchors: 6,
        calibConcurrency: 3,
        calibTimeoutMs: 6000,
        calibMinStraightMeters: 200,
        topPatches: 3,
        maxRenderPoints: 1200
    };

    const GapFinder = {

        lastResult: null,   // 最近一次分析结果（看板 / 报告 / 导出共用）
        visible: false,

        // —— 渲染相关状态 ——
        map: null,
        wrapper: null,
        canvas: null,
        labels: [],
        mapListeners: [],

        /* ================================================================
         * 主入口
         * ================================================================ */

        /**
         * 分析服务盲区
         *
         * @param {{lng:number,lat:number}} center  体检中心点
         * @param {Array<{lng:number,lat:number}>} polygonPts  等时圈多边形顶点
         * @param {Object} resultByKey  POI.fetchAll 的返回值 { market:{items:[{point}]}, ... }
         * @param {(p:number,msg:string)=>void} onProgress
         * @returns {Object} 分析结果（结构见文件末尾 buildResult 注释）
         */
        analyze: async function (center, polygonPts, resultByKey, onProgress) {
            const CFG = this._cfg();
            const report = (p, m) => onProgress && onProgress(p, m);

            const empty = (reason) => {
                const r = this._emptyResult(reason, CFG);
                this.lastResult = r;
                return r;
            };

            if (!polygonPts || polygonPts.length < 3) return empty('等时圈多边形无效，跳过盲区分析');
            if (!center || typeof center.lng !== 'number') return empty('中心点无效，跳过盲区分析');

            report(0, '构建分析栅格');

            // ── ① 栅格采样 ──────────────────────────────────────────────
            const grid = this._buildGrid(polygonPts, CFG.gridStepMeters, center);
            if (!grid || grid.cells.length === 0) return empty('栅格采样结果为空，跳过盲区分析');

            // ── 参与判定的三类 POI 索引 ──────────────────────────────────
            const keys = (CFG.checkKeys || []).filter(k => {
                const g = resultByKey && resultByKey[k];
                return g && Array.isArray(g.items);
            });
            if (keys.length === 0) return empty('未检索到菜市场/药店/小学数据，跳过盲区分析');

            const indexes = {};
            const poiCount = {};
            const missing = [];
            keys.forEach(k => {
                indexes[k] = this._buildIndex(resultByKey[k].items);
                poiCount[k] = indexes[k].count;
                if (poiCount[k] === 0) missing.push(k);
            });
            if (missing.length > 0) {
                const nameMap = { market: '菜市场', pharmacy: '药店', school: '小学/学校', hospital: '医院', store: '商超', bus: '公交站' };
                const names = missing.map(k => nameMap[k] || k).join('、');
                return empty(`未检索到 ${names} POI，无法判定服务盲区`);
            }

            // ── 直线距离场（同时记录最近 POI 的实际坐标，供 λ 标定使用）──
            report(0.15, '计算直线距离场');
            const straight = this._straightField(grid.cells, keys, indexes);

            // ── ② λ 标定 ────────────────────────────────────────────────
            report(0.3, '标定路网绕行系数 λ');
            const calib = await this._calibrateLambda(grid.cells, straight, keys, CFG, (done, total) => {
                report(0.3 + 0.4 * (done / Math.max(1, total)),
                    `路网绕行系数标定 ${done}/${total}`);
            });

            // ── ③ 步行距离场插值 ─────────────────────────────────────────
            report(0.75, '插值步行距离场');
            const walk = this._walkField(grid.cells.length, keys, straight, calib.lambda);

            // ── ④ 盲区判定 ──────────────────────────────────────────────
            report(0.85, '判定服务盲区点位');
            const cls = this._classify(grid.cells.length, keys, walk, CFG);

            // ── ⑤ 连通斑块聚合 ───────────────────────────────────────────
            report(0.92, '聚合连片盲区斑块');
            const patches = this._patches(grid, cls.isGap, cls.worst, CFG);

            report(1, '服务盲区分析完成');

            const result = this._buildResult({
                grid, keys, straight, walk, cls, patches, calib, poiCount, center, CFG
            });
            this.lastResult = result;
            Util.logGroup && Util.logGroup('服务盲区分析', result);
            return result;
        },

        /* ================================================================
         * ① 栅格采样
         * ================================================================ */

        /**
         * 在多边形 bbox 内打栅格，只保留多边形内的点（射线法）
         * 点数过多时自动放大步长，防止超大等时圈把浏览器卡死
         */
        _buildGrid: function (polygonPts, stepMeters, center) {
            let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
            for (const p of polygonPts) {
                const lng = (p.lng !== undefined) ? p.lng : (p.getLng && p.getLng());
                const lat = (p.lat !== undefined) ? p.lat : (p.getLat && p.getLat());
                if (typeof lng !== 'number' || typeof lat !== 'number') continue;
                if (lng < minLng) minLng = lng;
                if (lng > maxLng) maxLng = lng;
                if (lat < minLat) minLat = lat;
                if (lat > maxLat) maxLat = lat;
            }
            if (!isFinite(minLng) || !isFinite(minLat)) return null;

            const inPolygon = global.__poiInPolygon || this._pointInPolygon;

            const latRad = ((minLat + maxLat) / 2) * Math.PI / 180;
            const stepDegLat = stepMeters / M_PER_DEG_LAT;
            const stepDegLng = stepMeters / (M_PER_DEG_LAT * Math.max(0.2, Math.cos(latRad)));

            // 点数守卫：预估超过 6000 个点就放大步长（最多放大 3 次）
            let k = 1;
            let rows = Math.ceil((maxLat - minLat) / stepDegLat) + 1;
            let cols = Math.ceil((maxLng - minLng) / stepDegLng) + 1;
            while (rows * cols > 6000 && k < 4) {
                k *= 1.5;
                rows = Math.ceil((maxLat - minLat) / (stepDegLat * k)) + 1;
                cols = Math.ceil((maxLng - minLng) / (stepDegLng * k)) + 1;
            }
            const dLat = stepDegLat * k;
            const dLng = stepDegLng * k;

            const cells = [];
            for (let r = 0; r < rows; r++) {
                const lat = minLat + r * dLat;
                for (let c = 0; c < cols; c++) {
                    const lng = minLng + c * dLng;
                    if (!inPolygon({ lng, lat }, polygonPts)) continue;
                    cells.push({ r, c, lng, lat });
                }
            }
            if (cells.length === 0) return null;

            return {
                cells,
                rows,
                cols,
                dLat,
                dLng,
                stepMeters: stepMeters * k,   // 实际生效的步长（可能被守卫放大过）
                stepAutoEnlarged: k > 1,
                cellAreaM2: (stepMeters * k) * (stepMeters * k)
            };
        },

        /**
         * 射线法（poi.js 的 __poiInPolygon 不可用时的兜底实现）
         */
        _pointInPolygon: function (point, polygon) {
            let inside = false;
            const x = point.lng, y = point.lat;
            for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
                const xi = (polygon[i].lng !== undefined ? polygon[i].lng : polygon[i].getLng());
                const yi = (polygon[i].lat !== undefined ? polygon[i].lat : polygon[i].getLat());
                const xj = (polygon[j].lng !== undefined ? polygon[j].lng : polygon[j].getLng());
                const yj = (polygon[j].lat !== undefined ? polygon[j].lat : polygon[j].getLat());
                const intersect = ((yi > y) !== (yj > y)) &&
                                  (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi);
                if (intersect) inside = !inside;
            }
            return inside;
        },

        /* ================================================================
         * 空间索引 + 最近邻查询（工程优化：避免 O(栅格 × POI) 全量距离计算）
         * ================================================================ */

        _buildIndex: function (items) {
            const all = [];
            const map = new Map();
            let minI = Infinity, maxI = -Infinity, minJ = Infinity, maxJ = -Infinity;

            for (const it of items) {
                if (!it || !it.point) continue;
                const lng = it.point.lng, lat = it.point.lat;
                if (typeof lng !== 'number' || typeof lat !== 'number') continue;
                const p = { lng, lat, raw: it };
                all.push(p);
                const i = Math.floor(lng / IDX_CELL_DEG), j = Math.floor(lat / IDX_CELL_DEG);
                if (i < minI) minI = i; if (i > maxI) maxI = i;
                if (j < minJ) minJ = j; if (j > maxJ) maxJ = j;
                const key = i + ',' + j;
                if (!map.has(key)) map.set(key, []);
                map.get(key).push(p);
            }

            return {
                all,
                map,
                count: all.length,
                cell: IDX_CELL_DEG,
                cellMeters: IDX_CELL_DEG * M_PER_DEG_LAT,
                maxRing: all.length ? (Math.max(maxI - minI, maxJ - minJ) + 1) : 0
            };
        },

        /**
         * 最近邻查询：小数据集直接暴力（少一次 Map 开销）；大数据集用环形扩散 + 剪枝
         */
        _nearest: function (idx, lng, lat) {
            if (!idx || idx.count === 0) return { dist: Infinity, point: null };

            if (idx.count <= 40) {
                let best = Infinity, bp = null;
                for (const q of idx.all) {
                    const d = Util.distance({ lng, lat }, q);
                    if (d < best) { best = d; bp = q; }
                }
                return { dist: best, point: bp };
            }

            const cs = idx.cell, m = idx.map;
            const ci = Math.floor(lng / cs), cj = Math.floor(lat / cs);
            let best = Infinity, bp = null;

            for (let k = 0; k <= idx.maxRing; k++) {
                // 剪枝：第 k 环上任意点距查询点至少 (k-1) × cellMeters，
                // 若已找到更近的结果，外圈不可能再更优，直接停。
                if (best !== Infinity && best <= Math.max(0, k - 1) * idx.cellMeters) break;
                for (let di = -k; di <= k; di++) {
                    for (let dj = -k; dj <= k; dj++) {
                        if (k > 0 && Math.abs(di) !== k && Math.abs(dj) !== k) continue;
                        const arr = m.get((ci + di) + ',' + (cj + dj));
                        if (!arr) continue;
                        for (const q of arr) {
                            const d = Util.distance({ lng, lat }, q);
                            if (d < best) { best = d; bp = q; }
                        }
                    }
                }
            }
            return { dist: best, point: bp };
        },

        /* ================================================================
         * ③-a 直线距离场
         * ================================================================ */

        /**
         * 对每个栅格点，求到各类 POI 的直线最近距离 + 最近 POI 坐标
         * @returns {{ dist: Object<string,Float64Array>, pt: Object<string,Array>, worst: Float64Array }}
         */
        _straightField: function (cells, keys, indexes) {
            const n = cells.length;
            const dist = {}, pt = {};
            keys.forEach(k => { dist[k] = new Float64Array(n); pt[k] = new Array(n); });

            for (let i = 0; i < n; i++) {
                const cell = cells[i];
                for (const k of keys) {
                    const r = this._nearest(indexes[k], cell.lng, cell.lat);
                    dist[k][i] = r.dist;
                    pt[k][i] = r.point;
                }
            }
            return { dist, pt };
        },

        /* ================================================================
         * ② λ 标定（路网绕行系数）
         * ================================================================ */

        /**
         * 抽锚点 → 真实 WalkingRoute → λ = 步行距离 / 直线距离 → 取中位数
         *
         * 锚点选取策略（关键，直接决定 λ 的代表性）：
         *   判定边界在「直线距离 ≈ 1000 / λ_default ≈ 800m」附近。
         *   λ 在边界附近的准确性对最终盲区判定影响最大；
         *   在"离 POI 只有 50m"或"离 POI 3000m"的地方标定，对判定边界几乎没有帮助。
         *   所以：先按 |d_straight − target| 升序圈出候选池，再用最远点采样（FPS）
         *   从池里挑出空间上尽量分散的 N 个，兼顾"贴近判定边界"与"覆盖不同方位"。
         */
        _calibrateLambda: async function (cells, straight, keys, CFG, onStep) {
            const target = CFG.radiusMeters / CFG.lambdaDefault;

            // —— 先算出每个点"三类里最容易到达的那类"的直线距离（= 判定基准）——
            const worstStraight = new Float64Array(cells.length);
            const worstKey = new Array(cells.length);
            for (let i = 0; i < cells.length; i++) {
                let mn = Infinity, mk = null;
                for (const k of keys) {
                    const d = straight.dist[k][i];
                    if (d < mn) { mn = d; mk = k; }
                }
                worstStraight[i] = mn;
                worstKey[i] = mk;
            }

            // —— 候选池：直线距离够长（避免短距离噪声）+ 靠近判定边界 ——
            const cand = [];
            for (let i = 0; i < cells.length; i++) {
                if (worstStraight[i] < CFG.calibMinStraightMeters) continue;
                cand.push({ i, gap: Math.abs(worstStraight[i] - target) });
            }
            if (cand.length === 0) {
                return { lambda: CFG.lambdaDefault, samples: 0, fallback: true, detail: [] };
            }
            cand.sort((a, b) => a.gap - b.gap);

            const poolSize = Math.min(cand.length, Math.max(CFG.calibAnchors * 4, CFG.calibAnchors));
            const pool = cand.slice(0, poolSize);

            // —— 最远点采样：保证锚点在空间上分散，不聚成一坨 ——
            const anchors = [];
            const picked = [pool[0]];
            anchors.push(pool[0]);
            while (anchors.length < CFG.calibAnchors && picked.length < pool.length) {
                let bestIdx = -1, bestD = -1;
                for (let t = 0; t < pool.length; t++) {
                    if (picked.indexOf(pool[t]) >= 0) continue;
                    let mn = Infinity;
                    for (const p of picked) {
                        const d = Util.distance(cells[pool[t].i], cells[p.i]);
                        if (d < mn) mn = d;
                    }
                    if (mn > bestD) { bestD = mn; bestIdx = t; }
                }
                if (bestIdx < 0) break;
                picked.push(pool[bestIdx]);
                anchors.push(pool[bestIdx]);
            }

            // —— 并发调真实步行路径 ——
            let done = 0;
            const total = anchors.length;
            onStep && onStep(0, total);

            const detail = await Util.pmap(anchors, async (a) => {
                const cell = cells[a.i];
                const k = worstKey[a.i];
                const poi = straight.pt[k] && straight.pt[k][a.i];
                if (!poi) return null;

                const walkDist = await this._walkDistance(
                    { lng: cell.lng, lat: cell.lat },
                    { lng: poi.lng, lat: poi.lat },
                    CFG.calibTimeoutMs
                );
                done++;
                onStep && onStep(done, total);
                if (!walkDist || walkDist <= 0) return null;

                const lambda = walkDist / worstStraight[a.i];
                if (!isFinite(lambda) || lambda <= 0) return null;
                return {
                    lng: cell.lng, lat: cell.lat, key: k,
                    straight: Math.round(worstStraight[a.i]),
                    walk: Math.round(walkDist),
                    lambda: lambda
                };
            }, CFG.calibConcurrency);

            const samples = detail.filter(Boolean);
            if (samples.length < 2) {
                return {
                    lambda: CFG.lambdaDefault,
                    samples: samples.length,
                    fallback: true,
                    detail: samples
                };
            }

            // 中位数抗异常值（个别锚点可能绕远路，λ 飙到 3+）
            const arr = samples.map(s => s.lambda).sort((x, y) => x - y);
            const mid = arr.length % 2 ? arr[(arr.length - 1) / 2]
                                       : (arr[arr.length / 2 - 1] + arr[arr.length / 2]) / 2;
            const lambda = Util.clamp(mid, CFG.lambdaMin, CFG.lambdaMax);

            return {
                lambda,
                lambdaRaw: mid,
                samples: samples.length,
                fallback: false,
                clamped: Math.abs(lambda - mid) > 1e-9,
                detail: samples
            };
        },

        /**
         * 调一次 WalkingRoute，返回真实步行距离（米）；失败返回 null
         * 距离由路径点逐段累加求得，不依赖 getDistance()（不同版本返回类型不一致）
         */
        _walkDistance: function (start, end, timeoutMs) {
            return new Promise((resolve) => {
                if (typeof BMapGL === 'undefined' || !global.__bmap) { resolve(null); return; }

                let settled = false;
                const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
                const timer = setTimeout(() => finish(null), timeoutMs || 6000);

                let route = null;
                const onDone = function (results) {
                    clearTimeout(timer);
                    const pts = extractPath(results, route);
                    finish(pts ? pathLength(pts) : null);
                };

                const variants = [
                    { renderOptions: { map: null, autoViewport: false }, onSearchComplete: onDone },
                    { onSearchComplete: onDone }
                ];
                for (const opts of variants) {
                    try { route = new BMapGL.WalkingRoute(global.__bmap, opts); break; }
                    catch (e) { route = null; }
                }
                if (!route) { clearTimeout(timer); finish(null); return; }

                try {
                    if (typeof route.setSearchCompleteCallback === 'function') {
                        route.setSearchCompleteCallback(function () {
                            clearTimeout(timer);
                            const pts = extractPath(null, route);
                            finish(pts ? pathLength(pts) : null);
                        });
                    }
                } catch (e) { /* 部分版本无此方法，忽略 */ }

                try {
                    route.search(
                        new BMapGL.Point(start.lng, start.lat),
                        new BMapGL.Point(end.lng, end.lat)
                    );
                } catch (e) {
                    clearTimeout(timer);
                    finish(null);
                }
            });
        },

        /* ================================================================
         * ③④ 距离场插值 + 盲区判定
         * ================================================================ */

        /**
         * 步行距离场 = 直线距离 × λ
         * 这就是配套标准鼓励的「空间插值」：用少量真实路网观测（λ）外推全域，
         * 而不是对每个栅格点都发一次路径规划请求。
         */
        _walkField: function (n, keys, straight, lambda) {
            const walk = {};
            keys.forEach(k => {
                const src = straight.dist[k];
                const dst = new Float64Array(n);
                for (let i = 0; i < n; i++) dst[i] = src[i] * lambda;
                walk[k] = dst;
            });
            return walk;
        },

        /**
         * 盲区判定：三类步行距离**全部** > radiusMeters
         *
         * 定义 worstDist = min(三类距离) —— 即"最容易够到的那一类"的距离。
         *   判定等价于 worstDist > radiusMeters（因为 min 都超了，三类必然全超）
         *   worstDist 同时是天然的"缺口强度"指标：越大越荒，可直接驱动分级着色。
         */
        _classify: function (n, keys, walk, CFG) {
            const worst = new Float64Array(n);
            const worstKey = new Array(n);
            const bottleneck = new Array(n);   // 三类里"最难够到"的那类 → 主要缺口成因
            const perKeyOver = {};             // 各类单独超阈值的点数（用于缺失率统计）
            keys.forEach(k => { perKeyOver[k] = 0; });

            for (let i = 0; i < n; i++) {
                let mn = Infinity, mk = null, mx = -Infinity, xk = null;
                for (const k of keys) {
                    const d = walk[k][i];
                    if (d < mn) { mn = d; mk = k; }
                    if (d > mx) { mx = d; xk = k; }
                    if (d > CFG.radiusMeters) perKeyOver[k]++;
                }
                worst[i] = mn;
                worstKey[i] = mk;
                bottleneck[i] = xk;
            }

            const isGap = new Uint8Array(n);
            const level = new Uint8Array(n);   // 0=非盲区 1=一般盲区 2=重度盲区
            let gapCount = 0, severeCount = 0;
            for (let i = 0; i < n; i++) {
                if (worst[i] > CFG.radiusMeters) {
                    isGap[i] = 1;
                    gapCount++;
                    if (worst[i] > CFG.severeMeters) { level[i] = 2; severeCount++; }
                    else level[i] = 1;
                }
            }

            return { worst, worstKey, bottleneck, perKeyOver, isGap, level, gapCount, severeCount };
        },

        /* ================================================================
         * ⑤ 连通斑块聚合
         * ================================================================ */

        /**
         * 栅格 4 邻域连通分量 → 连片盲区斑块
         * 单点噪声（< 3 格）直接丢弃，避免把零星误判当成"一片盲区"
         */
        _patches: function (grid, isGap, worst, CFG) {
            const cells = grid.cells;
            const keyOf = (r, c) => r * 1000000 + c;

            const idxOf = new Map();
            const gapSet = new Set();
            for (let i = 0; i < cells.length; i++) {
                const k = keyOf(cells[i].r, cells[i].c);
                idxOf.set(k, i);
                if (isGap[i]) gapSet.add(k);
            }
            if (gapSet.size === 0) return [];

            const seen = new Set();
            const raw = [];

            for (const startKey of gapSet) {
                if (seen.has(startKey)) continue;
                seen.add(startKey);
                const stack = [startKey];
                const members = [];

                while (stack.length) {
                    const cur = stack.pop();
                    const ci = idxOf.get(cur);
                    members.push(ci);
                    const cell = cells[ci];
                    const nbs = [
                        keyOf(cell.r + 1, cell.c), keyOf(cell.r - 1, cell.c),
                        keyOf(cell.r, cell.c + 1), keyOf(cell.r, cell.c - 1)
                    ];
                    for (const nk of nbs) {
                        if (gapSet.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk); }
                    }
                }
                if (members.length >= 3) raw.push(members);
            }

            const cellArea = grid.cellAreaM2 || (grid.stepMeters * grid.stepMeters);
            const patches = raw.map(members => {
                let sumLng = 0, sumLat = 0, sumW = 0, maxW = -Infinity, worstAt = null;
                for (const i of members) {
                    sumLng += cells[i].lng;
                    sumLat += cells[i].lat;
                    sumW += worst[i];
                    if (worst[i] > maxW) { maxW = worst[i]; worstAt = cells[i]; }
                }
                const size = members.length;
                return {
                    size,
                    members,
                    areaM2: size * cellArea,
                    centroid: { lng: sumLng / size, lat: sumLat / size },
                    avgGap: sumW / size,
                    maxGap: maxW,
                    worstAt,
                    // 严重度积分 = 面积 × 平均缺口强度（越大越该优先补）
                    severity: size * (sumW / size)
                };
            });

            patches.sort((a, b) => b.severity - a.severity);
            return patches.slice(0, CFG.topPatches);
        },

        /* ================================================================
         * 结果组装
         * ================================================================ */

        _buildResult: function (o) {
            const { grid, keys, walk, cls, patches, calib, poiCount, center, CFG } = o;
            const n = grid.cells.length;
            const gapCount = cls.gapCount;

            // 盲区点位明细（抽样，避免把几千个点塞进内存对象图）
            const gapPoints = [];
            for (let i = 0; i < n; i++) {
                if (!cls.isGap[i]) continue;
                const d = {};
                keys.forEach(k => { d[k] = Math.round(walk[k][i]); });
                gapPoints.push({
                    lng: grid.cells[i].lng,
                    lat: grid.cells[i].lat,
                    dist: d,
                    worst: Math.round(cls.worst[i]),
                    level: cls.level[i],
                    bottleneck: cls.bottleneck[i]
                });
            }

            // 最差点位：worst 最大（三类里最容易够到的那类都最远）
            let worstPoint = null;
            if (gapPoints.length) {
                worstPoint = gapPoints.reduce((a, b) => (b.worst > a.worst ? b : a));
            }

            // 各类的"卡脖子"统计：在盲区点里，哪一类是最难够到的
            const bottleneckCount = {};
            keys.forEach(k => { bottleneckCount[k] = 0; });
            gapPoints.forEach(p => { bottleneckCount[p.bottleneck]++; });

            // 各类单独缺失率（该类的步行距离 > 阈值的栅格占比）
            const missingRate = {};
            keys.forEach(k => { missingRate[k] = n > 0 ? cls.perKeyOver[k] / n : 0; });

            // 中心点自身的盲区状态（报告里最常被问到的一句话结论）
            let centerStatus = null;
            if (center && typeof center.lng === 'number') {
                let bi = -1, bd = Infinity;
                for (let i = 0; i < n; i++) {
                    const d = Util.distance(center, grid.cells[i]);
                    if (d < bd) { bd = d; bi = i; }
                }
                if (bi >= 0) {
                    const d = {};
                    keys.forEach(k => { d[k] = Math.round(walk[k][bi]); });
                    centerStatus = {
                        isGap: !!cls.isGap[bi],
                        level: cls.level[bi],
                        worst: Math.round(cls.worst[bi]),
                        dist: d
                    };
                }
            }

            return {
                enabled: true,
                ok: true,

                // 参数快照（报告里要透明展示，方便复现）
                params: {
                    radiusMeters: CFG.radiusMeters,
                    severeMeters: CFG.severeMeters,
                    gridStepMeters: Math.round(grid.stepMeters),
                    stepAutoEnlarged: !!grid.stepAutoEnlarged,
                    checkKeys: keys.slice()
                },

                // λ 标定
                lambda: calib.lambda,
                lambdaRaw: calib.lambdaRaw,
                lambdaFallback: !!calib.fallback,
                lambdaClamped: !!calib.clamped,
                lambdaSamples: calib.samples,
                lambdaDetail: calib.detail || [],

                // 规模
                gridCount: n,
                gapCount,
                severeCount: cls.severeCount,
                gapRatio: n > 0 ? gapCount / n : 0,
                gapAreaM2: gapCount * (grid.cellAreaM2 || grid.stepMeters * grid.stepMeters),
                poiCount,

                // 明细
                gapPoints,
                worstPoint,
                patches,
                bottleneckCount,
                missingRate,
                centerStatus,

                // 内部引用（渲染 / 调试用，不参与序列化展示）
                _grid: grid,
                _walk: walk,
                _isGap: cls.isGap,
                _level: cls.level,
                _worst: cls.worst,
                _keys: keys
            };
        },

        _emptyResult: function (reason, CFG) {
            return {
                enabled: false,
                ok: false,
                reason,
                params: {
                    radiusMeters: CFG.radiusMeters,
                    severeMeters: CFG.severeMeters,
                    gridStepMeters: CFG.gridStepMeters,
                    checkKeys: (CFG.checkKeys || []).slice()
                },
                lambda: CFG.lambdaDefault,
                lambdaFallback: true,
                lambdaSamples: 0,
                gridCount: 0,
                gapCount: 0,
                severeCount: 0,
                gapRatio: 0,
                gapAreaM2: 0,
                gapPoints: [],
                patches: [],
                centerStatus: null
            };
        },

        _cfg: function () {
            const c = (typeof global.BLIND_GAP === 'object' && global.BLIND_GAP) ? global.BLIND_GAP : {};
            const out = {};
            for (const k in FALLBACK_CFG) {
                out[k] = (c[k] !== undefined && c[k] !== null) ? c[k] : FALLBACK_CFG[k];
            }
            return out;
        },

        /* ================================================================
         * 地图渲染
         *
         * 用 Canvas 覆盖层画点（仿 heatmap.js），而不是给每个盲区点加一个
         * BMapGL.Circle —— 盲区点动辄数百上千，矢量覆盖层会明显掉帧。
         * Canvas 一次 draw 全部画完，且随地图平移/缩放实时重投影。
         * ================================================================ */

        render: function (map, result) {
            this.clear(map);
            if (!result || !result.enabled || !result.gapCount) return;

            this.map = map;
            this.lastResult = result;
            this.visible = true;

            if (!this.wrapper) this._ensureDom(map);
            if (!this.wrapper) return;

            this.wrapper.style.display = 'block';
            this._drawPatchesLabel(map, result);
            this.refresh();
        },

        _ensureDom: function (map) {
            const container = map.getContainer();
            if (!container) return;

            const wrapper = document.createElement('div');
            wrapper.className = 'gap-overlay';
            wrapper.style.cssText = `
                position:absolute; top:0; left:0;
                width:${map.getSize().width}px; height:${map.getSize().height}px;
                pointer-events:none; z-index:0; display:none;`;

            const canvas = document.createElement('canvas');
            canvas.style.cssText = 'display:block;width:100%;height:100%;';
            wrapper.appendChild(canvas);
            // 插到容器第一个子节点前面 → 渲染在地图 WebGL 层下方，不会遮挡 POI 图标
            if (container.firstChild) {
                container.insertBefore(wrapper, container.firstChild);
            } else {
                container.appendChild(wrapper);
            }

            this.wrapper = wrapper;
            this.canvas = canvas;

            const onMove = () => this.refresh();
            ['movestart', 'moving', 'moveend', 'zoomstart', 'zoomend', 'resize'].forEach(ev => {
                map.addEventListener(ev, onMove);
                this.mapListeners.push([ev, onMove]);
            });
        },

        refresh: function () {
            const map = this.map, result = this.lastResult;
            if (!map || !this.canvas || !result || !result.enabled || !this.visible) return;

            const size = map.getSize();
            const w = size.width, h = size.height;
            const dpr = Math.max(1, window.devicePixelRatio || 1);

            if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
                this.canvas.width = Math.round(w * dpr);
                this.canvas.height = Math.round(h * dpr);
                this.canvas.style.width = w + 'px';
                this.canvas.style.height = h + 'px';
                this.wrapper.style.width = w + 'px';
                this.wrapper.style.height = h + 'px';
            }

            const ctx = this.canvas.getContext('2d');
            ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

            const pts = result.gapPoints;
            const CFG = this._cfg();
            const maxN = CFG.maxRenderPoints || 1200;
            const stride = pts.length > maxN ? Math.ceil(pts.length / maxN) : 1;

            // 半径随缩放：放大时点也放大，但限幅避免糊成一片
            const zoom = (typeof map.getZoom === 'function') ? map.getZoom() : 15;
            const rBase = Util.clamp((zoom - 11) * 0.9, 2.5, 7) * dpr;

            for (let i = 0; i < pts.length; i += stride) {
                const p = pts[i];
                let px;
                try { px = map.pointToOverlayPixel(new BMapGL.Point(p.lng, p.lat)); }
                catch (e) { continue; }
                if (!px) continue;

                const x = px.x * dpr, y = px.y * dpr;
                if (x < -20 || x > this.canvas.width + 20 || y < -20 || y > this.canvas.height + 20) continue;

                const severe = p.level === 2;
                ctx.beginPath();
                ctx.arc(x, y, rBase, 0, Math.PI * 2);
                ctx.fillStyle = severe ? 'rgba(255,84,112,0.62)' : 'rgba(255,181,71,0.55)';
                ctx.fill();

                if (severe) {
                    ctx.beginPath();
                    ctx.arc(x, y, rBase * 1.9, 0, Math.PI * 2);
                    ctx.strokeStyle = 'rgba(255,84,112,0.30)';
                    ctx.lineWidth = 1 * dpr;
                    ctx.stroke();
                }
            }
        },

        /**
         * Top-N 斑块打标签（矢量 Label，数量 ≤ 3，无性能压力）
         */
        _drawPatchesLabel: function (map, result) {
            const marks = ['①', '②', '③', '④', '⑤'];
            (result.patches || []).forEach((pt, i) => {
                try {
                    const label = new BMapGL.Label(
                        `<div class="gap-patch-label">盲区${marks[i] || (i + 1)} · ${(pt.areaM2 / 1e4).toFixed(1)} 公顷</div>`,
                        {
                            position: new BMapGL.Point(pt.centroid.lng, pt.centroid.lat),
                            offset: new BMapGL.Size(0, 0)
                        }
                    );
                    label.setStyle({
                        border: 'none',
                        background: 'transparent',
                        padding: '0',
                        cursor: 'default'
                    });
                    map.addOverlay(label);
                    this.labels.push(label);
                } catch (e) { /* 标签失败不影响主流程 */ }
            });
        },

        clear: function (map) {
            this.visible = false;
            this.labels.forEach(l => { try { map && map.removeOverlay(l); } catch (e) {} });
            this.labels = [];
            if (this.canvas) {
                try {
                    const ctx = this.canvas.getContext('2d');
                    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
                } catch (e) {}
            }
            if (this.wrapper) this.wrapper.style.display = 'none';
        },

        /**
         * 彻底销毁（切换体检时调用，解绑地图事件防止内存泄漏）
         */
        destroy: function (map) {
            this.clear(map);
            if (map) {
                this.mapListeners.forEach(([ev, fn]) => {
                    try { map.removeEventListener(ev, fn); } catch (e) {}
                });
            }
            this.mapListeners = [];
            if (this.wrapper && this.wrapper.parentNode) {
                this.wrapper.parentNode.removeChild(this.wrapper);
            }
            this.wrapper = null;
            this.canvas = null;
            this.lastResult = null;
        }
    };

    /* ====================================================================
     * 模块内私有：WalkingRoute 路径提取 / 路径长度
     * （与 isochrone.js 中的 extractPath 同逻辑，因是模块私有函数故各留一份）
     * ==================================================================== */

    function extractPath(results, route) {
        const chains = [
            () => results && results.getPlan && results.getPlan(0) && results.getPlan(0).getRoute && results.getPlan(0).getRoute(0) && results.getPlan(0).getRoute(0).getPath(),
            () => route && route.getPlan && route.getPlan(0) && route.getPlan(0).getRoute && route.getPlan(0).getRoute(0) && route.getPlan(0).getRoute(0).getPath(),
            () => route && route.getResults && route.getResults() && route.getResults().getPlan && route.getResults().getPlan(0) && route.getResults().getPlan(0).getRoute && route.getResults().getPlan(0).getRoute(0) && route.getResults().getPlan(0).getRoute(0).getPath(),
            () => results && results.getPlan && results.getPlan(0) && results.getPlan(0).getPath(),
            () => route && route.getPlan && route.getPlan(0) && route.getPlan(0).getPath()
        ];
        for (const fn of chains) {
            try {
                const arr = fn();
                if (Array.isArray(arr)) {
                    const pts = arr.filter(p => p && (p.lng !== undefined || p.getLng)).map(p => ({
                        lng: typeof p.lng === 'number' ? p.lng : p.getLng && p.getLng(),
                        lat: typeof p.lat === 'number' ? p.lat : p.getLat && p.getLat()
                    })).filter(p => typeof p.lng === 'number' && typeof p.lat === 'number');
                    if (pts.length > 1) return pts;
                }
            } catch (e) { /* 换下一种调用链 */ }
        }
        return null;
    }

    function pathLength(pts) {
        let sum = 0;
        for (let i = 1; i < pts.length; i++) sum += Util.distance(pts[i - 1], pts[i]);
        return sum;
    }

    global.GapFinder = GapFinder;
})(window);
