# 15 分钟便民生活圈 · 智能体检可视化系统

> "评价一个小区好不好？15 分钟步行能到多少生活配套？" —— 一键生成可读可看的体检报告。

---

## 一、功能一览

| # | 模块 | 实现要点 |
|---|------|---------|
| 1 | 地址输入 → 自动定位 | `BMapGL.Geocoder` 解析为经纬度，支持手动城市下拉 |
| 2 | 15 分钟步行可达圈 | **真实路网**：中心点 16 方向 `BMapGL.WalkingRoute`，按 80m/min×15min 在路径上插值取点，连成不规则多边形（非简单圆形辐射） |
| 3 | 民生 POI 检索 | 六类：医院 / 药店 / 菜市场 / 商超 / 学校 / 公交，`BMapGL.LocalSearch` inBounds 检索 + 多关键字合并去重 |
| 4 | 配套热力图 | 自定义 Canvas 覆盖层 + simpleheat，权重：医院 > 菜市场 > 学校/药店 > 商超/公交 |
| 5 | 数据可视化看板 | ECharts 雷达图（实际 vs 理想 vs 最低）+ 柱状图（数量分布）+ 综合评分环 |
| 6 | 体检报告 | 根据 POI 数量 + 缺失惩罚自动打分，生成五段报告（概览 / 优势 / 不足 / **服务盲区识别** / 改造建议），支持复制 / 打印 |
| 7 | **服务盲区识别**（赛题核心指标） | 在 15 分钟等时圈内栅格化采样，用真实步行路网标定绕行系数 λ，以「直线距离 × λ」外推步行距离场，识别菜市场 / 药店 / 小学三类步行距离均 > 1 km 的连片盲区，并在地图 / 看板 / 报告中三处呈现（实现见 `js/gap.js`）。 |

---

## 二、技术栈
- 百度地图开放平台 **WebGL JS API v3.0**（地址解析 / 步行规划 / POI / 多边形 / 信息窗）
- **ECharts 5.4.3**（雷达 + 柱状图）
- **simpleheat 0.0.1**（轻量 canvas 热力图，叠加在地图容器上）
- 纯原生 HTML/CSS/JS（无构建工具，零依赖即可运行）

---

## 三、运行方式

### 方式 A：直接双击打开
```
双击 index.html（需联网，且浏览器允许 file:// 加载百度地图脚本）
```

### 方式 B（推荐，便于部署 / 跨设备访问）：本地 HTTP 服务

也可使用本地的零依赖脚本 `serve.js`（非仓库文件，需自行准备）：

```bash
cd 项目根目录
node serve.js
# 浏览器访问 http://127.0.0.1:8080
```

也可用其他工具：
```bash
npx serve -p 8080          # Node
python -m http.server 8080 # Python
```

> 推荐用 HTTP 方式而非 `file://`：百度地图 AK 若配置了 Referer 白名单，`file://` 协议会被拒绝。

### 方式 C：公网部署
- 阿里云 OSS / 腾讯 COS：把整个目录上传，开启静态网站托管
- Vercel：`vercel --prod`（先在项目根加 `vercel.json`）
- GitHub Pages：推送到 `master` 分支，由 GitHub Actions（`.github/workflows/deploy.yml`）自动注入百度 AK 并部署

> ⚠️ 把浏览器端 AK 暴露在前端是 demo 场景的常规做法，正式上线应在百度开放平台配置 **Referer 白名单**（如 `*.your-domain.com/*`）。

---

## 四、目录结构

```
（项目根目录）
├── index.html        # 主入口
├── css\
│   └── style.css     # 深色大屏 / 玻璃拟态
├── js\
│   ├── config.js     # AK / 主题色 / 等时圈参数 / POI 阈值
│   ├── util.js       # 距离 / 面积 / 并发限流
│   ├── heatmap.js    # 浮动 Canvas + simpleheat 热力图层
│   ├── isochrone.js  # 等时圈核心（多方向步行路径规划 + 弧长插值）
│   ├── poi.js        # 六类 POI 检索 + 渲染 + 多边形内点过滤
│   ├── gap.js        # 服务盲区识别（栅格采样 + λ 标定 + 距离场插值 + 连通斑块聚合）
│   ├── dashboard.js  # ECharts 图表 + POI 列表 + 评分环
│   ├── report.js     # 四段式体检报告
│   └── app.js        # 主流程串联
├── tests\
│   ├── gap-smoke.js       # 服务盲区识别 · 离线冒烟测试（无需浏览器/联网）
│   └── gap-integration.js # 整机数据契约测试
├── lib\
│   ├── echarts.min.js     # 本地副本（CDN 失败时自动回退）
│   └── simpleheat.min.js  # 本地副本
└── README.md
```

