# 示例数据（满足任务书「配置好示例数据」要求）

本目录存放一份**真实体检导出快照** `sample-community.json`，
由「带百度 AK 真实体检」产出，作为仓库内置示例数据与对比测试报告的数据源。

> 本应用**基于百度地图开放能力在线运行**（地理编码 / POI 检索 / 路径规划），需要有效浏览器端 AK。
> 源码中 AK 为脱敏占位符 `__BMAP_AK__`，部署时由 CI 注入真实 Key。本目录数据**不用于运行时绕开百度**，
> 而是供 `scripts/gen-report-from-snapshot.js` 生成 `docs/真实对比测试报告.md` 的样例输入。

## 文件

- `sample-community.json` —— 当前内置**真实体检数据（北京·望京，评分 97/100）**，
  由「带百度 AK 真实体检」导出生成。

## 数据结构

快照与真实运行产物 100% 对齐，字段如下：

```jsonc
{
  "meta": { "name": "...", "city": "...", "address": "...", "note": "...", "generatedBy": "...", "generatedAt": "YYYY-MM-DD" },
  "center":   { "lng": 121.5057, "lat": 31.2453, "address": "..." },          // 体检中心点
  "samples":  [ { "lng": ..., "lat": ... }, ... ],                             // 等时圈多边形顶点（闭环）
  "area":     4610000,                                                         // 等时圈可达面积（m²）
  "resultByKey": {                                                            // 六类 POI
    "hospital": { "items": [ { "name": "...", "point": { "lng": ..., "lat": ... } }, ... ] },
    "pharmacy": { ... }, "market": { ... }, "store": { ... }, "school": { ... }, "bus": { ... }
  },
  "gapResult": { ... }                                                        // GapFinder.analyze 的完整返回值
}
```

`gapResult` 字段说明见 `js/gap.js` 末尾 `_buildResult` 注释。

## 当前数据说明

`data/sample-community.json` 当前已内置**真实体检数据（北京·望京，评分 97/100）**，
由「带百度 AK 真实体检」导出生成，开箱即用。

## 如需更换为其他社区数据

1. 配置 `config.local.js` 填入浏览器端 AK，或用已注入 AK 的线上 GitHub Pages；
2. 在 App 中输入目标社区地址，跑通一次完整体检；
3. 将本次结果整理为与上方结构一致的 `sample-community.json` 覆盖本目录
   （字段与真实运行产物对齐即可，可联系我协助导出）；
4. 运行 `node scripts/gen-report-from-snapshot.js` 一键刷新 `docs/真实对比测试报告.md` 数字。

> 说明：示例数据用于「评审方能快速跑通演示」与对比测试报告，应用本身始终在线调用百度地图真实路网。
