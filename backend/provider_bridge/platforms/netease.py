"""NetEase collection adapter hosted by the provider sidecar."""

from __future__ import annotations

from urllib.parse import quote, urlencode

from provider_bridge.collection_common import (
    at,
    category_payload,
    collection_payload,
    integer,
    join_names,
    link_id,
    list_value,
    object_value,
    page_limit,
    string,
    track_payload,
)
from provider_bridge.platform_http import PlatformHTTP


BASE_URL = "https://music.163.com"


class NeteaseCollections:
    source = "netease"

    def __init__(self, cookie: str = "", session=None):
        self.http = PlatformHTTP(cookie, session)

    def search_playlist(self, keyword: str, **_):
        return self._playlists(at(self._search(keyword, 1000), "result", "playlists"))

    def search_album(self, keyword: str, **_):
        return self._albums(at(self._search(keyword, 10), "result", "albums"))

    def _search(self, keyword: str, search_type: int):
        return self.http.post_form(
            BASE_URL + "/api/search/get/web",
            {"s": string(keyword), "type": search_type, "limit": 30, "offset": 0},
        )

    def playlist(self, identifier: str, **_):
        identifier = string(identifier)
        if not identifier:
            raise ValueError("netease playlist id is empty")
        payload = self.http.get(
            BASE_URL + "/api/v6/playlist/detail?" + urlencode({"id": identifier, "n": 1000, "s": 8})
        )
        raw = object_value(payload.get("playlist"))
        if not raw:
            raise ValueError("netease playlist response is empty")
        return self._playlist(raw), self._songs(raw.get("tracks"))

    def album(self, identifier: str, **_):
        identifier = string(identifier)
        if not identifier:
            raise ValueError("netease album id is empty")
        payload = self.http.get(BASE_URL + "/api/album/" + quote(identifier, safe=""))
        raw = object_value(payload.get("album"))
        if not raw:
            raise ValueError("netease album response is empty")
        return self._album(raw), self._songs(payload.get("songs"))

    def parse_playlist(self, link: str, **_):
        identifier = link_id(link, "id")
        if not identifier:
            raise ValueError("netease playlist link has no id")
        return self.playlist(identifier)

    def parse_album(self, link: str, **_):
        identifier = link_id(link, "id")
        if not identifier:
            raise ValueError("netease album link has no id")
        return self.album(identifier)

    def recommend(self, **_):
        payload = self.http.get(BASE_URL + "/api/personalized/playlist?limit=30")
        return self._playlists(payload.get("result"))

    def categories(self, **_):
        values = (
            ("语种", "华语"), ("语种", "欧美"), ("语种", "日语"), ("语种", "韩语"),
            ("风格", "流行"), ("风格", "摇滚"), ("风格", "民谣"), ("风格", "电子"),
            ("场景", "学习"), ("场景", "运动"), ("场景", "夜晚"), ("情感", "怀旧"),
        )
        return [category_payload(identifier=name, source=self.source, name=name, group=group) for group, name in values]

    def category(self, category_id: str, page: int = 1, limit: int = 30, **_):
        page, limit = page_limit(page, limit)
        query = urlencode({
            "cat": string(category_id), "order": "hot", "total": "true",
            "limit": limit, "offset": (page - 1) * limit,
        })
        return self._playlists(self.http.get(BASE_URL + "/api/playlist/list?" + query).get("playlists"))

    def user_playlists(self, page: int = 1, limit: int = 50, **_):
        account = self.http.get(BASE_URL + "/api/nuser/account/get")
        user_id = string(at(account, "profile", "userId")) or string(at(account, "account", "id"))
        if not user_id:
            raise ValueError("netease login cookie is required")
        page, limit = page_limit(page, limit, 50)
        query = urlencode({"uid": user_id, "limit": limit, "offset": (page - 1) * limit})
        return self._playlists(self.http.get(BASE_URL + "/api/user/playlist?" + query).get("playlist"))

    def _songs(self, value):
        result = []
        for raw_value in list_value(value):
            raw = object_value(raw_value)
            identifier = string(raw.get("id"))
            if not identifier:
                continue
            album = object_value(raw.get("al")) or object_value(raw.get("album"))
            artists = raw.get("ar") if raw.get("ar") is not None else raw.get("artists")
            duration_ms = integer(raw.get("dt")) or integer(raw.get("duration"))
            album_id = string(album.get("id"))
            result.append(track_payload(
                identifier=identifier,
                source=self.source,
                name=string(raw.get("name")),
                artist=join_names(artists),
                album=string(album.get("name")),
                album_id=album_id,
                duration=duration_ms // 1000,
                cover=string(album.get("picUrl")),
                extra={"song_id": identifier, "album_id": album_id},
            ))
        return result

    def _playlists(self, value):
        return [item for item in (self._playlist(object_value(raw)) for raw in list_value(value)) if item["id"]]

    def _playlist(self, raw):
        identifier = string(raw.get("id"))
        cover = string(raw.get("coverImgUrl")) or string(raw.get("picUrl"))
        return collection_payload(
            identifier=identifier,
            source=self.source,
            name=string(raw.get("name")),
            creator=string(at(raw, "creator", "nickname")),
            description=string(raw.get("description")),
            cover=cover,
            link="https://music.163.com/playlist?id=" + identifier,
            track_count=integer(raw.get("trackCount")),
            play_count=integer(raw.get("playCount")),
        )

    def _albums(self, value):
        return [item for item in (self._album(object_value(raw)) for raw in list_value(value)) if item["id"]]

    def _album(self, raw):
        identifier = string(raw.get("id"))
        return collection_payload(
            identifier=identifier,
            source=self.source,
            name=string(raw.get("name")),
            creator=join_names(raw.get("artists")),
            description=string(raw.get("description")),
            cover=string(raw.get("picUrl")),
            link="https://music.163.com/album?id=" + identifier,
            track_count=integer(raw.get("size")),
        )

