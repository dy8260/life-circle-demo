/**
 * 省 / 市 / 区 三级联动选择器
 *
 * 数据来源：window.REGION_DATA（js/region-data.js，全国 31 省级 / 342 地级市 / 3056 区·县，离线内嵌，自动生成）
 * API:
 *   RegionPicker.bind(provEl, cityEl, areaEl, { initial: { prov, city, area } })  绑定三级下拉并级联
 *   RegionPicker.composedAddr(provEl, cityEl, areaEl, detailEl)  拼「省+市+区+详细」地址串（送百度 geocoder）
 *   RegionPicker.cityOnly(provEl, cityEl)  仅取城市名（送天气）
 *
 * 设计要点：
 *   - 占位 option 用 disabled + selected + hidden，下拉不可选
 *   - 父级未选时子级 select 自动 disabled（视觉一目了然）
 *   - 直辖市（省下只有 1 个"市辖区"）自动选中并禁用"市"下拉，直接让用户选区，少点一次
 *   - composedAddr 自动跳过「市辖区 / 县」这类冗余市名，地址串更准（"北京市朝阳区望京SOHO"）
 */
(function (global) {
    'use strict';

    // 直辖市/特殊地区的"市"级是占位名，拼地址时应跳过
    const SKIP_CITY = { '市辖区': 1, '县': 1, '': 1 };

    const RegionPicker = {
        /**
         * 绑定一组三级下拉
         */
        bind: function (provEl, cityEl, areaEl, initial) {
            if (!provEl || !cityEl || !areaEl) return;
            const data = global.REGION_DATA || {};

            fillSelect(provEl, Object.keys(data), '——省——');

            const onProvChange = () => {
                const prov = provEl.value;
                const cities = (data[prov] && data[prov].cities) || [];
                fillSelect(cityEl, cities.map(c => c.name), '——市——');
                fillSelect(areaEl, [], '——区——', '请先选择上级');
                areaEl.disabled = true;

                // 直辖市优化：仅 1 个市且名为"市辖区/县" → 自动选中并禁用市下拉，直接出区
                if (cities.length === 1 && SKIP_CITY[cities[0].name]) {
                    cityEl.value = cities[0].name;
                    cityEl.disabled = true;
                    onCityChange();
                } else {
                    cityEl.disabled = !prov;
                }
            };
            const onCityChange = () => {
                const prov = provEl.value;
                const city = cityEl.value;
                const cities = (data[prov] && data[prov].cities) || [];
                const cur = cities.find(c => c.name === city);
                const areas = (cur && cur.areas) || [];
                if (areas.length > 0) {
                    fillSelect(areaEl, areas, '——区——');
                    areaEl.disabled = false;
                } else {
                    fillSelect(areaEl, [], '——区——', '该城市暂无区/县数据');
                    areaEl.disabled = true;
                }
            };

            provEl.addEventListener('change', onProvChange);
            cityEl.addEventListener('change', onCityChange);

            // 初始值（兼容直辖市：数据里北京市的“市”是“市辖区”，但用户可能传“北京市”）
            if (initial && initial.prov && data[initial.prov]) {
                setSelectValue(provEl, initial.prov);
                onProvChange();
                if (initial.city) {
                    const cities = (data[initial.prov] && data[initial.prov].cities) || [];
                    const cityExists = cities.some(c => c.name === initial.city);
                    if (!cityExists && cities.length === 1 && SKIP_CITY[cities[0].name]) {
                        setSelectValue(cityEl, cities[0].name);  // 直辖市自动落到“市辖区”
                    } else {
                        setSelectValue(cityEl, initial.city);
                    }
                    onCityChange();
                    if (initial.area) setSelectValue(areaEl, initial.area);
                }
                // 注意：初始化完成时不再 dispatch 'change'，避免再次触发 onCityChange 清空已选的区。
                // 外部需要刷新天气/状态请在 bind 返回后自行调用。
            } else if (data['北京市']) {
                setSelectValue(provEl, '北京市');
                onProvChange();
                cityEl.dispatchEvent(new Event('change', { bubbles: true }));
            }
        },

        /** 拼「省 + 市 + 区 + 详细」为百度 geocoder 用的地址串（跳过冗余市名） */
        composedAddr: function (provEl, cityEl, areaEl, detailEl) {
            const parts = [
                provEl && provEl.value,
                (cityEl && cityEl.value && !SKIP_CITY[cityEl.value]) ? cityEl.value : null,
                areaEl && areaEl.value,
                detailEl && detailEl.value && detailEl.value.trim()
            ].filter(Boolean);
            return parts.join('');
        },

        /**
         * 程序化回填省/市/区（定位功能用）
         * 复用 bind 初始化块的级联逻辑，但不重复挂监听。
         * addr: { prov | province, city, area | district }
         * 返回 true 表示省已在本地数据中并成功回填；false 表示省未命中（调用方应降级处理，如仅居中地图）
         */
        applyAddress: function (provEl, cityEl, areaEl, addr) {
            if (!provEl || !cityEl || !areaEl || !addr) return false;
            const data = global.REGION_DATA || {};
            let prov = addr.prov || addr.province || '';
            const city = addr.city || '';
            const area = addr.area || addr.district || '';
            // 容错：百度偶尔返回带「市/省」后缀或简称，模糊匹配本地省份 key
            if (!data[prov]) {
                const base = prov.replace(/[市省]$/, '');
                const hit = Object.keys(data).find(k => {
                    const kb = k.replace(/[市省]$/, '');
                    return k === prov || kb === base || k.indexOf(base) >= 0 || base.indexOf(kb) >= 0;
                });
                if (hit) prov = hit;
            }
            if (!data[prov]) return false;

            // 0. 先回填省下拉（否则省停留在默认值，市/区却变了，出现「北京市泰安市」的错位）
            provEl.disabled = false;
            provEl.value = prov;

            // —— 复刻 bind 的 onProvChange 填充逻辑（不触发 change 事件）——
            const cities = (data[prov] && data[prov].cities) || [];
            fillSelect(cityEl, cities.map(c => c.name), '——市——');
            fillSelect(areaEl, [], '——区——', '请先选择上级');
            areaEl.disabled = true;
            if (cities.length === 1 && SKIP_CITY[cities[0].name]) {
                cityEl.value = cities[0].name;
                cityEl.disabled = true;
                const cur = cities[0];
                const areas = (cur && cur.areas) || [];
                if (areas.length > 0) { fillSelect(areaEl, areas, '——区——'); areaEl.disabled = false; }
                else { fillSelect(areaEl, [], '——区——', '该城市暂无区/县数据'); areaEl.disabled = true; }
            } else {
                cityEl.disabled = !prov;
            }

            // —— 复刻 bind 初始值的 city/area 设置（含直辖市兜底）——
            if (city) {
                const citiesNow = (data[prov] && data[prov].cities) || [];
                const cityExists = citiesNow.some(c => c.name === city);
                if (!cityExists && citiesNow.length === 1 && SKIP_CITY[citiesNow[0].name]) {
                    setSelectValue(cityEl, citiesNow[0].name);   // 直辖市自动落到「市辖区」
                } else {
                    setSelectValue(cityEl, city);
                }
                const cur = citiesNow.find(c => c.name === cityEl.value);
                const areas = (cur && cur.areas) || [];
                if (areas.length > 0) { fillSelect(areaEl, areas, '——区——'); areaEl.disabled = false; }
                else { fillSelect(areaEl, [], '——区——', '该城市暂无区/县数据'); areaEl.disabled = true; }
                if (area) setSelectValue(areaEl, area);
                // 直辖市：仅一个市（市辖区/县）时禁用市级下拉，与初始绑定行为一致
                if (citiesNow.length === 1 && SKIP_CITY[citiesNow[0].name]) cityEl.disabled = true;
            }
            return true;
        },

        /** 仅取「市」名（用于天气小部件） */
        cityOnly: function (provEl, cityEl) {
            if (cityEl && cityEl.value && !SKIP_CITY[cityEl.value]) return cityEl.value;
            if (provEl && provEl.value) return provEl.value;
            return '';
        }
    };

    /**
     * 填充一个 select
     */
    function fillSelect(el, items, placeholder, emptyText) {
        el.innerHTML = '';
        const opt0 = document.createElement('option');
        opt0.value = '';
        opt0.textContent = (items.length === 0 && emptyText) ? emptyText : placeholder;
        opt0.disabled = true;
        opt0.selected = true;
        opt0.hidden = true;
        el.appendChild(opt0);
        items.forEach(name => {
            const o = document.createElement('option');
            o.value = name;
            o.textContent = name;
            el.appendChild(o);
        });
    }

    /**
     * 安全设置 select 值：直接设置每个 option 的 selected 属性
     *（避免 placeholder option 的 selected=true 干扰 el.value 赋值）
     */
    function setSelectValue(el, value) {
        if (!el || value == null) return;
        const str = String(value);
        for (let i = 0; i < el.options.length; i++) {
            el.options[i].selected = (el.options[i].value === str);
        }
    }

    global.RegionPicker = RegionPicker;
})(window);
