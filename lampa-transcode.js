(function (window, document) {
    'use strict';

    var name = 'lampa_transcode';
    var active;
    var bypass = false;
    var installed = false;
    var controller;
    var hlsScript;
    var gatewaySession;
    var pendingGateway;
    var playbackRequest = 0;
    var plexSequence = { id: null, next: 0 };
    var stockPlaylist;
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
        if (data.transcodeSource && data.url === data.transcodeSource.stream) return data.transcodeSource.url;
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
        if (!timeline || timeline.stop_recording ||
            !isFinite(seconds) || !isFinite(duration) || duration <= 0 || seconds < 0) return;
        var percent = Math.round(seconds / duration * 100);
        var store = window.Lampa.Timeline;
        try {
            if (typeof timeline.handler === 'function') timeline.handler(percent, seconds, duration);
            else if (timeline.hash && store && typeof store.update === 'function') {
                store.update({ hash: timeline.hash, time: seconds, duration: duration, percent: percent,
                    profile: timeline.profile, card: timeline.card, season: timeline.season, episode: timeline.episode });
            }
        } catch (error) {}
        timeline.time = seconds;
        timeline.duration = duration;
        timeline.percent = percent;
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
                finish(xhr.status, key ? result : xhr.responseText);
            };
            xhr.ontimeout = xhr.onerror = function () { finish(0); };
            xhr.send(data ? JSON.stringify(data) : null);
        } catch (error) {
            finish(0);
        }
        return xhr;
    }

    function releaseGateway(session) {
        if (!session || session.released) return;
        session.released = true;
        if (session.progress) session.progress('stopped');
        if (session.timer) window.clearInterval(session.timer);
        if (session.reportTimer) window.clearInterval(session.reportTimer);
        if (session.seekPoll) window.clearTimeout(session.seekPoll);
        if (session.seekNotice) hidePreparation(session.seekNotice);
        clearStartup(session);
        if (gatewaySession === session) gatewaySession = null;
        gatewayRequest('DELETE', session.api, session.key);
    }

    function clearStartup(session) {
        if (session.startup) window.clearTimeout(session.startup);
        session.startup = null;
    }

    function armStartup(session) {
        clearStartup(session);
        session.startup = window.setTimeout(function () {
            if (gatewaySession === session) {
                session.expired = true;
                session.playData.error();
            }
        }, 60000);
    }

    function readyStockGateway(session, lampa) {
        session.stockReady = true;
        if (session.hls && isFinite(session.duration) && session.duration > 0) {
            updateStockClock(lampa, session.offset, session.duration);
        }
        if (session.trackPlayback) trackPlayback(session, lampa);
        armStartup(session);
    }

    function tryStockPlay(session, media) {
        if (!session.startup || session.playTried || !media || !media.paused || typeof media.play !== 'function') return;
        session.playTried = true;
        var attempt;
        try { attempt = media.play(); }
        catch (error) { session.playTried = false; return; }
        if (!attempt || typeof attempt.then !== 'function') return;
        session.playAttempt = attempt;
        attempt.then(function () {
            if (gatewaySession === session && session.playAttempt === attempt) clearStartup(session);
        }, function (error) {
            if (gatewaySession !== session || session.playAttempt !== attempt || !session.startup) return;
            session.playTried = false;
            if (!error || error.name !== 'NotAllowedError') return;
            clearStartup(session);
            notify('Браузер заблокировал автозапуск. Нажмите ▶ в плеере.');
        });
    }

    function showPreparation(pending) {
        var status = document.createElement('div');
        status.setAttribute('role', 'status');
        status.style.cssText = 'position:fixed;top:0;right:0;bottom:0;left:0;display:flex;' +
            'align-items:center;justify-content:center;box-sizing:border-box;padding:1.5rem;' +
            'background:rgba(0,0,0,.72);color:#fff;font-size:1.5rem;font-size:clamp(1.5rem,4vw,2.25rem);' +
            'font-weight:700;line-height:1.3;z-index:2147483647;text-align:center;pointer-events:none';
        status.textContent = 'Подготавливаем видео…';
        pending.notice = status;
        document.body.appendChild(status);
    }

    function updateStockClock(lampa, current, duration) {
        var panel = lampa.PlayerPanel;
        var utils = lampa.Utils;
        if (!panel || typeof panel.update !== 'function' || !utils || !lampa.Lang) return;
        panel.update('time', utils.secondsToTime(Math.floor(current), true));
        panel.update('timenow', utils.secondsToTime(current));
        panel.update('position', (current / duration * 100) + '%');
        panel.update('timeend', utils.secondsToTime(duration) + ' - ' + lampa.Lang.translate('title_left') +
            ' ' + utils.secondsToTimeHuman(Math.max(0, duration - current)));
    }

    function stockTimeUpdate(session, lampa, event) {
        var media = typeof lampa.PlayerVideo.video === 'function' && lampa.PlayerVideo.video();
        var duration = Number(session.hls ? session.duration : event.duration);
        if (typeof event.current !== 'number' || !isFinite(event.current) ||
            !isFinite(duration) || duration <= 0 || (media && media.seeking)) return;
        if (session.clockStart === undefined) {
            session.clockStart = session.hls && media && media.seekable && media.seekable.length ? media.seekable.start(0) : 0;
        }
        var current = Math.min(duration, session.offset + Math.max(0, event.current - session.clockStart));
        session.current = current;
        if (session.hls) updateStockClock(lampa, current, duration);
        if (session.sample) session.sample(current, duration, event.current > session.clockStart && (!media || !media.paused));
    }

    function seriesAudioKey(data) {
        if (data.transcodeSeries) return data.transcodeSeries;
        var timeline = data.timeline || {};
        if (typeof timeline.card === 'string' && /^tv_/.test(timeline.card)) return timeline.card;
        var card = data.card || {};
        if (card.id && (card.media_type === 'tv' || card.original_name || data.episode)) return 'tv_' + card.id;
        if (data.plexPlaybackSession && Array.isArray(data.playlist) && data.playlist.length > 1 &&
            typeof card.title === 'string' && card.title.indexOf(' - ') > 0) {
            return 'plex_' + card.title.split(' - ')[0];
        }
    }

    function rememberStockAudio(session, tracks) {
        var timeline = session.original.timeline;
        var series = seriesAudioKey(session.original);
        var hash = timeline && timeline.hash;
        if (!tracks || tracks.length < 2) return;
        var key = series || hash ? name + '_audio_' + (series ? 'series_' + series : hash) : null;
        var choice;
        try { if (key) choice = JSON.parse(window.localStorage.getItem(key)); } catch (error) {}
        var matches = [];
        Array.prototype.forEach.call(tracks, function (track, index) {
            var label = String(track.label || track.name || '');
            var ordinal = /^(\d+)\.\s*/.exec(label);
            var identity = {
                label: label.replace(/^\d+\.\s*/, ''),
                language: String(track.language || track.lang || ''),
                index: index
            };
            if (choice && choice.label === identity.label && choice.language === identity.language) matches.push(index);
            var previous = track.onSelect;
            if (previous && previous.transcodeAudioSession === session) return;
            var selected = function () {
                try { if (key) window.localStorage.setItem(key, JSON.stringify(identity)); } catch (error) {}
                if (session.switchAudio) session.switchAudio(ordinal ? Number(ordinal[1]) - 1 : index, tracks.length);
                if (typeof previous === 'function') return previous.apply(this, arguments);
            };
            selected.transcodeAudioSession = session;
            track.onSelect = selected;
        });
        if (!choice || session.audioRestored) return;
        var index = matches.indexOf(choice.index) !== -1 ? choice.index : matches.length === 1 ? matches[0] : -1;
        if (index < 0) return;
        session.audioRestored = true;
        Array.prototype.forEach.call(tracks, function (track, i) {
            if (i !== index) {
                track.enabled = false;
                track.selected = false;
            }
        });
        tracks[index].enabled = true;
        tracks[index].selected = true;
    }

    function trackPlayback(session, lampa) {
        var original = session.original;
        var timeline = original.timeline;
        if (session.sample || !timeline || !timeline.hash || timeline.stop_recording) return;
        var state, position, duration, saved, advanced;
        var plexId = original.plexPlaybackSession;

        function report(next, heartbeat) {
            if (state === 'stopped' || !advanced || (!heartbeat && state === next)) return;
            var changed = state !== next;
            state = next;
            if (saved !== position) {
                saveTimeline(original, position, duration);
                saved = position;
            }
            if (changed && typeof lampa.Player.listener.send === 'function') {
                try { lampa.Player.listener.send('native_playback', {
                    hash: timeline.hash, state: state, percent: position / duration * 100,
                    time: position, duration: duration,
                    season: original.season || original.season_number,
                    episode: original.episode || original.episode_number
                }); } catch (error) {}
            }
            if (typeof plexId === 'string' && plexId && typeof window.CustomEvent === 'function') {
                if (plexSequence.id !== plexId) plexSequence = { id: plexId, next: 0 };
                window.dispatchEvent(new window.CustomEvent('lampa:playback-state', { detail: {
                    version: 1, sessionId: plexId, sequence: plexSequence.next++, hash: timeline.hash,
                    state: state, time: position, duration: duration
                } }));
            }
        }

        session.sample = function (current, total, playing) {
            duration = total;
            position = current;
            if (current > session.offset) advanced = true;
            if (!state && playing) report('playing');
        };
        session.progress = function (next) {
            if (state || next === 'stopped') report(next);
        };
        session.reportTimer = window.setInterval(function () {
            if (state) report(state, true);
            else if (advanced && saved !== position) {
                saveTimeline(original, position, duration);
                saved = position;
            }
        }, 10000);
    }

    function hidePreparation(pending) {
        if (pending.notice && pending.notice.parentNode) pending.notice.parentNode.removeChild(pending.notice);
    }

    function cancelPendingGateway() {
        var pending = pendingGateway;
        pendingGateway = null;
        if (!pending) return;
        if (pending.warmMedia) {
            pending.warmMedia.loop = false;
            pending.warmMedia.pause();
        }
        hidePreparation(pending);
        if (pending.poll) window.clearTimeout(pending.poll);
        if (pending.xhr) pending.xhr.abort();
        releaseGateway(pending.session);
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
        var pending = { url: url, gateway: gateway };
        var browser = window.navigator || {};
        var apple = /iPhone|iPad|iPod|Macintosh/.test(browser.userAgent || '');
        var nativeHls = apple && video.canPlayType && video.canPlayType('application/vnd.apple.mpegurl');
        pendingGateway = pending;
        showPreparation(pending);

        if (nativeHls && browser.userActivation && browser.userActivation.isActive &&
            lampa.PlayerVideo && typeof lampa.PlayerVideo.video === 'function' && typeof window.btoa === 'function') {
            // Keep the gesture on the stock media element while the gateway prepares the real source.
            var silence = 'RIFFd\x1f\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00@\x1f\x00\x00@\x1f\x00\x00\x01\x00\x08\x00data@\x1f\x00\x00';
            pending.warmData = {
                url: 'data:audio/wav;base64,' + window.btoa(silence + new Array(8001).join('\x80')),
                launch_player: 'inner', title: original.title, card: original.card, season: original.season,
                episode: original.episode, plexPlaybackSession: original.plexPlaybackSession,
                timeline: original.timeline && { hash: original.timeline.hash, stop_recording: true }
            };
            try { fallback(pending.warmData); }
            catch (error) { pending.warmData = null; }
        }

        function failed(session, stage, status, detail) {
            releaseGateway(session);
            if (request !== playbackRequest) return;
            if (pendingGateway === pending) pendingGateway = null;
            hidePreparation(pending);
            if (pending.warmMedia && typeof lampa.Player.close === 'function') {
                pending.warmMedia.loop = false;
                lampa.Player.close();
            }
            if (lampa.Noty && typeof lampa.Noty.show === 'function') {
                var reason = status === 401 ? 'Проверьте API-ключ' :
                    status === 422 ? 'Шлюз отклонил источник' :
                    status === 429 ? 'Достигнут лимит сессий' :
                    status === 0 ? 'Нет ответа от шлюза. Проверьте HTTPS и локальную сеть' :
                    status ? 'HTTP ' + status : detail || 'Ошибка воспроизведения';
                if ((status === 422 || status === 429) && typeof detail === 'string' && /^[А-Яа-яЁёA-Za-z0-9 .,:()-]{1,160}$/.test(detail)) {
                    reason = detail.replace(/\.$/, '');
                }
                lampa.Noty.show(stage + ': ' + reason + '. Открываю исходное видео.');
            }
            fallback(original);
        }

        var input = { url: url, accepts_h264_aac_mp4: Boolean(direct), renewable_stream: true, native_audio: true };
        if (nativeHls) {
            input.prefer_compatible_hls = true;
            if (video.canPlayType('video/mp4; codecs="hvc1.2.4.L153.B0"')) input.accepts_hevc_main10 = true;
        }
        function created(status, result) {
            if (request !== playbackRequest && status !== 201) return;
            if (status === 422 && input.prefer_compatible_hls && result && Array.isArray(result.detail) &&
                result.detail.some(function (issue) {
                    return issue.type === 'extra_forbidden' && Array.isArray(issue.loc) &&
                        (issue.loc[1] === 'prefer_compatible_hls' || issue.loc[1] === 'accepts_hevc_main10');
                })) {
                delete input.prefer_compatible_hls;
                delete input.accepts_hevc_main10;
                pending.xhr = gatewayRequest('POST', api, auth.key, input, created);
                return;
            }
            if (status !== 201 || !result || !/^[a-f0-9]{32}$/.test(result.id)) {
                failed(null, 'Создание сессии', status, result && result.detail);
                return;
            }
            var session = { api: api + '/' + result.id, key: auth.key, original: original };
            pending.session = session;
            var prefix = '/stream/' + result.id + '/';
            if (request !== playbackRequest) { releaseGateway(session); return; }
            var stream;
            function nativeSource(description, mediaUrl) {
                var master = description.native_stream_url;
                return typeof master === 'string' && master.indexOf(prefix + 'native.m3u8?') === 0
                    ? gateway + master.slice(1) : mediaUrl;
            }

            function waitForHls(mediaUrl, alive, schedule, complete) {
                var started = Date.now();
                var lastProgress = started;
                var buffered = 0;
                function read() {
                    if (!alive()) return;
                    return gatewayRequest('GET', mediaUrl, null, null, function (status, manifest) {
                        if (!alive()) return;
                        var lengths = status === 200 ? String(manifest).match(/^#EXTINF:[0-9.]+/gm) || [] : [];
                        var seconds = lengths.reduce(function (sum, entry) { return sum + Number(entry.slice(8)); }, 0);
                        if (lengths.length >= 3 || (lengths.length >= 2 && seconds >= 12) ||
                            (lengths.length && /^#EXT-X-ENDLIST\s*$/m.test(manifest))) {
                            complete(true);
                            return;
                        }
                        var now = Date.now();
                        if (seconds > buffered) {
                            buffered = seconds;
                            lastProgress = now;
                        }
                        if ((status !== 200 && status !== 503) || now - started >= 120000) {
                            complete(false, status);
                        } else if (now - lastProgress < 45000) {
                            schedule(window.setTimeout(read, 1000));
                        } else {
                            gatewayRequest('GET', session.api, session.key, null, function (healthStatus, info) {
                                if (!alive()) return;
                                if (healthStatus === 200 && info && info.state !== 'failed' && info.ffmpeg_speed > 0) {
                                    schedule(window.setTimeout(read, 5000));
                                } else complete(false, status);
                            });
                        }
                    });
                }
                return read();
            }
            var trackedHls = result.mode !== 'direct' && lampa.PlayerVideo && lampa.PlayerVideo.listener &&
                original.timeline && original.timeline.hash && !original.timeline.stop_recording && result.duration > 0;
            function launch() {
                if (request !== playbackRequest) { releaseGateway(session); return; }
                if (pending.warmData && !pending.warmReady) {
                    pending.onWarmReady = launch;
                    return;
                }
                pendingGateway = null;
                hidePreparation(pending);
                var warmMedia = pending.warmMedia;
                var reuse = warmMedia && warmMedia === lampa.PlayerVideo.video() && typeof warmMedia.load === 'function';
                var data = reuse ? pending.warmData : {};
                Object.keys(original).forEach(function (field) { data[field] = original[field]; });
                data.url = nativeSource(result, stream);
                if (result.mode !== 'direct') {
                    data.hls_manifest_timeout = 30000;
                    if ((window.location && window.location.protocol === 'lampaapp:') || nativeHls) {
                        data.hls_type = 'native';
                    }
                }
                if (trackedHls) {
                    // Stock timecodes for a rolling playlist use the playlist clock.
                    data.launch_player = 'inner';
                    data.timeline = {};
                    Object.keys(original.timeline).forEach(function (field) { data.timeline[field] = original.timeline[field]; });
                    data.timeline.stop_recording = true;
                    data.timeline.percent = 0;
                    data.timeline.time = 0;
                    data.timeline.duration = 0;
                }
                data.transcodeSource = { url: url, stream: data.url };
                var list = Array.isArray(data.playlist) ? data.playlist :
                    stockPlaylist && data.transcodeList === stockPlaylist.id ? stockPlaylist.items : null;
                if (list) {
                    var listId = request;
                    var series = seriesAudioKey(data);
                    data.playlist = list.map(function (entry) {
                        if (!entry) return entry;
                        var item = {};
                        Object.keys(entry).forEach(function (field) { item[field] = entry[field]; });
                        if (item.transcodeSource && item.url === item.transcodeSource.stream) {
                            item.url = item.transcodeSource.url;
                            delete item.transcodeSource;
                        }
                        var current = item.url === original.url || item.url === url || entry.url === original.url;
                        item.transcodeList = listId;
                        if (series) item.transcodeSeries = series;
                        if (data.plexPlaybackSession) item.plexPlaybackSession = data.plexPlaybackSession;
                        if (current) {
                            item.url = data.url;
                            item.transcodeSource = data.transcodeSource;
                        }
                        return item;
                    });
                    stockPlaylist = { id: listId, items: data.playlist };
                }
                delete data.torrent_hash;
                delete data.torrent_index;
                delete data.quality;
                delete data.url_reserve;
                delete data.ffprobe;
                delete data.translate;
                delete data.voiceovers;
                data.error = function () {
                    if (gatewaySession !== session || session.released || session.seekNotice) return;
                    var media = lampa.PlayerVideo && typeof lampa.PlayerVideo.video === 'function' && lampa.PlayerVideo.video();
                    var code = media && media.error && Number(media.error.code);
                    if (!session.expired && (code === 3 || code === 4) && session.recover && !session.retriedDecoder) {
                        session.retriedDecoder = true;
                        session.recover();
                        return;
                    }
                    var reasons = { 1: 'Воспроизведение прервано', 2: 'Видео перестало загружаться',
                        3: 'Ошибка декодирования видео', 4: 'Формат потока не поддерживается' };
                    failed(session, 'Штатный плеер', null, session.expired ? 'Поток не начал воспроизводиться' : reasons[code]);
                };
                session.playData = data;
                session.hls = result.mode !== 'direct';
                session.duration = result.duration;
                session.offset = Number(result.offset) || 0;
                session.trackPlayback = !session.hls || trackedHls;
                var playerVideo = lampa.PlayerVideo;
                if (session.duration > 0 && playerVideo &&
                    typeof playerVideo.url === 'function' && typeof playerVideo.destroy === 'function') {
                    function restartStream(position, audioIndex, recover) {
                        if (session.seekNotice || !isFinite(position)) return;
                        var seconds = Math.max(0, Math.min(session.duration - 0.1, position));
                        var audioSwitch = audioIndex !== undefined;
                        session.seekNotice = {};
                        showPreparation(session.seekNotice);
                        var stage = recover ? 'Подготовка совместимого видео' : audioSwitch ? 'Переключение аудиодорожки' : 'Перемотка';
                        session.seekNotice.notice.textContent = recover ? 'Готовим совместимое видео…' :
                            audioSwitch ? 'Переключаем аудиодорожку…' : 'Перематываем видео…';
                        clearStartup(session);
                        session.playAttempt = null;
                        function alive() { return gatewaySession === session && !session.released; }
                        var payload = { seconds: seconds };
                        if (audioSwitch) payload.audio_index = audioIndex;
                        if (recover) payload.force_compatibility = true;
                        gatewayRequest('POST', session.api + (audioSwitch ? '/tracks' : '/seek'), session.key, payload, function (status, shifted) {
                            if (!alive()) return;
                            if (status !== 200 || !shifted || typeof shifted.stream_url !== 'string' || shifted.stream_url.indexOf(prefix) !== 0) {
                                failed(session, stage, status);
                                return;
                            }
                            var mediaUrl = gateway + shifted.stream_url.slice(1);
                            waitForHls(mediaUrl, alive, function (timer) { session.seekPoll = timer; }, function (ready, errorStatus) {
                                if (!ready) { failed(session, 'Загрузка нового потока', errorStatus); return; }
                                var nextUrl = nativeSource(shifted, mediaUrl);
                                if (data.playlist) data.playlist.forEach(function (item) {
                                    if (item && item.url === data.url) item.url = nextUrl;
                                });
                                data.url = nextUrl;
                                data.transcodeSource.stream = nextUrl;
                                if (recover && !session.hls) {
                                    session.hls = true;
                                    if (nativeHls || (window.location && window.location.protocol === 'lampaapp:')) data.hls_type = 'native';
                                    data.hls_manifest_timeout = 30000;
                                    if (data.timeline) {
                                        var timeline = {};
                                        Object.keys(data.timeline).forEach(function (field) { timeline[field] = data.timeline[field]; });
                                        timeline.stop_recording = true;
                                        data.timeline = timeline;
                                    }
                                }
                                session.offset = Number(shifted.offset) || 0;
                                session.current = session.offset;
                                session.clockStart = undefined;
                                session.audioRestored = session.playTried = session.expired = false;
                                var media = typeof playerVideo.video === 'function' && playerVideo.video();
                                if (data.hls_type === 'native' && media && typeof media.load === 'function' &&
                                    typeof media.canPlayType === 'function' && media.canPlayType('application/vnd.apple.mpegurl')) {
                                    // Safari grants autoplay per media element. Keep it across stream generations.
                                    armStartup(session);
                                    media.src = nextUrl;
                                    media.load();
                                } else {
                                    playerVideo.destroy(true);
                                    armStartup(session);
                                    playerVideo.url(nextUrl, true);
                                }
                                hidePreparation(session.seekNotice);
                                session.seekNotice = null;
                                updateStockClock(lampa, session.offset, session.duration);
                            });
                        });
                    }
                    session.seek = function (fraction) { if (session.hls) restartStream(fraction * session.duration); };
                    session.recover = function () {
                        restartStream(session.current === undefined ? session.offset : session.current, undefined, true);
                    };
                    session.switchAudio = function (ordinal, trackCount) {
                        if (!session.hls || session.seekNotice || gatewaySession !== session || !session.stockReady) return;
                        var selection = {};
                        session.audioSelection = selection;
                        gatewayRequest('GET', session.api + '/tracks', session.key, null, function (status, tracks) {
                            if (gatewaySession !== session || session.audioSelection !== selection) return;
                            var audio = status === 200 && tracks && Array.isArray(tracks.audio) && tracks.audio.slice(0, 8);
                            if (!audio || audio.length !== trackCount || !audio[ordinal]) return;
                            restartStream(session.current === undefined ? session.offset : session.current, audio[ordinal].index);
                        });
                    };
                }
                gatewaySession = session;
                session.timer = window.setInterval(function () {
                    gatewayRequest('PATCH', session.api, session.key);
                }, 45000);
                try {
                    if (reuse) {
                        pending.warmMedia = null;
                        if (data.playlist && typeof lampa.Player.playlist === 'function') lampa.Player.playlist(data.playlist);
                        readyStockGateway(session, lampa);
                        warmMedia.loop = false;
                        warmMedia.src = data.url;
                        warmMedia.load();
                    } else fallback(data);
                }
                catch (error) { failed(session, 'Запуск штатного плеера'); }
            }
            function prepare() {
                if (typeof result.stream_url !== 'string' || result.stream_url.indexOf(prefix) !== 0) {
                    failed(session, 'Некорректный URL потока');
                    return;
                }
                stream = gateway + result.stream_url.slice(1);
                if (result.mode === 'direct') launch();
                else {
                    pending.notice.textContent = 'Подготавливаем поток для плеера…';
                    pending.xhr = waitForHls(stream, function () {
                        return request === playbackRequest && pendingGateway === pending;
                    }, function (timer) { pending.poll = timer; }, function (ready, status) {
                        if (ready) launch();
                        else failed(session, 'Загрузка HLS', status === 200 || status === 503 ? null : status,
                            'Не удалось собрать начальный буфер');
                    });
                }
            }
            var resume = trackedHls ? savedPosition(original) : 0;
            if (!(resume > 0 && resume < result.duration)) { prepare(); return; }
            pending.xhr = gatewayRequest('POST', session.api + '/seek', session.key, { seconds: resume }, function (status, shifted) {
                if (request !== playbackRequest) return;
                if (status !== 200 || !shifted || shifted.id !== result.id) {
                    failed(session, 'Продолжение просмотра', status);
                    return;
                }
                result = shifted;
                prepare();
            });
        }
        pending.xhr = gatewayRequest('POST', api, auth.key, input, created);
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
        if (lampa.PlayerVideo && lampa.PlayerVideo.listener) {
            if (lampa.PlayerPanel && lampa.PlayerPanel.listener) {
                lampa.PlayerPanel.listener.follow('mouse_rewind', function (event) {
                    var session = gatewaySession;
                    if (!session || !session.stockReady || !session.seek) return;
                    if (event.method === 'click') session.seek(event.percent);
                });
            }
            lampa.PlayerVideo.listener.follow('tracks', function (event) {
                if (gatewaySession) rememberStockAudio(gatewaySession, event.tracks);
            });
            lampa.Player.listener.follow('ready', function (data) {
                var media = typeof lampa.PlayerVideo.video === 'function' && lampa.PlayerVideo.video();
                if (pendingGateway && pendingGateway.warmData === data) {
                    var waiting = pendingGateway;
                    waiting.warmReady = true;
                    if (media) {
                        media.loop = true;
                        waiting.warmMedia = media;
                    }
                    if (waiting.onWarmReady) waiting.onWarmReady();
                    return;
                }
                var session = gatewaySession;
                if (!session || session.playData !== data) return;
                readyStockGateway(session, lampa);
                if (media && media.readyState >= 3) tryStockPlay(session, media);
            });
            lampa.PlayerVideo.listener.follow('canplay', function () {
                if (gatewaySession && typeof lampa.PlayerVideo.video === 'function') {
                    tryStockPlay(gatewaySession, lampa.PlayerVideo.video());
                }
            });
            lampa.PlayerVideo.listener.follow('timeupdate', function (event) {
                var media = typeof lampa.PlayerVideo.video === 'function' && lampa.PlayerVideo.video();
                if (gatewaySession && event.current > 0 && gatewaySession.startup && (!media || !media.paused)) {
                    clearStartup(gatewaySession);
                }
                if (gatewaySession && gatewaySession.stockReady && !gatewaySession.seekNotice) stockTimeUpdate(gatewaySession, lampa, event);
            });
            lampa.PlayerVideo.listener.follow('play', function () {
                if (gatewaySession) {
                    clearStartup(gatewaySession);
                }
                if (gatewaySession && gatewaySession.progress) gatewaySession.progress('playing');
            });
            lampa.PlayerVideo.listener.follow('pause', function () {
                if (gatewaySession && gatewaySession.progress) gatewaySession.progress('paused');
            });
            lampa.PlayerVideo.listener.follow('destroy', function (event) {
                if (!event.savemeta && gatewaySession && gatewaySession.progress) gatewaySession.progress('stopped');
            });
        }
        lampa.Player.listener.follow('destroy', function () {
            if (pendingGateway && pendingGateway.warmMedia) {
                playbackRequest++;
                cancelPendingGateway();
            }
            releaseGateway(gatewaySession);
        });
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
            var enabled = lampa.Storage.field(name + '_enabled') === true && typeof event.abort === 'function';
            var url = enabled && source(event.data);
            if (!url) {
                playbackRequest++;
                cancelPendingGateway();
                releaseGateway(gatewaySession);
                return;
            }
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
                var custom = lampa.Storage.field(name + '_custom') === true;
                if (useGateway && !custom && pendingGateway && pendingGateway.url === url && pendingGateway.gateway === gateway) {
                    event.abort();
                    return;
                }
                var request = ++playbackRequest;
                cancelPendingGateway();
                releaseGateway(gatewaySession);
                if (event.data.transcodeSource && event.data.url === event.data.transcodeSource.stream) {
                    event.data.url = event.data.transcodeSource.url;
                }
                if (custom) {
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