> `lib/` 是 CDN 的本地备份：`index.html` 会先加载 CDN，检测不到全局变量时用 `document.write` 回退到本地文件。**网络不稳时也能完整演示。**

---

## 五、自检

### 5.1 离线冒烟测试（无浏览器也能跑）

```bash
node tests/gap-smoke.js
```

该测试 mock 了百度地图 API 的返回结构，验证两条最容易「静默失效」的链路：

| 测试项 | 覆盖内容 |
|--------|---------|
| 等时圈路径提取 | 3 种 `WalkingRoute` 返回形态（官方 `results.getPlan(0).getRoute(0).getPath()`、经典 `route.getPlan(0)...`、`getPlan(0).getPath()`）|
| 边界点插值 | 1200m 落在折线第二段、插值比例 = 88/853 |
| POI 提取 | 4 种 `LocalSearch` 返回形态（`getCurrentNumPois`、`getNumPois`、内部数组、未知结构递归扫描）|
| 评分公式 | 全缺失 = 0 分，全达标 = 100 分 |
| 地理算法 | 距离 / 弧长插值 / 多边形面积（16 边形内接圆 4.409 km² vs 理论 4.524×0.9745 吻合）|
| simpleheat 调用 | `data/max/draw` 不产生 NaN alpha，归一化基准计算正确 |

### 5.2 真浏览器端到端测试（启动 Chromium 跑完整 6 类功能）

```bash
# 前置：装 puppeteer-core（puppeteer 体积太大，core 是无头控制核心，约 5MB）
npm install puppeteer-core

# 启动 http 服务（如未跑）
npx serve -p 8080 &

# 跑测试
node test/verify-e2e.js
```

测试脚本会：
1. 等百度地图 API 加载、init() 完成
2. 等 runAnalysis 全部跑完（等 POI 数量 > 0）
3. 抓取 6 个核心数据点（metaArea/scoreNum/scoreTag/poiTotal 等）
4. **点热力图按钮**，验证 canvas 像素非零占比（>30% 视为成功）
5. 截图保存到当前目录（默认 `demo-verify.png`）

实测数据样本（北京市朝阳区望京 SOHO，真实时钟 ~4s）：

| 指标 | 实测值 |
|------|--------|
| 流程耗时 | **4.0 s** |
| 可达面积 | **2.81 km²**（真实路网路径绕行后比圆形更小、更精准） |
| 综合评分 | **100 / 100**（优秀） |
| 配套总数 | **116 处**（缺失 0 类） |
| 医院 / 药店 / 商超 / 学校 / 公交 | **4 / 14 / 57 / 3 / 38** |
| 热力图画布 | **1016 × 498** |
| 热力图非零像素 | **38.73%**（覆盖到位） |

### 5.3 跑过的真问题（在测试中暴露，已修）

| # | 问题 | 根因 | 修复 |
|---|------|------|------|
| 1 | `ReferenceError: BMap is not defined` | `util.js` 用了裸 `BMap.Point`，百度 GL API 只暴露 `BMapGL` | 改返纯 `{lng,lat}` 字面量 |
| 2 | 16 路等时圈全部抛 `Cannot read 'lat'` | 百度 `WalkingRoute.search()` 必须接收 `BMapGL.Point` 实例，传 `{lng,lat}` 字面量时 SDK 内部 `_formatDestQuery30` 读 `.lat` 失败 | `isochrone.js` 调用前 `new BMapGL.Point(...)` 包一层 |
| 3 | `race-rescue` 提前设 `__inited=true` 导致 init() 第一句直接 return | init 内部 idempotent 检查与兜底顺序冲突 | 兜底不预设 flag，让 init 自己置位 |
| 4 | `Heatmap draw fail: read-only property 'data'` | simpleheat 0.0.1 做了 `imgd.data = imgd.data` 无用赋值，Chrome 95+ 抛错 | monkey-patch `_colorize` 跳过该赋值 |
| 5 | 热力图永远画不出（坐标错位） | `getProjection().lngLatToPoint(BMapGL.Pixel(...))` 类型错误 | 改 `map.pointToOverlayPixel(BMapGL.Point(...))` 一步到位 |

> 这 5 个问题都不抛到主 Console，只会让功能**静默失效**—— 是最难排查的类型。
> smoke-test.js 覆盖 mock 验证；verify-e2e.js 覆盖真实浏览器验证。

