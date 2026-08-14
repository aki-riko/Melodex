'''
Function:
    Implementation of LizhiMusicClient: https://www.lizhi.fm/
Author:
    Zhenchao Jin
WeChat Official Account (微信公众号):
    Charles的皮卡丘
'''
import copy
from .base import BaseMusicClient
from urllib.parse import urlencode
from rich.progress import Progress
from ..utils import legalizestring, resp2json, seconds2hms, usesearchheaderscookies, SongInfo


'''LizhiMusicClient'''
class LizhiMusicClient(BaseMusicClient):
    source = 'LizhiMusicClient'
    def __init__(self, **kwargs):
        super(LizhiMusicClient, self).__init__(**kwargs)
        self.default_search_headers = {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Version/9.0 Mobile/13B143 Safari/601.1',
            'Referer': 'https://m.lizhi.fm',
        }
        self.default_download_headers = {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Version/9.0 Mobile/13B143 Safari/601.1',
        }
        self.default_headers = self.default_search_headers
        self._initsession()
    '''_constructsearchurls'''
    def _constructsearchurls(self, keyword: str, rule: dict = None, request_overrides: dict = None):
        # init
        rule, request_overrides = rule or {}, request_overrides or {}
        # search rules
        default_rule = {'deviceId': "h5-b6ef91a9-3dbb-c716-1fdd-43ba08851150", "keywords": keyword, "page": 1, "receiptData": ""}
        default_rule.update(rule)
        # construct search urls based on search rules
        base_url = 'https://m.lizhi.fm/vodapi/search/voice?'
        search_urls, page_size, count = [], self.search_size_per_page, 0
        while self.search_size_per_source > count:
            page_rule = copy.deepcopy(default_rule)
            page_rule['page'] = int(count // page_size)
            if len(search_urls) > 0:
                try:
                    resp = self.get(search_urls[-1], **request_overrides)
                    receipt_data = resp2json(resp)['receiptData']
                except:
                    receipt_data = ""
                page_rule['receiptData'] = receipt_data
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
            search_results = resp2json(resp)['data']
            for search_result in search_results:
                # --download results
                if (not isinstance(search_result, dict)) or ('userInfo' not in search_result) or ('voiceInfo' not in search_result) or ('voicePlayProperty' not in search_result) or ('voiceId' not in search_result['voiceInfo']):
                    continue
                song_info = SongInfo(source=self.source)
                download_url = search_result['voicePlayProperty'].get('trackUrl', '')
                if not download_url: continue
                for quality in ['_ud.mp3', '_hd.mp3', '_sd.m4a']:
                    download_url: str = download_url[:-7] + quality
                    ext = download_url.split('?')[0].split('.')[-1] or 'mp3'
                    song_info = SongInfo(
                        source=self.source, download_url=download_url, download_url_status=self.audio_link_tester.test(download_url, request_overrides), ext=ext,
                        raw_data={'search': search_result, 'download': {}},
                    )
                    if song_info.with_valid_download_url: break
                if not song_info.with_valid_download_url: continue
                song_info.update(
                    duration=seconds2hms(search_result['voiceInfo'].get('duration', 0)), duration_s=search_result['voiceInfo'].get('duration', 0)
                )
                song_info.download_url_status['probe_status'] = self.audio_link_tester.probe(song_info.download_url, request_overrides)
                ext, file_size = song_info.download_url_status['probe_status']['ext'], song_info.download_url_status['probe_status']['file_size']
                if file_size and file_size != 'NULL': song_info.file_size = file_size
                if not song_info.file_size: song_info.file_size = 'NULL'
                if ext and ext != 'NULL': song_info.ext = ext
                lyric_result, lyric = dict(), 'NULL'
                song_info.raw_data['lyric'] = lyric_result
                song_info.update(dict(
                    lyric=lyric, song_name=legalizestring(search_result['voiceInfo'].get('name', 'NULL'), replace_null_string='NULL'), 
                    singers=legalizestring(search_result['userInfo'].get('name', 'NULL'), replace_null_string='NULL'), 
                    album=legalizestring(search_result['voiceInfo'].get('lableName', 'NULL'), replace_null_string='NULL'),
                    identifier=search_result['voiceInfo']['voiceId'],
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