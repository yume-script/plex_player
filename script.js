(function () {
    'use strict';

    var PLUGIN_ID = 'plex_player';
    var DB_TYPE = 'general'; // 플러그인 설정을 general 스코프에 저장/조회합니다.
    var HLS_CDN_URL = 'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.13/hls.min.js';

    var state = {
        baseUrl: '',
        libraryKey: '',
        libraryTitle: '',
        libraryType: '', // 'movie' | 'show'
        view: 'sections', // 'sections' | 'videos' | 'episodes'
        showTitle: '',
        showRatingKey: '',
        page: 1,
        totalPages: 1,
        sort: 'added_desc', // '' | 'title_asc' | 'title_desc' | 'added_desc' | 'added_asc' | 'release_desc' | 'release_asc'
    };

    var els = {};

    function $(id) {
        return document.getElementById(id);
    }

    function cacheEls() {
        els.select = $('plexLibrarySelect');
        els.sortSelect = $('plexSortSelect');
        els.backBtn = $('plexBackBtn');
        els.breadcrumb = $('plexBreadcrumb');
        els.loading = $('plexLoading');
        els.grid = $('plexGrid');
        els.pagination = $('plexPagination');
        els.overlay = $('plexPlayerOverlay');
        els.video = $('plexVideoEl');
        els.playerTitle = $('plexPlayerTitle');
        els.playerClose = $('plexPlayerClose');
    }

    function setLoading(isLoading) {
        els.loading.style.display = isLoading ? 'inline' : 'none';
    }

    async function callPlugin(action, params) {
        var qs = new URLSearchParams(Object.assign({
            type: DB_TYPE,
            limit: 50,
            action: action,
        }, params || {}));
        var res = await fetch('/api/media/dashboard/widgets/' + PLUGIN_ID + '/data?' + qs.toString());
        return res.json();
    }

    function renderError(message) {
        els.grid.innerHTML = '<div class="plex-error">' + escapeHtml(message || '오류가 발생했습니다.') + '</div>';
        els.pagination.innerHTML = '';
    }

    function escapeHtml(str) {
        var div = document.createElement('div');
        div.textContent = str == null ? '' : String(str);
        return div.innerHTML;
    }

    // 페이지 하나(최대 ITEMS_PER_PAGE개)에 필요한 썸네일을 한 번의 요청으로
    // 일괄 조회합니다. 카드 수만큼 fetch()를 개별로 순차 발사하던 이전
    // 방식이 첫 페이지 로딩 체감 속도를 가장 크게 늦추는 지점이었습니다.
    async function loadThumbsBatch(targets) {
        if (!targets || targets.length === 0) return;

        var uniquePaths = [];
        var seen = {};
        targets.forEach(function (t) {
            if (t.path && !seen[t.path]) {
                seen[t.path] = true;
                uniquePaths.push(t.path);
            }
        });
        if (uniquePaths.length === 0) return;

        try {
            var data = await callPlugin('thumbs', { thumb_paths: JSON.stringify(uniquePaths) });
            if (!data.success) {
                console.warn('[PlexPlugin] 썸네일 일괄 로드 실패:', data.error);
                return;
            }
            var map = data.items || {};
            targets.forEach(function (t) {
                var url = map[t.path];
                if (url) {
                    t.img.src = url;
                }
            });
        } catch (e) {
            console.warn('[PlexPlugin] 썸네일 일괄 요청 오류:', e);
        }
    }

    function formatDuration(ms) {
        if (!ms || isNaN(ms)) return '';
        var totalMin = Math.round(ms / 60000);
        var h = Math.floor(totalMin / 60);
        var m = totalMin % 60;
        return h > 0 ? (h + '시간 ' + m + '분') : (m + '분');
    }

    // ------------------------------------------------------------------
    // hls.js 동적 로딩
    // ------------------------------------------------------------------
    // 이 플러그인의 index.html(카테고리 풀페이지용 HTML 번들)에는 원래
    // <script src="...hls.min.js"></script> 태그가 있었지만, 코어가 이
    // html 문자열을 innerHTML로 화면에 주입하는 구조라 브라우저가 그
    // <script> 태그를 절대 실행하지 않았습니다(innerHTML로 삽입된 script
    // 태그는 DOM 스펙상 실행되지 않음). 그 결과 window.Hls가 항상
    // undefined였고, 목록을 클릭해 재생을 시도해도 "이 브라우저는 HLS
    // 스트리밍 재생을 지원하지 않습니다" 알럿만 뜨고 아무 것도 재생되지
    // 않았습니다. 여기 script.js(코어가 별도로 정상 실행해주는 js 번들)
    // 안에서 createElement로 스크립트를 직접 주입해 확실히 실행되게
    // 합니다.
    var hlsLoadPromise = null;
    function ensureHlsLoaded() {
        if (window.Hls) {
            return Promise.resolve(window.Hls);
        }
        if (hlsLoadPromise) {
            return hlsLoadPromise;
        }
        hlsLoadPromise = new Promise(function (resolve, reject) {
            var script = document.createElement('script');
            script.src = HLS_CDN_URL;
            script.async = true;
            script.onload = function () {
                if (window.Hls) {
                    resolve(window.Hls);
                } else {
                    reject(new Error('hls.js 로드는 됐지만 window.Hls를 찾을 수 없습니다.'));
                }
            };
            script.onerror = function () {
                reject(new Error('hls.js 스크립트를 불러오지 못했습니다 (네트워크/CDN 접근 문제).'));
            };
            document.head.appendChild(script);
        });
        return hlsLoadPromise;
    }

    // ------------------------------------------------------------------
    // 라이브러리(섹션) 로딩
    // ------------------------------------------------------------------
    async function loadSections() {
        setLoading(true);
        els.select.innerHTML = '<option value="">불러오는 중...</option>';
        var data = await callPlugin('sections');
        setLoading(false);

        if (!data.success) {
            els.select.innerHTML = '<option value="">설정 필요</option>';
            renderError(data.error || 'Plex 서버 설정을 확인해주세요.');
            return;
        }

        state.baseUrl = data.base_url || '';

        var sections = data.sections || [];
        if (sections.length === 0) {
            els.select.innerHTML = '<option value="">등록된 라이브러리 없음</option>';
            els.grid.innerHTML = '<div class="plex-empty">Plex 서버에 영화/TV 라이브러리가 없습니다.</div>';
            return;
        }

        els.select.innerHTML = '<option value="">라이브러리 선택...</option>' +
            sections.map(function (s) {
                return '<option value="' + escapeHtml(s.key) + '" data-type="' + escapeHtml(s.type) + '" data-title="' + escapeHtml(s.title) + '">' +
                    escapeHtml(s.title) + '</option>';
            }).join('');
    }

    async function onLibraryChange() {
        var opt = els.select.options[els.select.selectedIndex];
        var key = els.select.value;
        if (!key) {
            state.view = 'sections';
            renderBreadcrumb();
            els.grid.innerHTML = '<div class="plex-empty">상단에서 Plex 라이브러리를 선택해주세요.</div>';
            els.pagination.innerHTML = '';
            els.backBtn.style.display = 'none';
            return;
        }
        state.libraryKey = key;
        state.libraryTitle = opt.getAttribute('data-title') || '';
        state.libraryType = opt.getAttribute('data-type') || '';
        state.view = 'videos';
        els.backBtn.style.display = 'none';
        await loadVideos(1);
    }

    async function loadVideos(page) {
        page = page || 1;
        setLoading(true);
        els.grid.innerHTML = '';
        els.pagination.innerHTML = '';
        var data = await callPlugin('videos', { library_key: state.libraryKey, page: page, sort: state.sort });
        setLoading(false);

        if (!data.success) {
            renderError(data.error);
            return;
        }

        state.page = data.page || page;
        state.totalPages = data.total_pages || 1;

        renderBreadcrumb();
        renderGrid(data.items || [], function (item) {
            if (item.type === 'show') {
                openShow(item, 1);
            } else {
                playVideo(item.rating_key, item.title);
            }
        });
        renderPagination(state.page, state.totalPages, function (targetPage) {
            loadVideos(targetPage);
        });
    }

    async function openShow(item, page) {
        page = page || 1;
        state.view = 'episodes';
        state.showTitle = item.title;
        state.showRatingKey = item.rating_key;
        els.backBtn.style.display = 'inline-block';
        setLoading(true);
        els.grid.innerHTML = '';
        els.pagination.innerHTML = '';
        var data = await callPlugin('episodes', { rating_key: item.rating_key, page: page, sort: state.sort });
        setLoading(false);

        if (!data.success) {
            renderError(data.error);
            return;
        }

        state.page = data.page || page;
        state.totalPages = data.total_pages || 1;

        renderBreadcrumb();
        renderGrid(data.items || [], function (ep) {
            playVideo(ep.rating_key, state.showTitle + ' - ' + ep.title);
        });
        renderPagination(state.page, state.totalPages, function (targetPage) {
            openShow({ title: state.showTitle, rating_key: state.showRatingKey }, targetPage);
        });
    }

    function renderBreadcrumb() {
        if (state.view === 'episodes') {
            els.breadcrumb.textContent = state.libraryTitle + ' / ' + state.showTitle;
        } else if (state.view === 'videos') {
            els.breadcrumb.textContent = state.libraryTitle;
        } else {
            els.breadcrumb.textContent = '';
        }
    }

    function renderGrid(items, onClickItem) {
        if (!items || items.length === 0) {
            els.grid.innerHTML = '<div class="plex-empty">표시할 항목이 없습니다.</div>';
            return;
        }

        els.grid.innerHTML = '';
        var thumbTargets = [];

        items.forEach(function (item) {
            var card = document.createElement('div');
            card.className = 'plex-card';

            var thumbWrap = document.createElement('div');
            thumbWrap.className = 'plex-card-thumb-wrap';

            var img = document.createElement('img');
            img.loading = 'lazy';
            img.alt = item.title || '';
            thumbWrap.appendChild(img);
            if (item.thumb) {
                thumbTargets.push({ path: item.thumb, img: img });
            }

            if (item.type === 'show' && item.leaf_count) {
                var badge = document.createElement('span');
                badge.className = 'plex-card-badge';
                badge.textContent = item.leaf_count + '화';
                thumbWrap.appendChild(badge);
            } else if (item.duration_ms) {
                var badge2 = document.createElement('span');
                badge2.className = 'plex-card-badge';
                badge2.textContent = formatDuration(item.duration_ms);
                thumbWrap.appendChild(badge2);
            }

            var body = document.createElement('div');
            body.className = 'plex-card-body';

            var title = document.createElement('div');
            title.className = 'plex-card-title';
            title.textContent = item.title || '';
            body.appendChild(title);

            if (item.year) {
                var meta = document.createElement('div');
                meta.className = 'plex-card-meta';
                meta.textContent = item.year;
                body.appendChild(meta);
            }

            card.appendChild(thumbWrap);
            card.appendChild(body);
            card.addEventListener('click', function () {
                onClickItem(item);
            });

            els.grid.appendChild(card);
        });

        loadThumbsBatch(thumbTargets);
    }

    // ------------------------------------------------------------------
    // 페이지네이션 ([1] [2] [3] ... 스타일)
    // ------------------------------------------------------------------
    function renderPagination(page, totalPages, onPageClick) {
        els.pagination.innerHTML = '';
        if (!totalPages || totalPages <= 1) {
            return;
        }

        function makeBtn(label, targetPage, opts) {
            opts = opts || {};
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = label;
            btn.className = 'plex-page-btn' + (opts.active ? ' active' : '');
            if (opts.disabled) {
                btn.disabled = true;
            } else {
                btn.addEventListener('click', function () {
                    onPageClick(targetPage);
                });
            }
            return btn;
        }

        function makeEllipsis() {
            var span = document.createElement('span');
            span.className = 'plex-page-ellipsis';
            span.textContent = '…';
            return span;
        }

        els.pagination.appendChild(makeBtn('이전', page - 1, { disabled: page <= 1 }));

        // 현재 페이지 주변 ±2, 첫/마지막 페이지는 항상 노출, 나머지는 '…'로 축약.
        var windowStart = Math.max(1, page - 2);
        var windowEnd = Math.min(totalPages, page + 2);

        if (windowStart > 1) {
            els.pagination.appendChild(makeBtn('1', 1, { active: page === 1 }));
            if (windowStart > 2) {
                els.pagination.appendChild(makeEllipsis());
            }
        }

        for (var p = windowStart; p <= windowEnd; p++) {
            els.pagination.appendChild(makeBtn(String(p), p, { active: p === page }));
        }

        if (windowEnd < totalPages) {
            if (windowEnd < totalPages - 1) {
                els.pagination.appendChild(makeEllipsis());
            }
            els.pagination.appendChild(makeBtn(String(totalPages), totalPages, { active: page === totalPages }));
        }

        els.pagination.appendChild(makeBtn('다음', page + 1, { disabled: page >= totalPages }));
    }

    // ------------------------------------------------------------------
    // 재생
    // ------------------------------------------------------------------
    async function playVideo(ratingKey, title) {
        setLoading(true);
        var data = await callPlugin('play', { rating_key: ratingKey });
        setLoading(false);

        if (!data.success) {
            alert(data.error || '재생 정보를 가져오지 못했습니다.');
            return;
        }

        if (!window.BookOasisPlugin || !window.BookOasisPlugin.getStreamProxyUrl) {
            alert('현재 앱 환경에서는 스트리밍 프록시 기능을 사용할 수 없습니다.');
            return;
        }

        var proxyUrl = await window.BookOasisPlugin.getStreamProxyUrl(data.stream_url);
        if (!proxyUrl) {
            alert('Plex 서버 주소가 외부 도메인 화이트리스트에 없습니다.\n설정 > 외부 도메인에서 Plex 서버 주소(호스트)를 등록해주세요.');
            return;
        }

        await openPlayer(proxyUrl, title || data.title);
    }

    async function openPlayer(url, title) {
        var HlsCtor = null;
        try {
            HlsCtor = await ensureHlsLoaded();
        } catch (e) {
            console.error('[PlexPlugin]', e);
        }

        var canUseHlsJs = !!(HlsCtor && HlsCtor.isSupported());
        var canUseNativeHls = els.video.canPlayType('application/vnd.apple.mpegurl');

        if (!canUseHlsJs && !canUseNativeHls) {
            alert('영상 재생 라이브러리(hls.js)를 불러오지 못했거나, 이 브라우저가 HLS 재생을 지원하지 않습니다.\n' +
                '네트워크 상태를 확인하거나 광고 차단/보안 확장 프로그램을 잠시 꺼본 뒤 다시 시도해주세요.');
            return;
        }

        // 재생 가능함이 확인된 뒤에만 모달을 띄웁니다 (이전에는 이 체크보다
        // 먼저 오버레이가 열려서, 재생 불가 상황에도 빈 검은 화면 모달만
        // 뜨는 문제가 있었습니다).
        els.playerTitle.textContent = title || '';
        els.overlay.style.display = 'flex';

        if (window.__plexHls) {
            window.__plexHls.destroy();
            window.__plexHls = null;
        }

        if (canUseHlsJs) {
            var hls = new HlsCtor({
                // VOD(다시보기) 재생이라 라이브 지연을 신경 쓸 필요가 없으므로,
                // 순간적인 네트워크 지터를 흡수할 수 있도록 버퍼를 넉넉히
                // 잡아 재생 중 버벅임(리버퍼링)을 줄입니다.
                maxBufferLength: 60,       // 목표 버퍼 길이(초)
                maxMaxBufferLength: 120,   // 네트워크가 좋을 때 늘어날 수 있는 최대치(초)
                backBufferLength: 30,      // 되감기 대비 유지할 과거 버퍼(초)

                // Plex 트랜스코더가 첫 재생 시 콜드 스타트(트랜스코드 세션
                // 생성)하는 데 hls.js 기본 타임아웃(약 10초)보다 오래 걸릴
                // 수 있습니다. 기본값대로 두면 hls.js가 너무 일찍 포기하고
                // 재시도하는 사이 세그먼트가 아직 준비되지 않아 전부
                // 404(fragLoadError)로 실패하는 문제가 있었습니다. 초기
                // 매니페스트/레벨/세그먼트 로딩 타임아웃을 넉넉히 늘려
                // 워밍업 시간을 버틸 수 있게 합니다.
                manifestLoadingTimeOut: 20000,
                manifestLoadingMaxRetry: 4,
                levelLoadingTimeOut: 20000,
                levelLoadingMaxRetry: 4,
                fragLoadingTimeOut: 20000,
                fragLoadingMaxRetry: 6,
            });

            var madeProgress = false;
            var nonFatalErrorCount = 0;
            hls.on(HlsCtor.Events.FRAG_BUFFERED, function () {
                madeProgress = true;
                nonFatalErrorCount = 0;
            });

            hls.on(HlsCtor.Events.ERROR, function (event, data) {
                // 콘솔이 객체를 "Object" 자리표시자로만 찍어서 details/fatal이
                // 안 보이는 경우가 있어, 읽을 수 있는 문자열로도 함께 남깁니다.
                // hls-proxy는 실패 시 {"success":false,"error":"...","message":"..."}
                // 형식의 JSON 본문을 돌려주는데, httpStatus만으로는 그 이유를 알 수
                // 없어서 responseText까지 최대한 끌어모아 함께 남깁니다.
                var responseText = null;
                try {
                    if (data && data.networkDetails && typeof data.networkDetails.responseText === 'string') {
                        responseText = data.networkDetails.responseText;
                    } else if (data && data.response && typeof data.response.text === 'string') {
                        responseText = data.response.text;
                    } else if (data && data.response && typeof data.response.data === 'string') {
                        responseText = data.response.data;
                    }
                } catch (e) {
                    // 무시 - 진단 로깅용 보조 정보일 뿐 재생 흐름에 영향 없음
                }
                if (responseText && responseText.length > 500) {
                    responseText = responseText.slice(0, 500) + '...';
                }

                var info = {
                    type: data && data.type,
                    details: data && data.details,
                    fatal: data && data.fatal,
                    reason: data && data.reason,
                    httpStatus: data && data.response && data.response.code,
                    responseText: responseText,
                    url: data && (data.url || (data.frag && data.frag.url) || (data.context && data.context.url)),
                };
                console.error('[PlexPlugin] HLS 오류:', JSON.stringify(info), data);

                // hls.js 내부 XHR 객체에서 응답 본문을 못 건진 경우, 실패한
                // URL을 별도로 한 번 더 fetch해서 실제 응답 본문(hls-proxy의
                // error/message JSON일 가능성이 높음)을 확실히 남깁니다.
                // 재생 흐름에는 영향을 주지 않는 순수 진단용이라 결과를
                // 기다리지 않습니다.
                if (!responseText && info.url) {
                    fetch(info.url).then(function (r) {
                        return r.text().then(function (t) {
                            console.error('[PlexPlugin] 실패 URL 재확인 응답:', r.status, t.slice(0, 500));
                        });
                    }).catch(function (e) {
                        console.error('[PlexPlugin] 실패 URL 재확인 중 오류:', e);
                    });
                }

                if (data && data.fatal) {
                    alert('영상 재생 중 오류가 발생했습니다.\n' +
                        (data.details || data.type || '알 수 없는 오류') +
                        '\n\n브라우저 개발자 도구 콘솔에서 자세한 내용을 확인해주세요.');
                    return;
                }

                // fatal은 아니지만 한 번도 정상 재생이 진행되지 못한 채
                // 에러가 계속 반복되는 경우(예: 매 세그먼트 요청이 즉시
                // 실패하는 무한 루프)는 사실상 재생 불가 상태인데도 알림이
                // 안 뜨고 콘솔만 계속 쌓이는 문제가 있었습니다. 일정 횟수를
                // 넘기면 세션을 정리하고 한 번만 알려줍니다.
                nonFatalErrorCount += 1;
                if (!madeProgress && nonFatalErrorCount >= 20) {
                    if (window.__plexHls) {
                        window.__plexHls.destroy();
                        window.__plexHls = null;
                    }
                    alert('영상 재생을 시작하지 못했습니다 (반복 오류).\n' +
                        '마지막 오류: ' + (data.details || data.type || '알 수 없는 오류') +
                        '\n\n브라우저 개발자 도구 콘솔에서 [PlexPlugin] HLS 오류 로그를 확인해주세요.');
                }
            });

            hls.loadSource(url);
            hls.attachMedia(els.video);
            window.__plexHls = hls;
        } else {
            els.video.src = url;
        }

        els.video.play().catch(function () {
            // 자동재생이 차단된 경우 사용자가 직접 재생 버튼을 눌러야 함
        });
    }

    function closePlayer() {
        els.video.pause();
        els.video.removeAttribute('src');
        els.video.load();
        if (window.__plexHls) {
            window.__plexHls.destroy();
            window.__plexHls = null;
        }
        els.overlay.style.display = 'none';
    }

    // ------------------------------------------------------------------
    // 초기화
    // ------------------------------------------------------------------
    function init() {
        cacheEls();
        els.select.addEventListener('change', onLibraryChange);
        els.sortSelect.addEventListener('change', function () {
            state.sort = els.sortSelect.value;
            // 정렬이 바뀌면 페이지 번호는 더 이상 의미가 없으므로 1페이지로
            // 리셋하고, 지금 보고 있는 화면(영화/시리즈 목록 또는 에피소드
            // 목록)을 새 정렬로 다시 불러옵니다. 아직 라이브러리를 선택하지
            // 않은 상태(sections)면 다음 로드 때 자동 반영되므로 아무 것도
            // 안 합니다.
            if (state.view === 'videos') {
                loadVideos(1);
            } else if (state.view === 'episodes') {
                openShow({ title: state.showTitle, rating_key: state.showRatingKey }, 1);
            }
        });
        els.backBtn.addEventListener('click', function () {
            if (state.view === 'episodes') {
                state.view = 'videos';
                els.backBtn.style.display = 'none';
                loadVideos(1);
            }
        });
        els.playerClose.addEventListener('click', closePlayer);
        // 첫 재생 클릭 시점의 대기시간을 줄이기 위해 미리 로드를 시작해둡니다.
        // 실패해도(네트워크 등) 여기서는 조용히 무시하고, 실제 재생 시점에
        // openPlayer()가 다시 시도합니다.
        ensureHlsLoaded().catch(function (e) {
            console.warn('[PlexPlugin] hls.js 사전 로드 실패(재생 시점에 재시도됨):', e);
        });
        loadSections();
    }

    init();
})();
