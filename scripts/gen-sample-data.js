/**
 * 生成「离线示例数据」sample-community.json
 * ----------------------------------------------------------------
 * 用途：让演示模式（无百度 AK / 离线 / clone 后）能直接渲染完整报告。
 * 这是一组「贴合真实形态」的仿真数据，非实时抓取；真实数据请在本项目
 * 线上（带 AK）点「导出演示数据」一键覆盖（见 js/app.js 的 DemoMode）。
 *
 * 运行：node scripts/gen-sample-data.js
 * 输出：data/sample-community.json
 *
 * 设计原则：
 *   - 数据结构 100% 对齐真实运行产物（center / samples / area / resultByKey / gapResult），
 *     这样演示模式与真实模式走完全相同的渲染链（Dashboard / Report / Canvas）。
 *   - 用固定种子（LCG）保证可复现：每次生成结果一致，便于审阅与 diff。
 *   - POI 数量参考 config.js 的 POI_THRESHOLD，让体检分数落在合理区间（充足/达标/缺失混合）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

// —— 固定种子伪随机（LCG），保证可复现 ——
let _seed = 20260903;
function rnd() {
    _seed = (_seed * 1103515245 + 12345) & 0x7fffffff;
    return _seed / 0x7fffffff;
}
function rrange(a, b) { return a + (b - a) * rnd(); }

const DEG = 111320; // 1 纬度 ≈ 米
const COS = Math.cos((31.2453 * Math.PI) / 180);

// 上海·陆家嘴（示意社区中心点）
const CENTER = { lng: 121.5057, lat: 31.2453, address: '上海市·浦东新区·陆家嘴' };

// 等时圈半径（15 分钟步行 ≈ 1200m，直线半径略小以体现绕行）
const R_DEG = 0.0110;

// 生成不规则等时圈多边形（16 向采样 + 半径噪声，模拟真实路网凹陷）
function makeIsochrone() {
    const pts = [];
    const N = 16;
    for (let i = 0; i < N; i++) {
        const ang = (i / N) * Math.PI * 2;
        // 半径在 78%~122% 间抖动，制造不规则轮廓
        const r = R_DEG * rrange(0.78, 1.22);
        const dLng = (r * Math.cos(ang)) / COS;
        const dLat = r * Math.sin(ang);
        pts.push({ lng: +(CENTER.lng + dLng).toFixed(6), lat: +(CENTER.lat + dLat).toFixed(6) });
    }
    return pts;
}

// 多边形面积（shoelace，米²）
function polyAreaM2(pts) {
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const ax = a.lng * COS * DEG, ay = a.lat * DEG;
        const bx = b.lng * COS * DEG, by = b.lat * DEG;
        s += ax * by - bx * ay;
    }
    return Math.abs(s) / 2;
}

// 在中心点附近随机布点（半径比例 rFrac）
function scatter(n, rFrac, kind) {
    const out = [];
    for (let i = 0; i < n; i++) {
        const ang = rnd() * Math.PI * 2;
        const r = R_DEG * rFrac * rrange(0.2, 1.0);
        const dLng = (r * Math.cos(ang)) / COS;
        const dLat = r * Math.sin(ang);
        out.push({
            name: `${kind}示例点${i + 1}`,
            point: { lng: +(CENTER.lng + dLng).toFixed(6), lat: +(CENTER.lat + dLat).toFixed(6) }
        });
    }
    return out;
}

// —— 六类 POI（数量参考 POI_THRESHOLD，制造混合评级）——
const CATS = [
    { key: 'hospital', name: '医院',   count: 3 },   // ideal 3 → 充足
    { key: 'pharmacy', name: '药店',   count: 6 },   // ideal 5 → 充足
    { key: 'market',   name: '菜市场', count: 1 },   // ideal 2/min1 → 达标偏少
    { key: 'store',    name: '商超',   count: 9 },   // ideal 5 → 充足
    { key: 'school',   name: '学校',   count: 2 },   // ideal 3/min1 → 达标
    { key: 'bus',      name: '公交站', count: 12 }   // ideal 3 → 充足
];

const resultByKey = {};
CATS.forEach(c => {
    resultByKey[c.key] = { items: scatter(c.count, 0.95, c.name) };
});

// —— 服务盲区点位（西北方向一簇，远离 POI 密集区）——
const GAP_CENTER = { lng: CENTER.lng - 0.0065, lat: CENTER.lat + 0.0042 };
const GAP_N = 47;
const gapPoints = [];
for (let i = 0; i < GAP_N; i++) {
    const ang = rnd() * Math.PI * 2;
    const r = 0.0022 * rrange(0, 1.0);
    const lng = +(GAP_CENTER.lng + (r * Math.cos(ang)) / COS).toFixed(6);
    const lat = +(GAP_CENTER.lat + r * Math.sin(ang)).toFixed(6);
    const dMarket = Math.round(rrange(1050, 1950));
    const dPharmacy = Math.round(rrange(1020, 1850));
    const dSchool = Math.round(rrange(1150, 2050));
    const worst = Math.min(dMarket, dPharmacy, dSchool);
    const level = worst > 1500 ? 2 : 1;
    const arr = [['market', dMarket], ['pharmacy', dPharmacy], ['school', dSchool]];
    arr.sort((a, b) => b[1] - a[1]);
    const bottleneck = arr[0][0];
    gapPoints.push({ lng, lat, dist: { market: dMarket, pharmacy: dPharmacy, school: dSchool }, worst, level, bottleneck });
}

const GRID = 412;
const GAP_COUNT = gapPoints.length;
const SEVERE = gapPoints.filter(p => p.level === 2).length;
const CELL_M2 = 120 * 120;

function clusterCentroid(points) {
    let sLng = 0, sLat = 0, sW = 0, maxW = -Infinity, maxAt = null;
    points.forEach(p => {
        sLng += p.lng; sLat += p.lat; sW += p.worst;
        if (p.worst > maxW) { maxW = p.worst; maxAt = p; }
    });
    return {
        size: points.length,
        members: points.length,
        areaM2: points.length * CELL_M2,
        centroid: { lng: +(sLng / points.length).toFixed(6), lat: +(sLat / points.length).toFixed(6) },
        avgGap: Math.round(sW / points.length),
        maxGap: Math.round(maxW),
        worstAt: maxAt,
        severity: points.length * (sW / points.length)
    };
}

// 拆成两个斑块（前半/后半）以演示 Top-N 排序
const half = Math.floor(GAP_COUNT / 2);
const patches = [
    clusterCentroid(gapPoints.slice(0, half)),
    clusterCentroid(gapPoints.slice(half))
].sort((a, b) => b.severity - a.severity);

const bottleneckCount = { market: 0, pharmacy: 0, school: 0 };
gapPoints.forEach(p => { bottleneckCount[p.bottleneck]++; });
const missingRate = {
    market: +(GAP_COUNT * rrange(0.55, 0.7)).toFixed(2),
    pharmacy: +(GAP_COUNT * rrange(0.5, 0.62)).toFixed(2),
    school: +(GAP_COUNT * rrange(0.6, 0.75)).toFixed(2)
};

const samples = makeIsochrone();
const area = Math.round(polyAreaM2(samples));

const gapResult = {
    enabled: true,
    ok: true,
    params: {
        radiusMeters: 1000,
        severeMeters: 1500,
        gridStepMeters: 120,
        stepAutoEnlarged: false,
        checkKeys: ['market', 'pharmacy', 'school']
    },
    lambda: 1.28,
    lambdaRaw: 1.28,
    lambdaFallback: false,
    lambdaClamped: false,
    lambdaSamples: 6,
    lambdaDetail: [
        { lng: CENTER.lng - 0.003, lat: CENTER.lat + 0.002, key: 'market',   straight: 820, walk: 1040, lambda: 1.27 },
        { lng: CENTER.lng + 0.004, lat: CENTER.lat - 0.003, key: 'pharmacy', straight: 760, walk: 980,  lambda: 1.29 },
        { lng: CENTER.lng - 0.005, lat: CENTER.lat - 0.004, key: 'school',   straight: 880, walk: 1120, lambda: 1.27 },
        { lng: CENTER.lng + 0.006, lat: CENTER.lat + 0.001, key: 'market',   straight: 690, walk: 880,  lambda: 1.28 },
        { lng: CENTER.lng - 0.001, lat: CENTER.lat + 0.006, key: 'pharmacy', straight: 810, walk: 1040, lambda: 1.28 },
        { lng: CENTER.lng + 0.002, lat: CENTER.lat - 0.007, key: 'school',   straight: 900, walk: 1150, lambda: 1.28 }
    ],
    gridCount: GRID,
    gapCount: GAP_COUNT,
    severeCount: SEVERE,
    gapRatio: +(GAP_COUNT / GRID).toFixed(4),
    gapAreaM2: GAP_COUNT * CELL_M2,
    poiCount: { market: resultByKey.market.items.length, pharmacy: resultByKey.pharmacy.items.length, school: resultByKey.school.items.length },
    gapPoints,
    worstPoint: gapPoints.reduce((a, b) => (b.worst > a.worst ? b : a)),
    patches,
    bottleneckCount,
    missingRate,
    centerStatus: {
        isGap: false,
        level: 0,
        worst: 540,
        dist: { market: 320, pharmacy: 280, school: 540 }
    }
};

const snapshot = {
    meta: {
        name: '陆家嘴示例社区（离线演示数据）',
        city: '上海市',
        address: CENTER.address,
        note: '本文件为仿真实例数据，用于无 AK / 离线演示。真实数据请在带 AK 的线上点「导出演示数据」覆盖。',
        generatedBy: 'scripts/gen-sample-data.js',
        generatedAt: new Date().toISOString().slice(0, 10)
    },
    center: { lng: CENTER.lng, lat: CENTER.lat, address: CENTER.address },
    samples,
    area,
    resultByKey,
    gapResult
};

const outPath = path.join(__dirname, '..', 'data', 'sample-community.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2), 'utf8');

console.log('✅ 已生成', outPath);
console.log('   等时圈面积 ≈', (area / 1e6).toFixed(2), 'km²');
console.log('   POI 总数   =', CATS.reduce((s, c) => s + c.count, 0));
console.log('   盲区点位   =', GAP_COUNT, '（重度', SEVERE + '）');
