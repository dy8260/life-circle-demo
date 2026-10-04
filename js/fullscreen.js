/**
 * 区域全屏（页内最大化）
 *
 * 给地图、报告、右侧数据面板各加一个「⛶ 全屏」按钮，点击后该区域以
 * position:fixed; inset:0 铺满整个视口，方便投屏演示时查看完整内容；
 * 最大化后会在面板右上角自动出现一条醒目的「✕ 退出全屏」操作条，
 * 点击该条、点击原全屏按钮或按 Esc 均可退出。
 *
 * 关键实现：
 *   - 最大化时把目标元素临时挂到 document.body 下，使其跳出 .layout 等
 *     父容器的 stacking context，确保 z-index:9999 能真正覆盖 topbar。
 *   - 退出时按原位置恢复，保证后续布局不变。
 *   - 同一时刻仅一个区域最大化；最大化新区域前先还原旧的。
 *   - 地图区域最大化 / 还原后调用 global.__bmap.resize() 重算画布。
 */
(function (global) {
    'use strict';

    const ICON_MAX = '⛶ 全屏';       // 普通状态按钮文字
    const ICON_EXIT = '✕';            // 激活状态纯图标按钮文字
    const ICON_EXIT_TEXT = '✕ 退出';  // 激活状态文字按钮文字
    const EXIT_BAR_HTML = '<span class="fs-exit-ico">✕</span><span class="fs-exit-txt">退出全屏</span>';

    let activeEl = null;          // 当前已最大化的区域元素
    let activeBtn = null;         // 当前激活的全屏按钮
    let exitBarEl = null;         // 当前显示的退出操作条
    let originalParent = null;    // 最大化前原父元素
    let originalNext = null;      // 最大化前原下一个兄弟元素

    function getTarget(btn) {
        const sel = btn.getAttribute('data-target');
        return sel ? document.querySelector(sel) : null;
    }

    function resizeMapIfNeeded(el) {
        if (el && el.classList && el.classList.contains('map-panel') &&
            global.__bmap && typeof global.__bmap.resize === 'function') {
            // 等两帧让布局稳定后再通知百度地图重算画布尺寸
            requestAnimationFrame(function () {
                requestAnimationFrame(function () {
                    try { global.__bmap.resize(); } catch (e) { /* 忽略 */ }
                });
            });
        }
    }

    function removeExitBar() {
        if (exitBarEl && exitBarEl.parentNode) {
            exitBarEl.remove();
        }
        exitBarEl = null;
    }

    function createExitBar() {
        const bar = document.createElement('button');
        bar.type = 'button';
        bar.className = 'fs-exit-bar';
        bar.title = '退出全屏';
        bar.setAttribute('aria-label', '退出全屏');
        bar.innerHTML = EXIT_BAR_HTML;
        return bar;
    }

    function restore() {
        if (!activeEl) return;

        activeEl.classList.remove('is-maximized');
        removeExitBar();

        // 把元素移回原父容器（保持原来的 DOM 位置）
        if (originalParent) {
            if (originalNext && originalNext.parentNode === originalParent) {
                originalParent.insertBefore(activeEl, originalNext);
            } else {
                originalParent.appendChild(activeEl);
            }
        }

        if (activeBtn) {
            activeBtn.textContent = ICON_MAX;
            activeBtn.classList.remove('is-active');
        }

        resizeMapIfNeeded(activeEl);

        activeEl = null;
        activeBtn = null;
        originalParent = null;
        originalNext = null;
    }

    function maximize(btn, el) {
        // 若已有其它区域最大化，先还原
        if (activeEl && activeEl !== el) {
            restore();
        }

        // 记录原位置，用于退出时恢复
        originalParent = el.parentNode;
        originalNext = el.nextElementSibling;

        // 挂到 body，跳出 .layout 等父容器的 stacking context，才能覆盖 topbar
        document.body.appendChild(el);

        el.classList.add('is-maximized');
        btn.textContent = btn.classList.contains('fs-text-btn') || btn.classList.contains('fs-map-btn') ? ICON_EXIT_TEXT : ICON_EXIT;
        btn.classList.add('is-active');
        activeEl = el;
        activeBtn = btn;

        // 在最大化区域内部插入醒目的退出操作条（右上角）
        const bar = createExitBar();
        bar.addEventListener('click', restore);
        el.appendChild(bar);
        exitBarEl = bar;

        resizeMapIfNeeded(el);
    }

    function onBtnClick(btn) {
        const el = getTarget(btn);
        if (!el) return;
        if (el.classList.contains('is-maximized')) restore();
        else maximize(btn, el);
    }

    function initFullscreen() {
        const btns = document.querySelectorAll('.fs-btn');
        btns.forEach(function (btn) {
            // 初始状态统一为「⛶ 全屏」文字，避免 HTML 手写不一致
            if (btn.textContent.indexOf('全屏') === -1) btn.textContent = ICON_MAX;
            btn.addEventListener('click', function () { onBtnClick(btn); });
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && activeEl) restore();
        });
    }

    global.initFullscreen = initFullscreen;
})(window);
