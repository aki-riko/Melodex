"""Migu collection adapter hosted by the provider sidecar."""

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
    list_value,
    object_value,
    page_limit,
    regex_link_id,
    string,
    track_payload,
)
from provider_bridge.platform_http import PlatformHTTP


SEARCH_URL = "http://pd.musicapp.migu.cn/MIGUM2.0/v1.0/content"
CONTENT_URL = "https://app.c.nf.migu.cn"
HEADERS = {"Referer": "http://music.migu.cn/"}


class MiguCollections:
    source = "migu"

    def __init__(self, cookie: str = "", session=None):
        self.http = PlatformHTTP(cookie, session)

    def search_playlist(self, keyword: str, **_):
        payload = self.http.get(SEARCH_URL + "/search_all.do?" + urlencode(self._search_query(keyword, 1, 30, True)), headers=HEADERS)
        return self._playlists(at(payload, "songListResultData", "result"))

    def search_album(self, keyword: str, **_):
        payload = self.http.get(SEARCH_URL + "/search_all.do?" + urlencode(self._search_query(keyword, 1, 30, False)), headers=HEADERS)
        albums = self._albums(at(payload, "albumResultData", "result"))
        if not albums:
            raise ValueError("migu albums response is empty")
        return albums

    @staticmethod
    def _search_query(keyword, page, limit, playlist):
        switches = (
            '{"song":0,"album":0,"singer":0,"tagSong":0,"mvSong":0,"songlist":1,"bestShow":1}'
            if playlist else
            '{"song":0,"album":1,"singer":0,"tagSong":0,"mvSong":0,"songlist":0,"bestShow":1}'
        )
        return {"ua": "Android_migu", "version": "5.0.1", "text": string(keyword), "pageNo": max(1, integer(page)), "pageSize": min(max(integer(limit) or 30, 1), 100), "searchSwitch": switches}

    def playlist(self, identifier: str, **_):
        identifier = string(identifier)
        if not identifier:
            raise ValueError("migu playlist id is empty")
        songs = self._collection_songs("/MIGUM3.0/resource/playlist/song/v2.0", "playlistId", identifier, "migu playlist")
        try:
            playlist = self._playlist_info(identifier)
        except Exception:
            playlist = collection_payload(identifier=identifier, source=self.source, name=identifier, link=self._playlist_link(identifier))
        playlist["track_count"] = playlist["track_count"] or len(songs)
        if not playlist["cover"] and songs:
            playlist["cover"] = songs[0]["cover"]
        return playlist, songs

    def album(self, identifier: str, **_):
        identifier = string(identifier)
        if not identifier:
            raise ValueError("migu album id is empty")
        songs = self._collection_songs("/MIGUM2.0/v1.0/content/queryAlbumSong", "albumId", identifier, "migu album")
        query = urlencode({"needSimple": "00", "resourceType": 2003, "resourceId": identifier})
        payload = self.http.get(CONTENT_URL + "/MIGUM2.0/v1.0/content/resourceinfo.do?" + query, headers=HEADERS)
        self._validate(payload, "album info")
        resources = list_value(payload.get("resource"))
        if not resources:
            raise ValueError("migu album info response is empty")
        album = self._album_detail(object_value(resources[0]), identifier)
        album["track_count"] = album["track_count"] or len(songs)
        for song in songs:
            song["album"] = song["album"] or album["name"]
            song["album_id"] = song["album_id"] or album["id"]
            song["extra"]["album_id"] = song["album_id"]
            song["cover"] = song["cover"] or album["cover"]
        return album, songs

    def parse_playlist(self, link: str, **_):
        identifier = regex_link_id(link, (r"playlistId=(\d+)", r"musicListId=(\d+)", r"/(?:playlist|songlist)/(\d+)"))
        if not identifier and string(link) and "/" not in string(link):
            identifier = string(link)
        if not identifier:
            raise ValueError("invalid migu playlist link")
        return self.playlist(identifier)

    def parse_album(self, link: str, **_):
        identifier = regex_link_id(link, (r"music\.migu\.cn/(?:v3|v5)/music/album/(\d+)", r"albumId=(\d+)", r"resourceId=(\d+)"))
        if not identifier:
            raise ValueError("invalid migu album link")
        return self.album(identifier)

    def recommend(self, **_):
        return self.search_playlist("华语")

    def categories(self, **_):
        values = (
            ("语种", "华语", True), ("语种", "欧美", True), ("语种", "日语", False), ("语种", "韩语", False),
            ("语种", "粤语", False), ("风格", "流行", True), ("风格", "摇滚", True), ("风格", "民谣", True),
            ("风格", "电子", False), ("风格", "说唱", False), ("风格", "古风", False), ("风格", "轻音乐", False),
            ("场景", "影视", True), ("场景", "ACG", False), ("场景", "治愈", False), ("场景", "运动", False),
            ("场景", "学习", False), ("场景", "睡前", False),
        )
        result = [category_payload(identifier="", source=self.source, name="全部", group="全部")]
        result.extend(category_payload(identifier=name, source=self.source, name=name, group=group, hot=hot) for group, name, hot in values)
        return result

    def category(self, category_id: str, page: int = 1, limit: int = 30, **_):
        category_id = string(category_id) or "华语"
        playlists = self._search_playlists(category_id, page, limit)
        if not playlists:
            raise ValueError("migu category playlists response is empty")
        for playlist in playlists:
            playlist["extra"]["category_id"] = category_id
        return playlists

    def user_playlists(self, **_):
        raise ValueError("migu user playlists are not supported")

    def _search_playlists(self, keyword, page, limit):
        payload = self.http.get(SEARCH_URL + "/search_all.do?" + urlencode(self._search_query(keyword, page, limit, True)), headers=HEADERS)
        return self._playlists(at(payload, "songListResultData", "result"))

    def _playlist_info(self, identifier):
        query = urlencode({"needSimple": "00", "resourceType": 2021, "resourceId": identifier})
        payload = self.http.get(CONTENT_URL + "/MIGUM2.0/v1.0/content/resourceinfo.do?" + query, headers=HEADERS)
        self._validate(payload, "playlist info")
        resources = list_value(payload.get("resource"))
        if not resources:
            raise ValueError("migu playlist info response is empty")
        raw = object_value(resources[0])
        playlist_id = first(raw, "musicListId", "id") or identifier
        image = first(raw, "originalImgUrl") or first(object_value(raw.get("imgItem")), "img", "webpImg", "imgOri")
        return collection_payload(
            identifier=playlist_id, source=self.source, name=first(raw, "title", "name"), cover=self._image(image),
            track_count=integer(raw.get("musicNum")), play_count=integer(at(raw, "opNumItem", "playNum")),
            creator=string(raw.get("ownerName")), description=string(raw.get("summary")), link=self._playlist_link(playlist_id),
            extra={"type": "playlist", "playlist_id": playlist_id},
        )

    def _collection_songs(self, endpoint, key, identifier, operation):
        result, seen = [], set()
        for page in range(1, 101):
            query = urlencode({key: identifier, "pageNo": page, "pageSize": 50})
            payload = self.http.get(CONTENT_URL + endpoint + "?" + query, headers=HEADERS)
            self._validate(payload, operation)
            items = list_value(at(payload, "data", "songList"))
            for song in self._songs(items):
                if song["id"] not in seen:
                    seen.add(song["id"])
                    result.append(song)
            total = integer(at(payload, "data", "totalCount"))
            if len(items) < 50 or (total and len(result) >= total):
                break
        if not result:
            raise ValueError(operation + " response is empty")
        return result

    @staticmethod
    def _validate(payload, operation):
        code = string(payload.get("code"))
        if code and code != "000000":
            raise ValueError(f"migu {operation} failed: code={code}")

    def _songs(self, value):
        result = []
        for raw_value in list_value(value):
            raw = object_value(raw_value)
            identifier = first(raw, "contentId", "songId", "copyrightId", "id")
            if not identifier:
                continue
            name = first(raw, "songName", "name")
            artist = join_names(raw.get("singerList") or raw.get("singers") or raw.get("artists"), separator=" / ") or string(raw.get("singer"))
            album = string(raw.get("album"))
            album_id = string(raw.get("albumId"))
            albums = list_value(raw.get("albums"))
            if albums:
                album = album or string(object_value(albums[0]).get("name"))
                album_id = album_id or string(object_value(albums[0]).get("id"))
            size, ext = self._best_format(raw.get("audioFormats") or raw.get("rateFormats") or raw.get("newRateFormats"))
            duration = integer(raw.get("duration"))
            bitrate = size * 8 // 1000 // duration if size and duration else 0
            image = first(raw, "img1", "img2", "img3") or self._pick_image(raw.get("imgItems") or raw.get("albumImgs"))
            result.append(track_payload(
                identifier=identifier, source=self.source, name=name, artist=artist, album=album, album_id=album_id,
                duration=duration, size=size, bitrate=bitrate, ext=ext, cover=self._image(image),
                link="https://music.migu.cn/v3/music/song/" + identifier,
                extra={"content_id": string(raw.get("contentId")), "copyright_id": string(raw.get("copyrightId")), "album_id": album_id, "provider_lookup": f"{name} {artist}".strip()},
            ))
        return result

    def _playlists(self, value):
        result = []
        for raw_value in list_value(value):
            raw = object_value(raw_value)
            identifier, name = string(raw.get("id")), string(raw.get("name"))
            if identifier and name:
                image = first(raw, "musicListPicUrl") or self._pick_image(raw.get("imgItems"))
                result.append(collection_payload(
                    identifier=identifier, source=self.source, name=name, cover=self._image(image),
                    track_count=integer(raw.get("musicNum")), play_count=integer(raw.get("playNum")),
                    creator=first(raw, "userName", "ownerName"), link=self._playlist_link(identifier),
                    extra={"type": "playlist", "playlist_id": identifier},
                ))
        return result

    def _albums(self, value):
        result = []
        for raw_value in list_value(value):
            raw = object_value(raw_value)
            identifier = string(raw.get("id"))
            if identifier:
                result.append(collection_payload(
                    identifier=identifier, source=self.source, name=string(raw.get("name")),
                    cover=self._image(self._pick_image(raw.get("imgItems"))), creator=string(raw.get("singer")),
                    description=first(raw, "desc", "publishDate"), link=self._album_link(identifier),
                    extra={"type": "album", "album_id": identifier, "resource_type": string(raw.get("resourceType"))},
                ))
        return result

    def _album_detail(self, raw, fallback_id):
        identifier = first(raw, "albumId", "id") or fallback_id
        return collection_payload(
            identifier=identifier, source=self.source, name=string(raw.get("title")),
            cover=self._image(self._pick_image(raw.get("imgItems"))), track_count=integer(raw.get("totalCount")),
            play_count=integer(at(raw, "opNumItem", "playNum")), creator=string(raw.get("singer")),
            description=string(raw.get("summary")), link=self._album_link(identifier),
            extra={"type": "album", "album_id": identifier},
        )

    @staticmethod
    def _pick_image(value):
        items = list_value(value)
        for preferred in ("02", "01", "03"):
            for item in items:
                raw = object_value(item)
                if string(raw.get("imgSizeType")) == preferred and string(raw.get("img")):
                    return string(raw.get("img"))
        for item in items:
            raw = object_value(item)
            image = first(raw, "img", "webpImg", "imgOri")
            if image:
                return image
        return ""

    @staticmethod
    def _best_format(value):
        best_size, extension = 0, "mp3"
        for item in list_value(value):
            raw = object_value(item)
            size = 0
            for key in ("asize", "androidSize", "size", "isize"):
                size = integer(raw.get(key))
                if size:
                    break
            if size <= best_size:
                continue
            best_size = size
            fmt = string(raw.get("formatType")).upper()
            code = first(raw, "aformat", "androidFileType", "fileType", "iformat")
            extension = "flac" if "SQ" in fmt or code.startswith("011") else "mp3"
        return best_size, extension

    @staticmethod
    def _image(value):
        value = string(value)
        if value.startswith("//"):
            return "https:" + value
        if value.startswith("/"):
            return "https://d.musicapp.migu.cn" + value
        return value

    @staticmethod
    def _playlist_link(identifier):
        return "https://music.migu.cn/v5/#/playlist?playlistId=" + identifier + "&playlistType=ordinary"

    @staticmethod
    def _album_link(identifier):
        return "https://music.migu.cn/v3/music/album/" + identifier
