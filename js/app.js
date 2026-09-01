/**
 * 主入口 · 串联：地理编码 → 等时圈 → POI → 看板 → 报告
 * 加载顺序：HTML 中 <script> 标签按依赖顺序加载；最后由百度地图 API 在脚本载入时调用 window.__bmapReady
 */
(function (global) {
    'use strict';

    let map = null;
    let currentCenter = null;     // BMapGL.Point
    let currentSamples = null;    // 上次等时圈采样点

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
        setTimeout(() => {
            const input = document.getElementById('addrInput');
            Util.logGroup('auto-run', { hasInput: !!input, value: input && input.value });
            if (input && input.value.trim()) runAnalysis();
        }, 600);
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
                else { addrBarB.setAttribute('hidden', ''); /* 关闭对比时清空对比报告 */ if (global.Compare) global.Compare.clear(); }
                btnCompare.classList.toggle('active', show);
                btnCompare.textContent = show ? '🆚 关闭对比' : '🆚 对比模式';
            });
        }
        const btnCloseB = document.getElementById('btnCloseB');
        if (btnCloseB && addrBarB && btnCompare) {
            btnCloseB.addEventListener('click', () => {
                addrBarB.setAttribute('hidden', '');
                btnCompare.classList.remove('active');
                btnCompare.textContent = '🆚 对比模式';
                if (global.Compare) global.Compare.clear();
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
    }

    /** 暴露给对比模式：单次体检（共用全链路，不动 currentCenter/currentSamples） */
    function runOneStandalone(addr, onProgress) {
        return new Promise(async (resolve, reject) => {
            try {
                const center = await geocode(addr);
                onProgress && onProgress(0.3, '等时圈…');
                const samples = await Isochrone.build(center, () => {});
                if (samples.length < 3) return reject(new Error('等时圈采样不足 3 个'));
                onProgress && onProgress(0.5, '画多边形…');
                const ir = Isochrone.render(map, samples, center);
                onProgress && onProgress(0.7, 'POI…');
                const resultByKey = await POI.fetchAll(center, samples, () => {});
                onProgress && onProgress(0.9, '评分…');
                const cal = Dashboard.calcScore(resultByKey, ir.area, center);
                onProgress && onProgress(1, '完成');
                // ⚠ 这里不清图、不污染 currentCenter，避免影响主看板
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
            await global.Compare.runOne(0);
            showLoader(true, '正在体检地址 B …');
            await global.Compare.runOne(1);

            // 渲染报告 + 自动切到对比 tab
            global.Compare.renderReport();
            global.Compare.activateCompareTab();
        } catch (e) {
            toast('对比失败：' + (e.message || e));
        } finally {
            showLoader(false);
            btn && (btn.disabled = false);
        }
    }

    async function runAnalysis() {
        const addr = readAddrA();
        if (!addr.trim()) { toast('请选择省/市/区，并输入详细地址'); return; }

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
        const ir = Isochrone.render(map, samples, center);
        Dashboard.setArea(ir.area);
        Dashboard.setCenter(addr);
        updateHudPath(samples.length);

        // 3. POI 检索
        showLoader(true, '检索周边民生配套（医院/药店/商超/学校/公交）...');
        const resultByKey = await POI.fetchAll(center, samples, (p, m) => showLoader(true, m));
        POI.render(map, resultByKey, ir.polygon);

        // 4. 看板
        const { score, missedCategories, breakdown } = Dashboard.calcScore(resultByKey, ir.area, center);
        Dashboard.renderPoiCount(resultByKey);
        Dashboard.renderCharts(resultByKey);
        Dashboard.setScore(score, Util.scoreLevel(score).text);

        // 5. 报告（携带 breakdown 让报告展示分维度细节）
        Report.build(center, resultByKey, ir.area, score, missedCategories, breakdown);

        // 6. 热力图数据准备（用户开启时用）
        const heatData = POI.collectHeatmapData(resultByKey, samples);
        Heatmap.setData(heatData);

        // 7. 自检：?autotest=1 时自动开启热力图并报告状态到 DOM（用于真浏览器验收）
        if (/[?&]autotest=1\b/.test(global.location.search)) {
            setTimeout(() => {
                let heatStatus = 'unknown';
                try {
                    Heatmap.show(map);
                    heatStatus = 'shown: wrapper=' + (Heatmap.wrapper ? 'yes' : 'no') +
                        ', canvas=' + (Heatmap.canvas ? (Heatmap.canvas.width + 'x' + Heatmap.canvas.height) : 'no') +
                        ', pts=' + (Heatmap.data ? Heatmap.data.length : 0) +
                        ', simpleheat=' + (typeof Heatmap.heat);
                } catch (e) { heatStatus = 'ERR: ' + (e.message || e); }
                const out = document.createElement('div');
                out.id = '__autotest';
                out.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:99999;background:rgba(20,32,64,0.95);color:#e6f0ff;padding:10px 14px;border-radius:8px;font-family:Consolas,monospace;font-size:12px;line-height:1.6;border:1px solid #3a7afe;max-width:560px;';
                out.textContent = 'AUTOTEST·heat=' + heatStatus +
                    ' · poi=' + Object.values(resultByKey).reduce((s, c) => s + c.items.length, 0) +
                    ' · score=' + score;
                document.body.appendChild(out);
            }, 200);
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
        Isochrone.clear(map);
        POI.clear(map);
        Heatmap.clear();
        Heatmap.hide();
        document.getElementById('btnHeatmap').classList.remove('active');
        document.getElementById('reportSingle').innerHTML = `
            <div class="empty-tip">
                <p>👋 请在上方输入小区 / 街道 / 社区地址，例如：</p>
                <ul><li>北京市朝阳区望京 SOHO</li><li>上海市浦东新区陆家嘴</li></ul>
                <p class="muted">系统会基于<strong>真实步行路网</strong>绘制 15 分钟可达圈。</p>
            </div>`;
        document.getElementById('reportAddr').textContent = '尚未体检';
        Dashboard.setScore(0, '未体检');
        Dashboard.renderPoiCount({});
        Dashboard.renderCharts({});
        document.getElementById('metaArea').textContent = '— km²';
        document.getElementById('metaCenter').textContent = '—';
        currentCenter = null;
        currentSamples = null;
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

    /** 暴露给百度 API 回调 */
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
