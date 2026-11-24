(function (window, document) {
    'use strict';

    var name = 'lampa_transcode';
    var active;
    var bypass = false;
    var installed = false;
    var controller;
    var hlsScript;
    var gatewaySession;
    var playbackRequest = 0;
    var credentials;
    var script = document.currentScript;
    var configuredGateway = window.LAMPA_TRANSCODE_CONFIG && window.LAMPA_TRANSCODE_CONFIG.gateway;
    var detectedGateway = script && /\/plugin\.js(?:[?#]|$)/i.test(script.src) ?
        script.src.split(/[?#]/)[0].replace(/[^/]+$/, '') : '';

    function gatewayAddress() {
        var storage = window.Lampa.Storage;
        var saved = typeof storage.get === 'function' ? storage.get(name + '_gateway_url', '') : '';
        var address = String(saved || configuredGateway || detectedGateway || '').trim();
        if (!/^https?:\/\/(?:[a-z0-9.-]+|\[[a-f0-9:]+\])(?::[0-9]+)?(?:\/[^\s?#\\@]*)?$/i.test(address)) return '';
        if (window.location && /^(https|lampaapp):$/.test(window.location.protocol) && !/^https:/i.test(address)) return '';
        return address.replace(/\/*$/, '/');
    }

    function source(data) {
        if (!data || data.iptv || data.tv || data.vast_url || data.launch_player) return null;
        return typeof data.url === 'string' && /^https?:\/\//i.test(data.url) ? data.url : null;
    }

    function close(restore) {
        if (!active) return;
        var previous = active.previous;
        if (active.save) active.save();
        if (active.engine) active.engine.destroy();
        if (active.video) {
            active.video.pause();
            active.video.removeAttribute('src');
            active.video.load();
        }
        if (active.frame) {
            active.frame.contentWindow.postMessage({ type: 'lampa-transcode-close' }, active.origin);
            window.removeEventListener('message', active.message);
        }
        active.root.parentNode.removeChild(active.root);
        active = null;
        if (restore) controller.toggle(previous || 'content');
    }

    function jump(delta) {
        if (active && active.video && isFinite(active.video.duration)) {
            active.video.currentTime = Math.max(0, Math.min(active.video.duration, active.video.currentTime + delta));
        }
    }

    function savedPosition(original) {
        var timeline = original.timeline;
        var mode = window.Lampa.Storage.field('player_timecode');
        if (!timeline || timeline.percent >= 90 || mode === 'again') return 0;
        var time = Number(timeline.time);
        if (!(time > 10) || (mode === 'ask' && !window.confirm('Продолжить просмотр?'))) return 0;
        return time;
    }

    function saveTimeline(original, seconds, duration) {
        var timeline = original.timeline;
        if (!timeline || timeline.stop_recording || typeof timeline.handler !== 'function' ||
            !isFinite(seconds) || !isFinite(duration) || duration <= 0 || seconds < 0) return;
        try { timeline.handler(Math.round(seconds / duration * 100), seconds, duration); }
        catch (error) {}
    }

    function fallback(original) {
        close(true);
        bypass = true;
        try { window.Lampa.Player.play(original); }
        finally { bypass = false; }
    }

    function gatewayRequest(method, url, key, data, callback) {
        var xhr = new window.XMLHttpRequest();
        var finish = callback || function () {};
        try {
            xhr.open(method, url);
            xhr.timeout = 45000;
            if (key) xhr.setRequestHeader('Authorization', 'Bearer ' + key);
            if (data) xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.onload = function () {
                var result;
                if (key) {
                    try { result = JSON.parse(xhr.responseText); } catch (error) {}
                }
                finish(xhr.status, result);
            };
            xhr.ontimeout = xhr.onerror = function () { finish(0); };
            xhr.send(data ? JSON.stringify(data) : null);
        } catch (error) {
            finish(0);
        }
    }

    function releaseGateway(session) {
        if (!session || session.released) return;
        session.released = true;
        if (session.timer) window.clearInterval(session.timer);
        if (gatewaySession === session) gatewaySession = null;
        gatewayRequest('DELETE', session.api, session.key);
    }

    function notify(message) {
        var noty = window.Lampa.Noty;
        if (noty && typeof noty.show === 'function') noty.show(message);
    }

    function gatewayCredentials(gateway) {
        if (!credentials) {
            try {
                credentials = JSON.parse(window.localStorage.getItem(name + '_credentials'));
            } catch (error) {}
        }
        if (credentials && credentials.gateway === gateway && typeof credentials.key === 'string' && credentials.key) {
            return credentials;
        }
    }

    function configureKey() {
        var gateway = gatewayAddress();
        if (!gateway) {
            notify('Сначала укажите адрес медиашлюза.');
            return;
        }
        var input = window.Lampa.Input;
        if (!input || typeof input.edit !== 'function') {
            notify('В этой сборке Lampa недоступен редактор настроек.');
            return;
        }
        input.edit({ title: 'API-ключ медиашлюза', value: '', password: true, nosave: true, nomic: true }, function (value) {
            var key = String(value || '').trim();
            if (!key || gatewayAddress() !== gateway) return;
            credentials = { gateway: gateway, key: key };
            try {
                window.localStorage.setItem(name + '_credentials', JSON.stringify(credentials));
                notify('API-ключ сохранён.');
            } catch (error) {
                notify('API-ключ действует до закрытия Lampa.');
            }
        });
    }

    function removeKey() {
        var gateway = gatewayAddress();
        if (!gateway || !gatewayCredentials(gateway)) return;
        credentials = null;
        try {
            window.localStorage.removeItem(name + '_credentials');
        } catch (error) {}
        notify('API-ключ удалён.');
    }

    function nativeGateway(url, original, gateway, request) {
        if (!window.XMLHttpRequest) return false;
        var auth = gatewayCredentials(gateway);
        if (!auth) {
            notify('Укажите API-ключ в настройках Lampa Transcode. Открываю исходное видео.');
            return false;
        }
        var lampa = window.Lampa;
        var api = gateway + 'api/v1/sessions';
        var video = document.createElement('video');
        var direct = video.canPlayType && video.canPlayType('video/mp4; codecs="avc1.640028, mp4a.40.2"');

        function failed(session, stage, status) {
            releaseGateway(session);
            if (request !== playbackRequest) return;
            if (lampa.Noty && typeof lampa.Noty.show === 'function') {
                var reason = status === 401 ? 'Проверьте API-ключ' :
                    status === 422 ? 'Шлюз отклонил источник' :
                    status === 429 ? 'Достигнут лимит сессий' :
                    status === 0 ? 'Нет ответа от шлюза. Проверьте HTTPS и локальную сеть' :
                    status ? 'HTTP ' + status : 'Ошибка воспроизведения';
                lampa.Noty.show(stage + ': ' + reason + '. Открываю исходное видео.');
            }
            fallback(original);
        }

        gatewayRequest('POST', api, auth.key, {
            url: url, accepts_h264_aac_mp4: Boolean(direct), renewable_stream: true
        }, function (status, result) {
            if (status !== 201 || !result || !/^[a-f0-9]{32}$/.test(result.id)) {
                failed(null, 'Создание сессии', status);
                return;
            }
            var session = { api: api + '/' + result.id, key: auth.key, original: original };
            var prefix = '/stream/' + result.id + '/';
            if (request !== playbackRequest) { releaseGateway(session); return; }
            if (typeof result.stream_url !== 'string' || result.stream_url.indexOf(prefix) !== 0) {
                failed(session, 'Некорректный URL потока');
                return;
            }
            var stream = gateway + result.stream_url.slice(1);
            function launch() {
                if (request !== playbackRequest) { releaseGateway(session); return; }
                var data = {};
                Object.keys(original).forEach(function (field) { data[field] = original[field]; });
                data.url = stream;
                delete data.quality;
                delete data.url_reserve;
                delete data.ffprobe;
                delete data.translate;
                delete data.voiceovers;
                data.error = function () { if (gatewaySession === session) failed(session, 'Штатный плеер'); };
                gatewaySession = session;
                session.timer = window.setInterval(function () {
                    gatewayRequest('PATCH', session.api, session.key);
                }, 45000);
                try { fallback(data); }
                catch (error) { failed(session, 'Запуск штатного плеера'); }
            }
            if (result.mode === 'direct') launch();
            else gatewayRequest('GET', stream, null, null, function (status) {
                if (status === 200) launch();
                else failed(session, 'Загрузка HLS', status);
            });
        });
        return true;
    }

    function openGateway(url, original, gateway) {
        close(true);
        var root = document.createElement('section');
        var frame = document.createElement('iframe');
        var back = document.createElement('button');
        var native = document.createElement('button');
        var route = gateway + 'player/';
        var origin = route.match(/^https?:\/\/[^/]+/i)[0];
        root.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483647;background:#111';
        frame.title = 'Lampa Transcode';
        frame.style.cssText = 'width:100%;height:calc(100% - 3rem);border:0;display:block';
        frame.setAttribute('allow', 'fullscreen; autoplay');
        frame.onload = function () {
            frame.contentWindow.postMessage({ type: 'lampa-transcode-open', url: url, resume: savedPosition(original) }, origin);
        };
        back.textContent = 'Закрыть';
        back.onclick = function () { close(true); };
        native.textContent = 'Штатный плеер';
        native.onclick = function () { fallback(original); };
        root.appendChild(frame);
        root.appendChild(back);
        root.appendChild(native);
        active = {
            root: root, frame: frame, origin: origin, previous: controller.enabled().name,
            move: function (step) { (step < 0 ? back : native).focus(); },
            enter: function () {
                if (document.activeElement === native) native.click();
                else if (document.activeElement === back) back.click();
                else frame.focus();
            },
            message: function (event) {
                if (event.origin !== origin || event.source !== frame.contentWindow || !event.data) return;
                if (event.data.type === 'lampa-transcode-return') close(true);
                if (event.data.type === 'lampa-transcode-progress') {
                    saveTimeline(original, Number(event.data.position), Number(event.data.duration));
                }
            }
        };
        window.addEventListener('message', active.message);
        document.body.appendChild(root);
        controller.toggle(name);
        frame.src = route;
        frame.focus();
    }

    function open(url, original) {
        var root = document.createElement('section');
        var video = document.createElement('video');
        var toolbar = document.createElement('div');
        var status = document.createElement('span');
        var buttons = [];
        var position = 0;
        var resume = savedPosition(original);
        var lastSave = Date.now();
        var playback;
        var playlist = Array.isArray(original.playlist) ? original.playlist : [];

        function selectEpisode(entry) {
            var data = {};
            Object.keys(original).forEach(function (key) { data[key] = original[key]; });
            delete data.timeline;
            delete data.quality;
            Object.keys(entry).forEach(function (key) { data[key] = entry[key]; });
            window.Lampa.Player.play(data);
        }

        function setSource(url) {
            if (playback.engine) playback.engine.destroy();
            playback.engine = null;
            playback.url = url;
            if (!/\.m3u8(?:[?#]|$)/i.test(url) || video.canPlayType('application/vnd.apple.mpegurl')) {
                video.src = url;
                return;
            }
            function attach() {
                if (active !== playback || playback.url !== url) return;
                if (!window.Hls || !window.Hls.isSupported()) {
                    status.textContent = 'Для этого потока требуется HLS.';
                    return;
                }
                playback.engine = new window.Hls();
                playback.engine.on(window.Hls.Events.ERROR, function (_, info) {
                    if (info.fatal) status.textContent = 'Ошибка загрузки HLS.';
                });
                playback.engine.loadSource(url);
                playback.engine.attachMedia(video);
            }
            if (window.Hls) attach();
            else if (gatewayAddress()) {
                if (!hlsScript) {
                    hlsScript = document.createElement('script');
                    hlsScript.src = gatewayAddress() + 'hls.min.js';
                    document.head.appendChild(hlsScript);
                }
                hlsScript.addEventListener('load', attach);
                hlsScript.addEventListener('error', function () {
                    if (active === playback) status.textContent = 'Не удалось загрузить hls.js.';
                    hlsScript = null;
                });
            } else status.textContent = 'Для этого потока требуется HLS.';
        }

        function button(label, action) {
            var element = document.createElement('button');
            element.type = 'button';
            element.textContent = label;
            element.onclick = action;
            toolbar.appendChild(element);
            buttons.push(element);
        }

        close(true);
        root.style.cssText = 'position:fixed;inset:0;top:0;left:0;width:100%;height:100%;z-index:2147483647;background:#111;color:white;display:flex;flex-direction:column';
        video.style.cssText = 'width:100%;flex:1;min-height:0;background:black';
        toolbar.style.cssText = 'padding:12px;background:#222';
        video.controls = true;
        video.autoplay = true;
        video.setAttribute('playsinline', '');
        video.onloadedmetadata = function () {
            if (resume > 0 && resume < video.duration) video.currentTime = resume;
            resume = 0;
        };
        video.ontimeupdate = function () {
            if (Date.now() - lastSave >= 15000) {
                lastSave = Date.now();
                saveTimeline(original, video.currentTime, video.duration);
            }
        };
        video.onwaiting = function () { status.textContent = 'Буферизация…'; };
        video.onplaying = function () { status.textContent = ''; };
        video.onerror = function () { status.textContent = 'Источник не воспроизводится в этом браузере.'; };
        button('Закрыть', function () { close(true); });
        button('Пуск / пауза', function () {
            if (video.paused) {
                var result = video.play();
                if (result && result.catch) result.catch(function () { status.textContent = 'Нажмите кнопку воспроизведения на видео.'; });
            } else video.pause();
        });
        button('−10 с', function () { jump(-10); });
        button('+10 с', function () { jump(10); });
        button('Штатный плеер', function () { fallback(original); });
        var alternatives = original.quality && typeof original.quality === 'object' ? Object.keys(original.quality) : [];
        alternatives.forEach(function (label) {
            var value = original.quality[label];
            var selected = source({ url: typeof value === 'string' ? value : value && value.url });
            if (selected && selected !== url) button(label, function () {
                resume = video.currentTime;
                setSource(selected);
            });
        });
        var current = -1;
        playlist.forEach(function (entry, index) { if (entry && entry.url === original.url) current = index; });
        if (current >= 0) {
            if (source(playlist[current - 1])) button('Предыдущая серия', function () { selectEpisode(playlist[current - 1]); });
            if (source(playlist[current + 1])) button('Следующая серия', function () { selectEpisode(playlist[current + 1]); });
        }
        toolbar.appendChild(status);
        root.appendChild(video);
        root.appendChild(toolbar);
        playback = active = {
            root: root, video: video, previous: controller.enabled().name,
            save: function () { saveTimeline(original, video.currentTime, video.duration); }
        };
        active.move = function (step) {
            position = (position + step + buttons.length) % buttons.length;
            buttons[position].focus();
        };
        active.enter = function () { buttons[position].click(); };
        document.body.appendChild(root);
        controller.toggle(name);
        buttons[0].focus();
        setSource(url);
    }

    function install() {
        var lampa = window.Lampa;
        if (installed || !lampa || !lampa.Controller || !lampa.SettingsApi ||
            !lampa.Player || !lampa.Player.listener || !lampa.Storage) return;
        installed = true;
        controller = lampa.Controller;
        lampa.SettingsApi.addComponent({
            component: name,
            name: 'Lampa Transcode',
            icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">' +
                '<rect x="2.5" y="4.5" width="19" height="15" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
                '<path d="M10 8.5l5.5 3.5-5.5 3.5z" fill="currentColor"/></svg>'
        });
        lampa.SettingsApi.addParam({
            component: name,
            param: { name: name + '_enabled', type: 'trigger', default: false },
            field: { name: 'Открывать видео в Lampa Transcode' }
        });
        lampa.SettingsApi.addParam({
            component: name,
            param: { name: name + '_gateway_url', type: 'input', values: '', default: '', placeholder: 'https://nas.example.org' },
            field: { name: 'Адрес медиашлюза' },
            onChange: function (value) { lampa.Storage.set(name + '_gateway_url', String(value || '').trim()); }
        });
        lampa.SettingsApi.addParam({
            component: name,
            param: { name: name + '_set_key', type: 'button' },
            field: { name: 'API-ключ медиашлюза', description: 'Ввести или заменить ключ' },
            onChange: configureKey
        });
        lampa.SettingsApi.addParam({
            component: name,
            param: { name: name + '_remove_key', type: 'button' },
            field: { name: 'Удалить API-ключ' },
            onChange: removeKey
        });
        lampa.SettingsApi.addParam({
            component: name,
            param: { name: name + '_gateway', type: 'trigger', default: false },
            field: { name: 'Использовать сервер для HTTP-видео' }
        });
        lampa.SettingsApi.addParam({
            component: name,
            param: { name: name + '_custom', type: 'trigger', default: false },
            field: { name: 'Использовать экспериментальный плеер' }
        });
        lampa.Player.listener.follow('destroy', function () { releaseGateway(gatewaySession); });
        controller.add(name, {
            back: function () { close(true); },
            left: function () { jump(-10); },
            right: function () { jump(10); },
            up: function () { if (active) active.move(-1); },
            down: function () { if (active) active.move(1); },
            enter: function () { if (active) active.enter(); },
            gone: function (next) { if (next !== name) close(false); }
        });
        lampa.Player.listener.follow('create', function (event) {
            if (bypass) return;
            var request = ++playbackRequest;
            releaseGateway(gatewaySession);
            if (lampa.Storage.field(name + '_enabled') !== true || typeof event.abort !== 'function') return;
            var url = source(event.data);
            if (!url) return;
            try {
                if (event.data.quality && typeof lampa.Player.getUrlQuality === 'function') {
                    url = source({ url: lampa.Player.getUrlQuality(event.data.quality, false) }) || url;
                }
                if (event.data.torrent_hash && lampa.Torserver && typeof lampa.Torserver.toPlayUrl === 'function') {
                    url = lampa.Torserver.toPlayUrl(url);
                }
                var gateway = gatewayAddress();
                var useGateway = gateway && lampa.Storage.field(name + '_gateway') === true &&
                    !/\.(m3u8|mpd)(?:[?#]|$)/i.test(url);
                if (lampa.Storage.field(name + '_custom') === true) {
                    if (useGateway) openGateway(url, event.data, gateway);
                    else open(url, event.data);
                    event.abort();
                } else if (useGateway && nativeGateway(url, event.data, gateway, request)) {
                    event.abort();
                }
            } catch (error) {
                close(true);
            }
        });
    }

    if (window.LampaTranscodeLoaded) return;
    window.LampaTranscodeLoaded = true;
    if (window.appready) install();
    else if (window.Lampa && window.Lampa.Listener) {
        window.Lampa.Listener.follow('app', function (event) {
            if (event.type === 'ready') install();
        });
    }
})(window, document);
