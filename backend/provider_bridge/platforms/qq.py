"""QQ Music collection adapter hosted by the provider sidecar."""

from __future__ import annotations

import re
from urllib.parse import urlencode

from provider_bridge.collection_common import (
    at,
    category_payload,
    collection_payload,
    first,
    first_integer,
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


LEGACY_URL = "https://c.y.qq.com"
MUSIC_U_URL = "https://u.y.qq.com/cgi-bin/musicu.fcg"
HEADERS = {"Referer": "https://y.qq.com/"}


class QQCollections:
    source = "qq"

    def __init__(self, cookie: str = "", session=None):
        self.cookie = string(cookie)
        self.http = PlatformHTTP(cookie, session)

    def search_playlist(self, keyword: str, **_):
        return self._playlists(at(self._search(keyword, 3), "req", "data", "body", "songlist", "list"))

    def search_album(self, keyword: str, **_):
        return self._albums(at(self._search(keyword, 2), "req", "data", "body", "album", "list"))

    def _search(self, keyword: str, search_type: int):
        payload = {"req": {
            "module": "music.search.SearchCgiService",
            "method": "DoSearchForQQMusicDesktop",
            "param": {"query": string(keyword), "num_per_page": 30, "page_num": 1, "search_type": search_type},
        }}
        return self.http.post_json(MUSIC_U_URL, payload, headers=HEADERS)

    def playlist(self, identifier: str, **_):
        identifier = string(identifier)
        if not identifier:
            raise ValueError("qq playlist id is empty")
        query = urlencode({"type": 1, "json": 1, "utf8": 1, "onlysong": 0, "disstid": identifier, "format": "json"})
        payload = self.http.get(LEGACY_URL + "/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?" + query, headers=HEADERS)
        items = list_value(payload.get("cdlist"))
        if not items:
            raise ValueError("qq playlist response is empty")
        raw = object_value(items[0])
        return self._playlist(raw), self._songs(raw.get("songlist"))

    def album(self, identifier: str, **_):
        identifier = string(identifier)
        if not identifier:
            raise ValueError("qq album id is empty")
        query = urlencode({"albummid": identifier, "format": "json"})
        payload = self.http.get(LEGACY_URL + "/v8/fcg-bin/fcg_v8_album_info_cp.fcg?" + query, headers=HEADERS)
        raw = object_value(payload.get("data"))
        if not raw:
            raise ValueError("qq album response is empty")
        return self._album(raw), self._songs(raw.get("list"))

    def parse_playlist(self, link: str, **_):
        identifier = link_id(link, "id", "disstid")
        if not identifier:
            raise ValueError("qq playlist link has no id")
        return self.playlist(identifier)

    def parse_album(self, link: str, **_):
        identifier = link_id(link, "albummid")
        if not identifier:
            raise ValueError("qq album link has no id")
        return self.album(identifier)

    def recommend(self, **_):
        return self.category("10000000", 1, 30)

    def categories(self, **_):
        payload = self.http.get(
            LEGACY_URL + "/splcloud/fcgi-bin/fcg_get_diss_tag_conf.fcg?format=json", headers=HEADERS
        )
        result = []
        for group_value in list_value(at(payload, "data", "categories")):
            group = object_value(group_value)
            group_name = string(group.get("categoryGroupName"))
            for item_value in list_value(group.get("items")):
                item = object_value(item_value)
                identifier = string(item.get("categoryId"))
                name = string(item.get("categoryName"))
                if identifier and name:
                    result.append(category_payload(
                        identifier=identifier, source=self.source, name=name,
                        group=group_name, hot=identifier == "10000000",
                    ))
        return result

    def category(self, category_id: str, page: int = 1, limit: int = 30, **_):
        page, limit = page_limit(page, limit)
        start = (page - 1) * limit
        query = urlencode({
            "format": "json", "categoryId": string(category_id), "sortId": 5,
            "sin": start, "ein": start + limit - 1,
        })
        payload = self.http.get(LEGACY_URL + "/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg?" + query, headers=HEADERS)
        return self._playlists(at(payload, "data", "list"))

    def user_playlists(self, page: int = 1, limit: int = 50, **_):
        uin = self._cookie_uin()
        if not uin:
            raise ValueError("qq login cookie is required")
        page, limit = page_limit(page, limit, 50)
        query = urlencode({"hostuin": uin, "sin": (page - 1) * limit, "size": limit, "format": "json"})
        payload = self.http.get(LEGACY_URL + "/rsc/fcgi-bin/fcg_user_created_diss?" + query, headers=HEADERS)
        items = at(payload, "data", "disslist")
        if items is None:
            items = at(payload, "data", "list")
        return self._playlists(items)

    def _cookie_uin(self):
        for part in self.cookie.split(";"):
            name, separator, value = part.strip().partition("=")
            if separator and name.strip().lower() in {"uin", "qqmusic_uin", "wxuin"}:
                candidate = value.strip().lstrip("o")
                if re.fullmatch(r"\d+", candidate):
                    return candidate
        return ""

    def _songs(self, value):
        result = []
        for raw_value in list_value(value):
            raw = object_value(raw_value)
            identifier = first(raw, "songmid", "mid", "songid")
            if not identifier:
                continue
            album = object_value(raw.get("album"))
            album_id = first(raw, "albummid") or string(album.get("mid"))
            album_name = first(raw, "albumname") or string(album.get("name"))
            artists = raw.get("singer") if raw.get("singer") is not None else raw.get("singer_list")
            extra = {"songmid": identifier, "album_mid": album_id}
            if integer(at(raw, "pay", "paytrackprice")) > 0:
                extra["is_paid"] = "1"
            if integer(raw.get("sizeflac")) > 0:
                extra["has_lossless"] = "1"
            result.append(track_payload(
                identifier=identifier, source=self.source, name=first(raw, "songname", "name"),
                artist=join_names(artists), album=album_name, album_id=album_id,
                duration=integer(raw.get("interval")), cover=self._album_cover(album_id), extra=extra,
            ))
        return result

    def _playlists(self, value):
        return [item for item in (self._playlist(object_value(raw)) for raw in list_value(value)) if item["id"]]

    def _playlist(self, raw):
        identifier = first(raw, "dissid", "disstid")
        return collection_payload(
            identifier=identifier, source=self.source, name=string(raw.get("dissname")),
            creator=string(at(raw, "creator", "name")), description=string(raw.get("introduction")),
            cover=first(raw, "imgurl", "logo"), link="https://y.qq.com/n/ryqq/playlist/" + identifier,
            track_count=first_integer(raw, "song_count", "songnum"), play_count=integer(raw.get("listennum")),
        )

    def _albums(self, value):
        return [item for item in (self._album(object_value(raw)) for raw in list_value(value)) if item["id"]]

    def _album(self, raw):
        identifier = first(raw, "albumMID", "mid")
        return collection_payload(
            identifier=identifier, source=self.source, name=first(raw, "albumName", "name"),
            creator=first(raw, "singerName", "singername"), description=string(raw.get("desc")),
            cover=first(raw, "albumPic") or self._album_cover(identifier),
            link="https://y.qq.com/n/ryqq/albumDetail/" + identifier,
            track_count=first_integer(raw, "song_count", "total_song_num"),
        )

    @staticmethod
    def _album_cover(identifier: str) -> str:
        return "https://y.gtimg.cn/music/photo_new/T002R300x300M000" + identifier + ".jpg" if identifier else ""

