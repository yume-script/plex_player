# -*- coding: utf-8 -*-
"""
Plex Player Plugin for BookOasis
---------------------------------
Plex Media Server의 특정 라이브러리(섹션)를 선택해 영상 목록을 보여주고,
클릭하면 앱 내에서 바로 재생되는 카테고리 레벨 플러그인입니다.

동작 개요:
1. 카테고리 풀페이지 UI(index.html/script.js)가 화면 상단 드롭다운에
   Plex 라이브러리 목록을 채웁니다.
2. 라이브러리를 선택하면 그 안의 영화/시리즈 목록을 페이지 단위([1][2]...
   버튼)로 그리드에 보여줍니다. 시리즈를 클릭하면 에피소드 목록으로
   들어가며, 에피소드 목록도 동일하게 페이지네이션됩니다.
3. 영화/에피소드를 클릭하면 Plex의 Universal Transcode(HLS) 스트림 URL을
   생성해서, 코어가 제공하는 window.BookOasisPlugin.getStreamProxyUrl()로
   프록시된 주소를 받아 hls.js로 재생합니다. hls.js 라이브러리는
   script.js가 런타임에 동적으로 로드합니다(아래 참고).

설계 노트:
- 이 프레임워크는 플러그인이 자체 Flask 라우트를 등록할 수 없으므로,
  코어가 제공하는 단 하나의 공용 엔드포인트
  `/api/media/dashboard/widgets/<plugin_id>/data` (-> get_dashboard_data)를
  간단한 RPC 채널처럼 재사용합니다. 프런트엔드가 쿼리스트링에 action/
  library_key/rating_key를 실어 보내면, 이 메서드가 Flask의 현재 요청
  컨텍스트(flask.request)에서 그 값을 읽어 분기 처리합니다. get_dashboard_data
  의 공식 시그니처는 (db_type, limit)뿐이지만, 이 메서드는 실제 요청 처리
  함수 내부에서 호출되므로 flask.request는 정상적으로 현재 요청을 가리킵니다.
- Plex 서버로 보내는 라이브러리/영상 목록 조회(JSON API)는 이 파일이 서버
  사이드에서 `requests`로 직접 호출합니다. 가이드 문서에 따르면 도메인
  화이트리스트는 브라우저에서 여는 iframe 웹뷰 프록시 전용이라 플러그인
  파이썬 코드가 서버에서 보내는 요청에는 적용되지 않으므로, 화이트리스트
  등록 없이 동작합니다.
- 반면 실제 영상 스트리밍(HLS)은 브라우저가 직접
  `window.BookOasisPlugin.getStreamProxyUrl()`을 호출해야 하므로, 이때는
  사용자가 [설정 > 외부 도메인]에서 Plex 서버 주소를 화이트리스트에
  등록해야 합니다. (설정 화면 안내 문구에도 명시)
- hls.js는 index.html(html 번들) 안의 <script src> 태그가 아니라
  script.js(js 번들)에서 document.createElement로 동적 로드합니다.
  코어가 html 번들을 innerHTML로 주입하는 구조라, innerHTML로 삽입된
  <script> 태그는 브라우저가 실행하지 않기 때문입니다(DOM 스펙 동작).
  이걸 놓치면 window.Hls가 항상 undefined라 재생 버튼을 눌러도 아무
  반응이 없습니다.
- 영화/시리즈/에피소드 목록은 Plex REST API의 네이티브 페이지네이션
  파라미터(X-Plex-Container-Start / X-Plex-Container-Size)로 서버에서
  직접 나눠 받아옵니다(ITEMS_PER_PAGE, 기본 30개/페이지). 프런트엔드는
  응답의 total_pages를 바탕으로 [1][2][3]... 페이지 버튼을 그립니다.
- 썸네일은 카드마다 개별 요청하지 않고, 한 페이지에 필요한 경로를 모아
  action=thumbs 한 번으로 일괄 조회합니다(백엔드가 ThreadPoolExecutor로
  병렬 fetch). 개별 action=thumb도 남아있지만 그리드 렌더링에는 더 이상
  쓰지 않습니다.
- 재생 시작(action=play)은 예전에 트랜스코드 URL을 백엔드가 미리 한 번
  GET으로 호출해 에러를 검증했지만, 그 자체가 Plex 트랜스코드 세션을
  실제로 띄우는 무거운 요청이라 콜드 스타트를 두 번 치르는 셈이었습니다.
  지금은 가벼운 메타데이터 조회로만 사전 검증하고, 트랜스코드 관련 에러는
  프런트엔드 hls.js 에러 핸들러가 실제 재생 시점에 처리합니다.
- directPlay는 반드시 0으로 유지해야 합니다. protocol=hls로 세그먼트 단위
  스트림을 명시 요청하는 이 파이프라인에서 directPlay=1을 같이 보내면
  Plex가 "Direct Play 가능"으로 판단해 실제 세그먼트(.ts) 파일을 아예
  생성하지 않는 경우가 있어(매니페스트는 응답하지만 그 안의 모든 세그먼트가
  404), 한때 CPU 부하를 줄이려고 1로 바꿨다가 재생이 완전히 안 되는
  회귀를 만든 적이 있습니다. directStream=1만으로도 컨테이너만 안 맞는
  흔한 경우(mkv 등)는 재인코딩 없이 remux로 빠지므로 CPU 부하 완화 효과는
  충분합니다. MAX_VIDEO_BITRATE 기본값은 20000→8000kbps로 낮췄고, hls.js
  버퍼(maxBufferLength/maxMaxBufferLength/backBufferLength)도 넉넉히 잡아
  재생 중 버퍼링을 줄였습니다.
- 자막은 BURN_SUBTITLES 설정(기본 사용)에 따라 subtitles=burn 파라미터로
  화면에 합성(번인)합니다. 번인은 항상 풀 트랜스코드를 강제하므로 위
  Direct Stream 최적화와는 상충합니다 - 자막이 중요하지 않은 서재라면
  꺼두는 편이 재생 부하 면에서 유리합니다.
- 재생 직전 /video/:/transcode/universal/decision으로 가볍게 파라미터
  조합을 검증합니다(실제 트랜스코더는 안 띄우는 Plex 공식 dry-run
  엔드포인트라 콜드 스타트 비용이 없음). 여기서 거부되면(예: 400) Plex가
  준 실제 에러 본문을 그대로 사용자에게 보여줘서, hls.js의 뭉뚱그려진
  manifestLoadError보다 원인을 훨씬 빨리 좁힐 수 있습니다.
- 영화/시리즈/에피소드 목록 정렬은 SORT_OPTIONS 화이트리스트(가나다순/
  가나다 역순/최신 등록순/오래된 등록순/최신 개봉순/오래된 개봉순)에 있는
  값만 받아 Plex의 sort 쿼리 파라미터(titleSort/addedAt/
  originallyAvailableAt)로 그대로 전달합니다. 프런트엔드가 보낸 임의
  문자열을 그대로 Plex URL에 꽂지 않도록 여기서 한 번 걸러줍니다.
"""

