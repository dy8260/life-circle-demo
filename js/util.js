/**
 * 通用工具方法
 * - 并发限流 Promise.map
 * - 球面距离 / 多边形面积
 * - 路径按弧长找点
 */
(function (global) {
    'use strict';

    const util = {};

    /**
     * 并发限流 Promise.map(arr, fn, concurrency)
     * 适用于百度 API QPS 限制场景
     */
    util.pmap = function (arr, fn, concurrency = 3) {
        const results = new Array(arr.length);
        let idx = 0;
        const workers = new Array(Math.min(concurrency, arr.length)).fill(0).map(async () => {
            while (true) {
                const cur = idx++;
                if (cur >= arr.length) return;
                try { results[cur] = await fn(arr[cur], cur); }
                catch (e) { results[cur] = null; console.warn('pmap error', e); }
            }
        });
        return Promise.all(workers).then(() => results);
    };

    /**
     * 基于经纬度的两点距离（米，使用 Haversine）
     */
    util.distance = function (p1, p2) {
        const R = 6371008.8; // 平均地球半径 m
        const lat1 = p1.lat * Math.PI / 180;
        const lat2 = p2.lat * Math.PI / 180;
        const dLat = (p2.lat - p1.lat) * Math.PI / 180;
        const dLng = (p2.lng - p1.lng) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
                  Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    };

    /**
     * 给定路径（Point 数组）+ 目标弧长（米），插值出该点
     */
    util.pointAtDistance = function (path, targetDist) {
        if (!path || path.length === 0) return null;
        if (path.length === 1) return path[0];
        let acc = 0;
        for (let i = 1; i < path.length; i++) {
            const segDist = util.distance(path[i - 1], path[i]);
            if (acc + segDist >= targetDist) {
                const remain = targetDist - acc;
                const ratio = segDist === 0 ? 0 : remain / segDist;
                return {
                    lng: path[i - 1].lng + (path[i].lng - path[i - 1].lng) * ratio,
                    lat: path[i - 1].lat + (path[i].lat - path[i - 1].lat) * ratio
                };
            }
            acc += segDist;
        }
        // 全程不到目标距离 → 返回末端
        return path[path.length - 1];
    };

    /**
     * 经纬度多边形球面面积（平方米）
     * 使用《Map Projections: A Working Manual》(Snyder) 中的等面积纬线分带法
     */
    util.polygonArea = function (points) {
        if (!points || points.length < 3) return 0;
        const R = 6371008.8;
        let total = 0;
        for (let i = 0; i < points.length; i++) {
            const p1 = points[i];
            const p2 = points[(i + 1) % points.length];
            total += ((p2.lng - p1.lng) * Math.PI / 180) *
                     (2 + Math.sin(p1.lat * Math.PI / 180) +
                            Math.sin(p2.lat * Math.PI / 180));
        }
        return Math.abs(total * R * R / 2);
    };

    /**
     * 给定中心点和角度（度）+ 米距离，求远处的经纬度点
     */
    util.destination = function (center, distanceMeters, bearingDeg) {
        const R = 6371008.8;
        const brng = bearingDeg * Math.PI / 180;
        const lat1 = center.lat * Math.PI / 180;
        const lng1 = center.lng * Math.PI / 180;
        const dr = distanceMeters / R;

        const lat2 = Math.asin(Math.sin(lat1) * Math.cos(dr) +
                               Math.cos(lat1) * Math.sin(dr) * Math.cos(brng));
        const lng2 = lng1 + Math.atan2(Math.sin(brng) * Math.sin(dr) * Math.cos(lat1),
                                       Math.cos(dr) - Math.sin(lat1) * Math.sin(lat2));
        return { lng: lng2 * 180 / Math.PI, lat: lat2 * 180 / Math.PI };
    };

    /**
     * 数值限幅
     */
    util.clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    /**
     * 公共 emoji 状态判定
     */
    util.scoreLevel = function (score) {
        if (score >= 85) return { grade: 'A', text: '优秀', color: '#00d68f' };
        if (score >= 70) return { grade: 'B', text: '良好', color: '#3a7afe' };
        if (score >= 55) return { grade: 'C', text: '一般', color: '#ffb547' };
        return             { grade: 'D', text: '不足', color: '#ff5470' };
    };

    /**
     * 控制台分组日志（开发期）
     */
    util.logGroup = function (title, payload) {
        try { console.groupCollapsed('%c[生活圈]', 'color:#5b9bff', title); console.log(payload); console.groupEnd(); }
        catch (e) { console.log(title, payload); }
    };

    global.Util = util;
})(window);
