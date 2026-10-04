/**
 * 报告导出：将体检报告（当前地址 / 对比）渲染为 PNG 长图或 PDF，便于分享与归档。
 * 依赖 lib/html2canvas.min.js 与 lib/jspdf.umd.min.js（均本地化，断网可用）。
 *
 * 关键设计：导出图与「打印」按钮弹出的窗口使用同一份浅色报告文档（buildPrintDoc），
 * 在隐藏 iframe 内渲染后由 html2canvas 截图，因此视觉与打印预览一致、排版干净，
 * 且只截报告正文 DOM（无百度地图 WebGL 画布、无跨域问题）。
 */
(function (global) {
    'use strict';

    // 与「打印」窗口完全一致的浅色报告文档样式（覆盖报告内所有用到的类）
    const PRINT_CSS = `
        * { box-sizing: border-box; }
        body{font-family:"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif;color:#0a1429;padding:40px;line-height:1.8;background:#fff;max-width:840px;margin:0 auto;}
        h1{margin:0 0 8px;font-size:22px;}
        .meta{color:#666;font-size:13px;margin-bottom:24px;}
        h4{border-left:4px solid #3a7afe;padding-left:10px;margin-top:24px;font-size:16px;color:#102a5c;}
        h5{margin:12px 0 6px;font-size:13px;color:#1a3a6b;}
        p{margin:8px 0;}
        ul,ol{padding-left:22px;}
        li{margin:4px 0;}
        .level{display:inline-block;padding:4px 12px;border-radius:8px;background:#3a7afe;color:#fff;font-size:14px;font-weight:600;}
        .muted{color:#888;font-size:13px;}
        .gap-none{color:#0a9d5b;font-weight:600;}
        .gp-meta{color:#999;font-size:12px;margin-top:2px;}
        code{background:#f0f3f8;padding:1px 5px;border-radius:4px;font-size:12px;}
        .report-header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:4px;flex-wrap:wrap;}
        .report-header h2{margin:0;font-size:20px;}
        .report-section{margin-bottom:8px;}
        .report-list{margin:6px 0;}
        table{width:100%;border-collapse:collapse;margin:10px 0;font-size:13px;}
        th,td{border:1px solid #dbe3f0;padding:6px 10px;text-align:left;}
        thead th{background:#eef3fb;color:#102a5c;font-weight:600;}
        .per-type-table td:first-child{font-weight:600;}
        .bd-table{border:none;}
        .bd-table td{border:none;padding:3px 6px;vertical-align:middle;}
        .bd-bar{width:55%;}
        .bd-bg{background:#eef1f6;border-radius:6px;height:10px;overflow:hidden;}
        .bd-fg{height:10px;border-radius:6px;}
        .bd-val{text-align:right;font-weight:600;}
        .bd-pct{color:#999;}
        .bd-help{font-size:12px;color:#888;}
        .nearest-summary ul{list-style:none;padding-left:0;}
        .nearest-summary li{display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px dashed #eef;gap:12px;}
        .bd-missing{color:#e23;}
        .bd-dist-near{color:#0a9d5b;font-style:normal;font-weight:600;}
        .bd-dist-mid{color:#e0a000;font-style:normal;font-weight:600;}
        .bd-dist-far{color:#e23;font-style:normal;font-weight:600;}
        .bd-dist-nan{color:#e23;}
        .pt-main{background:#3a7afe;color:#fff;font-size:11px;padding:1px 6px;border-radius:6px;margin-left:4px;}
        .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:middle;}
        .per-type-note{background:#f5f8ff;border-left:3px solid #3a7afe;padding:8px 12px;border-radius:6px;color:#334;margin-top:8px;}
        .score-breakdown{margin:8px 0;}
    `;

    /** 生成与「打印」窗口完全一致的浅色报告文档 HTML 字符串 */
    function buildPrintDoc(addr, html) {
        const title = addr || '生活圈体检报告';
        return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>'
            + escapeAttr(title) + ' · 体检报告</title>'
            + '<style>' + PRINT_CSS + '</style></head><body>'
            + '<h1>' + (global.WALK_MINUTES || 15) + ' 分钟便民生活圈体检报告</h1>'
            + '<p class="meta">' + escapeHtml(title) + '</p>'
            + html
            + '</body></html>';
    }

    function escapeHtml(s) {
        return (s == null ? '' : String(s))
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function escapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }

    function toast(msg) {
        if (global.toast) global.toast(msg);
        else console.log('[report-export]', msg);
    }

    /** 取当前激活 tab 对应的报告正文 HTML 与头部地址（单地址 / 对比 / 应力测试） */
    function getActiveReportHtml() {
        const activeTab = document.querySelector('.report-tabs .tab.active');
        const which = (activeTab && activeTab.dataset.tab) || 'single';
        const idOf = ({ compare: 'reportCompare', stress: 'reportStress' })[which] || 'reportSingle';
        const el = document.getElementById(idOf);
        if (!el) return null;
        const text = (el.textContent || '').trim();
        if (text.length < 30) return null;
        const addrEl = document.getElementById('reportAddr');
        const addr = (addrEl && addrEl.textContent) || '';
        return { html: el.innerHTML, addr: addr };
    }

    /** 把报告文档写进一个隐藏 iframe，返回 { doc, frame } */
    function renderToIframe(htmlStr) {
        return new Promise((resolve, reject) => {
            const f = document.createElement('iframe');
            f.setAttribute('aria-hidden', 'true');
            f.style.cssText = 'position:fixed;left:-10000px;top:0;width:880px;height:1400px;border:0;background:#fff;';
            document.body.appendChild(f);
            const doc = f.contentDocument || (f.contentWindow && f.contentWindow.document);
            if (!doc) { if (f.parentNode) f.parentNode.removeChild(f); return reject(new Error('iframe 文档不可用')); }
            doc.open();
            doc.write(htmlStr);
            doc.close();
            // 等样式/字体应用后再截图，避免截到未布局的空白
            setTimeout(() => resolve({ doc: doc, frame: f }), 200);
        });
    }

    /** 在隐藏 iframe 内渲染浅色报告并截图，返回 canvas */
    async function capture(report) {
        if (typeof global.html2canvas !== 'function') {
            throw new Error('html2canvas 组件未加载');
        }
        const { doc, frame } = await renderToIframe(buildPrintDoc(report.addr, report.html));
        try {
            // 两帧，确保 iframe 内容完成重排
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            return await global.html2canvas(doc.body, {
                scale: 2,
                backgroundColor: '#ffffff',
                useCORS: true,
                logging: false
            });
        } finally {
            if (frame && frame.parentNode) frame.parentNode.removeChild(frame);
        }
    }

    function safeFilename() {
        const addr = (document.getElementById('reportAddr') || {}).textContent || '';
        const base = (addr.replace(/[\\/:*?"<>|]/g, '_').trim() || '生活圈体检报告').slice(0, 40);
        return base + ' · ' + (global.WALK_MINUTES || 15) + '分钟生活圈';
    }

    let busy = false;

    async function exportImage() {
        if (busy) return;
        const report = getActiveReportHtml();
        if (!report) { toast('暂无可导出的报告'); return; }
        busy = true;
        toast('正在生成图片…');
        try {
            const canvas = await capture(report);
            const a = document.createElement('a');
            a.download = safeFilename() + '.png';
            a.href = canvas.toDataURL('image/png');
            document.body.appendChild(a); a.click(); a.remove();
            toast('已导出 PNG 长图');
        } catch (e) {
            console.error(e);
            toast('导出图片失败：' + e.message);
        } finally {
            busy = false;
        }
    }

    async function exportPdf() {
        if (busy) return;
        const report = getActiveReportHtml();
        if (!report) { toast('暂无可导出的报告'); return; }
        const ns = global.jspdf || global;
        const JsPDF = ns && ns.jsPDF;
        if (typeof JsPDF !== 'function') { toast('PDF 组件未加载'); return; }
        busy = true;
        toast('正在生成 PDF…');
        try {
            const canvas = await capture(report);
            const pdf = new JsPDF('p', 'mm', 'a4');
            const pageW = pdf.internal.pageSize.getWidth();
            const pageH = pdf.internal.pageSize.getHeight();
            const imgW = pageW;
            const imgH = canvas.height * imgW / canvas.width;
            const imgData = canvas.toDataURL('image/png');
            let heightLeft = imgH;
            let position = 0;
            pdf.addImage(imgData, 'PNG', 0, position, imgW, imgH);
            heightLeft -= pageH;
            while (heightLeft > 0) {
                position -= pageH;
                pdf.addPage();
                pdf.addImage(imgData, 'PNG', 0, position, imgW, imgH);
                heightLeft -= pageH;
            }
            pdf.save(safeFilename() + '.pdf');
            toast('已导出 PDF');
        } catch (e) {
            console.error(e);
            toast('导出 PDF 失败：' + e.message);
        } finally {
            busy = false;
        }
    }

    function bind() {
        const imgBtn = document.getElementById('btnReportImage');
        const pdfBtn = document.getElementById('btnReportPdf');
        if (imgBtn) imgBtn.addEventListener('click', exportImage);
        if (pdfBtn) pdfBtn.addEventListener('click', exportPdf);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();

    // 暴露 buildPrintDoc 供「打印」按钮复用，保证打印与导出视觉一致
    global.ExportReport = { image: exportImage, pdf: exportPdf, buildPrintDoc: buildPrintDoc };
})(window);
