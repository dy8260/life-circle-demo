/**
 * 主入口 · 串联：地理编码 → 等时圈 → POI → 看板 → 报告
 * 加载顺序：HTML 中 <script> 标签按依赖顺序加载；最后由百度地图 API 在脚本载入时调用 window.__bmapReady
 */
(function (global) {
    'use strict';

    let map = null;
    let currentCenter = null;     // BMapGL.Point
    let currentSamples = null;    // 上次等时圈采样点
    let compareOverlays = [];     // 对比模式下创建的覆盖物（多边形/中心标记/POI），统一回收

    /** 初始化：百度 API 加载完毕时回调 */
    function init() {
        if (global.__inited) return;  // 幂等：避免 race 双触发
        global.__inited = true;
        // 1. 地图实例
        map = new BMapGL.Map('map');
        global.__bmap = map;
        map.centerAndZoom(new BMapGL.Point(116.482, 39.92), 14);
        map.enableScrollWheelZoom(true);
        map.enableInertialDragging(true);
        map.enableKeyboard(true);

        // 2. 深色地图主题（GL 内置）
        try { map.setMapStyle({ style: 'midnight' }); } catch (e) { try { map.setMapStyle({ style: 'dark' }); } catch (e2) {} }
        try { map.setMapType(BMAP_EARTH_MAP ? BMAP_EARTH_MAP : ''); } catch (e) {}

        // 3. 绑定交互
        bindEvents();
        // 3.0 主区域高度跟随顶栏（对比模式多一行地址时自动上收）
        syncLayoutHeight();
        if (global.ResizeObserver) {
            const tb = document.querySelector('.topbar');
            if (tb) new ResizeObserver(syncLayoutHeight).observe(tb);
        }
        global.addEventListener('resize', syncLayoutHeight);
        // 初始化 HUD 字段
        updateHud();

        // 3.1 绑定省/市/区三级联动（A 与 B 两组）
        bindRegionPickers();

        // 4. 看板图表初始化
        Dashboard.ensureCharts();

        // 5. 默认地址：方便快速展示
        document.getElementById('addrInput').value = '望京 SOHO';

        Util.logGroup('Ready', '百度地图加载完毕，自动开始首次体检...');

        // 6. 自动触发首次体检（解决"进来空白、需要手动点"的问题）
        //    延迟 600ms 让地图底图先加载避免居中闪现
        //    ⚠ 默认关闭：页面加载自动跑一次完整 POI 检索会提前烧掉 AK 配额，
        //       紧接着用户手动体检 + 对比会在一分钟内打满免费 key 的「每分钟请求数」限制，
        //       导致第一次点对比全 0。关闭后把配额留给用户真实操作。
        if (global.AUTO_RUN) {
            setTimeout(() => {
                const input = document.getElementById('addrInput');
                Util.logGroup('auto-run', { hasInput: !!input, value: input && input.value });
                if (input && input.value.trim()) runAnalysis();
            }, 600);
        } else {
            Util.logGroup('auto-run', { skipped: true, reason: 'AUTO_RUN=false（避免提前烧配额，对比模式首次点击更易成功）' });
        }
    }

    /**
     * 绑定省/市/区三级联动下拉（A 主地址 + B 对比地址）
     * 默认值：北京市 / 北京市 / 朝阳区
     */
    function bindRegionPickers() {
        if (!global.RegionPicker) return;
        // 主地址 A
        global.RegionPicker.bind(
            document.getElementById('provSelect'),
            document.getElementById('citySelect'),
            document.getElementById('areaSelect'),
            { prov: '北京市', city: '北京市', area: '朝阳区' }
        );
        // 对比地址 B
        global.RegionPicker.bind(
            document.getElementById('provSelectB'),
            document.getElementById('citySelectB'),
            document.getElementById('areaSelectB'),
            { prov: '北京市', city: '北京市', area: '海淀区' }
        );

        // 初始化完成后立即刷新天气（直辖市已自动映射到省份名）
        if (global.TimeWeather) {
            const cityName = global.RegionPicker.cityOnly(
                document.getElementById('provSelect'),
                document.getElementById('citySelect')
            );
            if (cityName) global.TimeWeather.updateWeather(cityName);
        }

        // 市切换时刷新天气（取第一个 select 组）
        const cityA = document.getElementById('citySelect');
        if (cityA) {
            cityA.addEventListener('change', () => {
                if (global.TimeWeather) {
                    const provA = document.getElementById('provSelect');
                    const cityName = global.RegionPicker.cityOnly(provA, cityA);
                    if (cityName) global.TimeWeather.updateWeather(cityName);
                }
            });
        }
    }

    /**
     * 同步主区域可用高度
     * .layout 用 calc(100vh - var(--header-h))，而顶栏高度会变：
     * 点「对比模式」多出地址 B 一行（约 48px）后，若仍按固定 70px 计算，
     * 报告卡底部会被挤出屏幕（body 是 overflow:hidden，滚不出来）。
     * 这里量出 topbar 真实高度写入 --header-h，让主区域实时跟随。
     */
    function syncLayoutHeight() {
        const topbar = document.querySelector('.topbar');
        if (!topbar) return;
        const h = Math.ceil(topbar.getBoundingClientRect().height);
        document.documentElement.style.setProperty('--header-h', h + 'px');
    }

    function bindEvents() {
        const btnGo = document.getElementById('btnGo');
        const input = document.getElementById('addrInput');
        const btnReset = document.getElementById('btnReset');

        btnGo.addEventListener('click', runAnalysis);
        input.addEventListener('keypress', e => { if (e.key === 'Enter') runAnalysis(); });
        btnReset.addEventListener('click', resetAll);

        // 对比模式入口：切换显示地址 B 行（紧贴地址 A 下方，不挤压标题）
        const btnCompare = document.getElementById('btnCompare');
        const addrBarB = document.getElementById('addrBarB');
        if (btnCompare && addrBarB) {
            btnCompare.addEventListener('click', () => {
                const show = addrBarB.hasAttribute('hidden');
                if (show) addrBarB.removeAttribute('hidden');
                else { addrBarB.setAttribute('hidden', ''); /* 关闭对比时清空对比报告 */ if (global.Compare) global.Compare.clear(); /* 看板保留 A/B 对比视图，直到下次单地址体检 */ }
                btnCompare.classList.toggle('active', show);
                btnCompare.textContent = show ? '🆚 关闭对比' : '🆚 对比模式';
                syncLayoutHeight();   // 多/少一行地址 → 主区域高度重算
            });
        }
        const btnCloseB = document.getElementById('btnCloseB');
        if (btnCloseB && addrBarB && btnCompare) {
            btnCloseB.addEventListener('click', () => {
                addrBarB.setAttribute('hidden', '');
                btnCompare.classList.remove('active');
                btnCompare.textContent = '🆚 对比模式';
                if (global.Compare) global.Compare.clear();
                /* 看板保留 A/B 对比视图，直到下次单地址体检 */
                syncLayoutHeight();
            });
        }

        // 对比地址 B 输入：监听详细地址输入变化，启用"开始对比"
        const addrInputB = document.getElementById('addrInputB');
        const btnRunCompare = document.getElementById('btnRunCompare');
        if (addrInputB && btnRunCompare) {
            const updateBtn = () => { btnRunCompare.disabled = !addrInputB.value.trim(); };
            addrInputB.addEventListener('input', updateBtn);
            addrInputB.addEventListener('keypress', e => { if (e.key === 'Enter' && addrInputB.value.trim()) runCompareAB(); });
            updateBtn();
        }
        if (btnRunCompare) btnRunCompare.addEventListener('click', runCompareAB);

        // 报告 tab 切换
        document.querySelectorAll('.report-tabs .tab').forEach(tab => {
            tab.addEventListener('click', () => {
                if (tab.disabled) return;
                document.querySelectorAll('.report-tabs .tab').forEach(t => t.classList.toggle('active', t === tab));
                const which = tab.dataset.tab;
                document.getElementById('reportSingle').hidden = (which !== 'single');
                document.getElementById('reportCompare').hidden = (which !== 'compare');
                const card = document.querySelector('.report-card');
                if (card) card.classList.toggle('has-compare', which === 'compare');
                if (which === 'compare' && global.Compare) global.Compare.renderReport();
            });
        });

        // 地址输入 ⓘ 提示按钮：点击切换 popover 显示
        const hintBtn = document.getElementById('addrHint');
        const hintPop = document.getElementById('addrHintPopover');
        if (hintBtn && hintPop) {
            hintBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const isHidden = hintPop.hasAttribute('hidden');
                if (isHidden) hintPop.removeAttribute('hidden');
                else hintPop.setAttribute('hidden', '');
            });
            // 点 popover 外面关闭
            document.addEventListener('click', (e) => {
                if (hintPop.hasAttribute('hidden')) return;
                if (hintPop.contains(e.target) || hintBtn.contains(e.target)) return;
                hintPop.setAttribute('hidden', '');
            });
            // ESC 关闭
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && !hintPop.hasAttribute('hidden')) {
                    hintPop.setAttribute('hidden', '');
                }
            });
        }

        // HUD：点击收起 / 展开（默认展开前 4 项：版本+缩放+经纬度，路网项附带显示）
        const hud = document.getElementById('hud');
        if (hud) {
            hud.addEventListener('click', () => hud.classList.toggle('collapsed'));
        }

        // 实时监听地图：缩放 + 鼠标移动
        if (typeof BMapGL !== 'undefined') {
            // init 阶段已经在初始化 map；缩放事件
            map.addEventListener('zoomend', () => updateHud());
            map.addEventListener('mousemove', (e) => {
                const lngEl = document.getElementById('hudLng');
                const latEl = document.getElementById('hudLat');
                if (lngEl) lngEl.textContent = e.latlng ? e.latlng.lng.toFixed(4) : '--.----';
                if (latEl) latEl.textContent = e.latlng ? e.latlng.lat.toFixed(4) : '--.----';
            });
        }

        document.getElementById('btnReportCopy').addEventListener('click', copyReport);
        document.getElementById('btnReportPrint').addEventListener('click', printReport);

        // 导出演示数据按钮已移除（示例数据改由构建期脚本 gen-report-from-snapshot.js 处理）

        // 服务盲区点位图层开关
        const btnGap = document.getElementById('btnGapToggle');
        if (btnGap) btnGap.addEventListener('click', toggleGap);
    }

    /** 暴露给对比模式：单次体检（共用全链路，不动 currentCenter/currentSamples）
     *  注意：此函数不做任何地图渲染/跳转（Isochrone.render / POI.render / centerAndZoom），
     *  对比模式由 _renderCompareMap 统一绘制，避免中间状态互相覆盖导致闪烁或丢失。
     */
    function runOneStandalone(addr, onProgress) {
        return new Promise(async (resolve, reject) => {
            try {
                const center = await geocode(addr);
                onProgress && onProgress(0.3, '等时圈…');
                const samples = await Isochrone.build(center, () => {});
                if (samples.length < 3) return reject(new Error('等时圈采样不足 3 个'));
                onProgress && onProgress(0.5, '画多边形…');
                // 构造多边形对象但不添加到地图（对比模式由 _renderCompareMap 统一渲染）
                const pts = Isochrone.buildPolygon(samples, center);
                const polygon = new BMapGL.Polygon(pts, Isochrone.defaultStyle());
                const area = Util.polygonArea(pts);
                const ir = { polygon, area, pts };  // pts 供 _renderCompareMap 直接使用（polygon 未上地图时 getPath() 不可靠）
                onProgress && onProgress(0.7, 'POI…');
                const resultByKey = await POI.fetchAll(center, samples, () => {});
                // 不调用 POI.render / Isochrone.render / map.centerAndZoom，避免干扰对比模式
                onProgress && onProgress(0.9, '评分…');
                const cal = Dashboard.calcScore(resultByKey, area, center);
                onProgress && onProgress(1, '完成');
                resolve({ center, samples, ir, resultByKey, score: cal.score, breakdown: cal.breakdown, missedCategories: cal.missedCategories });
            } catch (e) {
                reject(e);
            }
        });
    }

    /** 更新 HUD 中的"缩放级别"和"路网采样" */
    function updateHud() {
        if (!map || typeof BMapGL === 'undefined') return;
        const zoomEl = document.getElementById('hudZoom');
        if (zoomEl && map.getZoom) {
            zoomEl.textContent = String(map.getZoom());
        }
        const pathEl = document.getElementById('hudPath');
        if (pathEl) {
            const cnt = (currentSamples && currentSamples.length) || 0;
            pathEl.textContent = (typeof ISO !== 'undefined' && ISO.sampleCount)
                ? `${cnt}/${ISO.sampleCount}`
                : String(cnt);
        }
    }

    /** 等时圈采样完成后同步 HUD 的"路网进度" */
    function updateHudPath(sampleCount) {
        const pathEl = document.getElementById('hudPath');
        if (pathEl) {
            const total = (typeof ISO !== 'undefined' && ISO.sampleCount) || 16;
            pathEl.textContent = `${sampleCount}/${total}`;
        }
    }

    /** 读取地址栏 A 的"省 + 市 + 区 + 详细"拼接后的完整地址字符串 */
    function readAddrA() {
        if (!global.RegionPicker) return '';
        return global.RegionPicker.composedAddr(
            document.getElementById('provSelect'),
            document.getElementById('citySelect'),
            document.getElementById('areaSelect'),
            document.getElementById('addrInput')
        );
    }

    /** 对比地址 B 的拼接 */
    function readAddrB() {
        if (!global.RegionPicker) return '';
        return global.RegionPicker.composedAddr(
            document.getElementById('provSelectB'),
            document.getElementById('citySelectB'),
            document.getElementById('areaSelectB'),
            document.getElementById('addrInputB')
        );
    }

    /**
     * 同时体检地址 A 和 B，渲染对比结果到 #reportCompare
     */
    async function runCompareAB() {
        const addrA = readAddrA();
        const addrB = readAddrB();
        if (!addrA.trim() || !addrB.trim()) {
            toast('请同时填写地址 A 和地址 B');
            return;
        }
        if (!global.Compare) return;

        const btn = document.getElementById('btnRunCompare');
        btn && (btn.disabled = true);

        showLoader(true, '同时体检 A + B …');

        try {
            // 清空对比模块的旧结果
            global.Compare.reset();
            global.Compare.begin(addrA, addrB);

            // 顺序体检 A、B
            const resultA = await global.Compare.runOne(0);
            showLoader(true, '正在体检地址 B …');
            const resultB = await global.Compare.runOne(1);

            // 渲染报告 + 自动切到对比 tab
            global.Compare.renderReport();
            global.Compare.activateCompareTab();

            // 地图上同时显示 A 和 B 的等时圈 + POI（runOneStandalone 内部会互相覆盖，这里统一重绘）
            _renderCompareMap(global.Compare.results[0], global.Compare.results[1]);

            // 右侧看板切换为 A/B 并排对比视图（评分卡/配套统计/雷达/柱状图）
            Dashboard.renderCompare(global.Compare.results[0], global.Compare.results[1]);

            // 盲区卡：A/B 各跑一次真实盲区分析（成本 = 各 6 次 WalkingRoute 标定），
            // 异步回填，失败也不影响对比主流程
            _renderCompareGap(global.Compare.results[0], global.Compare.results[1]);
        } catch (e) {
            toast('对比失败：' + (e.message || e));
        } finally {
            showLoader(false);
            btn && (btn.disabled = false);
        }
    }

    /**
     * 清理对比模式在地图上留下的所有覆盖物（A/B 等时圈多边形 + 中心标记 + POI 图标）
     * ⚠ 这些覆盖物由 _renderOneCompare 直接 new 出来并 addOverlay，
     *    不受 Isochrone.clear() / POI.clear() 管辖（它们只清自己模块内部追踪的图层），
     *    因此「单地址体检」「重置」时必须显式调用本函数，
     *    否则对比时画的 B 圈和 B 图标会一直挂在地图上（旧 bug）。
     * @param {boolean} clearBase true 时同时清掉等时圈/POI 基础图层（重新体检场景）
     */
    function clearCompareOverlays(clearBase) {
        // ⚠ 先关掉已打开的信息窗（对比模式 marker 的弹窗同样不随 removeOverlay 消失）
        try { map.closeInfoWindow(); } catch (e) {}
        compareOverlays.forEach(o => { try { map.removeOverlay(o); } catch (e) {} });
        compareOverlays = [];
        if (clearBase) {
            try { Isochrone.clear(map); } catch (e) {}
            try { POI.clear(map); } catch (e) {}
        }
    }

    /**
     * 退出对比模式的「界面状态」：收起地址 B 行 + 报告 tab 切回单地址
     * 只在重新做单地址体检时调用（点「关闭对比」不走这里，那时要保留 A/B 看板与对比报告）
     */
    function _exitCompareModeUI() {
        const addrBarB = document.getElementById('addrBarB');
        const btnCompare = document.getElementById('btnCompare');
        if (addrBarB && !addrBarB.hasAttribute('hidden')) addrBarB.setAttribute('hidden', '');
        if (btnCompare) {
            btnCompare.classList.remove('active');
            btnCompare.textContent = '🆚 对比模式';
        }
        // 报告区切回单地址 tab（否则会一直停留在对比报告上）
        if (global.Compare && global.Compare.activateSingleTab) global.Compare.activateSingleTab();
        else {
            const rs = document.getElementById('reportSingle');
            const rc = document.getElementById('reportCompare');
            if (rs) rs.hidden = false;
            if (rc) rc.hidden = true;
            document.querySelectorAll('.report-tabs .tab').forEach(t => {
                t.classList.toggle('active', t.dataset.tab === 'single');
            });
            const card = document.querySelector('.report-card');
            if (card) card.classList.remove('has-compare');
        }
        syncLayoutHeight();
    }

    /**
     * 对比模式：在地图上同时渲染 A 和 B 的等时圈 + POI
     * runOneStandalone 内部 Isochrone.render/POI.render 会互相 clear，
     * 所以等两个都跑完后统一重绘：先画 A，再追加 B（B 用不同颜色区分）
     */
    function _renderCompareMap(resA, resB) {
        if (!resA || !resB) return;
        try {
            // 1. 清空地图上旧的覆盖层（上次对比残留 + 单地点模式残留）
            clearCompareOverlays(true);

            // 2. 渲染 A（蓝色系，默认色）
            _renderOneCompare(resA, '#5b9bff', '#3a7afe');

            // 3. 追加 B（橙色系，与 A 区分）
            _renderOneCompare(resB, '#ff9f43', '#ff6b35');

            // 4. 调整视野——以地址 A 为中心，固定缩放级别
            //    不用 getViewport（两点相距远时会缩到全国级别 → 地图变"一个点"）
            map.centerAndZoom(
                new BMapGL.Point(resA.center.lng, resA.center.lat),
                14
            );
        } catch (e) {
            console.warn('对比地图渲染异常', e);
        }
    }

    /**
     * 对比模式：A / B 各跑一次服务盲区分析，回填右侧「服务盲区识别」卡
     * 成本：每个地址 6 次 WalkingRoute（λ 标定），栅格计算全在本地。
     * 串行执行避免并发打满 AK 配额；任一失败不影响对比主流程。
     * ⚠ 不在地图上叠盲区点位（对比图已有两套等时圈 + POI，再叠会糊成一团），
     *    卡片里已注明点位图请切回单地址模式查看。
     */
    async function _renderCompareGap(resA, resB) {
        if (!global.GapFinder || !resA || !resB) return;
        const run = async (res) => {
            try {
                // ⚠ Compare.results 里没有 samples，用已排序的等时圈多边形顶点 res.ir.pts
                const polyPts = (res.ir && res.ir.pts && res.ir.pts.length >= 3) ? res.ir.pts : res.samples;
                return await GapFinder.analyze(res.center, polyPts, res.resultByKey, () => {});
            } catch (e) {
                console.warn('对比盲区分析失败', e);
                return null;
            }
        };
        const gapA = await run(resA);
        Dashboard.renderGapCompare(gapA, null);      // A 出来先填一半，避免长时间空白
        const gapB = await run(resB);
        Dashboard.renderGapCompare(gapA, gapB);
    }

    /**
     * 渲染单个对比地址的等时圈 + POI（不调用 clear，纯追加）
     * 使用真实等时圈多边形（res.ir.polygon）+ 类别彩色图标（含 emoji 区分）
     */
    function _renderOneCompare(res, strokeColor, fillColor) {
        // 等时圈多边形——优先用原始点数组（res.ir.pts），降级为圆形近似
        const rawPts = (res.ir && res.ir.pts) ? res.ir.pts : null;
        const polyPath = (res.ir && res.ir.polygon) ? res.ir.polygon.getPath() : null;
        // 优先用 pts（原始数组，不依赖 polygon 是否已上地图）
        const polygonPath = (rawPts && rawPts.length >= 3) ? rawPts : polyPath;

        if (polygonPath && polygonPath.length >= 3) {
            // 用 runOneStandalone 返回的真实等时圈多边形（与单地点模式一致）
            const poly = new BMapGL.Polygon(polygonPath, {
                strokeColor: strokeColor,
                strokeWeight: 2,
                strokeOpacity: 0.85,
                strokeStyle: 'solid',
                fillColor: fillColor,
                fillOpacity: 0.15
            });
            map.addOverlay(poly);
            compareOverlays.push(poly);
        } else if (res.area) {
            // 降级：以 center 为圆心按 area 反算半径画圆（兼容旧数据）
            const r = res.center;
            const approxR = Math.sqrt(Math.max(res.area, 1) / Math.PI);
            const latDeg = approxR / 111320;
            const lngDeg = approxR / (111320 * Math.cos(r.lat * Math.PI / 180));
            const circlePts = [];
            for (let i = 0; i < 36; i++) {
                const ang = i * 10 * Math.PI / 180;
                circlePts.push(new BMapGL.Point(
                    r.lng + lngDeg * Math.cos(ang),
                    r.lat + latDeg * Math.sin(ang)
                ));
            }
            const poly = new BMapGL.Polygon(circlePts, {
                strokeColor: strokeColor,
                strokeWeight: 2,
                strokeOpacity: 0.85,
                strokeStyle: 'solid',
                fillColor: fillColor,
                fillOpacity: 0.18
            });
            map.addOverlay(poly);
            compareOverlays.push(poly);
        }

        // 中心标记
        const c = new BMapGL.Point(res.center.lng, res.center.lat);
        const mk = new BMapGL.Marker(c, {
            title: res.addr,
            icon: new BMapGL.Icon(
                'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
                    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
                      <circle cx="12" cy="12" r="10" fill="${strokeColor}" opacity="0.25"/>
                      <circle cx="12" cy="12" r="6" fill="${strokeColor}" />
                    </svg>`
                ),
                new BMapGL.Size(24, 24),
                { anchor: new BMapGL.Size(12, 12) }
            )
        });
        mk.setZIndex(999);
        map.addOverlay(mk);
        compareOverlays.push(mk);

        // POI 标记——复用 POI.makeMarkerWithInfo（与单地点模式图标+弹窗 100% 一致，且 escapeHtml 在 poi.js 作用域内）
        if (res.resultByKey) {
            // 复用上面已计算的 polygonPath（优先原始点数组，不依赖 polygon.getPath()）
            const poiPolygonPts = polygonPath;
            const totalPoi = Object.values(res.resultByKey).reduce((s, g) => s + (g && g.items ? g.items.length : 0), 0);
            console.log('[对比模式POI]', res.addr, 'totalPoi=', totalPoi, 'polygonPath=', poiPolygonPts ? poiPolygonPts.length : null);
            try {
                Object.entries(res.resultByKey).forEach(([key, group]) => {
                if (!group || !group.items) return;
                const cat = (global.POI_CATEGORIES || []).find(c => c.key === key);
                if (!cat) return;

                // 过滤：在等时圈多边形外的点去除（与 POI.render 逻辑一致）
                const items = group.items.filter(item => {
                    if (!poiPolygonPts || poiPolygonPts.length < 3) return true;
                    return global.__poiInPolygon(item.point, poiPolygonPts);
                }).slice(0, 30);

                items.forEach(item => {
                    // poi.js 内创建（含 InfoWindow + 点击事件），确保 escapeHtml 可用、图标与单地点一致
                    const marker = POI.makeMarkerWithInfo(cat, item, map);
                    map.addOverlay(marker);
                    compareOverlays.push(marker);
                });
            });
            } catch (e) {
                console.error('[对比模式POI渲染异常]', e.message || e, e.stack || '');
            }
        }
    }

    async function runAnalysis() {
        const addr = readAddrA();
        if (!addr.trim()) { toast('请选择省/市/区，并输入详细地址'); return; }

        // 0. 退出对比模式的界面状态（收起地址 B 行 + 报告 tab 切回单地址）
        //    放在最前面：加载期间报告区不会继续挂着上一次的对比报告
        _exitCompareModeUI();

        // 1. 地理编码
        showLoader(true, '正在解析地址...');
        let center;
        try {
            Util.logGroup('geocode start', addr);
            center = await geocode(addr);
            Util.logGroup('geocode ok', { lng: center.lng, lat: center.lat });
        } catch (e) {
            Util.logGroup('geocode fail', e.message || e);
            showLoader(false);
            toast('地址解析失败：' + (e.message || '请尝试更精确的地址'));
            return;
        }

        currentCenter = center;
        map.centerAndZoom(center, 16);

        // 2. 等时圈
        showLoader(true, '计算 15 分钟步行等时圈...');
        const samples = await Isochrone.build(center, (p, m) => showLoader(true, m));
        if (samples.length < 3) {
            showLoader(false);
            toast('等时圈采样失败，可能该地点周边路网不完整');
            return;
        }
        currentSamples = samples;

        // 渲染等时圈 + 中心点
        // ⚠ 先清掉对比模式残留的 B 圈 + B 图标（compareOverlays 不受 Isochrone.clear 管辖）
        clearCompareOverlays(true);
        const ir = Isochrone.render(map, samples, center);
        Dashboard.exitCompare();          // 若看板还停留在 A/B 对比视图，切回单地址视图再填新数据
        Dashboard.setArea(ir.area);
        Dashboard.setCenter(addr);
        updateHudPath(samples.length);

            // 3. POI 检索 ~ 7. 自检（整体 try-catch 确保异常时加载层仍能消失）
            // ⚠ score / resultByKey 等变量需提升到 try 之外，供末尾 logGroup 使用（否则块级作用域报错）
            let score = 0, missedCategories = [], breakdown = null, resultByKey = null;
            try {
                showLoader(true, '检索周边民生配套（医院/药店/菜市场/商超/学校/公交）...');
                resultByKey = await POI.fetchAll(center, samples, (p, m) => showLoader(true, m));
                POI.render(map, resultByKey, ir.polygon);

            // 4. 服务盲区识别（核心指标）
            showLoader(true, '识别服务盲区点位...');
            const gapResult = await GapFinder.analyze(center, samples, resultByKey, (p, m) => showLoader(true, m));

            // 5. 看板
            const { score, missedCategories, breakdown } = Dashboard.calcScore(resultByKey, ir.area, center);
            Dashboard.renderPoiCount(resultByKey);
            Dashboard.renderCharts(resultByKey);
            Dashboard.setScore(score, Util.scoreLevel(score).text);
            Dashboard.renderGap(gapResult);

            // 5.1 盲区点位默认直接上图
            const gapBtn = document.getElementById('btnGapToggle');
            const hasGap = !!(gapResult && gapResult.enabled && gapResult.gapCount > 0);
            if (hasGap) {
                GapFinder.render(map, gapResult);
                if (gapBtn) { gapBtn.classList.add('active'); gapBtn.textContent = '隐藏点位'; gapBtn.disabled = false; }
            } else if (gapBtn) {
                if (global.GapFinder && GapFinder.visible) GapFinder.clear(map);
                gapBtn.classList.remove('active');
                gapBtn.textContent = '显示点位';
                gapBtn.disabled = true;
            }

            // 6. 报告
            Report.build(center, resultByKey, ir.area, score, missedCategories, breakdown, gapResult);

            // 6.1 体检快照由构建期脚本 gen-report-from-snapshot.js 读取仓库内置 sample-community.json 生成报告（运行时不再捕获）

            // 热力图数据准备
            Heatmap.setData(POI.collectHeatmapData(resultByKey, samples));

            // 7. 自检（?autotest=1）
            if (/[?&]autotest=1\b/.test(global.location.search)) {
                setTimeout(() => {
                    let heatStatus = 'unknown';
                    try { Heatmap.show(map); heatStatus = 'shown'; } catch (e) { heatStatus = 'ERR: ' + (e.message || e); }
                    const out = document.createElement('div');
                    out.id = '__autotest';
                    out.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:99999;background:rgba(20,32,64,0.95);color:#e6f0ff;padding:10px 14px;border-radius:8px;font-family:Consolas,monospace;font-size:12px;line-height:1.6;border:1px solid #3a7afe;max-width:560px;';
                    out.textContent = 'AUTOTEST·heat=' + heatStatus +
                        ' · poi=' + Object.values(resultByKey).reduce((s, c) => s + c.items.length, 0) +
                        ' · score=' + score +
                        ' · gap=' + (gapResult && gapResult.enabled ? gapResult.gapCount + '/' + gapResult.gridCount : 'n/a');
                    document.body.appendChild(out);
                }, 200);
            }
        } catch (e) {
            console.error('[体检] 步骤 3-7 异常:', e);
            toast('体检基本完成，部分功能异常：' + (e.message || e));
        }

        showLoader(false);
        Util.logGroup('体检完成', { center, score, poCount: Object.values(resultByKey).reduce((s, c) => s + c.items.length, 0) });
    }

    function geocode(address) {
        return new Promise((resolve, reject) => {
            let done = false;
            const t = setTimeout(() => { if (!done) { done = true; reject(new Error('超时')); } }, 6000);
            try {
                // 优先用「市」名作为 city 参数提高精度；直辖市用省份名（避免“市辖区”导致匹配失败）
                const cityName = global.RegionPicker
                    ? global.RegionPicker.cityOnly(document.getElementById('provSelect'), document.getElementById('citySelect'))
                    : '';
                const gc = new BMapGL.Geocoder();
                gc.getPoint(address, (point) => {
                    if (done) return;
                    done = true; clearTimeout(t);
                    if (point && point.lng) resolve(point);
                    else reject(new Error('未匹配到该地址'));
                }, cityName);
            } catch (e) { clearTimeout(t); reject(e); }
        });
    }

    /** 重算等时圈 */
    async function rebuildIsochrone() {
        if (!currentCenter) { toast('请先进行完整体检'); return; }
        showLoader(true, '重算等时圈...');
        const samples = await Isochrone.build(currentCenter, (p, m) => showLoader(true, m));
        if (samples.length >= 3) {
            currentSamples = samples;
            const r = Isochrone.render(map, samples, currentCenter);
            Dashboard.setArea(r.area);
            updateHudPath(samples.length);
        }
        showLoader(false);
    }

    /** 切换热力图 */
    function toggleHeatmap() {
        if (!POI.allResults) { toast('请先完成一次体检'); return; }
        if (typeof simpleheat === 'undefined') {
            toast('热力图依赖 simpleheat 未加载，请检查 lib/simpleheat.min.js');
            return;
        }
        const btn = document.getElementById('btnHeatmap');
        btn.classList.toggle('active', Heatmap.toggle(map));
    }

    /** 3D / 2D 切换 */
    function toggle3D() {
        // BMapGL 默认就是 3D 倾斜视角，简化处理：切换地图视角倾斜角度
        try {
            const cur = map.getHeading ? map.getHeading() : 0;
            map.setHeading ? map.setHeading(cur > 5 ? 0 : 50) : null;
            const pitch = map.getPitch ? map.getPitch() : 0;
            map.setPitch ? map.setPitch(pitch > 5 ? 0 : 40) : null;
        } catch (e) {}
    }

    /** 全屏 */
    function toggleFullscreen() {
        const el = document.documentElement;
        if (!document.fullscreenElement) {
            (el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullscreen).call(el);
        } else {
            (document.exitFullscreen || document.webkitExitFullscreen || document.mozExitFullscreen).call(document);
        }
    }

    /** 复制报告 */
    async function copyReport() {
        const addrTag = document.getElementById('reportAddr');
        if (!addrTag || addrTag.textContent.includes('尚未体检')) { toast('暂无可复制的内容'); return; }
        const html = document.getElementById('reportSingle').innerText;
        try {
            await navigator.clipboard.writeText(html);
            toast('报告内容已复制到剪贴板');
        } catch (e) {
            toast('复制失败：浏览器不支持');
        }
    }

    function printReport() {
        const content = document.getElementById('reportSingle').innerHTML;
        const addr = document.getElementById('reportAddr').textContent;
        const w = window.open('', '_blank');
        if (!w) { toast('请允许弹窗以打印报告'); return; }
        w.document.write(`
            <html><head><meta charset="UTF-8"><title>${addr} · 体检报告</title>
            <style>body{font-family:"PingFang SC","Microsoft Yahei",sans-serif;color:#0a1429;padding:40px;line-height:1.8;}
            h1{margin:0 0 8px;}.meta{color:#666;font-size:13px;margin-bottom:24px;}
            h4{border-left:4px solid #3a7afe;padding-left:10px;margin-top:24px;}
            ul,ol{padding-left:22px;}
            .level{display:inline-block;padding:4px 10px;border-radius:8px;background:#3a7afe;color:#fff;font-size:13px;}
            </style></head><body>
            <h1>15 分钟便民生活圈体检报告</h1>
            <p class="meta">${addr}</p>
            ${content}
            <script>window.onload=()=>window.print();<\/script>
            </body></html>`);
        w.document.close();
    }

    /** 重置 */
    function resetAll() {
        clearCompareOverlays(true);       // 清掉对比模式残留的 A/B 圈与图标
        Isochrone.clear(map);
        POI.clear(map);
        Heatmap.clear();
        Heatmap.hide();
        // 盲区图层一并清掉（btnHeatmap 在 v3.3.0 移除工具条后已不存在，故做空值守卫）
        if (global.GapFinder) { GapFinder.clear(map); Dashboard.renderGap(null); }
        const hmBtn = document.getElementById('btnHeatmap');
        if (hmBtn) hmBtn.classList.remove('active');
        document.getElementById('reportSingle').innerHTML = `
            <div class="empty-tip">
                <p>👋 请在上方输入小区 / 街道 / 社区地址，例如：</p>
                <ul><li>北京市朝阳区望京 SOHO</li><li>上海市浦东新区陆家嘴</li></ul>
                <p class="muted">系统会基于<strong>真实步行路网</strong>绘制 15 分钟可达圈，统计六类民生配套并识别<strong>服务盲区</strong>。</p>
            </div>`;
        document.getElementById('reportAddr').textContent = '尚未体检';
        Dashboard.exitCompare();          // 若正处于对比看板视图，先还原单地址 DOM
        _exitCompareModeUI();             // 收起地址 B 行 + 报告 tab 切回「单地址体检报告」
        if (global.Compare) global.Compare.clear();   // 重置：对比结果一并清空
        Dashboard.setScore(0, '未体检');
        Dashboard.renderPoiCount({});
        Dashboard.renderCharts({});
        document.getElementById('metaArea').textContent = '— km²';
        document.getElementById('metaCenter').textContent = '—';
        const gbtn = document.getElementById('btnGapToggle');
        if (gbtn) { gbtn.classList.remove('active'); gbtn.textContent = '显示点位'; gbtn.disabled = true; }
        currentCenter = null;
        currentSamples = null;
    }

    /** 服务盲区点位图层显隐切换 */
    function toggleGap() {
        const btn = document.getElementById('btnGapToggle');
        if (!global.GapFinder || !GapFinder.lastResult || !GapFinder.lastResult.enabled) return;
        if (GapFinder.visible) {
            GapFinder.clear(map);
            if (btn) { btn.classList.remove('active'); btn.textContent = '显示点位'; }
        } else {
            GapFinder.render(map, GapFinder.lastResult);
            if (btn) { btn.classList.add('active'); btn.textContent = '隐藏点位'; }
        }
    }

    /** Loader 控制 */
    function showLoader(show, text) {
        const el = document.getElementById('loader');
        const t = document.getElementById('loaderText');
        if (el) el.classList.toggle('hidden', !show);
        if (text && t) t.textContent = text;
    }

    function toast(msg) {
        // 简易 toast：500ms 后消失
        const ex = document.getElementById('__toast');
        if (ex) ex.remove();
        const div = document.createElement('div');
        div.id = '__toast';
        div.textContent = msg;
        div.style.cssText = `position:fixed;top:80px;left:50%;transform:translateX(-50%);
            background:rgba(20,32,64,0.92);border:1px solid rgba(120,180,255,0.3);
            color:#e6f0ff;padding:10px 18px;border-radius:8px;font-size:13px;
            z-index:9999;backdrop-filter:blur(6px);`;
        document.body.appendChild(div);
        setTimeout(() => div.remove(), 2200);
    }

    /** 暴露给百度地图 API 回调：地图脚本加载完成后触发 init（在线模式） */
    global.__bmapReady = init;

    // 对比模式需要的可复用体检工具
    global.app = {
        runOneStandalone: (addr, onProgress) => runOneStandalone(addr, onProgress)
    };
    // 兜底：如果百度 API 脚本比我们的 app.js 先到达并执行（race condition），
    //      百度脚本里的 `window.__bmapReady(...)` 调用会因当时仍是 noop 而失联。
    //      此处再做一次"如果 BMapGL 已存在，立即调 init"的补救。
    //      注意：不要提前设 __inited，让 init() 自己负责置位（init 第一句会判 __inited）。
    setTimeout(function () {
        if (typeof global.BMapGL !== 'undefined' && !global.__inited) {
            try { init(); } catch (e) {
                global.__diag && global.__diag('init race-rescue failed: ' + (e.message || e));
            }
        }
    }, 50);
})(window);
