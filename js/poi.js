/**
 * 周边 POI 检索器
 *
 * 策略：基于 15 分钟等时圈 polygon 的 Bounds 做 inBounds 检索
 * 六类民生配套：医院 / 药店 / 菜市场 / 商超 / 学校 / 公交
 * 百度 LocalSearch 单 keyword 单返回，因此每类可能搜多个关键字并合并去重
 *
 * 注意：百度 LocalSearch 返回的 result 结构在不同版本略有差异，
 * 这里采用防御式提取：兼容 getPoi/getNumPois、EnumerablePois、poiList 等多种可能形态
 */
(function (global) {
    'use strict';

    // 模块级 POI 检索缓存：相同关键字+范围直接命中，避免重复消耗 AK 配额
    // 仅在单次页面会话内有效（刷新即清空），空结果不缓存以便配额恢复后重取
    const _cache = {};

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
         * 把 Bounds 按 ratio 比例向外扩展（如 0.12 → 各边外扩 12%），
         * 用于放宽 POI 检索范围，让等时圈边界上的配套点稳定被搜到；
         * 真正上图前仍用精确 pointInPolygon(polygonPts) 过滤回真实等时圈，
         * 故不会改变「最终显示在等时圈内」的语义，只让检索网更稳。
         */
        _expandBounds: function (b, ratio) {
            try {
                const sw = b.getSouthWest(), ne = b.getNorthEast();
                const dx = (ne.lng - sw.lng) * ratio;
                const dy = (ne.lat - sw.lat) * ratio;
                return new BMapGL.Bounds(
                    new BMapGL.Point(sw.lng - dx, sw.lat - dy),
                    new BMapGL.Point(ne.lng + dx, ne.lat + dy)
                );
            } catch (e) { return b; }
        },

        /**
         * 把地图实例视口中心移到检索中心点（偏移较大时才动）。
         *
         * 【为什么必须做】百度 LocalSearch 的「检索区域」不是由传入的 bounds 决定，
         * 而是由地图实例的**当前视口中心**决定：searchInBounds 内部会先走
         * _getIdByLoc → 发出 qt=cen 请求，上报的 b= 正是「地图中心坐标」、l= 是缩放级别。
         * 若地图仍停在别的城市，百度就按那个城市解析 region，传入的 bounds 落在
         * region 之外 → 恒返回 0 条（status=n/a、非错误码，看起来像"没数据"或"限频"）。
         *
         * 日志铁证：检索地址在泰安，但所有 qt=cen 的 b= 坐标解析出来是北京
         * （BD09MC y≈4838591 → 约 39.9°N），说明百度一直在按北京解析 region。
         *
         * 这也解释了本项目的经典现象：
         *  - 单地址模式从未暴露：runAnalysis() 在 fetchAll 之前先 map.centerAndZoom(center, 16)，
         *    地图已经移到目标城市；
         *  - 对比模式首点必 0：runOneStandalone() 为修「地图跳两次」刻意不碰地图，
         *    地图还停在初始的北京视口；
         *  - 等多久重试都没用：视口不变，region 解析结果就不变（此前 3s/6s/10s 退避探活全败）；
         *  - 「第二次点击」才有数据：首轮结束后 _renderCompareMap() 把地图移到了 A，
         *    视口已落到泰安，再点就正常了。
         */
        _ensureMapAt: async function (center) {
            try {
                const m = global.__bmap;
                if (!m || typeof BMapGL === 'undefined') return;
                if (!center || typeof center.lng !== 'number' || typeof center.lat !== 'number') return;

                let need = true;
                try {
                    const cur = (typeof m.getCenter === 'function') ? m.getCenter() : null;
                    if (cur && typeof cur.lng === 'number') {
                        // 阈值 0.01° ≈ 1km：小偏移不折腾地图，避免无谓重绘与跳图
                        need = (Math.abs(cur.lng - center.lng) > 0.01) ||
                               (Math.abs(cur.lat - center.lat) > 0.01);
                    }
                } catch (e) { need = true; }

                if (!need) return;

                try {
                    const z = (typeof m.getZoom === 'function') ? m.getZoom() : 14;
                    // 级别太低时百度会解析到省级 region，导致城市级检索落空
                    if (typeof z === 'number' && z < 10) m.setZoom(14);
                    m.setCenter(new BMapGL.Point(center.lng, center.lat));
                    console.log('[POI] 地图视口已移到检索中心（百度按视口中心解析检索区域）');
                    // 留一帧时间让地图内部完成城市/region 上下文更新
                    await new Promise(r => setTimeout(r, 350));
                } catch (e) {}
            } catch (e) {}
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

            // 检索边界在等时圈外扩 ~12%，把边界上的 POI 稳定纳入检索网；
            // 后续仍用精确 pointInPolygon(polygonPts) 过滤回真实等时圈
            // → 消除「边界 POI 每次 routing 略有差异、时有时无」造成的假限频误判。
            const searchBounds = this._expandBounds(bounds, 0.12);

            // 等地图实例就绪后再发起检索，规避「页面刚加载 / 首次点击」时
            // LocalSearch 因地图尚未初始化而静默空返回（表现为 status=n/a count=0）。
            await this._waitMapReady();

            // 【关键】检索前先把地图视口移到检索中心。百度按「地图视口中心」而非
            // 传入 bounds 解析检索 region，视口在别处就会恒返回 0 条（详见 _ensureMapAt 注释）。
            await this._ensureMapAt(center);

            const gapMs = (typeof global.POI_SEARCH_GAP_MS === 'number') ? global.POI_SEARCH_GAP_MS : 280;
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));

            // 单轮检索：先把 6 类 POI 全部搜完，再对个别空类别做 nearby 兜底。
            // 返回 { out, globalTotal }，便于外层判断是否「整段冷解析为空」而需重试。
            const doFetch = async () => {
                let idx = 0;
                const tasks = POI_CATEGORIES.map(cat => ({
                    cat,
                    run: async () => {
                        const kwLimit = (typeof global.POI_KEYWORD_LIMIT === 'number') ? global.POI_KEYWORD_LIMIT : 3;
                        const kwQueue = cat.keywords.slice(0, kwLimit);
                        // 某类已召回足够多点位时，跳过剩余同义词，省配额且不损覆盖
                        const stopAt = (typeof global.POI_KEYWORD_STOP_AT === 'number') ? global.POI_KEYWORD_STOP_AT : 10;
                        let all = [];
                        const seenUid = new Set();
                        for (let i = 0; i < kwQueue.length; i++) {
                            const list = await this._search(kwQueue[i], searchBounds);
                            list.forEach(p => {
                                if (seenUid.has(p.uid)) return;
                                seenUid.add(p.uid);
                                all.push(p);
                            });
                            if (all.length >= stopAt) break;
                        }
                        idx++;
                        onProgress && onProgress(idx / POI_CATEGORIES.length,
                            `检索 ${cat.name} ${all.length} 处`);
                        return { category: cat, items: all };
                    }
                }));

                // 串行 + 间隔：规避百度检索端点的并发抖动（尤其对比模式 A+B 连续检索）
                const all = [];
                for (let i = 0; i < tasks.length; i++) {
                    if (i > 0) await sleep(gapMs);
                    all.push(await tasks[i].run());
                }

                const out = {};
                all.forEach(({ category, items }) => { out[category.key] = { ...category, items }; });
                this.allResults = out;

                // 第二阶段兜底：仅当本次整体「有数据」时，才对个别空类别补一次 nearby 检索。
                // 全部为空时 globalTotal=0，直接跳过 → 不再疯狂补请求。
                const globalTotal = all.reduce((s, r) => s + r.items.length, 0);
                if (globalTotal > 0) {
                    let sw, ne, cLat, cLng, rMeters;
                    try {
                        sw = bounds.getSouthWest(); ne = bounds.getNorthEast();
                        cLat = (sw.lat + ne.lat) / 2; cLng = (sw.lng + ne.lng) / 2;
                        rMeters = Math.round(Math.hypot(
                            (ne.lng - sw.lng) * 111320 * Math.cos(cLat * Math.PI / 180),
                            (ne.lat - sw.lat) * 111320) / 2) + 200;
                    } catch (e) { sw = null; }
                    const emptyCats = all.filter(r => r.items.length === 0);
                    let fi = 0;
                    for (const r of emptyCats) {
                        if (!sw) break;
                        if (fi++ > 0) await sleep(gapMs);
                        const list = await this._searchNearby(r.category.keywords[0], new BMapGL.Point(cLng, cLat), rMeters);
                        if (list.length) {
                            out[r.category.key] = { ...r.category, items: list };
                            console.log('[POI] nearby 兜底', r.category.key, '=>', list.length);
                        }
                    }
                }
                return { out, globalTotal };
            };

            // 整段为空兜底：只做 1 次低成本补查。
            //
            // 【不要再长退避】此前是 3s/6s/10s 共 19s 的退避 + 探活，实测全败。
            // 原因：真正的根因是「地图视口不在目标城市 → region 解析错位」（见 _ensureMapAt），
            // 视口不变，等再久、重试多少次都不会恢复，长退避只是白白拖慢体检 19 秒。
            // 根因已由 _ensureMapAt 修掉，这里只保留一次补查来覆盖偶发网络抖动。
            let result = await doFetch();
            if (result.globalTotal === 0) {
                console.warn('[POI] 整段为空，2s 后用 1 个高频词轻量补查一次');
                await sleep(2000);
                const probe = await this._search(POI_CATEGORIES[0].keywords[0], searchBounds);
                if (probe && probe.length > 0) {
                    console.log('[POI] 补查有数据，重新检索整段');
                    result = await doFetch();
                } else {
                    console.warn('[POI] 补查仍空 → 该范围确无此配套，或地图视口/region 仍未对齐');
                }
            }

            if (result.globalTotal === 0) {
                // 按实测概率排序：视口/region 错位是本项目最常见的"恒 0"原因
                console.warn(
                    '[POI] ⚠ 6 类 POI 仍为 0（totalPoi=0）。常见原因（按概率）：\n' +
                    '  ① 地图视口不在检索城市（最常见）：百度 LocalSearch 按「地图视口中心」而非传入 bounds\n' +
                    '     解析检索 region（内部 _getIdByLoc → qt=cen）。视口在别的城市时，\n' +
                    '     bounds 落在 region 之外 → 恒返回 0 条，且等多久重试都没用。\n' +
                    '     自查：控制台里 qt=cen 请求的 b= 坐标，是否就是你要检索的城市？\n' +
                    '  ② Referer 白名单：file://（origin=null）或 localhost 未在该 AK 的「Referer 白名单」中时，\n' +
                    '     百度会整体拒绝 LocalSearch，表现为 status=n/a、count=0（地图底图可能仍正常）；\n' +
                    '  ③ 百度 AK 配额 / 限流：表现为明确的错误码（401/240/302），而非本例的 status=n/a 干净 0 条。\n' +
                    '  排查：打开浏览器「网络」面板，看 api.map.baidu.com 的 place 检索请求返回码\n' +
                    '      —— 401/240/302 重定向到错误页即 AK/白名单问题；200 但空数组则回到 ① 查视口。'
                );
            }
            return result.out;
        },

        /**
         * 等待地图实例就绪（BMapGL 已加载且 global.__bmap 已创建）。
         * 仅在地图确实就绪后才发起 LocalSearch，避免首屏/首点因地图未初始化而静默空返回。
         * 上限 ~3s，到点即便未就绪也放行，绝不卡死。
         */
        _waitMapReady: function () {
            return new Promise((resolve) => {
                let tries = 0;
                const check = () => {
                    tries++;
                    // 地图实例已存在即视为可用（init() 在百度 API 回调里已 new 好 Map 并挂到 global.__bmap）
                    if (typeof BMapGL !== 'undefined' && global.__bmap) { resolve(true); return; }
                    if (tries > 60) { resolve(false); return; } // 3s 仍无则放行
                    setTimeout(check, 50);
                };
                check();
            });
        },

        /** bounds 检索（带缓存 + 限频重试） */
        _search: function (keyword, bounds) {
            let key = null;
            try {
                const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
                const r = (v) => Math.round(v * 1000) / 1000; // ~111m 精度，便于相邻范围命中同一缓存
                key = 'b:' + keyword + ':' + r(sw.lat) + ':' + r(sw.lng) + ':' + r(ne.lat) + ':' + r(ne.lng);
            } catch (e) { key = null; }
            return this._runWithRetry((local) => local.searchInBounds(keyword, bounds), 'bounds:' + keyword, key);
        },

        /** 中心点周边检索（第二阶段兜底用，带缓存 + 限频重试） */
        _searchNearby: function (keyword, center, radius) {
            const r = (v) => Math.round(v * 1000) / 1000;
            const key = 'n:' + keyword + ':' + r(center.lat) + ':' + r(center.lng) + ':' + radius;
            return this._runWithRetry((local) => local.searchNearby(keyword, center, radius), 'nearby:' + keyword, key);
        },

        /** 单次 LocalSearch 执行（构造 + 回调 + 8s 超时降级），返回 Promise<{list, failed, status}> */
        _runOnce: function (invoke, label) {
            return new Promise((resolve) => {
                let done = false;
                const finish = (payload) => { if (!done) { done = true; resolve(payload); } };
                const timer = setTimeout(() => finish({ list: [], failed: false, status: 'timeout' }), 8000);
                const onDone = (result) => {
                    clearTimeout(timer);
                    let status = 'n/a';
                    try {
                        if (result && typeof result.getStatus === 'function') status = result.getStatus();
                        else if (result && typeof result.status !== 'undefined') status = result.status;
                        else if (result && typeof result.code !== 'undefined') status = result.code;
                    } catch (e) {}
                    const list = this._extract(result);
                    // 仅当百度明确回错误码（非 0 / 非 n/a）才视为「检索失败」，
                    // 干净返回但 0 条（status=0 或 n/a）属「该范围无此配套」，不算失败。
                    const errCodes = {
                        1: '请求参数非法', 2: '请求权限失败', 3: '权限验证失败',
                        4: '配额/频控超限', 5: 'AK 不存在或非法', 101: '服务禁用',
                        102: '未通过白名单', 200: '后端内部错误', 240: '配额超限',
                        302: '需登录', 401: '未授权/配额', 500: '服务端错误'
                    };
                    const failed = (status !== 'n/a' && status !== 0 && status !== '0')
                        && (errCodes[status] !== undefined || Number(status) >= 1);
                    console.log('[POI]', label, 'status=', status, 'count=', list.length, failed ? '(失败)' : '');
                    finish({ list, failed, status });
                };
                const onErr = (e) => {
                    clearTimeout(timer);
                    const info = (e && (e.message || e.code || e)) || e;
                    console.warn('[POI]', label, 'onErr →', info);
                    finish({ list: [], failed: true, status: 'onErr' });
                };
                const optsVariants = [
                    { pageCapacity: 50, renderOptions: { map: null, autoViewport: false },
                      onSearchComplete: onDone, onError: onErr },
                    { pageCapacity: 50, onSearchComplete: onDone, onError: onErr }
                ];
                let local = null;
                for (const opts of optsVariants) {
                    try { local = new BMapGL.LocalSearch(global.__bmap, opts); break; }
                    catch (e) { local = null; }
                }
                if (!local) { clearTimeout(timer); finish({ list: [], failed: false, status: 'no-local' }); return; }
                try { invoke(local); }
                catch (e) { clearTimeout(timer); finish({ list: [], failed: true, status: 'invoke-err' }); }
            });
        },

        /**
         * 带缓存 + 区分式重试的执行器
         * - 缓存命中（非空）直接返回，避免重复消耗 AK 配额
         * - 仅「真失败」（onErr / 百度明确错误码）才按退避重试并标记「限频重试」
         * - 干净返回但 0 条 =「该范围无此配套」，只做 1 次短间隔补查排除冷启动，
         *   绝不按限频反复重试，避免误导用户以为在限频
         * - 仅缓存「非空」结果；空结果不缓存，便于配额恢复后重取
         */
        _runWithRetry: async function (invoke, label, cacheKey) {
            if (cacheKey && _cache[cacheKey]) {
                console.log('[POI] cache hit', label, '=>', _cache[cacheKey].length);
                return _cache[cacheKey];
            }
            const retries = (typeof global.POI_SEARCH_RETRY === 'number') ? global.POI_SEARCH_RETRY : 2;
            const gapMs = (typeof global.POI_SEARCH_RETRY_GAP_MS === 'number') ? global.POI_SEARCH_RETRY_GAP_MS : 600;
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));

            const first = await this._runOnce(invoke, label);
            if (first.list.length > 0) {
                if (cacheKey) _cache[cacheKey] = first.list;
                return first.list;
            }

            // 第一遍为空：区分「真失败」与「干净 0 条」
            if (first.failed) {
                // 真·限频 / 配额 / 白名单失败：按退避重试若干次，骑过限频窗口
                console.warn('[POI]', label, '检索失败(status=' + first.status + ')，进入限频退避重试');
                for (let i = 1; i <= retries; i++) {
                    await sleep(gapMs * i);
                    console.log('[POI] 限频重试', label, '#' + i);
                    const r = await this._runOnce(invoke, label);
                    if (r.list.length > 0) {
                        if (cacheKey) _cache[cacheKey] = r.list;
                        return r.list;
                    }
                    if (!r.failed) break; // 由「失败」转为「干净 0」→ 停止限频重试
                }
                console.warn('[POI]', label, '→ 持续失败，放弃（可能是 AK 配额/白名单）');
                return [];
            }

            // 干净返回但 0 条：仅 1 次短间隔补查排除冷启动，不按限频重试（避免误导）
            await sleep(400);
            const re = await this._runOnce(invoke, label);
            if (re.list.length > 0) {
                if (cacheKey) _cache[cacheKey] = re.list;
                return re.list;
            }
            // 仍 0 → 真实「该范围无此配套」，不是限频
            console.log('[POI]', label, '→ 0 条（该范围无此配套，非限频）');
            return [];
        },

        _extract: function (result) {
            if (!result) return [];
            const list = [];
            const push = (poi) => {
                if (!poi) return;
                const point = poi.point || (poi.latLng && { lng: poi.latLng.lng, lat: poi.latLng.lat });
                if (!point) return;
                list.push({
                    title:   poi.title || poi.name || '未命名',
                    address: poi.address || '',
                    point:   { lng: point.lng, lat: point.lat },
                    uid:     poi.uid || (poi.title + '|' + point.lng.toFixed(5) + '|' + point.lat.toFixed(5))
                });
            };
            const numGetters = ['getCurrentNumPois', 'getNumPois'];
            for (const g of numGetters) {
                try {
                    if (typeof result[g] === 'function' && typeof result.getPoi === 'function') {
                        const n = result[g]();
                        if (n > 0) { for (let i = 0; i < n; i++) push(result.getPoi(i)); }
                        if (list.length > 0) break;
                    }
                } catch (e) {}
            }
            ['EnumerablePois', 'poiList', 'rows', 'pois', 'Pois'].forEach(k => {
                try { if (Array.isArray(result[k])) result[k].forEach(push); } catch (e) {}
            });
            if (list.length === 0) this._deepScan(result, push);
            return list;
        },

        _deepScan: function (obj, push, depth = 0, seen = new Set()) {
            if (!obj || typeof obj !== 'object' || depth > 5 || seen.has(obj)) return;
            seen.add(obj);
            const hasPoint = (obj.point || obj.latLng) && (obj.title || obj.name);
            if (hasPoint) { push(obj); return; }
            for (const k in obj) {
                if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
                const v = obj[k];
                if (v && typeof v === 'object') this._deepScan(v, push, depth + 1, seen);
            }
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
                        { width: 240, height: 80, title: cat.name + ' · ' + items.length + ' 处中 ' + (items.indexOf(item) + 1), enableCloseOnClick: true }
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

        /**
         * 创建带信息窗 + 点击事件的 POI 标记（供对比模式复用，确保与单地点模式图标/弹窗一致）
         * 放在 poi.js 内以便使用本文件作用域的 escapeHtml
         * @param {Object} cat 类别配置（含 color/icon/name）
         * @param {Object} item POI 条目（含 point/title/address）
         * @param {BMapGL.Map} map 地图实例（点击时用于 openInfoWindow）
         * @returns {BMapGL.Marker}
         */
        makeMarkerWithInfo: function (cat, item, map) {
            const marker = this._makeMarker(cat, item);
            const pt = new BMapGL.Point(item.point.lng, item.point.lat);
            marker.setPosition(pt);
            const info = new BMapGL.InfoWindow(
                `<div style="padding:6px 4px;font-family:inherit;color:#0a1429;">
                    <h4 style="margin:0 0 4px;font-size:14px;">${escapeHtml(item.title)}</h4>
                    <p style="margin:0;font-size:12px;color:#666;">${escapeHtml(item.address || '')}</p>
                 </div>`,
                { width: 240, height: 80, title: cat.name + ' · 配套点', enableCloseOnClick: true }
            );
            marker.addEventListener('click', () => { try { map.openInfoWindow(info, pt); } catch (e) {} });
            return marker;
        },

        clear: function (map) {
            // ⚠ 先关掉已打开的信息窗：InfoWindow 不属于 overlay，
            //    removeOverlay 收不走它，重新体检时会残留上一个地址的弹窗
            try { map.closeInfoWindow(); } catch (e) {}
            Object.values(this.markersByCategory).forEach(arr => {
                arr.forEach(m => { try { map.removeOverlay(m); } catch (e) {} });
            });
            this.markersByCategory = {};
        },

        /**
         * 获得 "前 N 个 POI 坐标 + 权重" 的二维数组，给热力图使用
         * 权重按民生刚需程度排序：医院 > 菜市场 > 学校 > 药店 > 商超 > 公交
         */
        collectHeatmapData: function (resultByKey, polygonPts) {
            const data = [];
            const weightMap = { hospital: 4, market: 3, school: 2, pharmacy: 2, store: 1, bus: 1 };
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
