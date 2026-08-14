'''
Function:
    Implementation of JamendoMusicClient: https://www.jamendo.com/
Author:
    Zhenchao Jin
WeChat Official Account (微信公众号):
    Charles的皮卡丘
'''
import copy
import random
import hashlib
from .base import BaseMusicClient
from urllib.parse import urlencode
from rich.progress import Progress
from ..utils import legalizestring, resp2json, usesearchheaderscookies, seconds2hms, safeextractfromdict, SongInfo


'''JamendoMusicClient'''
class JamendoMusicClient(BaseMusicClient):
    source = 'JamendoMusicClient'
    def __init__(self, **kwargs):
        super(JamendoMusicClient, self).__init__(**kwargs)
        self.default_search_headers = {
            "referer": "https://www.jamendo.com/search?q=musicdl",
            "sec-ch-ua": "\"Google Chrome\";v=\"143\", \"Chromium\";v=\"143\", \"Not A(Brand\";v=\"24\"",
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": "\"Windows\"",
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
            "x-jam-call": "$536ab7feabd2404af7b6e54b4db74039734b58b3*0.5310391483096057~",
            "x-jam-version": "4gvfvv",
            "x-requested-with": "XMLHttpRequest",
        }
        self.default_download_headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        }
        self.default_headers = self.default_search_headers
        self._initsession()
    '''_makexjamcall'''
    def _makexjamcall(self, path: str = '/api/search') -> str:
        rand = str(random.random())
        digest = hashlib.sha1((path + rand).encode("utf-8")).hexdigest()
        return f"${digest}*{rand}~"
    '''_constructsearchurls'''
    def _constructsearchurls(self, keyword: str, rule: dict = None, request_overrides: dict = None):
        # init
        rule, request_overrides = rule or {}, request_overrides or {}
        # search rules
        default_rule = {'query': keyword, 'type': 'track', 'limit': self.search_size_per_source, 'identities': 'www'}
        default_rule.update(rule)
        # construct search urls based on search rules
        base_url = 'https://www.jamendo.com/api/search?'
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
            headers = copy.deepcopy(self.default_headers)
            headers['x-jam-call'] = self._makexjamcall()
            resp = self.get(search_url, headers=headers, **request_overrides)
            resp.raise_for_status()
            search_results = resp2json(resp)
            for search_result in search_results:
                # --download results
                if not isinstance(search_result, dict) or ('id' not in search_result) or ('stream' not in search_result and 'download' not in search_result):
                    continue
                song_info = SongInfo(source=self.source)
                streams: dict = search_result.get('download') or search_result.get('stream')
                for quality in ['flac', 'ogg', 'mp3']:
                    download_url = streams.get(quality, "")
                    if not download_url: continue
                    song_info = SongInfo(
                        source=self.source, download_url=download_url, download_url_status=self.audio_link_tester.test(download_url, request_overrides),
                        ext='mp3' if streams.get('mp3') else 'ogg', raw_data={'search': search_result, 'download': {}, 'lyric': {}}, lyric='NULL',
                        duration_s=search_result.get('duration', 0), duration=seconds2hms(search_result.get('duration', 0)), 
                        song_name=legalizestring(safeextractfromdict(search_result, ['name'], ""), replace_null_string='NULL'),
                        singers=legalizestring(safeextractfromdict(search_result, ['artist', 'name'], ""), replace_null_string='NULL'),
                        album=legalizestring(safeextractfromdict(search_result, ['album', 'name'], ""), replace_null_string='NULL'),
                        identifier=search_result['id'],
                    )
                    if song_info.with_valid_download_url: break
                if not song_info.with_valid_download_url: continue
                song_info.download_url_status['probe_status'] = self.audio_link_tester.probe(download_url, request_overrides)
                ext, file_size = song_info.download_url_status['probe_status']['ext'], song_info.download_url_status['probe_status']['file_size']
                if file_size and file_size != 'NULL': song_info.file_size = file_size
                if not song_info.file_size: song_info.file_size = 'NULL'
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