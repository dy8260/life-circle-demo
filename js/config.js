/**
 * 项目配置：百度地图 AK + 主题色 + 等时圈参数
 *
 * 浏览器端 AK 获取优先级（实现"源码不含真 key"的脱敏）：
 *   1) 本地开发：config.local.js（已被 .gitignore 忽略，不提交）设置 window.BMAP_AK_OVERRIDE
 *   2) 部署时：CI（GitHub Actions）把下方占位符注入为真实 key（存于仓库 Secret，不进源码）
 *   3) 兜底占位符（仅用于代码脱敏；此时地图无法加载，需配好 key 才可用）
 * 请在百度开放平台为浏览器端应用配置 Referer 白名单 = dy8260.github.io / localhost
 */
(function (global) {
    'use strict';

    // 浏览器端 AK（用户在百度地图开放平台创建的应用，「浏览器端」类型）
    // 本地用 config.local.js 覆盖；部署由 CI 注入；仓库源码只保留占位符
    var BMAP_AK_VALUE = (typeof global.BMAP_AK_OVERRIDE !== 'undefined' && global.BMAP_AK_OVERRIDE)
        ? global.BMAP_AK_OVERRIDE
        : '__BMAP_AK__';
    global.BMAP_AK = BMAP_AK_VALUE;

    // 主题色（深色大屏风格，玻璃拟态）
    global.THEME = {
        bg1: '#0a1429',
        bg2: '#0d1b3d',
        card: 'rgba(20,32,64,0.55)',
        border: 'rgba(120,180,255,0.18)',
        primary: '#3a7afe',
        primaryGlow: '#5b9bff',
        success: '#00d68f',
        warn:    '#ffb547',
        danger:  '#ff5470',
        text:    '#e6f0ff',
        textSub: '#8a9ec0'
    };

    // 等时圈参数（基准步行 80 m/min ≈ 1.33 m/s，符合 2021 住建部《完整居住社区建设标准》参考值）
    global.ISO = {
        sampleCount: 16,        // 采样方向数（每 22.5° 一个）
        walkSpeed: 80,          // 步行速度 m/min
        walkMinutes: 15,        // 目标时间
        farDistance: 1800,      // 每个方向的远点距离（米，覆盖 15min 并留冗余）
        routeConcurrency: 6     // 步行路径规划并发数（避免百度 QPS 限制；过大会被限流）
    };

    // 每类 POI 最多检索几个关键字（百度 LocalSearch 单 keyword 单返回，多关键字需合并去重）
    // 调大 → 召回更全，但 QPS 消耗线性上升；调小 → 省配额但可能漏检
    global.POI_KEYWORD_LIMIT = 3;

    // POI 检索相邻关键字的间隔（毫秒）。串行 + 间隔，保持温和的请求节奏。
    // 注：此前为规避"限频"调到 350，但实测证明「对比首点全 0」的真因是地图视口不在
    // 检索城市导致 region 解析错位（见 poi.js 的 _ensureMapAt），并非限频，故恢复 280。
    global.POI_SEARCH_GAP_MS = 280;

    // 某类已召回足够多点位（默认 60）时，跳过剩余同义词，省配额且不损覆盖。
    // 此前为 10，稀疏类别（单关键字仅召回个位数）会被过早截断，导致「配套设施数量少」的观感；
    // 上调到 60 让稀疏类别也能积累到更完整的覆盖（稠密类别由下方 POI_MAX_PAGES 分页补足）。
    global.POI_KEYWORD_STOP_AT = 60;

    // 单个关键字「真失败」（百度返回错误码或 onErr 回调）时的退避重试次数与间隔。
    // ⚠ 仅用于真失败；「干净返回 0 条」不再重试（此前误当限频重试，既无效又拖慢）。
    // 「对比首点全 0」的真因是地图视口/region 错位，已由 poi.js 的 _ensureMapAt 修复。
    global.POI_SEARCH_RETRY = 3;
    global.POI_SEARCH_RETRY_GAP_MS = 2000;

    // 百度 LocalSearch 单 keyword 单页最多返回 pageCapacity(50) 条且默认只取第一页，
    // 稠密区域（如商圈便利店 / 公交站）远超 50 条会被静默截断，是「配套设施数量少」的主因。
    // 开启分页：单关键字最多向后翻 POI_MAX_PAGES 页累积（2 页 → 单类最多约 100 条），显著提升召回。
    // 设为 1 即关闭分页（仅取第一页，回到原来的低配额行为）；调大召回更全但 AK 配额 / QPS 消耗线性上升。
    global.POI_MAX_PAGES = 2;

    // 页面加载是否自动跑一次「单地址」体检（默认 true：用户要求一进来就自动加载单地址）。
    // ⚠ 仅自动跑单地址；对比模式始终由「开始对比」按钮手动触发，不会在加载时自动跑。
    // 若自动体检为空，优先排查「地图视口是否在检索城市」（见 poi.js 的 _ensureMapAt 注释）。
    global.AUTO_RUN = true;

    // POI 分类配置（6 类）
    //
    // ⚠ 为什么把「菜市场」从「商超」里拆出来？
    //   「15 分钟社区生活圈」配套标准对服务盲区的判定口径是【菜市场 / 药店 / 小学】；
    //   实际检索关键词扩展为小学/幼儿园/中学以提升召回，UI 统一简称为「学校」。
    //   若把超市、便利店并入菜市场，则「1 公里内只有一家便利店」会被误判为「有菜市场」，
    //   与配套标准口径不符。故拆为独立两类，保证盲区判定语义严格。
    //
    // ⚠ 关键字顺序有语义：越靠前越优先被检索（受 POI_KEYWORD_LIMIT 截断）。
    //   「15 分钟生活圈」配套标准口径关注的三类关键字（菜市场 / 药店 / 小学/学校）必须排在各自分类首位。
    global.POI_CATEGORIES = [
        { key: 'hospital', name: '医院',   color: '#ff5470', icon: '🏥', keywords: ['综合医院', '医院', '社区卫生服务中心'] },
        { key: 'pharmacy', name: '药店',   color: '#ffa726', icon: '💊', keywords: ['药店', '药房'] },
        { key: 'market',   name: '菜市场', color: '#00d68f', icon: '🥬', keywords: ['菜市场', '农贸市场', '菜店'] },
        { key: 'store',    name: '商超',   color: '#26c6da', icon: '🛒', keywords: ['超市', '便利店'] },
        { key: 'school',   name: '学校',   color: '#42a5f5', icon: '🎓', keywords: ['小学', '幼儿园', '中学'] },
        { key: 'bus',      name: '公交站', color: '#ab47bc', icon: '🚌', keywords: ['公交站', '地铁站'] }
    ];

    // POI 缺失阈值（用于体检报告与评分，参考住建部《完整居住社区建设标准》/上海《15 分钟社区生活圈规划导则》）
    // min = 最低门槛，ideal = 理想值，weight = 评分权重（六类权重之和 = 1.00）
    global.POI_THRESHOLD = {
        hospital: { min: 1, ideal: 3, weight: 0.22 },
        pharmacy: { min: 2, ideal: 5, weight: 0.13 },
        market:   { min: 1, ideal: 2, weight: 0.15 },
        store:    { min: 2, ideal: 5, weight: 0.15 },
        school:   { min: 1, ideal: 3, weight: 0.20 },
        bus:      { min: 1, ideal: 3, weight: 0.15 }
    };

    // ============================================================
    // 无障碍可达性达标率（最近设施实测 × GB 50180-2018）
    //
    // 与「配套数量」统计的本质区别：数量只数"圈内有多少个"；本指标改为对居住采样点
    // 逐个测算"沿真实步行路网走到最近一处该类设施要多久"，再拿该耗时与国家标准
    // 《城市居住区规划设计标准》(GB 50180-2018) 的服务半径（折算为步行分钟）比对，
    // 得到「步行达标率 / 轮椅达标率」。轮椅人群按低速重算，是其独有维度。
    //
    // ⚠ stdRadius（服务半径，米）取自 GB 50180-2018「十五分钟生活圈」配套要求，
    //   折算步行分钟 = radius / 80（参考步行速度 80 m/min）。比对时用真实步行/轮椅速度，
    //   故标准本身恒定、达标与否取决于行动能力。实际应用前请核对标准原文数值。
    global.ACCESS_CATEGORIES = [
        { key: 'market',   name: '菜市场', icon: '🥬', stdRadius: 500 },
        { key: 'pharmacy', name: '药店',   icon: '💊', stdRadius: 500 },
        { key: 'school',   name: '学校',   icon: '🎓', stdRadius: 500 },
        { key: 'hospital', name: '医院',   icon: '🏥', stdRadius: 1000 },
        { key: 'bus',      name: '公交站', icon: '🚌', stdRadius: 500 }
    ];
    global.ACCESS = {
        enabled: true,     // 关闭则跳过最近设施实测（省配额 / 演示保底）
        sampleMax: 10,     // 居住采样点上限（× 类别数 = 真实路网路径规划调用次数；调小省配额）
        gridStep: 0,       // 0 = 按包围盒与 sampleMax 自动反推步长
        concurrency: 3,    // 真实路网路径规划并发数（控制 QPS）
        timeoutMs: 5000    // 单次标定超时（失败回落到直线 × 绕行系数 λ 兜底）
    };

    // ============================================================
    // 选址推荐（补点建议）—— 针对盲区，推荐在哪里新建某类设施最能消除盲区
    //
    // 采用最大覆盖选址（Maximal Coverage）的贪心解：把盲区栅格点当需求点，
    // 在每个盲区相关类别（菜市场 / 药店 / 学校）中贪心选取 topK 落点，
    // 使"以国标盲区半径 R 内能覆盖的盲区点最多"（按严重度加权）。
    // 纯直线距离计算，不调用 WalkingRoute → 零配额、秒级。
    global.RECOMMEND = {
        enabled: true,   // 关闭则跳过补点建议
        topK: 3,         // 每个类别最多推荐的落点数
        maxDemand: 300,  // 每个类别纳入计算的"未覆盖需求点"上限（栅格过多时按步长抽样，控计算量）
        autoShow: true   // 体检完成后自动在地图上标注推荐落点（用户可用「标注选址」按钮隐藏）
    };

    /**
     * 服务盲区识别参数
     *
     * 判定口径严格对齐「15 分钟社区生活圈」配套标准原文：
     *   「系统能否准确识别出周边 1 公里内没有菜市场、药店或小学的『服务盲区』点位」
     * 即：某点到【菜市场、药店、学校】三类的最近距离**全部** > radiusMeters 时，判为盲区点位。
     * 注：配套标准原文为“小学”；实际检索关键词扩展为小学/幼儿园/中学以提升召回，
     *     UI 统一简称为“学校”。
     */
    global.BLIND_GAP = {
        radiusMeters: 1000,      // 盲区判定半径（米），随 WALK_MINUTES 缩放（15min→1000≈配套标准「周边 1 公里」）
        radiusManual: false,     // 用户在「生活圈设置」里手动设过判定半径 → recalcDerived 不再随时长覆盖它
        severeManual: false,     // 同上，重度阈值手动覆盖标志
        checkKeys: ['market', 'pharmacy', 'school'],  // 参与判定的三类：菜市场 / 药店 / 学校（标准原文为小学）

        gridStepMeters: 120,     // 栅格采样间距（米）。越小越精确，点位数按平方增长
        severeMeters: 1500,      // 重度盲区分级阈值：三类最近距离均 > 此值；随 WALK_MINUTES 缩放（15min→1500）

        // 路网绕行系数 λ = 真实步行距离 / 直线距离
        // 直线距离会低估实际步行路程（绕行、过街、封闭小区），需乘以 λ 校正
        lambdaDefault: 1.25,     // 标定失败时的经验兜底值
        lambdaMin: 1.00,         // 下界（不可能比直线还短）
        lambdaMax: 1.80,         // 上界（过大说明路网异常，钳制防失真）
        calibAnchors: 6,         // 标定锚点数量（每个锚点 1 次 WalkingRoute，并发执行）
        calibConcurrency: 3,     // 标定并发数（控制 QPS）
        calibTimeoutMs: 6000,    // 单次标定超时
        calibMinStraightMeters: 200,  // 直线距离短于此值的锚点对不参与标定（噪声大）

        topPatches: 3,           // 输出 Top N 个连片盲区斑块（用于规划建议）
        maxRenderPoints: 1200    // 地图最多渲染的盲区点数（超限抽样，保性能）
    };

    // 国内主要城市清单（覆盖：4 直辖市 + 27 省会 + 自治区首府 + 计划单列市 + 重点旅游城市）
    // 1) 用于城市输入框 datalist 自动补全
    // 2) 与 js/time-weather.js 中的 CITY_COORDS 一一对应，支持任意键入即时匹配
    global.CITY_LIST = [
        // 直辖市
        '北京市', '上海市', '天津市', '重庆市',
        // 省会 / 自治区首府
        '石家庄', '太原', '呼和浩特', '沈阳', '长春', '哈尔滨',
        '南京', '杭州', '合肥', '福州', '南昌', '济南',
        '郑州', '武汉', '长沙', '广州', '南宁', '海口',
        '成都', '贵阳', '昆明', '拉萨', '兰州', '西宁',
        '银川', '乌鲁木齐',
        // 计划单列市 / 副省级
        '深圳', '宁波', '厦门', '青岛', '大连',
        // 重点城市
        '苏州', '无锡', '常州', '南通', '扬州', '镇江', '盐城', '徐州', '连云港',
        '温州', '绍兴', '嘉兴', '金华', '台州', '舟山',
        '芜湖', '泉州', '漳州',
        '烟台', '潍坊', '淄博', '威海', '临沂', '济宁',
        '洛阳', '开封', '宜昌', '襄阳',
        '株洲', '湘潭', '岳阳', '衡阳',
        '珠海', '汕头', '佛山', '东莞', '中山', '惠州', '江门', '湛江',
        '柳州', '桂林',
        '三亚', '北海',
        '绵阳', '德阳', '南充', '宜宾', '达州',
        '遵义', '大理', '丽江', '西双版纳',
        '敦煌', '喀什', '吐鲁番', '香格里拉', '日喀则',
        '延安', '榆林', '宝鸡', '咸阳', '天水', '石嘴山',
        '克拉玛依', '库尔勒',
        '香港', '澳门', '台北'
    ];

    /**
     * 省 / 市 / 区 三级联动数据已迁移到 js/region-data.js
     * （全国 31 省级 / 342 地级市 / 3056 区·县，离线内嵌、自动生成，请勿在此内联）
     */

    // ============================================================
    // 运行期可调：「生活圈步行时长」与「各类人员步行速度」共同决定可达圈规模
    //   reachable(类) = type.speed(m/min) × walkMinutes(min)
    // 改任一项都要联动更新「等时圈远点距离」与「盲区判定阈值」，保证「X 分钟生活圈」自洽。
    // 锚定 15 分钟 × 成年人(80m/min) 时与原始写死值完全一致（farDistance=1800 / radiusMeters=1000 / severeMeters=1500）。
    // 用户在顶部选择后由 app.js 调 applyWalkMinutes / setActiveType / setTypeSpeed 生效；
    // gap.js 的 _cfg() 每次运行实时读 global.BLIND_GAP，isochrone.js 实时读 ISO.*，故无需各自改代码。
    global.WALK_MINUTES = global.ISO.walkMinutes;   // 初始 15

    // 各类人员步行速度（m/min）+ 展示色：可在左侧面板逐类修改；主分析人群 = ACTIVE_TYPE
    //   （地图真实等时圈 / POI / 盲区 / 评分均按「主分析人群」的速度计算；其余人群仅在勾选后画彩色可达圈）
    global.WALK_TYPES = [
        { key: 'adult',  label: '成年人', speed: 80,  color: '#5a9bff' },  // ≈4.8 km/h，住建标准步行速度
        { key: 'youth',  label: '青年人', speed: 100, color: '#00d68f' },  // ≈6.0 km/h，快走
        { key: 'elder',  label: '老年人', speed: 50,  color: '#ffb547' },  // ≈3.0 km/h
        { key: 'child',  label: '儿童',   speed: 60,  color: '#ab47bc' },  // ≈3.6 km/h
        { key: 'wheel',  label: '轮椅',   speed: 40,  color: '#ff5470' }   // ≈2.4 km/h，无障碍
    ];
    global.ACTIVE_TYPE = 'adult';   // 当前主分析人群

    function activeSpeed() {
        const t = (global.WALK_TYPES || []).find(x => x.key === global.ACTIVE_TYPE);
        return t ? t.speed : (global.ISO.walkSpeed || 80);
    }
    global.getActiveSpeed = activeSpeed;   // 供 app.js 读取主人群速度（各人群评分近似用）

    // 共用：用当前「时长 + 主分析人群速度」重算派生量（等时圈远点距离 / 盲区阈值）
    function recalcDerived() {
        const m = global.WALK_MINUTES, v = activeSpeed();
        global.ISO.walkSpeed         = v;
        global.ISO.farDistance       = Math.round(v * m * 1.5);                       // 15×80→1800
        // 盲区半径/重度阈值：仅当用户未在「生活圈设置」里手动覆盖时才随时长缩放
        if (!global.BLIND_GAP.radiusManual) {
            global.BLIND_GAP.radiusMeters = Math.round(v * m * 5 / 6);                 // 15×80→1000
        }
        if (!global.BLIND_GAP.severeManual) {
            global.BLIND_GAP.severeMeters = Math.round(global.BLIND_GAP.radiusMeters * 1.5); // 15×80→1500
        }
    }

    // 应用「生活圈设置」弹窗里的盲区配置（半径 / 重度阈值 / 采样间距 / 判定设施），并置手动覆盖标志
    // 一旦手动设过判定半径或重度阈值，recalcDerived 就不再用时长覆盖它，实现「自定义盲区口径」
    global.setBlindGap = function (cfg) {
        if (!cfg) return;
        if (cfg.radius != null) {
            global.BLIND_GAP.radiusMeters = Math.max(50, Math.min(5000, Math.round(Number(cfg.radius) || 1000)));
            global.BLIND_GAP.radiusManual = true;
        }
        if (cfg.severe != null) {
            global.BLIND_GAP.severeMeters = Math.max(50, Math.min(8000, Math.round(Number(cfg.severe) || 1500)));
            global.BLIND_GAP.severeManual = true;
        }
        if (cfg.grid != null) {
            global.BLIND_GAP.gridStepMeters = Math.max(20, Math.min(500, Math.round(Number(cfg.grid) || 120)));
        }
        if (Array.isArray(cfg.keys)) {
            global.BLIND_GAP.checkKeys = cfg.keys;
        }
    };

    // 恢复盲区默认：清除手动覆盖，重新随生活圈时长缩放（与配套标准「周边 1 公里」锚定）
    global.resetBlindGap = function () {
        global.BLIND_GAP.radiusManual = false;
        global.BLIND_GAP.severeManual = false;
        recalcDerived();   // 立即按当前时长把半径/重度重算回标准值
    };

    global.applyWalkMinutes = function (m) {
        m = Math.max(1, Math.min(120, Math.round(Number(m) || 15)));
        global.ISO.walkMinutes = m;
        global.WALK_MINUTES = m;
        recalcDerived();
    };
    // 切换主分析人群（影响地图真实等时圈 / 评分；由 app.js 决定是否重跑全链路）
    global.setActiveType = function (key) {
        if (!(global.WALK_TYPES || []).some(x => x.key === key)) return;
        global.ACTIVE_TYPE = key;
        recalcDerived();
    };
    // 修改某一类人员的步行速度（仅当该类为主分析人群时才影响等时圈/评分/盲区）
    global.setTypeSpeed = function (key, v) {
        const t = (global.WALK_TYPES || []).find(x => x.key === key);
        if (!t) return;
        v = Math.max(20, Math.min(160, Math.round(Number(v) || t.speed)));
        t.speed = v;
        if (key === global.ACTIVE_TYPE) recalcDerived();
    };
    // 向后兼容：旧调用等价于「修改主分析人群的速度」
    global.applyWalkSpeed = function (v) { global.setTypeSpeed(global.ACTIVE_TYPE, v); };
    // 初始化派生值（15min × 成年人 时与原始写死值一致）
    recalcDerived();

})(window);