---

## 六、关键算法：真实路网等时圈

> **核心难点**：百度地图官方 API 没有直接给出"等时圈"接口。常见实现有两条路：
> ① 圆形辐射（误差大，会把河对岸、铁路对侧纳入可达区）
> ② 等距扇形（圆弧边界，无视路网）

我们采用 **多方向步行路径采样**：

1. 取 16 个均匀方向（每 22.5° 一个），每个方向放置一个 1.8 km 远的"远点"
2. 对每个方向调用 `BMapGL.WalkingRoute`，获取百度真实步行路径（已自动绕开高速、铁路、河流）
3. 在路径上按累计弧长找 `80 m/min × 15 min = 1200 m` 对应的点（用 `Util.pointAtDistance` 插值）
4. 16 个边缘点连成 polygon —— 形状随路网凹凸自然变化

> 步行速度 80 m/min 参照 2021 住建部《完整居住社区建设标准》及上海市《15 分钟社区生活圈规划导则》中老年人慢节奏的参考值。

代码见 `js/isochrone.js`，核心方法 `Isochrone.build(center, onProgress)`。

---

## 七、POI 缺失阈值设计

参照《完整居住社区建设标准》及多地《15 分钟生活圈规划导则》：

| 类别 | 最低 (min) | 理想 (ideal) | 评分权重 |
|------|--------|---------|--------|
| 医院 | 1 | 3 | 0.25 |
| 商超 | 2 | 4 | 0.20 |
| 学校 | 1 | 3 | 0.20 |
| 公交 | 1 | 3 | 0.20 |
| 药店 | 2 | 5 | 0.15 |

评分公式：
```
score = Σ (actual / ideal × 100 × weight)   # 未达 min 的类 score × 0.5 作为惩罚
```

可在 `js/config.js → POI_THRESHOLD` 调参。

---

---

## 九、API 调用与配额

| 接口 | 用法 | 限额说明 |
|------|------|--------|
| Geocoder | 1 次 / 体检 | 浏览器端默认 6000 次/分钟（一般远远不会触顶） |
| WalkingRoute | 16 次 / 体检（分 3 并发） | 默认 2000 次/分钟 |
| LocalSearch | 最多 6 类 × 3 关键字 = 18 次 / 体检 | 默认 2000 次/分钟 |
| WalkingRoute（盲区 λ 标定） | 6 次 / 体检（分 3 并发） | 默认 2000 次/分钟 |

如果担心 QPS，可把 `js/config.js` 中的 `routeConcurrency` 改小（如 2）或 `keywords` 改为只搜一个。

---

## 十二、v3.2.0 迭代：🆚 多小区对比模式

**为什么做？**：评分 v3.1.0 后有 20 分差距（望京 95 vs 密云 75），单点查询看不出"差异化价值"——用户想看"两个小区比怎么样"。

### 新增能力
- 顶部新增 **🆚 对比模式** 按钮，点击展开对比面板
- 同一时间支持 2~3 个对比地址，每个独立跑全链路（geocode → 等时圈 → POI → 评分）
- 报告区新增 **「🆚 对比报告 N」** tab，自动激活
- 对比报告含：
  - **🏆 排名表**：地址 / 综合分 / POI 数 / 可达面积 / 等级
  - **四维度分项对比**：每个维度用横向条形图展示所有对比地址；最高值加色
  - **文字总结**：自动生成"X 区领先 Y 分""优势维度""主要短板"
  - **改造建议**：每区一行，针对短板给出具体动作

### 实测样本
| 地址 | 评分 | POI | 面积 | 等级 |
|----|----|----|----|----|
| 🏆 望京 SOHO | **95** | 116 | 2.81 km² | 优秀 |
| 三里屯街道 | 90 | 118 | 2.05 km² | 优秀 |
| 密云新城子镇 | 75 | 18 | 1.02 km² | 一般 |

### 关键文件
- `js/compare.js`（**新增 ~340 行**）：addSlot/removeSlot/runAll/runOne/renderReport
- `index.html`：新增 🆚 按钮 + 对比槽 DOM + 报告 tab 切换
- `css/style.css`：`.compare-bar` / `.cmp-slot` / `.report-tabs` / `.compare-report-table`
- `js/app.js`：`runOneStandalone()` 暴露给对比模式复用，不动主流程 currentCenter/currentSamples