import base64
import json
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlencode

import requests

from plugins.metadata.base import BaseMetadataProvider


class PlexPlayerProvider(BaseMetadataProvider):
    id = "plex_player"
    name = "Plex 영상 재생"
    is_searchable = False

    # 영화/시리즈, 에피소드 목록 한 페이지당 표시 개수.
    ITEMS_PER_PAGE = 30
    # 썸네일 일괄(batch) 조회 시 Plex에 동시에 보낼 최대 요청 수.
    THUMB_BATCH_WORKERS = 6
    # 재생 워밍업(fire-and-forget) 요청 전용 타임아웃. REQUEST_TIMEOUT_SEC
    # (사용자가 응답을 기다리는 짧은 타임아웃)과 달리 아무도 기다리지 않는
    # 백그라운드 요청이므로 트랜스코더가 실제로 준비될 시간을 넉넉히 줍니다.
    PREWARM_TIMEOUT_SEC = 30

    # 목록 정렬 옵션 화이트리스트. 프런트엔드가 보낸 sort 값을 그대로 Plex
    # 쿼리스트링에 꽂지 않고, 여기 등록된 값만 통과시킵니다(임의 문자열
    # 주입 방지). 키는 프런트엔드/URL에서 쓰는 값, 값은 Plex가 실제로
    # 받는 sort 파라미터 문자열입니다. 빈 문자열("")은 "기본 정렬"로,
    # sort 파라미터 자체를 안 붙여 Plex/라이브러리 기본 정렬을 그대로 씁니다.
    SORT_OPTIONS = {
        "": "",
        "title_asc": "titleSort:asc",
        "title_desc": "titleSort:desc",
        "added_desc": "addedAt:desc",
        "added_asc": "addedAt:asc",
        "release_desc": "originallyAvailableAt:desc",
        "release_asc": "originallyAvailableAt:asc",
    }

    config_schema = [
        {
            "key": "PLEX_URL",
            "label": "Plex 서버 주소",
            "type": "text",
            "required": True,
            "default": "",
        },
        {
            "key": "PLEX_TOKEN",
            "label": "Plex 토큰 (X-Plex-Token)",
            "type": "password",
            "required": True,
        },
        {
            "key": "VIDEO_RESOLUTION",
            "label": "재생 해상도",
            "type": "select",
            "default": "1920x1080",
            "options": [
                {"value": "1920x1080", "label": "1080p"},
                {"value": "1280x720", "label": "720p"},
                {"value": "3840x2160", "label": "4K"},
            ],
        },
        {
            "key": "MAX_VIDEO_BITRATE",
            "label": "최대 비트레이트 (kbps, 재생 중 버벅이면 낮춰보세요)",
            "type": "number",
            "default": 8000,
        },
        {
            "key": "BURN_SUBTITLES",
            "label": "자막 자동 합성(번인) - 켜면 자막 있는 영상은 항상 풀 트랜스코드됩니다",
            "type": "select",
            "default": "1",
            "options": [
                {"value": "1", "label": "사용"},
                {"value": "0", "label": "사용 안 함"},
            ],
        },
        {
            "key": "REQUEST_TIMEOUT_SEC",
            "label": "Plex API 요청 타임아웃 (초)",
            "type": "number",
            "default": 10,
        },
    ]

    dashboard_widget = None
    home_widget = None
    detail_sidebar_widget = None
    update_manifest = None

    # 사이드바 1등 시민 카테고리 메뉴로 등록합니다.
    # sessions를 "all"로 두었지만, 영상 서재 세션에만 노출하고 싶다면
    # ["video"] 로 바꾸십시오.
    category_tab = {
        "title": "Plex 영상 재생",
        "icon": "fa-solid fa-clapperboard",
        "order": 85,
        "sessions": "all",
    }

    # ------------------------------------------------------------------
    # 필수 계약 (사용하지 않음 - 대시보드/카테고리 전용 플러그인)
    # ------------------------------------------------------------------
    def search(self, db_type, query):
        return {"success": True, "items": []}

    def apply(self, db_type, book_id, item_data):
        return False, "이 플러그인은 메타데이터 적용을 지원하지 않습니다."

    # ------------------------------------------------------------------
    # 카테고리 풀페이지 UI의 RPC 진입점
    # ------------------------------------------------------------------
    def get_dashboard_data(self, db_type, limit=10):
        action, library_key, rating_key, thumb_path, page, thumb_paths, sort_key = self._read_request_params()

        cfg = self.get_plugin_config(db_type, default={})
        base_url = (cfg.get("PLEX_URL") or "").strip().rstrip("/")
        token = (cfg.get("PLEX_TOKEN") or "").strip()

        if not base_url or not token:
            return {
                "success": False,
                "error": "Plex 서버 주소/토큰이 설정되지 않았습니다. "
                         "환경설정 > 플러그인 설정에서 먼저 입력해주세요.",
            }

        timeout = self._safe_int(cfg.get("REQUEST_TIMEOUT_SEC"), 10)

        if action == "videos":
            if not library_key:
                return {"success": False, "error": "library_key가 필요합니다."}
            return self._get_section_items(base_url, token, library_key, timeout, page, sort_key)

        if action == "episodes":
            if not rating_key:
                return {"success": False, "error": "rating_key가 필요합니다."}
            return self._get_episodes(base_url, token, rating_key, timeout, page, sort_key)

        if action == "play":
            if not rating_key:
                return {"success": False, "error": "rating_key가 필요합니다."}
            return self._get_play_info(base_url, token, rating_key, cfg, timeout)

        if action == "thumb":
            if not thumb_path:
                return {"success": False, "error": "thumb_path가 필요합니다."}
            return self._get_thumb(base_url, token, thumb_path, timeout)

        if action == "thumbs":
            if not thumb_paths:
                return {"success": False, "error": "thumb_paths가 필요합니다."}
            return self._get_thumbs_batch(base_url, token, thumb_paths, timeout)

        # 기본 동작: 라이브러리(섹션) 목록
        return self._get_sections(base_url, token, timeout)

    # ------------------------------------------------------------------
    # 내부 헬퍼
    # ------------------------------------------------------------------
    def _read_request_params(self):
        """카테고리 풀페이지 UI가 쿼리스트링으로 실어 보낸 action/페이지네이션
        파라미터를 현재 Flask 요청 컨텍스트에서 읽어옵니다."""
        try:
            from flask import request
            action = (request.args.get("action") or "sections").strip()
            library_key = (request.args.get("library_key") or "").strip()
            rating_key = (request.args.get("rating_key") or "").strip()
            thumb_path = (request.args.get("thumb_path") or "").strip()
            page = self._safe_int(request.args.get("page"), 1)
            if page < 1:
                page = 1
            sort_raw = request.args.get("sort")
            if sort_raw is None:
                # sort 파라미터 자체가 안 왔을 때(기본값) - 최신 등록순.
                sort_key = "added_desc"
            else:
                sort_key = sort_raw.strip()
                if sort_key not in self.SORT_OPTIONS:
                    sort_key = "added_desc"
                # sort_key가 ""(사용자가 드롭다운에서 "기본순서"를 명시적으로
                # 고른 경우)면 그대로 "" 유지 - SORT_OPTIONS[""] == ""라서
                # sort 쿼리 자체를 안 붙이는 정상 동작으로 이어집니다.
            thumb_paths_raw = request.args.get("thumb_paths") or ""
            thumb_paths = []
            if thumb_paths_raw:
                try:
                    parsed = json.loads(thumb_paths_raw)
                    if isinstance(parsed, list):
                        thumb_paths = [str(p).strip() for p in parsed if str(p).strip()]
                except (ValueError, TypeError):
                    thumb_paths = []
            return action, library_key, rating_key, thumb_path, page, thumb_paths, sort_key
        except Exception:
            return "sections", "", "", "", 1, [], "added_desc"

    @staticmethod
    def _safe_int(value, default):
        try:
            return int(value)
        except (TypeError, ValueError):
            return default

    def _request_json(self, url, timeout):
        try:
            res = requests.get(url, headers={"Accept": "application/json"}, timeout=timeout)
            res.raise_for_status()
            return res.json()
        except requests.RequestException as e:
            return {"__error__": f"Plex 서버 요청에 실패했습니다: {e}"}
        except ValueError as e:
            return {"__error__": f"Plex 응답을 해석하지 못했습니다: {e}"}

    def _get_sections(self, base_url, token, timeout):
        cache_key = f"sections:{base_url}"
        cached = self.cache_get(cache_key)
        if cached:
            try:
                sections = json.loads(cached)
                return {
                    "success": True,
                    "sections": sections,
                    "base_url": base_url,
                }
            except (ValueError, TypeError):
                pass

        url = f"{base_url}/library/sections?X-Plex-Token={token}"
        data = self._request_json(url, timeout)
        if "__error__" in data:
            return {"success": False, "error": data["__error__"]}

        directories = (data.get("MediaContainer") or {}).get("Directory") or []
        sections = []
        for d in directories:
            if d.get("type") not in ("movie", "show"):
                continue
            sections.append(
                {
                    "key": d.get("key"),
                    "title": d.get("title"),
                    "type": d.get("type"),
                    "thumb": d.get("thumb") or d.get("art") or "",
                }
            )

        self.cache_set(cache_key, json.dumps(sections), ttl=300)
        return {"success": True, "sections": sections, "base_url": base_url}

    def _get_section_items(self, base_url, token, library_key, timeout, page=1, sort_key=""):
        page_size = self.ITEMS_PER_PAGE
        start = (page - 1) * page_size
        plex_sort = self.SORT_OPTIONS.get(sort_key, "")
        url = (
            f"{base_url}/library/sections/{library_key}/all"
            f"?X-Plex-Token={token}"
            f"&X-Plex-Container-Start={start}&X-Plex-Container-Size={page_size}"
        )
        if plex_sort:
            url += f"&sort={plex_sort}"
        data = self._request_json(url, timeout)
        if "__error__" in data:
            return {"success": False, "error": data["__error__"]}

        container = data.get("MediaContainer") or {}
        metas = container.get("Metadata") or []
        items = []
        for m in metas:
            items.append(
                {
                    "rating_key": m.get("ratingKey"),
                    "title": m.get("title"),
                    "type": m.get("type"),  # 'movie' 또는 'show'
                    "thumb": m.get("thumb") or "",
                    "year": m.get("year"),
                    "summary": m.get("summary") or "",
                    "duration_ms": m.get("duration"),
                    "leaf_count": m.get("leafCount"),
                }
            )
        total = self._safe_int(container.get("totalSize"), len(items))
        total_pages = max(1, (total + page_size - 1) // page_size) if page_size else 1
        return {
            "success": True,
            "items": items,
            "base_url": base_url,
            "page": page,
            "page_size": page_size,
            "total": total,
            "total_pages": total_pages,
            "sort": sort_key,
        }

    def _get_episodes(self, base_url, token, rating_key, timeout, page=1, sort_key=""):
        page_size = self.ITEMS_PER_PAGE
        start = (page - 1) * page_size
        plex_sort = self.SORT_OPTIONS.get(sort_key, "")
        url = (
            f"{base_url}/library/metadata/{rating_key}/allLeaves"
            f"?X-Plex-Token={token}"
            f"&X-Plex-Container-Start={start}&X-Plex-Container-Size={page_size}"
        )
        if plex_sort:
            url += f"&sort={plex_sort}"
        data = self._request_json(url, timeout)
        if "__error__" in data:
            return {"success": False, "error": data["__error__"]}

        container = data.get("MediaContainer") or {}
        metas = container.get("Metadata") or []
        items = []
        for m in metas:
            season = m.get("parentIndex")
            ep = m.get("index")
            if isinstance(season, int) and isinstance(ep, int):
                label = f"S{season:02d}E{ep:02d} "
            else:
                label = ""
            items.append(
                {
                    "rating_key": m.get("ratingKey"),
                    "title": f"{label}{m.get('title') or ''}".strip(),
                    "type": "episode",
                    "thumb": m.get("thumb") or "",
                    "summary": m.get("summary") or "",
                    "duration_ms": m.get("duration"),
                }
            )
        total = self._safe_int(container.get("totalSize"), len(items))
        total_pages = max(1, (total + page_size - 1) // page_size) if page_size else 1
        return {
            "success": True,
            "items": items,
            "base_url": base_url,
            "page": page,
            "page_size": page_size,
            "total": total,
            "total_pages": total_pages,
            "sort": sort_key,
        }

    def _get_play_info(self, base_url, token, rating_key, cfg, timeout):
        meta_url = f"{base_url}/library/metadata/{rating_key}?X-Plex-Token={token}"
        meta_data = self._request_json(meta_url, timeout)
        if "__error__" in meta_data:
            return {"success": False, "error": meta_data["__error__"]}

        metas = (meta_data.get("MediaContainer") or {}).get("Metadata") or []
        if not metas:
            return {
                "success": False,
                "error": "해당 항목을 Plex에서 찾을 수 없습니다 (rating_key 확인 필요).",
            }
        title = metas[0].get("title") or ""

        resolution = cfg.get("VIDEO_RESOLUTION") or "1920x1080"
        bitrate = self._safe_int(cfg.get("MAX_VIDEO_BITRATE"), 8000)
        client_id = "bookoasis-plex-player"

        # Plex의 Universal Transcode(/video/:/transcode/universal/start.m3u8)는
        # 클라이언트를 식별하는 X-Plex-* 파라미터가 충분하지 않으면 400으로
        # 거절하는 경우가 있어, 실제 Plex 앱들이 보내는 것과 유사한 수준으로
        # 채워서 보냅니다. (directPlay 관련 설명은 params 바로 위 주석 참고)
        # subtitleSize만 보내고 subtitles(번인 여부) 자체를 안 보내면 Plex가
        # 자막을 화면에 합성하지 않습니다. BURN_SUBTITLES 설정에 따라
        # "burn"(번인, 항상 풀 트랜스코드)/"none"으로 전환합니다. 자막이
        # 없는 미디어에는 이 값이 있어도 아무 영향이 없습니다. 특정 자막
        # 트랙 선택(다국어 중 고르기)은 아직 미지원이며, Plex가 media에서
        # "selected"로 표시된 기본 자막 트랙을 그대로 사용합니다.
        #
        # directPlay는 반드시 0이어야 합니다. 한때 CPU 부하를 줄여보려고
        # 1로 바꿔봤는데, 여기서는 protocol=hls로 세그먼트 단위 스트림을
        # 명시적으로 요청하고 있어서 directPlay=1을 같이 보내면 Plex의
        # 결정 엔진이 "이 파일은 Direct Play가 가능하다"고 판단해 실제
        # 세그먼트(.ts) 파일 자체를 생성하지 않는 경우가 있었습니다.
        # 매니페스트(m3u8)는 정상 응답하지만 그 안에 나열된 세그먼트가
        # 전부 404로 실패하는 증상으로 나타났습니다. directStream=1만으로도
        # 컨테이너만 안 맞는 흔한 경우(mkv 등)는 재인코딩 없이 remux로
        # 빠지므로, CPU 부하 완화 효과는 이걸로 충분합니다.
        burn_subtitles = str(cfg.get("BURN_SUBTITLES", "1")).strip() != "0"
        params = {
            "path": f"/library/metadata/{rating_key}",
            "mediaIndex": 0,
            "partIndex": 0,
            "protocol": "hls",
            "fastSeek": 1,
            "directPlay": 0,
            "directStream": 1,
            "copyts": 1,
            "hasMDE": 1,
            "subtitles": "burn" if burn_subtitles else "none",
            "subtitleSize": 100,
            "audioBoost": 100,
            "maxVideoBitrate": bitrate,
            "videoResolution": resolution,
            "session": uuid.uuid4().hex,
            "X-Plex-Client-Identifier": client_id,
            "X-Plex-Product": "BookOasis",
            "X-Plex-Version": "1.0.0",
            "X-Plex-Platform": "Chrome",
            "X-Plex-Platform-Version": "125.0",
            "X-Plex-Device": "BookOasis Server",
            "X-Plex-Device-Name": "BookOasis Web Player",
            "X-Plex-Token": token,
        }
        stream_url = f"{base_url}/video/:/transcode/universal/start.m3u8?{urlencode(params)}"

        # 진단/검증용 가벼운 사전 확인: /video/:/transcode/universal/decision은
        # 실제 트랜스코드 세션(인코더)을 띄우지 않고, 지금 파라미터 조합이
        # 유효한지만 확인해주는 Plex 공식 엔드포인트입니다. start.m3u8을
        # 직접 두드리던 예전 사전점검과 달리 무겁지 않으므로 "콜드 스타트
        # 2회" 문제 없이도, 여기서 거부되는 경우(예: 파라미터 조합 오류)
        # Plex가 실제로 보낸 이유를 hls.js의 두루뭉술한 manifestLoadError
        # 대신 그대로 보여줄 수 있습니다. 세션 ID는 실제 재생에 쓸 stream_url
        # 과 절대 겹치지 않도록 별도로 새로 발급합니다.
        check_params = dict(params)
        check_params["session"] = uuid.uuid4().hex
        decision_error = self._check_transcode_decision(base_url, check_params, timeout)
        if decision_error:
            return {"success": False, "error": decision_error}

        # 예전에는 여기서 백엔드가 stream_url을 한 번 더 GET으로 "동기적으로"
        # 미리 호출해 에러를 확인했습니다. 그 방식은 API 응답 자체가 트랜스
        # 코드 완료를 기다리는 셈이라 첫 재생 체감 속도가 느렸습니다(콜드
        # 스타트 2회).
        # 반면 완전히 생략하니, 실제로는 Plex 트랜스코더 워밍업(콜드 스타트)
        # 시간이 hls.js의 기본 타임아웃(약 10초)보다 길어서 hls.js가 먼저
        # 포기하고 재시도하는 사이 세그먼트가 전부 404로 실패하는 문제가
        # 관찰됐습니다.
        # 절충안: 이 API 응답은 기다리지 않고(fire-and-forget) 백그라운드
        # 스레드에서만 같은 stream_url을 한 번 건드려 Plex가 최대한 일찍
        # 세그먼트 생성을 시작하도록 유도합니다. 이 요청의 성공/실패는
        # 확인하지 않으며, 프런트엔드 응답 속도에는 전혀 영향을 주지
        # 않습니다.
        threading.Thread(
            target=self._prewarm_stream, args=(stream_url,), daemon=True
        ).start()

        return {"success": True, "title": title, "stream_url": stream_url}

    def _check_transcode_decision(self, base_url, params, timeout):
        """/video/:/transcode/universal/decision으로 가볍게 사전 검증합니다.
        문제가 없으면 None을, 문제가 있으면 사용자에게 보여줄 에러 메시지
        문자열을 반환합니다."""
        decision_url = f"{base_url}/video/:/transcode/universal/decision?{urlencode(params)}"
        try:
            res = requests.get(
                decision_url, headers={"Accept": "application/json"}, timeout=timeout
            )
        except requests.RequestException as e:
            return f"Plex 재생 검증 요청 중 오류가 발생했습니다: {e}"

        if res.status_code >= 400:
            body = (res.text or "").strip()
            if len(body) > 500:
                body = body[:500] + "..."
            return (
                f"Plex가 재생 파라미터를 거부했습니다 (HTTP {res.status_code}). "
                f"응답 내용: {body or '(본문 없음)'}"
            )
        return None

    def _prewarm_stream(self, stream_url):
        """백그라운드 전용: 결과를 아무도 기다리지 않으므로 실패해도 조용히
        무시합니다. 실제 재생 성공 여부는 브라우저의 hls.js 요청이 결정하며,
        이 호출은 어디까지나 Plex 쪽 트랜스코더를 조금이라도 일찍 깨워주는
        보조 수단입니다."""
        try:
            requests.get(stream_url, timeout=self.PREWARM_TIMEOUT_SEC)
        except requests.RequestException:
            pass

    def _get_thumb(self, base_url, token, thumb_path, timeout):
        """코어의 logo-cache 프록시가 아니라, 이미 정상 동작이 확인된 백엔드
        직접 호출(requests) 경로로 썸네일을 가져와 base64 data URL로 돌려줍니다.
        logo-cache가 502를 내는 환경(사설 IP 판정, 코어 프록시 네트워크 구성
        차이 등)에서도 영향받지 않습니다."""
        cache_key = f"thumb:{base_url}:{thumb_path}"
        cached = self.cache_get(cache_key)
        if cached:
            return {"success": True, "data_url": cached}

        sep = "&" if "?" in thumb_path else "?"
        url = f"{base_url}{thumb_path}{sep}X-Plex-Token={token}"
        try:
            res = requests.get(url, timeout=timeout)
            res.raise_for_status()
        except requests.RequestException as e:
            return {"success": False, "error": f"썸네일 요청 실패: {e}"}

        content_type = res.headers.get("Content-Type", "image/jpeg")
        b64 = base64.b64encode(res.content).decode("ascii")
        data_url = f"data:{content_type};base64,{b64}"

        # Redis 값 크기 보호를 위해 너무 큰 이미지는 캐시하지 않습니다.
        if len(data_url) < 500000:
            self.cache_set(cache_key, data_url, ttl=86400)

        return {"success": True, "data_url": data_url}

    def _get_thumbs_batch(self, base_url, token, thumb_paths, timeout):
        """그리드 한 페이지에 필요한 썸네일 전부를 한 번의 요청으로 받아옵니다.
        프런트엔드가 카드 수만큼(최대 30개) 개별 fetch를 순차적으로 날리던
        것이 최초 로딩 체감 속도를 크게 늦추는 원인이었습니다. 여기서는
        스레드풀로 병렬 조회하되, 각 경로는 여전히 _get_thumb의 Redis 캐시를
        그대로 타므로 이미 캐시된 항목은 네트워크 요청 없이 즉시 반환됩니다."""
        # 중복 경로 제거 (순서는 유지할 필요 없음 - 프런트엔드가 경로 기준으로 매칭).
        unique_paths = list(dict.fromkeys(p for p in thumb_paths if p))
        if not unique_paths:
            return {"success": True, "items": {}}

        results = {}
        worker_count = max(1, min(self.THUMB_BATCH_WORKERS, len(unique_paths)))
        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            future_to_path = {
                executor.submit(self._get_thumb, base_url, token, path, timeout): path
                for path in unique_paths
            }
            for future in as_completed(future_to_path):
                path = future_to_path[future]
                try:
                    result = future.result()
                except Exception as e:
                    results[path] = None
                    continue
                results[path] = result.get("data_url") if result.get("success") else None

        return {"success": True, "items": results}
