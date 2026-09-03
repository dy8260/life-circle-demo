/**
 * 演示模式 · Canvas 离线地图渲染
 * ----------------------------------------------------------------
 * 无百度 AK / 离线时，用一张 Canvas 把「等时圈 + POI + 服务盲区」画出来，
 * 完全不依赖百度地图 JS API，也不需要联网。
 *
 * 调用方式（见 js/app.js 的 DemoMode）：
 *   const cv = DemoRender.mount(document.getElementById('map'));
 *   DemoRender.render(cv, { center, samples, resultByKey, gapResult });
 *   window.addEventListener('resize', () => DemoRender.refresh(cv));
 */
(function (global) {
    'use strict';

    const M_PER_DEG_LAT = 111320;

    const DemoRender = {
        /**
         * 在容器内创建铺满的 canvas（pointer-events:none，不挡住上层控件）
         * @returns {HTMLCanvasElement}
         */
        mount: function (container) {
            if (!container) return null;
            // 清掉上一次演示残留
            const old = container.querySelector('canvas.demo-canvas');
            if (old) old.remove();

            const cv = document.createElement('canvas');
            cv.className = 'demo-canvas';
            container.appendChild(cv);
            return cv;
        },

        /**
         * 渲染一次（同时缓存数据用于 resize 重绘）
         */
        render: function (canvas, data) {
            if (!canvas || !data) return;
            canvas.__demoData = data;
            this._draw(canvas);
        },

        /** resize 时重绘 */
        refresh: function (canvas) {
            if (canvas && canvas.__demoData) this._draw(canvas);
        },

        _draw: function (canvas) {
            const data = canvas.__demoData;
            if (!data) return;

            const rect = canvas.getBoundingClientRect();
            const W = Math.max(1, Math.round(rect.width));
            const H = Math.max(1, Math.round(rect.height));
            const dpr = Math.max(1, window.devicePixelRatio || 1);
            if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
                canvas.width = W * dpr;
                canvas.height = H * dpr;
            }
            const ctx = canvas.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, W, H);

            const center = data.center || {};
            const samples = data.samples || [];
            const resultByKey = data.resultByKey || {};
            const gap = data.gapResult || {};

            // —— 计算投影范围（覆盖等时圈 + POI + 盲区，留 8% 边距）——
            let minLng = center.lng, maxLng = center.lng, minLat = center.lat, maxLat = center.lat;
            const eat = (p) => {
                if (!p || typeof p.lng !== 'number' || typeof p.lat !== 'number') return;
                if (p.lng < minLng) minLng = p.lng;
                if (p.lng > maxLng) maxLng = p.lng;
                if (p.lat < minLat) minLat = p.lat;
                if (p.lat > maxLat) maxLat = p.lat;
            };
            samples.forEach(eat);
            Object.keys(resultByKey).forEach(k => {
                (resultByKey[k].items || []).forEach(it => it && it.point && eat(it.point));
            });
            (gap.gapPoints || []).forEach(eat);

            const spanLng = (maxLng - minLng) || 1e-4;
            const spanLat = (maxLat - minLat) || 1e-4;
            const pad = 0.08;
            const padLng = spanLng * pad, padLat = spanLat * pad;
            minLng -= padLng; maxLng += padLng; minLat -= padLat; maxLat += padLat;

            const cosMid = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180) || 1;
            const projW = (maxLng - minLng) * cosMid;
            const projH = (maxLat - minLat);
            const scale = Math.min(W / projW, H / projH) || 1;
            const offX = (W - projW * scale) / 2;
            const offY = (H - projH * scale) / 2;

            const px = (lng, lat) => ({
                x: offX + (lng - minLng) * cosMid * scale,
                y: offY + (maxLat - lat) * scale   // 纬度反转（屏幕 y 向下）
            });

            // —— 背景 ——
            const grad = ctx.createLinearGradient(0, 0, 0, H);
            grad.addColorStop(0, '#0c1733');
            grad.addColorStop(1, '#091123');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, W, H);

            // —— 等时圈多边形 ——
            if (samples.length >= 3) {
                ctx.beginPath();
                samples.forEach((p, i) => {
                    const q = px(p.lng, p.lat);
                    if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
                });
                ctx.closePath();
                ctx.fillStyle = 'rgba(58,122,254,0.14)';
                ctx.fill();
                ctx.lineWidth = 2;
                ctx.strokeStyle = 'rgba(91,155,255,0.85)';
                ctx.stroke();
            }

            // —— 各类 POI 点 ——
            const cats = global.POI_CATEGORIES || [];
            cats.forEach(cat => {
                const g = resultByKey[cat.key];
                if (!g || !g.items) return;
                g.items.forEach(it => {
                    if (!it.point) return;
                    const q = px(it.point.lng, it.point.lat);
                    ctx.beginPath();
                    ctx.arc(q.x, q.y, 3.2, 0, Math.PI * 2);
                    ctx.fillStyle = cat.color || '#5b9bff';
                    ctx.fill();
                    ctx.lineWidth = 1;
                    ctx.strokeStyle = 'rgba(7,15,35,0.7)';
                    ctx.stroke();
                });
            });

            // —— 服务盲区点位 ——
            const gaps = gap.gapPoints || [];
            const cap = (global.BLIND_GAP && global.BLIND_GAP.maxRenderPoints) || 1200;
            const stride = gaps.length > cap ? Math.ceil(gaps.length / cap) : 1;
            for (let i = 0; i < gaps.length; i += stride) {
                const p = gaps[i];
                const q = px(p.lng, p.lat);
                const severe = p.level === 2;
                ctx.beginPath();
                ctx.arc(q.x, q.y, severe ? 4 : 3, 0, Math.PI * 2);
                ctx.fillStyle = severe ? 'rgba(255,84,112,0.7)' : 'rgba(255,181,71,0.6)';
                ctx.fill();
                if (severe) {
                    ctx.beginPath();
                    ctx.arc(q.x, q.y, 7, 0, Math.PI * 2);
                    ctx.strokeStyle = 'rgba(255,84,112,0.35)';
                    ctx.lineWidth = 1;
                    ctx.stroke();
                }
            }

            // —— 优先改造斑块标签 ——
            (gap.patches || []).forEach((pt, i) => {
                if (!pt.centroid) return;
                const q = px(pt.centroid.lng, pt.centroid.lat);
                ctx.beginPath();
                ctx.arc(q.x, q.y, 9, 0, Math.PI * 2);
                ctx.lineWidth = 2;
                ctx.strokeStyle = 'rgba(255,84,112,0.9)';
                ctx.stroke();
                ctx.fillStyle = '#fff';
                ctx.font = 'bold 11px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(String(i + 1), q.x, q.y);
            });

            // —— 中心点 ——
            if (typeof center.lng === 'number') {
                const q = px(center.lng, center.lat);
                ctx.beginPath();
                ctx.arc(q.x, q.y, 6, 0, Math.PI * 2);
                ctx.fillStyle = '#ffffff';
                ctx.fill();
                ctx.lineWidth = 2.5;
                ctx.strokeStyle = '#3a7afe';
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(q.x - 10, q.y); ctx.lineTo(q.x + 10, q.y);
                ctx.moveTo(q.x, q.y - 10); ctx.lineTo(q.x, q.y + 10);
                ctx.strokeStyle = '#3a7afe';
                ctx.lineWidth = 1.5;
                ctx.stroke();
            }

            // —— 紧凑图例（左下）——
            this._legend(ctx, cats, W, H);
        },

        _legend: function (ctx, cats, W, H) {
            const items = (cats || []).map(c => ({ color: c.color, name: c.name }))
                .concat([{ color: '#ff5470', name: '重度盲区' }, { color: '#ffb547', name: '一般盲区' }]);
            if (!items.length) return;
            const lx = 12, ly = H - 12 - items.length * 16;
            ctx.font = '11px sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            items.forEach((it, i) => {
                const y = ly + i * 16;
                ctx.beginPath();
                ctx.arc(lx + 5, y, 4, 0, Math.PI * 2);
                ctx.fillStyle = it.color;
                ctx.fill();
                ctx.fillStyle = 'rgba(230,240,255,0.85)';
                ctx.fillText(it.name, lx + 14, y);
            });
        }
    };

    global.DemoRender = DemoRender;
})(window);
