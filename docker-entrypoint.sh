#!/bin/sh
# 容器启动入口：运行时注入百度地图 AK，随后启动 nginx 静态服务
# 说明：
#   - AK 不烧录进镜像，仅通过环境变量 BMAP_AK 传入，符合「源码不含真 key」脱敏要求
#   - 仅当 BMAP_AK 非空时才替换占位符 __BMAP_AK__
#   - 若未传 BMAP_AK，则保留占位符（地图无法加载，需自行配置）

set -e

if [ -n "$BMAP_AK" ]; then
  echo "[entrypoint] 注入 BMAP_AK 到 index.html / js/config.js ..."
  # 使用 | 作分隔符，避免 AK 中出现 / 时 sed 报错
  sed -i "s|__BMAP_AK__|$BMAP_AK|g" /usr/share/nginx/html/index.html /usr/share/nginx/html/js/config.js
  echo "[entrypoint] 注入完成"
else
  echo "[entrypoint] 未设置 BMAP_AK 环境变量，保留占位符（地图将不可用，请通过 -e BMAP_AK=... 传入）"
fi

echo "[entrypoint] 启动 nginx ..."
exec nginx -g 'daemon off;'
