'''
Function:
    Implementation of BuguyyMusicClient: https://buguyy.top/
Author:
    Zhenchao Jin
WeChat Official Account (微信公众号):
    Charles的皮卡丘
'''
import re
import copy
from .base import BaseMusicClient
from urllib.parse import urlencode
from rich.progress import Progress
from ..utils import legalizestring, usesearchheaderscookies, resp2json, safeextractfromdict, searchdictbykey, seconds2hms, SongInfo, QuarkParser


'''BuguyyMusicClient'''
class BuguyyMusicClient(BaseMusicClient):
    source = 'BuguyyMusicClient'
    def __init__(self, **kwargs):
        super(BuguyyMusicClient, self).__init__(**kwargs)
        if not self.quark_parser_config.get('cookies'): self.logger_handle.warning(f'{self.source}.__init__ >>> "quark_parser_config" is not configured, so song downloads are restricted and only mp3 files can be downloaded.')
        self.default_search_headers = {
            "accept": "application/json, text/plain, */*",
            "accept-encoding": "gzip, deflate, br, zstd",
            "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
            "origin": "https://buguyy.top",
            "priority": "u=1, i",
            "referer": "https://buguyy.top/",
            "sec-ch-ua": "\"Chromium\";v=\"142\", \"Google Chrome\";v=\"142\", \"Not_A Brand\";v=\"99\"",
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": "\"Windows\"",
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-site",
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
        # search rules
        default_rule = {'keyword': keyword}
        default_rule.update(rule)
        # construct search urls based on search rules
        base_url = 'https://a.buguyy.top/newapi/search.php?'
        page_rule = copy.deepcopy(default_rule)
        search_urls = [base_url + urlencode(page_rule)]
        self.search_size_per_page = self.search_size_per_source
        # return
        return search_urls
    '''_search'''
    @usesearchheaderscookies
    def _search(self, keyword: str = '', search_url: str = '', request_overrides: dict = None, song_infos: list = [], progress: Progress = None, progress_id: int = 0):
        # init
        request_overrides = request_overrides or {}
        # successful
        try:
            # --search results
            resp = self.get(search_url, verify=False, **request_overrides)
            resp.raise_for_status()
            search_results = resp2json(resp=resp)['data']['list']
            for search_result in search_results:
                # --download results
                if not isinstance(search_result, dict) or ('id' not in search_result):
                    continue
                song_info = SongInfo(source=self.source)
                # ----parse from quark links
                if self.quark_parser_config.get('cookies'):
                    quark_download_urls = [search_result.get('downurl', ''), search_result.get('ktmdownurl', '')]
                    for quark_download_url in quark_download_urls:
                        song_info = SongInfo(source=self.source)
                        try:
                            m = re.search(r"(?i)(?:WAV|FLAC)#(https?://[^#]+)|MP3#(https?://[^#]+)", quark_download_url)
                            quark_wav_download_url = m.group(1) or m.group(2)
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
                lyric_result = {}
                if not song_info.with_valid_download_url:
                    song_info = SongInfo(source=self.source)
                    try:
                        resp = self.get(f'https://a.buguyy.top/newapi/geturl2.php?id={search_result["id"]}', verify=False, **request_overrides)
                        resp.raise_for_status()
                        download_result = resp2json(resp=resp)
                        download_url = safeextractfromdict(download_result, ['data', 'url'], '')
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
                    lyric_result = copy.deepcopy(download_result)
                else:
                    try:
                        resp = self.get(f'https://a.buguyy.top/newapi/geturl2.php?id={search_result["id"]}', verify=False, **request_overrides)
                        resp.raise_for_status()
                        lyric_result = resp2json(resp=resp)
                    except:
                        pass
                if not song_info.with_valid_download_url: continue
                # ----parse more infos
                if not song_info.duration or song_info.duration == '-:-:-':
                    try:
                        duration = '{:02d}:{:02d}:{:02d}'.format(*([0,0,0] + list(map(int, re.findall(r'\d+', safeextractfromdict(lyric_result, ['data', 'duration'], '')))))[-3:])
                        if duration == '00:00:00': duration = '-:-:-'
                    except:
                        duration = '-:-:-'
                else:
                    duration = song_info.duration
                lyric = safeextractfromdict(lyric_result, ['data', 'lrc'], '')
                if not lyric or '歌词获取失败' in lyric: lyric = 'NULL'
                song_info.raw_data['lyric'] = lyric_result
                song_info.update(dict(
                    lyric=lyric, duration=duration, song_name=legalizestring(search_result.get('title', 'NULL'), replace_null_string='NULL'),
                    singers=legalizestring(search_result.get('singer', 'NULL'), replace_null_string='NULL'), 
                    album=legalizestring(safeextractfromdict(lyric_result, ['data', 'album'], ''), replace_null_string='NULL'),
                    identifier=search_result['id'],
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