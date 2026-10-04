# 地图 API 调用策略

> 本文档说明本应用如何调用百度地图开放能力（地理编码 / POI 检索 / 路径规划 / 天气），以及为控制配额、保证稳定性的治理、脱敏与容错设计。

## 1. 总体架构

- **纯前端架构**：所有地图能力均在浏览器端通过「百度地图 WebGL JS API（BMapGL）v3.0」调用，无需自建后端，天然契合静态站点托管。
- **入口约定**：GL API 就绪后回调 `global.__bmapReady = init`，`init` 内完成地图实例化、省市区联动、自动体检（`js/app.js`）。
- **核心模块**：

| 能力 | 百度 API | 实现文件 | 单次体检请求量级 |
|---|---|---|---|
| 地址 ↔ 坐标（地理/逆地理编码） | `BMapGL.Geocoder` | `js/region.js` / `js/app.js` | 1~2 |
| 省市区三级联动 | `Geocoder.getPoint` + 内嵌 `region-data.js` | `js/region.js` | 0（本地数据） |
| 民生 POI 检索 | `BMapGL.LocalSearch`（inBounds / nearby） | `js/poi.js` | 6 类 × 关键字数 |
| 步行路径规划（等时圈 + λ 标定） | `BMapGL.WalkingRoute` | `js/isochrone.js` / `js/gap.js` | 16 + ≤6 |
| **无障碍可达性实测** | `BMapGL.WalkingRoute` | `js/accessibility.js` | 采样点 × 5 类（见 §3.2） |
| 等时圈面积 / 距离计算 | 自研球面几何（`Util`） | `js/util.js` | 0 |
| 天气（可选增强） | open-meteo（第三方，跨域） | `js/time-weather.js` | 1 |
| 补建选址 / 归因决策 | — | `js/recommend.js` / `js/stress.js` | **0** |
| 快照导出 / 全屏 / 智能问答 | — | `js/export.js` / `js/fullscreen.js` / `js/assistant.js` | **0** |

> 后三行的加成：**选址建议、应力测试、智能问答、快照导出全部为纯本地计算**，不发起任何地图或网络请求。
> 它们消费的都是已经拿到的中间结果（`gapResult`、`fullPaths`、评分明细），因此追加功能不再增加配额压力。

## 2. AK 获取与脱敏

`js/config.js` 按以下优先级解析浏览器端 AK，**源码仓库永不含真 key**：

1. **本地开发覆盖**：`config.local.js`（已被 `.gitignore` 忽略，不提交）设置 `window.BMAP_AK_OVERRIDE`；
2. **部署注入**：CI（`deploy.yml`）用 `sed` 把 `index.html` / `js/config.js` 中的占位符 `__BMAP_AK__` 替换为仓库 Secret 中的真 key，**仅作用于部署产物，不回写源码**；
3. **兜底占位符**：若两者皆无，则回落为 `__BMAP_AK__`，此时地图无法加载（用于代码脱敏展示）。

> 站点运行时：`var ak = window.BMAP_AK || '__BMAP_AK__';`（`index.html`），本地打开时由 `config.local.js` 提供有效 AK 即可。

**Referer 白名单**：地图开放平台需为浏览器端应用配置 Referer 白名单（如 `localhost` 与部署域名）；`file://`（origin=null）需在白名单中含 null origin 才能检索 POI。

## 3. 配额与并发治理

### 3.1 核心参数

| 参数 | 值 | 作用 | 位置 |
|---|---:|---|---|
| `routeConcurrency` | 6 | 等时圈 16 方向路径规划并发数 | `config.js` `ISO` |
| `calibConcurrency` | 3 | λ 标定锚点并发数 | `config.js` `BLIND_GAP` |
| `calibAnchors` | 6 | λ 标定锚点数（单次体检真实路网观测数） | `config.js` `BLIND_GAP` |
| `ACCESS.concurrency` | 3 | 无障碍实测的路径规划并发数 | `config.js` `ACCESS` |
| `ACCESS.sampleMax` | 10 | 无障碍居住采样点上限 | `config.js` `ACCESS` |
| `ACCESS.timeoutMs` | 5000 | 单次无障碍实测超时 | `config.js` `ACCESS` |
| `POI_SEARCH_GAP_MS` | 280 | 六类 POI 检索之间的串行间隔 | `config.js` |
| `POI_KEYWORD_LIMIT` | 3 | 每类最多检索的关键字数 | `config.js` |
| `POI_KEYWORD_STOP_AT` | 60 | 单类召回达此数即停止同义词检索 | `config.js` |
| `POI_MAX_PAGES` | 2 | 单关键字最多翻页数（突破单页 50 条上限） | `config.js` |
| `POI_SEARCH_RETRY` / `RETRY_GAP_MS` | 3 / 2000 | 真失败时按退避重试 | `config.js` |

