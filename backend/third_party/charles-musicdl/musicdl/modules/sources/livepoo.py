'''
Function:
    Implementation of LivePOOMusicClient: https://www.livepoo.cn/
Author:
    Zhenchao Jin
WeChat Official Account (微信公众号):
    Charles的皮卡丘
'''
import re
import ast
import copy
import json_repair
from bs4 import BeautifulSoup
from .base import BaseMusicClient
from rich.progress import Progress
from urllib.parse import urlencode, urljoin, urlparse, parse_qs
from ..utils import legalizestring, usesearchheaderscookies, seconds2hms, searchdictbykey, SongInfo, QuarkParser


'''settings'''
FORMAT_RANK = {
    "DSD": 100, "DSF": 100, "DFF": 100, "WAV": 95, "AIFF": 95, "FLAC": 90, "ALAC": 90, "APE": 88, "WV": 88, "OPUS": 70,
    "AAC": 65, "M4A": 65, "OGG": 60, "VORBIS": 60, "MP3": 50, "WMA": 45,
}


'''LivePOOMusicClient'''
class LivePOOMusicClient(BaseMusicClient):
    source = 'LivePOOMusicClient'
    def __init__(self, **kwargs):
        super(LivePOOMusicClient, self).__init__(**kwargs)
        if not self.quark_parser_config.get('cookies'): self.logger_handle.warning(f'{self.source}.__init__ >>> "quark_parser_config" is not configured, so song downloads are restricted and only mp3 files can be downloaded.')
        self.default_search_headers = {
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
        }
        self.default_download_headers = {
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
        }
        self.default_headers = self.default_search_headers
        self._initsession()
    '''_constructsearchurls'''
    def _constructsearchurls(self, keyword: str, rule: dict = None, request_overrides: dict = None):
        # init
        rule, request_overrides = rule or {}, request_overrides or {}
        # search rules
        default_rule = {'page': 0, 'keyword': keyword}
        default_rule.update(rule)
        # construct search urls
        base_url = 'https://www.livepoo.cn/search?'
        self.search_size_per_page = min(self.search_size_per_source, 30)
        search_urls, page_size, count = [], self.search_size_per_page, 0
        while self.search_size_per_source > count:
            page_rule = copy.deepcopy(default_rule)
            page_rule['page'] = int(count // page_size)
            search_urls.append(base_url + urlencode(page_rule))
            count += page_size
        # return
        return search_urls
    '''_parsesearchresultsfromhtml'''
    def _parsesearchresultsfromhtml(self, html_text: str):
        soup, search_results = BeautifulSoup(html_text, "lxml"), []
        base_url = "https://www.livepoo.cn/"
        for li in soup.select("ul.tuij_song li.song_item2"):
            a = li.select_one("a[href]")
            if not a: continue
            href = a["href"].strip()
            full_url = urljoin(base_url, href)
            title_div = a.select_one(".song_info2 > div")
            title = title_div.get_text(strip=True) if title_div else a.get_text(" ", strip=True)
            q = parse_qs(urlparse(href).query)
            mid = q.get("id", [None])[0]
            m = re.compile(r'^(.*?)《(.*?)》$').match(title.strip())
            singer, song_name = (m.group(1).strip(), m.group(2).strip()) if m else (None, title.strip())
            search_results.append({"title": song_name, "artist": singer, "url": full_url, "id": mid.removeprefix('MUSIC_')})
        return search_results
    '''_extractquarklinksfromhtml'''
    def _extractquarklinksfromhtml(self, html_text: str):
        PAT = re.compile(
            r"""(?:const|let|var)\s+
                (?P<key>[A-Za-z0-9_]+?)\s*=\s*
                (?P<quote>["'])
                (?P<url>https?://pan\.quark\.cn/s/[^"']+)
                (?P=quote)
            """, re.VERBOSE
        )
        def _extractquarklinksfromtext(text: str):
            out = []
            for m in PAT.finditer(text):
                key, url = m.group("key"), m.group("url").strip()
                if not url: continue
                fmt = key[:-4] if key.endswith("_url") else key
                for k in FORMAT_RANK.keys(): fmt = k if k.lower() in fmt.lower() else fmt
                out.append({"key": key, "format": fmt, "url": url})
            return out
        soup, outs = BeautifulSoup(html_text, "lxml"), []
        for s in soup.find_all("script"):
            js = s.string or s.get_text() or ""
            if "pan.quark.cn/s/" not in js: continue
            outs.extend(_extractquarklinksfromtext(js))
        seen, uniq = set(), []
        for it in outs:
            if it["url"] in seen: continue
            seen.add(it["url"])
            uniq.append(it)
        uniq = sorted(uniq, key=lambda x: FORMAT_RANK.get(x["format"].upper(), 0), reverse=True)
        return {'quark_links': uniq}
    '''_extractlrc'''
    def _extractlrc(self, js_text: str):
        # _norm
        def _norm(s: str) -> str: return re.sub(r"\s+", "", str(s))
        # _pick
        def _pick(d: dict, target: str):
            for k, v in d.items():
                if _norm(k) == target: return v
            return None
        # _fmtlrctime
        def _fmtlrctime(sec):
            t = float(_norm(sec))
            m = int(t // 60)
            s = t - m * 60
            return f"[{m:02d}:{s:05.2f}]"
        # _lrclisttolrc
        def _lrclisttolrc(detail: dict) -> str:
            lrclist = detail.get("music_lrclist", [])
            rows = []
            for it in lrclist:
                t = _pick(it, "time")
                lyric = _pick(it, "lineLyric")
                if t is None or lyric is None: continue
                lyric = re.sub(r"\s+", " ", str(lyric)).strip()
                rows.append((_fmtlrctime(t), lyric))
            rows.sort(key=lambda x: x[0])
            meta = "\n".join([f"[ti:{detail.get('music_name','')}]", f"[ar:{detail.get('music_artist','')}]", f"[al:{detail.get('music_album','')}]"]).strip() + "\n"
            return meta + "\n".join(f"{ts}{ly}" for ts, ly in rows)
        # match
        s = re.search(r"const\s+detailJson\s*=\s*'(.+?)';\s*const\s+detail\s*=\s*JSON\.parse", js_text, re.S)
        if not s: return {}, 'NULL'
        string = s.group(1).replace("\r", "").replace("\n", "")
        lyric_result = json_repair.loads(ast.literal_eval(f'"{string}"'))
        lyric = _lrclisttolrc(lyric_result)
        # return
        return lyric_result, lyric
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
                if not isinstance(search_result, dict) or ('url' not in search_result):
                    continue
                song_info = SongInfo(source=self.source)
                # ----parse from quark links
                if self.quark_parser_config.get('cookies'):
                    try:
                        resp = self.get(search_result['url'], **request_overrides)
                        resp.raise_for_status()
                        download_result = self._extractquarklinksfromhtml(resp.text)
                    except:
                        pass
                    for quark_info in download_result['quark_links']:
                        quark_download_url = quark_info['url']
                        try:
                            download_result['quark_parse_result'], download_url = QuarkParser.parsefromurl(quark_download_url, **self.quark_parser_config)
                            duration = searchdictbykey(download_result['quark_parse_result'], 'duration')
                            duration = [int(float(d)) for d in duration if int(float(d)) > 0]
                            if duration: duration = duration[0]
                            else: duration = 0
                            if not download_url: continue
                            download_url_status = self.quark_audio_link_tester.test(download_url, request_overrides)
                            download_url_status['probe_status'] = self.quark_audio_link_tester.probe(download_url, request_overrides)
                            ext = download_url_status['probe_status']['ext']
                            if ext == 'NULL': ext = 'mp3'
                            song_info = SongInfo(
                                source=self.source, download_url=download_url, download_url_status=download_url_status, raw_data={'search': search_result, 'download': download_result},
                                default_download_headers=self.quark_default_download_headers, ext=ext, file_size=download_url_status['probe_status']['file_size'],
                                duration_s=duration, duration=seconds2hms(duration),
                            )
                            if song_info.with_valid_download_url: break
                        except:
                            continue
                # ----parse from play url
                if not song_info.with_valid_download_url:
                    song_info = SongInfo(source=self.source)
                    try:
                        resp = self.get(f"https://www.livepoo.cn/audio/play?id={search_result['id']}", **request_overrides)
                        resp.raise_for_status()
                        download_url = resp.text.strip()
                        download_url_status = self.audio_link_tester.test(download_url, request_overrides)
                        download_url_status['probe_status'] = self.audio_link_tester.probe(download_url, request_overrides)
                        ext = download_url_status['probe_status']['ext']
                        if ext == 'NULL': download_url.split('?')[0].split('.')[-1] or 'mp3'
                        song_info.update(dict(
                            download_url=download_url, download_url_status=download_url_status, raw_data={'search': search_result, 'download': {}},
                            ext=ext, file_size=download_url_status['probe_status']['file_size']
                        ))
                    except:
                        continue
                if not song_info.with_valid_download_url: continue
                # ----parse more infos
                try:
                    resp = self.get(search_result['url'], **request_overrides)
                    resp.raise_for_status()
                    lyric_result, lyric = self._extractlrc(resp.text)
                except:
                    lyric_result, lyric = dict(), 'NULL'
                song_info.raw_data['lyric'] = lyric_result
                song_info.update(dict(
                    lyric=lyric, song_name=legalizestring(search_result.get('title', 'NULL'), replace_null_string='NULL'), 
                    singers=legalizestring(search_result.get('artist', 'NULL'), replace_null_string='NULL'), album='NULL', identifier=search_result['id'],
                ))
                if not song_info.duration or song_info.duration == 'NULL': song_info.duration = '-:-:-'
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