### 验证
- `test/verify-e2e-compare.js` **21/21 全过**
- v3.1.0 旧断言 17/17 仍通过（修复 `score is not defined` 引用泄漏）
- 冒烟 10/10

### 一个发现（值得记录）
清理技术债时把 `${it_score(b)}` 改为 `${score}`，但 `renderBreakdown(b)` 没有 `score` 参数 → `ReferenceError: score is not defined` → loader 卡住不隐藏 → e2e waitForFunction 永远超时。教训：**清理代码时必须确认每个变量的作用域来源**，删除辅助函数前先 grep 全部引用。

## 十一、v3.1.0 迭代

### 体验问题修复（你提的问题一一对应）

| 你的反馈 | 修复 | 验证 |
|--------|----|----|
| **1.** 右下角红色发光物不知是啥 | `🔧` emoji → **SVG 齿轮 + 文字"调试"**（不依赖 emoji 字体）；圆角胶囊状按钮；warn 状态才变红 | 默认蓝色显示；有错才红色发光 |
| **2.** 顶部 badge 显示啥可换？ | badge → **HUD 实时坐标**：版本v3.1.0 / 当前缩放 / 鼠标经纬度 / 路网采样进度 16/16；点击可折叠 | 鼠标移动 HUD 同步刷新经纬度 |
| **3.** 任何小区评分都 100 | 重写评分：**4 维加权 30/35/20/15%**（配套完整度 / 就近便利度 / 等时圈覆盖 / 类别多样性）+ 距离衰减曲线 | 望京 95 / 三里屯 90 / 密云 75 / 延庆 77（极差 20） |
| **4.** 不知道地址要写省市还是区 | 地址输入加 **ⓘ 提示按钮**：点击弹出 popover，详细列出**省/市/区/详细**四段格式 + 推荐示例 | 默认隐藏，点击 ⓘ 展开 |

### 评分算法升级要点

```js
// 旧版（v3.0）：单维度数量比，理想=100 封顶 → 任何城区都 100
let s = (n / th.ideal) * 100;          // ≤ ideal 就拿满分

// 新版（v3.1.0）：四维加权 + 距离衰减
//   维度一 配套完整度 30%    POI 数量达标度（4 段线性）
//   维度二 就近便利度 35%    距离衰减：≤200m=100, 500m=90, 1200m=55, 2000m=25, >3km=0
//   维度三 等时圈覆盖 20%    面积 < 1.0 km² 严重扣分
//   维度四 类别多样性 15%    全部类别齐全得满分（按实际类别数归一化，非写死系数）
const total = completeness * 0.30 + proximity * 0.35 + coverage * 0.20 + diversity * 0.15;
```

**诊断结果**（puppeteer 实测 4 个地点）：

| 地点 | 评分 | POI 数 | 面积 | 覆盖度 | 就近便利度 |
|------|----|------|----|----|----|
| 核心商务区（望京） | **95** | 116 | 2.81 km² | 93 | 96 |
| 中心城区（三里屯） | **90** | 118 | 2.05 km² | 64 | 99 |
| 远郊乡镇（密云） | **75** | 18 | 1.02 km² | 26 | 96 |
| 深山区（延庆） | **77** | 12 | 1.54 km² | 45 | 99 |

### 相关文件
- `index.html`：HUD + ⓘ popover + 调试按钮 改写
- `css/style.css`：HUD 样式 / popover 样式 / 调试按钮 SVG 样式
- `js/dashboard.js`：`calcScore(resultByKey, areaM2, center)` 4 维加权
- `js/app.js`：bindEvents 加入 ⓘ、HUD 监听；runAnalysis 传 center 给 calcScore
- `js/report.js`：报告接入 breakdown 条形图 + 最近距离明细
- `test/verify-e2e-v31.js`：**17/17 验收脚本**（含评分差异断言）

## 十、项目亮点
- ✅ **真实路网等时圈**（非圆形，业内常规做法但少有清晰表达）
- ✅ **多源数据联动**：地理编码 + 路径规划 + POI + 热力图 一站式可视化
- ✅ **可落地** ：阈值参照住建部国标，报告可直接打印交街道办
- ✅ **工程严谨** ：QPS 限流、错误兜底、超时降级、多版本 API 兼容
- ✅ **视觉风格** ：深色大屏 + 玻璃拟态 + ECharts 主题契合，适合大屏展示

---

## 十一、v2 迭代（2026-09-01）

### 4 项体验修复

