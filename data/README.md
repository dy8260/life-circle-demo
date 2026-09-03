# 示例数据（离线演示用）

本目录存放演示模式的「快照」数据，供**无百度 AK / 离线 / clone 后**直接渲染完整报告，
无需联网、无需密钥。

## 文件

- `sample-community.json` —— 一份「贴合真实形态」的仿真快照（上海市·陆家嘴示意社区）。
  由 `scripts/gen-sample-data.js` 生成（固定随机种子，可复现）。

## 数据结构

快照与真实运行产物 100% 对齐，演示模式与真实模式走完全相同的渲染链
（`Dashboard` / `Report` / Canvas），字段如下：

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

`gapResult` 字段说明见 `js/gap.js` 末尾 `_buildResult` 注释；演示模式只用其中
`enabled / params / lambda* / gridCount / gapCount / severeCount / gapRatio /
gapAreaM2 / poiCount / gapPoints / patches / bottleneckCount / missingRate /
centerStatus` 等用于看板与报告的字段。

## 当前数据说明

`data/sample-community.json` 当前已内置**真实体检数据（北京·望京，评分 97/100）**，
由「带百度 AK 真实体检」导出生成，开箱即用。导出演示数据按钮已关闭，无需手动导出。

## 如需更换为其他社区数据

1. 配置 `config.local.js` 填入浏览器端 AK，或用已注入 AK 的线上 GitHub Pages；
2. 真实体检跑通后，在浏览器控制台执行 `DemoMode.export()` 即可下载本次快照
   （导出按钮已从界面移除，但 `capture` 仍会记录快照，控制台调用可直接导出）；
3. 将下载的 `sample-community.json` 覆盖本目录，重新打开即加载新数据；
4. 运行 `node scripts/gen-report-from-snapshot.js` 一键刷新 `docs/真实对比测试报告.md` 数字。

重新打开页面（或 `?demo=1`）即加载真实数据。「真实对比测试报告」
（`docs/真实对比测试报告.md`）也应基于这份真实快照重新核算数字。

## 重新生成仿真数据

```bash
node scripts/gen-sample-data.js
```

> 说明：仿真数据仅用于「无 AK 也能跑通完整演示」的兜底。评审最终应以
> 带 AK 的真实导出为准。
