/**
 * 整机数据契约冒烟（无浏览器）：把 gap + dashboard + report 串起来跑一遍，
 * 验证：① 盲区能进报告 HTML ② 四维评分不超 100 ③ 类别多样性动态归一。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const M_PER_DEG_LAT = 111320;
const EARTH_R = 6371008.8;

function makeSandbox() {
    const sb = { console, setTimeout, clearTimeout, setInterval, clearInterval, document: fakeDoc() };
    sb.window = sb; sb.globalThis = sb;
    vm.createContext(sb);
    for (const f of ['config.js', 'util.js', 'poi.js', 'gap.js', 'dashboard.js', 'report.js']) {
        vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), sb, { filename: f });
    }
    sb.Util.logGroup = () => {};
    return sb;
}
// 极简 document：只支持 getElementById 返回带 innerHTML/classList/style 的桩 + createElement
function fakeDoc() {
    const store = {};
    const mk = () => ({ innerHTML: '', textContent: '', hidden: false,
        classList: { add(){}, remove(){}, contains(){return false} }, style: {}, dataset: {},
        addEventListener(){}, appendChild(){}, setAttribute(){}, getAttribute(){return null} });
    return {
        getElementById: (id) => (store[id] || (store[id] = mk())),
        createElement: () => mk(),
        addEventListener(){},
        body: mk()
    };
}
function dest(c, distM, brg) {
    const b = brg * Math.PI/180, la1 = c.lat*Math.PI/180, lo1 = c.lng*Math.PI/180, dr = distM/EARTH_R;
    const la2 = Math.asin(Math.sin(la1)*Math.cos(dr)+Math.cos(la1)*Math.sin(dr)*Math.cos(b));
    const lo2 = lo1 + Math.atan2(Math.sin(b)*Math.sin(dr)*Math.cos(la1), Math.cos(dr)-Math.sin(la1)*Math.sin(la2));
    return { lng: lo2*180/Math.PI, lat: la2*180/Math.PI };
}
function circle(c, r, n=24){ const a=[]; for(let i=0;i<n;i++) a.push(dest(c,r,i*360/n)); return a; }
const C = { lng: 116.48, lat: 39.92 };
const CL = dest(C, 700, 270);
const at = (c,dx,dy)=>({ point:{ lng:c.lng+dx/(Math.cos(c.lat*Math.PI/180)*M_PER_DEG_LAT), lat:c.lat+dy/M_PER_DEG_LAT } });
function rbk(){
    return {
        market:{items:[at(CL,0,0),at(CL,60,40)]}, pharmacy:{items:[at(CL,-50,30)]},
        school:{items:[at(CL,40,-60),at(CL,-80,-20)]},
        hospital:{items:[at(C,100,100)]}, store:{items:[at(C,-100,-100)]}, bus:{items:[at(C,200,0)]}
    };
}
(async () => {
    const sb = makeSandbox();
    const poly = circle(C, 1200);
    const gap = await sb.GapFinder.analyze(C, poly, rbk(), () => {});
    const { score, breakdown } = sb.Dashboard.calcScore(rbk(), 2.8e6, C);
    const html = sb.Report.build(C, rbk(), 2.8e6, score, [], breakdown, gap);
    // Report.build 返回值是 _plainText() 纯文本；HTML 版本写入了 #reportSingle.innerHTML
    const reportHtml = sb.document.getElementById('reportSingle').innerHTML;
    let pass=0, fail=0; const ok=(c,n)=>{ c?(pass++,console.log('  ✅ '+n)):(fail++,console.log('  ❌ '+n)); };
    ok(gap.enabled && gap.gapCount > 0, `盲区已识别（${gap.gapCount}/${gap.gridCount}）`);
    ok(/服务盲区识别/.test(reportHtml), '报告 HTML 含「服务盲区识别」章节');
    ok(/⑤ 改造建议/.test(reportHtml), '报告章节已重排为 ⑤ 改造建议');
    ok(score >= 0 && score <= 100, `综合评分在 0~100 区间（=${score}）`);
    ok(breakdown.diversity <= 100 + 1e-9, `类别多样性未超 100（=${breakdown.diversity}，类别数=${sb.POI_CATEGORIES.length}）`);
    ok(gap.lambda > 1, `λ 已标定（=${gap.lambda.toFixed(3)}）`);
    console.log(`\n  通过 ${pass} 项，失败 ${fail} 项`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('💥', e); process.exit(1); });
