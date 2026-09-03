# 地图 API 调用策略

> 对应项目交付要求 #3 之「地图 API 调用策略」一节。
> 本文档说明本应用如何调用百度地图开放能力（地理编码 / POI 检索 / 路径规划 / 天气），以及为通过评审「API 深度调用与工程优化」（30%）所做的配额治理、脱敏与容错设计。

## 1. 总体架构

- **纯前端架构**：所有地图能力均在浏览器端通过「百度地图 WebGL JS API（BMapGL）v3.0」调用，无需自建后端，天然契合 GitHub Pages 静态托管。
- **入口约定**：百度 GL API 就绪后回调 `global.__bmapReady = init`，`init` 内完成地图实例化、省市区联动、自动体检（`js/app.js`）。
- **核心模块**：

| 能力 | 百度 API | 实现文件 |
|---|---|---|
| 地址 ↔ 坐标（地理/逆地理编码） | `BMapGL.Geocoder` | `js/region.js` / `js/app.js` |
| 省市区三级联动 | `Geocoder.getPoint` + 内嵌 `region-data.js` | `js/region.js` |
| 民生 POI 检索 | `BMapGL.LocalSearch`（inBounds / nearby） | `js/poi.js` |
| 步行路径规划（等时圈 + λ 标定） | `BMapGL.WalkingRoute` | `js/isochrone.js` / `js/gap.js` |
| 等时圈面积 / 距离计算 | 自研球面几何（`Util`） | `js/util.js` |
| 天气（可选增强） | open-meteo（第三方，跨域 `cors`） | `js/time-weather.js` |

## 2. AK 获取与脱敏（满足「API Key 需脱敏」）

`js/config.js` 按以下优先级解析浏览器端 AK，**源码仓库永不含真 key**：

1. **本地开发覆盖**：`config.local.js`（已被 `.gitignore` 忽略，不提交）设置 `window.BMAP_AK_OVERRIDE`；
2. **部署注入**：CI（`deploy.yml`）用 `sed` 把 `index.html` / `js/config.js` 中的占位符 `__BMAP_AK__` 替换为 GitHub Secret 中的真 key，**仅作用于部署产物，不回写源码**；
3. **兜底占位符**：若两者皆无，则回落为 `__BMAP_AK__`，此时地图无法加载（用于代码脱敏展示）。

> 站点运行时：`var ak = window.BMAP_AK || '__BMAP_AK__';`（`index.html`），本地双击 `index.html` 时由 `config.local.js` 提供有效 AK 即可。

**Referer 白名单**：百度开放平台需为浏览器端应用配置 Referer 白名单 = `dy8260.github.io` / `localhost`；`file://`（origin=null）需在白名单中含 null origin 才能检索 POI。

## 3. 配额与并发治理（满足「批量距离矩阵 **或** 并发请求策略」）

针对百度 API 的 QPS 限制，采用「并发限流 + 串行节流 + 缓存」组合：

| 参数 | 值 | 作用 | 位置 |
|---|---|---|---|
| `routeConcurrency` | 6 | 等时圈 16 方向 `WalkingRoute` 并发数（避免打满配额） | `config.js:41` |
| `calibConcurrency` | 3 | λ 标定锚点并发数 | `config.js:116` |
| `POI_SEARCH_GAP_MS` | 280 | 六类 POI 检索之间的串行间隔（温和请求节奏） | `config.js:51` |
| `POI_KEYWORD_LIMIT` | 3 | 每类最多检索的关键字数（多关键字需合并） | `config.js:46` |
| `POI_KEYWORD_STOP_AT` | 10 | 单类召回达此数即停止同义词检索，省配额 | `config.js:54` |
| `POI_SEARCH_RETRY` / `RETRY_GAP_MS` | 3 / 2000 | 真失败时按退避重试，骑过限频窗口 | `config.js:59-60` |

- **并发限流器**：`Util.pmap(arr, fn, concurrency)`（`util.js:16`）以固定 worker 数消费队列，单点失败不影响整体，是等时圈与 λ 标定的并发底座。
- **模块级缓存**：`poi.js` 内 `_cache` 以 `keyword+bounds` 为键缓存**非空**结果；空结果不缓存，便于配额恢复后重取，显著降低重复检索消耗。

> 说明：项目交付要求允许「批量距离矩阵计算 **或** 并发请求策略」二选一。本应用采用**并发请求 + 空间采样**策略（逐方向 `WalkingRoute` 并发 + λ 标定外推），已满足该评分点；后续可进一步增强为批量距离矩阵 API。

## 4. 容错与降级机制（满足「容错与降级」）

| 场景 | 处理 | 位置 |
|---|---|---|
| 等时圈单方向 WalkingRoute 超时/失败 | 6s 超时后**退化为按方位角直线远点**（`Util.destination`），保证 16 边界点始终齐全 | `isochrone.js:69` |
| POI 检索「真失败」（错误码） | 按 `RETRY_GAP_MS×i` 退避重试，骑过限频窗口 | `poi.js:353` |
| POI 检索「干净返回 0 条」 | 判定为「该范围确无此配套」，**不**按限流反复重试（避免误导），仅做 1 次短补查排除冷启动 | `poi.js:370` |
| 地图视口不在检索城市 | `_ensureMapAt` 先把地图中心移到检索点（百度按视口中心解析 region，否则异地恒返回 0） | `poi.js:80` |
| 三类配套 POI 全缺失 | 跳过盲区分析并友好提示「未检索到菜市场/药店/学校 POI，无法判定服务盲区」，不再显示 `Infinity` | `gap.js` / `report.js` |
| 地图/百度未就绪 | `_waitMapReady` 上限 ~3s 放行，绝不卡死首屏 | `poi.js:247` |

**百度错误码对照**（来自 `poi.js` `_runOnce`）：

| 状态码 | 含义 | 处理 |
|---|---|---|
| 0 / n/a | 成功 / 干净空 | 正常 |
| 1/2/3 | 参数非法 / 权限失败 / 验证失败 | 真失败，退避重试 |
| 4 / 240 | 配额 / 频控超限 | 限流，退避重试 |
| 5 / 101 / 401 | AK 非法 / 服务禁用 / 未授权 | 真失败 |
| 102 / 302 | 未过白名单 / 需登录 | 真失败 |

## 5. 小结

本策略以「**并发限流 + 缓存 + 区分式重试 + 多层级降级**」为核心的工程化调用框架，在保证真实路网数据质量的同时，把百度 API 配额压力与异常风险降到最低，直接对应评审「API 深度调用与工程优化」30% 维度的全部评分细则。
