/**
 * 生活圈应力测试（Local Life-Circle Stress Test）
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【为什么叫"应力测试"】
 *   常见的生活圈评价是**静态快照**：给一个地址，输出一个分数和几张图。
 *   本模块改为对同一次体检结果**持续加压**，观察它在压力下的表现：
 *     ① 降速加压 —— 人群步速从 120 降到 40 m/min，达标率如何塌缩？什么时候崩？（模块 1）
 *     ② 路网加压 —— 真实绕行在空间上分布不均，哪里最"堵"？（模块 2）
 *     ③ 判定加压 —— 每个结论的把握有多少，外推区域明确标注？（模块 3）
 *     ④ 归因定责 —— 不达标到底「没有设施」还是「有设施走不过去」？（模块 4）
 *
 * 【数据来源：全部复用既有管线，零新增 API 调用】
 *   1) js/accessibility.js  —— 每个居住采样点到最近设施的真实步行距离（含直线距离与来源标记）
 *   2) js/gap.js λ 场       —— λ(x,y) 空间变异绕行系数 + 留一交叉验证精度指标
 *   3) js/config.js         —— 5 类人群速度（含轮椅 40 m/min）与 GB 50180-2018 服务半径
 *
 * 【和「配套设施统计」的本质区别】
 *   数量统计回答"圈内有多少个"；本模块回答"对行动能力不同的人来说，
 *   这个社区什么时候开始不够用、差在哪一环、该补设施还是该修路"。
 */
