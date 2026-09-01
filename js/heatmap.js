/**
 * 配套设施热力图（地图图层）
 *
 * 实现思路：使用 simpleheat 在地图容器上叠加一个透明 canvas，
 * 监听地图的 move/zoom 事件，每次重画 heatmap 点位。
 * 这样既避免了 BMapGL.CustomLayer 内部 canvas 坐标系复杂的问题，
 * 又保证点位随地图缩放/平移实时跟随（不是静态图）。
 *
 * 数据源：POI 分类 → 每类不同权重（医院 4 > 商超 3 > 学校/药店 2 > 公交 1）
 */
(function (global) {
    'use strict';

    const Heatmap = {

        wrapper: null,
        canvas: null,
        heat: null,
        map: null,
        data: [],
        maxWeight: 1,      // simpleheat alpha 归一化基准（= 数据中最大权重）
        visible: false,
        mapListeners: [],

        /**
         * 初始化热力图 DOM 与 simpleheat
         */
        ensureDom: function (map) {
            if (this.wrapper && this.canvas && this.heat) return true;
            if (typeof simpleheat === 'undefined') {
                console.warn('[Heatmap] simpleheat 未加载，热力图功能不可用');
                return false;
            }
            this.map = map;

            const container = map.getContainer();

            const wrapper = document.createElement('div');
            wrapper.className = 'heatmap-overlay';
            wrapper.style.cssText = `
                position: absolute; top: 0; left: 0;
                width: ${map.getSize().width}px; height: ${map.getSize().height}px;
                pointer-events: none;
                z-index: 4;
                display: none;`;

            const canvas = document.createElement('canvas');
            canvas.style.cssText = 'display:block;width:100%;height:100%;';
            wrapper.appendChild(canvas);
            container.appendChild(wrapper);

            this.wrapper = wrapper;
            this.canvas = canvas;
            this.heat = simpleheat(canvas);

            // simpleheat 0.0.1 的 _colorize 末尾做了 `imgd.data = imgd.data` 这种无用赋值。
            // Chrome 95+ 之后 ImageData.data 变成只读属性，赋值直接抛 TypeError，
            // 导致整个 draw() 失败、热力图一片透明。直接 monkey-patch 掉这一行。
            this.heat._colorize = function () {
                const img = this._ctx.getImageData(0, 0, this._width, this._height);
                const e = img.data;
                const a = this._palette;
                for (let h = 3, r = e.length; h < r; h += 4) {
                    const t = 4 * e[h];
                    if (t) {
                        e[h - 3] = a[t];
                        e[h - 2] = a[t + 1];
                        e[h - 1] = a[t + 2];
                    }
                }
                // 不要再做 img.data = e 的多余赋值
                this._ctx.putImageData(img, 0, 0);
            };

            // 注意：simpleheat 0.0.1 只有 data/radius/gradient/draw 四个公开方法，
            // 没有 opacity()、clear() —— 透明度只能靠 gradient 里的 alpha 通道控制。
            // 另外 data(points, max) 的第二个参数 max 必须传，否则内部
            // globalAlpha = weight / undefined = NaN，热力图会完全画不出来。
            this.heat.radius(28, 18);
            this.heat.gradient({
                0.15: 'rgba(58,122,254,0.00)',
                0.35: 'rgba(58,122,254,0.45)',
                0.55: 'rgba(0,214,143,0.70)',
                0.75: 'rgba(255,181,71,0.85)',
                1.00: 'rgba(255,84,112,0.95)'
            });

            const onMove = () => this.refresh();
            map.addEventListener('movestart', onMove);
            map.addEventListener('moving', onMove);
            map.addEventListener('moveend', onMove);
            map.addEventListener('zoomstart', onMove);
            map.addEventListener('zoomend', onMove);
            map.addEventListener('resize', onMove);
            this.mapListeners.push(['movestart', onMove], ['moving', onMove],
                ['moveend', onMove], ['zoomstart', onMove],
                ['zoomend', onMove], ['resize', onMove]);

            return true;
        },

        /**
         * 设置热力图数据（[{lng,lat,weight}]）
         * 同时计算 maxWeight —— simpleheat 需要它做 alpha 归一化
         */
        setData: function (data) {
            this.data = data || [];
            let m = 1;
            for (const p of this.data) if (p.weight > m) m = p.weight;
            this.maxWeight = m;
            if (this.visible) this.refresh();
        },

        /**
         * 显示/隐藏热力图层
         */
        show: function (map) {
            if (!this.wrapper) {
                if (!this.ensureDom(map)) return false;   // simpleheat 未加载
            }
            this.visible = true;
            this.wrapper.style.display = 'block';
            this.refresh();
            return true;
        },

        hide: function () {
            this.visible = false;
            if (this.wrapper) this.wrapper.style.display = 'none';
        },

        toggle: function (map) {
            if (this.visible) { this.hide(); return false; }
            return this.show(map);   // 依赖缺失时返回 false，由调用方提示
        },

        /**
         * 重新按地图当前视口计算画布大小与点位
         */
        refresh: function () {
            if (!this.map || !this.visible || !this.heat || !this.canvas || !this.data) return;

            const map = this.map;
            const size = map.getSize();
            const w = size.width, h = size.height;

            // 适应高 DPI
            const dpr = Math.max(1, window.devicePixelRatio || 1);
            const needResize = (this.canvas.width !== Math.round(w * dpr)) ||
                               (this.canvas.height !== Math.round(h * dpr));

            if (needResize) {
                this.canvas.width = Math.round(w * dpr);
                this.canvas.height = Math.round(h * dpr);
                this.canvas.style.width = w + 'px';
                this.canvas.style.height = h + 'px';
                this.wrapper.style.width = w + 'px';
                this.wrapper.style.height = h + 'px';
                // simpleheat 在构造时缓存了 _width/_height，改变 canvas 尺寸后必须同步，
                // 否则 draw() 内部的 clearRect/getImageData 仍按旧尺寸处理。
                this.heat._canvas = this.canvas;
                this.heat._ctx = this.canvas.getContext('2d');
                this.heat._width = this.canvas.width;
                this.heat._height = this.canvas.height;
            }

            // 经纬度 → 画布屏幕像素。地图提供 pointToOverlayPixel(BMapGL.Point) 一步到位。
            const pts = [];
            for (const p of this.data) {
                let opx;
                try {
                    opx = map.pointToOverlayPixel(new BMapGL.Point(p.lng, p.lat));
                } catch (e) {
                    continue;
                }
                if (!opx) continue;
                const cw = this.canvas.width, ch = this.canvas.height;
                // overlayPixel 已经是容器像素；画布有 dpr 缩放 → 绘制坐标乘 dpr
                const x = opx.x * dpr, y = opx.y * dpr;
                if (x < -50 || x > cw + 50 || y < -50 || y > ch + 50) continue;
                pts.push([x, y, p.weight || 1]);
            }
            try {
                // 第二个参数 max 必须传（simpleheat 用 weight/max 计算 alpha）
                this.heat.data(pts, this.maxWeight);
                this.heat.draw();
            } catch (e) {
                console.warn('Heatmap draw fail:', e);
            }
        },

        /**
         * 清空热力图。simpleheat 没有 clear()，需要自己清画布
         */
        clear: function () {
            this.data = [];
            this.maxWeight = 1;
            if (this.heat && this.canvas) {
                try {
                    this.heat.data([], 1);
                    this.heat.draw();
                } catch (e) {
                    try {
                        const ctx = this.canvas.getContext('2d');
                        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
                    } catch (e2) {}
                }
            }
        }
    };

    global.Heatmap = Heatmap;
})(window);
