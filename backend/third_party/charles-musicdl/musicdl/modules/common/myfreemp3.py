'''
Function:
    Implementation of MyFreeMP3MusicClient: https://www.myfreemp3.com.cn/
Author:
    Zhenchao Jin
WeChat Official Account (微信公众号):
    Charles的皮卡丘
'''
import re
import copy
from urllib.parse import urlparse
from rich.progress import Progress
from ..sources import BaseMusicClient
from ..utils import legalizestring, resp2json, usesearchheaderscookies, seconds2hms, extractdurationsecondsfromlrc, searchdictbykey, SongInfo, QuarkParser


'''MyFreeMP3MusicClient'''
class MyFreeMP3MusicClient(BaseMusicClient):
    source = 'MyFreeMP3MusicClient'
    def __init__(self, **kwargs):
        super(MyFreeMP3MusicClient, self).__init__(**kwargs)
        if not self.quark_parser_config.get('cookies'): self.logger_handle.warning(f'{self.source}.__init__ >>> "quark_parser_config" is not configured, so only "netease" source can be leveraged.')
        self.allowed_music_sources = ['kuake', 'netease'] if self.quark_parser_config.get('cookies') else ['netease']
        self.default_search_headers = {
            "accept": "*/*", "accept-encoding": "gzip, deflate, br, zstd", "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8", "origin": "https://www.myfreemp3.com.cn",
            "priority": "u=1, i", "sec-ch-ua": "\"Google Chrome\";v=\"143\", \"Chromium\";v=\"143\", \"Not A(Brand\";v=\"24\"",
            "sec-ch-ua-mobile": "?0", "sec-ch-ua-platform": "\"Windows\"", "sec-fetch-dest": "empty", "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin", "x-requested-with": "XMLHttpRequest",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
        }
        self.default_download_headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        }
        self.default_headers = self.default_search_headers
        self._initsession()
    '''_constructsearchurls'''
    def _constructsearchurls(self, keyword: str, rule: dict = None, request_overrides: dict = None):
        # init
        rule, request_overrides = rule or {}, request_overrides or {}
        allowed_music_sources = copy.deepcopy(self.allowed_music_sources)
        self.search_size_per_page = min(10, self.search_size_per_page)
        # search rules
        default_rule = {'type': 'netease', 'filter': 'name', 'page': '1', 'input': keyword}
        default_rule.update(rule)
        # construct search urls based on search rules
        base_url = 'https://www.myfreemp3.com.cn/'
        search_urls, page_size = [], self.search_size_per_page
        for source in allowed_music_sources:
            source_default_rule = copy.deepcopy(default_rule)
            source_default_rule['type'], count = source, 0
            while self.search_size_per_source > count:
                page_rule = copy.deepcopy(source_default_rule)
                page_rule['page'] = str(int(count // page_size) + 1)
                search_urls.append({'url': base_url, 'data': page_rule, 'source': source})
                count += page_size
        # return
        return search_urls
    '''_parseneteasesearchresult'''
    def _parseneteasesearchresult(self, search_result: dict, request_overrides: dict = None):
        request_overrides = request_overrides or {}
        if (not isinstance(search_result, dict)) or ('id' not in search_result): return SongInfo(source=self.source)
        download_url =  f'http://music.163.com/song/media/outer/url?id={search_result["id"]}.mp3'
        lyric: str = search_result.get('lrc', '')
        lyric = lyric.removeprefix('data:text/plain,')
        duration = extractdurationsecondsfromlrc(lyric)
        song_info = SongInfo(
            source=self.source, download_url=download_url, download_url_status=self.audio_link_tester.test(download_url, request_overrides),
            ext='mp3', file_size='NULL', duration_s=duration, duration=seconds2hms(duration), root_source='netease', identifier=search_result['id'],
            raw_data={'search': search_result, 'download': {}, 'lyric': {}}, lyric=lyric, cover_url=search_result.get('pic'), album='NULL',
            song_name=legalizestring(search_result.get('title', 'NULL'), replace_null_string='NULL'),
            singers=legalizestring(search_result.get('author', 'NULL'), replace_null_string='NULL'),
        )
        song_info.download_url_status['probe_status'] = self.audio_link_tester.probe(song_info.download_url, request_overrides)
        ext, file_size = song_info.download_url_status['probe_status']['ext'], song_info.download_url_status['probe_status']['file_size']
        if file_size and file_size != 'NULL': song_info.file_size = file_size
        if ext and ext != 'NULL': song_info.ext = ext
        return song_info
    '''_parsequarksearchresult'''
    def _parsequarksearchresult(self, search_result: dict, request_overrides: dict = None):
        request_overrides = request_overrides or {}
        if (not isinstance(search_result, dict)) or ('url_kk' not in search_result): return SongInfo(source=self.source)
        search_result['id'] = urlparse(search_result['url_kk']).path.strip('/').split('/')[-1]
        quark_download_url = search_result['url_kk']
        download_result, download_url = QuarkParser.parsefromurl(quark_download_url, **self.quark_parser_config)
        if not download_url: return SongInfo(source=self.source)
        duration = searchdictbykey(download_result, 'duration')
        duration = [int(float(d)) for d in duration if int(float(d)) > 0]
        if duration: duration = duration[0]
        else: duration = 0
        song, artist = (lambda s: (m.group(2).strip(), m.group(1).strip()) if (m:=re.search(r'^\s*(.*?)\s*[-–—－]\s*(.*?)(?:\.[A-Za-z0-9]{1,5})?\s*(?:\s*[-–—－]\s*.*)?$', s.strip())) else (re.sub(r'\.[^.]+$', '', s.strip()).strip(), ""))(search_result.get('title'))
        song_info = SongInfo(
            source=self.source, download_url=download_url, download_url_status=self.quark_audio_link_tester.test(download_url, request_overrides),
            ext='mp3', file_size='NULL', duration_s=duration, duration=seconds2hms(duration), root_source='quark', identifier=search_result['id'],
            raw_data={'search': search_result, 'download': download_result, 'lyric': {}}, lyric='NULL', album='NULL', default_download_headers=self.quark_default_download_headers,
            song_name=legalizestring(song, replace_null_string='NULL'), singers=legalizestring(artist, replace_null_string='NULL')
        )
        song_info.download_url_status['probe_status'] = self.quark_audio_link_tester.probe(song_info.download_url, request_overrides)
        ext, file_size = song_info.download_url_status['probe_status']['ext'], song_info.download_url_status['probe_status']['file_size']
        if file_size and file_size != 'NULL': song_info.file_size = file_size
        if ext and ext != 'NULL': song_info.ext = ext
        return song_info
    '''_search'''
    @usesearchheaderscookies
    def _search(self, keyword: str = '', search_url: dict = None, request_overrides: dict = None, song_infos: list = [], progress: Progress = None, progress_id: int = 0):
        # init
        request_overrides = request_overrides or {}
        search_meta = copy.deepcopy(search_url)
        search_url, source = search_meta.pop('url'), search_meta.pop('source')
        # successful
        try:
            # --search results
            resp = self.post(search_url, **search_meta, **request_overrides)
            resp.raise_for_status()
            search_results = resp2json(resp)['data']['list']
            for search_result in search_results:
                # --download results
                if source in ['netease']:
                    try:
                        song_info = self._parseneteasesearchresult(search_result, request_overrides)
                    except:
                        song_info = SongInfo(source=self.source)
                else:
                    assert source in ['kuake']
                    try:
                        song_info = self._parsequarksearchresult(search_result, request_overrides)
                    except:
                        song_info = SongInfo(source=self.source)
                if not song_info.with_valid_download_url: continue
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