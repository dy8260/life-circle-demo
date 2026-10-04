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
    let analysisSuspended = false; // 对比模式是否已撤下三个分析图层（退出时据此决定要不要恢复开关）

    /** 初始化：百度 API 加载完毕时回调 */
    function init() {
        if (global.__inited) return;  // 幂等：避免 race 双触发
        // 置位放在最前，保证 init 内部后续步骤不会因并发二次进入。
        // ⚠ 若下方抛错，由调用方 tryInit() 的 catch 负责复位 __inited = false，
        //   否则 SDK 后续真正就绪时回调会被这行幂等判断挡掉，整页再也无法初始化。
        global.__inited = true;
        // 1. 地图实例
        map = new BMapGL.Map('map');
        global.__bmap = map;
        map.centerAndZoom(new BMapGL.Point(116.482, 39.92), 14);
        map.enableScrollWheelZoom(true);
        map.enableInertialDragging(true);
        map.enableKeyboard(true);

        // 2. 默认底图：卫星（用户指定）。普通档由 applyBaseLayer 切回时重新应用 midnight 深色矢量主题。
        applyBaseLayer('satellite');

        // 3. 绑定交互
        bindEvents();
        bindMapTypeSwitch();   // 底图主题切换（深色 / 浅色 / 灰度）
        bindWalkMinutes();     // 生活圈步行时长下拉（5/10/15/20/30 分钟）
        bindWalkTypes();       // 各类人员步行速度（可改）+ 点击设为「主分析人群」
        bindActiveTypeSelect();// 主人群下拉 + 速度输入框（弹窗内）
        bindCircleSettingsModal(); // ⚙ 生活圈设置弹窗（时长 / 人群速度 / 彩色圈开关）
        bindGapSettings();    // 弹窗内「服务盲区识别」配置（半径/重度阈值/采样间距/判定设施）
        bindSpeedCmp();        // 展示各人员步行区域（彩色可达圈）开关
        bindLegend();          // 合并图例（配套设施 / 每类人员）收起/展开
        bindInfoWidgets();     // 右上时间/天气部件 收起/展开
        syncCircleParams();    // 标题 / 评分卡目标时长 / 速度行 / 可达半径 全部同步一次
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

        // 3.2 区域选择器就绪后立即刷新天气（消除启动竞态：绑定前 select 为空导致首屏不抓天气）
        if (global.TimeWeather) { try { global.TimeWeather.updateWeather(); } catch (e) {} }

        // 4. 看板图表初始化
        Dashboard.ensureCharts();

        // 4.1 区域全屏（地图 / 报告 / 右侧数据面板 的 ⛶ 按钮）
        if (global.initFullscreen) initFullscreen();

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
        // +2px 安全余量：避免 topbar 底部边框 / 小数像素导致地图顶部被遮挡
        const h = Math.ceil(topbar.getBoundingClientRect().height) + 2;
        document.documentElement.style.setProperty('--header-h', h + 'px');
        // 若地图正在全屏，顶部栏高度变化会导致全屏面板尺寸变化，需通知百度地图重绘
        if (global.__bmap && document.querySelector('.map-panel.is-maximized')) {
            requestAnimationFrame(function () {
                requestAnimationFrame(function () {
                    try { global.__bmap.resize(); } catch (e) { /* 忽略 */ }
                });
            });
        }
    }

    function bindEvents() {
        const btnGo = document.getElementById('btnGo');
        const input = document.getElementById('addrInput');
        const btnDemo = document.getElementById('btnDemo');
        const btnExport = document.getElementById('btnExport');

        btnGo.addEventListener('click', runAnalysis);
        input.addEventListener('keypress', e => { if (e.key === 'Enter') runAnalysis(); });
        // 「演示数据」按钮：加载内置离线示例（北京·望京），无需联网即可展示完整体检效果
        if (btnDemo) btnDemo.addEventListener('click', loadOfflineDemo);
        // 「导出快照」按钮：将当前在线体检结果导出为 JSON，用于生成 / 更新离线示例数据
        if (btnExport) btnExport.addEventListener('click', exportSnapshot);

        // 对比模式入口：切换显示地址 B 行（紧贴地址 A 下方，不挤压标题）
        const btnCompare = document.getElementById('btnCompare');
        const addrBarB = document.getElementById('addrBarB');
        if (btnCompare && addrBarB) {
            btnCompare.addEventListener('click', () => {
                const show = addrBarB.hasAttribute('hidden');
                if (show) addrBarB.removeAttribute('hidden');
                else {
                    addrBarB.setAttribute('hidden', '');
                    /* 关闭对比时清空对比报告 */
                    if (global.Compare) global.Compare.clear();
                    /* 看板保留 A/B 对比视图，直到下次单地址体检 */
                    resumeAnalysisLayers();   // 对比期间被禁用的三个分析图层开关，按数据可用性重新放开
                }
                btnCompare.classList.toggle('active', show);
                btnCompare.textContent = show ? '🆚 关闭对比' : '🆚 对比模式';
                // 多/少一行地址 → 主区域高度重算；B 行显隐切换后 DOM 高度变化需要等下一帧布局完成再量
                syncLayoutHeight();
                requestAnimationFrame(syncLayoutHeight);
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
                resumeAnalysisLayers();   // 对比期间被禁用的三个分析图层开关，按数据可用性重新放开
                syncLayoutHeight();
                requestAnimationFrame(syncLayoutHeight);
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
                const which = tab.dataset.tab;
                switchReportTab(which);
                if (which === 'compare' && global.Compare) global.Compare.renderReport();
                // 切换到应力测试时重绘：面板从 hidden 变可见，ECharts 需要重新量取容器尺寸，
                // 否则初始化时容器宽度为 0，图表画不出来。
                if (which === 'stress' && global.Stress) global.Stress.renderTo('reportStress');
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

        // HUD（右侧圈参数状态）：点击收起 / 展开（收起后只保留「时长 / 速度」，隐藏可达半径与路网进度）
        const hud = document.getElementById('hud');
        if (hud) {
            hud.addEventListener('click', () => hud.classList.toggle('collapsed'));
        }

        document.getElementById('btnReportCopy').addEventListener('click', copyReport);
        document.getElementById('btnReportPrint').addEventListener('click', printReport);

        // 导出演示数据按钮已移除（示例数据改由构建期脚本 gen-report-from-snapshot.js 处理）

        // 服务盲区点位图层开关
        const btnGap = document.getElementById('btnGapToggle');
        if (btnGap) btnGap.addEventListener('click', toggleGap);
        // 选址推荐标注开关
        const btnRec = document.getElementById('btnRecToggle');
        if (btnRec) btnRec.addEventListener('click', toggleRec);
        // 步行阻抗场图层开关
        const btnImp = document.getElementById('btnImpedanceToggle');
        if (btnImp) btnImp.addEventListener('click', toggleImpedance);
    }

    /** 切换地图底图：普通（深色矢量）/ 卫星
     *   - 普通：矢量底图 + midnight 深色主题（与整站深色 UI 一致）
     *   - 卫星：BMapGL 栅格影像，对"看真实楼栋/道路"更有冲击力
     *  ⚠ 切到卫星前必须先 resetMapStyle() 清掉「普通」模式的自定义深色矢量样式，
     *    否则 midnight 的底色/主题残留，会把卫星影像压暗，看起来才"和普通没区别"。
     *    百度 GL 的地图类型常量是全局变量，用 typeof 兜底，避免某些版本未暴露时整段失效。
     */
    function applyBaseLayer(type) {
        if (!map) return;
        try {
            if (type === 'satellite') {
                // 卫星影像：切到栅格影像前先清掉矢量自定义样式，避免底色残留
                try { map.resetMapStyle(); } catch (e) {}
                map.setMapType((typeof BMAP_SATELLITE_MAP !== 'undefined') ? BMAP_SATELLITE_MAP : 'satellite');
            } else {
                // 普通：矢量底图 + 恢复 midnight 深色主题
                map.setMapType((typeof BMAP_NORMAL_MAP !== 'undefined') ? BMAP_NORMAL_MAP : 'normal');
                try { map.setMapStyle({ style: 'midnight' }); }
                catch (e) { try { map.setMapStyle({ style: 'dark' }); } catch (e2) {} }
            }
        } catch (e) {
            if (global.Util && Util.log) Util.log('底图切换失败', e);
        }
    }

    /** 绑定底图主题切换分段控件（事件委托，避免重复绑定） */
    function bindMapTypeSwitch() {
        const box = document.getElementById('mapTypeSwitch');
        if (!box) return;
        if (box.__mtBound) return;   // 幂等
        box.__mtBound = true;
        box.addEventListener('click', e => {
            const btn = e.target.closest('.mt-btn');
            if (!btn) return;
            const type = btn.getAttribute('data-type');
            applyBaseLayer(type);
            box.querySelectorAll('.mt-btn').forEach(b => b.classList.toggle('is-active', b === btn));
        });
    }

    /** 把当前「时长 + 主分析人群速度」同步到所有展示位：
     *  标题、评分卡目标时长、左侧时长下拉、各类人员速度输入行、主人群高亮、可达半径 */
    /** 设置弹窗当前是否处于打开状态（参数编辑面板内改值不要即时重算，点「完成」才统一分析） */
    function isSettingsModalOpen() {
        const m = document.getElementById('circleSettingsMask');
        return !!(m && m.classList.contains('is-open'));
    }

    function syncCircleParams() {
        const m = global.WALK_MINUTES || 15;
        const types = global.WALK_TYPES || [];
        const activeKey = global.ACTIVE_TYPE;
        const active = types.find(t => t.key === activeKey) || types[0];
        const radius = Math.round((active ? active.speed : 80) * m);   // 可达半径（米）= 主人群速度 × 时长
        const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };

        set('brandMinutes', m);
        set('metaTargetMinutes', m + ' 分钟');
        set('bwRadius', radius.toLocaleString('zh-CN'));

        // 左侧设置按钮摘要：时长 · 主人群 速度
        const sum = document.getElementById('circleSummary');
        if (sum && active) sum.textContent = `${m} 分钟 · ${active.label} ${active.speed}`;

        // 时长下拉同步
        const sel = document.getElementById('walkMinSelect');
        if (sel) sel.value = String(m);

        // 紧凑主行：主人群下拉 + 主人群速度输入框
        const typeSel = document.getElementById('activeTypeSelect');
        if (typeSel) typeSel.value = activeKey;

        const mainSpeed = document.getElementById('mainSpeed');
        if (mainSpeed && document.activeElement !== mainSpeed && active) mainSpeed.value = active.speed;

        // 各类人员速度输入行：同步各自速度值（用户正在编辑的那一行不覆盖）
        const box = document.getElementById('walkTypes');
        if (box) {
            box.querySelectorAll('.bw-type').forEach(row => {
                const key = row.getAttribute('data-key');
                const t = types.find(x => x.key === key);
                if (!t) return;
                row.classList.toggle('is-active', key === activeKey);
                const input = row.querySelector('.bw-speed');
                if (input && document.activeElement !== input) input.value = t.speed;
            });
        }

        // 同步「人员步行区域」图例（颜色 / 名称 / 速度 / 半径）
        renderSpeedLegend();
    }

    /** 弹窗打开时，把「服务盲区识别」当前配置回填到输入框 / 勾选框（保证所见即所得） */
    function syncGapParams() {
        const bg = global.BLIND_GAP || {};
        const setVal = (id, v) => { const el = document.getElementById(id); if (el && document.activeElement !== el) el.value = v; };
        setVal('gapRadius', bg.radiusMeters != null ? bg.radiusMeters : 1000);
        setVal('gapSevere', bg.severeMeters != null ? bg.severeMeters : 1500);
        setVal('gapGrid',   bg.gridStepMeters != null ? bg.gridStepMeters : 120);
        // 判定设施复选框：与 checkKeys 对齐
        const keys = Array.isArray(bg.checkKeys) ? bg.checkKeys : ['market', 'pharmacy', 'school'];
        document.querySelectorAll('#circleSettingsMask [data-gapkey]').forEach(cb => {
            cb.checked = keys.indexOf(cb.getAttribute('data-gapkey')) !== -1;
        });
    }

    /** 绑定「服务盲区识别」配置：改动即写入 global.BLIND_GAP（弹窗内不即时分析，点「完成」统一应用） */
    function bindGapSettings() {
        const mask = document.getElementById('circleSettingsMask');
        if (!mask || mask.__gapBound) return;   // 幂等
        mask.__gapBound = true;
        // 输入框 change 时写入（半径 / 重度阈值 / 采样间距）
        mask.addEventListener('change', e => {
            const t = e.target;
            if (t.id === 'gapRadius' || t.id === 'gapSevere' || t.id === 'gapGrid') {
                if (global.setBlindGap) {
                    global.setBlindGap({
                        radius: document.getElementById('gapRadius').value,
                        severe: document.getElementById('gapSevere').value,
                        grid:   document.getElementById('gapGrid').value
                    });
                }
                return;
            }
            // 判定设施复选框：收集当前勾选项
            if (t.hasAttribute && t.hasAttribute('data-gapkey')) {
                if (global.setBlindGap) {
                    const keys = [];
                    document.querySelectorAll('#circleSettingsMask [data-gapkey]').forEach(cb => {
                        if (cb.checked) keys.push(cb.getAttribute('data-gapkey'));
                    });
                    global.setBlindGap({ keys: keys });
                }
            }
        });
    }

    /** 构建 / 刷新「人员步行区域」图例：每类人员的颜色 + 速度 + 步行可达半径（速度 × 时长） */
    function renderSpeedLegend() {
        const list = document.getElementById('speedLegendList');
        if (!list) return;
        const m = global.WALK_MINUTES || 15;
        const types = global.WALK_TYPES || [];
        const activeKey = global.ACTIVE_TYPE;
        list.innerHTML = types.map(t => {
            const r = Math.round(t.speed * m);
            const rTxt = r >= 1000 ? (r / 1000).toFixed(2) + ' km' : r + ' m';
            const tag = (t.key === activeKey) ? ' <i class="sl-tag">主</i>' : '';
            return '<li class="sl-item' + (t.key === activeKey ? ' is-active' : '') + '">' +
                '<span class="sl-dot" style="background:' + t.color + '"></span>' +
                '<span class="sl-name">' + t.label + tag + '</span>' +
                '<span class="sl-meta">' + t.speed + ' · ' + rTxt + '</span>' +
                '</li>';
        }).join('');
        const sub = document.getElementById('slSub');
        if (sub) sub.textContent = m + ' 分钟可达';
    }

    /** 绑定「生活圈步行时长」下拉：切换后立即按新时长重算（已体检过则重跑全链路） */
    function bindWalkMinutes() {
        const sel = document.getElementById('walkMinSelect');
        if (!sel) return;
        if (sel.__wmBound) return;   // 幂等
        sel.__wmBound = true;
        sel.value = String(global.WALK_MINUTES || 15);
        sel.addEventListener('change', () => {
            if (global.applyWalkMinutes) global.applyWalkMinutes(sel.value);
            syncCircleParams();
            // 弹窗编辑面板内：仅更新状态与 UI，不即时重算，等点「完成」统一分析
            if (isSettingsModalOpen()) return;
            // 已体检过：用当前地址按新时长重算（等时圈/POI/盲区/评分全部刷新）
            if (currentCenter) runAnalysis();
            refreshSpeedComparison();
        });
    }

    /** 绑定「主分析人群」下拉 + 主人群速度输入框（紧凑单行版）：
     *  - 切换下拉 → 设为主分析人群并重算
     *  - 改速度输入框 → 更新当前主人群速度并重算 */
    function bindActiveTypeSelect() {
        const typeSel = document.getElementById('activeTypeSelect');
        const mainSpeed = document.getElementById('mainSpeed');
        if (typeSel && !typeSel.__atBound) {
            typeSel.__atBound = true;
            typeSel.addEventListener('change', () => {
                if (global.setActiveType) global.setActiveType(typeSel.value);
                syncCircleParams();
                if (isSettingsModalOpen()) return;   // 弹窗内仅更新状态/UI，点「完成」才分析
                if (currentCenter) runAnalysis();
                refreshSpeedComparison();
            });
        }
        if (mainSpeed && !mainSpeed.__msBound) {
            mainSpeed.__msBound = true;
            mainSpeed.addEventListener('change', () => {
                let v = Math.round(Number(mainSpeed.value) || 80);
                v = Math.max(20, Math.min(160, v));
                if (global.setTypeSpeed) global.setTypeSpeed(global.ACTIVE_TYPE, v);
                syncCircleParams();
                if (isSettingsModalOpen()) return;   // 弹窗内仅更新状态/UI，点「完成」才分析
                if (currentCenter) runAnalysis();
                refreshSpeedComparison();
            });
        }
    }

    /** 绑定「生活圈设置」弹窗：打开 / 关闭（点按钮、点 × 、点完成、点遮罩、按 ESC 均可关） */
    function bindCircleSettingsModal() {
        const btn = document.getElementById('openCircleSettings');
        const mask = document.getElementById('circleSettingsMask');
        const closeBtn = document.getElementById('circleSettingsClose');
        const doneBtn = document.getElementById('circleSettingsDone');
        const resetBtn = document.getElementById('circleSettingsReset');
        if (!btn || !mask) return;

        const open = () => {
            mask.classList.add('is-open');
            btn.setAttribute('aria-expanded', 'true');
            syncGapParams();   // 打开即把当前盲区配置回填弹窗
            const first = mask.querySelector('select, input');
            if (first) setTimeout(() => first.focus(), 30);
        };
        const close = () => {
            mask.classList.remove('is-open');
            btn.setAttribute('aria-expanded', 'false');
        };

        if (!btn.__csBound) {
            btn.__csBound = true;
            btn.addEventListener('click', open);
        }
        if (closeBtn && !closeBtn.__csBound) {
            closeBtn.__csBound = true;
            closeBtn.addEventListener('click', close);
        }
        if (doneBtn && !doneBtn.__csBound) {
            doneBtn.__csBound = true;
            doneBtn.addEventListener('click', () => {
                close();
                // 「完成」：统一应用弹窗内所有改动（等时圈 / POI / 盲区 / 评分 / 彩色圈）
                if (currentCenter) runAnalysis();
            });
        }
        // 点遮罩空白处关闭
        if (!mask.__csBound) {
            mask.__csBound = true;
            mask.addEventListener('click', e => { if (e.target === mask) close(); });
        }
        // ESC 关闭
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && mask.classList.contains('is-open')) close();
        });
        // 恢复默认
        if (resetBtn && !resetBtn.__csBound) {
            resetBtn.__csBound = true;
            resetBtn.addEventListener('click', () => {
                if (global.applyWalkMinutes) global.applyWalkMinutes(15);
                if (global.setActiveType) global.setActiveType('adult');
                const def = { adult: 80, youth: 100, elder: 50, child: 60, wheel: 40 };
                Object.keys(def).forEach(k => { if (global.setTypeSpeed) global.setTypeSpeed(k, def[k]); });
                if (global.resetBlindGap) global.resetBlindGap();   // 盲区配置恢复默认
                const cmp = document.getElementById('cmpCircles');
                if (cmp) cmp.checked = false;
                syncCircleParams();
                syncGapParams();
                if (isSettingsModalOpen()) return;   // 弹窗内仅重置+UI，点「完成」才分析
                if (currentCenter) runAnalysis();
                refreshSpeedComparison();
            });
        }
    }

    /** 绑定「各类人员步行速度」：
     *  - 点击某行（除输入框外）→ 设为「主分析人群」（影响真实等时圈/POI/盲区/评分），并重算
     *  - 修改某行速度输入框 → 更新该类速度；若为主人群则同步重算真实等时圈等
     *  两者都会刷新「各人员步行区域」彩色圈（若已勾选） */
    function bindWalkTypes() {
        const box = document.getElementById('walkTypes');
        if (!box) return;
        if (box.__wtBound) return;   // 幂等
        box.__wtBound = true;

        // 点击行 → 切主人群（点在输入框上例外）
        box.addEventListener('click', e => {
            const row = e.target.closest('.bw-type');
            if (!row) return;
            if (e.target.closest('.bw-speed')) return;
            const key = row.getAttribute('data-key');
            if (key === global.ACTIVE_TYPE) return;
            if (global.setActiveType) global.setActiveType(key);
            syncCircleParams();
            if (isSettingsModalOpen()) return;   // 弹窗内仅更新状态/UI，点「完成」才分析
            if (currentCenter) runAnalysis();
            refreshSpeedComparison();
        });

        // 修改速度输入框 → 更新该类速度并重算
        box.addEventListener('change', e => {
            const input = e.target.closest('.bw-speed');
            if (!input) return;
            const key = input.getAttribute('data-key');
            const v = Math.round(Number(input.value) || 0);
            if (global.setTypeSpeed) global.setTypeSpeed(key, v);
            syncCircleParams();
            if (isSettingsModalOpen()) return;   // 弹窗内仅更新状态/UI，点「完成」才分析
            if (currentCenter) runAnalysis();
            refreshSpeedComparison();
        });
    }

    /** 绑定「展示各人员步行区域」开关 */
    function bindSpeedCmp() {
        const t = document.getElementById('cmpCircles');
        if (!t) return;
        if (t.__scBound) return;   // 幂等
        t.__scBound = true;
        t.addEventListener('change', () => {
            // 弹窗内勾选/取消不即时刷新地图，点「完成」统一分析
            if (isSettingsModalOpen()) return;
            refreshSpeedComparison();
        });
    }

    /** 绑定合并「图例」的收起 / 展开（点击头部切换：两列 → 仅标题栏） */
    function bindLegend() {
        const head = document.getElementById('legendHead');
        const box = document.getElementById('legendBox');
        if (!head || !box || head.__lgBound) return;
        head.__lgBound = true;
        head.addEventListener('click', () => {
            const collapsed = box.classList.toggle('is-collapsed');
            const tg = head.querySelector('.lg-toggle');
            if (tg) tg.textContent = collapsed ? '▸' : '▼';
        });
    }

    /**
     * 渲染「分析图层」图例（服务盲区点位 / 推荐选址 / 步行阻抗场）。
     * 复用「配套设施」的复选框图例样式：
     *  - 单地址模式：置于「每类人员」列下方；
     *  - 对比模式：重新定位到「配套设施」列（与 A/B 图例同列），复选框禁用，仅作符号说明。
     * 复选框勾选态联动地图对应图层的显隐（复用 toggleGap / toggleRec / toggleImpedance）。
     *
     * @param {Object} [gap] 盲区结果（仅用于 severeMeters 取阈值，缺省时回退全局配置）
     */
    function renderLayerLegend(gap) {
        const ul = document.getElementById('layerLegendList');
        if (!ul) return;

        const card = document.querySelector('.report-card');
        const inCompare = !!(card && card.classList.contains('has-compare'));

        // 对比模式下图层不在该地图叠加，三个复选框勾选无响应，故直接不渲染（保持图例清爽）
        if (inCompare) {
            ul.innerHTML = '';
            return;
        }

        // 单地址模式：图例置于「每类人员」列下方（HTML 中默认位置）
        const BLIND = global.BLIND_GAP || {};
        // 盲区结果优先取传入的 gap，否则回退到最近一次分析结果（刷新图例时可能无入参）
        const gapData = gap || (global.GapFinder && global.GapFinder.lastResult);
        // 仅当确实识别出盲区时才显示「服务盲区点位」复选框；无盲区时图层为空、勾选无意义
        const hasGap = !!(gapData && gapData.gapCount > 0);
        const severeM = (gapData && gapData.params && gapData.params.severeMeters)
            || BLIND.severeMeters || 1500;
        const severeKm = (severeM / 1000).toFixed(1);

        const gapOn = !!(global.GapFinder && GapFinder.visible);
        const recOn = !!global.__recActive;
        const impOn = !!(global.Stress && global.Stress._imp && global.Stress._imp.visible);

        const item = (layer, on, sym, text, sub) =>
            '<li class="legend-item legend-layer-item" data-layer="' + layer + '">'
            + '<label class="legend-label" title="点击在地图上显示 / 隐藏">'
            + '<input type="checkbox" class="legend-check" data-layer="' + layer + '"'
            + (on ? ' checked' : '')
            + '>'
            + '<span class="legend-sym-wrap">' + sym + '</span>'
            + '<span class="legend-text">' + text + ' <small class="layer-note">' + sub + '</small></span>'
            + '</label></li>';

        const items = [];
        // 服务盲区点位：仅当存在盲区时显示；图标统一用单个红点代表盲区点位（图层含一般/重度两类）
        if (hasGap) {
            items.push(item('gap', gapOn,
                '<i class="dot" style="background:#ff5470"></i>',
                '服务盲区点位', '重度 ' + severeKm + 'km'));
        }
        // 推荐选址：🏗️ 拟新建落点
        items.push(item('rec', recOn, '🏗️', '推荐选址', '拟新建落点'));
        // 步行阻抗场：蓝→红 渐变条（绕行越大越红）
        items.push(item('imp', impOn, '<span class="legend-grad"></span>', '步行阻抗场', '蓝→红·绕行越大'));

        ul.innerHTML = items.join('');

        // 一次性委托：复选框切换对应图层显隐
        if (!ul.__layerBound) {
            ul.__layerBound = true;
            ul.addEventListener('change', (e) => {
                const cb = e.target.closest('.legend-check[data-layer]');
                if (!cb) return;
                const layer = cb.getAttribute('data-layer');
                if (layer === 'gap') toggleGap();
                else if (layer === 'rec') toggleRec();
                else if (layer === 'imp') toggleImpedance();
                renderLayerLegend();   // 显隐变化后刷新图例勾选态
            });
        }
    }
    global.renderLayerLegend = renderLayerLegend;

    /** 绑定右上「时间 / 天气」部件的收起 / 展开（点击头部切换；收起态头部显示紧凑 HH:MM） */
    function bindInfoWidgets() {
        const head = document.getElementById('iwHead');
        const box = document.getElementById('infoWidgets');
        if (!head || !box || head.__iwBound) return;
        head.__iwBound = true;
        head.addEventListener('click', () => {
            const collapsed = box.classList.toggle('is-collapsed');
            const tg = head.querySelector('.iw-toggle');
            if (tg) tg.textContent = collapsed ? '▸' : '▼';
        });
    }

    /** 在地图上用不同颜色展示每类人员的「真实路网步行区域」（真实等时圈，非圆）。
     *  ⚠ 此模式【隐藏】主分析人群的真实路网等时圈多边形，改画 5 类各自的真实路网等时圈——
     *    每类按其「速度 × 时长」截断 16 向完整步行路径获得真实可达多边形，主人群更粗更实。
     *    路径只采样一次（按最快人群 × 时长 × 1.5），5 类共用截断，避免 5×16 次路由。 */
    let speedCmpOverlays = [];
    let speedCmpCenterMk = null;
    let speedCmpPaths = null;     // 缓存的 16 条完整路径（带签名失效）
    let speedCmpSig = null;
    let speedCmpRunToken = 0;     // 运行令牌：采样中再次触发时，旧运行放弃渲染，防图层重复叠加
    function clearSpeedCmpOverlays() {
        speedCmpOverlays.forEach(o => { try { map.removeOverlay(o); } catch (e) {} });
        speedCmpOverlays = [];
        if (speedCmpCenterMk) { try { map.removeOverlay(speedCmpCenterMk); } catch (e) {} speedCmpCenterMk = null; }
    }
    async function refreshSpeedComparison() {
        const myToken = ++speedCmpRunToken;
        clearSpeedCmpOverlays();
        const t = document.getElementById('cmpCircles');
        const show = !!(t && t.checked);
        try {
            await _refreshSpeedComparisonInner(t, show, myToken);
        } finally {
            // 关键：本函数会通过 onProgress 调 showLoader(true)，而除 runAnalysis 外的
            // 触发路径（设置弹窗勾选 / 改速度 / 切主人群）没有任何外层收尾，
            // 不在这里 hide 会导致遮罩永远卡在「计算各人员步行区域...」。showLoader 幂等，重复 hide 无副作用。
            // 只有最新一次运行负责收尾，避免旧运行提前 hide 打断新运行的进度提示。
            if (myToken === speedCmpRunToken) showLoader(false);
        }
    }

    async function _refreshSpeedComparisonInner(t, show, myToken) {
        if (!show) {
            // 关闭：若真实等时圈曾被隐藏则恢复（POI / 盲区标记不受影响）
            if (currentSamples && currentCenter && typeof BMapGL !== 'undefined'
                && (!global.Isochrone || !global.Isochrone.polygon)) {
                try { Isochrone.render(map, currentSamples, currentCenter); } catch (e) {}
            }
            return;
        }
        if (!currentCenter || typeof BMapGL === 'undefined') return;

        const m = global.WALK_MINUTES || 15;
        const types = global.WALK_TYPES || [];
        const c = new BMapGL.Point(currentCenter.lng, currentCenter.lat);

        // 隐藏主分析人群的真实路网等时圈多边形（将在下方用 5 类真实等时圈替换）
        try { Isochrone.clear(map); } catch (e) {}

        // 远点距离按「最快人群 × 时长 × 1.5」保证覆盖全部类型；带签名缓存，中心/时长变化才重算
        const maxSpeed = types.reduce((a, x) => Math.max(a, x.speed), 0);
        const farDistance = Math.round(maxSpeed * m * 1.5);
        const sig = currentCenter.lng.toFixed(6) + ',' + currentCenter.lat.toFixed(6) + ',' + farDistance;
        if (speedCmpSig !== sig || !speedCmpPaths) {
            try {
                const paths = await Isochrone.buildPaths(currentCenter, farDistance, (p, msg) => {
                    // 采样中又有新触发：本次作废，不再刷新遮罩文案
                    if (myToken === speedCmpRunToken) showLoader(true, msg || '计算各人员步行区域...');
                });
                if (myToken !== speedCmpRunToken) return;   // 已被新运行接管，放弃本次结果
                speedCmpPaths = paths;
                speedCmpSig = sig;
            } catch (e) { if (myToken === speedCmpRunToken) speedCmpPaths = null; }
        }

        // 中心点 marker 补回（上面 Isochrone.clear 已移除）
        try { speedCmpCenterMk = Isochrone.renderCenterMarker(map, c); } catch (e) {}

        // 每类人员各画一条「真实路网」等时圈（按各自速度 × 时长截断），主人群更粗更实
        if (speedCmpPaths) {
            types.forEach(p => {
                const targetDist = Math.round(p.speed * m);
                const isActive = p.key === global.ACTIVE_TYPE;
                const style = {
                    strokeColor: p.color,
                    strokeWeight: isActive ? 2.5 : 1.5,
                    strokeOpacity: isActive ? 0.95 : 0.65,
                    strokeStyle: 'solid',
                    fillColor: p.color,
                    fillOpacity: isActive ? 0.12 : 0.05
                };
                const poly = Isochrone.renderIsoForType(map, speedCmpPaths, c, targetDist, style);
                if (poly) speedCmpOverlays.push(poly);
            });
        } else {
            // 兜底：路径采样失败（如周边路网稀疏），退化为彩色圆，保证至少有可视化
            types.forEach(p => {
                const r = Math.round(p.speed * m);
                if (r <= 0) return;
                const isActive = p.key === global.ACTIVE_TYPE;
                const circle = new BMapGL.Circle(c, r, {
                    strokeColor: p.color, strokeWeight: isActive ? 2.5 : 1.5,
                    strokeOpacity: isActive ? 0.95 : 0.65, strokeStyle: 'solid',
                    fillColor: p.color, fillOpacity: isActive ? 0.1 : 0.05
                });
                map.addOverlay(circle);
                speedCmpOverlays.push(circle);
            });
        }
    }

    /** 暴露给对比模式：单次体检（共用全链路，不动 currentCenter/currentSamples）
     *  注意：此函数不做任何地图渲染/跳转（Isochrone.render / POI.render / centerAndZoom），
     *  对比模式由 _renderCompareMap 统一绘制，避免中间状态互相覆盖导致闪烁或丢失。
     */
    function runOneStandalone(addr, onProgress) {
        return new Promise(async (resolve, reject) => {
            try {
                const center = await geocode(addr);
                onProgress && onProgress(0.2, '等时圈…');
                // 用「完整路径」采样（与单地址体检同源）：一次 16 向采样，主等时圈 + 各人群评分全部复用，
                // 避免对比模式各地址重复绕路导致 AK 配额翻倍。
                const minutes = global.WALK_MINUTES || 15;
                const typesAll = global.WALK_TYPES || [];
                const maxSpeed = typesAll.reduce((a, x) => Math.max(a, x.speed), 0) || (global.ISO.walkSpeed || 80);
                const farDistance = Math.round(maxSpeed * minutes * 1.5);
                const fullPaths = await Isochrone.buildPaths(center, farDistance, () => {});
                if (!fullPaths || fullPaths.length < 3) return reject(new Error('等时圈采样不足 3 个'));
                const activeDist = (global.getActiveSpeed() || global.ISO.walkSpeed || 80) * minutes;
                // 主人群等时圈边界（截断到主人群距离），供多边形面积与主评分使用
                const samples = fullPaths
                    .map(fp => (fp && fp.length >= 2) ? Util.pointAtDistance(fp, activeDist) : null)
                    .filter(Boolean);
                onProgress && onProgress(0.4, '画多边形…');
                // 构造多边形对象但不添加到地图（对比模式由 _renderCompareMap 统一渲染）
                const pts = Isochrone.buildPolygon(samples, center);
                const polygon = new BMapGL.Polygon(pts, Isochrone.defaultStyle());
                const area = Util.polygonArea(pts);
                const ir = { polygon, area, pts };  // pts 供 _renderCompareMap 直接使用（polygon 未上地图时 getPath() 不可靠）
                onProgress && onProgress(0.6, 'POI…');
                // 检索边界用「最快人群」可达范围（farDistance），保证各类人 perType 数 POI 不漏；
                // 主评分仍用按主人群多边形（activeDist）裁剪后的 resultByKeyActive，与单地址体检同源。
                const maxBoundary = fullPaths
                    .map(fp => (fp && fp.length >= 2) ? Util.pointAtDistance(fp, farDistance) : null)
                    .filter(Boolean);
                const resultByKeyFull = await POI.fetchAll(center, maxBoundary, () => {});
                const activePts = samples.map(p => ({ lng: p.lng, lat: p.lat }));
                const resultByKey = Util.filterByPolygon(resultByKeyFull, activePts);
                // 不调用 POI.render / Isochrone.render / map.centerAndZoom，避免干扰对比模式
                onProgress && onProgress(0.8, '评分…');
                const cal = Dashboard.calcScore(resultByKey, area, center);
                // 各人群（全龄/适老/无障碍）评分：复用完整 fullPaths + 完整 POI，与单地址体检同源
                const perType = Dashboard.perTypeScores(typesAll, center, fullPaths, minutes, global.ACTIVE_TYPE, resultByKeyFull);
                onProgress && onProgress(1, '完成');
                // 无障碍可达性达标率（最近设施实测 × GB 50180-2018，独有轮椅维度）：
                // 在等时圈多边形内采样居住点，逐类测算到最近设施的真实步行耗时并与国标半径比对。
                const accPoly = (ir && ir.pts && ir.pts.length >= 3)
                    ? ir.pts.map(p => ({ lng: p.lng, lat: p.lat }))
                    : null;
                let accessibility = null;
                try {
                    accessibility = await Accessibility.compute(center, accPoly, resultByKeyFull, { onProgress: (p, m) => onProgress && onProgress(0.9, m) });
                } catch (ae) { console.warn('可达性测算失败（不影响主流程）', ae); accessibility = null; }

                // 选址推荐（补点建议）依赖盲区分析结果；计算一次后既供推荐卡使用，
                // 也供对比模式「服务盲区识别」卡复用（_renderCompareGap 直接读 res.gapResult，不再重复跑）。
                let gapResult = null, recommendation = null;
                try {
                    gapResult = await GapFinder.analyze(center, accPoly, resultByKey, () => {});
                } catch (ge) { console.warn('盲区分析失败（不影响主流程）', ge); gapResult = null; }
                try {
                    if (global.RECOMMEND && global.RECOMMEND.enabled !== false && gapResult && gapResult.enabled) {
                        recommendation = Recommend.compute(gapResult, {});
                    }
                } catch (re) { console.warn('选址推荐计算失败（不影响主流程）', re); recommendation = null; }

                resolve({ center, samples, ir, resultByKey, resultByKeyFull, score: cal.score, breakdown: cal.breakdown, missedCategories: cal.missedCategories, perType, accessibility, gapResult, recommendation });
            } catch (e) {
                reject(e);
            }
        });
    }

    // 右上角 HUD 卡已移除（用户要求去掉最右侧显示），路网采样进度不再单独展示；
    // 等时圈采样进度由加载遮罩（Loader）体现，故以下两个函数保留调用点但为空实现。
    function updateHud() {}
    function updateHudPath() {}

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
            // ⚠ 叠加 A/B 之前先撤掉单地址视图下的三个分析图层（盲区点位 / 选址推荐 / 步行阻抗场），
            //   否则会与两套等时圈 + POI 糊在一起，对比图读不出来。
            suspendAnalysisLayers();
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
        else switchReportTab('single');
        // 「全选」复选框只在单地址模式有意义（对比模式展示 A/B 地址图例）→ 恢复显示
        const legendBox = document.getElementById('legendBox');
        if (legendBox) legendBox.classList.remove('is-compare');
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
            // 1. 清空地图上旧的覆盖层（上次对比残留 + 单地点模式残留），
            //    并改为对比模式配色图例：A 地址（蓝）/ B 地址（橙）
            clearCompareOverlays(true);
            const legendList = document.getElementById('legendList');
            const legendTitle = document.querySelector('.legend .lg-title');
            if (legendTitle) legendTitle.textContent = '对比图例';
            // 「配套设施」列此时展示的是 A/B 地址图例，「全选」主复选框不适用 → 隐藏（见 css .legend.is-compare）
            const legendBox = document.getElementById('legendBox');
            if (legendBox) legendBox.classList.add('is-compare');
            if (legendList) {
                // 每行只留一个色点：原先「色点 + emoji 圆点」重复，视觉上变成两个图标
                legendList.innerHTML =
                    '<li><span class="dot" style="background:#5b9bff"></span>A 地址（蓝）</li>' +
                    '<li><span class="dot" style="background:#ff9f43"></span>B 地址（橙）</li>';
            }
            // 分析图层图例（服务盲区点位 / 推荐选址 / 步行阻抗场）在对比模式下不展示，
            // renderLayerLegend 检测到 has-compare 会清空并 return；这里再调一次以清掉单地址残留。
            renderLayerLegend(null);

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
            // 优先复用 runOneStandalone 已算好的盲区结果（避免重复 6 次 WalkingRoute 标定）
            if (res && res.gapResult) return res.gapResult;
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
        analysisSuspended = false;   // 单地址体检自行控制三个分析图层，清掉对比残留标记

        // 1. 地理编码
        showLoader(true, '正在解析地址...');
        let center;
        try {
            Util.logGroup('geocode start', addr);
            center = await geocode(addr);
            Util.logGroup('geocode ok', { lng: center.lng, lat: center.lat });
        } catch (e) {
            Util.logGroup('geocode fail', e.message || e);
            // 在线地图服务不可用（超时 / AK 未授权 / 配额耗尽）时，自动切换到内置离线示例数据，
            // 保证评审/演示打开页面时永不空白；真正的「地址填错」才会走下方 toast。
            const msg = (e && e.message) || '';
            if (!global.BMapGL || /超时|timeout|AK|INVALID|PERMISSION|权限|UNAUTHORIZED|quota|配额/i.test(msg)) {
                showLoader(false);
                toast('在线地图服务暂不可用，已切换到离线示例数据（北京·望京）');
                await loadOfflineDemo();
                return;
            }
            showLoader(false);
            toast('地址解析失败：' + (e.message || '请尝试更精确的地址'));
            return;
        }

        currentCenter = center;
        map.centerAndZoom(center, 16);

        // 2. 等时圈（完整路径：一次 16 向采样，主等时圈 + 各人群评分 + 各人员步行区域 全部复用，零额外路由）
        const minutes = global.WALK_MINUTES || 15;
        const typesAll = global.WALK_TYPES || [];
        const maxSpeed = typesAll.reduce((a, x) => Math.max(a, x.speed), 0) || (global.ISO.walkSpeed || 80);
        const farDistance = Math.round(maxSpeed * minutes * 1.5);
        showLoader(true, '计算 ' + minutes + ' 分钟步行等时圈...');
        let fullPaths;
        try {
            fullPaths = await Isochrone.buildPaths(center, farDistance, (p, m) => showLoader(true, m));
        } catch (e) {
            fullPaths = null;
        }
        if (!fullPaths || fullPaths.length < 3) {
            // 等时圈采样失败（通常是步行路由服务不可用）：自动切换到离线示例数据，避免空白
            showLoader(false);
            toast('在线路网服务暂不可用，已切换到离线示例数据（北京·望京）');
            await loadOfflineDemo();
            return;
        }
        // 缓存供「展示各人员步行区域」复用（签名 = 中心 + farDistance，与 refreshSpeedComparison 一致，避免重复 16 次路由）
        speedCmpPaths = fullPaths;
        speedCmpSig = center.lng.toFixed(6) + ',' + center.lat.toFixed(6) + ',' + farDistance;

        // 主人群等时圈：从完整路径按「主人群速度 × 时长」截断（与地图体检主圈同源）
        const activeDist = (global.getActiveSpeed() || global.ISO.walkSpeed || 80) * minutes;
        clearCompareOverlays(true);   // ⚠ 先清掉对比模式残留的 B 圈 + B 图标
        const ir = Isochrone.renderFromPaths(map, fullPaths, center, activeDist, Isochrone.defaultStyle());
        // 截断后的主圈采样点（仅供「关闭各人员步行区域」恢复主圈 + POI 检索边界使用）
        currentSamples = fullPaths
            .map(fp => (fp && fp.length >= 2) ? Util.pointAtDistance(fp, activeDist) : null)
            .filter(Boolean);

        Dashboard.exitCompare();          // 若看板还停留在 A/B 对比视图，切回单地址视图再填新数据
        restoreRecMarkers();              // 还原单地址视图下的推荐标注（若有）
        Dashboard.setArea(ir.area);
        Dashboard.setCenter(addr);
        updateHudPath(fullPaths.length);

            // 3. POI 检索 ~ 7. 自检（整体 try-catch 确保异常时加载层仍能消失）
            // ⚠ score / resultByKey 等变量需提升到 try 之外，供末尾 logGroup 使用（否则块级作用域报错）
            let score = 0, missedCategories = [], breakdown = null, resultByKey = null;
            try {
                // POI 检索边界用「最快人群」可达范围（fullPaths 外缘 = farDistance），
                // 保证各类人 perTypeScores 数 POI 不漏（含比主人群更快的类型）；
                // 主评分 / 盲区 / 面板 / 报告 仍用按主人群多边形裁剪后的 resultByKeyActive，与地图主圈一致。
                const maxBoundary = fullPaths
                    .map(fp => (fp && fp.length >= 2) ? Util.pointAtDistance(fp, farDistance) : null)
                    .filter(Boolean);
                showLoader(true, '检索周边民生配套（医院/药店/菜市场/商超/学校/公交）...');
                resultByKey = await POI.fetchAll(center, maxBoundary, (p, m) => showLoader(true, m));
                POI.render(map, resultByKey, ir.polygon);
                // 主人群可达范围裁剪（currentSamples = activeDist 截断），供主流程消费
                const activePts = (currentSamples || []).map(p => ({ lng: p.lng, lat: p.lat }));
                const resultByKeyActive = Util.filterByPolygon(resultByKey, activePts);

            // 4. 服务盲区识别（核心指标）
            showLoader(true, '识别服务盲区点位...');
            const gapResult = await GapFinder.analyze(center, currentSamples, resultByKeyActive, (p, m) => showLoader(true, m));

            // 5. 看板
            const { score, missedCategories, breakdown } = Dashboard.calcScore(resultByKeyActive, ir.area, center);
            // 5.0 各人群（全龄/适老/无障碍）评分：真实路网计算（复用完整 fullPaths + 完整 POI），与地图体检同源
            const perType = Dashboard.perTypeScores(
                global.WALK_TYPES || [],
                center,
                fullPaths,
                minutes,
                global.ACTIVE_TYPE,
                resultByKey
            );
            Dashboard.renderPerType(perType);
            Dashboard.renderPoiCount(resultByKeyActive);
            Dashboard.renderCharts(resultByKeyActive);
            Dashboard.setScore(score, Util.scoreLevel(score).text);
            Dashboard.renderGap(gapResult);

            // 6.0 无障碍可达性达标率（最近设施实测 × GB 50180-2018，独有轮椅维度）
            //     与「配套数量」互补：数量看"圈内有多少"，本指标看"走到最近一处要多久、是否达国标半径"。
            showLoader(true, '测算无障碍可达性达标率...');
            const accPoly = (currentSamples || []).map(p => ({ lng: p.lng, lat: p.lat }));
            let access = null;
            try {
                access = await Accessibility.compute(center, accPoly, resultByKey, { onProgress: (p, m) => showLoader(true, m) });
            } catch (ae) { console.warn('可达性测算失败（不影响主流程）', ae); access = null; }
            Dashboard.renderAccessibility(access);

            // 6.0.2 用可达性实测样本精化 λ 场
            //      可达性模块对每个居住点都跑了一次真实 WalkingRoute，观测点通常比纯锚点标定
            //      多一个量级；用这批样本重算 λ(x,y)，阻抗场与判定置信度都会明显更准。
            //      这一步不改动既有的盲区判定结果，只补充阻抗场与三态字段。
            try {
                if (access && access.ok && access.lambdaPairs && access.lambdaPairs.length) {
                    GapFinder.refineLambdaField(access.lambdaPairs);
                }
            } catch (fe) { console.warn('λ 场精化失败（不影响主流程）', fe); }

            // 6.0.1 选址推荐（补点建议）：针对盲区贪心选点
            let recommend = null;
            try {
                if (global.RECOMMEND && global.RECOMMEND.enabled !== false) {
                    recommend = Recommend.compute(gapResult, {});
                }
            } catch (re) { console.warn('选址推荐计算失败（不影响主流程）', re); recommend = null; }
            Dashboard.renderRecommend(recommend);
            global.__lastRecommend = recommend;
            global.__recActive = false;
            // 地图标注：默认开启（便于现场查看），可用「标注选址」按钮切换
            const recBtn = document.getElementById('btnRecToggle');
            const hasRecSites = !!(recommend && recommend.ok && recommend.perCategory.some(c => c.sites && c.sites.length));
            if (hasRecSites) {
                if (global.RECOMMEND && global.RECOMMEND.autoShow) {
                    Recommend.renderMarkers(map, recommend);
                    global.__recActive = true;
                    if (recBtn) { recBtn.disabled = false; recBtn.classList.add('active'); recBtn.textContent = '隐藏标注'; }
                } else if (recBtn) { recBtn.disabled = false; recBtn.textContent = '标注选址'; }
            } else if (recBtn) {
                recBtn.disabled = true; recBtn.classList.remove('active'); recBtn.textContent = '标注选址';
            }

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
            Report.build(center, resultByKeyActive, ir.area, score, missedCategories, breakdown, gapResult, perType, access, recommend);

            // 6.2 生活圈应力测试：对同一次体检结果做加压分析，输出到独立的「应力测试」tab
            try {
                const stressData = global.Stress ? Stress.build({ access: access, gap: gapResult }) : null;
                if (global.Stress) Stress.renderTo('reportStress', stressData);
                const stTab = document.getElementById('tabStress');
                if (stTab) stTab.disabled = !(stressData && stressData.ok);
                const addrTag = document.getElementById('reportAddr');
                if (addrTag) addrTag.dataset.stress = addr + ' · 生活圈应力测试';
            } catch (se) { console.warn('应力测试渲染失败（不影响主流程）', se); }

            // 6.3 步行阻抗场：左侧面板摘要 + 地图图层按钮状态
            try {
                if (global.Stress) {
                    Stress.renderSummary('impedanceBody', gapResult);
                    const hasField = !!(gapResult && gapResult.lambdaField && gapResult.lambdaField.range);
                    const impBtn = document.getElementById('btnImpedanceToggle');
                    // 新一次体检会替换整份结果，先收起旧图层，避免残留上一次的阻力分布
                    if (Stress._imp.visible) Stress.hideImpedanceLayer(map);
                    if (impBtn) {
                        impBtn.disabled = !hasField;
                        impBtn.classList.remove('active');
                        impBtn.textContent = '显示阻抗场';
                    }
                }
            } catch (ie) { console.warn('阻抗场面板渲染失败（不影响主流程）', ie); }

            // 6.4 刷新「分析图层」图例（服务盲区点位 / 推荐选址 / 步行阻抗场），与配套设施共用一列
            renderLayerLegend(gapResult);

            // 6.1 体检快照由构建期脚本 gen-report-from-snapshot.js 读取仓库内置 sample-community.json 生成报告（运行时不再捕获）

            // 热力图数据准备
            Heatmap.setData(POI.collectHeatmapData(resultByKeyActive, currentSamples));

            // 6.1 若开启了「展示各人员步行区域」，按当前人群重绘其他人员的真实路网等时圈
            await refreshSpeedComparison();

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
            // 6.5 缓存完整在线体检结果，供「导出快照」生成离线示例数据
            //     （含无障碍维度 / 各人群评分 / λ 空间场，落盘时再剥离 _ 前缀的内部字段）
            try {
                global.__liveSnapshot = {
                    center: { lng: center.lng, lat: center.lat, address: addr },
                    samples: currentSamples.map(p => ({ lng: p.lng, lat: p.lat })),
                    resultByKey: resultByKeyActive,
                    gapResult: gapResult,
                    recommend: recommend,   // 选址推荐结果（含站点经纬度，轻量可直接落盘；离线优先用此，避免重算依赖的内部栅格）
                    accessibility: access,
                    perType: perType,
                    score: score,
                    missedCategories: missedCategories,
                    breakdown: breakdown,
                    meta: { address: addr, exportedAt: new Date().toISOString() }
                };
            } catch (se) { console.warn('快照缓存失败（不影响主流程）', se); }
        } catch (e) {
            console.error('[体检] 步骤 3-7 异常:', e);
            toast('体检基本完成，部分功能异常：' + (e.message || e));
        }

        showLoader(false);
        Util.logGroup('体检完成', { center, score, poCount: Object.values(resultByKey).reduce((s, c) => s + c.items.length, 0) });
    }

    /**
     * 加载内置离线示例数据（北京·望京），无需联网即可展示完整体检效果。
     * 数据以内联 JS 形式暴露为 window.__OFFLINE_SAMPLE__（见 data/sample-community.js），
     * 既支持 file:// 本地直接打开，也支持 Pages 部署；无需 fetch，规避 CORS。
     * 既可由「演示数据」按钮手动触发，也作为在线服务不可用时的自动回退（保证页面永不空白）。
     *
     * 离线数据可由「导出快照」按钮从一次完整的在线体检生成（含无障碍维度 / 各人群评分 / λ 空间场 / 选址推荐），
     * 导出后替换 data/sample-community.js 中的 window.__OFFLINE_SAMPLE__ 即可获得与在线一致的完整体验；
     * 若快照中缺失上述深度字段，则对应模块自动降级显示，不影响主流程。
     */
    async function loadOfflineDemo() {
        showLoader(true, '加载离线示例数据...');
        const snap = window.__OFFLINE_SAMPLE__;
        if (!snap || !snap.center || !snap.samples || !snap.resultByKey) {
            showLoader(false);
            toast('离线示例数据未找到：请先在线体检一次，再用「导出快照」生成 data/sample-community.js');
            return;
        }
        try {
            _exitCompareModeUI();
            analysisSuspended = false;   // 单地址视图，清掉对比残留标记

            const center = new BMapGL.Point(snap.center.lng, snap.center.lat);
            currentCenter = center;
            map.centerAndZoom(center, 16);

            // 等时圈主圈 + 中心点（snapshot.samples 即主人群边界采样点，无需截断）
            clearCompareOverlays(true);
            const ir = Isochrone.render(map, snap.samples, center);
            currentSamples = snap.samples.map(p => ({ lng: p.lng, lat: p.lat }));

            Dashboard.exitCompare();
            restoreRecMarkers();
            Dashboard.setArea(ir.area);
            Dashboard.setCenter(snap.center.address || '示例社区');
            updateHudPath(snap.samples.length);

            // POI 检索边界用主圈；主评分 / 盲区 / 报告按主圈裁剪
            const activePts = currentSamples.map(p => ({ lng: p.lng, lat: p.lat }));
            POI.render(map, snap.resultByKey, ir.polygon);
            const resultByKeyActive = Util.filterByPolygon(snap.resultByKey, activePts);

            const { score, missedCategories, breakdown } = Dashboard.calcScore(resultByKeyActive, ir.area, snap.center);
            Dashboard.renderPerType(snap.perType || null);   // 离线有细分数据时直接渲染，否则清空占位
            Dashboard.renderPoiCount(resultByKeyActive);
            Dashboard.renderCharts(resultByKeyActive);
            Dashboard.setScore(score, Util.scoreLevel(score).text);
            Dashboard.renderGap(snap.gapResult);

            // 无障碍可达性：离线有实测时渲染，否则清空占位
            Dashboard.renderAccessibility(snap.accessibility || null);

            // 选址推荐：优先用快照中已导出的推荐结果（站点经纬度，轻量可直接落盘，无需依赖内部栅格）；
            // 旧版快照若缺该字段，退回由 gapResult 实时重算（依赖 _grid/_walk/_isGap 内部字段，缺失则不生成）
            let recommend = snap.recommend || null;
            if (!recommend) {
                try {
                    if (global.RECOMMEND && global.RECOMMEND.enabled !== false) {
                        recommend = Recommend.compute(snap.gapResult, {});
                    }
                } catch (re) { console.warn('离线选址推荐计算失败', re); recommend = null; }
            }
            Dashboard.renderRecommend(recommend);
            global.__lastRecommend = recommend;
            global.__recActive = false;
            const recBtn = document.getElementById('btnRecToggle');
            const hasRecSites = !!(recommend && recommend.ok && recommend.perCategory.some(c => c.sites && c.sites.length));
            if (hasRecSites) {
                if (global.RECOMMEND && global.RECOMMEND.autoShow) {
                    Recommend.renderMarkers(map, recommend);
                    global.__recActive = true;
                    if (recBtn) { recBtn.disabled = false; recBtn.classList.add('active'); recBtn.textContent = '隐藏标注'; }
                } else if (recBtn) { recBtn.disabled = false; recBtn.textContent = '标注选址'; }
            } else if (recBtn) {
                recBtn.disabled = true; recBtn.classList.remove('active'); recBtn.textContent = '标注选址';
            }

            // 盲区点位默认上图
            const gapBtn = document.getElementById('btnGapToggle');
            const hasGap = !!(snap.gapResult && snap.gapResult.enabled && snap.gapResult.gapCount > 0);
            if (hasGap) {
                GapFinder.render(map, snap.gapResult);
                if (gapBtn) { gapBtn.classList.add('active'); gapBtn.textContent = '隐藏点位'; gapBtn.disabled = false; }
            } else if (gapBtn) {
                if (global.GapFinder && GapFinder.visible) GapFinder.clear(map);
                gapBtn.classList.remove('active');
                gapBtn.textContent = '显示点位';
                gapBtn.disabled = true;
            }

            // 报告（perType / accessibility 离线时若快照含则一并渲染）
            Report.build(snap.center, resultByKeyActive, ir.area, score, missedCategories, breakdown, snap.gapResult, snap.perType || null, snap.accessibility || null, recommend);

            // 应力测试：离线若 gapResult 含 λ 空间场则完整呈现，否则仅阻抗图层降级
            try {
                const stressData = global.Stress ? Stress.build({ access: snap.accessibility || null, gap: snap.gapResult }) : null;
                if (global.Stress) Stress.renderTo('reportStress', stressData);
                const stTab = document.getElementById('tabStress');
                if (stTab) stTab.disabled = !(stressData && stressData.ok);
                const addrTag = document.getElementById('reportAddr');
                if (addrTag) addrTag.dataset.stress = (snap.center.address || '示例社区') + ' · 生活圈应力测试';
            } catch (se) { console.warn('离线应力测试渲染失败', se); }

            // 步行阻抗场摘要：依据快照是否含 λ 空间场决定图层按钮可用性
            try {
                if (global.Stress) {
                    Stress.renderSummary('impedanceBody', snap.gapResult);
                    const hasField = !!(snap.gapResult && snap.gapResult.lambdaField && snap.gapResult.lambdaField.range);
                    const impBtn = document.getElementById('btnImpedanceToggle');
                    if (Stress._imp.visible) Stress.hideImpedanceLayer(map);
                    if (impBtn) {
                        impBtn.disabled = !hasField;
                        impBtn.classList.remove('active');
                        impBtn.textContent = '显示阻抗场';
                    }
                }
            } catch (ie) { console.warn('离线阻抗场面板渲染失败', ie); }

            renderLayerLegend(snap.gapResult);

            // 热力图数据准备
            Heatmap.setData(POI.collectHeatmapData(resultByKeyActive, currentSamples));

            // 速度对比缓存置空，避免「展示各人员步行区域」误触发
            speedCmpPaths = null;
            speedCmpSig = null;

            showLoader(false);
            const offlineAddr = (snap.meta && snap.meta.address) ? snap.meta.address : (snap.center.address || '北京·望京');
            toast('已加载离线示例数据：' + offlineAddr);
        } catch (e) {
            console.error('[离线演示] 渲染异常:', e);
            showLoader(false);
            toast('离线示例渲染异常：' + (e.message || e));
        }
    }

    /**
     * 将当前在线体检结果导出为 JSON（下载 / 剪贴板回退），
     * 用户可将其替换进 data/sample-community.js 的 window.__OFFLINE_SAMPLE__，
     * 从而得到一份含无障碍维度 / 各人群评分 / λ 空间场的完整体检示例。
     */
    function exportSnapshot() {
        const snap = global.__liveSnapshot;
        if (!snap || !snap.center || !snap.samples) {
            toast('暂无可导出的体检数据：请先在线完成一次体检');
            return;
        }
        // 剥离 _ 前缀的内部字段（非序列化的大对象 / 潜在循环引用），只保留可安全落盘的轻量字段
        const clean = function (obj) {
            if (Array.isArray(obj)) return obj.map(clean);
            if (obj && typeof obj === 'object') {
                const out = {};
                for (const k in obj) {
                    if (Object.prototype.hasOwnProperty.call(obj, k) && k.charAt(0) !== '_') out[k] = clean(obj[k]);
                }
                return out;
            }
            return obj;
        };
        const text = JSON.stringify(clean(snap), null, 2);
        try {
            const blob = new Blob([text], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'sample-community.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            toast('已导出快照（含无障碍 / 各人群 / λ 空间场）：sample-community.json');
        } catch (e) {
            // file:// 下 Blob 下载可能被限制，回退为复制到剪贴板
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text);
                toast('已复制快照 JSON 到剪贴板（当前环境不支持文件下载）');
            } catch (e2) {
                toast('导出失败：' + (e.message || e));
            }
        }
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

    /**
     * 统一切换报告区 tab（single / compare / stress）
     *
     * ⚠ 三块面板必须严格互斥。此前点击 tab 与「对比模式」各自维护显隐，
     *   对比模式只关掉 single/compare，应力测试面板就会和对比报告同时显示。
     *   所有切换入口统一走本函数，避免再出现两份状态。
     * @param {string} which 'single' | 'compare' | 'stress'
     */
    function switchReportTab(which) {
        const panels = { single: 'reportSingle', compare: 'reportCompare', stress: 'reportStress' };
        Object.keys(panels).forEach(k => {
            const el = document.getElementById(panels[k]);
            if (el) el.hidden = (k !== which);
        });
        document.querySelectorAll('.report-tabs .tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === which);
        });
        const card = document.querySelector('.report-card');
        if (card) card.classList.toggle('has-compare', which === 'compare');
        syncReportHeader(which);
    }
    // 供对比模块等其他脚本复用同一份切换逻辑
    global.switchReportTab = switchReportTab;

    /**
     * 根据当前报告 tab 同步卡片头部 #reportAddr 标题
     * @param {string} which 'single' | 'compare' | 'stress'；不传则取当前 active tab
     */
    function syncReportHeader(which) {
        const addrTag = document.getElementById('reportAddr');
        if (!addrTag) return;
        if (!which) {
            const activeTab = document.querySelector('.report-tabs .tab.active');
            which = activeTab && activeTab.dataset.tab || 'single';
        }
        if (which === 'stress') {
            addrTag.textContent = addrTag.dataset.stress || '生活圈应力测试';
        } else if (which === 'compare') {
            addrTag.textContent = addrTag.dataset.compare || '对比报告';
        } else {
            addrTag.textContent = addrTag.dataset.single || '尚未体检';
        }
    }

    /** 当前激活的报告面板（单地址 / 对比 / 应力测试） */
    function getActiveReportInfo() {
        const activeTab = document.querySelector('.report-tabs .tab.active');
        if (activeTab && activeTab.dataset.tab === 'stress') {
            return { el: document.getElementById('reportStress'), subtitle: '生活圈应力测试', isCompare: false };
        }
        if (activeTab && activeTab.dataset.tab === 'compare') {
            const c = global.Compare;
            let subtitle = '对比报告';
            if (c && c.results && c.results[0] && c.results[1]) {
                subtitle = `对比报告：${c.results[0].addr} vs ${c.results[1].addr}`;
            }
            return { el: document.getElementById('reportCompare'), subtitle, isCompare: true };
        }
        return { el: document.getElementById('reportSingle'), subtitle: document.getElementById('reportAddr').textContent, isCompare: false };
    }

    /** 复制报告 */
    async function copyReport() {
        const { el, subtitle } = getActiveReportInfo();
        if (!el || el.textContent.trim().length === 0 || (subtitle && subtitle.includes('尚未体检'))) {
            toast('暂无可复制的内容');
            return;
        }
        const text = el.innerText;
        try {
            await navigator.clipboard.writeText(text);
            toast('报告内容已复制到剪贴板');
        } catch (e) {
            toast('复制失败：浏览器不支持');
        }
    }

    function printReport() {
        const { el, subtitle } = getActiveReportInfo();
        if (!el || el.innerHTML.trim().length === 0 || (subtitle && subtitle.includes('尚未体检'))) {
            toast('暂无可打印的内容');
            return;
        }
        const content = el.innerHTML;
        const addr = subtitle;
        const w = window.open('', '_blank');
        if (!w) { toast('请允许弹窗以打印报告'); return; }
        // 复用 export.js 的 buildPrintDoc，保证「打印窗口」与「导出图片 / PDF」视觉完全一致
        let docHtml;
        if (global.ExportReport && typeof global.ExportReport.buildPrintDoc === 'function') {
            docHtml = global.ExportReport.buildPrintDoc(addr, content)
                .replace('</body>', '<script>window.onload=function(){window.print();}</script></body>');
        } else {
            // 兜底（极少见：export.js 未加载），保留早期基础样式
            docHtml = '<html><head><meta charset="UTF-8"><title>' + addr + ' · 体检报告</title>'
                + '<style>body{font-family:"PingFang SC","Microsoft Yahei",sans-serif;color:#0a1429;padding:40px;line-height:1.8;}'
                + 'h1{margin:0 0 8px;}.meta{color:#666;font-size:13px;margin-bottom:24px;}'
                + 'h4{border-left:4px solid #3a7afe;padding-left:10px;margin-top:24px;}ul,ol{padding-left:22px;}</style></head><body>'
                + '<h1>' + (global.WALK_MINUTES || 15) + ' 分钟便民生活圈体检报告</h1>'
                + '<p class="meta">' + addr + '</p>' + content
                + '<script>window.onload=function(){window.print();}</script></body></html>';
        }
        w.document.write(docHtml);
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
                <p class="muted">系统会基于<strong>真实步行路网</strong>绘制 ${global.WALK_MINUTES || 15} 分钟可达圈，统计六类民生配套并识别<strong>服务盲区</strong>。</p>
            </div>`;
        // 应力测试面板：重置内容与 tab 可用性（root 隐藏由 tab 切换逻辑负责）
        const stressPanel = document.getElementById('reportStress');
        if (stressPanel) stressPanel.innerHTML = '';
        const stTab = document.getElementById('tabStress');
        if (stTab) { stTab.disabled = true; stTab.classList.remove('active'); }
        // 应力测试：清掉面板内容、阻抗场图层与其摘要
        if (global.Stress) {
            Stress.hideImpedanceLayer(map);
            Stress.lastResult = null;
        }
        const impBtn = document.getElementById('btnImpedanceToggle');
        if (impBtn) {
            impBtn.disabled = true;
            impBtn.classList.remove('active');
            impBtn.textContent = '显示阻抗场';
        }
        const impBody = document.getElementById('impedanceBody');
        if (impBody) {
            impBody.innerHTML = '<p class="gap-empty muted">完成体检后自动生成：'
                + '按实测的「直线 vs 步行」样本重建空间变异绕行系数，并在地图上叠加阻力图层。</p>';
        }
        const addrTag = document.getElementById('reportAddr');
        if (addrTag) {
            addrTag.textContent = '尚未体检';
            delete addrTag.dataset.single;
            delete addrTag.dataset.compare;
        }
        Dashboard.exitCompare();          // 若正处于对比看板视图，先还原单地址 DOM
        suspendRecMarkers();              // 关闭对比时清掉推荐标注，避免空看板残留地图桩
        _exitCompareModeUI();             // 收起地址 B 行 + 报告 tab 切回「单地址体检报告」
        if (global.Compare) global.Compare.clear();   // 重置：对比结果一并清空
        analysisSuspended = false;                    // 对比残留的「图层已撤下」标记一并清除
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
        renderLayerLegend();   // 刷新图例高亮态
    }

    /** 步行阻抗场图层显隐切换：在地图上叠加"哪里路难走"的阻力分布 */
    function toggleImpedance() {
        const btn = document.getElementById('btnImpedanceToggle');
        if (!global.Stress || !global.GapFinder || !GapFinder.lastResult) {
            if (btn) btn.disabled = true;
            return;
        }
        const shown = Stress._imp.visible;
        if (shown) {
            Stress.hideImpedanceLayer(map);
            if (btn) { btn.classList.remove('active'); btn.textContent = '显示阻抗场'; }
        } else {
            const ok = Stress.showImpedanceLayer(map, GapFinder.lastResult);
            if (!ok) {
                toast('暂无阻抗场数据：本次体检未获得足够的真实路网观测');
                if (btn) btn.disabled = true;
                return;
            }
            if (btn) { btn.classList.add('active'); btn.textContent = '隐藏阻抗场'; }
        }
        renderLayerLegend();   // 刷新图例高亮态
    }

    /** 选址推荐标注开关：显示 / 隐藏地图上的「🏗️」推荐落点 */
    function toggleRec() {
        const btn = document.getElementById('btnRecToggle');
        if (!global.__lastRecommend || !global.__lastRecommend.ok
            || !global.__lastRecommend.perCategory.some(c => c.sites && c.sites.length)) {
            if (btn) { btn.disabled = true; btn.textContent = '标注选址'; }
            return;
        }
        if (global.__recActive) {
            Recommend.clearMarkers(map);
            global.__recActive = false;
            if (btn) { btn.classList.remove('active'); btn.textContent = '标注选址'; }
        } else {
            Recommend.renderMarkers(map, global.__lastRecommend);
            global.__recActive = true;
            if (btn) { btn.classList.add('active'); btn.textContent = '隐藏标注'; }
        }
        renderLayerLegend();   // 刷新图例高亮态
    }

    /**
     * 进入对比模式前：撤掉单地址视图下叠加的三个分析图层
     *   ① 服务盲区点位   ② 选址推荐标注   ③ 步行阻抗场
     *
     * 对比地图要同时画 A / B 两套等时圈 + POI，再叠这三层会糊成一团，
     * 因此在加载对比地图之前统一清除，并把三个开关复位为「关闭 + 禁用」。
     * 退出对比后由 resumeAnalysisLayers() 按当前体检数据的可用性重新放开开关。
     */
    function suspendAnalysisLayers() {
        // ① 服务盲区点位
        if (global.GapFinder && GapFinder.visible) {
            try { GapFinder.clear(map); } catch (e) { /* 忽略：未初始化时无图层可清 */ }
        }
        const gapBtn = document.getElementById('btnGapToggle');
        if (gapBtn) {
            gapBtn.classList.remove('active');
            gapBtn.textContent = '显示点位';
            gapBtn.disabled = true;
        }

        // ② 选址推荐标注（内部会清图 + 复位按钮 + 刷新图例）
        suspendRecMarkers();

        // ③ 步行阻抗场
        if (global.Stress && global.Stress._imp && global.Stress._imp.visible) {
            try { Stress.hideImpedanceLayer(map); } catch (e) { /* 忽略 */ }
        }
        const impBtn = document.getElementById('btnImpedanceToggle');
        if (impBtn) {
            impBtn.classList.remove('active');
            impBtn.textContent = '显示阻抗场';
            impBtn.disabled = true;
        }

        renderLayerLegend();   // 三层均已关闭，刷新图例勾选态
        analysisSuspended = true;
    }

    /**
     * 退出对比模式后：按当前体检数据的可用性恢复三个分析图层的开关
     * 只复位开关状态（图层保持关闭，需要时由用户自行点开），
     * 避免对比模式留下的「禁用」态一直挂着，也避免直接复原图层与 A/B 叠加。
     *
     * 仅在真正执行过 suspendAnalysisLayers() 时才生效——否则「只开合地址 B 栏、
     * 没有点开始对比」的场景会把单地址视图下已开启的图层开关误复位成关闭态。
     */
    function resumeAnalysisLayers() {
        if (!analysisSuspended) return;
        analysisSuspended = false;

        const gapResult = global.GapFinder && GapFinder.lastResult;
        const hasGap = !!(gapResult && gapResult.enabled && gapResult.gapCount > 0);
        const hasField = !!(gapResult && gapResult.lambdaField && gapResult.lambdaField.range);

        const gapBtn = document.getElementById('btnGapToggle');
        if (gapBtn) {
            gapBtn.disabled = !hasGap;
            gapBtn.classList.remove('active');
            gapBtn.textContent = '显示点位';
        }

        const impBtn = document.getElementById('btnImpedanceToggle');
        if (impBtn) {
            impBtn.disabled = !hasField;
            impBtn.classList.remove('active');
            impBtn.textContent = '显示阻抗场';
        }

        const rec = global.__lastRecommend;
        const hasRecSites = !!(rec && rec.ok && rec.perCategory.some(c => c.sites && c.sites.length));
        const recBtn = document.getElementById('btnRecToggle');
        if (recBtn) {
            recBtn.disabled = !hasRecSites;
            recBtn.classList.remove('active');
            recBtn.textContent = '标注选址';
        }
        global.__recActive = false;

        renderLayerLegend();   // 开关已复位，刷新图例勾选态
    }

    /** 进入对比模式前：清除单地址的推荐标注，并临时禁用开关（避免与 A/B 双圈叠加糊图） */
    function suspendRecMarkers() {
        Recommend.clearMarkers(map);
        global.__recActive = false;
        const btn = document.getElementById('btnRecToggle');
        if (btn) { btn.disabled = true; btn.classList.remove('active'); btn.textContent = '标注选址'; }
        renderLayerLegend();   // 推荐标注已清除，刷新图例高亮态
    }

    /** 退出对比模式后：若此前已开启，则恢复推荐标注（单地址视图） */
    function restoreRecMarkers() {
        const btn = document.getElementById('btnRecToggle');
        const rec = global.__lastRecommend;
        const hasSites = !!(rec && rec.ok && rec.perCategory.some(c => c.sites && c.sites.length));
        if (!hasSites) { if (btn) { btn.disabled = true; btn.textContent = '标注选址'; } return; }
        if (btn) btn.disabled = false;
        // 默认恢复显示（与体检完成后的 autoShow 行为一致）
        Recommend.renderMarkers(map, rec);
        global.__recActive = true;
        if (btn) { btn.classList.add('active'); btn.textContent = '隐藏标注'; }
        renderLayerLegend();   // 恢复推荐标注，刷新图例高亮态
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

    /** 百度地图 GL SDK 是否真正可用
     *
     *  ⚠ 这是「偶发 BMapGL.Map is not a constructor」的根因所在：
     *    百度是**两段式加载**——第一段引导脚本（api?type=webgl&v=3.0&callback=...）一执行
     *    就立刻 `window.BMapGL = window.BMapGL || {}`，建出一个**空壳命名空间**（此时里面
     *    只有 apiLoad，没有 Map / Point）；真正的 SDK 由它再注入的第二段 getscript
     *    （约 1.2MB）下载并执行完毕后，才把 BMapGL.Map 挂上去，最后回调 __bmapReady。
     *    所以「typeof BMapGL !== 'undefined'」为真 **不等于** SDK 可用，必须直接查构造器本身。
     */
    function bmapReady() {
        return typeof global.BMapGL !== 'undefined'
            && typeof global.BMapGL.Map === 'function'
            && typeof global.BMapGL.Point === 'function';
    }

    /** 带就绪守卫的 init 入口
     *  @returns {boolean} true = 已处理完毕（成功或已放弃重试）；false = SDK 未就绪，交给轮询继续等
     */
    function tryInit() {
        if (global.__inited) return true;
        if (!bmapReady()) return false;          // 空壳命名空间 / SDK 仍在下载 → 继续等
        try {
            init();
            return true;
        } catch (e) {
            // ⚠ 必须复位：init() 在 new BMapGL.Map 之前就已置位 __inited，
            //    不复位的话，SDK 稍后真正就绪时回调 init 会被幂等判断直接 return，
            //    导致地图 / 事件绑定 / 省市联动 / 图表全部不初始化，且刷新前无法自愈。
            global.__inited = false;
            // 已经就绪仍然失败，说明不是加载时序问题（多半是 DOM 缺失等），
            // 不再重试，避免重复 bindEvents 造成事件绑多遍。
            global.__initFailed = true;
            global.__diag && global.__diag('init failed: ' + (e.message || e), 'error');
            return true;
        }
    }

    /** 暴露给百度地图 API 回调：SDK 真正加载完成时触发（在线模式） */
    global.__bmapReady = tryInit;

    // 对比模式需要的可复用体检工具
    global.app = {
        runOneStandalone: (addr, onProgress) => runOneStandalone(addr, onProgress)
    };

    // 兜底：百度脚本是动态 async 注入的，可能在 app.js 之前就已执行完毕并调用了 callback，
    //       而当时 __bmapReady 还是 noop → init 永远不会被触发（race condition）。
    //       这里用「轮询等待 SDK 真正就绪 + 超时告警」替代原来的单次 50ms 定时器：
    //       50ms 在冷启动 / 慢网络下几乎必然落在第二段 getscript 的下载窗口内，
    //       正是该报错偶发出现的直接原因。
    (function waitBmapReady() {
        var deadline = Date.now() + 15000;
        (function poll() {
            if (global.__initFailed || tryInit()) return;
            if (Date.now() > deadline) {
                global.__diag && global.__diag(
                    '❌ 百度地图 SDK 15s 内未就绪：请检查网络 / AK 是否有效 / Referer 白名单是否含当前域名' +
                    '（注意 script.onerror 只覆盖第一段引导脚本，第二段 getscript 失败不会触发）',
                    'error');
                return;
            }
            setTimeout(poll, 100);
        })();
    })();
})(window);
