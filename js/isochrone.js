/**
 * 15 分钟步行等时圈生成器
 *
 * 核心算法：
 * 1. 以中心点为圆心，在 ISO.sampleCount 个均匀方向上各取一个远点（>15min 步行距离）
 * 2. 对每个方向调用 BMapGL.WalkingRoute 获取真实路网路径
 * 3. 在路径上按 walkSpeed × walkMinutes 计算对应距离，并插值出该方向的边界点
 * 4. N 个边界点构成多边形（非圆，覆盖真实路网可达区域）
 *
 * 为什么不用圆形辐射？
 * - 真实路网（小区、河流、立交）会让步行可达区域呈不规则形状
 * - 圆形辐射会高估步行可达区或纳入实际到不了的区域（穿墙、跨河）
 * - 算法多花几秒换来"真实路网"的等时圈，对生活圈体检可信度至关重要
 */
(function (global) {
    'use strict';

    const Isochrone = {

        polygon: null,
        centerMarker: null,
        pulseMarker: null,

        /**
         * 根据中心点计算 15 分钟等时圈，返回多点数组
         * @param {BMapGL.Point} center
         * @param {(progress:number,msg:string)=>void} onProgress
         */
        build: async function (center, onProgress) {
            if (!center) throw new Error('center required');
            onProgress && onProgress(0, '初始化采样方向');

            const directions = [];
            for (let i = 0; i < ISO.sampleCount; i++) {
                const bearing = (i * 360 / ISO.sampleCount);
                directions.push({
                    idx: i,
                    bearing,
                    farPt: Util.destination(center, ISO.farDistance, bearing)
                });
            }

            const targetDist = ISO.walkSpeed * ISO.walkMinutes;
            let completed = 0;

            const samples = await Util.pmap(directions, async (dir) => {
                const pt = await this._walkOne(
                    new BMapGL.Point(center.lng, center.lat),         // start 必须是 BMapGL.Point
                    new BMapGL.Point(dir.farPt.lng, dir.farPt.lat),   // end 同上（百度 SDK 内部读 .lat 失败）
                    targetDist,
                    dir.bearing
                );
                completed++;
                onProgress && onProgress(completed / ISO.sampleCount,
                    `步行路径采样 ${completed}/${ISO.sampleCount}`);
                return pt;
            }, ISO.routeConcurrency);

            return samples.filter(Boolean);
        },

        _walkOne: function (start, end, targetDist, bearing) {
            return new Promise((resolve) => {
                let done = false;
                const fallbackPt = () =>
                    Util.destination({ lng: start.lng, lat: start.lat }, targetDist, bearing);
                const finish = (pt) => { if (!done) { done = true; resolve(pt || fallbackPt()); } };

                const timer = setTimeout(() => finish(fallbackPt()), 15000);

                const onDone = function (results) {
                    clearTimeout(timer);
                    const pts = extractPath(results, route);
                    finish(pts ? Util.pointAtDistance(pts, targetDist) : fallbackPt());
                };

                // 构造参数分级降级：renderOptions.map=null 表示不把路线画到地图上（我们只要数据）
                // 部分版本不接受 map:null，故准备两套参数依次尝试
                const variants = [
                    { renderOptions: { map: null, autoViewport: false }, onSearchComplete: onDone },
                    { onSearchComplete: onDone }
                ];

                let route = null;
                for (const opts of variants) {
                    try { route = new BMapGL.WalkingRoute(global.__bmap, opts); break; }
                    catch (e) { route = null; }
                }
                if (!route) { clearTimeout(timer); finish(fallbackPt()); return; }

                // 兼容部分版本只触发 setSearchCompleteCallback 的情况
                try {
                    if (typeof route.setSearchCompleteCallback === 'function') {
                        route.setSearchCompleteCallback(function () {
                            clearTimeout(timer);
                            const pts = extractPath(null, route);
                            finish(pts ? Util.pointAtDistance(pts, targetDist) : fallbackPt());
                        });
                    }
                } catch (e) {}

                try { route.search(start, end); }
                catch (e) {
                    clearTimeout(timer);
                    finish(Util.destination({ lng: start.lng, lat: start.lat }, targetDist, bearing));
                }
            });
        },

        /**
         * 与 _walkOne 类似，但【返回完整路径点数组】（不按 targetDist 截断），
         * 路由失败时回退为「中心点 → 远点」的 2 点径向线，保证后续可按任意 targetDist 截断。
         * 这是「一次采样、多种速度各自截断」方案的基础：5 类人员共用这 16 条完整路径，
         * 避免每类各跑一次 WalkingRoute（5×16=80 次 → 仅 16 次）。
         */
        _walkFull: function (start, end, bearing, farPt) {
            return new Promise((resolve) => {
                let done = false;
                const radial = [{ lng: start.lng, lat: start.lat }, farPt];
                const fallback = () => radial;
                const finish = (pts) => { if (!done) { done = true; resolve(pts && pts.length > 1 ? pts : fallback()); } };

                const timer = setTimeout(() => finish(fallback()), 15000);

                const onDone = function (results) {
                    clearTimeout(timer);
                    const pts = extractPath(results, route);
                    finish(pts && pts.length > 1 ? pts : null);
                };

                const variants = [
                    { renderOptions: { map: null, autoViewport: false }, onSearchComplete: onDone },
                    { onSearchComplete: onDone }
                ];

                let route = null;
                for (const opts of variants) {
                    try { route = new BMapGL.WalkingRoute(global.__bmap, opts); break; }
                    catch (e) { route = null; }
                }
                if (!route) { clearTimeout(timer); finish(fallback()); return; }

                try {
                    if (typeof route.setSearchCompleteCallback === 'function') {
                        route.setSearchCompleteCallback(function () {
                            clearTimeout(timer);
                            const pts = extractPath(null, route);
                            finish(pts && pts.length > 1 ? pts : null);
                        });
                    }
                } catch (e) {}

                try { route.search(start, end); }
                catch (e) { clearTimeout(timer); finish(fallback()); }
            });
        },

        /**
         * 在地图上渲染等时圈 + 中心点
         * @returns {{polygon:BMapGL.Polygon, area:number}}
         */
        render: function (map, samples, center) {
            this.clear(map);

            if (!samples || samples.length < 3) {
                return { polygon: null, area: 0 };
            }

            // 让 polygon 闭合
            const pts = samples.map(p => new BMapGL.Point(p.lng, p.lat));

            const polygon = new BMapGL.Polygon(pts, {
                strokeColor: '#5b9bff',
                strokeWeight: 2,
                strokeOpacity: 0.9,
                strokeStyle: 'solid',
                fillColor: '#3a7afe',
                fillOpacity: 0.22
            });
            map.addOverlay(polygon);

            // 中心点 marker（带 SVG pulse）
            const centerSvg = `
                <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
                  <circle cx="20" cy="20" r="14" fill="#ff5470" opacity="0.18"/>
                  <circle cx="20" cy="20" r="9"  fill="#ff5470" opacity="0.35"/>
                  <circle cx="20" cy="20" r="5"  fill="#ff5470" stroke="#fff" stroke-width="2"/>
                </svg>`.trim();

            const icon = new BMapGL.Icon(
                'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(centerSvg),
                new BMapGL.Size(40, 40),
                { anchor: new BMapGL.Size(20, 20) }
            );
            const mk = new BMapGL.Marker(center, { icon, title: '体检中心' });
            mk.setZIndex(999);
            map.addOverlay(mk);

            this.polygon = polygon;
            this.centerMarker = mk;

            return { polygon, area: Util.polygonArea(pts) };
        },

        /**
         * 默认等时圈多边形样式（供对比模式复用）
         */
        defaultStyle: function () {
            return {
                strokeColor: '#5b9bff',
                strokeWeight: 2,
                strokeOpacity: 0.9,
                strokeStyle: 'solid',
                fillColor: '#3a7afe',
                fillOpacity: 0.22
            };
        },

        /**
         * 仅构造多边形点数组（不添加到地图，供对比模式离线使用）
         * @param {Array} samples - build() 返回的采样点
         * @param {BMapGL.Point} center
         * @returns {Array<BMapGL.Point>} 闭合多边形顶点
         */
        buildPolygon: function (samples, center) {
            if (!samples || samples.length < 3) return [];
            return samples.map(p => new BMapGL.Point(p.lng, p.lat));
        },

        /**
         * 一次性采样 N 个方向的【完整步行路径】（不过滤、不截断）。
         * @param {BMapGL.Point} center 中心点
         * @param {number} farDistance 远点距离（米）——应取「最快人群 × 时长 × 冗余」，保证覆盖所有人员
         * @returns {Promise<Array<Array<{lng,lat}>>>} 长度 = sampleCount，每项是一条完整路径（或 2 点径向回退）
         */
        buildPaths: async function (center, farDistance, onProgress) {
            if (!center) throw new Error('center required');
            const directions = [];
            for (let i = 0; i < ISO.sampleCount; i++) {
                const bearing = (i * 360 / ISO.sampleCount);
                directions.push({ idx: i, bearing, farPt: Util.destination(center, farDistance, bearing) });
            }
            let completed = 0;
            const fullPaths = await Util.pmap(directions, async (dir) => {
                const pts = await this._walkFull(
                    new BMapGL.Point(center.lng, center.lat),
                    new BMapGL.Point(dir.farPt.lng, dir.farPt.lat),
                    dir.bearing,
                    dir.farPt
                );
                completed++;
                onProgress && onProgress(completed / ISO.sampleCount, `步行路径采样 ${completed}/${ISO.sampleCount}`);
                return pts;
            }, ISO.routeConcurrency);
            return fullPaths;
        },

        /**
         * 用「完整路径」按 targetDist 截断，生成某一速度下的真实路网等时圈多边形并上图。
         * @param {Array<Array<{lng,lat}>>} fullPaths buildPaths 的返回
         * @param {BMapGL.Point} center
         * @param {number} targetDist 该速度下的目标弧长（= speed × walkMinutes）
         * @param {object} style 多边形样式（strokeColor / fillColor 等）
         * @returns {BMapGL.Polygon|null}
         */
        renderIsoForType: function (map, fullPaths, center, targetDist, style) {
            if (!fullPaths || !fullPaths.length) return null;
            const boundary = fullPaths.map(fp => {
                if (!fp || fp.length < 2) return null;
                const p = Util.pointAtDistance(fp, targetDist);
                return p || fp[fp.length - 1];
            }).filter(Boolean);
            if (boundary.length < 3) return null;
            const pts = boundary.map(p => new BMapGL.Point(p.lng, p.lat));
            const polygon = new BMapGL.Polygon(pts, style);
            map.addOverlay(polygon);
            return polygon;
        },

        /**
         * 仅绘制中心点 marker（带 SVG pulse），不画等时圈。供「各人员步行区域」模式在隐藏主等时圈后补回中心点。
         * @returns {BMapGL.Marker}
         */
        renderCenterMarker: function (map, center) {
            const centerSvg = `
                <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
                  <circle cx="20" cy="20" r="14" fill="#ff5470" opacity="0.18"/>
                  <circle cx="20" cy="20" r="9"  fill="#ff5470" opacity="0.35"/>
                  <circle cx="20" cy="20" r="5"  fill="#ff5470" stroke="#fff" stroke-width="2"/>
                </svg>`.trim();
            const icon = new BMapGL.Icon(
                'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(centerSvg),
                new BMapGL.Size(40, 40),
                { anchor: new BMapGL.Size(20, 20) }
            );
            const mk = new BMapGL.Marker(center, { icon, title: '体检中心' });
            mk.setZIndex(999);
            map.addOverlay(mk);
            return mk;
        },

        /**
         * 用「完整路径」按目标弧长截断，渲染主人群真实路网等时圈 + 中心点。
         * 与 render() 的区别：输入是 buildPaths() 返回的 16 向完整路径（而非单次采样点），
         * 主等时圈与各人群真实评分复用同一份路径，避免重复 16 次路由。
         * 会登记 this.polygon / this.centerMarker，供 clear() 与「展示各人员步行区域」恢复逻辑复用。
         * @returns {{polygon:BMapGL.Polygon, area:number}}
         */
        renderFromPaths: function (map, fullPaths, center, targetDist, style) {
            this.clear(map);
            if (!fullPaths || fullPaths.length < 3) return { polygon: null, area: 0 };
            const boundary = fullPaths.map(fp => {
                if (!fp || fp.length < 2) return null;
                const p = Util.pointAtDistance(fp, targetDist);
                return p || fp[fp.length - 1];
            }).filter(Boolean);
            if (boundary.length < 3) return { polygon: null, area: 0 };
            const pts = boundary.map(p => new BMapGL.Point(p.lng, p.lat));
            const polygon = new BMapGL.Polygon(pts, style || this.defaultStyle());
            map.addOverlay(polygon);
            const mk = this.renderCenterMarker(map, center);
            this.polygon = polygon;
            this.centerMarker = mk;
            return { polygon, area: Util.polygonArea(pts) };
        },

        clear: function (map) {
            if (this.polygon)      { map.removeOverlay(this.polygon); this.polygon = null; }
            if (this.centerMarker) { map.removeOverlay(this.centerMarker); this.centerMarker = null; }
            if (this.pulseMarker)  { map.removeOverlay(this.pulseMarker); this.pulseMarker = null; }
        }
    };

    /**
     * 从 WalkingRoute 结果中提取路径点数组
     * 百度 JS API 不同版本取路径的调用链不一致，这里做防御式兼容：
     *   GL 官方示例：results.getPlan(0).getRoute(0).getPath()
     *   经典 BMap ：route.getPlan(0).getRoute(0).getPath()
     *   部分版本  ：results.getPlan(0).getPath()
     * @returns {Array<BMapGL.Point>|null}
     */
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
                    // 过滤空项 + 统一成 {lng, lat} 字面量
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

    global.Isochrone = Isochrone;
})(window);
