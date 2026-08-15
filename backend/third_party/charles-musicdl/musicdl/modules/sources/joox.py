'''
Function:
    Implementation of JooxMusicClient: https://www.joox.com/intl
Author:
    Zhenchao Jin
WeChat Official Account (微信公众号):
    Charles的皮卡丘
'''
import copy
import base64
import json_repair
from .base import BaseMusicClient
from rich.progress import Progress
from urllib.parse import urlencode, urlparse, parse_qs
from ..utils import legalizestring, byte2mb, resp2json, seconds2hms, usesearchheaderscookies, SongInfo


'''JooxMusicClient'''
class JooxMusicClient(BaseMusicClient):
    source = 'JooxMusicClient'
    def __init__(self, **kwargs):
        super(JooxMusicClient, self).__init__(**kwargs)
        self.default_search_headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
            'Cookie': 'wmid=142420656; user_type=1; country=id; session_key=2a5d97d05dc8fe238150184eaf3519ad;',
            'X-Forwarded-For': '36.73.34.109'
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
        default_rule = {'country': 'sg', 'lang': 'zh_cn', 'keyword': keyword}
        default_rule.update(rule)
        # construct search urls based on search rules
        base_url = 'https://cache.api.joox.com/openjoox/v3/search?'
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
            resp = self.session.get(search_url, **request_overrides)
            resp.raise_for_status()
            search_results = []
            for section in resp2json(resp)['section_list']:
                for items in section['item_list']:
                    search_results.extend(items.get('song', []))
            parsed_search_url = parse_qs(urlparse(search_url).query, keep_blank_values=True)
            lang, country = parsed_search_url['lang'][0], parsed_search_url['country'][0]
            for search_result in search_results:
                # --download results
                if not isinstance(search_result, dict) or ('song_info' not in search_result) or ('id' not in search_result['song_info']):
                    continue
                song_info = SongInfo(source=self.source)
                params = {'songid': search_result['song_info']['id'], 'lang': lang, 'country': country}
                try:
                    resp = self.get('https://api.joox.com/web-fcgi-bin/web_get_songinfo', params=params, **request_overrides)
                    resp.raise_for_status()
                    download_result = json_repair.loads(resp.text.replace('MusicInfoCallback(', '')[:-1])
                    kbps_map = json_repair.loads(download_result['kbps_map'])
                except:
                    continue
                for quality in [('r320Url', '320'), ('r192Url', '192'), ('mp3Url', '128'), ('m4aUrl', '96')]:
                    if (not kbps_map.get(quality[1])) or (not download_result.get(quality[0])):
                        continue
                    download_url: str = download_result.get(quality[0])
                    ext = download_url.split('?')[0].split('.')[-1]
                    song_info = SongInfo(
                        source=self.source, download_url=download_url, download_url_status=self.audio_link_tester.test(download_url, request_overrides), ext=ext,
                        raw_data={'search': search_result, 'download': download_result}, file_size_bytes=kbps_map.get(quality[1], 0),
                        file_size=byte2mb(kbps_map.get(quality[1], 0)), duration_s=download_result.get('minterval', 0), duration=seconds2hms(download_result.get('minterval', 0)),
                    )
                    if song_info.with_valid_download_url: break
                if not song_info.with_valid_download_url: continue
                song_info.update(dict(
                    song_name=legalizestring(search_result['song_info'].get('name', 'NULL'), replace_null_string='NULL'), 
                    singers=legalizestring(', '.join([singer.get('name', 'NULL') for singer in search_result['song_info'].get('artist_list', [])]), replace_null_string='NULL'), 
                    album=legalizestring(search_result['song_info'].get('album_name', 'NULL'), replace_null_string='NULL'),
                    identifier=search_result['song_info']['id'],
                ))
                # --lyric results
                params = {'musicid': search_result['song_info']['id'], 'country': country, 'lang': lang}
                try:
                    resp = self.get('https://api.joox.com/web-fcgi-bin/web_lyric', params=params, **request_overrides)
                    resp.raise_for_status()
                    lyric_result: dict = json_repair.loads(resp.text.replace('MusicJsonCallback(', '')[:-1]) or {}
                    lyric = base64.b64decode(lyric_result.get('lyric', '')).decode('utf-8') or 'NULL'
                except:
                    lyric_result, lyric = dict(), 'NULL'
                song_info.raw_data['lyric'] = lyric_result
                song_info.lyric = lyric
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