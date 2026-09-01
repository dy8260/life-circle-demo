/**
 * 周边 POI 检索器
 *
 * 策略：基于 15 分钟等时圈 polygon 的 Bounds 做 inBounds 检索
 * 五大类民生配套：医院 / 药店 / 商超 / 学校 / 公交
 * 百度 LocalSearch 单 keyword 单返回，因此每类可能搜多个关键字并合并去重
 *
 * 注意：百度 LocalSearch 返回的 result 结构在不同版本略有差异，
 * 这里采用防御式提取：兼容 getPoi/getNumPois、EnumerablePois、poiList 等多种可能形态
 */
(function (global) {
    'use strict';

    const POI = {

        markersByCategory: {},  // 分类 → marker 列表
        allResults: null,       // 最近一次完整检索结果（供热力图/报告使用）

        /**
         * 计算多边形顶点的 Bounds（BMapGL.Bounds 对象）
         */
        computeBounds: function (polygonPts) {
            if (!polygonPts || polygonPts.length === 0) return null;
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            polygonPts.forEach(p => {
                if (p.lng < minX) minX = p.lng;
                if (p.lng > maxX) maxX = p.lng;
                if (p.lat < minY) minY = p.lat;
                if (p.lat > maxY) maxY = p.lat;
            });
            return new BMapGL.Bounds(
                new BMapGL.Point(minX, minY),
                new BMapGL.Point(maxX, maxY)
            );
        },

        /**
         * 检索所有分类 POI
         * @param {BMapGL.Point} center
         * @param {Array} polygonPts
         * @param {(p:number,msg:string)=>void} onProgress
         * @returns {Object} { categoryKey: { ...meta, items: [...] } }
         */
        fetchAll: async function (center, polygonPts, onProgress) {
            if (!polygonPts || polygonPts.length < 3) return {};
            const bounds = this.computeBounds(polygonPts);
            if (!bounds) return {};

            let idx = 0;
            const tasks = POI_CATEGORIES.map(cat => ({
                cat,
                weight: 1,
                run: async () => {
                    const kwQueue = cat.keywords.slice(0, 2); // 最多搜两个关键字以节省 QPS
                    let all = [];
                    const seenUid = new Set();
                    for (let i = 0; i < kwQueue.length; i++) {
                        const list = await this._search(kwQueue[i], bounds);
                        list.forEach(p => {
                            if (seenUid.has(p.uid)) return;
                            seenUid.add(p.uid);
                            all.push(p);
                        });
                    }
                    idx++;
                    onProgress && onProgress(idx / POI_CATEGORIES.length,
                        `检索 ${cat.name} ${all.length} 处`);
                    return { category: cat, items: all };
                }
            }));

            const all = await Util.pmap(tasks, t => t.run(), 2);
            const out = {};
            all.forEach(({ category, items }) => {
                out[category.key] = { ...category, items };
            });
            this.allResults = out;
            return out;
        },

        _search: function (keyword, bounds) {
            return new Promise((resolve) => {
                let done = false;
                const finish = (list) => { if (!done) { done = true; resolve(list); } };
                const timer = setTimeout(() => finish([]), 8000);

                const onDone = function (result) {
                    clearTimeout(timer);
                    finish(extract(result));
                };
                const onErr = function () { clearTimeout(timer); finish([]); };

                // 构造参数分级降级：map:null 表示不让百度自动渲染 POI（我们自己画彩色图钉）
                // 但部分版本不接受 map:null，因此准备两套参数依次尝试
                const optsVariants = [
                    { pageCapacity: 50, renderOptions: { map: null, autoViewport: false },
                      onSearchComplete: onDone, onError: onErr },
                    { pageCapacity: 50,
                      onSearchComplete: onDone, onError: onErr }
                ];

                let local = null;
                for (const opts of optsVariants) {
                    try { local = new BMapGL.LocalSearch(global.__bmap, opts); break; }
                    catch (e) { local = null; }
                }
                if (!local) { clearTimeout(timer); finish([]); return; }

                try { local.searchInBounds(keyword, bounds); }
                catch (e) { clearTimeout(timer); finish([]); }

                function extract(result) {
                    if (!result) return [];
                    const list = [];
                    const push = (poi) => {
                        if (!poi) return;
                        const point = poi.point ||
                                      (poi.latLng && { lng: poi.latLng.lng, lat: poi.latLng.lat });
                        if (!point) return;
                        list.push({
                            title:   poi.title || poi.name || '未命名',
                            address: poi.address || '',
                            point:   { lng: point.lng, lat: point.lat },
                            uid:     poi.uid || (poi.title + '|' + point.lng.toFixed(5) + '|' + point.lat.toFixed(5))
                        });
                    };

                    // 官方用法（JSAPI 3.0/GL）：results.getCurrentNumPois() + results.getPoi(i)
                    // 另兼容 getNumPois() 及若干内部数组字段，防止版本差异导致空结果
                    const numGetters = ['getCurrentNumPois', 'getNumPois'];
                    for (const g of numGetters) {
                        try {
                            if (typeof result[g] === 'function' && typeof result.getPoi === 'function') {
                                const n = result[g]();
                                if (n > 0) {
                                    for (let i = 0; i < n; i++) push(result.getPoi(i));
                                }
                                if (list.length > 0) break;
                            }
                        } catch (e) {}
                    }

                    // 数组形态兜底
                    ['EnumerablePois', 'poiList', 'rows', 'pois', 'Pois'].forEach(k => {
                        try { if (Array.isArray(result[k])) result[k].forEach(push); } catch (e) {}
                    });

                    // 最后兜底：递归扫描 result 对象，捞取任何带坐标的 POI 条目
                    if (list.length === 0) deepScan(result, push);

                    return list;
                }

                /**
                 * 递归扫描：找出所有含 point/latLng 且带 title/name 的对象
                 * 用于百度返回结构再次变更时的最后防线
                 */
                function deepScan(obj, push, depth = 0, seen = new Set()) {
                    if (!obj || typeof obj !== 'object' || depth > 5 || seen.has(obj)) return;
                    seen.add(obj);
                    const hasPoint = (obj.point || obj.latLng) && (obj.title || obj.name);
                    if (hasPoint) { push(obj); return; }
                    for (const k in obj) {
                        if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
                        const v = obj[k];
                        if (v && typeof v === 'object') deepScan(v, push, depth + 1, seen);
                    }
                }
            });
        },

        /**
         * 把分类 POI 渲染到地图（彩色图钉 + 信息窗）
         * @param {BMapGL.Map} map
         * @param {Object} resultByKey
         * @param {BMapGL.Polygon} polygon 用于点-多边形包含过滤
         */
        render: function (map, resultByKey, polygon) {
            this.clear(map);
            this.markersByCategory = {};

            const legendList = document.getElementById('legendList');
            if (legendList) legendList.innerHTML = '';

            const polygonPts = polygon ? polygon.getPath() : null;

            POI_CATEGORIES.forEach(cat => {
                const group = resultByKey[cat.key];
                if (!group) return;
                this.markersByCategory[cat.key] = [];
                // 过滤：在 polygon 外的点去除（精确）
                const filtered = group.items.filter(item => {
                    if (!polygonPts || polygonPts.length < 3) return true;
                    return pointInPolygon(item.point, polygonPts);
                });
                // 限制每类最多显示前 30 个（数量过多影响视觉与性能）
                const items = filtered.slice(0, 30);

                items.forEach(item => {
                    const marker = this._makeMarker(cat, item);
                    const pt = new BMapGL.Point(item.point.lng, item.point.lat);
                    marker.setPosition(pt);
                    const info = new BMapGL.InfoWindow(
                        `<div style="padding:6px 4px;font-family:inherit;color:#0a1429;">
                            <h4 style="margin:0 0 4px;font-size:14px;">${escapeHtml(item.title)}</h4>
                            <p style="margin:0;font-size:12px;color:#666;">${escapeHtml(item.address || '')}</p>
                         </div>`,
                        { width: 240, height: 80, title: cat.name + ' · ' + items.length + ' 处中 ' + (items.indexOf(item) + 1) }
                    );
                    marker.addEventListener('click', () => {
                        map.openInfoWindow(info, pt);
                    });
                    map.addOverlay(marker);
                    this.markersByCategory[cat.key].push(marker);
                });

                if (legendList) {
                    legendList.insertAdjacentHTML('beforeend',
                        `<li><span class="dot" style="background:${cat.color}"></span>${cat.icon} ${cat.name} <small style="color:#8a9ec0">${items.length}</small></li>`);
                }
            });
        },

        _makeMarker: function (cat, item) {
            const svg = `
                <svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36">
                  <defs>
                    <filter id="s" x="-50%" y="-50%" width="200%" height="200%">
                      <feDropShadow dx="0" dy="2" stdDeviation="1.5" flood-opacity="0.35"/>
                    </filter>
                  </defs>
                  <path d="M14 0 C6 0 0 6 0 14 C0 22 14 36 14 36 C14 36 28 22 28 14 C28 6 22 0 14 0 Z"
                        fill="${cat.color}" filter="url(#s)"/>
                  <circle cx="14" cy="14" r="9" fill="#fff"/>
                  <text x="14" y="19" text-anchor="middle" font-size="13">${cat.icon}</text>
                </svg>`.trim();

            const icon = new BMapGL.Icon(
                'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg),
                new BMapGL.Size(28, 36),
                { anchor: new BMapGL.Size(14, 32) }
            );
            return new BMapGL.Marker(new BMapGL.Point(item.point.lng, item.point.lat),
                { icon, title: item.title });
        },

        clear: function (map) {
            Object.values(this.markersByCategory).forEach(arr => {
                arr.forEach(m => { try { map.removeOverlay(m); } catch (e) {} });
            });
            this.markersByCategory = {};
        },

        /**
         * 获得 "前 N 个 POI 坐标 + 权重" 的二维数组，给热力图使用
         * 每类权重不同：医院 1.0、药店 0.7、商超 0.9、学校 0.8、公交 0.6
         */
        collectHeatmapData: function (resultByKey, polygonPts) {
            const data = [];
            const weightMap = { hospital: 4, market: 3, school: 2, pharmacy: 2, bus: 1 };
            POI_CATEGORIES.forEach(cat => {
                const group = resultByKey && resultByKey[cat.key];
                if (!group) return;
                group.items.forEach(it => {
                    if (polygonPts && polygonPts.length >= 3 && !pointInPolygon(it.point, polygonPts)) return;
                    data.push({
                        lng: it.point.lng, lat: it.point.lat,
                        weight: weightMap[cat.key] || 1
                    });
                });
            });
            return data;
        }
    };

    /**
     * 防御工具：HTML 转义
     */
    function escapeHtml(s) {
        return (s == null ? '' : String(s))
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /**
     * 射线法判断点是否在多边形内
     * point: {lng, lat}, polygon: BMapGL.Point[] or {lng,lat} array
     */
    function pointInPolygon(point, polygon) {
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
    }

    global.POI = POI;
    global.__poiInPolygon = pointInPolygon;  // 导出备用
})(window);
