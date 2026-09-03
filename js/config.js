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

    // 某类已召回足够多点位（默认 10）时，跳过剩余同义词，省配额且不损覆盖
    global.POI_KEYWORD_STOP_AT = 10;

    // 单个关键字「真失败」（百度返回错误码或 onErr 回调）时的退避重试次数与间隔。
    // ⚠ 仅用于真失败；「干净返回 0 条」不再重试（此前误当限频重试，既无效又拖慢）。
    // 「对比首点全 0」的真因是地图视口/region 错位，已由 poi.js 的 _ensureMapAt 修复。
    global.POI_SEARCH_RETRY = 3;
    global.POI_SEARCH_RETRY_GAP_MS = 2000;

    // 页面加载是否自动跑一次「单地址」体检（默认 true：用户要求一进来就自动加载单地址）。
    // ⚠ 仅自动跑单地址；对比模式始终由「开始对比」按钮手动触发，不会在加载时自动跑。
    // 若自动体检为空，优先排查「地图视口是否在检索城市」（见 poi.js 的 _ensureMapAt 注释）。
    global.AUTO_RUN = true;

    // POI 分类配置（6 类）
    //
    // ⚠ 为什么把「菜市场」从「商超」里拆出来？
    //   赛题任务书对服务盲区的判定口径是【菜市场 / 药店 / 小学】。
    //   若把超市、便利店并入菜市场，则「1 公里内只有一家便利店」会被误判为「有菜市场」，
    //   与任务书口径不符。故拆为独立两类，保证盲区判定语义严格。
    //
    // ⚠ 关键字顺序有语义：越靠前越优先被检索（受 POI_KEYWORD_LIMIT 截断）。
    //   任务书点名的三类关键字（菜市场 / 药店 / 小学）必须排在各自分类首位。
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

    /**
     * 服务盲区识别参数
     *
     * 判定口径严格对齐赛题任务书原文：
     *   「系统能否准确识别出周边 1 公里内没有菜市场、药店或小学的『服务盲区』点位」
     * 即：某点到【菜市场、药店、小学】三类的最近距离**全部** > radiusMeters 时，判为盲区点位。
     */
    global.BLIND_GAP = {
        radiusMeters: 1000,      // 盲区判定半径（米），任务书原文「周边 1 公里」
        checkKeys: ['market', 'pharmacy', 'school'],  // 参与判定的三类：菜市场 / 药店 / 小学

        gridStepMeters: 120,     // 栅格采样间距（米）。越小越精确，点位数按平方增长
        severeMeters: 1500,      // 重度盲区分级阈值：三类最近距离均 > 此值

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

})(window);
