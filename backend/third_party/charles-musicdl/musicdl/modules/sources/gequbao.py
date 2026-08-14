'''
Function:
    Implementation of GequbaoMusicClient: https://www.gequbao.com/
Author:
    Zhenchao Jin
WeChat Official Account (微信公众号):
    Charles的皮卡丘
'''
import re
import json_repair
from bs4 import BeautifulSoup
from urllib.parse import urljoin
from .base import BaseMusicClient
from rich.progress import Progress
from ..utils import legalizestring, usesearchheaderscookies, resp2json, safeextractfromdict, SongInfo, QuarkParser


'''GequbaoMusicClient'''
class GequbaoMusicClient(BaseMusicClient):
    source = 'GequbaoMusicClient'
    def __init__(self, **kwargs):
        super(GequbaoMusicClient, self).__init__(**kwargs)
        if not self.quark_parser_config.get('cookies'): self.logger_handle.warning(f'{self.source}.__init__ >>> "quark_parser_config" is not configured, so song downloads are restricted and only mp3 files can be downloaded.')
        self.default_search_headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
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
        search_urls = [f'https://www.gequbao.com/s/{keyword}']
        self.search_size_per_page = self.search_size_per_source
        # return
        return search_urls
    '''_parsesearchresultsfromhtml'''
    def _parsesearchresultsfromhtml(self, html_text: str):
        soup = BeautifulSoup(html_text, "lxml")
        base_url, search_results = "https://www.gequbao.com", []
        for a in soup.select("a.music-link"):
            href = urljoin(base_url, a.get("href", "").strip())
            title_tag = a.select_one(".music-title span")
            title = title_tag.get_text(strip=True) if title_tag else ""
            artist_tag = a.select_one("small")
            artist = artist_tag.get_text(strip=True) if artist_tag else ""
            search_results.append({'href': href, 'title': title, 'artist': artist})
        return search_results
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
                if not isinstance(search_result, dict) or ('href' not in search_result):
                    continue
                song_info = SongInfo(source=self.source)
                # ----fetch basic information
                try:
                    resp = self.get(search_result['href'], **request_overrides)
                    resp.raise_for_status()
                    soup = BeautifulSoup(resp.text, "lxml")
                    script_tag = soup.find("script", string=re.compile(r"window\.appData"))
                    if script_tag is None: continue
                    js_text: str = script_tag.string
                    m = re.search(r"window\.appData\s*=\s*(\{.*?\})\s*;", js_text, re.S)
                    if not m: continue
                    download_result = json_repair.loads(m.group(1))
                except:
                    continue
                # ----parse from quark links
                if self.quark_parser_config.get('cookies'):
                    quark_download_urls = download_result.get('mp3_extra_urls', [])
                    for quark_download_url in quark_download_urls:
                        song_info = SongInfo(source=self.source)
                        try:
                            quark_wav_download_url = quark_download_url['share_link']
                            download_result['quark_parse_result'], download_url = QuarkParser.parsefromurl(quark_wav_download_url, **self.quark_parser_config)
                            if not download_url: continue
                            download_url_status = self.quark_audio_link_tester.test(download_url, request_overrides)
                            download_url_status['probe_status'] = self.quark_audio_link_tester.probe(download_url, request_overrides)
                            ext = download_url_status['probe_status']['ext']
                            if ext == 'NULL': ext = 'mp3'
                            song_info.update(dict(
                                download_url=download_url, download_url_status=download_url_status, raw_data={'search': search_result, 'download': download_result},
                                default_download_headers=self.quark_default_download_headers, ext=ext, file_size=download_url_status['probe_status']['file_size']
                            ))
                            if song_info.with_valid_download_url: break
                        except:
                            continue
                # ----parse from play url
                if not song_info.with_valid_download_url:
                    if 'play_id' not in download_result or not download_result['play_id']: continue
                    song_info = SongInfo(source=self.source)
                    try:
                        resp = self.post('https://www.gequbao.com/api/play-url', json={'id': download_result['play_id']}, **request_overrides)
                        resp.raise_for_status()
                        download_result['api/play-url'] = resp2json(resp=resp)
                        download_url = safeextractfromdict(download_result['api/play-url'], ['data', 'url'], '')
                        if not download_url: continue
                        download_url_status = self.audio_link_tester.test(download_url, request_overrides)
                        download_url_status['probe_status'] = self.audio_link_tester.probe(download_url, request_overrides)
                        ext = download_url_status['probe_status']['ext']
                        if ext == 'NULL': download_url.split('?')[0].split('.')[-1] or 'mp3'
                        song_info.update(dict(
                            download_url=download_url, download_url_status=download_url_status, raw_data={'search': search_result, 'download': download_result},
                            ext=ext, file_size=download_url_status['probe_status']['file_size']
                        ))
                    except:
                        continue
                if not song_info.with_valid_download_url: continue
                # ----parse more infos
                try:
                    lrc_div = soup.find("div", id="content-lrc")
                    lyric, lyric_result = lrc_div.get_text("\n", strip=True), {'lrc_div': str(lrc_div)}
                except:
                    lyric, lyric_result = 'NULL', {}
                format_duration = lambda d: "{:02}:{:02}:{:02}".format(*([0] * (3 - len(d.split(":"))) + list(map(int, d.split(":")))))
                duration = format_duration(download_result.get('mp3_duration', '00:00:00') or '00:00:00')
                if duration == '00:00:00': duration = '-:-:-'
                song_info.raw_data['lyric'] = lyric_result
                song_info.update(dict(
                    lyric=lyric, duration=duration, song_name=legalizestring(download_result.get('mp3_title', 'NULL'), replace_null_string='NULL'),
                    singers=legalizestring(download_result.get('mp3_author', 'NULL'), replace_null_string='NULL'), album='NULL',
                    identifier=download_result.get('play_id'),
                ))
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