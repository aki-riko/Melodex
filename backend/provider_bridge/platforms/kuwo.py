"""Kuwo collection adapter hosted by the provider sidecar."""

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
    link_id,
    list_value,
    normalize_kuwo_text,
    object_value,
    page_limit,
    string,
    track_payload,
)
from provider_bridge.platform_http import PlatformHTTP


SEARCH_URL = "http://search.kuwo.cn/r.s"
LIST_URL = "http://nplserver.kuwo.cn/pl.svc"
BROWSE_URL = "http://wapi.kuwo.cn/api/pc/classify/playlist"


class KuwoCollections:
    source = "kuwo"

    def __init__(self, cookie: str = "", session=None):
        self.http = PlatformHTTP(cookie, session)

    def search_playlist(self, keyword: str, **_):
        return self._playlists(self._search(keyword, "playlist").get("abslist"))

    def search_album(self, keyword: str, **_):
        return self._albums(self._search(keyword, "album").get("albumlist"))

    def _search(self, keyword: str, collection_type: str):
        query = {
            "client": "kt", "all": string(keyword), "pn": 0, "rn": 30, "uid": 0,
            "ver": "kwplayer_ar_9.2.2.1", "vipver": 1, "show_copyright_off": 1,
            "newver": 1, "ft": collection_type, "cluster": 0, "strategy": 2012,
            "encoding": "utf8", "rformat": "json", "mobi": 1,
        }
        return self.http.get(SEARCH_URL + "?" + urlencode(query))

    def playlist(self, identifier: str, **_):
        identifier = string(identifier)
        if not identifier:
            raise ValueError("kuwo playlist id is empty")
        query = {
            "op": "getlistinfo", "pid": identifier, "pn": 0, "rn": 1000,
            "encode": "utf8", "keyset": "pl2012", "vipver": "MUSIC_9.1.1.2_BCS2", "newver": 1,
        }
        payload = self.http.get(LIST_URL + "?" + urlencode(query))
        playlist = self._playlist_detail(payload, identifier)
        songs = self._songs(payload.get("musiclist"), playlist)
        if not songs:
            raise ValueError("kuwo playlist response has no songs")
        if not playlist["track_count"]:
            playlist["track_count"] = len(songs)
        return playlist, songs

    def album(self, identifier: str, **_):
        identifier = string(identifier)
        if not identifier:
            raise ValueError("kuwo album id is empty")
        query = {
            "pn": 0, "rn": 1000, "stype": "albuminfo", "albumid": identifier,
            "sortby": 0, "alflac": 1, "show_copyright_off": 1, "pcmp4": 1, "encoding": "utf8",
        }
        payload = self.http.get(SEARCH_URL + "?" + urlencode(query))
        album = self._album(object_value(payload))
        album["id"] = album["id"] or identifier
        album["link"] = self._album_link(album["id"])
        songs = self._songs(payload.get("musiclist"), album)
        if not songs:
            raise ValueError("kuwo album response has no songs")
        if not album["track_count"]:
            album["track_count"] = len(songs)
        return album, songs

    def parse_playlist(self, link: str, **_):
        identifier = link_id(link)
        if not re.search(r"/playlist_detail/\d+", string(link), re.IGNORECASE) or not identifier:
            raise ValueError("invalid kuwo playlist link")
        return self.playlist(identifier)

    def parse_album(self, link: str, **_):
        identifier = link_id(link)
        if not re.search(r"/album_detail/\d+", string(link), re.IGNORECASE) or not identifier:
            raise ValueError("invalid kuwo album link")
        return self.album(identifier)

    def recommend(self, **_):
        return self.category("", 1, 30)

    def categories(self, **_):
        payload = self.http.get(BROWSE_URL + "/getTagList?" + urlencode({"loginUid": 0, "loginSid": 0, "appUid": 38668888}))
        if integer(payload.get("code")) != 200:
            raise ValueError(f"kuwo playlist categories failed: code={integer(payload.get('code'))}")
        result = [category_payload(identifier="", source=self.source, name="全部", group="全部")]
        for group_value in list_value(payload.get("data")):
            group = object_value(group_value)
            group_name = normalize_kuwo_text(group.get("name"))
            for item_value in list_value(group.get("data")):
                item = object_value(item_value)
                identifier = string(item.get("id"))
                name = normalize_kuwo_text(item.get("name"))
                if identifier and name:
                    result.append(category_payload(
                        identifier=identifier, source=self.source, name=name, group=group_name,
                        hot="HOT" in string(item.get("extend")).upper(),
                    ))
        return result

    def category(self, category_id: str, page: int = 1, limit: int = 30, **_):
        page, limit = page_limit(page, limit)
        query = {"pn": page, "rn": limit, "loginUid": 0, "loginSid": 0, "appUid": 38668888}
        endpoint = "/getRcmPlayList"
        if string(category_id):
            endpoint = "/getTagPlayList"
            query["id"] = string(category_id)
        else:
            query["order"] = "hot"
        payload = self.http.get(BROWSE_URL + endpoint + "?" + urlencode(query))
        if integer(payload.get("code")) != 200:
            raise ValueError(f"kuwo category playlists failed: code={integer(payload.get('code'))}")
        playlists = self._browse_playlists(at(payload, "data", "data"))
        if not playlists:
            raise ValueError("kuwo category playlists response is empty")
        return playlists

    def _songs(self, value, collection):
        result = []
        for raw_value in list_value(value):
            raw = object_value(raw_value)
            identifier = first(raw, "id", "musicrid", "audio_id").removeprefix("MUSIC_")
            if not identifier:
                continue
            album_id = first(raw, "albumid", "albumId") or collection["id"]
            album = normalize_kuwo_text(first(raw, "album", "falbum")) or collection["name"]
            cover = self._image(first(raw, "albumpic", "pic120", "web_albumpic_short", "img")) or collection["cover"]
            name = normalize_kuwo_text(first(raw, "name", "songname", "fsongname"))
            artist = normalize_kuwo_text(first(raw, "artist", "aartist", "fartist"))
            result.append(track_payload(
                identifier=identifier, source=self.source, name=name, artist=artist,
                album=album, album_id=album_id, duration=integer(raw.get("duration")), cover=cover,
                link="http://www.kuwo.cn/play_detail/" + identifier,
                extra={"rid": identifier, "album_id": album_id, "provider_lookup": f"{name} {artist}".strip()},
            ))
        return result

    def _playlists(self, value):
        result = []
        for raw_value in list_value(value):
            raw = object_value(raw_value)
            identifier = string(raw.get("playlistid"))
            if identifier:
                result.append(collection_payload(
                    identifier=identifier, source=self.source, name=normalize_kuwo_text(raw.get("name")),
                    cover=self._image(raw.get("pic")), track_count=integer(raw.get("songnum")),
                    play_count=integer(raw.get("playcnt")), creator=normalize_kuwo_text(raw.get("nickname")),
                    description=normalize_kuwo_text(raw.get("intro")), link=self._playlist_link(identifier),
                ))
        return result

    def _browse_playlists(self, value):
        result = []
        for raw_value in list_value(value):
            raw = object_value(raw_value)
            identifier = string(raw.get("id"))
            if identifier:
                result.append(collection_payload(
                    identifier=identifier, source=self.source, name=normalize_kuwo_text(raw.get("name")),
                    cover=self._image(raw.get("img")), track_count=first_integer(raw, "songnum", "total", "count", "musicnum"),
                    play_count=integer(raw.get("listencnt")), creator=normalize_kuwo_text(raw.get("uname")),
                    description=normalize_kuwo_text(first(raw, "desc", "info")), link=self._playlist_link(identifier),
                ))
        return result

    def _playlist_detail(self, raw, fallback_id):
        identifier = first(raw, "id", "pid") or fallback_id
        return collection_payload(
            identifier=identifier, source=self.source, name=normalize_kuwo_text(first(raw, "title", "name")),
            cover=self._image(raw.get("pic")), track_count=first_integer(raw, "total", "validtotal"),
            play_count=integer(raw.get("playnum")), creator=normalize_kuwo_text(raw.get("uname")),
            description=normalize_kuwo_text(raw.get("info")), link=self._playlist_link(identifier),
        )

    def _albums(self, value):
        result = []
        for raw_value in list_value(value):
            raw = object_value(raw_value)
            identifier = first(raw, "albumid", "id")
            if identifier:
                result.append(self._album(raw))
        return result

    def _album(self, raw):
        identifier = first(raw, "albumid", "id")
        return collection_payload(
            identifier=identifier, source=self.source, name=normalize_kuwo_text(first(raw, "name", "album")),
            cover=self._image(first(raw, "hts_img", "img", "pic")),
            track_count=first_integer(raw, "songnum", "musiccnt"), play_count=first_integer(raw, "PLAYCNT", "playcnt"),
            creator=normalize_kuwo_text(first(raw, "aartist", "artist")), description=normalize_kuwo_text(raw.get("info")),
            link=self._album_link(identifier),
        )

    @staticmethod
    def _image(value):
        value = string(value)
        for old in ("_150.", "_120.", "_100."):
            value = value.replace(old, "_700.", 1)
        if value.startswith("//"):
            return "http:" + value
        if value and not value.startswith(("http://", "https://")):
            return "http://" + value.lstrip("/")
        return value

    @staticmethod
    def _playlist_link(identifier):
        return "http://www.kuwo.cn/playlist_detail/" + identifier if identifier else ""

    @staticmethod
    def _album_link(identifier):
        return "http://www.kuwo.cn/album_detail/" + identifier if identifier else ""

