/**
 * 项目配置：百度地图 AK + 主题色 + 等时圈参数
 * 演示场景把 AK 暴露在前端（请在百度开放平台配置 Referer 白名单 = * 或本机 IP）
 */
(function (global) {
    'use strict';

    // 浏览器端 AK（用户在百度地图开放平台创建的应用，「浏览器端」类型）
    global.BMAP_AK = '4G0d2gbkyXWZRLIWovEsQg3ZmnIvgr49';

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

    // POI 分类配置
    global.POI_CATEGORIES = [
        { key: 'hospital', name: '医院',   color: '#ff5470', icon: '🏥', keywords: ['综合医院', '医院'] },
        { key: 'pharmacy', name: '药店',   color: '#ffa726', icon: '💊', keywords: ['药店', '药房'] },
        { key: 'market',   name: '商超',   color: '#00d68f', icon: '🛒', keywords: ['超市', '商场', '便利店'] },
        { key: 'school',   name: '学校',   color: '#42a5f5', icon: '🎓', keywords: ['小学', '中学', '大学', '幼儿园'] },
        { key: 'bus',      name: '公交站', color: '#ab47bc', icon: '🚌', keywords: ['公交站', '地铁站'] }
    ];

    // POI 缺失阈值（用于体检报告与评分，参考住建部《完整居住社区建设标准》/上海《15 分钟社区生活圈规划导则》）
    global.POI_THRESHOLD = {
        hospital: { min: 1, ideal: 3, weight: 0.25 },
        pharmacy: { min: 2, ideal: 5, weight: 0.15 },
        market:   { min: 2, ideal: 4, weight: 0.20 },
        school:   { min: 1, ideal: 3, weight: 0.20 },
        bus:      { min: 1, ideal: 3, weight: 0.20 }
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
