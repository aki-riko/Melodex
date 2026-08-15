'''
Function:
    Implementation of YinyuedaoMusicClient: https://1mp3.top/
Author:
    Zhenchao Jin
WeChat Official Account (微信公众号):
    Charles的皮卡丘
'''
import json_repair
from bs4 import BeautifulSoup
from .base import BaseMusicClient
from rich.progress import Progress
from ..utils import legalizestring, usesearchheaderscookies, safeextractfromdict, seconds2hms, searchdictbykey, SongInfo, QuarkParser


'''settings'''
FORMAT_RANK = {
    "DSD": 100, "DSF": 100, "DFF": 100, "WAV": 95, "AIFF": 95, "FLAC": 90, "ALAC": 90, "APE": 88, "WV": 88, "OPUS": 70,
    "AAC": 65, "M4A": 65, "OGG": 60, "VORBIS": 60, "MP3": 50, "WMA": 45,
}


'''YinyuedaoMusicClient'''
class YinyuedaoMusicClient(BaseMusicClient):
    source = 'YinyuedaoMusicClient'
    def __init__(self, **kwargs):
        super(YinyuedaoMusicClient, self).__init__(**kwargs)
        if not self.quark_parser_config.get('cookies'): self.logger_handle.warning(f'{self.source}.__init__ >>> "quark_parser_config" is not configured, so song downloads are restricted and only mp3 files can be downloaded.')
        self.default_search_headers = {
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
            "accept-encoding": "gzip, deflate, br, zstd",
            "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
            "priority": "u=0, i",
            "referer": "https://1mp3.top/",
            "sec-ch-ua": "\"Chromium\";v=\"142\", \"Google Chrome\";v=\"142\", \"Not_A Brand\";v=\"99\"",
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": "\"Windows\"",
            "sec-fetch-dest": "document",
            "sec-fetch-mode": "navigate",
            "sec-fetch-site": "same-origin",
            "sec-fetch-user": "?1",
            "upgrade-insecure-requests": "1",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
        }
        self.default_download_headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        }
        self.default_headers = self.default_search_headers
        self._initsession()
    '''_constructsearchurls'''
    def _constructsearchurls(self, keyword: str, rule: dict = None, request_overrides: dict = None):
        # init
        rule, request_overrides = rule or {}, request_overrides or {}
        # construct search urls
        search_urls = [f'https://1mp3.top/?key={keyword}&search=1']
        self.search_size_per_page = self.search_size_per_source
        # return
        return search_urls
    '''_parsesearchresultsfromhtml'''
    def _parsesearchresultsfromhtml(self, html_text: str):
        soup = BeautifulSoup(html_text, "lxml")
        search_results = []
        for li in soup.select("#musicList > li"):
            music_id_attr = li.get("data-music-id")
            music_title_attr = li.get("data-music-title")
            music_singer_attr = li.get("data-music-singer")
            music_cover_attr = li.get("data-music-cover")
            a_download = li.select_one("a.download-btn")
            music_json_str = a_download.get("data-music")
            music_data = json_repair.loads(music_json_str)
            search_results.append({
                "id_attr": music_id_attr, "title_attr": music_title_attr, "singer_attr": music_singer_attr, "cover_attr": music_cover_attr,
                "id": music_data.get("id"), "title": music_data.get("title"), "singer": music_data.get("singer"), "picurl": music_data.get("picurl"),
                "create_time": music_data.get("create_time"), "mtype": music_data.get("mtype"), "downlist": music_data.get("downlist", []),
                "ktmdownlist": music_data.get("ktmdownlist", []),
            })
        return search_results
    '''_search'''
    @usesearchheaderscookies
    def _search(self, keyword: str = '', search_url: str = '', request_overrides: dict = None, song_infos: list = [], progress: Progress = None, progress_id: int = 0):
        # init
        request_overrides = request_overrides or {}
        def _sortbyformat(items):
            def _score(x):
                fmt = (x.get("format") or "").upper()
                return FORMAT_RANK.get(fmt, 0)
            return sorted(items, key=_score, reverse=True)
        # successful
        try:
            # --search results
            resp = self.get(search_url, **request_overrides)
            resp.raise_for_status()
            search_results = self._parsesearchresultsfromhtml(resp.text)
            for search_result in search_results:
                # --download results
                if not isinstance(search_result, dict) or ('id' not in search_result):
                    continue
                song_info = SongInfo(source=self.source)
                # ----parse from quark links
                if self.quark_parser_config.get('cookies'):
                    quark_download_urls = [*search_result.get('downlist', []), *search_result.get('ktmdownlist', [])]
                    quark_download_urls = _sortbyformat(quark_download_urls)
                    for quark_download_url in quark_download_urls:
                        song_fmt = safeextractfromdict(quark_download_url, ['format'], '')
                        if not song_fmt: continue
                        song_info = SongInfo(source=self.source)
                        try:
                            quark_wav_download_url = quark_download_url['url']
                            download_result, download_url = QuarkParser.parsefromurl(quark_wav_download_url, **self.quark_parser_config)
                            duration = searchdictbykey(download_result, 'duration')
                            duration = [int(float(d)) for d in duration if int(float(d)) > 0]
                            if duration: duration = duration[0]
                            else: duration = 0
                            if not download_url: continue
                            download_url_status = self.quark_audio_link_tester.test(download_url, request_overrides)
                            download_url_status['probe_status'] = self.quark_audio_link_tester.probe(download_url, request_overrides)
                            ext = download_url_status['probe_status']['ext']
                            if ext == 'NULL': ext = 'mp3'
                            song_info.update(dict(
                                download_url=download_url, download_url_status=download_url_status, raw_data={'search': search_result, 'download': download_result},
                                default_download_headers=self.quark_default_download_headers, ext=ext, file_size=download_url_status['probe_status']['file_size'],
                                duration_s=duration, duration=seconds2hms(duration),
                            ))
                            if song_info.with_valid_download_url: break
                        except:
                            continue
                # ----parse from play url
                if not song_info.with_valid_download_url:
                    song_info = SongInfo(source=self.source)
                    try:
                        resp = self.get(f'https://1mp3.top/include/geturl.php?id={search_result["id"]}', **request_overrides)
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
                lyric_result, lyric = dict(), 'NULL'
                song_info.raw_data['lyric'] = lyric_result
                song_info.update(dict(
                    lyric=lyric, song_name=legalizestring(search_result.get('title', 'NULL'), replace_null_string='NULL'), 
                    singers=legalizestring(search_result.get('singer', 'NULL'), replace_null_string='NULL'), album='NULL', identifier=search_result['id'],
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