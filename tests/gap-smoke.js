/**
 * 服务盲区识别算法 · Node 冒烟测试（零浏览器依赖）
 *
 * 运行：
 *   node tests/gap-smoke.js
 *
 * 做什么：
 *   把 js/config.js、js/util.js、js/gap.js 塞进一个假的 window 沙箱里执行，
 *   喂一份构造好的等时圈多边形 + POI 数据，验证：
 *     ① 栅格采样规模合理
 *     ② λ 标定：无路网 API 时正确退回经验值；有路网 API 时算出预期系数
 *     ③ 盲区判定：远离三类 POI 的区域被判为盲区、近旁区域不被判为盲区
 *     ④ 连通斑块聚合与排序
 *     ⑤ 同一输入两次运行结果一致（确定性）
 *
 * 为什么不用浏览器测：
 *   本算法唯一的外部依赖是 BMapGL.WalkingRoute（λ 标定用）。
 *   把它做成可替换的桩之后，算法主体（栅格 / 索引 / 距离场 / 判定 / 连通）可以
 *   完全离线验证，比开浏览器点一遍更快也更容易回归。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const EARTH_R = 6371008.8;
const M_PER_DEG_LAT = 111320;

/* ───────────────────────── 断言小工具 ───────────────────────── */
let pass = 0, fail = 0;
function ok(cond, name, extra) {
    if (cond) { pass++; console.log('  ✅ ' + name); }
    else { fail++; console.log('  ❌ ' + name + (extra ? '  →  ' + extra : '')); }
}
function near(a, b, tol, name) {
    ok(Math.abs(a - b) <= tol, name, `实际 ${a}，期望 ${b} ±${tol}`);
}

/* ───────────────────────── 沙箱搭建 ───────────────────────── */

function makeSandbox(walkingRouteImpl) {
    const sandbox = { console, setTimeout, clearTimeout, setInterval, clearInterval };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);

    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'config.js'), 'utf8'), sandbox, { filename: 'config.js' });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'util.js'), 'utf8'), sandbox, { filename: 'util.js' });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'gap.js'), 'utf8'), sandbox, { filename: 'gap.js' });

    // 关掉分组调试日志，否则 307 个栅格点的结果对象会把测试输出刷爆
    sandbox.Util.logGroup = () => {};

    if (walkingRouteImpl) {
        sandbox.BMapGL = {
            Point: function (lng, lat) { this.lng = lng; this.lat = lat; },
            WalkingRoute: walkingRouteImpl
        };
        sandbox.__bmap = { fake: true };   // gap.js 的 _walkDistance 会检查这个
    }
    return sandbox;
}

/**
 * 构造一个"走 Λ 形绕路"的假 WalkingRoute：路径总长 = detour × 直线距离
 * 这样 λ 标定就应当解出 detour，用来验证标定链路是否真的通。
 */
function fakeWalkingRoute(detour) {
    return function (map, opts) {
        this.search = (start, end) => {
            const latRad = ((start.lat + end.lat) / 2) * Math.PI / 180;
            const dx = (end.lng - start.lng) * Math.cos(latRad) * M_PER_DEG_LAT;
            const dy = (end.lat - start.lat) * M_PER_DEG_LAT;
            const straight = Math.hypot(dx, dy);
            if (!(straight > 0)) { opts.onSearchComplete(null); return; }

            // Λ 形：中点向垂直方向抬起 h，使 2·√((s/2)²+h²) = detour·s
            const h = (straight / 2) * Math.sqrt(Math.max(0, detour * detour - 1));
            const ux = dx / straight, uy = dy / straight;
            const px = -uy, py = ux;                        // 垂直单位向量（米）
            const midM = { x: dx / 2 + px * h, y: dy / 2 + py * h };
            const apex = {
                lng: start.lng + midM.x / (Math.cos(latRad) * M_PER_DEG_LAT),
                lat: start.lat + midM.y / M_PER_DEG_LAT
            };
            const path = [start, apex, end];

            setTimeout(() => opts.onSearchComplete({
                getPlan: () => ({ getRoute: () => ({ getPath: () => path }) })
            }), 0);
        };
    };
}