| # | 问题 | 修复 | 涉及文件 |
|---|------|------|---------|
| 1 | 右下角持续刷 `【ERROR】:0 × Script error.` 弹窗，污染演示画面 | `__diag` 框改为**默认隐藏**（lazy-create），右下角放一个 `🔧` 小按钮，需要时点开 | `index.html` |
| 2 | 右侧看板在 1280×800 视口下内容溢出、卡片撑爆 | 压缩卡片内边距/字号/雷达高度；加 `1440 / 1280 / 980 / 640` 四档自适应断点；980px 以下单列堆叠 | `css/style.css` |
| 3 | 左上角"等时圈 / 热力图 / 3D / 全屏"4 个 emoji 按钮（竖排挤字） | 整个工具栏**移除**，替换为「实时时间 + 当前城市天气」双 widget —— 桌面顶部右上角，更有趣也更实用 | `index.html` `js/time-weather.js` `css/style.css` |
| 4 | 城市下拉只有 6 个固定选项，无法选"敦煌""满洲里"等 | 改 `<select>` 为 `<input list="cityList">` + `<datalist>`：**可输入任意国内地名，自动补全 104 个候选**；不在表内的城市由 `BMapGL.Geocoder` 反查坐标 | `index.html` `js/config.js` `js/app.js` `js/time-weather.js` |

### 实时时间 + 天气小部件（修改点 3）
- **时间**：本地时钟，每秒刷新 `HH:MM:SS` + `YYYY/MM/DD` + `星期X`，冒号每秒闪烁（CSS `steps(2)` 步进）
- **天气**：Open-Meteo 免费无 Key API（`/v1/forecast?current=temperature_2m,weather_code,...`），天气码 → emoji + 中文
- **城市匹配**：内置 104 个国内主要城市经纬度字典（4 直辖市 + 27 省会 + 计划单列市 + 重点旅游城市）；命中即查；未命中用 `BMapGL.Geocoder` 反查坐标兜底
- **刷新策略**：切换城市立即更新；后台每 10 分钟自动刷新

### 自适应断点（修改点 2）

| 视口宽度 | 布局策略 |
|---------|---------|
| ≥1440 px | 双列宽布局：地图 + 380px 看板 |
| ≤1440 px | 看板压到 340px，雷达 150px、柱状 130px |
| ≤1280 px | 顶栏去掉 meta 徽章，地址框 min-width 收紧 |
| ≤980 px | **单列堆叠**：地图 → 看板 → 报告（看板与报告均限制最大高度，可滚动） |
| ≤640 px | 时间/天气 widget 移到地图底部横排 |

### 真浏览器验证（`test/verify-e2e.js` v2）

13 项断言全部通过：

| 维度 | 验证项 | 结果 |
|------|-------|------|
| 修改① | 默认无 `__diag` 弹窗 + 右下角 `🔧` 按钮可见 | ✅ |
| 修改① | 点击 `🔧` 后诊断框可正常展开（display=block） | ✅ |
| 修改② | 4 张看板卡片（评分/配套/雷达/柱状）全部渲染 | ✅ |
| 修改② | 1280×800 窄屏下 4 张卡片仍可见 | ✅ |
| 修改② | 980×700 单列堆叠顺序 = 地图 → 看板 → 报告 | ✅ |
| 修改③ | 时间 widget 实时显示（13:08:16 2026/09/01 星期二） | ✅ |
| 修改③ | 天气 widget 显示 `☀️ 北京市 28°C 晴 36% 4.9km/h` | ✅ |
| 修改④ | citySelect = `<input list="cityList">`，datalist 候选 104 个 | ✅ |
| 修改④ | 列表内城市（敦煌）切天气：温度/描述即时更新 | ✅ |
| 修改④ | 列表外城市（满洲里）也能切：触发 Geocoder 反查坐标 | ✅ |

### 实测样本（2026-09-01 13:08）

| 指标 | v1 | v2（迭代后） |
|------|----|----|
| 错误弹窗 | 持续刷 Script error. | ✅ 默认无 |
| 默认 1440×900 看板 | 溢出/挤压 | ✅ 4 卡片可滚动全见 |
| 1280×800 适配 | 卡片被截断 | ✅ 全部可见 |
| 980×700 适配 | 双列被压扁 | ✅ 单列堆叠 |
| 城市可选范围 | 6 个 | ✅ 104 + 任意键入 |
| 工具栏 | 4 按钮 | ✅ 实时时间 + 天气 |

新增文件：`js/time-weather.js`（实时时间 + Open-Meteo 天气）
变更文件：`index.html` `css/style.css` `js/config.js` `js/app.js` `test/verify-e2e.js`
