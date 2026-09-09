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
import hashlib
import json
import os
import random
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import quote, urlencode

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

    # 라이브러리(섹션) 목록/썸네일을 코어의 Redis 캐시(self.cache_get/
    # cache_set)에 의존하지 않고 이 플러그인 폴더 안에 직접 캐싱합니다.
    # 배포 환경마다 그 헬퍼가 실제로 존재/동작하는지가 불확실했던 반면,
    # 플러그인 폴더 자체는 (requirements.txt 설치 시 libs/ 하위 폴더가
    # 생기는 것에서 보듯) 항상 쓰기 가능하다는 게 프레임워크의 기본
    # 전제이므로, 여기 캐시는 Redis 유무와 무관하게 항상 동작합니다.
    CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache")
    SECTIONS_CACHE_TTL = 300       # 라이브러리 목록: 5분
    THUMB_CACHE_TTL = 30 * 86400   # 썸네일: 30일 (자주 안 바뀌는 정적 이미지)
    CACHE_MAX_AGE = 45 * 86400     # 이 기간이 지난 캐시 파일은 정리 대상
    CACHE_CLEANUP_PROBABILITY = 0.02  # 쓰기마다 2% 확률로만 정리 스캔 실행

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
        action, library_key, rating_key, thumb_path, page, thumb_paths, sort_key, search = self._read_request_params()

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
            return self._get_section_items(base_url, token, library_key, timeout, page, sort_key, search)

        if action == "episodes":
            if not rating_key:
                return {"success": False, "error": "rating_key가 필요합니다."}
            return self._get_episodes(base_url, token, rating_key, timeout, page, sort_key, search)

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

        return self._get_sections(base_url, token, timeout)

    # ------------------------------------------------------------------
    # 내부 헬퍼
    # ------------------------------------------------------------------
    def _read_request_params(self):
        try:
            from flask import request
            action = (request.args.get("action") or "sections").strip()
            library_key = (request.args.get("library_key") or "").strip()
            rating_key = (request.args.get("rating_key") or "").strip()
            thumb_path = (request.args.get("thumb_path") or "").strip()
            # 프런트엔드 검색창(제목 필터). 길이만 방어적으로 제한하고
            # (Plex URL에 그대로 실리는 값이라 과도하게 긴 입력 방지),
            # 그 외 이스케이프는 요청 시 urllib.parse.quote로 처리합니다.
            search = (request.args.get("search") or "").strip()[:200]

            page = self._safe_int(request.args.get("page"), 1)
            if page < 1:
                page = 1

            sort_raw = request.args.get("sort")
            if sort_raw is None:
                sort_key = "added_desc"
            else:
                sort_key = sort_raw.strip()
                if sort_key not in self.SORT_OPTIONS:
                    sort_key = "added_desc"

            thumb_paths_raw = request.args.get("thumb_paths") or ""
            thumb_paths = []
            if thumb_paths_raw:
                try:
                    parsed = json.loads(thumb_paths_raw)
                    if isinstance(parsed, list):
                        thumb_paths = [str(p).strip() for p in parsed if str(p).strip()]
                except (ValueError, TypeError):
                    thumb_paths = []

            return action, library_key, rating_key, thumb_path, page, thumb_paths, sort_key, search
        except Exception:
            return "sections", "", "", "", 1, [], "added_desc", ""

    @staticmethod
    def _safe_int(value, default):
        try:
            return int(value)
        except (TypeError, ValueError):
            return default

    def _safe_cache_get(self, key, sub="", ttl=None):
        """플러그인 폴더 안 디스크 캐시에서 읽습니다. ttl(초)이 주어지면
        그보다 오래된 항목은 만료로 간주해 None을 반환합니다(파일 자체는
        지우지 않고, 다음 _safe_cache_set 때 덮어씁니다 - 삭제는 별도
        정리 루틴이 담당)."""
        path = self._disk_cache_path(key, sub)
        if not path or not os.path.isfile(path):
            return None
        try:
            with open(path, "r", encoding="utf-8") as f:
                payload = json.load(f)
        except (OSError, ValueError):
            return None

        if ttl is not None and (time.time() - payload.get("ts", 0)) > ttl:
            return None

        return payload.get("value")

    def _safe_cache_set(self, key, value, sub="", ttl=None):
        """디스크에 원자적으로(임시 파일 후 os.replace) 기록합니다. ttl은
        여기서는 쓰이지 않고(만료 판단은 읽을 때 함) 호출부 시그니처
        호환을 위해서만 받습니다. 쓰기 실패(권한/디스크 문제 등)는 캐시가
        없어지는 것뿐이므로 조용히 무시합니다."""
        path = self._disk_cache_path(key, sub)
        if not path:
            return
        payload = {"ts": time.time(), "value": value}
        try:
            tmp_path = f"{path}.tmp"
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(payload, f)
            os.replace(tmp_path, path)
        except OSError:
            return

        # 매 쓰기마다 스캔하면 낭비이므로 낮은 확률로만 오래된 캐시 파일을
        # 정리합니다(베스트 에포트 - 실패해도 다음 기회에 다시 시도됨).
        if random.random() < self.CACHE_CLEANUP_PROBABILITY:
            self._cleanup_old_cache_files()

    def _disk_cache_path(self, key, sub=""):
        directory = os.path.join(self.CACHE_DIR, sub) if sub else self.CACHE_DIR
        try:
            os.makedirs(directory, exist_ok=True)
        except OSError:
            return None
        digest = hashlib.md5(key.encode("utf-8")).hexdigest()
        return os.path.join(directory, digest + ".json")

    def _cleanup_old_cache_files(self):
        """CACHE_MAX_AGE보다 오래된 캐시 파일을 지웁니다. 사용자가 Plex
        라이브러리를 계속 둘러볼수록 썸네일 캐시 파일이 계속 쌓이기만
        하는 것을 막기 위한 청소입니다. 정리 자체가 실패해도(권한 등)
        플러그인 동작에는 영향이 없으므로 예외를 삼킵니다."""
        try:
            now = time.time()
            for root, _dirs, files in os.walk(self.CACHE_DIR):
                for name in files:
                    if not name.endswith(".json"):
                        continue
                    path = os.path.join(root, name)
                    try:
                        if now - os.path.getmtime(path) > self.CACHE_MAX_AGE:
                            os.remove(path)
                    except OSError:
                        continue
        except OSError:
            pass

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
        cached = self._safe_cache_get(cache_key, sub="sections", ttl=self.SECTIONS_CACHE_TTL)
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

        self._safe_cache_set(cache_key, json.dumps(sections), sub="sections")
        return {"success": True, "sections": sections, "base_url": base_url}

    def _get_section_items(self, base_url, token, library_key, timeout, page=1, sort_key="", search=""):
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
        if search:
            # Plex의 "title" 쿼리 파라미터는 부분 일치(포함) 검색으로
            # 동작합니다. quote()로 인코딩해 한글/특수문자/공백을 안전하게
            # 전달합니다.
            url += f"&title={quote(search)}"

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
                    "type": m.get("type"),
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

    def _get_episodes(self, base_url, token, rating_key, timeout, page=1, sort_key="", search=""):
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
        if search:
            url += f"&title={quote(search)}"

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

        check_params = dict(params)
        check_params["session"] = uuid.uuid4().hex
        decision_error = self._check_transcode_decision(base_url, check_params, timeout)
        if decision_error:
            return {"success": False, "error": decision_error}

        threading.Thread(
            target=self._prewarm_stream, args=(stream_url,), daemon=True
        ).start()

        return {"success": True, "title": title, "stream_url": stream_url}

    def _check_transcode_decision(self, base_url, params, timeout):
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
        try:
            requests.get(stream_url, timeout=self.PREWARM_TIMEOUT_SEC)
        except requests.RequestException:
            pass

    def _get_thumb(self, base_url, token, thumb_path, timeout):
        cache_key = f"thumb:{base_url}:{thumb_path}"
        cached = self._safe_cache_get(cache_key, sub="thumbs", ttl=self.THUMB_CACHE_TTL)
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

        # 디스크 캐시 파일 하나가 과도하게 커지는 것만 방지합니다(Redis
        # 값 크기 제한과는 무관하지만, 동일한 안전 마진을 그대로 유지).
        if len(data_url) < 500000:
            self._safe_cache_set(cache_key, data_url, sub="thumbs")

        return {"success": True, "data_url": data_url}

    def _get_thumbs_batch(self, base_url, token, thumb_paths, timeout):
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
                except Exception:
                    results[path] = None
                    continue
                results[path] = result.get("data_url") if result.get("success") else None

        return {"success": True, "items": results}
