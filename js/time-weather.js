/**
 * 实时时间 + 当前城市天气
 *  - 时间：本地时钟每秒刷新
 *  - 天气：先用 config.js 中内置的城市经纬度（覆盖 4 直辖市 + 27 省会 + 计划单列/重点城市等），
 *          命中即直接查 Open-Meteo；未命中再用百度 Geocoder 反查坐标。
 *  - Open-Meteo 免费、无 Key、支持 CORS；天气码 → emoji + 中文描述。
 */
(function (global) {
    'use strict';

    /* ========== 国内主要城市经纬度（覆盖直辖市/省会/计划单列/重点旅游城市） ========== */
    var CITY_COORDS = {
        // 直辖市
        '北京市':   { lng: 116.4074, lat: 39.9042 }, '上海':  { lng: 121.4737, lat: 31.2304 },
        '上海市':   { lng: 121.4737, lat: 31.2304 }, '天津':  { lng: 117.1901, lat: 39.1255 },
        '天津市':   { lng: 117.1901, lat: 39.1255 }, '重庆':  { lng: 106.5516, lat: 29.5630 },
        '重庆市':   { lng: 106.5516, lat: 29.5630 },
        // 省会
        '石家庄':   { lng: 114.5149, lat: 38.0428 }, '太原':  { lng: 112.5489, lat: 37.8706 },
        '呼和浩特': { lng: 111.7519, lat: 40.8414 }, '沈阳':  { lng: 123.4315, lat: 41.8057 },
        '长春':     { lng: 125.3245, lat: 43.8868 }, '哈尔滨': { lng: 126.6424, lat: 45.7569 },
        '南京':     { lng: 118.7969, lat: 32.0603 }, '杭州':  { lng: 120.1551, lat: 30.2741 },
        '合肥':     { lng: 117.2272, lat: 31.8206 }, '福州':  { lng: 119.2965, lat: 26.0745 },
        '南昌':     { lng: 115.8581, lat: 28.6832 }, '济南':  { lng: 117.1201, lat: 36.6512 },
        '郑州':     { lng: 113.6254, lat: 34.7466 }, '武汉':  { lng: 114.3055, lat: 30.5928 },
        '长沙':     { lng: 112.9388, lat: 28.2278 }, '广州':  { lng: 113.2644, lat: 23.1291 },
        '南宁':     { lng: 108.3669, lat: 22.8170 }, '海口':  { lng: 110.3312, lat: 20.0311 },
        '成都':     { lng: 104.0668, lat: 30.5728 }, '贵阳':  { lng: 106.7135, lat: 26.5783 },
        '昆明':     { lng: 102.8329, lat: 24.8801 }, '拉萨':  { lng: 91.1409, lat: 29.6500 },
        '兰州':     { lng: 103.8343, lat: 36.0611 }, '西宁':  { lng: 101.7782, lat: 36.6171 },
        '银川':     { lng: 106.2309, lat: 38.4872 }, '乌鲁木齐':{ lng: 87.6168, lat: 43.8256 },
        // 计划单列市 / 副省级 / 重点城市
        '深圳':     { lng: 114.0579, lat: 22.5431 }, '宁波':  { lng: 121.5440, lat: 29.8683 },
        '厦门':     { lng: 118.0894, lat: 24.4798 }, '青岛':  { lng: 120.3826, lat: 36.0671 },
        '大连':     { lng: 121.6147, lat: 38.9140 }, '苏州':  { lng: 120.5853, lat: 31.2989 },
        '无锡':     { lng: 120.3119, lat: 31.4912 }, '常州':  { lng: 119.9740, lat: 31.8113 },
        '南通':     { lng: 120.8943, lat: 31.9802 }, '扬州':  { lng: 119.4129, lat: 32.3936 },
        '镇江':     { lng: 119.4250, lat: 32.1889 }, '盐城':  { lng: 120.1633, lat: 33.3497 },
        '徐州':     { lng: 117.1851, lat: 34.2618 }, '连云港':{ lng: 119.2216, lat: 34.5963 },
        '温州':     { lng: 120.6720, lat: 28.0007 }, '绍兴':  { lng: 120.5820, lat: 30.0301 },
        '嘉兴':     { lng: 120.7506, lat: 30.7623 }, '金华':  { lng: 119.6474, lat: 29.0782 },
        '台州':     { lng: 121.4208, lat: 28.6560 }, '舟山':  { lng: 122.1068, lat: 29.9710 },
        '合肥':     { lng: 117.2272, lat: 31.8206 }, '芜湖':  { lng: 118.3551, lat: 31.3349 },
        '泉州':     { lng: 118.6757, lat: 24.8741 }, '漳州':  { lng: 117.6471, lat: 24.5130 },
        '烟台':     { lng: 121.4480, lat: 37.4638 }, '潍坊':  { lng: 119.1619, lat: 36.7068 },
        '淄博':     { lng: 118.0548, lat: 36.8135 }, '威海':  { lng: 122.1206, lat: 37.5128 },
        '临沂':     { lng: 118.3564, lat: 35.1046 }, '济宁':  { lng: 116.5871, lat: 35.4154 },
        '洛阳':     { lng: 112.4540, lat: 34.6197 }, '开封':  { lng: 114.3413, lat: 34.7972 },
        '宜昌':     { lng: 111.2864, lat: 30.6919 }, '襄阳':  { lng: 112.1205, lat: 32.0090 },
        '株洲':     { lng: 113.1313, lat: 27.8358 }, '湘潭':  { lng: 112.9090, lat: 27.8654 },
        '岳阳':     { lng: 113.1289, lat: 29.3576 }, '衡阳':  { lng: 112.5722, lat: 26.8943 },
        '珠海':     { lng: 113.5767, lat: 22.2707 }, '汕头':  { lng: 116.6822, lat: 23.3535 },
        '佛山':     { lng: 113.1214, lat: 23.0218 }, '东莞':  { lng: 113.7518, lat: 23.0207 },
        '中山':     { lng: 113.3824, lat: 22.5159 }, '惠州':  { lng: 114.4168, lat: 23.1115 },
        '江门':     { lng: 113.0817, lat: 22.5787 }, '湛江':  { lng: 110.3594, lat: 21.2707 },
        '柳州':     { lng: 109.4280, lat: 24.3263 }, '桂林':  { lng: 110.2907, lat: 25.2736 },
        '三亚':     { lng: 109.5117, lat: 18.2528 }, '北海':  { lng: 109.1198, lat: 21.4733 },
        '绵阳':     { lng: 104.6796, lat: 31.4677 }, '德阳':  { lng: 104.3979, lat: 31.1268 },
        '南充':     { lng: 106.1105, lat: 30.8373 }, '宜宾':  { lng: 104.6233, lat: 28.7513 },
        '达州':     { lng: 107.4682, lat: 31.2098 }, '遵义':  { lng: 106.9373, lat: 27.7253 },
        '大理':     { lng: 100.2257, lat: 25.5969 }, '丽江':  { lng: 100.2336, lat: 26.8721 },
        '西双版纳': { lng: 100.7971, lat: 22.0017 }, '敦煌':  { lng: 94.6614, lat: 40.1421 },
        '喀什':     { lng: 75.9897,  lat: 39.4677 }, '吐鲁番':{ lng: 89.1840,  lat: 42.9476 },
        '吐鲁番市': { lng: 89.1840,  lat: 42.9476 },
        '香格里拉': { lng: 99.7066,  lat: 27.8261 }, '日喀则':{ lng: 88.8851,  lat: 29.2674 },
        '延安':     { lng: 109.4905, lat: 36.5856 }, '榆林':  { lng: 109.7412, lat: 38.2862 },
        '宝鸡':     { lng: 107.2370, lat: 34.3621 }, '咸阳':  { lng: 108.7050, lat: 34.3293 },
        '天水':     { lng: 105.7249, lat: 34.5805 }, '石嘴山':{ lng: 106.3833, lat: 38.9841 },
        '克拉玛依': { lng: 84.8898,  lat: 45.5959 }, '库尔勒':{ lng: 86.1454,  lat: 41.7631 },
        '香港':     { lng: 114.1694, lat: 22.3193 }, '澳门':  { lng: 113.5439, lat: 22.1987 },
        '台北':     { lng: 121.5654, lat: 25.0330 }
    };

    /* ========== Open-Meteo 天气码 → emoji + 中文 ========== */
    var WX_MAP = {
        0:  { ic: '☀️', cn: '晴' },
        1:  { ic: '🌤️', cn: '少云' },
        2:  { ic: '⛅',  cn: '多云' },
        3:  { ic: '☁️', cn: '阴' },
        45: { ic: '🌫️', cn: '雾' },
        48: { ic: '🌫️', cn: '雾凇' },
        51: { ic: '🌦️', cn: '小毛毛雨' },
        53: { ic: '🌦️', cn: '毛毛雨' },
        55: { ic: '🌦️', cn: '大毛毛雨' },
        56: { ic: '🌦️', cn: '冻毛毛雨' },
        57: { ic: '🌦️', cn: '强冻毛毛雨' },
        61: { ic: '🌧️', cn: '小雨' },
        63: { ic: '🌧️', cn: '中雨' },
        65: { ic: '🌧️', cn: '大雨' },
        66: { ic: '🌧️', cn: '冻雨' },
        67: { ic: '🌧️', cn: '强冻雨' },
        71: { ic: '🌨️', cn: '小雪' },
        73: { ic: '❄️', cn: '中雪' },
        75: { ic: '❄️', cn: '大雪' },
        77: { ic: '❄️', cn: '雪粒' },
        80: { ic: '🌦️', cn: '阵雨' },
        81: { ic: '🌧️', cn: '强阵雨' },
        82: { ic: '⛈️', cn: '暴阵雨' },
        85: { ic: '🌨️', cn: '阵雪' },
        86: { ic: '🌨️', cn: '强阵雪' },
        95: { ic: '⛈️', cn: '雷暴' },
        96: { ic: '⛈️', cn: '雷暴伴冰雹' },
        99: { ic: '⛈️', cn: '强雷暴伴冰雹' }
    };

    /* ========== 实时时钟 ========== */
    var _tickTimer = null;
    function pad2(n) { return n < 10 ? '0' + n : '' + n; }
    function paintTime() {
        var d = new Date();
        var hh = document.getElementById('timeHH');
        if (!hh) return;
        hh.textContent = pad2(d.getHours());
        document.getElementById('timeMM').textContent = pad2(d.getMinutes());
        document.getElementById('timeSS').textContent = pad2(d.getSeconds());
        document.getElementById('timeDate').textContent = d.getFullYear() + '/' + pad2(d.getMonth() + 1) + '/' + pad2(d.getDate());
        var weeks = ['日','一','二','三','四','五','六'];
        document.getElementById('timeWeek').textContent = '星期' + weeks[d.getDay()];
        var iwClock = document.getElementById('iwClock');
        if (iwClock) iwClock.textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }
    function startClock() {
        paintTime();
        if (_tickTimer) clearInterval(_tickTimer);
        _tickTimer = setInterval(paintTime, 1000);
    }

    /* ========== 天气抓取 ========== */
    // 主源：Open-Meteo（免费、无 Key、CORS）；备用源：vvhan 聚合接口（国内直连友好）。
    // 策略：超时 8s + 主源重试 1 次 + 备用源兜底，任一成功即渲染，避免「一次失败永远不可用」。
    var _wxTimer = null;
    var _wxSeq = 0;          // 请求序号：仅最新一次请求允许写入 UI，防旧响应覆盖新响应

    function fetchJSON(url, timeoutMs) {
        return new Promise(function (resolve, reject) {
            var ctrl = ('AbortController' in global) ? new AbortController() : null;
            var timer = setTimeout(function () {
                if (ctrl) { try { ctrl.abort(); } catch (_) {} }
                reject(new Error('请求超时'));
            }, timeoutMs || 8000);
            fetch(url, { mode: 'cors', signal: ctrl ? ctrl.signal : undefined }).then(function (r) {
                clearTimeout(timer);
                if (!r.ok) { reject(new Error('HTTP ' + r.status)); return; }
                return r.json().then(resolve, function (e) { reject(e); });
            }).catch(function (e) { clearTimeout(timer); reject(e); });
        });
    }

    function findCoord(cityName) {
        if (!cityName) return null;
        var key = cityName.trim();
        if (CITY_COORDS[key]) return CITY_COORDS[key];
        // 兼容"市"后缀 / 短名匹配
        var short = key.replace(/市$/, '');
        if (CITY_COORDS[short]) return CITY_COORDS[short];
        if (CITY_COORDS[key + '市']) return CITY_COORDS[key + '市'];
        // 兜底：北京市 → 北京
        for (var k in CITY_COORDS) {
            if (k.replace(/市$/, '') === short) return CITY_COORDS[k];
        }
        return null;
    }

    function geocodeCoord(cityName) {
        return new Promise(function (resolve) {
            if (typeof BMapGL === 'undefined' || !global.BMapGL.Geocoder) { resolve(null); return; }
            try {
                var gc = new BMapGL.Geocoder();
                gc.getPoint(cityName, function (pt) {
                    if (pt && pt.lng) resolve({ lng: pt.lng, lat: pt.lat });
                    else resolve(null);
                }, cityName);
            } catch (e) { resolve(null); }
        });
    }

    function fetchOpenMeteo(coord) {
        var url = 'https://api.open-meteo.com/v1/forecast'
            + '?latitude=' + coord.lat
            + '&longitude=' + coord.lng
            + '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,apparent_temperature'
            + '&timezone=Asia%2FShanghai';
        return fetchJSON(url, 8000);
    }

    /* 备用源 1：wttr.in（国际，CORS *，国内多数网络可达；按城市名查询，无需坐标） */
    function fetchWttr(cityName) {
        var url = 'https://wttr.in/' + encodeURIComponent(cityName) + '?format=j1';
        return fetchJSON(url, 8000);
    }

    /* wttr.in 的 weatherDesc 是英文 → 关键字映射为中文 + emoji */
    function wttrDescToCn(t) {
        t = String(t || '');
        if (t.indexOf('Thunder') >= 0) return { ic: '⛈️', cn: '雷暴' };
        if (t.indexOf('Snow') >= 0 || t.indexOf('sleet') >= 0) return { ic: '❄️', cn: '雪' };
        if (t.indexOf('Drizzle') >= 0) return { ic: '🌦️', cn: '毛毛雨' };
        if (t.indexOf('Rain') >= 0 || t.indexOf('Showers') >= 0) return { ic: '🌧️', cn: '雨' };
        if (t.indexOf('Ice') >= 0) return { ic: '🌧️', cn: '冻雨' };
        if (t.indexOf('Mist') >= 0 || t.indexOf('Fog') >= 0 || t.indexOf('haze') >= 0) return { ic: '🌫️', cn: '雾' };
        if (t.indexOf('Overcast') >= 0) return { ic: '☁️', cn: '阴' };
        if (t.indexOf('Cloudy') >= 0) return { ic: '⛅', cn: '多云' };
        if (t.indexOf('Clear') >= 0 || t.indexOf('Sunny') >= 0) return { ic: '☀️', cn: '晴' };
        return { ic: '🌡️', cn: t || '未知' };
    }

    function paintWttr(cityName, payload) {
        var cur = (payload && payload.current_condition && payload.current_condition[0]) || null;
        if (!cur) throw new Error('wttr 返回为空');
        var cn = wttrDescToCn(cur.weatherDesc && cur.weatherDesc[0] && cur.weatherDesc[0].value);
        var ic = document.getElementById('wxIcon');
        var city = document.getElementById('wxCity');
        var tEl  = document.getElementById('wxTemp');
        var dEl  = document.getElementById('wxDesc');
        var hEl  = document.getElementById('wxHum');
        var wEl  = document.getElementById('wxWind');
        if (ic)  ic.textContent  = cn.ic;
        if (city) city.textContent = cityName || '当前城市';
        if (tEl)  tEl.textContent  = (cur.temp_C !== undefined && cur.temp_C !== '') ? Math.round(Number(cur.temp_C)) : '--';
        if (dEl)  dEl.textContent  = cn.cn;
        if (hEl)  hEl.textContent  = (cur.humidity !== undefined) ? cur.humidity : '--';
        if (wEl)  wEl.textContent  = (cur.windspeedKmph !== undefined) ? cur.windspeedKmph + ' km/h' : '--';
    }

    /* 备用源 2：vvhan 聚合天气（按城市名查询，无需坐标） */
    function fetchVvhan(cityName) {
        var url = 'https://api.vvhan.com/api/weather?city=' + encodeURIComponent(cityName);
        return fetchJSON(url, 8000);
    }

    /* vvhan 天气现象文本 → emoji（按关键字粗匹配即可） */
    function wxTextToIcon(t) {
        t = String(t || '');
        if (t.indexOf('雷') >= 0) return '⛈️';
        if (t.indexOf('雪') >= 0) return '❄️';
        if (t.indexOf('雨') >= 0) return '🌧️';
        if (t.indexOf('雾') >= 0 || t.indexOf('霾') >= 0) return '🌫️';
        if (t.indexOf('阴') >= 0) return '☁️';
        if (t.indexOf('云') >= 0) return '⛅';
        if (t.indexOf('晴') >= 0) return '☀️';
        return '🌡️';
    }

    function paintWeather(cityName, payload) {
        var cur = (payload && payload.current) || {};
        var code = (typeof cur.weather_code === 'number') ? cur.weather_code : null;
        var map = (code != null && WX_MAP[code]) ? WX_MAP[code] : { ic: '🌡️', cn: '未知' };
        var temp = (typeof cur.temperature_2m === 'number') ? Math.round(cur.temperature_2m) : '--';
        var hum  = (typeof cur.relative_humidity_2m === 'number') ? cur.relative_humidity_2m : '--';
        var wind = (typeof cur.wind_speed_10m === 'number') ? cur.wind_speed_10m.toFixed(1) + ' km/h' : '--';
        var ic = document.getElementById('wxIcon');
        var city = document.getElementById('wxCity');
        var tEl  = document.getElementById('wxTemp');
        var dEl  = document.getElementById('wxDesc');
        var hEl  = document.getElementById('wxHum');
        var wEl  = document.getElementById('wxWind');
        if (ic)  ic.textContent  = map.ic;
        if (city) city.textContent = cityName || '当前城市';
        if (tEl)  tEl.textContent  = temp;
        if (dEl)  dEl.textContent  = map.cn;
        if (hEl)  hEl.textContent  = hum;
        if (wEl)  wEl.textContent  = wind;
    }

    function paintVvhan(cityName, payload) {
        var info = (payload && payload.info) || (payload && payload.data) || {};
        var type = info.type || info.weather || '未知';
        var hi = parseInt(String(info.high || '').replace(/[^0-9]/g, ''), 10);
        var lo = parseInt(String(info.low  || '').replace(/[^0-9]/g, ''), 10);
        var temp = (isNaN(hi) && isNaN(lo)) ? '--'
                 : Math.round(((isNaN(hi) ? lo : hi) + (isNaN(lo) ? hi : lo)) / 2);
        var ic = document.getElementById('wxIcon');
        var city = document.getElementById('wxCity');
        var tEl  = document.getElementById('wxTemp');
        var dEl  = document.getElementById('wxDesc');
        var hEl  = document.getElementById('wxHum');
        var wEl  = document.getElementById('wxWind');
        if (ic)  ic.textContent  = wxTextToIcon(type);
        if (city) city.textContent = (info.city || cityName || '当前城市');
        if (tEl)  tEl.textContent  = temp;
        if (dEl)  dEl.textContent  = type;
        if (hEl)  hEl.textContent  = '--';
        if (wEl)  wEl.textContent  = (info.fengxiang || info.wind || '--');
    }

    function paintWeatherError(cityName, err) {
        var ic = document.getElementById('wxIcon');
        var city = document.getElementById('wxCity');
        var tEl  = document.getElementById('wxTemp');
        var dEl  = document.getElementById('wxDesc');
        var wEl  = document.getElementById('widget-weather');
        var reason = (err && err.message) || String(err || '未知错误');
        if (ic)  ic.textContent  = '🌡️';
        if (city) city.textContent = cityName || '当前城市';
        if (tEl)  tEl.textContent  = '--';
        if (dEl)  dEl.textContent  = '天气不可用·点击重试';
        if (wEl)  wEl.title = '天气获取失败：' + reason + '；点击卡片可重试';
        global.__diag && global.__diag('天气获取失败：' + reason, 'warn');
    }

    async function updateWeather(cityName) {
        var my = ++_wxSeq;   // 新请求使旧请求失效
        var raw = (cityName || '').trim();
        if (!raw) {
            // 未显式传城市：从「省 / 市」下拉解析（含直辖市「市辖区」占位处理）
            var provEl = document.getElementById('provSelect');
            var cityEl = document.getElementById('citySelect');
            if (global.RegionPicker && global.RegionPicker.cityOnly) {
                raw = global.RegionPicker.cityOnly(provEl, cityEl) || '';
            }
            if (!raw && cityEl) raw = (cityEl.value || '').trim();
        }
        // 直辖市“市辖区/县”占位 → 用省份名查天气
        var name = raw;
        if (global.RegionPicker && global.RegionPicker.cityOnly && document.getElementById('citySelect')) {
            var resolved = global.RegionPicker.cityOnly(
                document.getElementById('provSelect'), document.getElementById('citySelect'));
            if (resolved && (!raw || SKIP_LIKE_CITY.test(raw))) name = resolved;
        }
        if (!name) return;

        var coord = findCoord(name);
        if (!coord) coord = await geocodeCoord(name);

        // 主源两次 → 备用源 wttr.in → 备用源 vvhan
        var lastErr = null;
        if (coord) {
            for (var i = 0; i < 2; i++) {
                try {
                    var data = await fetchOpenMeteo(coord);
                    if (my !== _wxSeq) return;   // 已有更新请求，丢弃本次结果
                    paintWeather(name, data);
                    return;
                } catch (e) { lastErr = e; }
                await new Promise(function (r) { setTimeout(r, 600 * (i + 1)); });
                if (my !== _wxSeq) return;
            }
        }
        // wttr.in 不需要坐标，主源失败（含未取到坐标）时也值得一试
        try {
            var wdata = await fetchWttr(name);
            if (my !== _wxSeq) return;
            paintWttr(name, wdata);
            return;
        } catch (eW) { lastErr = lastErr || eW; }
        try {
            var vdata = await fetchVvhan(name);
            if (my !== _wxSeq) return;
            if (vdata && (vdata.success || vdata.info || vdata.data)) {
                paintVvhan(name, vdata);
                return;
            }
            lastErr = new Error('备用源返回异常');
        } catch (e2) { lastErr = lastErr || e2; }
        if (my !== _wxSeq) return;
        paintWeatherError(name, coord ? lastErr : new Error('未找到该城市坐标'));
    }

    // 与 region.js 的「市辖区 / 县」占位一致的判断（本地兜底，避免依赖未加载）
    var SKIP_LIKE_CITY = /^(市辖区|县)$/;

    function startWeather() {
        var city = document.getElementById('citySelect');
        var prov = document.getElementById('provSelect');
        if (city) city.addEventListener('change', function () { updateWeather(city.value); });
        // 直辖市只改省下拉也会换城市（市下拉是禁用的占位），省变化同样刷新天气
        if (prov) prov.addEventListener('change', function () { updateWeather(); });
        // 点击天气卡片手动重试（网络受限 / 跟踪保护拦截时的自救入口）
        var wxWidget = document.getElementById('widget-weather');
        if (wxWidget) wxWidget.addEventListener('click', function () { updateWeather(); });
        // 启动即抓一次：此时区域选择器可能尚未绑定，updateWeather 内部会自行解析城市；
        // 再延迟补抓一次，覆盖「选择器晚绑定 / 首次网络抖动」的情况。
        updateWeather();
        setTimeout(function () { updateWeather(); }, 1500);
        if (_wxTimer) clearInterval(_wxTimer);
        _wxTimer = setInterval(function () {
            var c = document.getElementById('citySelect');
            updateWeather(c ? c.value : '');
        }, 10 * 60 * 1000);  // 每 10 分钟刷新
    }

    /* ========== 暴露 ========== */
    global.TimeWeather = {
        start: function () { startClock(); startWeather(); },
        updateWeather: updateWeather
    };

    // DOM 准备好后自动启动（在百度 API 加载完成前后都能用；天气独立于地图）
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { TimeWeather.start(); });
    } else {
        // 延迟到 body 解析完再启动，确保 timeHH 等元素已存在
        setTimeout(function () { TimeWeather.start(); }, 0);
    }
})(window);