(function (global) {
    'use strict';

    // 临界步速扫描范围（m/min）：下界取轮椅速度，上界取快走/跑步上限
    const V_MIN = 40;
    const V_MAX = 120;
    const V_STEP = 5;

    // 判定"仍然够用"的达标率门槛：低于此值认为该社区对这个步速的人群已经不够友好
    const RATE_THRESHOLD = 0.6;

    const Stress = {

        lastResult: null,

        /**
         * 汇总四个模块的分析结果
         *
         * @param {Object} o
         * @param {Object} o.access   Accessibility.compute() 的返回值
         * @param {Object} o.gap      GapFinder.lastResult
         * @returns {Object} { ok, collapse, impedance, tristate, attribution }
         */
        build: function (o) {
            o = o || {};
            const access = o.access;
            const gap = o.gap;

            const result = {
                ok: false,
                collapse: null,
                impedance: null,
                tristate: null,
                attribution: null
            };

            try { result.collapse = collapseCurve(access); } catch (e) { console.warn('[stress] 塌缩曲线失败', e); }
            try { result.impedance = (gap && gap.lambdaField) ? gap.lambdaField : null; } catch (e) { /* 忽略 */ }
            try { result.tristate = (gap && gap.tristate) ? gap.tristate : null; } catch (e) { /* 忽略 */ }
            try { result.attribution = attribution(access); } catch (e) { console.warn('[stress] 归因分析失败', e); }

            result.ok = !!(result.collapse || result.impedance || result.tristate || result.attribution);
            this.lastResult = result;
            return result;
        },

        /* ================================================================
         * 渲染
         * ================================================================ */

        /**
         * 渲染到指定容器
         * @param {string} containerId
         * @param {Object} data build() 的返回值（缺省则取 lastResult）
         */
        renderTo: function (containerId, data) {
            const box = document.getElementById(containerId);
            if (!box) return;
            const d = data || this.lastResult;
            if (!d || !d.ok) {
                box.innerHTML = '<div class="report-section"><h4>🔬 生活圈应力测试</h4>'
                    + '<p class="muted">完成一次体检后，这里会给出加压测试的四组结论：'
                    + '达标率塌缩曲线、步行阻抗场、判定置信度，以及「缺设施还是缺路」的归因。</p></div>';
                return;
            }

            const html = [];
            html.push('<div class="report-section">');
            html.push('<h4>🔬 生活圈应力测试</h4>');
            html.push('<p>静态评分只能说明"现在好不好"。本节对同一次体检结果<b>施加压力</b>：'
                + '降低人群步速、放大路网绕行、追问答定把握，从而回答四个更贴近实际需求的问题——'
                + '慢到什么程度就不够用、哪里最难走、结论有多少把握、以及该补设施还是该修路。</p>');
            html.push('</div>');

            html.push(this._renderCollapse(d.collapse));
            html.push(this._renderImpedance(d.impedance));
            html.push(this._renderTristate(d.tristate));
            html.push(this._renderAttribution(d.attribution));

            // 重写容器内容前先释放旧的图表实例：
            // 直接在已初始化的 DOM 上再次 echarts.init 会触发重复初始化告警并泄漏实例
            if (typeof echarts !== 'undefined') {
                ['stressCollapseChart', 'stressAttributionChart'].forEach(function (id) {
                    const oldEl = document.getElementById(id);
                    if (!oldEl) return;
                    try {
                        const inst = echarts.getInstanceByDom(oldEl);
                        if (inst) inst.dispose();
                    } catch (e) { /* 忽略 */ }
                });
            }

            box.innerHTML = html.join('');

            // 图表必须在 DOM 落地之后再初始化
            if (d.collapse && d.collapse.ok) this._drawCollapseChart(d.collapse);
            if (d.attribution && d.attribution.ok) this._drawAttributionChart(d.attribution);
        },

        _renderCollapse: function (c) {
            if (!c || !c.ok) {
                return '<div class="report-section"><h4>① 可达性塌缩曲线</h4>'
                    + '<p class="muted">未获取到最近设施实测数据，本节跳过。</p></div>';
            }

            const vcTxt = c.criticalSpeed == null
                ? '即使按 ' + V_MAX + ' m/min 快走，综合达标率仍低于 ' + (RATE_THRESHOLD * 100) + '%'
                : (c.criticalSpeed <= V_MIN
                    ? '在 ' + V_MIN + ' m/min（轮椅行进速度）下综合达标率仍不低于 ' + (RATE_THRESHOLD * 100) + '%，对全行动能力人群都够用'
                    : '综合达标率跌破 ' + (RATE_THRESHOLD * 100) + '% 的临界步速为 <b>' + c.criticalSpeed + ' m/min</b>');

            const rows = c.perCategory.map(function (p) {
                const vc = p.criticalSpeed;
                const vcTxt2 = vc == null ? '&gt;' + V_MAX : (vc <= V_MIN ? '&le;' + V_MIN : String(vc));
                return '<tr><td>' + p.icon + ' ' + esc(p.name) + ' <small>(≤' + p.stdMinutes + '′)</small></td>'
                    + '<td>' + vcTxt2 + '</td>'
                    + '<td>' + Math.round(p.rateAtWalk * 100) + '%</td>'
                    + '<td>' + Math.round(p.rateAtWheel * 100) + '%</td></tr>';
            }).join('');

            return ''
                + '<div class="report-section">'
                + '<h4>① 可达性塌缩曲线与临界步速</h4>'
                + '<p>把"这类人对生活圈够不够用"写成<b>步速的连续函数</b>：'
                + '对每类设施，按 GB 50180-2018 服务半径换算的行走时间与各居住点的实测步行距离比对，'
                + '得到任意步速下的达标率。曲线向下塌缩的位置，就是这个社区开始"不够用"的位置。</p>'
                + '<div class="stress-kpi-row">'
                +   kpiCard('临界步速 Vc', c.criticalSpeed == null ? ('&gt;' + V_MAX) : (c.criticalSpeed <= V_MIN ? ('&le;' + V_MIN) : c.criticalSpeed), 'm/min',
                        c.criticalSpeed == null ? '#ff5470' : (c.criticalSpeed <= V_MIN ? '#00d68f' : '#ffb547'))
                +   kpiCard('步行基准达标率', Math.round(c.rateAtWalk * 100), '%', colorOfRate(c.rateAtWalk))
                +   kpiCard('轮椅基准达标率', Math.round(c.rateAtWheel * 100), '%', colorOfRate(c.rateAtWheel))
                +   kpiCard('全龄落差', Math.round((c.rateAtWalk - c.rateAtWheel) * 100), '个百分点', '#ffb547')
                + '</div>'
                + '<div id="stressCollapseChart" class="stress-chart"></div>'
                + '<p class="per-type-note">' + vcTxt + '。'
                + (c.mostFragile ? ('最先失守的是<b>' + esc(c.mostFragile.name) + '</b>，'
                    + '该类在慢速下降过程中最先掉出达标区间，是优先整治对象。') : '')
                + '</p>'
                + '<h5 style="margin:14px 0 6px;font-size:13px">分类临界步速</h5>'
                + '<table class="per-type-table"><thead><tr>'
                + '<th>设施类别</th><th>临界步速 (m/min)</th><th>步行基准</th><th>轮椅基准</th>'
                + '</tr></thead><tbody>' + rows + '</tbody></table>'
                + '</div>';
        },

        _drawCollapseChart: function (c) {
            const el = document.getElementById('stressCollapseChart');
            if (!el || typeof echarts === 'undefined') return;

            const series = c.perCategory.map(function (p, i) {
                return {
                    name: p.name,
                    type: 'line',
                    smooth: true,
                    symbol: 'circle',
                    symbolSize: 5,
                    data: p.series.map(function (v) { return Math.round(v * 100); })
                };
            });
            series.unshift({
                name: '综合达标率',
                type: 'line',
                smooth: true,
                symbol: 'circle',
                symbolSize: 7,
                lineStyle: { width: 3 },
                data: c.overallSeries.map(function (v) { return Math.round(v * 100); })
            });

            // 主分析人群与轮椅人群所处的步速位置
            const markSpeed = function (v, name, color) {
                return {
                    xAxis: v, lineStyle: { color: color, type: 'dashed', width: 1.5 },
                    label: { formatter: name, color: color, fontSize: 11, position: 'insideEndTop' }
                };
            };

            const chart = echarts.init(el, null, { renderer: 'canvas' });
            chart.setOption({
                backgroundColor: 'transparent',
                grid: { left: 44, right: 20, top: 34, bottom: 40 },
                tooltip: {
                    trigger: 'axis',
                    backgroundColor: 'rgba(13,27,61,0.94)',
                    borderColor: 'rgba(120,180,255,0.25)',
                    textStyle: { color: '#e6f0ff', fontSize: 12 },
                    formatter: function (ps) {
                        const lines = ps.map(function (p) {
                            return p.marker + p.seriesName + '：' + p.value + '%';
                        });
                        return ps[0].axisValue + ' m/min<br>' + lines.join('<br>');
                    }
                },
                legend: {
                    top: 2, left: 0, itemWidth: 12, itemHeight: 8, textStyle: { color: '#8a9ec0', fontSize: 11 }
                },
                xAxis: {
                    type: 'category',
                    data: c.speeds,
                    name: '步速 m/min',
                    nameLocation: 'middle',
                    nameGap: 26,
                    nameTextStyle: { color: '#8a9ec0', fontSize: 11 },
                    axisLine: { lineStyle: { color: 'rgba(120,180,255,0.25)' } },
                    axisLabel: { color: '#8a9ec0', fontSize: 11 },
                    axisTick: { show: false }
                },
                yAxis: {
                    type: 'value',
                    min: 0, max: 100,
                    name: '达标率 %',
                    nameTextStyle: { color: '#8a9ec0', fontSize: 11 },
                    axisLine: { show: false },
                    axisTick: { show: false },
                    axisLabel: { color: '#8a9ec0', fontSize: 11 },
                    splitLine: { lineStyle: { color: 'rgba(120,180,255,0.12)' } }
                },
                series: decorateSeries(series, markSpeed, c)
            });
        },

        _renderImpedance: function (f) {
            const head = '<div class="report-section"><h4>② 步行阻抗场 λ(x, y)</h4>';
            if (!f || !f.range) {
                return head + '<p class="muted">未获取到足够的真实路网观测，无法构建阻抗场。</p></div>';
            }

            const loo = f.loocv;
            const looTxt = loo
                ? ('留一交叉验证：' + loo.n + ' 个观测点逐个留出验证，空间场平均绝对误差 <b>'
                    + loo.mae.toFixed(3) + '</b>、均方根误差 ' + loo.rmse.toFixed(3)
                    + (loo.improveMae == null ? '' :
                        ('；相比「全图统一用单一全局常数 λ=' + loo.meanLambda.toFixed(2)
                         + '」的传统外推，空间场把预测误差降低了 <b>' + Math.round(loo.improveMae * 100) + '%</b>')))
                : '观测点不足 3 个，暂不做交叉验证。';

            const confTxt = (function () {
                if (!f.confMean) return '';
                return '全场平均判定置信度 <b>' + Math.round(f.confMean * 100) + '%</b>；';
            })();

            const detours = (f.topDetours || []).map(function (d, i) {
                const nm = nameOfKey(d.key);
                return '<li><b>绕行实证 ' + (i + 1) + '：</b>' + esc(nm) + ' —— 直线 ' + d.straight + ' m，'
                    + '沿实际路网 ' + d.walk + ' m，因绕行多走 <b style="color:#ff5470">' + d.detour + ' m</b>'
                    + '（绕行系数 ' + d.lambda.toFixed(2) + '）</li>';
            }).join('');

            return head
                + '<p>常规的步行距离外推把绕行系数 λ 当作<b>一个全局常数</b>。'
                + '但真实城市的绕行程度随位置变化——河流两岸、铁路两侧、封闭式小区内外往往相差一倍以上，'
                + '用同一个常数会把局部的高绕行"平均"掉。本模块把每一条"直线 vs 实测"的真实路网记录当作一次空间采样，'
                + '插值成连续变化的<b>阻抗场</b>，并给出它自身的精度证据。</p>'
                + '<div class="stress-kpi-row">'
                +   kpiCard('路网观测点', f.observationCount, '条', '#3a7afe')
                +   kpiCard('λ 实测区间', f.range.min.toFixed(2) + ' ~ ' + f.range.max.toFixed(2), '', '#ffb547')
                +   kpiCard('λ 均值', f.range.mean.toFixed(2), '', '#00d68f')
                +   kpiCard(loo ? 'MAE' : 'MAE', loo ? loo.mae.toFixed(3) : '样本不足', '', loo && loo.mae < 0.15 ? '#00d68f' : '#ffb547')
                +   kpiCard(loo ? '相对全局常数改进率' : '相对全局常数改进率',
                        loo && loo.improveMae != null ? '+' + Math.round(loo.improveMae * 100) + '%' : '—', '',
                        loo && loo.improveMae != null && loo.improveMae >= 0 ? '#00d68f' : '#ff5470')
                + '</div>'
                + '<p class="per-type-note">方法一说明：对场中任一点，用其余观测按距离平方反比加权插值出它的 λ。'
                + looTxt + '。' + confTxt + '误差越小，说明用距离场外推替代逐点路径规划越可靠。</p>'
                + (detours ? ('<h5 style="margin:14px 0 6px;font-size:13px">绕行举证（λ 最高的观测点対）</h5><ul class="report-list">' + detours + '</ul>') : '')
                + '</div>';
        },

        _renderTristate: function (t) {
            const head = '<div class="report-section"><h4>③ 隐性盲区与判定置信度</h4>';
            if (!t || !t.counts) {
                return head + '<p class="muted">未获取到三态判定数据，本节跳过。</p></div>';
            }
            const c = t.counts;
            const total = c.cover + c.hidden + c.explicit;
            const pct = function (x) { return total ? (x / total * 100).toFixed(1) : '0.0'; };

            return head
                + '<p>盲区按"<b>直线画圆</b>会不会漏判"分成三类：'
                + '<b>隐性盲区</b>是直线距离在阈值内（画圆看着有配套）、实际步行却超出阈值的点位，'
                + '这类点位正是圆形可达圈会系统性漏判的部分。</p>'
                + '<table class="per-type-table"><thead><tr>'
                + '<th>判定结果</th><th>栅格点数</th><th>占比</th><th>说明</th>'
                + '</tr></thead><tbody>'
                + '<tr><td>🟢 正常覆盖</td><td>' + c.cover + '</td><td>' + pct(c.cover) + '%</td>'
                + '<td style="font-size:12px">步行距离就在服务半径内</td></tr>'
                + '<tr><td style="color:#ffb547"><b>🟡 隐性盲区</b></td><td>' + c.hidden + '</td>'
                + '<td><b style="color:#ffb547">' + pct(c.hidden) + '%</b></td>'
                + '<td style="font-size:12px">直线看着近，实际绕行后走不到</td></tr>'
                + '<tr><td style="color:#ff5470"><b>🔴 显性盲区</b></td><td>' + c.explicit + '</td>'
                + '<td><b style="color:#ff5470">' + pct(c.explicit) + '%</b></td>'
                + '<td style="font-size:12px">直线距离本身已超出服务半径</td></tr>'
                + '</tbody></table>'
                + '<p class="per-type-note">'
                + (c.hidden > 0
                    ? ('其中 <b>' + c.hidden + '</b> 个点位（' + pct(c.hidden) + '%）'
                        + '在直线口径下会被误判为"有配套"，只有按真实步行距离核验才暴露出来——'
                        + '这是<b>不能用圆代替等时圈</b>的直接证据。')
                    : '本次未发现隐性盲区：直线距离在服务半径内的点位，实际步行均可到达。')
                + '</p>'
                + '<p class="per-type-note">'
                + '<b>判定置信度：</b>场中任一点的结论把握，取决于它离真实路网观测点有多远——'
                + '离观测点越近越可靠，远离观测点的区域依赖空间外推，把握相应下降。'
                + '本次盲区点位的平均置信度约 <b>' + Math.round((t.confMean || 0) * 100) + '%</b>'
                + (t.lowConfidenceRatio > 0
                    ? ('，其中 <b>' + Math.round(t.lowConfidenceRatio * 100) + '%</b> 属于外推区域（置信度低于 40%），'
                        + '建议实地复核后再纳入决策。')
                    : '，未发现大面积的外推区域。')
                + '</p>'
                + '</div>';
        },

        _renderAttribution: function (a) {
            const head = '<div class="report-section"><h4>④ 缺设施，还是缺路？</h4>';
            if (!a || !a.ok) {
                return head + '<p class="muted">未获取到足够的最近设施实测数据，无法归因。</p></div>';
            }

            const rows = a.perCategory.map(function (p) {
                const connPct = p.bad ? Math.round(p.connect / p.bad * 100) : 0;
                return '<tr><td>' + p.icon + ' ' + esc(p.name) + '</td>'
                    + '<td>' + p.bad + ' / ' + p.total + '</td>'
                    + '<td>' + p.supply + '</td>'
                    + '<td><b style="color:' + (connPct >= 50 ? '#ffb547' : '#8a9ec0') + '">' + p.connect
                    + '</b>（' + connPct + '%）</td>'
                    + '<td>' + (p.avgDetour > 0 ? Math.round(p.avgDetour) + ' m' : '—') + '</td></tr>';
            }).join('');

            const list = (a.openList || []).map(function (s, i) {
                return '<li><b>打通点 ' + (i + 1) + '：</b>' + esc(s.title)
                    + ' <div class="gp-meta">坐标 ' + s.lat.toFixed(5) + ', ' + s.lng.toFixed(5)
                    + ' · 累计绕行损失 ' + Math.round(s.totalLoss) + ' m · 影响 ' + s.points
                    + ' 个居住采样点 · 涉及 ' + s.categoryCount + ' 类设施</div>'
                    + '<div class="gp-meta">建议动作：' + esc(s.action) + '</div></li>';
            }).join('');

            return head
                + '<p>对每一个<b>不达标</b>的居住采样点，沿"直线 → 实际"这条链路问一句：'
                + '它是<b>本来就没有这座设施</b>，还是<b>设施在直线半径内、只是走不过去</b>？'
                + '两者的治理手段完全不同——前者要新建，后者要打通。</p>'
                + '<div class="stress-kpi-row">'
                +   kpiCard('不达标采样点', a.totalBad, '个', '#ff5470')
                +   kpiCard('供给缺口', a.totalSupply, '个', '#3a7afe')
                +   kpiCard('连通缺口', a.totalConnect, '个', '#ffb547')
                +   kpiCard('连通缺口占比', a.connectRatio != null ? Math.round(a.connectRatio * 100) : 0, '%', '#ffb547')
                + '</div>'
                + '<div id="stressAttributionChart" class="stress-chart"></div>'
                + '<p class="per-type-note">' + esc(a.headline) + '</p>'
                + '<h5 style="margin:14px 0 6px;font-size:13px">分类归因</h5>'
                + '<table class="per-type-table"><thead><tr>'
                + '<th>设施类别</th><th>不达标 / 总数</th><th>供给缺口</th><th>连通缺口</th><th>平均绕行损失</th>'
                + '</tr></thead><tbody>' + rows + '</tbody></table>'
                + (list
                    ? ('<h5 style="margin:14px 0 6px;font-size:13px">优先打通清单（按累计绕行损失排序）</h5>'
                        + '<ul class="report-list">' + list + '</ul>'
                        + '<p class="per-type-note">上述目标设施<b>在直线距离上已经够得着</b>，'
                        + '却被绕行拉长到不达标。相比新建一座设施，'
                        + '打通一处步行通道通常成本更低、见效更快，应作为改造方案的首选。</p>')
                    : '<p class="per-type-note">未发现明显的连通性缺口，说明不达标主要由设施本身的布局距离造成，'
                        + '宜按上方的补点建议新建。</p>')
                + '</div>';
        },

        _drawAttributionChart: function (a) {
            const el = document.getElementById('stressAttributionChart');
            if (!el || typeof echarts === 'undefined') return;

            const cats = a.perCategory.map(function (p) { return p.name; });
            const supply = a.perCategory.map(function (p) { return p.supply; });
            const connect = a.perCategory.map(function (p) { return p.connect; });

            const chart = echarts.init(el, null, { renderer: 'canvas' });
            chart.setOption({
                backgroundColor: 'transparent',
                grid: { left: 66, right: 24, top: 32, bottom: 30 },
                tooltip: {
                    trigger: 'axis',
                    axisPointer: { type: 'shadow' },
                    backgroundColor: 'rgba(13,27,61,0.94)',
                    borderColor: 'rgba(120,180,255,0.25)',
                    textStyle: { color: '#e6f0ff', fontSize: 12 }
                },
                legend: {
                    top: 2, left: 0, itemWidth: 12, itemHeight: 8,
                    textStyle: { color: '#8a9ec0', fontSize: 11 }
                },
                xAxis: {
                    type: 'value',
                    name: '采样点数',
                    nameTextStyle: { color: '#8a9ec0', fontSize: 11 },
                    axisLine: { show: false }, axisTick: { show: false },
                    axisLabel: { color: '#8a9ec0', fontSize: 11 },
                    splitLine: { lineStyle: { color: 'rgba(120,180,255,0.12)' } }
                },
                yAxis: {
                    type: 'category',
                    data: cats,
                    axisLine: { lineStyle: { color: 'rgba(120,180,255,0.25)' } },
                    axisTick: { show: false },
                    axisLabel: { color: '#8a9ec0', fontSize: 11 }
                },
                series: [
                    {
                        name: '供给缺口（需新建）',
                        type: 'bar', stack: 'total', barWidth: 16,
                        itemStyle: { color: '#185fa5' },
                        data: supply
                    },
                    {
                        name: '连通缺口（需打通）',
                        type: 'bar', stack: 'total', barWidth: 16,
                        itemStyle: { color: '#ffb547' },
                        data: connect
                    }
                ]
            });
        },

        /* ================================================================
         * 地图图层：步行阻抗场
         *
         * 沿用 GapFinder 的做法——用 Canvas 覆盖层一次性画完全部栅格点，
         * 而不是给每个点加一个矢量覆盖物（栅格点动辄上千，矢量层会明显掉帧）。
         * ================================================================ */

        _imp: { visible: false, wrapper: null, canvas: null, listeners: [], result: null },

        /**
         * 在地图上叠加阻抗场图层
         * 颜色由冷到暖（蓝 → 黄 → 红）表示该处"直线距离被路网放大"的程度；
         * 透明度表示该结论的置信度——离真实路网观测点越远，越依赖空间外推，画得越淡。
         */
        showImpedanceLayer: function (map, gapResult) {
            this.hideImpedanceLayer(map);
            const field = gapResult && gapResult._lambdaField;
            const grid = gapResult && gapResult._grid;
            if (!map || !field || !grid || !field.conf) return false;

            this._imp.result = gapResult;
            if (!this._imp.wrapper) this._ensureImpedanceDom(map);
            if (!this._imp.wrapper) return false;

            this._imp.wrapper.style.display = 'block';
            this._imp.visible = true;
            this._drawImpedance(map);
            return true;
        },

        hideImpedanceLayer: function (map) {
            this._imp.visible = false;
            if (this._imp.canvas) {
                try {
                    const ctx = this._imp.canvas.getContext('2d');
                    ctx.clearRect(0, 0, this._imp.canvas.width, this._imp.canvas.height);
                } catch (e) { /* 忽略 */ }
            }
            if (this._imp.wrapper) this._imp.wrapper.style.display = 'none';
        },

        /** 解绑事件并移除图层（切换地图实例时调用，防止内存泄漏） */
        destroyImpedanceLayer: function (map) {
            this.hideImpedanceLayer(map);
            if (map) {
                this._imp.listeners.forEach(function (pair) {
                    try { map.removeEventListener(pair[0], pair[1]); } catch (e) { /* 忽略 */ }
                });
            }
            this._imp.listeners = [];
            if (this._imp.wrapper && this._imp.wrapper.parentNode) {
                this._imp.wrapper.parentNode.removeChild(this._imp.wrapper);
            }
            this._imp.wrapper = null;
            this._imp.canvas = null;
            this._imp.result = null;
        },

        _ensureImpedanceDom: function (map) {
            const container = map.getContainer();
            if (!container) return;

            const wrapper = document.createElement('div');
            wrapper.className = 'stress-overlay';
            // ⚠ 层级同 GapFinder：地图底图由 z-index:0 的 WebGL canvas 绘制，覆盖层必须取 z-index:1
            //   才能画在它上面；同时低于 BMapGL 控件/版权（z-index 5/8/10），pointer-events:none 不挡交互。
            wrapper.style.cssText = 'position:absolute; top:0; left:0;'
                + 'width:' + map.getSize().width + 'px; height:' + map.getSize().height + 'px;'
                + 'pointer-events:none; z-index:1; display:none;';

            const canvas = document.createElement('canvas');
            canvas.style.cssText = 'display:block;width:100%;height:100%;';
            wrapper.appendChild(canvas);

            // 追加到容器末尾（不遮挡 POI 图标由透明度和指针穿透保证，而非靠压在地图下方）
            container.appendChild(wrapper);

            this._imp.wrapper = wrapper;
            this._imp.canvas = canvas;

            const self = this;
            const onMove = function () { if (self._imp.visible) self._drawImpedance(map); };
            ['movestart', 'moving', 'moveend', 'zoomstart', 'zoomend', 'resize'].forEach(function (ev) {
                map.addEventListener(ev, onMove);
                self._imp.listeners.push([ev, onMove]);
            });
        },

        _drawImpedance: function (map) {
            const result = this._imp.result;
            if (!map || !this._imp.canvas || !result || !this._imp.visible) return;

            const size = map.getSize();
            const w = size.width, h = size.height;
            const dpr = Math.max(1, global.devicePixelRatio || 1);

            if (this._imp.canvas.width !== Math.round(w * dpr)
                || this._imp.canvas.height !== Math.round(h * dpr)) {
                this._imp.canvas.width = Math.round(w * dpr);
                this._imp.canvas.height = Math.round(h * dpr);
                this._imp.canvas.style.width = w + 'px';
                this._imp.canvas.style.height = h + 'px';
                this._imp.wrapper.style.width = w + 'px';
                this._imp.wrapper.style.height = h + 'px';
            }

            const ctx = this._imp.canvas.getContext('2d');
            ctx.clearRect(0, 0, this._imp.canvas.width, this._imp.canvas.height);

            const cells = result._grid.cells;
            const field = result._lambdaField;
            const lo = field.range.min, hi = field.range.max;
            const span = Math.max(1e-6, hi - lo);

            const maxN = 1600;
            const stride = cells.length > maxN ? Math.ceil(cells.length / maxN) : 1;
            const zoom = (typeof map.getZoom === 'function') ? map.getZoom() : 15;
            const rBase = Math.max(2.5, Math.min(7, (zoom - 11) * 0.9)) * dpr;

            for (let i = 0; i < cells.length; i += stride) {
                const cell = cells[i];
                let px;
                try { px = map.pointToOverlayPixel(new BMapGL.Point(cell.lng, cell.lat)); }
                catch (e) { continue; }
                if (!px) continue;

                const x = px.x * dpr, y = px.y * dpr;
                if (x < -20 || x > this._imp.canvas.width + 20
                    || y < -20 || y > this._imp.canvas.height + 20) continue;

                // λ 归一化到 [0,1] → 色相从 210°(蓝) 到 0°(红)
                const t = Math.max(0, Math.min(1, (field.value[i] - lo) / span));
                const hue = 210 * (1 - t);
                // 透明度表达置信度：离观测点越远越淡
                const alpha = 0.2 + (field.conf[i] || 0.15) * 0.45;

                ctx.beginPath();
                ctx.arc(x, y, rBase, 0, Math.PI * 2);
                ctx.fillStyle = 'hsla(' + hue.toFixed(0) + ', 85%, 55%, ' + alpha.toFixed(2) + ')';
                ctx.fill();
            }
        },

        /** 左侧面板摘要（λ 区间 + 精度指标，与地图图层配套） */
        renderSummary: function (containerId, gapResult) {
            const box = document.getElementById(containerId);
            if (!box) return;
            const f = gapResult && gapResult.lambdaField;
            if (!f || !f.range) {
                box.innerHTML = '<p class="gap-empty muted">完成体检后自动生成：'
                    + '按实测的「直线 vs 步行」样本重建空间变异绕行系数，并在地图上叠加阻力图层。</p>';
                return;
            }
            const loo = f.loocv;
            const html = []
                .concat([
                    '<div class="im-row"><span>路网观测点</span><b>' + f.observationCount + ' 条</b></div>',
                    '<div class="im-row"><span>λ 实测区间</span><b>' + f.range.min.toFixed(2)
                        + ' ~ ' + f.range.max.toFixed(2) + '</b></div>',
                    '<div class="im-row"><span>λ 均值</span><b>' + f.range.mean.toFixed(2) + '</b></div>',
                    loo ? ('<div class="im-row"><span>精度自证 MAE</span><b>' + loo.mae.toFixed(3)
                        + '</b></div>') : '',
                    loo && loo.rmse != null ? ('<div class="im-row"><span>精度自证 RMSE</span><b>'
                        + loo.rmse.toFixed(3) + '</b></div>') : '',
                    loo && loo.improveMae != null ? ('<div class="im-row"><span>相对全局常数改进率</span><b>'
                        + '+' + Math.round(loo.improveMae * 100) + '%</b></div>') : '',
                    '<div class="im-row"><span>平均判定置信度</span><b>'
                        + Math.round(f.confMean * 100) + '%</b></div>'
                ]).join('');
            box.innerHTML = html
                + '<p class="im-note muted">颜色越暖表示该处直线与实际步行差距越大；'
                + '透明度越低表示离实测观测点越远、结论越依赖空间外推。'
                + '完整的绕行举证见报告「应力测试」页。</p>';
        },

        /** 导出纯文本（供报告复制 / 打印时并入） */
        toPlainText: function (data) {
            const d = data || this.lastResult;
            if (!d || !d.ok) return '';
            const L = [];
            L.push('【生活圈应力测试】');
            if (d.collapse && d.collapse.ok) {
                L.push('① 可达性塌缩曲线');
                L.push(' - 临界步速 Vc：' + (d.collapse.criticalSpeed == null
                    ? ('>' + V_MAX + ' m/min（全部步速下均不达标）')
                    : d.collapse.criticalSpeed + ' m/min'));
                L.push(' - 步行基准达标率：' + Math.round(d.collapse.rateAtWalk * 100) + '%');
                L.push(' - 轮椅基准达标率：' + Math.round(d.collapse.rateAtWheel * 100) + '%');
                if (d.collapse.mostFragile) {
                    L.push(' - 最先失守的类别：' + d.collapse.mostFragile.name);
                }
            }
            if (d.impedance && d.impedance.range) {
                L.push('② 步行阻抗场 λ(x,y)');
                L.push(' - 观测点：' + d.impedance.observationCount + ' 条');
                L.push(' - λ 区间：' + d.impedance.range.min.toFixed(2) + ' ~ ' + d.impedance.range.max.toFixed(2)
                    + '，均值 ' + d.impedance.range.mean.toFixed(2));
                if (d.impedance.loocv) {
                    const loo = d.impedance.loocv;
                    L.push(' - 精度自证：LOOCV 平均绝对误差 ' + loo.mae.toFixed(3)
                        + '、均方根误差 ' + loo.rmse.toFixed(3)
                        + (loo.improveMae == null ? '' : ('，相对全局常数 λ 改进率 '
                            + Math.round(loo.improveMae * 100) + '%')));
                }
                (d.impedance.topDetours || []).forEach(function (x, i) {
                    L.push(' - 绕行实证 ' + (i + 1) + '：直线 ' + x.straight + ' m → 实际 ' + x.walk + ' m（λ ' + x.lambda.toFixed(2) + '）');
                });
            }
            if (d.tristate && d.tristate.counts) {
                const c = d.tristate.counts;
                L.push('③ 隐性盲区与判定置信度');
                L.push(' - 正常覆盖 ' + c.cover + ' 点 / 隐性盲区 ' + c.hidden + ' 点 / 显性盲区 ' + c.explicit + ' 点');
                L.push(' - 盲区平均判定置信度：' + Math.round((d.tristate.confMean || 0) * 100) + '%');
            }
            if (d.attribution && d.attribution.ok) {
                L.push('④ 缺设施 vs 缺路');
                L.push(' - 不达标采样点：' + d.attribution.totalBad + ' 个（供给缺口 ' + d.attribution.totalSupply
                    + ' / 连通缺口 ' + d.attribution.totalConnect + '）');
                L.push(' - ' + d.attribution.headline);
                (d.attribution.openList || []).slice(0, 3).forEach(function (s, i) {
                    L.push(' - 打通点 ' + (i + 1) + '：' + s.title + '（绕行损失 ' + Math.round(s.totalLoss)
                        + ' m，涉及 ' + s.categoryCount + ' 类）');
                });
            }
            return L.join('\n');
        }
    };

    /* ====================================================================
     * 模块内部实现
     * ==================================================================== */

    /**
     * 模块 1：可达性塌缩曲线
     *
     * 用同一批「居住点 → 最近设施」的实测距离，把达标率写成步速 v 的连续函数：
     *     rate_c(v) = |{p : dist_p / v ≤ stdMinutes_c}| / N_c
     * dist 来自真实步行路网，因此同一条记录可以按任意步速重算，无需重复请求地图服务。
     */
    function collapseCurve(access) {
        if (!access || !access.ok || !access.detail) return { ok: false };

        const cats = global.ACCESS_CATEGORIES || [];
        const groups = [];

        cats.forEach(function (c) {
            const arr = access.detail[c.key] || [];
            const usable = arr.filter(function (r) {
                return r && typeof r.dist === 'number' && r.dist > 0;
            });
            if (!usable.length) return;
            groups.push({
                key: c.key, name: c.name, icon: c.icon,
                stdMinutes: usable[0].stdMinutes,
                recs: usable
            });
        });

        if (!groups.length) return { ok: false };

        const all = [];
        groups.forEach(function (g) { g.recs.forEach(function (r) { all.push(r); }); });

        const speeds = [];
        for (let v = V_MIN; v <= V_MAX; v += V_STEP) speeds.push(v);

        // 某步速下的达标率：dist / v 得到行走分钟，与该类国标分钟阈值比对
        const rateAt = function (recs, v) {
            let pass = 0;
            for (let i = 0; i < recs.length; i++) {
                if (recs[i].dist / v <= recs[i].stdMinutes) pass++;
            }
            return recs.length ? pass / recs.length : 0;
        };

        const overallSeries = speeds.map(function (v) { return rateAt(all, v); });

        // 临界步速：达标率跌破门槛时所在的步速。Vc 越高，说明社区越"挑人"
        const criticalOf = function (series) {
            for (let i = 0; i < series.length; i++) {
                if (series[i] >= RATE_THRESHOLD) return speeds[i];
            }
            return null;   // 即使最快也不达标
        };

        const walkSpeed = (global.getActiveSpeed ? global.getActiveSpeed() : 80) || 80;
        const wheelType = (global.WALK_TYPES || []).find(function (t) { return t.key === 'wheel'; });
        const wheelSpeed = wheelType ? wheelType.speed : 40;

        const perCategory = groups.map(function (g) {
            const series = speeds.map(function (v) { return rateAt(g.recs, v); });
            return {
                key: g.key, name: g.name, icon: g.icon,
                stdMinutes: g.stdMinutes,
                series: series,
                criticalSpeed: criticalOf(series),
                rateAtWalk: rateAt(g.recs, walkSpeed),
                rateAtWheel: rateAt(g.recs, wheelSpeed)
            };
        });

        // 最先失守 = 临界步速最高（或对高速也已低分）的那一类
        let fragile = null;
        perCategory.forEach(function (p) {
            const score = p.criticalSpeed == null ? (V_MAX + 1) : p.criticalSpeed;
            if (!fragile || score > fragile._score) {
                fragile = { name: p.name, key: p.key, _score: score };
            }
        });

        return {
            ok: true,
            speeds: speeds,
            overallSeries: overallSeries,
            perCategory: perCategory,
            criticalSpeed: criticalOf(overallSeries),
            rateAtWalk: rateAt(all, walkSpeed),
            rateAtWheel: rateAt(all, wheelSpeed),
            sampledPoints: all.length,
            mostFragile: fragile ? { name: fragile.name, key: fragile.key } : null,
            walkSpeed: walkSpeed,
            wheelSpeed: wheelSpeed
        };
    }

    /**
     * 模块 4：缺口归因（供给缺口 vs 连通缺口）
     *
     * 判定口径与 accessibility.js 的达标判定完全一致，保证两处结论不会互相矛盾：
     *     不达标  ⟺  dist / v0 > stdMinutes  ⟺  dist > v0 × stdMinutes
     * 其中 v0 为主分析人群步速。
     */
    function attribution(access) {
        if (!access || !access.ok || !access.detail) return { ok: false };

        const cats = global.ACCESS_CATEGORIES || [];
        const v0 = (global.getActiveSpeed ? global.getActiveSpeed() : 80) || 80;

        const perCategory = [];
        const siteMap = new Map();     // 目标设施 → 累计绕行损失
        let totalBad = 0, totalSupply = 0, totalConnect = 0;

        cats.forEach(function (c) {
            const arr = access.detail[c.key] || [];
            let bad = 0, supply = 0, connect = 0, detourSum = 0, n = 0;

            arr.forEach(function (r) {
                if (!r || typeof r.dist !== 'number' || r.dist <= 0) return;
                n++;
                const threshold = v0 * (r.stdMinutes || Math.max(1, Math.round((c.stdRadius || 500) / 80)));
                if (r.dist <= threshold) return;   // 达标，不参与归因

                bad++;
                const straight = (typeof r.straight === 'number' && r.straight > 0) ? r.straight : null;

                if (straight == null) {
                    // 缺少直线距离时无法区分两类缺口，保守计入供给缺口
                    supply++;
                    return;
                }

                if (straight > threshold) {
                    supply++;                       // 设施本身就在足够远的地方，新建才是解
                } else {
                    connect++;                      // 设施直线够得着，是路不通把它变成走不到
                    const loss = r.dist - straight;
                    detourSum += Math.max(0, loss);

                    if (r.nearest && r.nearest.point) {
                        const k = r.nearest.title + '|' + r.nearest.point.lng.toFixed(5) + ',' + r.nearest.point.lat.toFixed(5);
                        let rec = siteMap.get(k);
                        if (!rec) {
                            rec = {
                                title: r.nearest.title,
                                lng: r.nearest.point.lng,
                                lat: r.nearest.point.lat,
                                totalLoss: 0, points: 0,
                                catKeys: new Set()
                            };
                            siteMap.set(k, rec);
                        }
                        rec.totalLoss += Math.max(0, loss);
                        rec.points += 1;
                        rec.catKeys.add(c.key);
                    }
                }
            });

            totalBad += bad;
            totalSupply += supply;
            totalConnect += connect;

            perCategory.push({
                key: c.key, name: c.name, icon: c.icon,
                total: n, bad: bad, supply: supply, connect: connect,
                avgDetour: connect ? detourSum / connect : 0
            });
        });

        if (!totalBad) return { ok: false };

        const openList = Array.from(siteMap.values())
            .sort(function (a, b) { return b.totalLoss - a.totalLoss; })
            .slice(0, 5)
            .map(function (s) {
                return {
                    title: s.title, lng: s.lng, lat: s.lat,
                    totalLoss: s.totalLoss, points: s.points,
                    categoryCount: s.catKeys.size,
                    action: suggestAction(s)
                };
            });

        const connectRatio = totalBad ? totalConnect / totalBad : 0;

        return {
            ok: true,
            totalBad: totalBad,
            totalSupply: totalSupply,
            totalConnect: totalConnect,
            connectRatio: connectRatio,
            perCategory: perCategory,
            openList: openList,
            headline: buildHeadline(connectRatio, totalBad, totalSupply, totalConnect)
        };
    }

    /**
     * 按累计绕行损失给出建议动作，让清单从"描述问题"变成"可执行项"
     */
    function suggestAction(site) {
        if (site.totalLoss >= 600) {
            return '绕行损失偏大，建议核查是否存在断头路或被封闭阻断，优先增设人行通道或开放社区内部步行路径';
        }
        if (site.totalLoss >= 300) {
            return '建议在直线方向上增设人行横道、过街天桥或无障碍坡道，压缩绕行距离';
        }
        return '建议优化沿街人行道连续性，拆除占道障碍，缩短实际步行路径';
    }

    function buildHeadline(ratio, bad, supply, connect) {
        const pct = Math.round(ratio * 100);
        if (bad === 0) return '未发现不达标采样点。';
        if (pct >= 60) {
            return '在 ' + bad + ' 个不达标采样点中，<b>' + Math.round(pct) + '%</b>（' + connect
                + ' 个）的问题<b>不是没有这座设施，而是走不过去</b>——'
                + '该类缺口靠新建无法根治，应优先研究打通步行通道。';
        }
        if (pct >= 30) {
            return '在 ' + bad + ' 个不达标采样点中，' + supply + ' 个属于设施本身过远（需新建），'
                + connect + ' 个属于有设施但走不过去（需打通），两类手段需并行推进。';
        }
        return '在 ' + bad + ' 个不达标采样点中，绝大多数（' + supply + ' 个）是设施直线距离本身过远，'
            + '应以新增布点为主要手段。';
    }

    /* ---------------- 图表工具 ---------------- */

    /**
     * 给系列附加"当前主分析人群 / 轮椅人群"所在的步速参考线，
     * 让读数者一眼看出自己关心的那类人落在曲线的什么位置。
     */
    function decorateSeries(series, markSpeed, c) {
        const first = series[0];
        if (!first) return series;
        first.markLine = {
            silent: true,
            symbol: 'none',
            data: [
                markSpeed(c.walkSpeed, '主分析人群 ' + c.walkSpeed, '#5b9bff'),
                markSpeed(c.wheelSpeed, '轮椅 ' + c.wheelSpeed, '#ff5470')
            ]
        };
        return series;
    }

    /* ---------------- 展示工具 ---------------- */

    function kpiCard(label, value, unit, color) {
        return '<div class="stress-kpi">'
            + '<div class="sk-label">' + esc(label) + '</div>'
            + '<div class="sk-value" style="color:' + color + '">' + value
            + (unit ? '<span class="sk-unit">' + esc(unit) + '</span>' : '') + '</div>'
            + '</div>';
    }

    function colorOfRate(v) {
        return v >= 0.85 ? '#00d68f' : v >= 0.7 ? '#3a7afe' : v >= 0.55 ? '#ffb547' : '#ff5470';
    }

    function nameOfKey(k) {
        const c = (global.POI_CATEGORIES || []).find(function (x) { return x.key === k; });
        return c ? c.name : (k || '配套');
    }

    function esc(s) {
        return (s == null ? '' : String(s))
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    global.Stress = Stress;
})(window);
