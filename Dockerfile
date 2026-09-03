# 15 分钟便民生活圈 · 智能体检可视化系统 —— 静态托管镜像
# 纯前端静态站点，用官方 nginx 镜像托管，零额外依赖、无需编译。
FROM nginx:alpine

# 复制项目静态文件到 nginx 默认根目录
# （.dockerignore 已排除 .git / node_modules / 测试与文档等，仅保留运行所需文件）
COPY . /usr/share/nginx/html

# 容器启动脚本：运行时从环境变量 BMAP_AK 注入百度 AK，再启动 nginx
COPY docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 百度地图 AK（浏览器端）。构建/运行均可传入，不写死进镜像。
# 用法：docker run -e BMAP_AK=你的AK -p 8080:80 life-circle
ENV BMAP_AK=""

EXPOSE 80

ENTRYPOINT ["/entrypoint.sh"]
