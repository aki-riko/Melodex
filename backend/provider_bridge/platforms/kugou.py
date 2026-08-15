"""Kugou collection adapter hosted by the provider sidecar."""

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
    list_value,
    object_value,
    page_limit,
    string,
    track_payload,
)
from provider_bridge.platform_http import PlatformHTTP


SEARCH_PLAYLIST_URL = "https://specialsearch.kugou.com/special_search"
SEARCH_ALBUM_URL = "https://albumsearch.kugou.com/album_search"
MOBILE_URL = "http://mobilecdn.kugou.com"
MOBILE_WEB_URL = "http://m.kugou.com"
HEADERS = {"Referer": MOBILE_WEB_URL + "/"}


class KugouCollections:
    source = "kugou"

    def __init__(self, cookie: str = "", session=None):
        self.http = PlatformHTTP(cookie, session)

    def search_playlist(self, keyword: str, **_):
        query = self._search_query(keyword)
        return self._playlists(self.http.get(SEARCH_PLAYLIST_URL + "?" + urlencode(query), headers=HEADERS).get("data", {}).get("lists"))

    def search_album(self, keyword: str, **_):
        query = self._search_query(keyword)
        return self._albums(self.http.get(SEARCH_ALBUM_URL + "?" + urlencode(query), headers=HEADERS).get("data", {}).get("lists"))

    @staticmethod
    def _search_query(keyword):
        return {"keyword": string(keyword), "page": 1, "pagesize": 30, "userid": 0, "clientver": "", "platform": "WebFilter", "filter": 0}

    def playlist(self, identifier: str, **_):
        identifier = string(identifier)
        if not identifier:
            raise ValueError("kugou playlist id is empty")
        query = urlencode({"specialid": identifier, "version": 9108, "area_code": 1})
        payload = self.http.get(MOBILE_URL + "/api/v3/special/info?" + query, headers=HEADERS)
        self._validate(payload, "playlist info")
        playlist = self._playlist(object_value(payload.get("data")))
        playlist["id"] = playlist["id"] or identifier
        playlist["link"] = self._playlist_link(playlist["id"])
        songs = self._collection_songs("special/song", "specialid", identifier)
        playlist["track_count"] = playlist["track_count"] or len(songs)
        return playlist, songs

    def album(self, identifier: str, **_):
        identifier = string(identifier)
        if not identifier:
            raise ValueError("kugou album id is empty")
        query = urlencode({"albumid": identifier, "version": 9108, "area_code": 1})
        payload = self.http.get(MOBILE_URL + "/api/v3/album/info?" + query, headers=HEADERS)
        self._validate(payload, "album info")
        album = self._album(object_value(payload.get("data")))
        album["id"] = album["id"] or identifier
        album["link"] = self._album_link(album["id"])
        songs = self._collection_songs("album/song", "albumid", identifier)
        for song in songs:
            song["album"] = song["album"] or album["name"]
            song["album_id"] = song["album_id"] or album["id"]
            song["extra"]["album_id"] = song["album_id"]
            song["cover"] = song["cover"] or album["cover"]
        album["track_count"] = album["track_count"] or len(songs)
        return album, songs

    def parse_playlist(self, link: str, **_):
        match = re.search(r"/yy/special/single/(\d+)(?:\.html)?", string(link), re.IGNORECASE)
        if not match:
            raise ValueError("invalid kugou playlist link")
        return self.playlist(match.group(1))

    def parse_album(self, link: str, **_):
        match = re.search(r"/album/(\d+)(?:\.html)?", string(link), re.IGNORECASE)
        if not match:
            raise ValueError("invalid kugou album link")
        return self.album(match.group(1))

    def recommend(self, **_):
        payload = self.http.get(MOBILE_WEB_URL + "/plist/index&json=true", headers=HEADERS)
        playlists = self._playlists(at(payload, "plist", "list", "info"))
        if not playlists:
            raise ValueError("kugou recommendations response is empty")
        return playlists

    def categories(self, **_):
        payload = self.http.get(MOBILE_URL + "/api/v3/tag/list?pid=0&apiver=2&plat=0", headers=HEADERS)
        self._validate(payload, "playlist categories")
        result = [category_payload(identifier="", source=self.source, name="全部", group="全部")]
        for group_value in list_value(at(payload, "data", "info")):
            group = object_value(group_value)
            group_name = string(group.get("name"))
            for child_value in list_value(group.get("children")):
                child = object_value(child_value)
                identifier = string(child.get("id"))
                name = string(child.get("name"))
                if not identifier or not name:
                    continue
                tag_id = string(child.get("special_tag_id")) or "0"
                result.append(category_payload(
                    identifier=f"{identifier}:{tag_id}", source=self.source, name=name, group=group_name,
                    hot=integer(child.get("is_hot")) == 1, extra={"id": identifier, "tag_id": tag_id},
                ))
        return result

    def category(self, category_id: str, page: int = 1, limit: int = 30, **_):
        page, limit = page_limit(page, limit)
        identifier, tag_id = self._category_id(category_id)
        if not identifier:
            for item in self.categories():
                if item["id"]:
                    identifier, tag_id = self._category_id(item["id"])
                    break
        if not identifier:
            raise ValueError("kugou playlist category id is empty")
        query = urlencode({"plat": 0, "page": page, "pagesize": limit, "tagid": tag_id, "ugc": 1, "id": identifier, "sort": 2})
        payload = self.http.get(MOBILE_URL + "/api/v3/tag/specialList?" + query, headers=HEADERS)
        self._validate(payload, "category playlists")
        playlists = self._playlists(at(payload, "data", "info"))
        if not playlists:
            raise ValueError("kugou category playlists response is empty")
        return playlists

    def _collection_songs(self, route, key, identifier):
        result = []
        for page in range(1, 101):
            query = urlencode({key: identifier, "page": page, "pagesize": 300, "version": 9108, "area_code": 1})
            payload = self.http.get(MOBILE_URL + "/api/v3/" + route + "?" + query, headers=HEADERS)
            self._validate(payload, route)
            items = list_value(at(payload, "data", "info"))
            result.extend(self._songs(items))
            total = integer(at(payload, "data", "total"))
            if len(items) < 300 or (total and len(result) >= total):
                break
        if not result:
            raise ValueError("kugou collection response is empty")
        return result

    @staticmethod
    def _validate(payload, operation):
        if integer(payload.get("status")) != 1 or integer(payload.get("errcode")) != 0:
            raise ValueError(f"kugou {operation} failed")

    def _songs(self, value):
        result = []
        for raw_value in list_value(value):
            raw = object_value(raw_value)
            identifier = first(raw, "hash", "origin_hash", "sqhash", "320hash")
            if not identifier:
                continue
            name = first(raw, "songname", "song_name")
            artist = first(raw, "singername", "singer_name")
            if not name or not artist:
                parsed = string(raw.get("filename")).split(" - ", 1)
                artist = artist or (parsed[0].strip() if len(parsed) == 2 else "")
                name = name or (parsed[1].strip() if len(parsed) == 2 else string(raw.get("filename")))
            album_id = first(raw, "album_id", "albumid")
            album = first(raw, "album_name", "remark")
            cover = string(at(raw, "trans_param", "union_cover")).replace("{size}", "240")
            size = first_integer(raw, "filesize", "320filesize", "sqfilesize")
            duration = integer(raw.get("duration"))
            bitrate = integer(raw.get("bitrate")) or (size * 8 // 1000 // duration if size and duration else 0)
            result.append(track_payload(
                identifier=identifier, source=self.source, name=name, artist=artist, album=album, album_id=album_id,
                duration=duration, size=size, bitrate=bitrate, cover=cover,
                link="https://www.kugou.com/song/#hash=" + identifier,
                extra={"hash": identifier, "album_id": album_id, "audio_id": first(raw, "audio_id", "album_audio_id"),
                       "sq_hash": string(raw.get("sqhash")), "hq_hash": string(raw.get("320hash")),
                       "provider_lookup": f"{name} {artist}".strip()},
            ))
        return result

    def _playlists(self, value):
        result = []
        for raw_value in list_value(value):
            playlist = self._playlist(object_value(raw_value))
            if playlist["id"]:
                result.append(playlist)
        return result

    def _playlist(self, raw):
        identifier = first(raw, "specialid", "global_specialid")
        return collection_payload(
            identifier=identifier, source=self.source, name=string(raw.get("specialname")),
            cover=first(raw, "img", "imgurl").replace("{size}", "240"),
            track_count=first_integer(raw, "song_count", "songcount"), play_count=first_integer(raw, "total_play_count", "playcount"),
            creator=first(raw, "nickname", "username", "singername"), description=string(raw.get("intro")),
            link=self._playlist_link(identifier),
        )

    def _albums(self, value):
        result = []
        for raw_value in list_value(value):
            album = self._album(object_value(raw_value))
            if album["id"]:
                result.append(album)
        return result

    def _album(self, raw):
        identifier = string(raw.get("albumid"))
        return collection_payload(
            identifier=identifier, source=self.source, name=string(raw.get("albumname")),
            cover=first(raw, "img", "imgurl").replace("{size}", "240"),
            track_count=first_integer(raw, "songcount", "song_count"), play_count=first_integer(raw, "play_count", "playcount"),
            creator=first(raw, "singer", "singername"), description=string(raw.get("intro")),
            link=self._album_link(identifier),
        )

    @staticmethod
    def _category_id(value):
        parts = string(value).split(":", 1)
        return parts[0].strip(), (parts[1].strip() if len(parts) == 2 and parts[1].strip() else "0")

    @staticmethod
    def _playlist_link(identifier):
        return "https://www.kugou.com/yy/special/single/" + identifier + ".html" if identifier else ""

    @staticmethod
    def _album_link(identifier):
        return "https://www.kugou.com/album/" + identifier + ".html" if identifier else ""
