'''
Function:
    Implementation of GDStudioMusicClient: https://music.gdstudio.xyz/
Author:
    Zhenchao Jin
WeChat Official Account (微信公众号):
    Charles的皮卡丘
'''
import copy
import time
import random
import hashlib
import requests
import json_repair
from urllib.parse import quote
from rich.progress import Progress
from ..sources import BaseMusicClient
from ..utils import legalizestring, resp2json, usesearchheaderscookies, byte2mb, estimatedurationwithfilesizebr, estimatedurationwithfilelink, seconds2hms, SongInfo


'''settings'''
SUPPORTED_SITES = [
    'spotify', 'tencent', 'netease', 'kuwo', 'tidal', 'qobuz', 'joox', 'bilibili', 'apple', 'ytmusic', # 'kugou', 'ximalaya', 'migu',
]
SITE_TO_API_MAPPER = {
    'kuwo': 'https://music.gdstudio.xyz/api.php', 'tencent': 'https://music.gdstudio.xyz/api.php', 'tidal': 'https://music.gdstudio.xyz/api.php',
    'spotify': 'https://music.gdstudio.xyz/api.php', 'netease': 'https://music.gdstudio.xyz/api.php', 'bilibili': 'https://music.gdstudio.xyz/api.php',
    'apple': 'https://music.gdstudio.xyz/api.php',
    'migu': 'https://music-api-cn.gdstudio.xyz/api.php', 'kugou': 'https://music-api-cn.gdstudio.xyz/api.php', 'ximalaya': 'https://music-api-cn.gdstudio.xyz/api.php', # useless with error code 503 
    'joox': 'https://music-api-hk.gdstudio.xyz/api.php',
    'qobuz': 'https://music-api-us.gdstudio.xyz/api.php', 'ytmusic': 'https://music-api-us.gdstudio.xyz/api.php',
}


