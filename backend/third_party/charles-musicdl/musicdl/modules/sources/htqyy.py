'''
Function:
    Implementation of HTQYYMusicClient: http://www.htqyy.com/
Author:
    Zhenchao Jin
WeChat Official Account (微信公众号):
    Charles的皮卡丘
'''
import re
from html import unescape
from bs4 import BeautifulSoup
from urllib.parse import urljoin
from .base import BaseMusicClient
from rich.progress import Progress
from ..utils import legalizestring, usesearchheaderscookies, SongInfo


'''HTQYYMusicClient'''
class HTQYYMusicClient(BaseMusicClient):
    source = 'HTQYYMusicClient'
    def __init__(self, **kwargs):
        super(HTQYYMusicClient, self).__init__(**kwargs)
        self.default_search_headers = {
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
            "accept-encoding": "gzip, deflate",
            "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
            "cache-control": "max-age=0",
            "host": "www.htqyy.com",
            "proxy-connection": "keep-alive",
            "referer": "http://www.htqyy.com/",
            "upgrade-insecure-requests": "1",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
        }
        self.default_download_headers = {
            "accept-encoding": "identity;q=1, *;q=0",
            "referer": "http://www.htqyy.com/",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
        }
        self.default_headers = self.default_search_headers
        self._initsession()
    '''_constructsearchurls'''
    def _constructsearchurls(self, keyword: str, rule: dict = None, request_overrides: dict = None):
        # init
        rule, request_overrides = rule or {}, request_overrides or {}
        # construct search urls
        search_urls = [f'http://www.htqyy.com/home/search?wd={keyword}']
        self.search_size_per_page = self.search_size_per_source
        # return
        return search_urls
    '''_parsesearchresultsfromhtml'''
    def _parsesearchresultsfromhtml(self, html_text: str):
        base_url = "http://www.htqyy.com"
        soup = BeautifulSoup(html_text, "html.parser")
        items = soup.select("ul#musicList li.musicItem")
        search_results = []
        for li in items:
            chk = li.select_one('input[type="checkbox"][name="checked"]')
            song_id = chk["value"].strip() if chk and chk.has_attr("value") else None
            a_title = li.select_one("span.title a")
            title_text = a_title.get_text(" ", strip=True) if a_title else None
            play_href = a_title["href"].strip() if a_title and a_title.has_attr("href") else None
            play_url = urljoin(base_url, play_href) if play_href else None
            sid = a_title.get("sid") if a_title else None
            title_attr = a_title.get("title") if a_title else None
            a_artist = li.select_one("span.artistName a")
            artist = a_artist.get_text(" ", strip=True) if a_artist else None
            artist_url = urljoin(base_url, a_artist["href"]) if a_artist and a_artist.has_attr("href") else None
            a_album = li.select_one("span.albumName a")
            album = a_album.get_text(" ", strip=True) if a_album else None
            album_url = urljoin(base_url, a_album["href"]) if a_album and a_album.has_attr("href") else None
            num = li.select_one("span.num")
            num = num.get_text(strip=True) if num else None
            search_results.append({
                "num": num, "id": song_id, "sid": sid, "title": title_text, "title_attr": title_attr, "artist": artist,
                "artist_url": artist_url, "album": album, "album_url": album_url, "play_url": play_url,
            })
        return search_results
    '''_extractplayscriptinfo'''
    def _extractplayscriptinfo(self, html_text: str):
        soup = BeautifulSoup(html_text, "html.parser")
        script_text = None
        for s in soup.find_all("script"):
            txt = s.string or s.get_text()
            if not txt: continue
            if ("PageData." in txt or "var PageData" in txt) and ("fileHost" in txt or "var mp3" in txt): script_text = txt; break
        if not script_text: return {}
        t, pagedata = script_text, {}
        for m in re.finditer(r'PageData\.(\w+)\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([0-9]+))\s*;', t):
            key = m.group(1)
            val = m.group(2) or m.group(3) or m.group(4)
            if m.group(4) is not None: val = int(val)
            pagedata[key] = val
        def _grabvar(name: str):
            m = re.search(rf'\bvar\s+{re.escape(name)}\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([0-9]+))\s*;', t)
            if not m: return None
            val = m.group(1) or m.group(2) or m.group(3)
            if m.group(3) is not None: val = int(val)
            return val
        format_, ip = _grabvar("format") or pagedata.get("format"), _grabvar("ip")
        file_host, mp3_path, bd_text, bd_text2, img_url, mp3_url = _grabvar("fileHost"), _grabvar("mp3"), _grabvar("bdText"), _grabvar("bdText2"), _grabvar("imgUrl"), None
        if file_host and mp3_path and re.search(r'\bmp3\s*=\s*fileHost\s*\+\s*mp3\s*;', t): mp3_url = file_host + mp3_path
        def _unescape(x): return unescape(x) if isinstance(x, str) else x
        return {
            "format": _unescape(format_), "PageData": {k: _unescape(v) for k, v in pagedata.items()}, "ip": _unescape(ip),
            "fileHost": _unescape(file_host), "mp3_path": _unescape(mp3_path), "mp3_url": _unescape(mp3_url), "bdText": _unescape(bd_text),
            "bdText2": _unescape(bd_text2), "imgUrl": _unescape(img_url),
        }
    '''_search'''
    @usesearchheaderscookies
    def _search(self, keyword: str = '', search_url: str = '', request_overrides: dict = None, song_infos: list = [], progress: Progress = None, progress_id: int = 0):
        # init
        request_overrides = request_overrides or {}
        # successful
        try:
            # --search results
            resp = self.get(search_url, **request_overrides)
            resp.raise_for_status()
            search_results = self._parsesearchresultsfromhtml(resp.text)
            for search_result in search_results:
                # --download results
                if not isinstance(search_result, dict) or ('play_url' not in search_result):
                    continue
                try:
                    resp = self.get(search_result['play_url'], **request_overrides)
                    resp.raise_for_status()
                    download_result = self._extractplayscriptinfo(resp.text)
                    download_url = download_result.get('mp3_url')
                except:
                    continue
                if not download_url: continue
                song_info = SongInfo(
                    source=self.source, download_url=download_url, download_url_status=self.audio_link_tester.test(download_url, request_overrides), 
                    raw_data={'search': search_result, 'download': download_result, 'lyric': {}}, ext=download_result.get('format', 'mp3'), file_size='NULL',
                    lyric='NULL', duration='-:-:-', song_name=legalizestring(search_result.get('title', 'NULL'), replace_null_string='NULL'),
                    singers=legalizestring(search_result.get('artist', 'NULL'), replace_null_string='NULL'), identifier=search_result.get('id') or search_result.get('sid'),
                    album=legalizestring(search_result.get('album', 'NULL'), replace_null_string='NULL'),
                )
                if not song_info.with_valid_download_url: continue
                song_info.download_url_status['probe_status'] = self.audio_link_tester.probe(song_info.download_url, request_overrides)
                ext, file_size = song_info.download_url_status['probe_status']['ext'], song_info.download_url_status['probe_status']['file_size']
                if file_size and file_size != 'NULL': song_info.file_size = file_size
                if ext and ext != 'NULL': song_info.ext = ext
                # --append to song_infos
                song_infos.append(song_info)
                # --judgement for search_size
                if self.strict_limit_search_size_per_page and len(song_infos) >= self.search_size_per_page: break
            # --update progress
            progress.update(progress_id, description=f"{self.source}.search >>> {search_url} (Success)")
        # failure
        except Exception as err:
            progress.update(progress_id, description=f"{self.source}.search >>> {search_url} (Error: {err})")
        # return
        return song_infos