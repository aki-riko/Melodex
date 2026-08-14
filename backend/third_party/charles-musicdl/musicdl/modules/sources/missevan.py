'''
Function:
    Implementation of MissEvanMusicClient: https://www.missevan.com/
Author:
    Zhenchao Jin
WeChat Official Account (微信公众号):
    Charles的皮卡丘
'''
import copy
from .base import BaseMusicClient
from urllib.parse import urlencode
from rich.progress import Progress
from ..utils import legalizestring, resp2json, seconds2hms, usesearchheaderscookies, safeextractfromdict, SongInfo


'''MissEvanMusicClient'''
class MissEvanMusicClient(BaseMusicClient):
    source = 'MissEvanMusicClient'
    def __init__(self, **kwargs):
        super(MissEvanMusicClient, self).__init__(**kwargs)
        self.default_search_headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Referer": "https://www.missevan.com/",
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
        default_rule = {'s': keyword, 'p': '1', 'type': '3', 'page_size': '10', 'cid': '48'}
        default_rule.update(rule)
        # construct search urls based on search rules
        base_url = 'https://www.missevan.com/sound/getsearch?'
        search_urls, page_size, count = [], self.search_size_per_page, 0
        while self.search_size_per_source > count:
            page_rule = copy.deepcopy(default_rule)
            page_rule['page_size'] = page_size
            page_rule['page'] = int(count // page_size) + 1
            search_urls.append(base_url + urlencode(page_rule))
            count += page_size
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
            resp = self.get(search_url, **request_overrides)
            resp.raise_for_status()
            search_results = resp2json(resp)['info']['Datas']
            for search_result in search_results:
                # --download results
                if not isinstance(search_result, dict) or ('id' not in search_result):
                    continue
                song_info = SongInfo(source=self.source)
                try:
                    resp = self.get(f"https://www.missevan.com/sound/getsound?soundid={search_result['id']}", **request_overrides)
                    resp.raise_for_status()
                    download_result: dict = resp2json(resp)
                except:
                    continue
                download_urls = [safeextractfromdict(download_result, ['info', 'sound', 'soundurl'], ''), safeextractfromdict(download_result, ['info', 'sound', 'soundurl_128'], '')]
                for download_url in download_urls:
                    if not download_url: continue
                    try: duration_s = float(safeextractfromdict(download_result, ['info', 'sound', 'duration'], 0)) / 1000
                    except: duration_s = 0
                    song_info = SongInfo(
                        source=self.source, download_url=download_url, download_url_status=self.audio_link_tester.test(download_url, request_overrides),
                        file_size='NULL', duration_s=duration_s, duration=seconds2hms(duration_s), raw_data={'search': search_result, 'download': download_result, 'lyric': {}},
                        ext=download_url.split('?')[0].split('.')[-1], identifier=search_result['id'], lyric='NULL', album='NULL',
                        song_name=legalizestring(safeextractfromdict(download_result, ['info', 'sound', 'soundstr'], ''), replace_null_string='NULL'),
                        singers=legalizestring(safeextractfromdict(download_result, ['info', 'sound', 'username'], ''), replace_null_string='NULL'),
                    )
                    if song_info.with_valid_download_url: break
                if not song_info.with_valid_download_url: continue
                song_info.download_url_status['probe_status'] = self.audio_link_tester.probe(song_info.download_url, request_overrides)
                if song_info.download_url_status['probe_status']['ext'] != 'NULL': song_info.ext = song_info.download_url_status['probe_status']['ext']
                song_info.file_size = song_info.download_url_status['probe_status']['file_size']
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