'''GDStudioMusicClient'''
class GDStudioMusicClient(BaseMusicClient):
    source = 'GDStudioMusicClient'
    def __init__(self, **kwargs):
        self.allowed_music_sources = list(set(kwargs.pop('allowed_music_sources', SUPPORTED_SITES[:-1])))
        super(GDStudioMusicClient, self).__init__(**kwargs)
        self.default_search_headers = {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        }
        self.default_download_headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        }
        self.default_headers = self.default_search_headers
        self._initsession()
    '''_yieldcallback'''
    def _yieldcallback(self):
        random_num = ''.join([str(random.randint(0, 9)) for _ in range(21)])
        timestamp = int(time.time() * 1000)
        return f"jQuery{random_num}_{timestamp}"
    '''_yieldcrc32'''
    def _yieldcrc32(self, id_value: str, hostname: str = 'music.gdstudio.xyz', version: str = "2025.11.4"):
        # timestamp
        try:
            resp = self.get('https://www.ximalaya.com/revision/time')
            resp.raise_for_status()
            ts_ms = resp.text.strip()
        except:
            ts_ms = int(time.time() * 1000)
        ts9 = str(ts_ms)[:9]
        # version
        parts = version.split(".")
        padded = [p if len(p) != 1 else "0" + p for p in parts]
        ver_padded = "".join(padded)
        # id
        id_str = quote(str(id_value))
        # src
        src = f"{hostname}|{ver_padded}|{ts9}|{id_str}"
        # return
        return hashlib.md5(src.encode("utf-8")).hexdigest()[-8:].upper()
    '''_constructsearchurls'''
    def _constructsearchurls(self, keyword: str, rule: dict = None, request_overrides: dict = None):
        # init
        rule, request_overrides = rule or {}, request_overrides or {}
        allowed_music_sources = copy.deepcopy(self.allowed_music_sources)
        # search rules
        default_rule = {'types': 'search', 'count': self.search_size_per_page, 'pages': '1', 'name': keyword}
        default_rule.update(rule)
        # construct search urls based on search rules
        search_urls, page_size = [], self.search_size_per_page
        for source in SUPPORTED_SITES:
            if source not in allowed_music_sources: continue
            source_default_rule = copy.deepcopy(default_rule)
            source_default_rule['source'], count = source, 0
            while self.search_size_per_source > count:
                if SITE_TO_API_MAPPER[source] in ['https://music.gdstudio.xyz/api.php']:
                    page_rule_post = copy.deepcopy(source_default_rule)
                    page_rule_post['pages'] = str(int(count // page_size) + 1)
                    page_rule_post['count'] = str(page_size)
                    page_rule_post['s'] = self._yieldcrc32(keyword)
                    search_urls.append({
                        'url': SITE_TO_API_MAPPER[source], 'data': page_rule_post, 'params': {'callback': self._yieldcallback()}, 'method': 'post'
                    })
                else:
                    page_rule_get = copy.deepcopy(source_default_rule)
                    page_rule_get['pages'] = str(int(count // page_size) + 1)
                    page_rule_get['count'] = str(page_size)
                    page_rule_get['s'] = self._yieldcrc32(keyword)
                    page_rule_get['callback'] = self._yieldcallback()
                    page_rule_get['_'] = str(int(time.time() * 1000))
                    search_urls.append({
                        'url': SITE_TO_API_MAPPER[source], 'params': page_rule_get, 'method': 'get'
                    })
                count += page_size
        # return
        return search_urls
    '''_search'''
    @usesearchheaderscookies
    def _search(self, keyword: str = '', search_url: dict = None, request_overrides: dict = None, song_infos: list = [], progress: Progress = None, progress_id: int = 0):
        # init
        request_overrides = request_overrides or {}
        search_meta = copy.deepcopy(search_url)
        search_url, method = search_meta.pop('url'), search_meta.pop('method')
        self.default_headers, request_overrides = copy.deepcopy(self.default_headers), copy.deepcopy(request_overrides)
        # successful
        try:
            # --search results
            resp: requests.Response = getattr(self, method)(search_url, **search_meta, **request_overrides)
            resp.raise_for_status()
            json_str = resp.text[resp.text.index('(')+1: resp.text.rindex(')')]
            search_results = json_repair.loads(json_str)
            for search_result in search_results:
                # --download results
                if (not isinstance(search_result, dict)) or ('id' not in search_result) or ('url_id' not in search_result) or ('source' not in search_result): continue
                song_info = SongInfo(source=self.source, root_source=search_result['source'])
                for br in [999, 740, 320, 192, 128]: # 999 and 740 mean lossless
                    params = {'callback': self._yieldcallback()}
                    data_json = {'types': 'url', 'id': search_result['id'], 'source': search_result['source'], 'br': br, 's': self._yieldcrc32(search_result['id'])}
                    try:
                        if method == 'post':
                            resp = self.post(SITE_TO_API_MAPPER[search_result['source']], params=params, data=data_json, **request_overrides)
                        else:
                            resp = self.get(SITE_TO_API_MAPPER[search_result['source']], params={**params, **data_json, '_': str(int(time.time() * 1000))}, **request_overrides)
                        resp.raise_for_status()
                        json_str = resp.text[resp.text.index('(')+1: resp.text.rindex(')')]
                        download_result = json_repair.loads(json_str)
                    except:
                        continue
                    if not download_result.get('url'): continue
                    download_url = download_result['url']
                    if not download_url.startswith('http'): download_url = f'https://music.gdstudio.xyz/' + download_url
                    if search_result['source'] in ['bilibili']: download_url = f'https://music-proxy.gdstudio.org/{download_url}'
                    song_info = SongInfo(
                        source=self.source, download_url=download_url, download_url_status=self.audio_link_tester.test(download_url, request_overrides),
                        ext=download_url.split('?')[0].split('.')[-1], file_size_bytes=download_result.get('size', 0), file_size=byte2mb(download_result.get('size', 0)),
                        duration=estimatedurationwithfilesizebr(download_result.get('size', 0), download_result.get('br', br)),
                        duration_s=estimatedurationwithfilesizebr(download_result.get('size', 0), download_result.get('br', br), return_seconds=True),
                        raw_data={'search': search_result, 'download': download_result}, identifier=f"{search_result['source']}_{search_result['id']}",
                        song_name=legalizestring(search_result.get('name', 'NULL'), replace_null_string='NULL'),
                        singers=legalizestring(', '.join(search_result.get('artist', 'NULL')), replace_null_string='NULL'),
                        album=legalizestring(search_result.get('album', 'NULL'), replace_null_string='NULL'), root_source=search_result['source'],
                    )
                    if search_result['source'] in ['bilibili']: song_info.download_url_status['ok'] = True if song_info.download_url_status['clen'] > 0 else False # use proxy url, general test method will fail
                    if song_info.with_valid_download_url: break
                if not song_info.with_valid_download_url: continue
                song_info.download_url_status['probe_status'] = self.audio_link_tester.probe(song_info.download_url, request_overrides)
                ext, file_size = song_info.download_url_status['probe_status']['ext'], song_info.download_url_status['probe_status']['file_size']
                if file_size and file_size != 'NULL': song_info.file_size = file_size
                if ext and ext != 'NULL': song_info.ext = ext
                if song_info.ext == 'm4s': song_info.ext = 'm4a'
                # --lyric results
                try:
                    params = {'callback': self._yieldcallback()}
                    data_json = {'types': 'lyric', 'id': search_result['lyric_id'], 'source': search_result['source'], 's': self._yieldcrc32(search_result['lyric_id'])}
                    if method == 'post':
                        resp = self.post(SITE_TO_API_MAPPER[search_result['source']], data=data_json, params=params, **request_overrides)
                    else:
                        resp = self.get(SITE_TO_API_MAPPER[search_result['source']], params={**params, **data_json, '_': str(int(time.time() * 1000))}, **request_overrides)
                    resp.raise_for_status()
                    json_str = resp.text[resp.text.index('(')+1: resp.text.rindex(')')]
                    lyric_result = json_repair.loads(json_str)
                    lyric = lyric_result.get('lyric') or lyric_result.get('tlyric') or 'NULL'
                except:
                    lyric_result, lyric = dict(), 'NULL'
                if not lyric or lyric == 'NULL':
                    try:
                        params = {
                            'artist_name': song_info.singers, 'track_name': song_info.song_name, 'album_name': song_info.album, 
                            'duration': estimatedurationwithfilelink(song_info.download_url, headers=self.default_download_headers, request_overrides=request_overrides),
                        }
                        resp = self.get(f'https://lrclib.net/api/get?', params=params, **request_overrides)
                        resp.raise_for_status()
                        lyric_result = resp2json(resp=resp)
                        lyric = lyric_result.get('syncedLyrics') or lyric_result.get('plainLyrics')
                        if lyric: song_info.duration_s, song_info.duration = params['duration'], seconds2hms(params['duration'])
                    except:
                        lyric_result, lyric = dict(), 'NULL'
                song_info.lyric = lyric
                song_info.raw_data['lyric'] = lyric_result
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