/* ───────────────────────── 测试数据 ───────────────────────── */

const CENTER = { lng: 116.4800, lat: 39.9200 };

// 1.2 km 半径的圆 polygon（模拟 15 分钟等时圈，实际是不规则的，这里用正圆代替）
function circlePolygon(c, radiusM, n = 24) {
    const pts = [];
    for (let i = 0; i < n; i++) pts.push(destination(c, radiusM, (i * 360) / n));
    return pts;
}
function destination(c, distM, bearingDeg) {
    const brng = bearingDeg * Math.PI / 180;
    const lat1 = c.lat * Math.PI / 180, lng1 = c.lng * Math.PI / 180;
    const dr = distM / EARTH_R;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(dr) + Math.cos(lat1) * Math.sin(dr) * Math.cos(brng));
    const lng2 = lng1 + Math.atan2(Math.sin(brng) * Math.sin(dr) * Math.cos(lat1),
                                   Math.cos(dr) - Math.sin(lat1) * Math.sin(lat2));
    return { lng: lng2 * 180 / Math.PI, lat: lat2 * 180 / Math.PI };
}

/**
 * POI 布局：三类全部集中在中心西侧约 700m 处。
 * 于是圆内东侧（距该簇 > 1 km 直线、× λ 后更远）应当被判为盲区。
 */
const CLUSTER = destination(CENTER, 700, 270);   // 正西 700m
function poiAt(c, dxM, dyM) {
    return { point: { lng: c.lng + dxM / (Math.cos(c.lat * Math.PI / 180) * M_PER_DEG_LAT), lat: c.lat + dyM / M_PER_DEG_LAT } };
}
function buildResultByKey() {
    return {
        market:   { items: [poiAt(CLUSTER, 0, 0), poiAt(CLUSTER, 60, 40)] },
        pharmacy: { items: [poiAt(CLUSTER, -50, 30)] },
        school:   { items: [poiAt(CLUSTER, 40, -60), poiAt(CLUSTER, -80, -20)] },
        hospital: { items: [poiAt(CENTER, 100, 100)] },   // 不参与盲区判定
        store:    { items: [poiAt(CENTER, -100, -100)] },
        bus:      { items: [poiAt(CENTER, 200, 0)] }
    };
}

/* ───────────────────────── 用例 ───────────────────────── */

