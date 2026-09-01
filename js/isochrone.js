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

                const timer = setTimeout(() => finish(fallbackPt()), 6000);

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