- **并发限流器**：`Util.pmap(arr, fn, concurrency)`（`util.js`）以固定 worker 数消费队列，单点失败不影响整体，是等时圈、λ 标定与无障碍实测共用的并发底座。
- **模块级缓存**：`poi.js` 内 `_cache` 以 `keyword+bounds` 为键缓存**非空**结果；空结果不缓存，便于配额恢复后重取。

### 3.2 单次体检配额核算

| 环节 | 请求次数 | 可否下调 |
|---|---:|---|
| 等时圈 16 向采样 | 16 | `sampleCount` |
| λ 标定锚点 | ≤ 6 | `calibAnchors` |
| 无障碍可达性实测 | 采样点 × 5 类，上限 10×5 = **50** | `sampleMax` / 关闭 `enabled` |
| POI 检索 | 6 类 × ≤3 关键字 × ≤2 页 | 各检索引擎参数 |
| 天气 | 1 | 可关闭 |

实务中无障碍采样点数由等时圈栅格按 `sampleMax` 降采样得到，密度高的小社区往往远小于 10（示例社区实际为 5 点 → 25 次）。
**合计量级约数十次路径规划**，全部可通过上述参数关闭或下调；把 `ACCESS.enabled` 置为 `false` 即可跳过无障碍实测（降级为直线估算）。

### 3.3 关于批量距离矩阵

浏览器端 AK 调用 Web 服务批量距离矩阵接口通常返回「服务被禁用」，因此本应用采用明确可行的等价路径：**少量并发路网请求 + 空间插值外推**。
λ 标定（6 次观测）把「逐点点×逐 POI」的 O(n·m) 请求压缩到常数级；无障碍实测则是按采样点而非逐个栅格点发起，同样遵循"观测少数、外推多数"的思路。

## 4. 容错与降级机制

| 场景 | 处理 | 位置 |
|---|---|---|
| 等时圈单方向路径规划超时/失败 | 6s 超时后**退化为按方位角直线远点**，保证 16 边界点始终齐全 | `isochrone.js` |
| λ 标定样本不足 / 全部失败 | 回落经验值 `λ=1.25`，标记 `lambdaFallback=true`，报告端提示估算值 | `gap.js` |
| 无障碍实测超时/失败 | 回落为 `直线距离 × λ`（`src='estimate'`）；该类无候选设施时记 `src='none'` | `accessibility.js` |
| POI 检索「真失败」（错误码） | 按 `RETRY_GAP_MS×i` 退避重试，骑过限频窗口 | `poi.js` |
| POI 检索「干净返回 0 条」 | 判定为「该范围确无此配套」，**不**反复重试（避免误导），仅做 1 次短补查 | `poi.js` |
| 地图视口不在检索城市 | `_ensureMapAt` 先把地图中心移到检索点（地图按视口中心解析 region） | `poi.js` |
| 三类配套 POI 全缺失 | 跳过盲区分析并提示「无法判定服务盲区」，不再显示 `Infinity` | `gap.js` / `report.js` |
| 地图/地图 SDK 未就绪 | `_waitMapReady` 上限 ~3s 放行，绝不卡死首屏 | `poi.js` |
| 空间插值精度不足 | LOOCV 给出负向改进率时不宣称精确，仅标记为待实地复核 | `gap.js` / `stress.js` |

**地图错误码对照**（`poi.js`）：

| 状态码 | 含义 | 处理 |
|---|---|---|
| 0 / n/a | 成功 / 干净空 | 正常 |
| 1/2/3 | 参数非法 / 权限失败 / 验证失败 | 真失败，退避重试 |
| 4 / 240 | 配额 / 频控超限 | 限流，退避重试 |
| 5 / 101 / 401 | AK 非法 / 服务禁用 / 未授权 | 真失败 |
| 102 / 302 | 未过白名单 / 需登录 | 真失败 |

## 5. 观测结果的复用（降低重复请求）

同一批观测会在模块间流转，避免重复付费：

```
Isochrone.build    → fullPaths（16 条完整路径）
   ├→ 多人群等时圈：换个 targetDist 重截断（+0 请求）
   └→ 无障碍分析的地域采样范围
accessibility      → lambdaPairs（真实路况 λ 样本）
   └→ gap.js refineLambdaField：回灌进 λ 空间场（+0 请求）
gapResult          → recommend.js 选址贪心（+0 请求）
                  → stress.js 归因决策树（+0 请求）
```

## 6. 小结

本策略以「**并发限流 + 缓存 + 区分式重试 + 多层级降级 + 观测复用**」为核心：
在保证真实路网数据质量的前提下，把单次体检的配额压力压到数十次请求，并且让后加入的分析能力（多人群、空间场、归因、选址、问答）全部建立在已有观测之上，做到功能增长不伴随配额增长。