(async function main() {
    console.log('\n=== 服务盲区识别 · 冒烟测试 ===\n');
    const polygon = circlePolygon(CENTER, 1200);

    /* --- 场景 A：没有路网 API（退回经验值 λ） --- */
    console.log('[场景 A] 无 WalkingRoute → λ 应退回经验值 1.25');
    const sbA = makeSandbox(null);
    const rA = await sbA.GapFinder.analyze(CENTER, polygon, buildResultByKey(), () => {});

    ok(rA.enabled, '分析成功执行');
    ok(rA.gridCount > 100, `栅格点数合理（${rA.gridCount} 点）`);
    near(rA.params.gridStepMeters, 120, 0, '栅格步长 = 120 m');
    ok(rA.lambdaFallback === true, 'λ 已标记为兜底值');
    near(rA.lambda, 1.25, 1e-9, 'λ = 经验值 1.25');
    ok(rA.gapCount > 0, `识别出盲区点位（${rA.gapCount} 个，占比 ${(rA.gapRatio * 100).toFixed(1)}%）`);
    ok(rA.gapCount < rA.gridCount, '未把整个区域都判成盲区');
    ok(rA.patches.length > 0, `聚合出连片斑块（${rA.patches.length} 块）`);
    ok(rA.patches.every((p, i, a) => i === 0 || a[i - 1].severity >= p.severity), '斑块按严重度降序排列');
    ok(rA.centerStatus && rA.centerStatus.worst > 0, '中心点状态已计算');
    ok(!!rA.worstPoint && rA.worstPoint.worst >= rA.centerStatus.worst, '最差点位缺口强度 ≥ 中心点');

    // 方向性校验：盲区点位整体应位于 POI 簇的反方向（POI 在正西 → 盲区质心应在东侧）
    if (rA.gapPoints.length) {
        const cx = rA.gapPoints.reduce((s, p) => s + p.lng, 0) / rA.gapPoints.length;
        ok(cx > CENTER.lng, '盲区质心位于 POI 簇反方向（东侧），方向性正确');
    }

    /* --- 场景 B：假路网返回 1.3 倍绕行 → λ 应解出 ≈1.30 --- */
    console.log('\n[场景 B] 假 WalkingRoute 绕行 1.30× → λ 应标定为 ≈1.30');
    const sbB = makeSandbox(fakeWalkingRoute(1.30));
    sbB.BLIND_GAP.calibAnchors = 6;
    const rB = await sbB.GapFinder.analyze(CENTER, polygon, buildResultByKey(), () => {});

    ok(rB.lambdaFallback === false, `λ 标定成功（${rB.lambdaSamples} 个样本）`);
    ok(rB.lambdaSamples >= 2, '标定样本 ≥ 2');
    near(rB.lambda, 1.30, 0.03, 'λ ≈ 1.30（与注入的绕行系数一致）');
    ok(rB.gapCount >= rA.gapCount,
        `λ 变大后盲区不减少（A=${rA.gapCount} → B=${rB.gapCount}）`,
        '绕行系数变大应使盲区增多或持平');

    /* --- 场景 C：λ 极端值钳制 --- */
    console.log('\n[场景 C] 注入 3.0× 绕行 → λ 应被钳到上限 1.80');
    const sbC = makeSandbox(fakeWalkingRoute(3.0));
    const rC = await sbC.GapFinder.analyze(CENTER, polygon, buildResultByKey(), () => {});
    ok(rC.lambdaClamped === true, 'λ 已标记钳制');
    near(rC.lambda, 1.80, 1e-9, 'λ 被钳到上限 1.80');

    /* --- 场景 D：配套密集 → 不应有盲区 --- */
    console.log('\n[场景 D] 三类配套均匀铺满 → 不应识别出盲区');
    const dense = { market: { items: [] }, pharmacy: { items: [] }, school: { items: [] } };
    for (let a = 0; a < 360; a += 45) {
        for (const r of [200, 600, 1000]) {
            const c = destination(CENTER, r, a);
            dense.market.items.push({ point: c });
            dense.pharmacy.items.push({ point: c });
            dense.school.items.push({ point: c });
        }
    }
    const sbD = makeSandbox(null);
    const rD = await sbD.GapFinder.analyze(CENTER, polygon, dense, () => {});
    ok(rD.enabled, '密集场景分析成功');
    near(rD.gapCount, 0, 0, '配套铺满时盲区数 = 0');
    near(rD.patches.length, 0, 0, '配套铺满时斑块数 = 0');

    /* --- 场景 E：确定性（同输入两次运行结果一致） --- */
    console.log('\n[场景 E] 确定性校验');
    const sbE = makeSandbox(null);
    const rE1 = await sbE.GapFinder.analyze(CENTER, polygon, buildResultByKey(), () => {});
    const rE2 = await sbE.GapFinder.analyze(CENTER, polygon, buildResultByKey(), () => {});
    ok(rE1.gridCount === rE2.gridCount && rE1.gapCount === rE2.gapCount,
        '两次运行栅格数与盲区数完全一致');

    /* --- 场景 F：异常输入不应抛错 --- */
    console.log('\n[场景 F] 异常输入防御');
    const sbF = makeSandbox(null);
    const rF1 = await sbF.GapFinder.analyze(CENTER, [], buildResultByKey(), () => {});
    ok(rF1.enabled === false && !!rF1.reason, '空多边形 → 优雅降级（不抛错）');
    const rF2 = await sbF.GapFinder.analyze(CENTER, polygon, {}, () => {});
    ok(rF2.enabled === false && !!rF2.reason, '无 POI 数据 → 优雅降级');
    const rF3 = await sbF.GapFinder.analyze(null, polygon, buildResultByKey(), () => {});
    ok(rF3.enabled === false, '中心点缺失 → 优雅降级');

    /* --- 汇总 --- */
    console.log('\n──────────────────────────────');
    console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
    console.log('──────────────────────────────\n');
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
    console.error('\n💥 测试执行异常：', e);
    process.exit(1);
});
