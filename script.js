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
        search: '',
        isPlaying: false,
        currentRatingKey: null,
        currentTitle: '',
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
        els.inlineSlot = $('plexInlinePlayerSlot');
        els.placeholder = $('plexPlayerPlaceholder');
        els.sidebar = $('plexSidebar');
        els.sidebarToggle = $('plexSidebarToggle');
        els.searchInput = $('plexSearchInput');
        els.libraryPrefsBtn = $('plexLibraryPrefsBtn');
        els.libraryPrefsOverlay = $('plexLibraryPrefsOverlay');
        els.libraryPrefsClose = $('plexLibraryPrefsClose');
        els.libraryPrefsList = $('plexLibraryPrefsList');
        els.libraryPrefsSelectAll = $('plexLibraryPrefsSelectAll');
        els.libraryPrefsSelectNone = $('plexLibraryPrefsSelectNone');
        els.libraryPrefsSave = $('plexLibraryPrefsSave');
        els.libraryPrefsStatus = $('plexLibraryPrefsStatus');
        els.libraryPrefsResultRow = $('plexLibraryPrefsResultRow');
        els.libraryPrefsResult = $('plexLibraryPrefsResult');
        els.libraryPrefsCopy = $('plexLibraryPrefsCopy');

        // 재생 영역. 예전에는 미니창 모드에서 이 전체가 document.body로
        // 옮겨졌지만(그러다 재방문 시 코어가 그 DOM을 정리해버려 미니창이
        // 풀리는 버그가 있었습니다), 지금은 브라우저의 진짜 Document
        // Picture-in-Picture API로 <video> 노드 자체만 별도 창으로
        // 옮깁니다(openMiniWindow 참고) - 이 컨테이너(plexPlayerArea)
        // 자신은 절대 이동하지 않고 항상 이 자리에 고정되어 있습니다.
        els.playerArea = $('plexPlayerArea');
        els.videoWrap = $('plexVideoWrap');
        els.video = $('plexVideoEl');
        els.playerTitle = $('plexPlayerTitle');
        els.playerClose = $('plexPlayerClose');
        els.miniBtn = $('plexPlayerMiniBtn');
        els.playerLoading = $('plexPlayerLoading');
        els.playerLoadingText = $('plexPlayerLoadingText');
    }

    function showPlayerLoading(text) {
        if (!els.playerLoading) return;
        if (els.playerLoadingText) {
            els.playerLoadingText.textContent = text || '동영상을 준비하고 있습니다...';
        }
        els.playerLoading.style.display = 'flex';
    }

    function hidePlayerLoading() {
        if (!els.playerLoading) return;
        els.playerLoading.style.display = 'none';
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

    // ------------------------------------------------------------------
    // 라이브러리 표시 설정 (체크박스 모달)
    // ------------------------------------------------------------------
    async function openLibraryPrefs() {
        els.libraryPrefsOverlay.style.display = 'flex';
        els.libraryPrefsList.innerHTML = '<div class="plex-empty">불러오는 중...</div>';
        els.libraryPrefsStatus.textContent = '';
        els.libraryPrefsResultRow.style.display = 'none';

        var data = await callPlugin('library_prefs');
        if (!data.success) {
            els.libraryPrefsList.innerHTML = '<div class="plex-error">' + escapeHtml(data.error || '불러오지 못했습니다.') + '</div>';
            return;
        }

        var sections = data.sections || [];
        // selected가 null이면 "설정 안 함 = 전체 표시" 상태이므로 전부
        // 체크된 것으로 그립니다.
        var selectedSet = null;
        if (Array.isArray(data.selected)) {
            selectedSet = {};
            data.selected.forEach(function (name) { selectedSet[name] = true; });
        }

        if (sections.length === 0) {
            els.libraryPrefsList.innerHTML = '<div class="plex-empty">Plex 서버에 영화/TV 라이브러리가 없습니다.</div>';
            return;
        }

        els.libraryPrefsList.innerHTML = '';
        sections.forEach(function (s) {
            var label = document.createElement('label');
            label.className = 'plex-library-prefs-item';

            var checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = s.title || '';
            checkbox.checked = selectedSet ? !!selectedSet[s.title] : true;

            var titleSpan = document.createElement('span');
            titleSpan.textContent = s.title || '';

            var typeSpan = document.createElement('span');
            typeSpan.className = 'plex-library-prefs-type';
            typeSpan.textContent = s.type === 'show' ? 'TV' : '영화';

            label.appendChild(checkbox);
            label.appendChild(titleSpan);
            label.appendChild(typeSpan);
            els.libraryPrefsList.appendChild(label);
        });
    }

    function closeLibraryPrefs() {
        els.libraryPrefsOverlay.style.display = 'none';
        els.libraryPrefsResultRow.style.display = 'none';
    }

    function setAllLibraryPrefsCheckboxes(checked) {
        var boxes = els.libraryPrefsList.querySelectorAll('input[type="checkbox"]');
        boxes.forEach(function (box) { box.checked = checked; });
    }

    // 이 플러그인은 자체적으로 설정을 저장할 안전한 방법이 없습니다
    // (코어의 설정 저장 API는 정확한 요청 형식이 문서화되어 있지 않아,
    // 예전에 추측으로 직접 썼다가 기존 PLEX_URL/TOKEN 설정이 통째로
    // 사라지는 사고가 있었습니다). 그래서 체크한 결과를 문자열로만
    // 보여주고, 실제 저장은 항상 코어의 정식 설정 화면에서 사용자가
    // 직접 하도록 합니다 - 아무것도 쓰지 않으므로 100% 안전합니다.
    function saveLibraryPrefs() {
        var boxes = els.libraryPrefsList.querySelectorAll('input[type="checkbox"]');
        var total = boxes.length;
        var checkedTitles = [];
        boxes.forEach(function (box) {
            if (box.checked) checkedTitles.push(box.value);
        });

        if (checkedTitles.length === 0) {
            alert('최소 1개 이상의 라이브러리를 선택해주세요.\n(전부 해제하면 "전체 표시"와 구분할 수 없습니다.)');
            return;
        }

        // 전부 선택한 경우 특정 이름을 나열하지 않고 빈 값(=전체 표시)을
        // 안내합니다. 나중에 Plex에 라이브러리가 추가돼도 자동으로 목록에
        // 나타나게 하기 위해서입니다.
        var resultValue = (total > 0 && checkedTitles.length === total) ? '' : checkedTitles.join(', ');

        els.libraryPrefsResult.value = resultValue;
        els.libraryPrefsResultRow.style.display = 'block';
        els.libraryPrefsResult.focus();
        els.libraryPrefsResult.select();
    }

    async function copyLibraryPrefsResult() {
        var value = els.libraryPrefsResult.value;
        try {
            await navigator.clipboard.writeText(value);
            els.libraryPrefsStatus.textContent = '복사됨';
        } catch (e) {
            // 클립보드 API를 못 쓰는 환경(권한/HTTPS 아님 등) - 이미 위에서
            // select()로 선택해뒀으니 사용자가 Ctrl+C로 직접 복사하면 됩니다.
            els.libraryPrefsResult.focus();
            els.libraryPrefsResult.select();
            els.libraryPrefsStatus.textContent = '자동 복사 실패 - 입력창이 선택되어 있으니 Ctrl+C로 복사해주세요.';
        }
        setTimeout(function () { els.libraryPrefsStatus.textContent = ''; }, 3000);
    }

    async function onLibraryChange() {
        var opt = els.select.options[els.select.selectedIndex];
        var key = els.select.value;
        // 다른 라이브러리로 넘어가면 이전 검색어가 남아있어 혼란을 주지
        // 않도록 초기화합니다.
        state.search = '';
        if (els.searchInput) els.searchInput.value = '';
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
        var data = await callPlugin('videos', { library_key: state.libraryKey, page: page, sort: state.sort, search: state.search });
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
        var data = await callPlugin('episodes', { rating_key: item.rating_key, page: page, sort: state.sort, search: state.search });
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
            var row = document.createElement('div');
            row.className = 'plex-list-item';

            var thumbWrap = document.createElement('div');
            thumbWrap.className = 'plex-list-thumb';

            var img = document.createElement('img');
            img.loading = 'lazy';
            img.alt = item.title || '';
            thumbWrap.appendChild(img);
            if (item.thumb) {
                thumbTargets.push({ path: item.thumb, img: img });
            }

            var body = document.createElement('div');
            body.className = 'plex-list-body';

            var title = document.createElement('div');
            title.className = 'plex-list-title';
            title.textContent = item.title || '';
            body.appendChild(title);

            var metaParts = [];
            if (item.year) metaParts.push(String(item.year));
            if (item.type === 'show' && item.leaf_count) {
                metaParts.push(item.leaf_count + '화');
            } else if (item.duration_ms) {
                metaParts.push(formatDuration(item.duration_ms));
            }
            if (metaParts.length > 0) {
                var meta = document.createElement('div');
                meta.className = 'plex-list-meta';
                meta.textContent = metaParts.join(' · ');
                body.appendChild(meta);
            }

            row.appendChild(thumbWrap);
            row.appendChild(body);

            if (item.type === 'show') {
                var badge = document.createElement('span');
                badge.className = 'plex-list-badge';
                badge.textContent = 'TV';
                row.appendChild(badge);
            }

            row.addEventListener('click', function () {
                onClickItem(item);
            });

            els.grid.appendChild(row);
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
        // 사용자가 클릭한 즉시 재생 영역을 열고 로딩 표시부터 보여줍니다.
        // 백엔드의 /play 조회(Plex 트랜스코드 사전 검증 포함)와 프록시 URL
        // 발급에도 몇 초씩 걸릴 수 있어서, 이 단계부터 "뭔가 진행 중"임을
        // 보여주지 않으면 검은 화면만 한동안 보여 멈춘 것처럼 느껴집니다.
        state.currentRatingKey = ratingKey;
        state.currentTitle = title || '';
        openPlayerShell(title);
        showPlayerLoading('재생 정보를 확인하고 있습니다...');

        setLoading(true);
        var data = await callPlugin('play', { rating_key: ratingKey });
        setLoading(false);

        if (!data.success) {
            closePlayer();
            alert(data.error || '재생 정보를 가져오지 못했습니다.');
            return;
        }

        if (!window.BookOasisPlugin || !window.BookOasisPlugin.getStreamProxyUrl) {
            closePlayer();
            alert('현재 앱 환경에서는 스트리밍 프록시 기능을 사용할 수 없습니다.');
            return;
        }

        showPlayerLoading(data.is_direct ? '동영상을 불러오고 있습니다...' : '동영상을 캐싱하고 있습니다...');
        var proxyUrl = await window.BookOasisPlugin.getStreamProxyUrl(data.stream_url);
        if (!proxyUrl) {
            closePlayer();
            alert('Plex 서버 주소가 외부 도메인 화이트리스트에 없습니다.\n설정 > 외부 도메인에서 Plex 서버 주소(호스트)를 등록해주세요.');
            return;
        }

        await openPlayer(proxyUrl, title || data.title, !!data.is_direct);
    }

    // ------------------------------------------------------------------
    // 재생 영역 플레이스홀더 표시/숨김
    // ------------------------------------------------------------------
    function updatePlaceholderVisibility() {
        if (!els.placeholder) return;
        els.placeholder.style.display = state.isPlaying ? 'none' : '';
    }

    // ------------------------------------------------------------------
    // 미니창 = 브라우저의 진짜 Document Picture-in-Picture API
    // ------------------------------------------------------------------
    // 예전에는 이 오버레이 전체를 document.body로 옮겨서 "미니창"을
    // 흉내냈는데, 그 방식은 카테고리를 재방문할 때 코어가 body 하위의
    // 낯선 요소를 정리해버리면 미니창이 풀리는 문제가 있었습니다.
    // 대신 window.documentPictureInPicture API로 완전히 별도의 브라우저
    // 창을 띄우고, <video> 노드 자체를 그 창의 document로 물리적으로
    // reparent합니다 - hls.js 인스턴스를 새로 만들 필요 없이 그대로
    // 이어서 재생되고, 이 창은 BookOasis 페이지와 완전히 분리된
    // top-level browsing context라 BookOasis의 DOM이 어떻게 바뀌든
    // (카테고리 이동 포함) 전혀 영향을 받지 않습니다. 이 API를 지원하지
    // 않는 브라우저에서는 <video>의 네이티브 requestPictureInPicture()로
    // 자동 대체합니다.
    var docPipWindow = null;

    async function toggleMiniWindow() {
        if (docPipWindow && !docPipWindow.closed) {
            docPipWindow.close(); // 뒷정리는 pagehide 핸들러가 담당
            return;
        }
        if (!state.isPlaying) {
            alert('먼저 영상을 재생해주세요.');
            return;
        }
        await openMiniWindow();
    }

    async function openMiniWindow() {
        if (window.documentPictureInPicture && typeof window.documentPictureInPicture.requestWindow === 'function') {
            try {
                var pipWindow = await window.documentPictureInPicture.requestWindow({
                    width: 480,
                    height: 270,
                });

                // 미니창은 호스트 페이지의 CSS를 상속하지 않으므로 최소한의
                // 인라인 스타일만 직접 주입합니다.
                var style = pipWindow.document.createElement('style');
                style.textContent =
                    'html, body { margin:0; padding:0; height:100%; background:#000; overflow:hidden; }' +
                    '#plexMiniVideoWrap { position:relative; width:100%; height:100%; }' +
                    '#plexMiniVideoWrap video { width:100%; height:100%; object-fit:contain; background:#000; }' +
                    '#plexMiniTitleBar { position:absolute; left:0; right:0; bottom:0; padding:4px 10px;' +
                    ' font:12px -apple-system, BlinkMacSystemFont, sans-serif; color:#fff;' +
                    ' background:rgba(0,0,0,0.55); white-space:nowrap; overflow:hidden;' +
                    ' text-overflow:ellipsis; text-align:center; }';
                pipWindow.document.head.appendChild(style);

                var wrap = pipWindow.document.createElement('div');
                wrap.id = 'plexMiniVideoWrap';
                var bar = pipWindow.document.createElement('div');
                bar.id = 'plexMiniTitleBar';
                bar.textContent = state.currentTitle || '';
                wrap.appendChild(bar);

                // 실제 <video> 엘리먼트를 미니창으로 옮깁니다. 새로 만들지
                // 않고 노드 자체를 reparent하므로 붙어있던 hls.js 인스턴스가
                // 끊기지 않고 그대로 이어서 재생됩니다.
                wrap.prepend(els.video);
                pipWindow.document.body.appendChild(wrap);

                docPipWindow = pipWindow;
                updateMiniButtonState();
                attachDocPipCloseHandler(pipWindow);
            } catch (e) {
                console.warn('[PlexPlugin] 미니창 열기 실패, 네이티브 PIP로 대체합니다:', e && e.message);
                await fallbackToNativePip();
            }
            return;
        }

        await fallbackToNativePip();
    }

    async function fallbackToNativePip() {
        if (!els.video.requestPictureInPicture) {
            alert('이 브라우저는 미니창(PIP) 기능을 지원하지 않습니다.');
            return;
        }
        try {
            await els.video.requestPictureInPicture();
        } catch (e) {
            alert('미니창을 여는 데 실패했습니다: ' + (e && e.message ? e.message : e));
        }
    }

    // 미니창이 닫힐 때(사용자가 직접 닫거나 close()를 호출한 경우) 비디오를
    // 원래 자리로 되돌립니다. 이 시점에 카테고리탭 자체가 이미 화면에서
    // 사라진 상태였다면(=다른 사이드바 메뉴로 이동한 뒤 미니창만 닫은 경우)
    // 재생을 완전히 정리하고, 여전히 보이는 상태라면 이어서 인라인 재생을
    // 계속합니다.
    function attachDocPipCloseHandler(pipWindow) {
        pipWindow.addEventListener('pagehide', function () {
            if (els.videoWrap && els.video.parentNode !== els.videoWrap) {
                els.videoWrap.prepend(els.video);
            }
            docPipWindow = null;
            updateMiniButtonState();

            if (isHiddenFromView(els.playerArea)) {
                closePlayer();
            }
        }, { once: true });
    }

    function updateMiniButtonState() {
        if (!els.miniBtn) return;
        var isOpen = !!(docPipWindow && !docPipWindow.closed);
        els.miniBtn.innerHTML = isOpen
            ? '<i class="fa-solid fa-window-close"></i> 미니창 닫기'
            : '<i class="fa-solid fa-clone"></i> 미니창';
        els.miniBtn.title = isOpen ? '미니창을 닫고 원래 화면으로 되돌리기' : '미니창(PIP)으로 분리해서 보기';
    }

    // ------------------------------------------------------------------
    // 카테고리 이동 감지 (BookOasis SPA가 이 화면을 완전히 제거하는지,
    // class/style로 숨기기만 하는지 문서화돼 있지 않아 두 경우를 모두
    // 잡는 범용적인 방식을 씁니다)
    // ------------------------------------------------------------------
    function isHiddenFromView(el) {
        if (!el || !document.body.contains(el)) return true; // 완전히 제거됨
        var node = el;
        while (node && node !== document.body) {
            var cs = getComputedStyle(node);
            if (cs.display === 'none' || cs.visibility === 'hidden') return true;
            node = node.parentElement;
        }
        if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return true;
        return false;
    }

    var navigationObserver = null;

    function setupNavigationCleanupObserver() {
        var rootEl = document.querySelector('.plex-player-container');
        if (!rootEl || !rootEl.parentNode) return;

        var checkAndHandle = function () {
            if (isHiddenFromView(rootEl)) handleContainerRemoved();
        };

        navigationObserver = new MutationObserver(checkAndHandle);
        navigationObserver.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style'],
        });
    }

    function handleContainerRemoved() {
        if (navigationObserver) { navigationObserver.disconnect(); navigationObserver = null; }

        if (document.pictureInPictureElement === els.video) {
            // 네이티브 PIP로 재생 중이면 그대로 유지하고, 사용자가 PIP를
            // 닫는 시점에 정리합니다.
            els.video.addEventListener('leavepictureinpicture', closePlayer, { once: true });
            return;
        }

        if (docPipWindow && !docPipWindow.closed) {
            // 미니창(Document PIP)이 열려있는 동안은 다른 사이드바 메뉴로
            // 이동해도 재생을 유지합니다. 미니창을 닫을 때의 뒷정리는
            // attachDocPipCloseHandler()의 pagehide 리스너가 담당합니다.
            return;
        }

        closePlayer();
    }

    // 재생 URL이 준비되기 전에도(백엔드 조회/프록시 URL 발급 대기 중) 우선
    // 재생 영역부터 열어 로딩 상태를 보여주기 위한 "껍데기" 초기화입니다.
    // 이미 열려 있는 상태에서 다시 호출해도 안전합니다(멱등).
    function openPlayerShell(title) {
        els.playerTitle.textContent = title || '';
        els.placeholder.style.display = 'none';
        els.playerArea.style.display = 'flex';
        state.isPlaying = true;
    }


    async function openPlayer(url, title, isDirect) {
        openPlayerShell(title);

        if (window.__plexHls) {
            window.__plexHls.destroy();
            window.__plexHls = null;
        }

        // Direct Play: 백엔드가 이미 브라우저가 그대로 재생 가능한 파일
        // (mp4/mov + h264/aac)이라고 판단해서 원본 URL을 그대로 줬으므로,
        // hls.js도 트랜스코드도 필요 없이 <video src>로 바로 재생합니다.
        if (isDirect) {
            els.video.src = url;
            els.video.play().catch(function () {
                // 자동재생이 차단된 경우 사용자가 직접 재생 버튼을 눌러야 함
            });
            return;
        }

        var HlsCtor = null;
        try {
            HlsCtor = await ensureHlsLoaded();
        } catch (e) {
            console.error('[PlexPlugin]', e);
        }

        var canUseHlsJs = !!(HlsCtor && HlsCtor.isSupported());
        var canUseNativeHls = els.video.canPlayType('application/vnd.apple.mpegurl');

        if (!canUseHlsJs && !canUseNativeHls) {
            closePlayer();
            alert('영상 재생 라이브러리(hls.js)를 불러오지 못했거나, 이 브라우저가 HLS 재생을 지원하지 않습니다.\n' +
                '네트워크 상태를 확인하거나 광고 차단/보안 확장 프로그램을 잠시 꺼본 뒤 다시 시도해주세요.');
            return;
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
                    hidePlayerLoading();
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
                    hidePlayerLoading();
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
        if (docPipWindow && !docPipWindow.closed) {
            try { docPipWindow.close(); } catch (e) { /* 무시 */ }
        }
        if (document.pictureInPictureElement === els.video) {
            document.exitPictureInPicture().catch(function () {});
        }
        els.video.pause();
        els.video.removeAttribute('src');
        els.video.load();
        if (window.__plexHls) {
            window.__plexHls.destroy();
            window.__plexHls = null;
        }
        hidePlayerLoading();
        els.playerArea.style.display = 'none';
        state.isPlaying = false;
        state.currentRatingKey = null;
        updatePlaceholderVisibility();
    }

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

        // 검색창: 입력할 때마다 바로 요청하지 않고 350ms 동안 추가 입력이
        // 없을 때만 서버(Plex title 필터)에 다시 조회합니다.
        var searchDebounceTimer = null;
        els.searchInput.addEventListener('input', function () {
            var value = els.searchInput.value;
            clearTimeout(searchDebounceTimer);
            searchDebounceTimer = setTimeout(function () {
                state.search = value.trim();
                if (state.view === 'videos') {
                    loadVideos(1);
                } else if (state.view === 'episodes') {
                    openShow({ title: state.showTitle, rating_key: state.showRatingKey }, 1);
                }
            }, 350);
        });

        // 목록 사이드바 접기/펼치기. 선택 상태는 localStorage에 저장해
        // 다음 방문 때도 유지합니다.
        els.sidebarToggle.addEventListener('click', function () {
            var collapsed = els.sidebar.classList.toggle('collapsed');
            els.sidebarToggle.classList.toggle('collapsed', collapsed);
            try {
                localStorage.setItem('plexPlayerSidebarCollapsed', collapsed ? '1' : '0');
            } catch (e) {
                // 프라이빗 모드 등으로 localStorage를 못 쓰는 환경 - 이번
                // 세션에서만 상태가 유지되지 않을 뿐 기능에는 영향 없음.
            }
        });
        try {
            if (localStorage.getItem('plexPlayerSidebarCollapsed') === '1') {
                els.sidebar.classList.add('collapsed');
                els.sidebarToggle.classList.add('collapsed');
            }
        } catch (e) {
            // 위와 동일한 이유로 무시
        }

        // 라이브러리 표시 설정 모달
        els.libraryPrefsBtn.addEventListener('click', openLibraryPrefs);
        els.libraryPrefsClose.addEventListener('click', closeLibraryPrefs);
        els.libraryPrefsSelectAll.addEventListener('click', function () {
            setAllLibraryPrefsCheckboxes(true);
        });
        els.libraryPrefsSelectNone.addEventListener('click', function () {
            setAllLibraryPrefsCheckboxes(false);
        });
        els.libraryPrefsSave.addEventListener('click', saveLibraryPrefs);
        els.libraryPrefsCopy.addEventListener('click', copyLibraryPrefsResult);
        els.libraryPrefsOverlay.addEventListener('click', function (e) {
            // 모달 바깥(반투명 배경) 클릭 시 닫기
            if (e.target === els.libraryPrefsOverlay) closeLibraryPrefs();
        });

        // 재생 영역은 이제 항상 이 화면 안에 고정되어 있습니다(미니창은
        // 진짜 별도 브라우저 창으로 분리되므로 이 컨테이너 자체를 옮기거나
        // 재사용할 필요가 없습니다).
        els.playerClose.addEventListener('click', closePlayer);
        els.miniBtn.addEventListener('click', toggleMiniWindow);
        els.video.addEventListener('loadeddata', hidePlayerLoading);
        els.video.addEventListener('playing', hidePlayerLoading);
        els.video.addEventListener('error', hidePlayerLoading);
        setupNavigationCleanupObserver();

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
